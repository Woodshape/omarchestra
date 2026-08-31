import assert from "node:assert/strict"
import { test } from "node:test"

import {
  LIMITS,
  NdjsonDecoder,
  encodeMessage,
  makeAssignment,
  makeControlRequest,
  makeHello,
  makeHelloAck,
  validateMessage,
  validateTelemetry
} from "../lib/protocol.mjs"
import { REMOTE_IDS } from "./remote-fixtures.mjs"

test("remote bridge protocol requires complete visible ownership identity", () => {
  const hello = makeHello({
    teamGoalId: REMOTE_IDS.teamGoal,
    role: "builder",
    agentRunId: REMOTE_IDS.builder,
    shellId: "shell-builder",
    piSessionId: "pi-builder",
    extensionInstanceId: "extension-builder",
    pid: 102,
    mode: "tui",
    timestamp: 1
  })
  assert.equal(validateMessage(hello), hello)
  for (const field of ["teamGoalId", "role", "agentRunId", "shellId", "piSessionId", "extensionInstanceId", "pid", "mode"]) {
    const invalid = { ...hello }
    delete invalid[field]
    assert.throws(() => validateMessage(invalid), error => error.code === "missing_field", field)
  }
  assert.throws(() => makeHello({ ...hello, mode: "rpc" }), error => error.code === "invalid_mode")
  assert.throws(() => makeHello({ ...hello, pid: 0 }), error => error.code === "invalid_integer")
})

test("protocol rejects unknown fields, invalid assignments, and oversized frames", () => {
  const assignment = makeAssignment({
    teamGoalId: REMOTE_IDS.teamGoal,
    role: "reviewer",
    assignmentId: "assignment-1",
    prompt: "Review the change",
    timestamp: 1
  })
  assert.equal(assignment.type, "assignment")
  assert.throws(() => validateMessage({ ...assignment, extra: true }), error => error.code === "unknown_field")
  assert.throws(() => makeAssignment({ ...assignment, prompt: "x".repeat(LIMITS.promptCharacters + 1) }),
    error => error.code === "invalid_string")
  assert.throws(() => makeHelloAck({ connectionId: "runner-1", accepted: true, reason: "no", timestamp: 1 }),
    error => error.code === "invalid_field")
  assert.throws(() => encodeMessage({ ...assignment, prompt: "x".repeat(LIMITS.promptCharacters + 1),
    teamGoalId: REMOTE_IDS.teamGoal, role: "reviewer", assignmentId: "a", timestamp: 1 }),
    error => error.code === "frame_too_large" || error.code === "invalid_string")
})

test("NDJSON decoding accepts fragmentation and rejects malformed or unbounded input", () => {
  const hello = makeHello({
    teamGoalId: REMOTE_IDS.teamGoal,
    role: "coordinator",
    agentRunId: REMOTE_IDS.coordinator,
    shellId: "shell-coordinator",
    piSessionId: "pi-coordinator",
    extensionInstanceId: "extension-coordinator",
    pid: 101,
    mode: "tui",
    timestamp: 1
  })
  const frame = encodeMessage(hello)
  const decoder = new NdjsonDecoder()
  assert.deepEqual(decoder.push(frame.slice(0, 9)), [])
  assert.deepEqual(decoder.push(frame.slice(9)), [hello])
  assert.throws(() => new NdjsonDecoder().push("{bad}\n"), error => error.code === "invalid_json")
  assert.throws(() => new NdjsonDecoder().push("x".repeat(LIMITS.decoderBufferBytes + 1)),
    error => error.code === "buffer_too_large")
})

test("control requests are framed separately from bridge assignment and event payloads", () => {
  const request = makeControlRequest({
    requestId: "request-1",
    operation: "events",
    payload: { after: null, limit: 10 },
    timestamp: 1
  })
  assert.deepEqual(JSON.parse(encodeMessage(request)), request)
  assert.throws(() => makeControlRequest({ requestId: "request-1", operation: "shell_input", timestamp: 1 }),
    error => error.code === "invalid_operation")
  assert.throws(() => validateTelemetry({ bad: undefined }), error => error.code === "invalid_telemetry")
})