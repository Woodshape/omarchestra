import {
  ASSIGNMENT_STATES,
  CONTROL_MODES,
  LIMITS,
  makeAssignmentAck,
  makeEvent,
  makeHello,
  makeStateSnapshot,
  validateMessage
} from "./protocol.mjs"
import { requireCondition } from "./errors.mjs"

const clone = value => structuredClone(value)
const ACTIVE_ASSIGNMENT_STATES = new Set(["accepted", "working"])
const ASSIGNMENT_STATE_SET = new Set(ASSIGNMENT_STATES)
const CONTROL_MODE_SET = new Set(CONTROL_MODES)

function freezeState(state) {
  return Object.freeze({
    ...state,
    assignment: state.assignment === null ? null : Object.freeze({ ...state.assignment }),
    seenAssignmentIds: Object.freeze([...state.seenAssignmentIds])
  })
}

function assertState(state) {
  requireCondition(state !== null && typeof state === "object", "invalid_bridge_state", "Bridge state must be an object")
  return state
}

function validateIdentity({ teamGoalId, role, agentRunId, shellId, piSessionId, extensionInstanceId }) {
  makeHello({
    teamGoalId,
    role,
    agentRunId,
    shellId,
    piSessionId,
    extensionInstanceId,
    pid: 1,
    mode: "tui",
    timestamp: 0
  })
}

export function createBridgeState({
  teamGoalId,
  role,
  agentRunId,
  shellId,
  piSessionId,
  extensionInstanceId,
  pid = process.pid
}) {
  validateIdentity({ teamGoalId, role, agentRunId, shellId, piSessionId, extensionInstanceId })
  requireCondition(Number.isSafeInteger(pid) && pid > 0, "invalid_bridge_state", "Bridge PID is invalid")
  return freezeState({
    teamGoalId,
    role,
    agentRunId,
    shellId,
    piSessionId,
    extensionInstanceId,
    pid,
    connectionState: "disconnected",
    connectionCount: 0,
    sequence: 0,
    lastEventId: null,
    controlMode: "managed",
    assignment: null,
    seenAssignmentIds: []
  })
}

export function createHello(state, { pid = state.pid, timestamp = Date.now() } = {}) {
  assertState(state)
  return makeHello({
    teamGoalId: state.teamGoalId,
    role: state.role,
    agentRunId: state.agentRunId,
    shellId: state.shellId,
    piSessionId: state.piSessionId,
    extensionInstanceId: state.extensionInstanceId,
    pid,
    mode: "tui",
    timestamp,
    lastEventSequence: state.sequence,
    ...(state.lastEventId === null ? {} : { lastEventId: state.lastEventId })
  })
}

export function markConnected(state) {
  assertState(state)
  if (state.connectionState === "connected") return { state, eventType: null }
  const connectionCount = state.connectionCount + 1
  return {
    state: freezeState({ ...state, connectionState: "connected", connectionCount }),
    eventType: connectionCount === 1 ? "bridge_connected" : "bridge_reconnected"
  }
}

export function markDisconnected(state) {
  assertState(state)
  if (state.connectionState === "disconnected") return { state, eventType: null }
  return {
    state: freezeState({ ...state, connectionState: "disconnected" }),
    eventType: "bridge_disconnected"
  }
}

export function evaluateAssignment(state, assignment, { isIdle, timestamp = Date.now() } = {}) {
  assertState(state)
  validateMessage(assignment)
  requireCondition(assignment.type === "assignment", "invalid_assignment", "Assignment message required")
  requireCondition(assignment.teamGoalId === state.teamGoalId && assignment.role === state.role,
    "binding_mismatch", "Assignment does not address this visible role")
  let status
  let reason
  let nextState = state
  if (state.seenAssignmentIds.includes(assignment.assignmentId)) {
    status = "duplicate"
    reason = "assignmentId was already accepted by this bridge instance"
  } else if (isIdle !== true || (state.assignment && ACTIVE_ASSIGNMENT_STATES.has(state.assignment.state))) {
    status = "busy"
    reason = "visible Pi host session is not idle"
  } else {
    status = "accepted"
    nextState = freezeState({
      ...state,
      assignment: { assignmentId: assignment.assignmentId, state: "accepted" },
      seenAssignmentIds: [...state.seenAssignmentIds, assignment.assignmentId]
    })
  }
  return {
    state: nextState,
    acknowledgement: makeAssignmentAck({
      role: state.role,
      assignmentId: assignment.assignmentId,
      status,
      reason,
      timestamp
    })
  }
}

export function makeInvalidAssignmentAcknowledgement(state, assignmentId, reason, { timestamp = Date.now() } = {}) {
  assertState(state)
  return makeAssignmentAck({ role: state.role, assignmentId, status: "invalid", reason, timestamp })
}

export function setAssignmentState(state, assignmentState) {
  assertState(state)
  requireCondition(state.assignment !== null, "assignment_missing", "Cannot change state without an assignment")
  requireCondition(ASSIGNMENT_STATE_SET.has(assignmentState), "invalid_assignment", "Assignment state is invalid")
  return freezeState({ ...state, assignment: { ...state.assignment, state: assignmentState } })
}

export function markAssignmentStarted(state) {
  return setAssignmentState(state, "working")
}

export function markAssignmentSettled(state) {
  assertState(state)
  requireCondition(state.assignment !== null, "assignment_missing", "Cannot settle without an assignment")
  return setAssignmentState(state, state.controlMode === "manual_takeover" ? "needs_reconciliation" : "settled")
}

export function observeSubmittedInput(state, source) {
  assertState(state)
  if (source !== "interactive" || state.controlMode !== "managed") return { state, takeover: false }
  const assignment = state.assignment && ACTIVE_ASSIGNMENT_STATES.has(state.assignment.state)
    ? { ...state.assignment, state: "needs_reconciliation" }
    : state.assignment
  return {
    state: freezeState({ ...state, controlMode: "manual_takeover", assignment }),
    takeover: true
  }
}

export function applyRunnerSnapshot(state, snapshot) {
  assertState(state)
  validateMessage(snapshot)
  requireCondition(snapshot.type === "runner_snapshot", "invalid_snapshot", "Runner snapshot required")
  requireCondition(snapshot.teamGoalId === state.teamGoalId && snapshot.role === state.role,
    "binding_mismatch", "Runner snapshot does not address this bridge")
  if (snapshot.bridge) {
    for (const field of ["piSessionId", "extensionInstanceId", "pid"]) {
      if (snapshot.bridge[field] !== undefined && snapshot.bridge[field] !== null) {
        requireCondition(snapshot.bridge[field] === state[field], "bridge_identity_changed",
          `Runner snapshot ${field} differs from the visible bridge identity`)
      }
    }
  }
  let next = state
  if (snapshot.controlMode === "manual_takeover" && state.controlMode === "managed") {
    next = freezeState({
      ...next,
      controlMode: "manual_takeover",
      assignment: next.assignment && ACTIVE_ASSIGNMENT_STATES.has(next.assignment.state)
        ? { ...next.assignment, state: "needs_reconciliation" }
        : next.assignment
    })
  }
  if (snapshot.assignment) {
    requireCondition(next.assignment === null || next.assignment.assignmentId === snapshot.assignment.assignmentId,
      "assignment_mismatch", "Runner snapshot assignment differs from the visible bridge assignment")
    next = freezeState({
      ...next,
      assignment: { assignmentId: snapshot.assignment.assignmentId, state: snapshot.assignment.state },
      seenAssignmentIds: next.seenAssignmentIds.includes(snapshot.assignment.assignmentId)
        ? next.seenAssignmentIds
        : [...next.seenAssignmentIds, snapshot.assignment.assignmentId]
    })
  } else {
    requireCondition(next.assignment === null,
      "assignment_mismatch", "Runner snapshot removed the visible bridge assignment")
  }
  return next
}

function sanitizeValue(value, depth, seen) {
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    if (value.length <= LIMITS.telemetryStringCharacters) return value
    return `${value.slice(0, LIMITS.telemetryStringCharacters - 1)}…`
  }
  if (typeof value !== "object") return `[${typeof value}]`
  if (seen.has(value)) return "[circular]"
  if (depth >= LIMITS.telemetryDepth) return "[max-depth]"
  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.slice(0, LIMITS.telemetryArrayItems).map(item => sanitizeValue(item, depth + 1, seen))
    if (value.length > LIMITS.telemetryArrayItems) result.push("[items-truncated]")
  } else {
    result = {}
    const entries = Object.entries(value).slice(0, LIMITS.telemetryKeys)
    for (const [key, item] of entries) result[key] = sanitizeValue(item, depth + 1, seen)
    if (Object.keys(value).length > LIMITS.telemetryKeys) result.$truncated = true
  }
  seen.delete(value)
  return result
}

export function toBoundedMetadata(value) {
  let sanitized = sanitizeValue(value, 0, new Set())
  if (Buffer.byteLength(JSON.stringify(sanitized)) <= LIMITS.telemetryBytes) return sanitized
  return { truncated: true, reason: `metadata exceeded ${LIMITS.telemetryBytes} encoded bytes` }
}

function eventId(extensionInstanceId, sequence) {
  const suffix = `:${sequence.toString(36)}`
  const head = extensionInstanceId.slice(0, Math.max(1, LIMITS.idCharacters - suffix.length - 7))
  return `bridge-${head}${suffix}`
}

export function nextEvent(state, eventType, data = {}, { assignmentId = undefined, timestamp = Date.now() } = {}) {
  assertState(state)
  const sequence = state.sequence + 1
  const event = makeEvent({
    role: state.role,
    eventId: eventId(state.extensionInstanceId, sequence),
    sequence,
    eventType,
    assignmentId: assignmentId === undefined
      ? state.assignment?.assignmentId
      : assignmentId,
    timestamp,
    data: toBoundedMetadata(data)
  })
  return {
    state: freezeState({ ...state, sequence, lastEventId: event.eventId }),
    event
  }
}

export function createStateSnapshot(state, { timestamp = Date.now() } = {}) {
  assertState(state)
  return makeStateSnapshot({
    role: state.role,
    sequence: state.sequence,
    connectionState: state.connectionState,
    controlMode: state.controlMode,
    assignment: state.assignment,
    lastEventId: state.lastEventId ?? undefined,
    timestamp
  })
}