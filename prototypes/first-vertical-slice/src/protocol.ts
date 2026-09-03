/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * protocol.ts — versioned NDJSON envelope definitions, bounds, validators and
 * frame codec for the first vertical-slice prototype. This module owns no I/O
 * and no storage. It is the single source of truth for frame shapes.
 *
 * Protocol identifier and frame limits follow the completed spike evidence
 * (bounded frames, strict envelopes) but the schema is deliberately separate
 * from every spike implementation.
 */

export const PROTOCOL_ID = 'omarchestra.first-vertical-slice/v1'

/** Maximum encoded frame size in bytes, excluding the trailing newline. */
export const MAX_FRAME_BYTES = 16 * 1024
/** Maximum buffered partial frame bytes before a connection is rejected. */
export const MAX_DECODE_BUFFER_BYTES = 32 * 1024
/** Maximum number of event records in one event_page. */
export const MAX_EVENTS_PER_PAGE = 256

export const ROLES = ['coordinator', 'builder', 'reviewer'] as const
export type Role = (typeof ROLES)[number]

export const CONTROL_MODES = ['managed', 'manual_takeover'] as const
export type ControlMode = (typeof CONTROL_MODES)[number]

export const AGENT_STATES = ['waiting', 'working'] as const
export type AgentState = (typeof AGENT_STATES)[number]

export const ASSIGNMENT_STATES = ['pending', 'active', 'needs_reconciliation'] as const
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number]

export const ACK_STATUSES = ['accepted', 'busy', 'duplicate', 'invalid'] as const
export type AckStatus = (typeof ACK_STATUSES)[number]

export const CLIENT_FRAME_TYPES = [
  'bridge.hello',
  'bridge.assignment_ack',
  'bridge.event',
  'projection.hello',
] as const
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number]

export const RUNNER_FRAME_TYPES = [
  'hello_ack',
  'snapshot',
  'assignment',
  'presentation_update',
  'event_page',
  'event',
  'protocol_error',
] as const
export type RunnerFrameType = (typeof RUNNER_FRAME_TYPES)[number]

export interface Frame {
  protocol: string
  type: string
  messageId: string
  body: Record<string, unknown>
}

/** Conservative bounded ASCII identifier form shared by all identity fields. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/

export const TEXT_LIMITS = {
  goalText: 8192,
  prompt: 4096,
  eventPayload: 4096,
  label: 512,
} as const

export class ProtocolError extends Error {
  code: string
  constructor(code: string, detail: string) {
    super(`protocol error [${code}]: ${detail}`)
    this.code = code
    this.name = 'ProtocolError'
  }
}

export function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactFields(
  body: Record<string, unknown>,
  expected: readonly string[],
  where: string,
): void {
  const actual = Object.keys(body).sort()
  const want = [...expected].sort()
  if (actual.length !== want.length || actual.some((key, index) => key !== want[index])) {
    throw new ProtocolError('unknown_body_field', `${where} fields must be exactly ${want.join(', ')}`)
  }
}

function requireId(value: unknown, field: string): string {
  if (!isBoundedId(value)) {
    throw new ProtocolError('invalid_id', `${field} must be a bounded ASCII identifier`)
  }
  return value
}

function requireBoundedString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new ProtocolError('invalid_string', `${field} must be a non-empty string of at most ${limit} characters`)
  }
  return value
}

function requirePositiveInt(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ProtocolError('invalid_integer', `${field} must be an integer in [1, ${max}]`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ProtocolError('invalid_enum', `${field} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

// ---------------------------------------------------------------------------
// Client-to-runner frame bodies
// ---------------------------------------------------------------------------

export interface BridgeHelloBody {
  teamGoalId: string
  role: Role
  agentRunId: string
  terminalSessionRef: string
  piSessionId: string
  extensionInstanceId: string
  hostPid: number
  hostMode: 'tui'
  shellRunId: string
}

export function validateBridgeHello(body: unknown): BridgeHelloBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'bridge.hello body must be an object')
  requireExactFields(
    body,
    [
      'teamGoalId',
      'role',
      'agentRunId',
      'terminalSessionRef',
      'piSessionId',
      'extensionInstanceId',
      'hostPid',
      'hostMode',
      'shellRunId',
    ],
    'bridge.hello',
  )
  if (body.hostMode !== 'tui') {
    throw new ProtocolError('invalid_enum', 'bridge.hello hostMode must be "tui"')
  }
  return {
    teamGoalId: requireId(body.teamGoalId, 'teamGoalId'),
    role: requireEnum(body.role, ROLES, 'role'),
    agentRunId: requireId(body.agentRunId, 'agentRunId'),
    terminalSessionRef: requireId(body.terminalSessionRef, 'terminalSessionRef'),
    piSessionId: requireId(body.piSessionId, 'piSessionId'),
    extensionInstanceId: requireId(body.extensionInstanceId, 'extensionInstanceId'),
    hostPid: requirePositiveInt(body.hostPid, 'hostPid', 2 ** 31 - 1),
    hostMode: 'tui',
    shellRunId: requireId(body.shellRunId, 'shellRunId'),
  }
}

export interface AssignmentAckBody {
  assignmentId: string
  ack: AckStatus
}

export function validateAssignmentAck(body: unknown): AssignmentAckBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'bridge.assignment_ack body must be an object')
  requireExactFields(body, ['assignmentId', 'ack'], 'bridge.assignment_ack')
  return {
    assignmentId: requireId(body.assignmentId, 'assignmentId'),
    ack: requireEnum(body.ack, ACK_STATUSES, 'ack'),
  }
}

export interface BridgeEventBody {
  eventId: string
  sequence: number
  eventType: string
  payload: Record<string, unknown>
}

export function validateBridgeEvent(body: unknown): BridgeEventBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'bridge.event body must be an object')
  requireExactFields(body, ['eventId', 'sequence', 'eventType', 'payload'], 'bridge.event')
  const payload = body.payload
  if (!isPlainObject(payload)) throw new ProtocolError('invalid_body', 'bridge.event payload must be an object')
  const encodedPayload = JSON.stringify(payload)
  if (encodedPayload === undefined || Buffer.byteLength(encodedPayload, 'utf8') > TEXT_LIMITS.eventPayload) {
    throw new ProtocolError('frame_too_large', 'bridge.event payload exceeds the bounded payload size')
  }
  return {
    eventId: requireId(body.eventId, 'eventId'),
    sequence: requirePositiveInt(body.sequence, 'sequence', Number.MAX_SAFE_INTEGER),
    eventType: requireEnumEventType(body.eventType),
    payload,
  }
}

function requireEnumEventType(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_TYPE_RE.test(value)) {
    throw new ProtocolError('invalid_enum', 'eventType must be a lowercase bounded event identifier')
  }
  return value
}

export interface ProjectionHelloBody {
  teamGoalId: string
  clientId: string
  resumeAfter: number | null
}

export function validateProjectionHello(body: unknown): ProjectionHelloBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'projection.hello body must be an object')
  requireExactFields(body, ['teamGoalId', 'clientId', 'resumeAfter'], 'projection.hello')
  const resumeAfter = body.resumeAfter
  if (resumeAfter !== null) {
    if (
      typeof resumeAfter !== 'number' ||
      !Number.isInteger(resumeAfter) ||
      resumeAfter < 0 ||
      resumeAfter > Number.MAX_SAFE_INTEGER
    ) {
      throw new ProtocolError('invalid_integer', 'resumeAfter must be a non-negative integer or null')
    }
  }
  return {
    teamGoalId: requireId(body.teamGoalId, 'teamGoalId'),
    clientId: requireId(body.clientId, 'clientId'),
    resumeAfter: resumeAfter === null ? null : (resumeAfter as number),
  }
}

// ---------------------------------------------------------------------------
// Runner-to-client frame bodies (validated defensively on both sides)
// ---------------------------------------------------------------------------

export interface EventRecord {
  sequence: number
  eventId: string
  eventType: string
  role: Role | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface RoleProjectionValue {
  role: Role
  agentRunId: string
  terminalSessionRef: string
  piSessionId: string
  extensionInstanceId: string
  hostPid: number
  hostMode: 'tui'
  shellRunId: string
  controlMode: ControlMode
  agentState: AgentState
  assignmentState: AssignmentState | null
  nativeTerminalTitle: string
  piStatus: string
}

export interface SnapshotBody {
  cursor: number
  teamGoal: { id: string; goalText: string; createdAt: string; eventCursor: number }
  roles: RoleProjectionValue[]
  assignment: {
    id: string
    role: Role
    agentRunId: string
    state: AssignmentState
    lastAckStatus: AckStatus | null
    prompt: string
    createdAt: string
    updatedAt: string
  } | null
  journal: { requested: 'default' | 'wal'; effective: string; sqliteVersion: string }
}

export interface PresentationUpdateBody {
  role: Role
  agentRunId: string
  eventCursor: number
  nativeTerminalTitle: string
  piStatus: string
}

export interface EventPageBody {
  fromCursor: number
  toCursor: number
  events: EventRecord[]
}

function validateEventRecord(value: unknown, where: string): EventRecord {
  if (!isPlainObject(value)) throw new ProtocolError('invalid_body', `${where} event must be an object`)
  requireExactFields(value, ['sequence', 'eventId', 'eventType', 'role', 'payload', 'createdAt'], where)
  if (!isPlainObject(value.payload)) throw new ProtocolError('invalid_body', `${where} payload must be an object`)
  const role = value.role === null ? null : requireEnum(value.role, ROLES, `${where} role`)
  const createdAt = requireBoundedString(value.createdAt, `${where} createdAt`, 64)
  return {
    sequence: requirePositiveInt(value.sequence, `${where} sequence`, Number.MAX_SAFE_INTEGER),
    eventId: requireId(value.eventId, `${where} eventId`),
    eventType: requireEnumEventType(value.eventType),
    role: role as Role | null,
    payload: value.payload,
    createdAt,
  }
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new ProtocolError('invalid_integer', `${field} must be a non-negative safe integer`)
  }
  return value
}

function validateRoleProjection(value: unknown, where: string): RoleProjectionValue {
  if (!isPlainObject(value)) throw new ProtocolError('invalid_body', `${where} must be an object`)
  requireExactFields(value, [
    'role', 'agentRunId', 'terminalSessionRef', 'shellRunId', 'piSessionId', 'extensionInstanceId',
    'hostPid', 'hostMode', 'controlMode', 'agentState', 'assignmentState', 'nativeTerminalTitle', 'piStatus',
  ], where)
  if (value.hostMode !== 'tui') throw new ProtocolError('invalid_enum', `${where} hostMode must be tui`)
  const assignmentState = value.assignmentState === null
    ? null
    : requireEnum(value.assignmentState, ASSIGNMENT_STATES, `${where} assignmentState`)
  return {
    role: requireEnum(value.role, ROLES, `${where} role`),
    agentRunId: requireId(value.agentRunId, `${where} agentRunId`),
    terminalSessionRef: requireId(value.terminalSessionRef, `${where} terminalSessionRef`),
    shellRunId: requireId(value.shellRunId, `${where} shellRunId`),
    piSessionId: requireId(value.piSessionId, `${where} piSessionId`),
    extensionInstanceId: requireId(value.extensionInstanceId, `${where} extensionInstanceId`),
    hostPid: requirePositiveInt(value.hostPid, `${where} hostPid`, 2 ** 31 - 1),
    hostMode: 'tui',
    controlMode: requireEnum(value.controlMode, CONTROL_MODES, `${where} controlMode`),
    agentState: requireEnum(value.agentState, AGENT_STATES, `${where} agentState`),
    assignmentState,
    nativeTerminalTitle: requireBoundedString(value.nativeTerminalTitle, `${where} nativeTerminalTitle`, TEXT_LIMITS.label),
    piStatus: requireBoundedString(value.piStatus, `${where} piStatus`, TEXT_LIMITS.label),
  }
}

export function validateSnapshotBody(body: unknown): SnapshotBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'snapshot body must be an object')
  requireExactFields(body, ['cursor', 'teamGoal', 'roles', 'assignment', 'journal'], 'snapshot')
  const cursor = requireNonNegativeInt(body.cursor, 'snapshot cursor')
  if (!isPlainObject(body.teamGoal)) throw new ProtocolError('invalid_body', 'snapshot teamGoal must be an object')
  requireExactFields(body.teamGoal, ['id', 'goalText', 'createdAt', 'eventCursor'], 'snapshot teamGoal')
  const teamGoal = {
    id: requireId(body.teamGoal.id, 'snapshot teamGoal id'),
    goalText: requireBoundedString(body.teamGoal.goalText, 'snapshot goalText', TEXT_LIMITS.goalText),
    createdAt: requireBoundedString(body.teamGoal.createdAt, 'snapshot createdAt', 64),
    eventCursor: requireNonNegativeInt(body.teamGoal.eventCursor, 'snapshot eventCursor'),
  }
  if (teamGoal.eventCursor !== cursor) throw new ProtocolError('invalid_cursor', 'snapshot cursors must agree')
  if (!Array.isArray(body.roles) || body.roles.length !== ROLES.length) {
    throw new ProtocolError('invalid_body', 'snapshot must contain exactly three roles')
  }
  const roles = body.roles.map((role, index) => validateRoleProjection(role, `snapshot role ${index}`))
  if (new Set(roles.map((role) => role.role)).size !== ROLES.length) {
    throw new ProtocolError('invalid_body', 'snapshot roles must be unique')
  }
  let assignment: SnapshotBody['assignment'] = null
  if (body.assignment !== null) {
    if (!isPlainObject(body.assignment)) throw new ProtocolError('invalid_body', 'snapshot assignment must be an object or null')
    requireExactFields(body.assignment, [
      'id', 'role', 'agentRunId', 'state', 'lastAckStatus', 'prompt', 'createdAt', 'updatedAt',
    ], 'snapshot assignment')
    const lastAckStatus = body.assignment.lastAckStatus === null
      ? null
      : requireEnum(body.assignment.lastAckStatus, ACK_STATUSES, 'snapshot assignment lastAckStatus')
    assignment = {
      id: requireId(body.assignment.id, 'snapshot assignment id'),
      role: requireEnum(body.assignment.role, ROLES, 'snapshot assignment role'),
      agentRunId: requireId(body.assignment.agentRunId, 'snapshot assignment agentRunId'),
      state: requireEnum(body.assignment.state, ASSIGNMENT_STATES, 'snapshot assignment state'),
      lastAckStatus,
      prompt: requireBoundedString(body.assignment.prompt, 'snapshot assignment prompt', TEXT_LIMITS.prompt),
      createdAt: requireBoundedString(body.assignment.createdAt, 'snapshot assignment createdAt', 64),
      updatedAt: requireBoundedString(body.assignment.updatedAt, 'snapshot assignment updatedAt', 64),
    }
  }
  if (!isPlainObject(body.journal)) throw new ProtocolError('invalid_body', 'snapshot journal must be an object')
  requireExactFields(body.journal, ['requested', 'effective', 'sqliteVersion'], 'snapshot journal')
  const journal = {
    requested: requireEnum(body.journal.requested, ['default', 'wal'] as const, 'snapshot journal requested'),
    effective: requireBoundedString(body.journal.effective, 'snapshot journal effective', 32),
    sqliteVersion: requireBoundedString(body.journal.sqliteVersion, 'snapshot SQLite version', 64),
  }
  return { cursor, teamGoal, roles, assignment, journal }
}

export function validateHelloAckBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'hello_ack body must be an object')
  requireExactFields(body, ['connectionKind', 'teamGoalId', 'role'], 'hello_ack')
  const kind = requireEnum(body.connectionKind, ['bridge', 'projection'] as const, 'hello_ack connectionKind')
  const role = body.role === null ? null : requireEnum(body.role, ROLES, 'hello_ack role')
  if ((kind === 'bridge') !== (role !== null)) throw new ProtocolError('invalid_body', 'hello_ack role must match connection kind')
  return { connectionKind: kind, teamGoalId: requireId(body.teamGoalId, 'hello_ack teamGoalId'), role }
}

export function validateAssignmentBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'assignment body must be an object')
  requireExactFields(body, ['assignmentId', 'role', 'agentRunId', 'prompt'], 'assignment')
  return {
    assignmentId: requireId(body.assignmentId, 'assignmentId'),
    role: requireEnum(body.role, ROLES, 'assignment role'),
    agentRunId: requireId(body.agentRunId, 'assignment agentRunId'),
    prompt: requireBoundedString(body.prompt, 'assignment prompt', TEXT_LIMITS.prompt),
  }
}

export function validatePresentationUpdateBody(body: unknown): PresentationUpdateBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'presentation_update body must be an object')
  requireExactFields(body, ['role', 'agentRunId', 'eventCursor', 'nativeTerminalTitle', 'piStatus'], 'presentation_update')
  return {
    role: requireEnum(body.role, ROLES, 'presentation_update role'),
    agentRunId: requireId(body.agentRunId, 'presentation_update agentRunId'),
    eventCursor: requireNonNegativeInt(body.eventCursor, 'presentation_update eventCursor'),
    nativeTerminalTitle: requireBoundedString(body.nativeTerminalTitle, 'presentation_update title', TEXT_LIMITS.label),
    piStatus: requireBoundedString(body.piStatus, 'presentation_update Pi status', TEXT_LIMITS.label),
  }
}

export function validateEventPageBody(body: unknown): EventPageBody {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'event_page body must be an object')
  requireExactFields(body, ['fromCursor', 'toCursor', 'events'], 'event_page')
  const fromCursor = requireNonNegativeInt(body.fromCursor, 'event_page fromCursor')
  const toCursor = requireNonNegativeInt(body.toCursor, 'event_page toCursor')
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS_PER_PAGE) {
    throw new ProtocolError('invalid_body', 'event_page events must be a bounded array')
  }
  const events = body.events.map((event, index) => validateEventRecord(event, `event_page ${index}`))
  let expected = fromCursor + 1
  for (const event of events) {
    if (event.sequence !== expected) throw new ProtocolError('invalid_cursor', 'event_page sequences must be contiguous')
    expected += 1
  }
  const expectedTo = events.length === 0 ? fromCursor : events[events.length - 1].sequence
  if (toCursor !== expectedTo) throw new ProtocolError('invalid_cursor', 'event_page toCursor does not match its events')
  return { fromCursor, toCursor, events }
}

export function validateEventBody(body: unknown): EventRecord {
  return validateEventRecord(body, 'event')
}

export function validateProtocolErrorBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ProtocolError('invalid_body', 'protocol_error body must be an object')
  requireExactFields(body, ['code', 'detail'], 'protocol_error')
  return {
    code: requireBoundedString(body.code, 'protocol_error code', 64),
    detail: requireBoundedString(body.detail, 'protocol_error detail', 1024),
  }
}

export function validateBodyForType(type: string, body: unknown): Record<string, unknown> {
  switch (type) {
    case 'bridge.hello': return validateBridgeHello(body) as unknown as Record<string, unknown>
    case 'bridge.assignment_ack': return validateAssignmentAck(body) as unknown as Record<string, unknown>
    case 'bridge.event': return validateBridgeEvent(body) as unknown as Record<string, unknown>
    case 'projection.hello': return validateProjectionHello(body) as unknown as Record<string, unknown>
    case 'hello_ack': return validateHelloAckBody(body)
    case 'snapshot': return validateSnapshotBody(body) as unknown as Record<string, unknown>
    case 'assignment': return validateAssignmentBody(body)
    case 'presentation_update': return validatePresentationUpdateBody(body) as unknown as Record<string, unknown>
    case 'event_page': return validateEventPageBody(body) as unknown as Record<string, unknown>
    case 'event': return validateEventBody(body) as unknown as Record<string, unknown>
    case 'protocol_error': return validateProtocolErrorBody(body)
    default: throw new ProtocolError('unknown_frame_type', `unknown frame type ${type}`)
  }
}

// ---------------------------------------------------------------------------
// Frame codec
// ---------------------------------------------------------------------------

export interface DecodedFrame {
  type: string
  messageId: string
  body: Record<string, unknown>
}

function parseFrameLine(line: string, lineOffset: number): DecodedFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new ProtocolError('malformed_json', `frame ${lineOffset} is not valid JSON`)
  }
  if (!isPlainObject(parsed)) {
    throw new ProtocolError('malformed_frame', `frame ${lineOffset} must be a JSON object`)
  }
  requireExactFields(parsed, ['protocol', 'type', 'messageId', 'body'], 'frame')
  if (parsed.protocol !== PROTOCOL_ID) {
    throw new ProtocolError('unsupported_protocol', `frame ${lineOffset} protocol must be ${PROTOCOL_ID}`)
  }
  const type = parsed.type
  if (
    typeof type !== 'string' ||
    !(CLIENT_FRAME_TYPES as readonly string[]).includes(type) &&
    !(RUNNER_FRAME_TYPES as readonly string[]).includes(type)
  ) {
    throw new ProtocolError('unknown_frame_type', `frame ${lineOffset} has an unknown type`)
  }
  const messageId = parsed.messageId
  if (typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
    throw new ProtocolError('invalid_id', `frame ${lineOffset} messageId must be a bounded ASCII identifier`)
  }
  if (!isPlainObject(parsed.body)) {
    throw new ProtocolError('invalid_body', `frame ${lineOffset} body must be an object`)
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError('frame_too_large', `frame ${lineOffset} exceeds the bounded frame size`)
  }
  return { type, messageId, body: validateBodyForType(type, parsed.body) }
}

/** Incremental NDJSON frame decoder with a bounded receive buffer. */
export class NdjsonDecoder {
  private buffer = ''
  private lineOffset = 0

  push(chunk: string): DecodedFrame[] {
    this.buffer += chunk
    const frames: DecodedFrame[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      this.lineOffset += 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) {
        throw new ProtocolError('malformed_frame', 'empty frames are not permitted')
      }
      frames.push(parseFrameLine(line, this.lineOffset))
      newlineIndex = this.buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_DECODE_BUFFER_BYTES) {
      throw new ProtocolError('decoder_overflow', 'receive buffer exceeded the bounded frame size')
    }
    return frames
  }
}

/**
 * Encode one frame as a newline-terminated JSON line.
 * Rejects unknown envelope shapes and oversized frames before any write.
 */
export function encodeFrame(type: string, messageId: string, body: Record<string, unknown>): string {
  if (!isClientFrameType(type) && !isRunnerFrameType(type)) {
    throw new ProtocolError('unknown_frame_type', `outgoing frame type ${type} is not a known protocol frame`)
  }
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new ProtocolError('invalid_id', 'outgoing messageId must be a bounded ASCII identifier')
  }
  const validatedBody = validateBodyForType(type, body)
  const frame = { protocol: PROTOCOL_ID, type, messageId, body: validatedBody }
  const line = JSON.stringify(frame)
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
    throw new ProtocolError('frame_too_large', 'outgoing frame exceeds the bounded frame size')
  }
  return `${line}\n`
}

export function isClientFrameType(type: string): type is ClientFrameType {
  return (CLIENT_FRAME_TYPES as readonly string[]).includes(type)
}

export function isRunnerFrameType(type: string): type is RunnerFrameType {
  return (RUNNER_FRAME_TYPES as readonly string[]).includes(type)
}