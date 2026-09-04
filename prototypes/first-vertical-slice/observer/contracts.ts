/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * contracts.ts — the pure `omarchestra.observer/v1` protocol module for the
 * observer/Adoption milestone. This module performs no I/O and imports neither
 * Adoption nor QML. It owns the strict bounded envelope shapes, the
 * connection-bound identity values, the enumerated lifecycle facts, and the
 * typed failures. The Agent Registry and telemetry policy consume these
 * validators; no live adapter reaches a process here.
 *
 * The exact shapes, bounds, ordering, expiry, and privacy classification are
 * locked in docs/observer-adoption-v1.md.
 */

import { ROLES, isBoundedId, type Role } from '../src/protocol.ts'

export type { Role }

export const OBSERVER_PROTOCOL_ID = 'omarchestra.observer/v1'

export const OBSERVER_CAPABILITIES = Object.freeze([
  'observe.lifecycle',
  'adoption.acknowledge',
  'managed.activate',
] as const)
export type ObserverCapability = (typeof OBSERVER_CAPABILITIES)[number]

export const OBSERVER_LIMITS = Object.freeze({
  envelopeBytes: 16 * 1024,
  decodeBufferBytes: 32 * 1024,
  idCharacters: 128,
  detailCharacters: 1024,
  labelCharacters: 512,
  nestingDepth: 4,
  capabilityCount: OBSERVER_CAPABILITIES.length,
  maxObservedSessions: 64,
  maxEventPage: 128,
  dedupLimit: 256,
})

export const OBSERVER_ERROR_CODES = Object.freeze([
  'invalid_envelope',
  'envelope_too_large',
  'unsupported_protocol',
  'incompatible_extension',
  'invalid_identity',
  'invalid_sequence',
  'stale_registration',
  'message_id_conflict',
  'session_limit',
  'privacy_violation',
  'connection_not_current',
  'session_unavailable',
  'session_expired',
  'proposal_not_found',
  'proposal_conflict',
  'proposal_stale',
  'proposal_expired',
  'authorization_required',
  'authorization_mismatch',
  'authorization_replayed',
  'node_mismatch',
  'remote_team_goal',
  'role_occupied',
  'session_busy',
  'session_unknown',
  'session_exited',
  'already_managed',
  'ack_refused',
  'ack_timeout',
  'identity_drift',
  'reconciliation_failed',
  'transaction_failed',
  'postcommit_delivery_failed',
] as const)
export type ObserverErrorCode = (typeof OBSERVER_ERROR_CODES)[number]

export const OBSERVER_LIFECYCLE_VALUES = ['running', 'exited'] as const
export type ObserverLifecycle = (typeof OBSERVER_LIFECYCLE_VALUES)[number]

export const OBSERVER_ACTIVITY_VALUES = ['idle', 'busy', 'waiting_for_user', 'unknown'] as const
export type ObserverActivity = (typeof OBSERVER_ACTIVITY_VALUES)[number]

export const OBSERVER_HEALTH_VALUES = ['healthy', 'degraded'] as const
export type ObserverHealth = (typeof OBSERVER_HEALTH_VALUES)[number]

export const OBSERVER_CLOSE_REASONS = ['quit', 'reload', 'new', 'resume', 'fork'] as const
export type ObserverCloseReason = (typeof OBSERVER_CLOSE_REASONS)[number]

export const OBSERVER_ADOPTION_DECISIONS = ['acknowledged', 'refused'] as const
export type ObserverAdoptionDecision = (typeof OBSERVER_ADOPTION_DECISIONS)[number]

export const OBSERVER_AVAILABILITY_VALUES = ['available', 'unavailable'] as const
export type ObserverAvailability = (typeof OBSERVER_AVAILABILITY_VALUES)[number]

export const OBSERVER_PI_STATUS_LOCAL = 'Unassigned · observed'

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

export class ObserverError extends Error {
  readonly code: ObserverErrorCode
  readonly detail: string

  constructor(code: ObserverErrorCode, detail: string) {
    if (!(OBSERVER_ERROR_CODES as readonly unknown[]).includes(code)) {
      throw new TypeError('observer error code must be a stable allow-listed value')
    }
    if (typeof detail !== 'string' || detail.length === 0 || [...detail].length > OBSERVER_LIMITS.detailCharacters) {
      throw new TypeError(`observer error detail must contain 1–${OBSERVER_LIMITS.detailCharacters} Unicode characters`)
    }
    super(`observer error [${code}]: ${detail}`)
    this.name = 'ObserverError'
    this.code = code
    this.detail = detail
  }
}

export class ObserverProtocolError extends ObserverError {
  constructor(
    code: ObserverErrorCode,
    detail: string,
  ) {
    super(code, detail)
    this.name = 'ObserverProtocolError'
  }
}

// ---------------------------------------------------------------------------
// Observer-to-registry envelope types
// ---------------------------------------------------------------------------

export interface ObserverRegisterBody {
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  hostPid: number
  hostMode: 'tui'
  observerVersion: string
  capabilities: readonly ObserverCapability[]
  registrationAttempt: number
  sourceSequence: number
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  health: ObserverHealth
}

export interface ObserverConnectionBody {
  connectionId: string
  connectionChallenge: string
  sourceSequence: number
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  health: ObserverHealth
}

export interface ObserverHeartbeatBody extends ObserverConnectionBody {}

export interface ObserverLifecycleBody extends ObserverConnectionBody {
  eventId: string
}

export interface ObserverCloseBody {
  connectionId: string
  connectionChallenge: string
  sourceSequence: number
  reason: ObserverCloseReason
}

export interface AdoptionAckBody {
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connectionId: string
  connectionChallenge: string
  proposalId: string
  proposalDigest: string
  acknowledgementNonce: string
  registryRevision: number
  sourceSequence: number
  decision: ObserverAdoptionDecision
  activity: ObserverActivity
  refusalCode: string | null
}

// ---------------------------------------------------------------------------
// Registry-to-observer envelope types
// ---------------------------------------------------------------------------

export interface ObserverRegisteredBody {
  observedSessionId: string
  executionNodeId: string
  connectionId: string
  connectionChallenge: string
  acceptedRegistrationAttempt: number
  acceptedSourceSequence: number
  heartbeatIntervalMs: number
  leaseDurationMs: number
  registryRevision: number
  piStatus: typeof OBSERVER_PI_STATUS_LOCAL
}

export interface ObserverRejectedBody {
  requestMessageId: string
  code: ObserverErrorCode
  detail: string
}

export interface AdoptionRequestAckBody {
  proposalId: string
  proposalDigest: string
  acknowledgementNonce: string
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connectionId: string
  connectionChallenge: string
  registryRevision: number
  targetTeamGoalId: string
  targetRole: Role
  acknowledgementRemainingMs: number
}

export interface AdoptionCommittedBody {
  proposalId: string
  proposalDigest: string
  agentRunId: string
  targetTeamGoalId: string
  targetRole: Role
  controlMode: 'managed'
  piStatus: string
  terminalTitleMetadata: string
  runtimeBindingGuarantee: 'unavailable'
}

export interface AdoptionFailedBody {
  proposalId: string
  code: ObserverErrorCode
  detail: string
}

// ---------------------------------------------------------------------------
// Frame types and codec types
// ---------------------------------------------------------------------------

export const OBSERVER_CLIENT_FRAME_TYPES = Object.freeze([
  'observer.register',
  'observer.heartbeat',
  'observer.lifecycle',
  'observer.close',
  'adoption.ack',
] as const)
export type ObserverClientFrameType = (typeof OBSERVER_CLIENT_FRAME_TYPES)[number]

export const OBSERVER_RUNNER_FRAME_TYPES = Object.freeze([
  'observer.registered',
  'observer.rejected',
  'adoption.request_ack',
  'adoption.committed',
  'adoption.failed',
] as const)
export type ObserverRunnerFrameType = (typeof OBSERVER_RUNNER_FRAME_TYPES)[number]

export interface ObserverFrame {
  protocol: typeof OBSERVER_PROTOCOL_ID
  type: string
  messageId: string
  body: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateObserverRegister(input: unknown): ObserverRegisterBody {
  const value = exactObject(input, [
    'processIncarnationId', 'piSessionId', 'extensionInstanceId', 'hostPid', 'hostMode',
    'observerVersion', 'capabilities', 'registrationAttempt', 'sourceSequence',
    'lifecycle', 'activity', 'health',
  ], 'observer.register')
  assertBounded(value, 'observer.register')
  if (value.hostMode !== 'tui') {
    throw new ObserverProtocolError('invalid_envelope', 'observer.register hostMode must be exactly "tui"')
  }
  const capabilities = requireCapabilities(value.capabilities)
  const result: ObserverRegisterBody = {
    processIncarnationId: requireId(value.processIncarnationId, 'processIncarnationId'),
    piSessionId: requireId(value.piSessionId, 'piSessionId'),
    extensionInstanceId: requireId(value.extensionInstanceId, 'extensionInstanceId'),
    hostPid: requirePositiveInt(value.hostPid, 'hostPid', 2 ** 31 - 1),
    hostMode: 'tui',
    observerVersion: requireVersion(value.observerVersion, 'observerVersion'),
    capabilities,
    registrationAttempt: requirePositiveInt(value.registrationAttempt, 'registrationAttempt', Number.MAX_SAFE_INTEGER),
    sourceSequence: requirePositiveInt(value.sourceSequence, 'sourceSequence', Number.MAX_SAFE_INTEGER),
    lifecycle: requireEnum(value.lifecycle, OBSERVER_LIFECYCLE_VALUES, 'lifecycle'),
    activity: requireEnum(value.activity, OBSERVER_ACTIVITY_VALUES, 'activity'),
    health: requireEnum(value.health, OBSERVER_HEALTH_VALUES, 'health'),
  }
  assertBounded(result, 'observer.register')
  return result
}

export function validateObserverHeartbeat(input: unknown): ObserverHeartbeatBody {
  const value = exactObject(input, [
    'connectionId', 'connectionChallenge', 'sourceSequence', 'lifecycle', 'activity', 'health',
  ], 'observer.heartbeat')
  const result: ObserverHeartbeatBody = {
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    sourceSequence: requirePositiveInt(value.sourceSequence, 'sourceSequence', Number.MAX_SAFE_INTEGER),
    lifecycle: requireEnum(value.lifecycle, OBSERVER_LIFECYCLE_VALUES, 'lifecycle'),
    activity: requireEnum(value.activity, OBSERVER_ACTIVITY_VALUES, 'activity'),
    health: requireEnum(value.health, OBSERVER_HEALTH_VALUES, 'health'),
  }
  assertBounded(result, 'observer.heartbeat')
  return result
}

export function validateObserverLifecycle(input: unknown): ObserverLifecycleBody {
  const value = exactObject(input, [
    'connectionId', 'connectionChallenge', 'eventId', 'sourceSequence', 'lifecycle', 'activity', 'health',
  ], 'observer.lifecycle')
  const result: ObserverLifecycleBody = {
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    eventId: requireId(value.eventId, 'eventId'),
    sourceSequence: requirePositiveInt(value.sourceSequence, 'sourceSequence', Number.MAX_SAFE_INTEGER),
    lifecycle: requireEnum(value.lifecycle, OBSERVER_LIFECYCLE_VALUES, 'lifecycle'),
    activity: requireEnum(value.activity, OBSERVER_ACTIVITY_VALUES, 'activity'),
    health: requireEnum(value.health, OBSERVER_HEALTH_VALUES, 'health'),
  }
  assertBounded(result, 'observer.lifecycle')
  return result
}

export function validateObserverClose(input: unknown): ObserverCloseBody {
  const value = exactObject(input, [
    'connectionId', 'connectionChallenge', 'sourceSequence', 'reason',
  ], 'observer.close')
  const result: ObserverCloseBody = {
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    sourceSequence: requirePositiveInt(value.sourceSequence, 'sourceSequence', Number.MAX_SAFE_INTEGER),
    reason: requireEnum(value.reason, OBSERVER_CLOSE_REASONS, 'reason'),
  }
  assertBounded(result, 'observer.close')
  return result
}

export function validateAdoptionAck(input: unknown): AdoptionAckBody {
  const value = exactObject(input, [
    'processIncarnationId', 'piSessionId', 'extensionInstanceId', 'connectionId',
    'connectionChallenge', 'proposalId', 'proposalDigest', 'acknowledgementNonce',
    'registryRevision', 'sourceSequence', 'decision', 'activity', 'refusalCode',
  ], 'adoption.ack')
  const decision = requireEnum(value.decision, OBSERVER_ADOPTION_DECISIONS, 'decision')
  const proposalDigest = requireSha256(value.proposalDigest)
  const refusalCode = value.refusalCode === null
    ? null
    : requireId(value.refusalCode, 'refusalCode')
  if (decision === 'acknowledged') {
    if (refusalCode !== null) {
      throw new ObserverProtocolError('invalid_envelope', 'adoption.ack refusalCode must be null when decision is acknowledged')
    }
  } else if (refusalCode === null) {
    throw new ObserverProtocolError('invalid_envelope', 'adoption.ack refused requires a refusalCode')
  }
  const result: AdoptionAckBody = {
    processIncarnationId: requireId(value.processIncarnationId, 'processIncarnationId'),
    piSessionId: requireId(value.piSessionId, 'piSessionId'),
    extensionInstanceId: requireId(value.extensionInstanceId, 'extensionInstanceId'),
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    proposalId: requireId(value.proposalId, 'proposalId'),
    proposalDigest,
    acknowledgementNonce: requireId(value.acknowledgementNonce, 'acknowledgementNonce'),
    registryRevision: requireNonNegativeInt(value.registryRevision, 'registryRevision'),
    sourceSequence: requirePositiveInt(value.sourceSequence, 'sourceSequence', Number.MAX_SAFE_INTEGER),
    decision,
    activity: requireEnum(value.activity, OBSERVER_ACTIVITY_VALUES, 'activity'),
    refusalCode,
  }
  assertBounded(result, 'adoption.ack')
  return result
}

/** Alias kept for callers that prefer the fully-qualified envelope name. */
export const validateObserverAdoptionAck = validateAdoptionAck

export function validateObserverRegistered(input: unknown): ObserverRegisteredBody {
  const value = exactObject(input, [
    'observedSessionId', 'executionNodeId', 'connectionId', 'connectionChallenge',
    'acceptedRegistrationAttempt', 'acceptedSourceSequence', 'heartbeatIntervalMs',
    'leaseDurationMs', 'registryRevision', 'piStatus',
  ], 'observer.registered')
  if (value.piStatus !== OBSERVER_PI_STATUS_LOCAL) {
    throw new ObserverProtocolError('invalid_envelope', `observer.registered piStatus must be exactly ${OBSERVER_PI_STATUS_LOCAL}`)
  }
  const result: ObserverRegisteredBody = {
    observedSessionId: requireId(value.observedSessionId, 'observedSessionId'),
    executionNodeId: requireId(value.executionNodeId, 'executionNodeId'),
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    acceptedRegistrationAttempt: requirePositiveInt(value.acceptedRegistrationAttempt, 'acceptedRegistrationAttempt', Number.MAX_SAFE_INTEGER),
    acceptedSourceSequence: requirePositiveInt(value.acceptedSourceSequence, 'acceptedSourceSequence', Number.MAX_SAFE_INTEGER),
    heartbeatIntervalMs: requirePositiveInt(value.heartbeatIntervalMs, 'heartbeatIntervalMs', Number.MAX_SAFE_INTEGER),
    leaseDurationMs: requirePositiveInt(value.leaseDurationMs, 'leaseDurationMs', Number.MAX_SAFE_INTEGER),
    registryRevision: requireNonNegativeInt(value.registryRevision, 'registryRevision'),
    piStatus: OBSERVER_PI_STATUS_LOCAL,
  }
  assertBounded(result, 'observer.registered')
  return result
}

export function validateObserverRejected(input: unknown): ObserverRejectedBody {
  const value = exactObject(input, ['requestMessageId', 'code', 'detail'], 'observer.rejected')
  const result: ObserverRejectedBody = {
    requestMessageId: requireId(value.requestMessageId, 'requestMessageId'),
    code: requireErrorCode(value.code),
    detail: requireString(value.detail, 'detail', OBSERVER_LIMITS.detailCharacters),
  }
  assertBounded(result, 'observer.rejected')
  return result
}

export function validateAdoptionRequestAck(input: unknown): AdoptionRequestAckBody {
  const value = exactObject(input, [
    'proposalId', 'proposalDigest', 'acknowledgementNonce', 'observedSessionId',
    'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId',
    'connectionId', 'connectionChallenge', 'registryRevision', 'targetTeamGoalId',
    'targetRole', 'acknowledgementRemainingMs',
  ], 'adoption.request_ack')
  const result: AdoptionRequestAckBody = {
    proposalId: requireId(value.proposalId, 'proposalId'),
    proposalDigest: requireSha256(value.proposalDigest),
    acknowledgementNonce: requireId(value.acknowledgementNonce, 'acknowledgementNonce'),
    observedSessionId: requireId(value.observedSessionId, 'observedSessionId'),
    executionNodeId: requireId(value.executionNodeId, 'executionNodeId'),
    processIncarnationId: requireId(value.processIncarnationId, 'processIncarnationId'),
    piSessionId: requireId(value.piSessionId, 'piSessionId'),
    extensionInstanceId: requireId(value.extensionInstanceId, 'extensionInstanceId'),
    connectionId: requireId(value.connectionId, 'connectionId'),
    connectionChallenge: requireId(value.connectionChallenge, 'connectionChallenge'),
    registryRevision: requireNonNegativeInt(value.registryRevision, 'registryRevision'),
    targetTeamGoalId: requireId(value.targetTeamGoalId, 'targetTeamGoalId'),
    targetRole: requireRole(value.targetRole, 'targetRole'),
    acknowledgementRemainingMs: requireNonNegativeInt(value.acknowledgementRemainingMs, 'acknowledgementRemainingMs'),
  }
  assertBounded(result, 'adoption.request_ack')
  return result
}

export function validateAdoptionCommitted(input: unknown): AdoptionCommittedBody {
  const value = exactObject(input, [
    'proposalId', 'proposalDigest', 'agentRunId', 'targetTeamGoalId', 'targetRole',
    'controlMode', 'piStatus', 'terminalTitleMetadata', 'runtimeBindingGuarantee',
  ], 'adoption.committed')
  if (value.controlMode !== 'managed') {
    throw new ObserverProtocolError('invalid_envelope', 'adoption.committed controlMode must be exactly "managed"')
  }
  if (value.runtimeBindingGuarantee !== 'unavailable') {
    throw new ObserverProtocolError('invalid_envelope', 'adoption.committed runtimeBindingGuarantee must be exactly "unavailable"')
  }
  const result: AdoptionCommittedBody = {
    proposalId: requireId(value.proposalId, 'proposalId'),
    proposalDigest: requireSha256(value.proposalDigest),
    agentRunId: requireId(value.agentRunId, 'agentRunId'),
    targetTeamGoalId: requireId(value.targetTeamGoalId, 'targetTeamGoalId'),
    targetRole: requireRole(value.targetRole, 'targetRole'),
    controlMode: 'managed',
    piStatus: requireString(value.piStatus, 'piStatus', OBSERVER_LIMITS.labelCharacters),
    terminalTitleMetadata: requireString(value.terminalTitleMetadata, 'terminalTitleMetadata', OBSERVER_LIMITS.labelCharacters),
    runtimeBindingGuarantee: 'unavailable',
  }
  assertBounded(result, 'adoption.committed')
  return result
}

export function validateAdoptionFailed(input: unknown): AdoptionFailedBody {
  const value = exactObject(input, ['proposalId', 'code', 'detail'], 'adoption.failed')
  const result: AdoptionFailedBody = {
    proposalId: requireId(value.proposalId, 'proposalId'),
    code: requireErrorCode(value.code),
    detail: requireString(value.detail, 'detail', OBSERVER_LIMITS.detailCharacters),
  }
  assertBounded(result, 'adoption.failed')
  return result
}

export function validateObserverBodyForType(type: string, body: unknown): Record<string, unknown> {
  switch (type) {
    case 'observer.register': return validateObserverRegister(body) as unknown as Record<string, unknown>
    case 'observer.heartbeat': return validateObserverHeartbeat(body) as unknown as Record<string, unknown>
    case 'observer.lifecycle': return validateObserverLifecycle(body) as unknown as Record<string, unknown>
    case 'observer.close': return validateObserverClose(body) as unknown as Record<string, unknown>
    case 'adoption.ack': return validateAdoptionAck(body) as unknown as Record<string, unknown>
    case 'observer.registered': return validateObserverRegistered(body) as unknown as Record<string, unknown>
    case 'observer.rejected': return validateObserverRejected(body) as unknown as Record<string, unknown>
    case 'adoption.request_ack': return validateAdoptionRequestAck(body) as unknown as Record<string, unknown>
    case 'adoption.committed': return validateAdoptionCommitted(body) as unknown as Record<string, unknown>
    case 'adoption.failed': return validateAdoptionFailed(body) as unknown as Record<string, unknown>
    default: throw new ObserverProtocolError('invalid_envelope', 'observer frame type is not recognized')
  }
}

// ---------------------------------------------------------------------------
// Frame codec
// ---------------------------------------------------------------------------

export function isObserverClientFrameType(type: string): type is ObserverClientFrameType {
  return (OBSERVER_CLIENT_FRAME_TYPES as readonly string[]).includes(type)
}

export function isObserverRunnerFrameType(type: string): type is ObserverRunnerFrameType {
  return (OBSERVER_RUNNER_FRAME_TYPES as readonly string[]).includes(type)
}

/** Encode one observer frame as a newline-terminated JSON line, validated up front. */
export function encodeFrame(type: string, messageId: string, body: Record<string, unknown>): string {
  if (!isObserverClientFrameType(type) && !isObserverRunnerFrameType(type)) {
    throw new ObserverProtocolError('invalid_envelope', 'outgoing frame type is not recognized')
  }
  if (!MESSAGE_ID_RE.test(messageId)) {
    throw new ObserverProtocolError('invalid_envelope', 'outgoing messageId must be a bounded opaque identifier')
  }
  const validated = validateObserverBodyForType(type, body)
  const frame: ObserverFrame = { protocol: OBSERVER_PROTOCOL_ID, type, messageId, body: validated }
  const line = JSON.stringify(frame)
  if (utf8Bytes(line) > OBSERVER_LIMITS.envelopeBytes) {
    throw new ObserverProtocolError('envelope_too_large', 'outgoing observer frame exceeds the bounded envelope size')
  }
  return `${line}\n`
}

/** Incremental NDJSON observer-frame decoder with a bounded receive buffer. */
export class NdjsonDecoder {
  private buffer = ''
  private lineOffset = 0

  push(chunk: string): ObserverFrame[] {
    this.buffer += chunk
    const frames: ObserverFrame[] = []
    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      this.lineOffset += 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) {
        throw new ObserverProtocolError('invalid_envelope', 'empty observer frames are not permitted')
      }
      if (utf8Bytes(line) > OBSERVER_LIMITS.envelopeBytes) {
        throw new ObserverProtocolError('envelope_too_large', 'observer frame exceeds the bounded envelope size')
      }
      frames.push(parseFrameLine(line, this.lineOffset))
      newlineIndex = this.buffer.indexOf('\n')
    }
    if (utf8Bytes(this.buffer) > OBSERVER_LIMITS.decodeBufferBytes) {
      throw new ObserverProtocolError('invalid_envelope', `decode buffer exceeded the bounded ${OBSERVER_LIMITS.decodeBufferBytes} bytes`)
    }
    return frames
  }
}

function parseFrameLine(line: string, lineOffset: number): ObserverFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new ObserverProtocolError('invalid_envelope', `observer frame ${lineOffset} is not valid JSON`)
  }
  if (!isPlainObject(parsed)) {
    throw new ObserverProtocolError('invalid_envelope', `observer frame ${lineOffset} must be a JSON object`)
  }
  exactObject(parsed, ['protocol', 'type', 'messageId', 'body'], `observer frame ${lineOffset}`)
  if (parsed.protocol !== OBSERVER_PROTOCOL_ID) {
    throw new ObserverProtocolError('unsupported_protocol', `observer frame ${lineOffset} protocol must be ${OBSERVER_PROTOCOL_ID}`)
  }
  const type = String(parsed.type)
  if (!isObserverClientFrameType(type) && !isObserverRunnerFrameType(type)) {
    throw new ObserverProtocolError('invalid_envelope', `observer frame ${lineOffset} has an unknown type`)
  }
  if (!MESSAGE_ID_RE.test(String(parsed.messageId))) {
    throw new ObserverProtocolError('invalid_envelope', `observer frame ${lineOffset} messageId must be a bounded opaque identifier`)
  }
  return {
    protocol: OBSERVER_PROTOCOL_ID,
    type,
    messageId: String(parsed.messageId),
    body: validateObserverBodyForType(type, parsed.body),
  }
}

// ---------------------------------------------------------------------------
// Validation internals. These perform no I/O and reject unknown fields.
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/
const SHA256_RE = /^[a-f0-9]{64}$/

function exactObject(input: unknown, fields: readonly string[], where: string): Record<string, unknown> {
  const value = requirePlainObject(input, where)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new ObserverProtocolError('invalid_envelope', `${where} fields must be exactly ${expected.join(', ')}`)
  }
  return value
}

function requirePlainObject(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) {
    throw new ObserverProtocolError('invalid_identity', `${where} must be a bounded ASCII identity`)
  }
  return input
}

function requireString(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > maxCharacters) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a non-empty string of at most ${maxCharacters} characters`)
  }
  return input
}

function requireVersion(input: unknown, where: string): string {
  if (typeof input !== 'string' || !VERSION_RE.test(input)) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a bounded version identifier`)
  }
  return input
}

function requireSha256(input: unknown, where = 'proposalDigest'): string {
  if (typeof input !== 'string' || !SHA256_RE.test(input)) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be exactly 64 lowercase hexadecimal characters`)
  }
  return input
}

function requirePositiveInt(input: unknown, where: string, max: number): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > max) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a positive safe integer`)
  }
  return input
}

function requireNonNegativeInt(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > Number.MAX_SAFE_INTEGER) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be a non-negative safe integer`)
  }
  return input
}

function requireEnum<T extends string>(input: unknown, choices: readonly T[], where: string): T {
  if (typeof input !== 'string' || !(choices as readonly string[]).includes(input)) {
    throw new ObserverProtocolError('invalid_envelope', `${where} must be one of ${choices.join(', ')}`)
  }
  return input as T
}

function requireRole(input: unknown, where: string): Role {
  return requireEnum(input, ROLES, where)
}

function requireErrorCode(input: unknown): ObserverErrorCode {
  if (typeof input !== 'string' || !(OBSERVER_ERROR_CODES as readonly string[]).includes(input)) {
    throw new ObserverProtocolError('invalid_envelope', 'code must be a stable observer error code')
  }
  return input as ObserverErrorCode
}

function requireCapabilities(input: unknown): readonly ObserverCapability[] {
  if (!Array.isArray(input) || input.length !== OBSERVER_CAPABILITIES.length) {
    throw new ObserverProtocolError('incompatible_extension', 'capabilities must be exactly three unique canonical entries')
  }
  for (let index = 0; index < input.length; index += 1) {
    const capability = input[index]
    if (typeof capability !== 'string' || capability !== OBSERVER_CAPABILITIES[index]) {
      throw new ObserverProtocolError('incompatible_extension', 'capabilities must be exactly the canonical observer capability set in order')
    }
  }
  return input as readonly ObserverCapability[]
}

function assertBounded(input: unknown, where: string): void {
  const bytes = utf8Bytes(safeJson(input))
  if (bytes > OBSERVER_LIMITS.envelopeBytes) {
    throw new ObserverProtocolError('envelope_too_large', `${where} exceeds ${OBSERVER_LIMITS.envelopeBytes} bytes`)
  }
}

function safeJson(input: unknown): string {
  try {
    const encoded = JSON.stringify(input)
    if (encoded === undefined) throw new Error('not JSON')
    return encoded
  } catch {
    throw new ObserverProtocolError('invalid_envelope', 'envelope must be finite, acyclic JSON data')
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
