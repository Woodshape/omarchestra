import assert from "node:assert/strict"
import { test } from "node:test"

import { makeAssignmentAck, makeEvent, makeHello } from "../lib/protocol.mjs"
import { MemoryDurableStore } from "../lib/durable-store.mjs"
import { RunnerCore } from "../lib/runner-core.mjs"
import { fakeClock, REMOTE_BINDINGS, REMOTE_IDS, bridgeHello } from "./remote-fixtures.mjs"

function makeCore(options = {}) {
  return new RunnerCore({
    store: options.store ?? new MemoryDurableStore(),
    receiptId: REMOTE_IDS.receipt,
    teamGoalId: REMOTE_IDS.teamGoal,
    bindings: REMOTE_BINDINGS,
    now: options.now ?? fakeClock(),
    maxEvents: options.maxEvents ?? 32,
    maxArtifacts: options.maxArtifacts ?? 8
  })
}

test("runner owns exactly three role bindings and rejects cross-role handshakes", async () => {
  const core = makeCore()
  await core.initialize()
  const sent = new Map()
  for (const role of ["coordinator", "builder", "reviewer"]) {
    const output = []
    sent.set(role, output)
    const result = await core.acceptBridge(bridgeHello(role), message => {
      output.push(message)
      return true
    })
    assert.equal(result.accepted, true)
    assert.equal(result.role, role)
    assert.equal(result.messages[0].type, "runner_snapshot")
  }
  const snapshot = await core.snapshot()
  assert.deepEqual(Object.keys(snapshot.bindings).sort(), ["builder", "coordinator", "reviewer"])
  assert.equal(new Set(Object.values(snapshot.bindings).map(binding => binding.agentRunId)).size, 3)
  await assert.rejects(
    () => core.acceptBridge(makeHello({
      ...bridgeHello("builder"),
      role: "reviewer",
      agentRunId: REMOTE_BINDINGS.builder.agentRunId,
      shellId: REMOTE_BINDINGS.builder.shellId,
      piSessionId: "other-pi",
      extensionInstanceId: "other-extension",
      pid: 999
    }), () => true),
    error => error.code === "connection_conflict" || error.code === "bridge_identity_changed" || error.code === "binding_mismatch"
  )
  assert.equal(sent.get("builder").filter(message => message.type === "assignment").length, 0)
})

test("assignment acknowledgement and bridge events are durable, ordered, and deduplicated", async () => {
  const core = makeCore()
  await core.initialize()
  const output = []
  const bridge = await core.acceptBridge(bridgeHello("builder"), message => {
    output.push(message)
    return true
  })
  const issued = await core.issueAssignment({
    role: "builder",
    assignmentId: "assignment-builder-1",
    prompt: "Implement the bounded spike"
  })
  assert.equal(issued.status, "sent")
  assert.equal(output.at(-1).type, "assignment")
  const acknowledged = await core.handleBridgeMessage(bridge.connectionId, makeAssignmentAck({
    role: "builder",
    assignmentId: "assignment-builder-1",
    status: "accepted",
    timestamp: 10
  }))
  assert.equal(acknowledged.recorded, true)
  const firstEvent = makeEvent({
    role: "builder",
    eventId: "bridge-event-builder-1",
    sequence: 1,
    eventType: "assignment_started",
    assignmentId: "assignment-builder-1",
    timestamp: 11,
    data: { tool: "none" }
  })
  assert.equal((await core.handleBridgeMessage(bridge.connectionId, firstEvent)).recorded, true)
  const duplicate = await core.handleBridgeMessage(bridge.connectionId, firstEvent)
  assert.equal(duplicate.duplicate, true)
  const gapEvent = makeEvent({
    role: "builder",
    eventId: "bridge-event-builder-3",
    sequence: 3,
    eventType: "message_ended",
    assignmentId: "assignment-builder-1",
    timestamp: 12,
    data: { role: "assistant", textCharacters: 12 }
  })
  const gap = await core.handleBridgeMessage(bridge.connectionId, gapEvent)
  assert.equal(gap.gap, true)
  const page = await core.eventPage({ after: null, limit: 32 })
  assert.equal(page.baseline, true)
  assert.equal(page.gap, true)
  assert.deepEqual(page.events.map(event => event.eventType), [
    "bridge_connected", "assignment_issued", "assignment_acknowledged", "assignment_started",
    "bridge_event_gap", "message_ended"
  ])
  assert.equal(page.events.at(-1).gapBefore, true)
  const snapshot = await core.snapshot()
  assert.equal(snapshot.assignments[0].state, "working")
  assert.equal(snapshot.bridges.builder.lastBridgeSequence, 3)
})

test("assignment intent remains durable when bridge delivery is not confirmed", async () => {
  const core = makeCore()
  await core.initialize()
  const connection = await core.acceptBridge(bridgeHello("builder"), () => false)
  const result = await core.issueAssignment({
    role: "builder", assignmentId: "unconfirmed-delivery", prompt: "Do not infer delivery"
  })
  assert.equal(result.sent, false)
  assert.equal(result.status, "queued")
  assert.equal(result.assignment.state, "needs_reconciliation")
  const snapshot = await core.snapshot()
  assert.equal(snapshot.assignments[0].state, "needs_reconciliation")
  assert.ok((await core.eventPage({ after: null })).events.some(event =>
    event.eventType === "assignment_needs_reconciliation"))
})

test("manual takeover updates only the submitted role and blocks its dependent dispatch", async () => {
  const core = makeCore()
  await core.initialize()
  const connections = {}
  for (const role of ["coordinator", "builder", "reviewer"]) {
    const result = await core.acceptBridge(bridgeHello(role), () => true)
    connections[role] = result.connectionId
  }
  await core.issueAssignment({ role: "builder", assignmentId: "builder-work", prompt: "Change files" })
  await core.handleBridgeMessage(connections.builder, makeAssignmentAck({
    role: "builder", assignmentId: "builder-work", status: "accepted", timestamp: 20
  }))
  const takeover = await core.recordHumanTakeover("builder", { source: "interactive" })
  assert.equal(takeover.changed, true)
  const snapshot = await core.snapshot()
  assert.equal(snapshot.bridges.builder.controlMode, "manual_takeover")
  assert.equal(snapshot.bridges.coordinator.controlMode, "managed")
  assert.equal(snapshot.bridges.reviewer.controlMode, "managed")
  assert.equal(snapshot.assignments[0].state, "needs_reconciliation")
  const reviewer = await core.issueAssignment({ role: "reviewer", assignmentId: "review-work", prompt: "Review" })
  assert.equal(reviewer.status, "sent")
  await assert.rejects(
    () => core.issueAssignment({ role: "builder", assignmentId: "builder-work-2", prompt: "More" }),
    error => error.code === "takeover_active"
  )
})

test("runner restart restores identity and resends the same active assignment without changing siblings", async () => {
  const store = new MemoryDurableStore()
  const first = makeCore({ store })
  await first.initialize()
  const output = []
  const connected = await first.acceptBridge(bridgeHello("builder"), message => {
    output.push(message)
    return true
  })
  await first.issueAssignment({ role: "builder", assignmentId: "durable-assignment", prompt: "Persist this work" })
  await first.handleBridgeMessage(connected.connectionId, makeAssignmentAck({
    role: "builder", assignmentId: "durable-assignment", status: "accepted", timestamp: 4
  }))
  await first.handleBridgeMessage(connected.connectionId, makeEvent({
    role: "builder", eventId: "event-before-restart", sequence: 1,
    eventType: "assignment_started", assignmentId: "durable-assignment", timestamp: 5, data: {}
  }))

  const second = makeCore({ store, now: fakeClock(100) })
  const restored = await second.initialize()
  assert.ok(restored.sequence > 0)
  assert.equal(restored.assignments[0].assignmentId, "durable-assignment")
  const reconnectOutput = []
  const reconnected = await second.acceptBridge(bridgeHello("builder", {
    lastEventSequence: 1,
    lastEventId: "event-before-restart"
  }), message => {
    reconnectOutput.push(message)
    return true
  })
  assert.equal(reconnected.resumed, true)
  reconnectOutput.push(...reconnected.messages)
  assert.equal(reconnectOutput.at(-1).type, "assignment")
  assert.equal(reconnectOutput.at(-1).assignmentId, "durable-assignment")
  const after = await second.snapshot()
  assert.equal(after.bridges.builder.piSessionId, "pi-builder")
  assert.equal(after.bridges.builder.pid, 102)
  assert.equal(after.bridges.coordinator.connectionState, "disconnected")
  assert.equal(after.bridges.reviewer.connectionState, "disconnected")
  assert.ok(after.sequence > restored.sequence)
  assert.ok(output.some(message => message.type === "assignment"))
})

test("bridge hello cursor gaps are recorded before reconnect snapshot delivery", async () => {
  const core = makeCore()
  await core.initialize()
  const result = await core.acceptBridge(bridgeHello("reviewer", {
    lastEventSequence: 3,
    lastEventId: "reviewer-event-3"
  }), () => true)
  assert.equal(result.accepted, true)
  const snapshot = await core.snapshot()
  assert.equal(snapshot.bridges.reviewer.lastBridgeSequence, 3)
  const page = await core.eventPage({ after: null, limit: 10 })
  assert.ok(page.events.some(event => event.eventType === "bridge_event_gap"
    && event.data.source === "bridge_hello_cursor"))
  const covered = await core.handleBridgeMessage(result.connectionId, makeEvent({
    role: "reviewer", eventId: "reviewer-event-2", sequence: 2,
    eventType: "message_started", timestamp: 4, data: {}
  }))
  assert.equal(covered.cursorCovered, true)
})

test("bounded cursor retention reports an explicit baseline and gap", async () => {
  const core = makeCore({ maxEvents: 3 })
  await core.initialize()
  const connection = await core.acceptBridge(bridgeHello("coordinator"), () => true)
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    await core.handleBridgeMessage(connection.connectionId, makeEvent({
      role: "coordinator",
      eventId: `coordinator-event-${sequence}`,
      sequence,
      eventType: "message_started",
      timestamp: sequence,
      data: { sequence }
    }))
  }
  const page = await core.eventPage({ after: "runner-10000000-0000-4000-8000-000000000001:1", limit: 3 })
  assert.equal(page.gap, true)
  assert.equal(page.gapReason, "cursor_expired")
  assert.ok(page.snapshot)
  assert.equal(page.baseline, true)
})