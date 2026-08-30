import { StringDecoder } from "node:string_decoder";

export const PROTOCOL_VERSION = 1;

export const LIMITS = Object.freeze({
  idCharacters: 128,
  promptCharacters: 16_384,
  reasonCharacters: 1_024,
  telemetryBytes: 16_384,
  telemetryDepth: 6,
  telemetryKeys: 64,
  telemetryArrayItems: 64,
  telemetryStringCharacters: 4_096,
  frameBytes: 65_536,
  decoderBufferBytes: 131_072,
});

export const ASSIGNMENT_ACK_STATUSES = Object.freeze([
  "accepted",
  "busy",
  "duplicate",
  "invalid",
]);

export const CONTROL_MODES = Object.freeze([
  "managed",
  "manual_takeover",
]);

export const ASSIGNMENT_STATES = Object.freeze([
  "accepted",
  "working",
  "settled",
  "needs_reconciliation",
]);

export const EVENT_TYPES = Object.freeze([
  "bridge_connected",
  "bridge_disconnected",
  "bridge_reconnected",
  "session_started",
  "session_shutdown",
  "assignment_started",
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
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACK_STATUS_SET = new Set(ASSIGNMENT_ACK_STATUSES);
const CONTROL_MODE_SET = new Set(CONTROL_MODES);
const ASSIGNMENT_STATE_SET = new Set(ASSIGNMENT_STATES);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_type", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalid_type", `${label} must be a plain object`);
  }
}

function assertExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("missing_field", `Missing field: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("unknown_field", `Unknown field: ${key}`);
  }
}

function assertVersion(value) {
  if (value !== PROTOCOL_VERSION) {
    fail("unsupported_version", `protocolVersion must be ${PROTOCOL_VERSION}`);
  }
}

function assertId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    fail("invalid_id", `${label} must match ${ID_PATTERN}`);
  }
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_timestamp", "timestamp must be a non-negative integer in Unix milliseconds");
  }
}

function assertOptionalString(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail("invalid_string", `${label} must contain 1-${maximum} characters`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") fail("invalid_type", `${label} must be a boolean`);
}

function assertSequence(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_sequence", "sequence must be a non-negative safe integer");
  }
}

function assertBase(value, required, optional = []) {
  assertPlainObject(value, "message");
  assertExactKeys(value, ["type", "protocolVersion", ...required], optional);
  assertVersion(value.protocolVersion);
}

function inspectTelemetry(value, depth, seen) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_telemetry", "telemetry numbers must be finite");
    return;
  }
  if (typeof value === "string") {
    if (value.length > LIMITS.telemetryStringCharacters) {
      fail("telemetry_too_large", "telemetry string exceeds its character limit");
    }
    return;
  }
  if (typeof value !== "object") {
    fail("invalid_telemetry", "telemetry must contain only JSON values");
  }
  if (seen.has(value)) fail("invalid_telemetry", "telemetry must not contain cycles");
  if (depth >= LIMITS.telemetryDepth) fail("telemetry_too_deep", "telemetry exceeds its depth limit");
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > LIMITS.telemetryArrayItems) {
      fail("telemetry_too_large", "telemetry array exceeds its item limit");
    }
    for (const item of value) inspectTelemetry(item, depth + 1, seen);
  } else {
    assertPlainObject(value, "telemetry object");
    const keys = Object.keys(value);
    if (keys.length > LIMITS.telemetryKeys) {
      fail("telemetry_too_large", "telemetry object exceeds its key limit");
    }
    for (const key of keys) inspectTelemetry(value[key], depth + 1, seen);
  }
  seen.delete(value);
}

export function validateTelemetry(value) {
  inspectTelemetry(value, 0, new Set());
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > LIMITS.telemetryBytes) {
    fail("telemetry_too_large", `telemetry exceeds ${LIMITS.telemetryBytes} encoded bytes`);
  }
  return value;
}

function validateHello(value) {
  assertBase(value, [
    "agentRunId",
    "piSessionId",
    "extensionInstanceId",
    "pid",
    "mode",
    "timestamp",
  ]);
  assertId(value.agentRunId, "agentRunId");
  assertId(value.piSessionId, "piSessionId");
  assertId(value.extensionInstanceId, "extensionInstanceId");
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) fail("invalid_pid", "pid must be a positive integer");
  if (value.mode !== "tui") fail("invalid_mode", 'mode must be "tui"');
  assertTimestamp(value.timestamp);
}

function validateHelloAck(value) {
  assertBase(value, ["connectionId", "accepted", "timestamp"], ["reason"]);
  assertId(value.connectionId, "connectionId");
  assertBoolean(value.accepted, "accepted");
  assertTimestamp(value.timestamp);
  if (value.accepted && Object.hasOwn(value, "reason")) {
    fail("invalid_field", "an accepted hello_ack must not contain reason");
  }
  if (!value.accepted) {
    if (!Object.hasOwn(value, "reason")) fail("missing_field", "a rejected hello_ack requires reason");
    assertOptionalString(value.reason, "reason", LIMITS.reasonCharacters);
  }
}

function validateAssignment(value) {
  assertBase(value, ["assignmentId", "prompt", "timestamp"]);
  assertId(value.assignmentId, "assignmentId");
  assertOptionalString(value.prompt, "prompt", LIMITS.promptCharacters);
  assertTimestamp(value.timestamp);
}

function validateAssignmentAck(value) {
  assertBase(value, ["assignmentId", "status", "timestamp"], ["reason"]);
  assertId(value.assignmentId, "assignmentId");
  if (!ACK_STATUS_SET.has(value.status)) fail("invalid_status", "invalid assignment acknowledgement status");
  assertTimestamp(value.timestamp);
  if (value.status === "accepted" && Object.hasOwn(value, "reason")) {
    fail("invalid_field", "an accepted assignment_ack must not contain reason");
  }
  if (value.status !== "accepted") {
    if (!Object.hasOwn(value, "reason")) fail("missing_field", "a non-accepted assignment_ack requires reason");
    assertOptionalString(value.reason, "reason", LIMITS.reasonCharacters);
  }
}

function validateEvent(value) {
  assertBase(value, ["eventId", "sequence", "eventType", "timestamp", "data"], ["assignmentId"]);
  assertId(value.eventId, "eventId");
  assertSequence(value.sequence);
  if (value.sequence === 0) fail("invalid_sequence", "event sequence must be greater than zero");
  if (!EVENT_TYPE_SET.has(value.eventType)) fail("invalid_event_type", `unknown eventType: ${value.eventType}`);
  assertTimestamp(value.timestamp);
  if (Object.hasOwn(value, "assignmentId")) assertId(value.assignmentId, "assignmentId");
  validateTelemetry(value.data);
}

function validateSnapshotAssignment(value) {
  assertPlainObject(value, "assignment");
  assertExactKeys(value, ["assignmentId", "state"]);
  assertId(value.assignmentId, "assignmentId");
  if (!ASSIGNMENT_STATE_SET.has(value.state)) fail("invalid_status", "invalid assignment state");
}

function validateStateSnapshot(value) {
  assertBase(value, ["sequence", "connectionState", "controlMode", "assignment", "timestamp"]);
  assertSequence(value.sequence);
  if (value.connectionState !== "connected" && value.connectionState !== "disconnected") {
    fail("invalid_status", "connectionState must be connected or disconnected");
  }
  if (!CONTROL_MODE_SET.has(value.controlMode)) fail("invalid_status", "invalid control mode");
  if (value.assignment !== null) validateSnapshotAssignment(value.assignment);
  assertTimestamp(value.timestamp);
}

export function validateMessage(value) {
  assertPlainObject(value, "message");
  switch (value.type) {
    case "hello": validateHello(value); break;
    case "hello_ack": validateHelloAck(value); break;
    case "assignment": validateAssignment(value); break;
    case "assignment_ack": validateAssignmentAck(value); break;
    case "event": validateEvent(value); break;
    case "state_snapshot": validateStateSnapshot(value); break;
    default: fail("unknown_message_type", `Unknown message type: ${String(value.type)}`);
  }
  return value;
}

function compactUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function makeHello(fields) {
  return validateMessage({ ...fields, type: "hello", protocolVersion: PROTOCOL_VERSION });
}

export function makeHelloAck(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "hello_ack", protocolVersion: PROTOCOL_VERSION }));
}

export function makeAssignment(fields) {
  return validateMessage({ ...fields, type: "assignment", protocolVersion: PROTOCOL_VERSION });
}

export function makeAssignmentAck(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "assignment_ack", protocolVersion: PROTOCOL_VERSION }));
}

export function makeEvent(fields) {
  return validateMessage(compactUndefined({ ...fields, type: "event", protocolVersion: PROTOCOL_VERSION }));
}

export function makeStateSnapshot(fields) {
  return validateMessage({ ...fields, type: "state_snapshot", protocolVersion: PROTOCOL_VERSION });
}

export function encodeMessage(value) {
  const message = validateMessage(value);
  const encoded = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(encoded) > LIMITS.frameBytes) {
    fail("frame_too_large", `frame exceeds ${LIMITS.frameBytes} bytes`);
  }
  return encoded;
}

export class NdjsonDecoder {
  #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      fail("invalid_chunk", "decoder chunk must be a string, Buffer, or Uint8Array");
    }
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    const messages = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) fail("empty_frame", "empty NDJSON frames are not allowed");
      messages.push(this.#parseLine(line));
    }
    this.#assertBufferLimit();
    return messages;
  }

  finish() {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.length === 0) return [];
    let line = this.#buffer;
    this.#buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) return [];
    return [this.#parseLine(line)];
  }

  reset() {
    this.#decoder = new StringDecoder("utf8");
    this.#buffer = "";
  }

  #assertBufferLimit() {
    if (Buffer.byteLength(this.#buffer) > LIMITS.decoderBufferBytes) {
      this.reset();
      fail("buffer_too_large", `decoder buffer exceeds ${LIMITS.decoderBufferBytes} bytes`);
    }
  }

  #parseLine(line) {
    if (Buffer.byteLength(line) > LIMITS.frameBytes) fail("frame_too_large", `frame exceeds ${LIMITS.frameBytes} bytes`);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      fail("invalid_json", `invalid JSON frame: ${error.message}`);
    }
    return validateMessage(parsed);
  }
}
