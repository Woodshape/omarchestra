import { StringDecoder } from "node:string_decoder"

export const PROTOCOL_VERSION = 1
export const PROTOCOL_SCHEMA = "omarchestra.remote-execution-node.protocol/v1"

export const ROLES = Object.freeze(["coordinator", "builder", "reviewer"])
export const CONTROL_MODES = Object.freeze(["managed", "manual_takeover"])
export const ASSIGNMENT_STATES = Object.freeze([
  "pending", "accepted", "working", "settled", "needs_reconciliation", "failed"
])
export const ASSIGNMENT_ACK_STATUSES = Object.freeze([
  "accepted", "busy", "duplicate", "invalid"
])
export const EVENT_TYPES = Object.freeze([
  "bridge_connected",
  "bridge_disconnected",
  "bridge_reconnected",
  "session_started",
  "session_shutdown",
  "assignment_issued",
  "assignment_started",
  "assignment_acknowledged",
  "assignment_settled",
  "assignment_needs_reconciliation",
  "agent_started",
  "agent_ended",
  "agent_settled",
  "message_started",
  "message_updated",
  "message_ended",
  "tool_started",
  "tool_updated",
  "tool_ended",
  "attention_required",
  "attention_resolved",
  "human_message_submitted",
  "manual_takeover",
  "bridge_state_snapshot",
  "bridge_event_gap",
  "artifact_recorded",
  "validation_recorded",
  "runner_restarted"
])
export const CONTROL_OPERATIONS = Object.freeze([
  "snapshot", "events", "assign", "record_artifact", "record_validation", "ping"
])

export const LIMITS = Object.freeze({
  idCharacters: 128,
  uuidCharacters: 36,
  roleCharacters: 32,
  promptCharacters: 16_384,
  reasonCharacters: 1_024,
  metadataStringCharacters: 512,
  telemetryBytes: 16_384,
  telemetryDepth: 6,
  telemetryKeys: 64,
  telemetryArrayItems: 64,
  telemetryStringCharacters: 4_096,
  frameBytes: 65_536,
  decoderBufferBytes: 131_072,
  eventPageItems: 256,
  pendingMessages: 256
})

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ROLE_SET = new Set(ROLES)
const CONTROL_MODE_SET = new Set(CONTROL_MODES)
const ASSIGNMENT_STATE_SET = new Set(ASSIGNMENT_STATES)
const ACK_STATUS_SET = new Set(ASSIGNMENT_ACK_STATUSES)
const EVENT_TYPE_SET = new Set(EVENT_TYPES)
const OPERATION_SET = new Set(CONTROL_OPERATIONS)

export class ProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "ProtocolError"
    this.code = code
    this.details = details
  }
}

function fail(code, message, details = {}) {
  throw new ProtocolError(code, message, details)
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_type", `${label} must be a plain object`)
  }
}

function assertExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("missing_field", `Missing field: ${key}`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field", `Unknown field: ${key}`)
  }
}

function assertVersion(value) {
  if (value !== PROTOCOL_VERSION) {
    fail("unsupported_version", `protocolVersion must be ${PROTOCOL_VERSION}`)
  }
}

function assertId(value, label, { uuid = false } = {}) {
  const pattern = uuid ? UUID_PATTERN : ID_PATTERN
  if (typeof value !== "string" || pattern.test(value) === false) {
    fail("invalid_id", `${label} is invalid`)
  }
}

function assertRole(value, label = "role") {
  if (!ROLE_SET.has(value)) fail("invalid_role", `${label} must be one of ${ROLES.join(", ")}`)
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_timestamp", "timestamp must be a non-negative safe integer")
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("invalid_integer", `${label} must be positive`)
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_integer", `${label} must be non-negative`)
}

function assertString(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum
    || /[\0\r\n]/.test(value)) {
    fail("invalid_string", `${label} is invalid`)
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") fail("invalid_type", `${label} must be boolean`)
}

function assertNullableString(value, label, maximum) {
  if (value !== null) assertString(value, label, maximum)
}

function assertSequence(value, label = "sequence") {
  assertNonNegativeInteger(value, label)
}

function assertBase(value, required, optional = []) {
  assertPlainObject(value, "message")
  assertExactKeys(value, ["type", "protocolVersion", ...required], optional)
  assertVersion(value.protocolVersion)
}

function inspectTelemetry(value, depth, seen) {
  if (value === null || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_telemetry", "telemetry numbers must be finite")
    return
  }
  if (typeof value === "string") {
    if (value.length > LIMITS.telemetryStringCharacters) {
      fail("telemetry_too_large", "telemetry string exceeds its limit")
    }
    if (/[\0\r\n]/.test(value)) fail("invalid_telemetry", "telemetry strings contain a forbidden character")
    return
  }
  if (typeof value !== "object") fail("invalid_telemetry", "telemetry must contain JSON values")
  if (seen.has(value)) fail("invalid_telemetry", "telemetry must not contain cycles")
  if (depth >= LIMITS.telemetryDepth) fail("telemetry_too_deep", "telemetry exceeds its depth limit")
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > LIMITS.telemetryArrayItems) {
      fail("telemetry_too_large", "telemetry array exceeds its item limit")
    }
    for (const item of value) inspectTelemetry(item, depth + 1, seen)
  } else {
    assertPlainObject(value, "telemetry object")
    const keys = Object.keys(value)
    if (keys.length > LIMITS.telemetryKeys) {
      fail("telemetry_too_large", "telemetry object exceeds its key limit")
    }
    for (const [key, item] of Object.entries(value)) {
      assertString(key, "telemetry key", LIMITS.metadataStringCharacters, { allowEmpty: true })
      inspectTelemetry(item, depth + 1, seen)
    }
  }
  seen.delete(value)
}

export function validateTelemetry(value) {
  inspectTelemetry(value, 0, new Set())
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > LIMITS.telemetryBytes) {
    fail("telemetry_too_large", `telemetry exceeds ${LIMITS.telemetryBytes} encoded bytes`)
  }
  return value
}

function validateBridgeHello(value) {
  assertBase(value, [
    "teamGoalId", "role", "agentRunId", "shellId", "piSessionId", "extensionInstanceId",
    "pid", "mode", "timestamp"
  ], ["lastEventSequence", "lastEventId"])
  assertId(value.teamGoalId, "teamGoalId", { uuid: true })
  assertRole(value.role)
  assertId(value.agentRunId, "agentRunId", { uuid: true })
  assertId(value.shellId, "shellId")
  assertId(value.piSessionId, "piSessionId")
  assertId(value.extensionInstanceId, "extensionInstanceId")
  assertPositiveInteger(value.pid, "pid")
  if (value.mode !== "tui") fail("invalid_mode", "visible bridge mode must be tui")
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "lastEventSequence")) assertSequence(value.lastEventSequence, "lastEventSequence")
  if (Object.hasOwn(value, "lastEventId")) assertId(value.lastEventId, "lastEventId")
}

function validateHelloAck(value) {
  assertBase(value, ["connectionId", "accepted", "timestamp"], [
    "reason", "role", "resumed", "cursor"
  ])
  assertId(value.connectionId, "connectionId")
  assertBoolean(value.accepted, "accepted")
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "role")) assertRole(value.role)
  if (Object.hasOwn(value, "resumed")) assertBoolean(value.resumed, "resumed")
  if (Object.hasOwn(value, "cursor")) assertId(value.cursor, "cursor")
  if (value.accepted && Object.hasOwn(value, "reason")) {
    fail("invalid_field", "accepted hello_ack must not contain reason")
  }
  if (!value.accepted) {
    if (!Object.hasOwn(value, "reason")) fail("missing_field", "rejected hello_ack requires reason")
    assertString(value.reason, "reason", LIMITS.reasonCharacters)
  }
}

function validateAssignment(value) {
  assertBase(value, ["teamGoalId", "role", "assignmentId", "prompt", "timestamp"])
  assertId(value.teamGoalId, "teamGoalId", { uuid: true })
  assertRole(value.role)
  assertId(value.assignmentId, "assignmentId")
  assertString(value.prompt, "prompt", LIMITS.promptCharacters)
  assertTimestamp(value.timestamp)
}

function validateAssignmentAck(value) {
  assertBase(value, ["role", "assignmentId", "status", "timestamp"], ["reason"])
  assertRole(value.role)
  assertId(value.assignmentId, "assignmentId")
  if (!ACK_STATUS_SET.has(value.status)) fail("invalid_status", "invalid assignment acknowledgement status")
  assertTimestamp(value.timestamp)
  if (value.status === "accepted" && Object.hasOwn(value, "reason")) {
    fail("invalid_field", "accepted assignment_ack must not contain reason")
  }
  if (value.status !== "accepted") {
    if (!Object.hasOwn(value, "reason")) fail("missing_field", "non-accepted acknowledgement requires reason")
    assertString(value.reason, "reason", LIMITS.reasonCharacters)
  }
}

function validateBridgeEvent(value) {
  assertBase(value, ["role", "eventId", "sequence", "eventType", "timestamp", "data"], [
    "assignmentId"
  ])
  assertRole(value.role)
  assertId(value.eventId, "eventId")
  assertPositiveInteger(value.sequence, "event sequence")
  if (!EVENT_TYPE_SET.has(value.eventType)) fail("invalid_event_type", `unknown eventType: ${value.eventType}`)
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "assignmentId")) assertId(value.assignmentId, "assignmentId")
  validateTelemetry(value.data)
}

function validateAssignmentSummary(value, label = "assignment") {
  assertPlainObject(value, label)
  assertExactKeys(value, ["assignmentId", "state"], ["role", "promptCharacters", "lastAck"])
  assertId(value.assignmentId, `${label} assignmentId`)
  if (!ASSIGNMENT_STATE_SET.has(value.state)) fail("invalid_status", `${label} state is invalid`)
  if (Object.hasOwn(value, "role")) assertRole(value.role)
  if (Object.hasOwn(value, "promptCharacters")) assertNonNegativeInteger(value.promptCharacters, "promptCharacters")
  if (Object.hasOwn(value, "lastAck")) {
    assertPlainObject(value.lastAck, `${label} lastAck`)
    assertExactKeys(value.lastAck, ["status", "timestamp"], ["reason"])
    if (!ACK_STATUS_SET.has(value.lastAck.status)) fail("invalid_status", "lastAck status is invalid")
    assertTimestamp(value.lastAck.timestamp)
    if (Object.hasOwn(value.lastAck, "reason")) assertString(value.lastAck.reason, "lastAck reason", LIMITS.reasonCharacters)
  }
}

function validateRunnerSnapshot(value) {
  assertBase(value, ["teamGoalId", "role", "cursor", "assignment", "controlMode", "timestamp"], [
    "gap", "gapReason", "bridge"
  ])
  assertId(value.teamGoalId, "teamGoalId", { uuid: true })
  assertRole(value.role)
  assertId(value.cursor, "cursor")
  if (value.assignment !== null) validateAssignmentSummary(value.assignment)
  if (!CONTROL_MODE_SET.has(value.controlMode)) fail("invalid_status", "snapshot controlMode is invalid")
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "gap")) assertBoolean(value.gap, "gap")
  if (Object.hasOwn(value, "gapReason")) assertString(value.gapReason, "gapReason", LIMITS.reasonCharacters)
  if (Object.hasOwn(value, "bridge")) {
    assertPlainObject(value.bridge, "snapshot bridge")
    assertExactKeys(value.bridge, ["connectionState", "lastEventSequence"], ["piSessionId", "extensionInstanceId", "pid"])
    if (value.bridge.connectionState !== "connected" && value.bridge.connectionState !== "disconnected") {
      fail("invalid_status", "snapshot bridge connectionState is invalid")
    }
    assertSequence(value.bridge.lastEventSequence, "lastEventSequence")
    if (Object.hasOwn(value.bridge, "piSessionId")) assertId(value.bridge.piSessionId, "snapshot piSessionId")
    if (Object.hasOwn(value.bridge, "extensionInstanceId")) assertId(value.bridge.extensionInstanceId, "snapshot extensionInstanceId")
    if (Object.hasOwn(value.bridge, "pid")) assertPositiveInteger(value.bridge.pid, "snapshot pid")
  }
}

function validateBridgeStateSnapshot(value) {
  assertBase(value, ["role", "sequence", "connectionState", "controlMode", "assignment", "timestamp"], [
    "lastEventId"
  ])
  assertRole(value.role)
  assertSequence(value.sequence)
  if (value.connectionState !== "connected" && value.connectionState !== "disconnected") {
    fail("invalid_status", "bridge connectionState is invalid")
  }
  if (!CONTROL_MODE_SET.has(value.controlMode)) fail("invalid_status", "bridge controlMode is invalid")
  if (value.assignment !== null) validateAssignmentSummary(value.assignment)
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "lastEventId")) assertId(value.lastEventId, "lastEventId")
}

function validateControlHello(value) {
  assertBase(value, ["receiptId", "teamGoalId", "controlClientId", "timestamp"])
  assertId(value.receiptId, "receiptId", { uuid: true })
  assertId(value.teamGoalId, "teamGoalId", { uuid: true })
  assertId(value.controlClientId, "controlClientId")
  assertTimestamp(value.timestamp)
}

function validateControlAck(value) {
  assertBase(value, ["connectionId", "accepted", "timestamp"], ["reason"])
  assertId(value.connectionId, "connectionId")
  assertBoolean(value.accepted, "accepted")
  assertTimestamp(value.timestamp)
  if (value.accepted && Object.hasOwn(value, "reason")) fail("invalid_field", "accepted control_ack must not contain reason")
  if (!value.accepted) {
    if (!Object.hasOwn(value, "reason")) fail("missing_field", "rejected control_ack requires reason")
    assertString(value.reason, "reason", LIMITS.reasonCharacters)
  }
}

function validateControlRequest(value) {
  assertBase(value, ["requestId", "operation", "timestamp"], ["payload"])
  assertId(value.requestId, "requestId")
  if (!OPERATION_SET.has(value.operation)) fail("invalid_operation", `unknown control operation: ${value.operation}`)
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "payload")) {
    assertPlainObject(value.payload, "control payload")
    validateTelemetry(value.payload)
  }
}

function validateControlResponse(value) {
  assertBase(value, ["requestId", "status", "timestamp"], ["data", "error"])
  assertId(value.requestId, "requestId")
  if (value.status !== "ok" && value.status !== "error") fail("invalid_status", "control response status is invalid")
  assertTimestamp(value.timestamp)
  const hasData = Object.hasOwn(value, "data")
  const hasError = Object.hasOwn(value, "error")
  if (hasData === hasError) fail("invalid_envelope", "control response requires exactly one of data or error")
  if (hasData) {
    assertPlainObject(value.data, "control response data")
    validateTelemetry(value.data)
    if (value.status !== "ok") fail("invalid_envelope", "error response cannot contain data")
  } else {
    assertPlainObject(value.error, "control response error")
    assertExactKeys(value.error, ["code", "message"], ["details"])
    assertString(value.error.code, "control error code", LIMITS.metadataStringCharacters)
    assertString(value.error.message, "control error message", LIMITS.reasonCharacters)
    if (Object.hasOwn(value.error, "details")) validateTelemetry(value.error.details)
    if (value.status !== "error") fail("invalid_envelope", "ok response cannot contain error")
  }
}

function validateProtocolError(value) {
  assertBase(value, ["code", "message", "timestamp"], ["connectionId"])
  assertString(value.code, "protocol error code", LIMITS.metadataStringCharacters)
  assertString(value.message, "protocol error message", LIMITS.reasonCharacters)
  assertTimestamp(value.timestamp)
  if (Object.hasOwn(value, "connectionId")) assertId(value.connectionId, "connectionId")
}

export function validateMessage(value) {
  assertPlainObject(value, "message")
  switch (value.type) {
    case "hello": validateBridgeHello(value); break
    case "hello_ack": validateHelloAck(value); break
    case "assignment": validateAssignment(value); break
    case "assignment_ack": validateAssignmentAck(value); break
    case "event": validateBridgeEvent(value); break
    case "state_snapshot": validateBridgeStateSnapshot(value); break
    case "runner_snapshot": validateRunnerSnapshot(value); break
    case "control_hello": validateControlHello(value); break
    case "control_ack": validateControlAck(value); break
    case "control_request": validateControlRequest(value); break
    case "control_response": validateControlResponse(value); break
    case "protocol_error": validateProtocolError(value); break
    default: fail("unknown_message_type", `unknown message type: ${String(value.type)}`)
  }
  return value
}

function compactUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

export function makeHello(fields) {
  return validateMessage({ ...fields, type: "hello", protocolVersion: PROTOCOL_VERSION })
}

export const makeBridgeHello = makeHello

export function makeHelloAck(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "hello_ack", protocolVersion: PROTOCOL_VERSION }))
}

export function makeAssignment(fields) {
  return validateMessage({ ...fields, type: "assignment", protocolVersion: PROTOCOL_VERSION })
}

export function makeAssignmentAck(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "assignment_ack", protocolVersion: PROTOCOL_VERSION }))
}

export function makeEvent(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "event", protocolVersion: PROTOCOL_VERSION }))
}

export const makeBridgeEvent = makeEvent

export function makeStateSnapshot(fields) {
  return validateMessage({ ...fields, type: "state_snapshot", protocolVersion: PROTOCOL_VERSION })
}

export const makeBridgeStateSnapshot = makeStateSnapshot

export function makeRunnerSnapshot(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "runner_snapshot", protocolVersion: PROTOCOL_VERSION }))
}

export function makeControlHello(fields) {
  return validateMessage({ ...fields, type: "control_hello", protocolVersion: PROTOCOL_VERSION })
}

export function makeControlAck(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "control_ack", protocolVersion: PROTOCOL_VERSION }))
}

export function makeControlRequest(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "control_request", protocolVersion: PROTOCOL_VERSION }))
}

export function makeControlResponse(fields) {
  const value = compactUndefined({ ...fields, type: "control_response", protocolVersion: PROTOCOL_VERSION })
  return validateMessage(value)
}

export function makeProtocolError(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "protocol_error", protocolVersion: PROTOCOL_VERSION }))
}

export function encodeMessage(value) {
  const message = validateMessage(value)
  const encoded = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(encoded) > LIMITS.frameBytes) {
    fail("frame_too_large", `frame exceeds ${LIMITS.frameBytes} bytes`)
  }
  return encoded
}

export class NdjsonDecoder {
  #decoder = new StringDecoder("utf8")
  #buffer = ""

  push(chunk) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      fail("invalid_chunk", "decoder chunk must be a string, Buffer, or Uint8Array")
    }
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk))
    const messages = []
    while (true) {
      const newline = this.#buffer.indexOf("\n")
      if (newline < 0) break
      let line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line.length === 0) fail("empty_frame", "empty NDJSON frames are not allowed")
      messages.push(this.#parseLine(line))
    }
    this.#assertBufferLimit()
    return messages
  }

  finish() {
    this.#buffer += this.#decoder.end()
    if (this.#buffer.length === 0) return []
    let line = this.#buffer
    this.#buffer = ""
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (line.length === 0) return []
    return [this.#parseLine(line)]
  }

  reset() {
    this.#decoder = new StringDecoder("utf8")
    this.#buffer = ""
  }

  #assertBufferLimit() {
    if (Buffer.byteLength(this.#buffer) > LIMITS.decoderBufferBytes) {
      this.reset()
      fail("buffer_too_large", `decoder buffer exceeds ${LIMITS.decoderBufferBytes} bytes`)
    }
  }

  #parseLine(line) {
    if (Buffer.byteLength(line) > LIMITS.frameBytes) fail("frame_too_large", `frame exceeds ${LIMITS.frameBytes} bytes`)
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      fail("invalid_json", `invalid JSON frame: ${error.message}`)
    }
    return validateMessage(parsed)
  }
}

export function assertProtocolId(value, label = "ID") {
  assertId(value, label)
  return value
}

export function assertProtocolUuid(value, label = "UUID") {
  assertId(value, label, { uuid: true })
  return value
}