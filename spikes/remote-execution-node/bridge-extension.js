module.exports = async function remoteExecutionBridge(pi) {
  const protocol = await import("./lib/protocol.mjs")
  const bridgeState = await import("./lib/bridge-state.mjs")
  const telemetry = await import("./lib/telemetry.mjs")
  const { ReconnectingBridgeClient } = await import("./lib/bridge-client.mjs")

  let context
  let state
  let client
  let closed = false
  let textDelta = null
  const toolUpdates = new Map()
  const toolTimers = new Map()

  const label = telemetry.boundedLabel

  const emit = (eventType, data = {}, assignmentId = undefined) => {
    if (closed || !state || !client) return false
    try {
      const result = bridgeState.nextEvent(state, eventType, data, { assignmentId })
      state = result.state
      return client.send(result.event)
    } catch (error) {
      if (context?.hasUI) context.ui.notify(`Bridge telemetry failed: ${error.message}`, "error")
      return false
    }
  }

  const snapshot = () => {
    if (!closed && state && client) client.send(bridgeState.createStateSnapshot(state))
  }


  const flushTextDelta = () => {
    if (!textDelta) return
    const current = textDelta
    textDelta = null
    emit("message_updated", telemetry.boundedTextDeltaSummary(current.count, current.characters))
  }

  const flushToolUpdate = toolCallId => {
    const current = toolUpdates.get(toolCallId)
    if (!current) return
    toolUpdates.delete(toolCallId)
    const timer = toolTimers.get(toolCallId)
    if (timer !== undefined) clearTimeout(timer)
    toolTimers.delete(toolCallId)
    emit("tool_updated", {
      toolCallId: label(toolCallId, 128) ?? "unknown",
      updateCount: current.count
    })
  }

  const acceptAssignment = assignment => {
    if (closed || !state || !client) return
    if (context?.mode !== "tui" || context?.hasUI !== true) {
      client.send(bridgeState.makeInvalidAssignmentAcknowledgement(
        state, assignment.assignmentId, "visible TUI mode is required"
      ))
      return
    }
    let result
    try {
      result = bridgeState.evaluateAssignment(state, assignment, { isIdle: context.isIdle() })
      state = result.state
      client.send(result.acknowledgement)
    } catch (error) {
      client.send(bridgeState.makeInvalidAssignmentAcknowledgement(
        state, assignment.assignmentId, label(error.message, protocol.LIMITS.reasonCharacters) ?? "invalid assignment"
      ))
      return
    }
    if (result.acknowledgement.status !== "accepted") return
    emit("assignment_started", { promptCharacters: assignment.prompt.length }, assignment.assignmentId)
    try {
      pi.sendUserMessage(assignment.prompt)
    } catch (error) {
      emit("assignment_needs_reconciliation", {
        reason: label(error.message, protocol.LIMITS.reasonCharacters) ?? "sendUserMessage failed"
      }, assignment.assignmentId)
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx
    closed = false
    if (ctx.mode !== "tui" || ctx.hasUI !== true) {
      if (ctx.hasUI) ctx.ui.notify("remote execution bridge requires visible TUI mode", "error")
      return
    }
    const socketPath = process.env.OMARCHESTRA_BRIDGE_SOCKET
    const teamGoalId = process.env.OMARCHESTRA_TEAM_GOAL_ID
    const agentRunId = process.env.OMARCHESTRA_AGENT_RUN_ID
    const role = process.env.OMARCHESTRA_ROLE
    const shellId = process.env.OMARCHESTRA_SHELL_ID || process.env.BOOMUX_SHELL_ID
    const extensionInstanceId = process.env.OMARCHESTRA_EXTENSION_INSTANCE_ID || `bridge-${process.pid}`
    if (!socketPath || !teamGoalId || !agentRunId || !role || !shellId) {
      if (ctx.hasUI) ctx.ui.notify("remote execution bridge environment is incomplete", "error")
      return
    }
    try {
      state = bridgeState.createBridgeState({
        teamGoalId,
        role,
        agentRunId,
        shellId,
        piSessionId: ctx.sessionManager.getSessionId(),
        extensionInstanceId
      })
      client = new ReconnectingBridgeClient({
        socketPath,
        makeHello: () => bridgeState.createHello(state),
        onState: (kind, detail) => {
          if (kind === "connected") {
            const result = bridgeState.markConnected(state)
            state = result.state
            if (result.eventType) emit(result.eventType, {})
            emit("session_started", { mode: "tui" })
            snapshot()
          } else if (kind === "disconnected") {
            const result = bridgeState.markDisconnected(state)
            state = result.state
            if (result.eventType) emit(result.eventType, {})
          } else if (kind === "rejected" && ctx.hasUI) {
            ctx.ui.notify(`remote runner rejected bridge: ${detail?.reason ?? "unknown reason"}`, "error")
          }
        },
        onMessage: message => {
          if (message.type === "runner_snapshot") {
            try {
              state = bridgeState.applyRunnerSnapshot(state, message)
              snapshot()
            } catch (error) {
              emit("assignment_needs_reconciliation", { reason: label(error.message) ?? "snapshot mismatch" })
            }
          } else if (message.type === "assignment") {
            acceptAssignment(message)
          } else if (message.type === "protocol_error" && ctx.hasUI) {
            ctx.ui.notify(`remote runner protocol error: ${message.code}`, "error")
          }
        }
      })
      client.start()
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`remote execution bridge did not start: ${error.message}`, "error")
    }
  })

  pi.on("session_shutdown", async () => {
    if (closed) return
    closed = true
    for (const timer of toolTimers.values()) clearTimeout(timer)
    toolTimers.clear()
    toolUpdates.clear()
    flushTextDelta()
    if (state && client) {
      const result = bridgeState.nextEvent(state, "session_shutdown", {})
      state = result.state
      try { client.send(result.event) } catch {}
      client.close()
    }
    client = undefined
    context = undefined
  })

  pi.on("input", async (event, _ctx) => {
    if (!state || closed || event.source !== "interactive") return
    const result = bridgeState.observeSubmittedInput(state, event.source)
    state = result.state
    if (!result.takeover) return
    emit("human_message_submitted", { characters: typeof event.text === "string" ? event.text.length : 0 })
    emit("manual_takeover", { reason: "submitted interactive input" })
  })

  pi.on("agent_start", async () => {
    if (state?.assignment?.state === "accepted") state = bridgeState.markAssignmentStarted(state)
    emit("agent_started", {})
  })
  pi.on("agent_end", async event => emit("agent_ended", {
    messageCount: Array.isArray(event?.messages) ? event.messages.length : 0
  }))
  pi.on("agent_settled", async () => {
    flushTextDelta()
    if (state?.assignment && (state.assignment.state === "accepted" || state.assignment.state === "working")) {
      state = bridgeState.markAssignmentSettled(state)
      emit(state.controlMode === "manual_takeover" ? "assignment_needs_reconciliation" : "assignment_settled", {})
    }
    emit("agent_settled", {})
  })
  pi.on("message_start", async event => emit("message_started", telemetry.redactMessageMetadata(event?.message)))
  pi.on("message_update", async event => {
    const update = event?.assistantMessageEvent
    if (!update || typeof update.type !== "string" || update.type.startsWith("thinking")) return
    if (update.type === "text_delta") {
      const delta = typeof update.delta === "string" ? update.delta.length : 0
      if (!textDelta) textDelta = { count: 0, characters: 0 }
      textDelta.count += 1
      textDelta.characters += delta
      return
    }
    emit("message_updated", { updateType: label(update.type, 64) ?? "unknown" })
  })
  pi.on("message_end", async event => {
    flushTextDelta()
    emit("message_ended", telemetry.redactMessageMetadata(event?.message))
  })
  pi.on("tool_execution_start", async event => emit("tool_started", telemetry.redactToolMetadata(event)))
  pi.on("tool_execution_update", async event => {
    const toolCallId = label(event?.toolCallId, 128) ?? "unknown"
    const current = toolUpdates.get(toolCallId) ?? { count: 0 }
    current.count += 1
    toolUpdates.set(toolCallId, current)
    if (!toolTimers.has(toolCallId)) {
      const timer = setTimeout(() => flushToolUpdate(toolCallId), 100)
      toolTimers.set(toolCallId, timer)
    }
  })
  pi.on("tool_execution_end", async event => {
    const toolCallId = label(event?.toolCallId, 128) ?? "unknown"
    flushToolUpdate(toolCallId)
    emit("tool_ended", {
      ...telemetry.redactToolMetadata(event),
      isError: event?.isError === true
    })
  })
  pi.on("ui_prompt_start", async event => emit("attention_required", telemetry.redactAttentionMetadata(event)))
  pi.on("ui_prompt_end", async event => emit("attention_resolved", telemetry.redactAttentionMetadata(event)))

  pi.registerCommand("remote-bridge-attention-probe", {
    description: "Exercise remote bridge attention telemetry with a visible confirmation",
    handler: async (_args, ctx) => {
      await ctx.ui.confirm("Remote bridge attention probe", "Confirm to resolve this visible attention test.")
    }
  })
}