import {
  makeAssignment,
  makeAssignmentAck,
  makeControlAck,
  makeControlResponse,
  makeEvent,
  makeHelloAck,
  makeRunnerSnapshot,
  validateMessage,
  validateTelemetry,
  ROLES,
  EVENT_TYPES,
  LIMITS
} from "./protocol.mjs"
import { errorReport, requireCondition, spikeError } from "./errors.mjs"
import {
  ARTIFACT_SCHEMA,
  createRunnerState,
  validateRunnerState
} from "./durable-store.mjs"
import { makeValidationArtifact, validateValidationArtifact } from "./artifacts.mjs"
import { validateOpaqueId, validateRole, validateUuid, plainObject } from "./validation.mjs"

const clone = value => structuredClone(value)
const ACTIVE_ASSIGNMENT_STATES = new Set(["pending", "accepted", "working"])
const EVENT_TYPES_SET = new Set(EVENT_TYPES)

function nowValue(now) {
  const value = now()
  requireCondition(Number.isSafeInteger(value) && value >= 0, "invalid_clock", "Clock returned an invalid timestamp")
  return value
}

function messageError(error) {
  if (error instanceof Error) return { code: error.code ?? "internal", message: error.message, details: error.details ?? {} }
  return { code: "internal", message: String(error), details: {} }
}

function requireRole(role) {
  validateRole(role)
  return role
}

function exactBinding(binding, expected, role) {
  requireCondition(binding.agentRunId === expected.agentRunId && binding.shellId === expected.shellId
    && binding.shellRunId === (expected.shellRunId ?? null),
  "binding_mismatch", `${role} bridge binding does not match the durable runner binding`)
}

export class RunnerCore {
  constructor({
    store,
    receiptId,
    teamGoalId,
    bindings,
    now = () => Date.now(),
    maxEvents = 256,
    maxArtifacts = 128,
    makeConnectionId = (kind, number) => `${kind}-${number}`
  }) {
    requireCondition(store && typeof store.load === "function" && typeof store.initialize === "function"
      && typeof store.replace === "function", "invalid_runner", "RunnerCore requires a durable state store")
    validateUuid(receiptId, "receipt ID")
    validateUuid(teamGoalId, "Team Goal ID")
    plainObject(bindings, "runner bindings")
    requireCondition(Number.isSafeInteger(maxEvents) && maxEvents > 0 && maxEvents <= LIMITS.eventPageItems,
      "invalid_runner", "maxEvents must be between 1 and 256")
    requireCondition(Number.isSafeInteger(maxArtifacts) && maxArtifacts > 0 && maxArtifacts <= 128,
      "invalid_runner", "maxArtifacts is invalid")
    this.store = store
    this.receiptId = receiptId
    this.teamGoalId = teamGoalId
    this.bindings = clone(bindings)
    this.now = now
    this.maxEvents = maxEvents
    this.maxArtifacts = maxArtifacts
    this.makeConnectionId = makeConnectionId
    this.state = null
    this.initialized = false
    this.operationQueue = Promise.resolve()
    this.connectionNumber = 0
    this.bridges = new Map()
    this.controls = new Map()
  }

  async initialize() {
    return this.#enqueue(async () => {
      const current = await this.store.load()
      if (current === null) {
        const initial = createRunnerState({
          receiptId: this.receiptId,
          teamGoalId: this.teamGoalId,
          bindings: this.bindings,
          now: this.now
        })
        await this.store.initialize(initial)
        this.state = initial
      } else {
        const restored = validateRunnerState(current, {
          maxEvents: this.maxEvents,
          maxArtifacts: this.maxArtifacts
        })
        requireCondition(restored.receiptId === this.receiptId && restored.teamGoalId === this.teamGoalId,
          "runner_identity_changed", "Durable runner state belongs to another receipt or Team Goal")
        for (const role of ROLES) exactBinding(restored.bindings[role], this.bindings[role], role)
        this.state = clone(restored)
        let staleConnection = false
        for (const role of ROLES) {
          const bridge = this.state.bridges[role]
          if (bridge.connectionState === "connected") {
            bridge.connectionState = "disconnected"
            bridge.connectionId = null
            bridge.disconnectedAtMs = nowValue(this.now)
            staleConnection = true
          }
        }
        if (staleConnection) {
          this.#appendRunnerEvent(this.state, "runner_restarted", {
            roles: ROLES.filter(role => restored.bridges[role].connectionState === "connected")
          })
          this.state.updatedAtMs = nowValue(this.now)
          await this.store.replace(validateRunnerState(this.state, {
            maxEvents: this.maxEvents,
            maxArtifacts: this.maxArtifacts
          }))
        }
      }
      this.initialized = true
      return this.snapshot()
    })
  }

  async snapshot() {
    requireCondition(this.initialized && this.state !== null, "runner_not_initialized", "RunnerCore is not initialized")
    return clone(this.#snapshot(this.state))
  }

  async eventPage({ after = null, limit = LIMITS.eventPageItems } = {}) {
    requireCondition(this.initialized && this.state !== null, "runner_not_initialized", "RunnerCore is not initialized")
    requireCondition(after === null || typeof after === "string", "invalid_cursor", "Event cursor must be null or a string")
    requireCondition(Number.isSafeInteger(limit) && limit > 0 && limit <= LIMITS.eventPageItems,
      "invalid_events", "Event page limit is invalid")
    return clone(this.#eventPage(this.state, after, limit))
  }

  async acceptBridge(hello, send) {
    validateMessage(hello)
    requireCondition(hello.type === "hello", "handshake_required", "Bridge hello is required")
    requireCondition(typeof send === "function", "invalid_transport", "Bridge send function is required")
    return this.#enqueue(async () => {
      this.#requireInitialized()
      const binding = this.state.bindings[hello.role]
      requireCondition(binding !== undefined, "invalid_role", "Bridge role is not assigned to this runner")
      requireCondition(hello.teamGoalId === this.teamGoalId, "team_goal_mismatch", "Bridge Team Goal ID differs")
      requireCondition(hello.agentRunId === binding.agentRunId && hello.shellId === binding.shellId,
        "binding_mismatch", "Bridge identity does not match its assigned Agent Run and Shell")
      const durableBridge = this.state.bridges[hello.role]
      if (durableBridge.connectionState === "connected") {
        return {
          accepted: false,
          acknowledgement: makeHelloAck({
            connectionId: this.#nextConnectionId("rejected"),
            accepted: false,
            reason: "role_already_connected",
            timestamp: nowValue(this.now),
            role: hello.role
          }),
          messages: []
        }
      }
      if (durableBridge.piSessionId !== null) {
        requireCondition(durableBridge.piSessionId === hello.piSessionId
          && durableBridge.extensionInstanceId === hello.extensionInstanceId
          && durableBridge.pid === hello.pid,
        "bridge_identity_changed", "Reconnection identity differs from the receipt-owned visible Pi process")
      }
      const durableBridgeSequence = durableBridge.lastBridgeSequence
      const observedBridgeSequence = hello.lastEventSequence ?? 0
      requireCondition(observedBridgeSequence >= durableBridgeSequence,
        "bridge_cursor_regressed", "Bridge reconnect cursor is older than the durable runner cursor")
      if (observedBridgeSequence === durableBridgeSequence
        && hello.lastEventId !== undefined && durableBridge.lastEventId !== null) {
        requireCondition(hello.lastEventId === durableBridge.lastEventId,
          "bridge_cursor_changed", "Bridge reconnect event identity differs from the durable runner cursor")
      }
      const connectionId = this.#nextConnectionId(`bridge-${hello.role}`)
      const resumed = durableBridge.connectionCount > 0
      const atMs = nowValue(this.now)
      durableBridge.connectionState = "connected"
      durableBridge.connectionId = connectionId
      durableBridge.piSessionId = hello.piSessionId
      durableBridge.extensionInstanceId = hello.extensionInstanceId
      durableBridge.pid = hello.pid
      durableBridge.connectedAtMs = atMs
      durableBridge.connectionCount += 1
      this.bridges.set(connectionId, {
        role: hello.role,
        send,
        initialBridgeSequence: observedBridgeSequence
      })
      this.#appendRunnerEvent(this.state, resumed ? "bridge_reconnected" : "bridge_connected", {
        role: hello.role,
        agentRunId: hello.agentRunId,
        shellId: hello.shellId,
        pid: hello.pid,
        piSessionId: hello.piSessionId,
        extensionInstanceId: hello.extensionInstanceId
      }, { role: hello.role })
      if (observedBridgeSequence > durableBridgeSequence) {
        const expectedSequence = durableBridgeSequence + 1
        durableBridge.lastBridgeSequence = observedBridgeSequence
        durableBridge.lastEventId = hello.lastEventId ?? null
        this.#appendRunnerEvent(this.state, "bridge_event_gap", {
          role: hello.role,
          expectedSequence,
          observedSequence: observedBridgeSequence,
          source: "bridge_hello_cursor"
        }, { role: hello.role, sourceEventId: hello.lastEventId ?? null, sourceSequence: observedBridgeSequence })
      }
      const assignment = this.#assignmentForRole(this.state, hello.role)
      const messages = [
        makeRunnerSnapshot({
          teamGoalId: this.teamGoalId,
          role: hello.role,
          cursor: this.#cursor(this.state.sequence),
          assignment: assignment ? this.#assignmentSummary(assignment) : null,
          controlMode: durableBridge.controlMode,
          timestamp: atMs,
          bridge: {
            connectionState: durableBridge.connectionState,
            lastEventSequence: durableBridge.lastBridgeSequence,
            piSessionId: durableBridge.piSessionId,
            extensionInstanceId: durableBridge.extensionInstanceId,
            pid: durableBridge.pid
          }
        })
      ]
      if (assignment && ACTIVE_ASSIGNMENT_STATES.has(assignment.state)) {
        assignment.deliveryCount += 1
        assignment.updatedAtMs = atMs
        messages.push(makeAssignment({
          teamGoalId: this.teamGoalId,
          role: hello.role,
          assignmentId: assignment.assignmentId,
          prompt: assignment.prompt,
          timestamp: atMs
        }))
      }
      this.state.updatedAtMs = atMs
      await this.store.replace(this.#validatedState())
      return {
        accepted: true,
        role: hello.role,
        connectionId,
        resumed,
        acknowledgement: makeHelloAck({
          connectionId,
          accepted: true,
          role: hello.role,
          resumed,
          cursor: this.#cursor(this.state.sequence),
          timestamp: atMs
        }),
        messages
      }
    })
  }

  async disconnect(connectionId, reason = "transport closed") {
    validateOpaqueId(connectionId, "connection ID")
    return this.#enqueue(async () => {
      const connection = this.bridges.get(connectionId)
      this.bridges.delete(connectionId)
      if (!connection) return { changed: false }
      this.#requireInitialized()
      const bridge = this.state.bridges[connection.role]
      if (bridge.connectionId !== connectionId) return { changed: false }
      bridge.connectionState = "disconnected"
      bridge.connectionId = null
      bridge.disconnectedAtMs = nowValue(this.now)
      this.#appendRunnerEvent(this.state, "bridge_disconnected", {
        role: connection.role,
        reason: String(reason).slice(0, 256)
      }, { role: connection.role })
      this.state.updatedAtMs = nowValue(this.now)
      await this.store.replace(this.#validatedState())
      return { changed: true, role: connection.role }
    })
  }

  async handleBridgeMessage(connectionId, message) {
    validateMessage(message)
    return this.#enqueue(async () => {
      this.#requireInitialized()
      const connection = this.bridges.get(connectionId)
      requireCondition(connection, "unknown_connection", "Bridge connection is not registered")
      requireCondition(message.type !== "hello" && message.type !== "control_hello",
        "unexpected_message", "Handshake messages are not accepted after registration")
      const bridge = this.state.bridges[connection.role]
      if (message.type === "assignment_ack") return this.#handleAssignmentAck(bridge, connection.role, message)
      if (message.type === "event") return this.#handleBridgeEvent(bridge, connection.role, message, connection)
      if (message.type === "state_snapshot") return this.#handleBridgeSnapshot(bridge, connection.role, message)
      throw spikeError("unexpected_message", `Message type ${message.type} is not accepted from a bridge`)
    })
  }

  async issueAssignment({ role, assignmentId, prompt }) {
    validateRole(role)
    validateOpaqueId(assignmentId, "assignment ID")
    requireCondition(typeof prompt === "string" && prompt.length > 0 && prompt.length <= 16_384
      && !/[\0\r\n]/.test(prompt), "invalid_assignment", "Assignment prompt is invalid")
    return this.#enqueue(async () => {
      this.#requireInitialized()
      const bridge = this.state.bridges[role]
      const existing = this.#assignmentForId(this.state, assignmentId)
      if (existing) {
        requireCondition(existing.role === role && existing.prompt === prompt,
          "assignment_conflict", "Assignment ID is already bound to another role or prompt")
        return { status: "duplicate", assignment: this.#assignmentSummary(existing), sent: false }
      }
      const active = this.#assignmentForRole(this.state, role)
      if (active && ACTIVE_ASSIGNMENT_STATES.has(active.state)) {
        return { status: "busy", assignment: this.#assignmentSummary(active), sent: false }
      }
      requireCondition(bridge.controlMode === "managed", "takeover_active", "Role is under manual takeover")
      requireCondition(this.state.assignments.length < LIMITS.pendingMessages,
        "assignment_limit", "Runner assignment retention limit is reached")
      const atMs = nowValue(this.now)
      const assignment = {
        assignmentId,
        role,
        prompt,
        state: "pending",
        issuedAtMs: atMs,
        updatedAtMs: atMs,
        lastAck: null,
        deliveryCount: 0
      }
      this.state.assignments.push(assignment)
      bridge.assignmentId = assignmentId
      this.#appendRunnerEvent(this.state, "assignment_issued", {
        role,
        assignmentId,
        promptCharacters: prompt.length
      }, { role, assignmentId })
      this.state.updatedAtMs = atMs
      const connection = this.#connectionForRole(role)
      const message = connection ? makeAssignment({
        teamGoalId: this.teamGoalId,
        role,
        assignmentId,
        prompt,
        timestamp: atMs
      }) : null
      if (connection) assignment.deliveryCount += 1
      // Persist the assignment intent and delivery count before attempting transport.
      await this.store.replace(this.#validatedState())
      let sent = false
      if (connection) {
        try { sent = connection.send(message) !== false }
        catch { sent = false }
        if (!sent) {
          assignment.state = "needs_reconciliation"
          assignment.updatedAtMs = nowValue(this.now)
          this.#appendRunnerEvent(this.state, "assignment_needs_reconciliation", {
            role,
            assignmentId,
            reason: "assignment transport outcome was not confirmed"
          }, { role, assignmentId })
          this.state.updatedAtMs = nowValue(this.now)
          await this.store.replace(this.#validatedState())
        }
      }
      return { status: sent ? "sent" : "queued", assignment: this.#assignmentSummary(assignment), sent }
    })
  }

  async recordHumanTakeover(role, { source = "interactive", reason = "submitted human input" } = {}) {
    validateRole(role)
    return this.#enqueue(async () => {
      this.#requireInitialized()
      const bridge = this.state.bridges[role]
      const assignment = this.#assignmentForRole(this.state, role)
      if (bridge.controlMode === "manual_takeover") return { changed: false, role }
      bridge.controlMode = "manual_takeover"
      if (assignment && ACTIVE_ASSIGNMENT_STATES.has(assignment.state)) {
        assignment.state = "needs_reconciliation"
        assignment.updatedAtMs = nowValue(this.now)
      }
      const atMs = nowValue(this.now)
      this.#appendRunnerEvent(this.state, "manual_takeover", {
        role,
        source: String(source).slice(0, 128),
        reason: String(reason).slice(0, 256)
      }, { role, assignmentId: assignment?.assignmentId ?? null })
      this.state.updatedAtMs = atMs
      await this.store.replace(this.#validatedState())
      return { changed: true, role, assignmentId: assignment?.assignmentId ?? null }
    })
  }

  async recordArtifact(artifact) {
    plainObject(artifact, "artifact")
    return this.#enqueue(async () => {
      this.#requireInitialized()
      const normalized = clone(artifact)
      const existing = this.state.artifacts.find(item => item.artifactId === normalized.artifactId)
      if (existing) {
        requireCondition(JSON.stringify(existing) === JSON.stringify(normalized),
          "artifact_conflict", "Artifact ID is already bound to different content")
        return { status: "duplicate", artifact: clone(existing) }
      }
      requireCondition(this.state.artifacts.length < this.maxArtifacts,
        "artifact_limit", "Runner artifact retention limit is reached")
      requireCondition(normalized.schema === ARTIFACT_SCHEMA, "invalid_artifact", "Artifact schema is invalid")
      validateTelemetry(normalized.result)
      const candidate = clone(this.state)
      candidate.artifacts.push(normalized)
      validateRunnerState(candidate, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts })
      const atMs = nowValue(this.now)
      this.state.artifacts.push(normalized)
      this.#appendRunnerEvent(this.state, normalized.kind === "validation" ? "validation_recorded" : "artifact_recorded", {
        artifactId: normalized.artifactId,
        role: normalized.role,
        kind: normalized.kind
      })
      this.state.updatedAtMs = atMs
      await this.store.replace(this.#validatedState())
      return { status: "recorded", artifact: clone(normalized) }
    })
  }

  async recordValidation(payload) {
    plainObject(payload, "validation payload")
    const required = ["artifactId", "command", "exitCode", "stdoutMetadata", "stderrMetadata"]
    const allowed = new Set([...required, "signal", "result", "capturedAtMs", "role"])
    requireCondition(required.every(key => Object.hasOwn(payload, key))
      && Object.keys(payload).every(key => allowed.has(key)),
    "invalid_artifact", "Validation control payload requires metadata only and contains missing or unknown fields")
    const artifact = makeValidationArtifact({
      artifactId: payload.artifactId,
      command: payload.command,
      exitCode: payload.exitCode,
      signal: payload.signal ?? null,
      stdoutMetadata: payload.stdoutMetadata,
      stderrMetadata: payload.stderrMetadata,
      result: payload.result ?? null,
      capturedAtMs: payload.capturedAtMs ?? nowValue(this.now),
      role: payload.role ?? null
    })
    validateValidationArtifact(artifact)
    return this.recordArtifact(artifact)
  }

  async acceptControl(controlHello, send) {
    validateMessage(controlHello)
    requireCondition(controlHello.type === "control_hello", "handshake_required", "Control hello is required")
    requireCondition(typeof send === "function", "invalid_transport", "Control send function is required")
    return this.#enqueue(async () => {
      this.#requireInitialized()
      requireCondition(controlHello.receiptId === this.receiptId && controlHello.teamGoalId === this.teamGoalId,
        "control_identity_mismatch", "Control hello does not address this runner")
      for (const value of this.controls.values()) {
        if (value.controlClientId === controlHello.controlClientId) {
          const connectionId = this.#nextConnectionId("rejected-control")
          return {
            accepted: false,
            connectionId,
            acknowledgement: makeControlAck({
              connectionId,
              accepted: false,
              reason: "control_client_already_connected",
              timestamp: nowValue(this.now)
            })
          }
        }
      }
      const connectionId = this.#nextConnectionId("control")
      this.controls.set(connectionId, { controlClientId: controlHello.controlClientId, send })
      return {
        accepted: true,
        connectionId,
        acknowledgement: makeControlAck({ connectionId, accepted: true, timestamp: nowValue(this.now) })
      }
    })
  }

  async disconnectControl(connectionId) {
    this.controls.delete(connectionId)
  }

  async handleControlMessage(connectionId, request) {
    validateMessage(request)
    this.#requireInitialized()
    requireCondition(this.controls.has(connectionId), "unknown_connection", "Control connection is not registered")
    requireCondition(request.type === "control_request", "unexpected_message", "Expected a control request")
    try {
      const data = await this.#controlOperation(request.operation, request.payload ?? {})
      return makeControlResponse({
        requestId: request.requestId,
        status: "ok",
        data,
        timestamp: nowValue(this.now)
      })
    } catch (error) {
      const report = messageError(error)
      return makeControlResponse({
        requestId: request.requestId,
        status: "error",
        error: { code: report.code, message: report.message, details: report.details },
        timestamp: nowValue(this.now)
      })
    }
  }

  #controlOperation(operation, payload) {
    plainObject(payload, "control payload")
    switch (operation) {
      case "snapshot":
        return this.snapshot()
      case "events":
        return this.eventPage({ after: payload.after ?? null, limit: payload.limit ?? LIMITS.eventPageItems })
      case "assign":
        return this.issueAssignment({ role: payload.role, assignmentId: payload.assignmentId, prompt: payload.prompt })
      case "record_artifact":
        return this.recordArtifact(payload.artifact)
      case "record_validation":
        return this.recordValidation(payload)
      case "ping":
        return { ok: true, cursor: this.#cursor(this.state.sequence) }
      default:
        throw spikeError("invalid_operation", `Unsupported control operation: ${operation}`)
    }
  }

  #handleAssignmentAck(bridge, role, message) {
    requireCondition(message.role === role, "binding_mismatch", "Assignment acknowledgement role differs from connection role")
    const assignment = this.#assignmentForId(this.state, message.assignmentId)
    requireCondition(assignment && assignment.role === role, "assignment_unknown", "Assignment acknowledgement is not owned by this role")
    const atMs = nowValue(this.now)
    assignment.lastAck = {
      status: message.status,
      timestamp: message.timestamp,
      ...(message.reason === undefined ? {} : { reason: message.reason })
    }
    if (message.status === "accepted") {
      if (assignment.state === "pending") assignment.state = "accepted"
      bridge.assignmentId = assignment.assignmentId
    } else if (message.status === "invalid") {
      assignment.state = "needs_reconciliation"
    }
    assignment.updatedAtMs = atMs
    this.#appendRunnerEvent(this.state, "assignment_acknowledged", {
      role,
      assignmentId: message.assignmentId,
      status: message.status,
      reason: message.reason ?? null
    }, { role, assignmentId: message.assignmentId })
    this.state.updatedAtMs = atMs
    return this.store.replace(this.#validatedState()).then(() => ({ recorded: true }))
  }

  #handleBridgeEvent(bridge, role, message, connection) {
    requireRole(message.role)
    requireCondition(message.role === role, "binding_mismatch", "Bridge event role differs from connection role")
    const assignment = this.#assignmentForRole(this.state, role)
    if (message.assignmentId !== undefined && message.assignmentId !== null) {
      requireCondition(assignment?.assignmentId === message.assignmentId,
        "assignment_mismatch", "Bridge event is not for the receipt-owned role assignment")
    }
    if (this.state.seenEventIds.includes(message.eventId)) return Promise.resolve({ recorded: false, duplicate: true })
    if (message.sequence <= bridge.lastBridgeSequence
      && message.sequence <= connection.initialBridgeSequence) {
      // The reconnect hello already reported this source cursor. The frame may
      // still be queued locally, so discard it without turning a known gap into
      // a failed reconnect.
      return Promise.resolve({ recorded: false, duplicate: true, cursorCovered: true })
    }
    requireCondition(message.sequence > bridge.lastBridgeSequence,
      "stale_event", "Bridge event sequence is not newer than the durable sequence", {
        expectedGreaterThan: bridge.lastBridgeSequence,
        observed: message.sequence
      })
    const gap = message.sequence > bridge.lastBridgeSequence + 1
    const atMs = nowValue(this.now)
    if (gap) {
      this.#appendRunnerEvent(this.state, "bridge_event_gap", {
        role,
        expectedSequence: bridge.lastBridgeSequence + 1,
        observedSequence: message.sequence,
        sourceEventId: message.eventId
      }, { role, assignmentId: message.assignmentId ?? null })
    }
    this.#appendRunnerEvent(this.state, message.eventType, message.data, {
      role,
      sourceEventId: message.eventId,
      sourceSequence: message.sequence,
      assignmentId: message.assignmentId ?? null,
      gapBefore: gap
    })
    this.#rememberEventId(this.state, message.eventId)
    bridge.lastBridgeSequence = message.sequence
    bridge.lastEventId = message.eventId
    this.#applyBridgeEventState(bridge, assignment, message)
    this.state.updatedAtMs = atMs
    return this.store.replace(this.#validatedState()).then(() => ({ recorded: true, gap }))
  }

  #handleBridgeSnapshot(bridge, role, message) {
    requireCondition(message.role === role, "binding_mismatch", "Bridge snapshot role differs from connection role")
    const assignment = this.#assignmentForRole(this.state, role)
    if (message.assignment !== null) {
      requireCondition(assignment?.assignmentId === message.assignment.assignmentId,
        "assignment_mismatch", "Bridge snapshot reports an unknown assignment")
    }
    const atMs = nowValue(this.now)
    if (message.sequence < bridge.lastBridgeSequence) {
      this.#appendRunnerEvent(this.state, "bridge_event_gap", {
        role,
        expectedSequence: bridge.lastBridgeSequence,
        observedSequence: message.sequence,
        source: "state_snapshot_older_than_runner"
      }, { role, assignmentId: assignment?.assignmentId ?? null })
    } else {
      const previousSequence = bridge.lastBridgeSequence
      const gap = message.sequence > bridge.lastBridgeSequence + 1
      if (gap) {
        this.#appendRunnerEvent(this.state, "bridge_event_gap", {
          role,
          expectedSequence: bridge.lastBridgeSequence + 1,
          observedSequence: message.sequence,
          source: "bridge_state_snapshot"
        }, { role, sourceEventId: message.lastEventId ?? null,
          sourceSequence: message.sequence, assignmentId: assignment?.assignmentId ?? null })
      }
      bridge.lastBridgeSequence = message.sequence
      if (message.lastEventId !== undefined) bridge.lastEventId = message.lastEventId
      else if (message.sequence !== previousSequence) bridge.lastEventId = null
    }
    if (message.controlMode === "manual_takeover") {
      bridge.controlMode = "manual_takeover"
      if (assignment && ACTIVE_ASSIGNMENT_STATES.has(assignment.state)) assignment.state = "needs_reconciliation"
    }
    if (message.assignment?.state === "needs_reconciliation" && assignment) assignment.state = "needs_reconciliation"
    this.#appendRunnerEvent(this.state, "bridge_state_snapshot", {
      role,
      sequence: message.sequence,
      controlMode: message.controlMode,
      assignmentId: message.assignment?.assignmentId ?? null
    }, { role, assignmentId: message.assignment?.assignmentId ?? null })
    this.state.updatedAtMs = atMs
    return this.store.replace(this.#validatedState()).then(() => ({ recorded: true }))
  }

  #applyBridgeEventState(bridge, assignment, message) {
    if (message.eventType === "human_message_submitted" || message.eventType === "manual_takeover") {
      bridge.controlMode = "manual_takeover"
      if (assignment && ACTIVE_ASSIGNMENT_STATES.has(assignment.state)) assignment.state = "needs_reconciliation"
      return
    }
    if (!assignment) return
    if (message.eventType === "assignment_started" || message.eventType === "agent_started") {
      if (assignment.state === "pending" || assignment.state === "accepted") assignment.state = "working"
    } else if (message.eventType === "assignment_settled" || message.eventType === "agent_settled") {
      assignment.state = bridge.controlMode === "manual_takeover" ? "needs_reconciliation" : "settled"
    } else if (message.eventType === "assignment_needs_reconciliation") {
      assignment.state = "needs_reconciliation"
    }
    assignment.updatedAtMs = nowValue(this.now)
  }

  #validatedState() {
    return validateRunnerState(this.state, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts })
  }

  #requireInitialized() {
    requireCondition(this.initialized && this.state !== null, "runner_not_initialized", "RunnerCore is not initialized")
  }

  #nextConnectionId(kind) {
    this.connectionNumber += 1
    return this.makeConnectionId(kind, this.connectionNumber)
  }

  #connectionForRole(role) {
    for (const connection of this.bridges.values()) if (connection.role === role) return connection
    return null
  }

  #assignmentForRole(state, role) {
    const assignments = state.assignments.filter(item => item.role === role)
    return assignments.at(-1) ?? null
  }

  #assignmentForId(state, assignmentId) {
    return state.assignments.find(item => item.assignmentId === assignmentId) ?? null
  }

  #assignmentSummary(assignment) {
    return {
      assignmentId: assignment.assignmentId,
      role: assignment.role,
      state: assignment.state,
      promptCharacters: assignment.prompt.length,
      ...(assignment.lastAck === null ? {} : { lastAck: clone(assignment.lastAck) })
    }
  }

  #cursor(sequence) {
    return `runner-${this.receiptId}:${sequence}`
  }

  #snapshot(state) {
    const bridges = {}
    for (const role of ROLES) {
      const bridge = state.bridges[role]
      bridges[role] = {
        role,
        agentRunId: bridge.agentRunId,
        shellId: bridge.shellId,
        connectionState: bridge.connectionState,
        piSessionId: bridge.piSessionId,
        extensionInstanceId: bridge.extensionInstanceId,
        pid: bridge.pid,
        controlMode: bridge.controlMode,
        assignmentId: bridge.assignmentId,
        lastBridgeSequence: bridge.lastBridgeSequence,
        connectionCount: bridge.connectionCount
      }
    }
    return {
      receiptId: state.receiptId,
      teamGoalId: state.teamGoalId,
      cursor: this.#cursor(state.sequence),
      firstCursor: this.#cursor(state.firstSequence - 1),
      sequence: state.sequence,
      bindings: clone(state.bindings),
      bridges,
      assignments: state.assignments.map(item => this.#assignmentSummary(item)),
      artifacts: state.artifacts.map(item => ({
        artifactId: item.artifactId,
        role: item.role,
        kind: item.kind,
        schema: item.schema,
        createdAtMs: item.createdAtMs
      }))
    }
  }

  #eventPage(state, after, limit) {
    let afterSequence = null
    let gap = false
    let gapReason = null
    if (after !== null) {
      const prefix = `runner-${this.receiptId}:`
      requireCondition(after.startsWith(prefix), "invalid_cursor", "Event cursor belongs to another runner")
      const suffix = after.slice(prefix.length)
      requireCondition(/^(?:0|[1-9][0-9]*)$/.test(suffix), "invalid_cursor", "Event cursor sequence is invalid")
      afterSequence = Number(suffix)
      requireCondition(Number.isSafeInteger(afterSequence) && afterSequence >= 0,
        "invalid_cursor", "Event cursor sequence is out of range")
      requireCondition(afterSequence <= state.sequence, "invalid_cursor", "Event cursor is ahead of the runner")
      if (afterSequence < state.firstSequence - 1) {
        gap = true
        gapReason = "cursor_expired"
      }
    } else {
      gap = true
      gapReason = "baseline_requested"
    }
    const events = (gap && after !== null
      ? state.events
      : state.events.filter(event => afterSequence === null || event.sequence > afterSequence))
      .slice(0, limit)
    return {
      cursor: this.#cursor(state.sequence),
      firstCursor: this.#cursor(state.firstSequence - 1),
      baseline: after === null || gap,
      gap,
      ...(gapReason === null ? {} : { gapReason }),
      snapshot: gap ? this.#snapshot(state) : null,
      events
    }
  }

  #appendRunnerEvent(state, eventType, data, {
    role = "runner",
    sourceEventId = null,
    sourceSequence = null,
    assignmentId = null,
    gapBefore = false
  } = {}) {
    requireCondition(EVENT_TYPES_SET.has(eventType), "invalid_event_type", `Event type ${eventType} is not allowed`)
    validateTelemetry(data)
    const sequence = state.sequence + 1
    const event = {
      sequence,
      cursor: this.#cursor(sequence),
      role,
      eventId: `runner-event-${this.receiptId}:${sequence}`,
      sourceEventId,
      sourceSequence,
      eventType,
      assignmentId,
      timestamp: nowValue(this.now),
      data: clone(data),
      gapBefore
    }
    state.sequence = sequence
    state.events.push(event)
    if (state.events.length > this.maxEvents) state.events.shift()
    state.firstSequence = state.events.length > 0 ? state.events[0].sequence : state.sequence + 1
    return event
  }

  #rememberEventId(state, eventId) {
    if (state.seenEventIds.includes(eventId)) return
    state.seenEventIds.push(eventId)
    while (state.seenEventIds.length > 2_048) state.seenEventIds.shift()
  }

  #enqueue(operation) {
    const result = this.operationQueue.then(operation, operation)
    this.operationQueue = result.catch(() => {})
    return result
  }
}

export const DurableRunnerCore = RunnerCore