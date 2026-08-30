import {
  ASSIGNMENT_STATES,
  LIMITS,
  makeAssignmentAck,
  makeEvent,
  makeHello,
  makeStateSnapshot,
  validateMessage,
} from "./protocol.mjs";

const ASSIGNMENT_STATE_SET = new Set(ASSIGNMENT_STATES);
const ACTIVE_ASSIGNMENT_STATES = new Set(["accepted", "working"]);

function freezeState(state) {
  return Object.freeze({
    ...state,
    assignment: state.assignment === null ? null : Object.freeze({ ...state.assignment }),
    seenAssignmentIds: Object.freeze([...state.seenAssignmentIds]),
  });
}

function assertState(state) {
  if (state === null || typeof state !== "object") throw new TypeError("bridge state must be an object");
  return state;
}

export function createBridgeState({ agentRunId, piSessionId, extensionInstanceId }) {
  // Reuse the wire validator so state and handshake identifiers cannot diverge.
  makeHello({
    agentRunId,
    piSessionId,
    extensionInstanceId,
    pid: 1,
    mode: "tui",
    timestamp: 0,
  });
  return freezeState({
    agentRunId,
    piSessionId,
    extensionInstanceId,
    connectionState: "disconnected",
    connectionCount: 0,
    sequence: 0,
    controlMode: "managed",
    assignment: null,
    seenAssignmentIds: [],
  });
}

export function createHello(state, { pid = process.pid, timestamp = Date.now() } = {}) {
  assertState(state);
  return makeHello({
    agentRunId: state.agentRunId,
    piSessionId: state.piSessionId,
    extensionInstanceId: state.extensionInstanceId,
    pid,
    mode: "tui",
    timestamp,
  });
}

export function markConnected(state) {
  assertState(state);
  if (state.connectionState === "connected") return { state, eventType: null };
  const connectionCount = state.connectionCount + 1;
  return {
    state: freezeState({ ...state, connectionState: "connected", connectionCount }),
    eventType: connectionCount === 1 ? "bridge_connected" : "bridge_reconnected",
  };
}

export function markDisconnected(state) {
  assertState(state);
  if (state.connectionState === "disconnected") return { state, eventType: null };
  return {
    state: freezeState({ ...state, connectionState: "disconnected" }),
    eventType: "bridge_disconnected",
  };
}

export function evaluateAssignment(state, assignment, { isIdle, timestamp = Date.now() } = {}) {
  assertState(state);
  validateMessage(assignment);
  if (assignment.type !== "assignment") throw new TypeError("assignment message required");

  let status;
  let reason;
  let nextState = state;
  if (state.seenAssignmentIds.includes(assignment.assignmentId)) {
    status = "duplicate";
    reason = "assignmentId was already accepted by this extension instance";
  } else if (isIdle !== true || (state.assignment && ACTIVE_ASSIGNMENT_STATES.has(state.assignment.state))) {
    status = "busy";
    reason = "visible Pi host session is not idle";
  } else {
    status = "accepted";
    nextState = freezeState({
      ...state,
      assignment: { assignmentId: assignment.assignmentId, state: "accepted" },
      seenAssignmentIds: [...state.seenAssignmentIds, assignment.assignmentId],
    });
  }

  return {
    state: nextState,
    acknowledgement: makeAssignmentAck({
      assignmentId: assignment.assignmentId,
      status,
      reason,
      timestamp,
    }),
  };
}

export function makeInvalidAssignmentAcknowledgement(assignmentId, reason, { timestamp = Date.now() } = {}) {
  return makeAssignmentAck({ assignmentId, status: "invalid", reason, timestamp });
}

export function setAssignmentState(state, assignmentState) {
  assertState(state);
  if (!state.assignment) throw new Error("cannot change assignment state without an accepted assignment");
  if (!ASSIGNMENT_STATE_SET.has(assignmentState)) throw new TypeError(`invalid assignment state: ${assignmentState}`);
  return freezeState({
    ...state,
    assignment: { ...state.assignment, state: assignmentState },
  });
}

export function markAssignmentStarted(state) {
  return setAssignmentState(state, "working");
}

export function markAssignmentSettled(state) {
  assertState(state);
  if (!state.assignment) throw new Error("cannot settle without an assignment");
  return setAssignmentState(
    state,
    state.controlMode === "manual_takeover" ? "needs_reconciliation" : "settled",
  );
}

export function observeSubmittedInput(state, source) {
  assertState(state);
  if (source !== "interactive" || state.controlMode !== "managed") {
    return { state, takeover: false };
  }
  const assignment = state.assignment && ACTIVE_ASSIGNMENT_STATES.has(state.assignment.state)
    ? { ...state.assignment, state: "needs_reconciliation" }
    : state.assignment;
  return {
    state: freezeState({ ...state, controlMode: "manual_takeover", assignment }),
    takeover: true,
  };
}

function sanitizeTelemetry(value, depth, seen) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    if (value.length <= LIMITS.telemetryStringCharacters) return value;
    return `${value.slice(0, LIMITS.telemetryStringCharacters - 1)}…`;
  }
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[circular]";
  if (depth >= LIMITS.telemetryDepth) return "[max-depth]";
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value
      .slice(0, LIMITS.telemetryArrayItems)
      .map((item) => sanitizeTelemetry(item, depth + 1, seen));
    if (value.length > LIMITS.telemetryArrayItems) result.push("[items-truncated]");
  } else {
    result = {};
    const entries = Object.entries(value).slice(0, LIMITS.telemetryKeys);
    for (const [key, item] of entries) result[key] = sanitizeTelemetry(item, depth + 1, seen);
    if (Object.keys(value).length > LIMITS.telemetryKeys) result.$truncated = true;
  }
  seen.delete(value);
  return result;
}

export function toBoundedTelemetry(value) {
  const sanitized = sanitizeTelemetry(value, 0, new Set());
  if (Buffer.byteLength(JSON.stringify(sanitized)) <= LIMITS.telemetryBytes) return sanitized;
  return { truncated: true, reason: `telemetry exceeded ${LIMITS.telemetryBytes} encoded bytes` };
}

function createEventId(extensionInstanceId, sequence) {
  const suffix = `:${sequence.toString(36)}`;
  return `${extensionInstanceId.slice(0, LIMITS.idCharacters - suffix.length)}${suffix}`;
}

export function nextEvent(state, eventType, data = {}, options = {}) {
  assertState(state);
  const timestamp = options.timestamp ?? Date.now();
  const assignmentId = Object.hasOwn(options, "assignmentId")
    ? options.assignmentId
    : state.assignment && state.assignment.state !== "settled"
      ? state.assignment.assignmentId
      : undefined;
  const sequence = state.sequence + 1;
  const event = makeEvent({
    eventId: createEventId(state.extensionInstanceId, sequence),
    sequence,
    eventType,
    assignmentId,
    timestamp,
    data: toBoundedTelemetry(data),
  });
  return {
    state: freezeState({ ...state, sequence }),
    event,
  };
}

export function createStateSnapshot(state, { timestamp = Date.now() } = {}) {
  assertState(state);
  return makeStateSnapshot({
    sequence: state.sequence,
    connectionState: state.connectionState,
    controlMode: state.controlMode,
    assignment: state.assignment,
    timestamp,
  });
}
