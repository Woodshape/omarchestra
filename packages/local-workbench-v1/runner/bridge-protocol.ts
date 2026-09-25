/** Content-free Pi observer protocol. All payloads are closed, bounded and versioned. */
import { randomBytes } from 'node:crypto'
import { isSessionCode } from './session-code.ts'
export const BRIDGE_PROTOCOL = 'omarchestra.bridge/v1'
export const BRIDGE_FRAME_BYTES = 16_384
export const BRIDGE_BUFFER_BYTES = 32_768
export const BRIDGE_CAPABILITIES = ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'] as const
/** Optional presentation feature. Legacy peers receive the unchanged registered body. */
export const SESSION_CODE_CAPABILITY = 'presentation.session-code'
const validCapabilities = (v: unknown) => Array.isArray(v)
  && (v.length === 3 || (v.length === 4 && v[3] === SESSION_CODE_CAPABILITY))
  && BRIDGE_CAPABILITIES.every((c, i) => v[i] === c)
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const capability = (v: unknown): v is string => id(v) && v.length >= 32
const counter = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const enums = {
  hostMode: ['tui'], lifecycle: ['running', 'exited'], activity: ['idle', 'busy', 'unknown', 'waiting_for_user'], health: ['healthy', 'degraded'],
  reason: ['quit', 'reload', 'new', 'resume', 'fork'], mode: ['observed', 'committed'],
  code: ['invalid_envelope', 'incompatible_extension', 'invalid_identity', 'stale_registration', 'invalid_sequence', 'connection_not_current', 'session_limit', 'fence_conflict'],
} as const
const bodies = {
  register: { processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, hostMode: (v: unknown) => enums.hostMode.includes(v as 'tui'), capabilities: validCapabilities, registrationAttempt: counter, sourceSequence: counter, lifecycle: (v: unknown) => enums.lifecycle.includes(v as never), activity: (v: unknown) => enums.activity.includes(v as never), health: (v: unknown) => enums.health.includes(v as never) },
  registered: { observedSessionId: id, executionNodeId: id, connectionId: capability, connectionChallenge: capability, acceptedRegistrationAttempt: counter, acceptedSourceSequence: counter, leaseDurationMs: counter, heartbeatIntervalMs: counter, mode: (v: unknown) => enums.mode.includes(v as never) },
  heartbeat: { connectionId: capability, connectionChallenge: capability, sourceSequence: counter, lifecycle: (v: unknown) => enums.lifecycle.includes(v as never), activity: (v: unknown) => enums.activity.includes(v as never), health: (v: unknown) => enums.health.includes(v as never) },
  close: { connectionId: capability, connectionChallenge: capability, sourceSequence: counter, reason: (v: unknown) => enums.reason.includes(v as never) },
  input_observed: { connectionId: capability, connectionChallenge: capability, sourceSequence: counter, eventId: id },
  input_received: { connectionId: capability, connectionChallenge: capability, eventId: id },
  adoption_request: { proposalId: id, proposalDigest: digest, acknowledgementNonce: capability, observedSessionId: id, processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, connectionId: capability, connectionChallenge: capability, targetGoalId: id, targetRole: id, vacancyGeneration: (v: unknown) => counter(v) && v > 0, remainingMs: (v: unknown) => counter(v) && v <= 5000 },
  adoption_ack: { proposalId: id, proposalDigest: digest, acknowledgementNonce: capability, observedSessionId: id, processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, connectionId: capability, connectionChallenge: capability, sourceSequence: counter, decision: (v: unknown) => v === 'acknowledged' || v === 'refused', activity: (v: unknown) => enums.activity.includes(v as never) },
  adoption_committed: { runId: id, bindingDigest: digest, processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, connectionId: capability, connectionChallenge: capability, goalId: id, role: id },
  adoption_cancelled: { proposalDigest: digest, connectionId: capability, connectionChallenge: capability },
  managed_status: { runId: id, bindingDigest: digest, connectionId: capability, connectionChallenge: capability,
    state: (v: unknown) => v === 'ready' || v === 'manual_takeover' },
  binding_receipt: { runId: id, bindingDigest: digest, connectionId: capability, connectionChallenge: capability, sourceSequence: counter, activity: (v: unknown) => enums.activity.includes(v as never), pendingInput: (v: unknown) => typeof v === 'boolean' },
  recovery_request: { runId: id, bindingDigest: digest, processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, connectionId: capability, connectionChallenge: capability },
  recovery_proof: { runId: id, bindingDigest: digest, processInstanceId: capability, piSessionId: id, extensionInstanceId: capability, connectionId: capability, connectionChallenge: capability, sourceSequence: counter, pendingInput: (v: unknown) => typeof v === 'boolean' },
  rejected: { requestMessageId: id, code: (v: unknown) => enums.code.includes(v as never) },
} as const
export type BridgeType = keyof typeof bodies
export interface BridgeFrame { protocol: typeof BRIDGE_PROTOCOL; type: BridgeType; messageId: string; body: Record<string, unknown> }
export function bridgeId(prefix: string): string { return `${prefix}-${randomBytes(16).toString('hex')}` }
function invalid(): never { throw new Error('invalid_bridge_envelope') }
export function validateBridgeFrame(value: unknown): BridgeFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'body,messageId,protocol,type' || record.protocol !== BRIDGE_PROTOCOL || !id(record.messageId) || typeof record.type !== 'string' || !Object.hasOwn(bodies, record.type)) invalid()
  if (!record.body || typeof record.body !== 'object' || Array.isArray(record.body)) invalid()
  const shape = bodies[record.type as BridgeType] as Record<string, (v: unknown) => boolean>
  const body = record.body as Record<string, unknown>
  const optionalCode = record.type === 'registered' && Object.hasOwn(body, 'sessionCode')
  if (optionalCode && body.sessionCode !== null && !isSessionCode(body.sessionCode)) invalid()
  if (Object.keys(body).length !== Object.keys(shape).length + (optionalCode ? 1 : 0)
      || Object.keys(body).some(key => !(optionalCode && key === 'sessionCode') && (!Object.hasOwn(shape, key) || !shape[key](body[key])))) invalid()
  return { protocol: BRIDGE_PROTOCOL, type: record.type as BridgeType, messageId: record.messageId as string, body }
}
export function encodeBridgeFrame(type: BridgeType, messageId: string, body: Record<string, unknown>): Buffer {
  const frame = validateBridgeFrame({ protocol: BRIDGE_PROTOCOL, type, messageId, body })
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
  if (bytes.length > BRIDGE_FRAME_BYTES) invalid()
  return bytes
}
export function decodeBridgeFrame(bytes: Buffer): BridgeFrame {
  if (bytes.length > BRIDGE_FRAME_BYTES || bytes.includes(10) || bytes.includes(13)) invalid()
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  const frame = validateBridgeFrame(parsed)
  // Canonical wire form also rejects duplicate JSON keys and ambiguous encodings.
  if (JSON.stringify(frame) !== text) invalid()
  return frame
}
/** Byte-level framing before UTF-8 decode; a multi-frame chunk is processed in order. */
export class BridgeDecoder {
  private pending = Buffer.alloc(0)
  push(chunk: Buffer): BridgeFrame[] {
    if (!Buffer.isBuffer(chunk)) invalid()
    const frames: BridgeFrame[] = []
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start)
      const part = chunk.subarray(start, end < 0 ? chunk.length : end)
      if (part.length + this.pending.length > BRIDGE_FRAME_BYTES || part.length + this.pending.length > BRIDGE_BUFFER_BYTES) invalid()
      this.pending = Buffer.concat([this.pending, part])
      if (end < 0) break
      frames.push(decodeBridgeFrame(this.pending))
      if (frames.length > 128) invalid()
      this.pending = Buffer.alloc(0)
      start = end + 1
    }
    return frames
  }
}
