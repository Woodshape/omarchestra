/**
 * Local Workbench v1 Phase 2 — observer transport and Pi installation probe.
 *
 * Legacy injected management object-event port, NOT the S4 Pi channel.
 * The separately versioned owner-only framed connection lives in
 * bridge-{protocol,channel,registry,owner}.ts; S5 must replace this legacy
 * management seam with challenged delivery on that connection. Outbound frames carry
 * identifiers, enums and digests only: no Goal text, no check definition, no
 * worker prose. An unknown frame kind, an unknown field, an oversized line or
 * a non-string field is a protocol error and never a partial application.
 *
 * `probePiInstallation` reads the local Pi extension manifest without writing
 * anything. Installation is negotiated, never performed by the workbench.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { workbenchError } from './errors.ts'

export const MAX_FRAME_BYTES = 65_536
export const FRAME_KINDS = ['adopt', 'committed', 'release', 'purge_notice', 'observe_request'] as const
export const EVENT_TYPES = ['adopt_ack', 'readiness', 'input_observed', 'disconnected', 'protocol_error', 'session_observed'] as const

export type FrameKind = (typeof FRAME_KINDS)[number]
export type EventType = (typeof EVENT_TYPES)[number]

export interface WorkbenchFrame {
  frameId: string
  kind: FrameKind
  runId: string | null
  bindingDigest: string | null
  nonce: string | null
  payload: Record<string, string | number | boolean | null>
}

export interface TransportEvent {
  type: EventType
  runId: string
  bindingDigest: string
  transportId: string
  /** Required and checked at runtime for adopt_ack; never inferred from a Run ID. */
  nonce?: string
  source: 'extension' | 'interactive' | 'operator' | 'unknown'
  detail: string
  /** Only set for `session_observed`: the Pi session the extension reported. */
  observedSessionId?: string
  role?: string | null
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST = /^[a-f0-9]{64}$/

function requireId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw workbenchError('invalid_input', `${where} is not a bounded identifier`, 'send frames produced by this workbench version')
  return value
}

function requireDigest(value: unknown, where: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw workbenchError('invalid_input', `${where} is not a sha256 digest`, 'send frames produced by this workbench version')
  return value
}

/** Canonical encode. Sorted keys make frames comparable across processes. */
export function encodeFrame(frame: WorkbenchFrame): string {
  const payloadKeys = Object.keys(frame.payload).sort()
  const encoded = JSON.stringify({
    frameId: requireId(frame.frameId, 'frameId'),
    kind: frame.kind,
    runId: frame.runId,
    bindingDigest: frame.bindingDigest,
    nonce: frame.nonce,
    payload: Object.fromEntries(payloadKeys.map(key => [key, frame.payload[key]])),
  })
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) {
    throw workbenchError('invalid_input', 'frame exceeds the transport byte bound', 'reduce the frame payload; the transport carries identity, not content')
  }
  return encoded
}

export function decodeFrame(line: unknown): WorkbenchFrame {
  if (typeof line !== 'string') throw workbenchError('invalid_input', 'frame must be a string line', 'send one JSON frame per line')
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw workbenchError('invalid_input', 'frame exceeds the transport byte bound', 'send bounded frames only')
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw workbenchError('invalid_input', 'frame is not JSON', 'send one JSON frame per line')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw workbenchError('invalid_input', 'frame must be a JSON object', 'send one JSON frame per line')
  const record = parsed as Record<string, unknown>
  const allowed = ['frameId', 'kind', 'runId', 'bindingDigest', 'nonce', 'payload']
  if (Object.keys(record).some(key => !allowed.includes(key))) {
    throw workbenchError('invalid_input', 'frame has an unknown field', 'send frames with exactly frameId, kind, runId, bindingDigest, nonce, payload')
  }
  if (!FRAME_KINDS.includes(record.kind as FrameKind)) {
    throw workbenchError('invalid_input', `unsupported frame kind ${String(record.kind)}`, 'send a frame kind this workbench version implements')
  }
  const payload = record.payload ?? {}
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw workbenchError('invalid_input', 'frame payload must be an object', 'send scalar payload entries only')
  }
  return {
    frameId: requireId(record.frameId, 'frameId'),
    kind: record.kind as FrameKind,
    runId: record.runId === null || record.runId === undefined ? null : requireId(record.runId, 'runId'),
    bindingDigest: record.bindingDigest === null || record.bindingDigest === undefined ? null : requireDigest(record.bindingDigest, 'bindingDigest'),
    nonce: record.nonce === null || record.nonce === undefined ? null : requireId(record.nonce, 'nonce'),
    payload: payload as Record<string, string | number | boolean | null>,
  }
}

export interface ObserverPort {
  readonly transportId: string
  send(frame: WorkbenchFrame): void
  subscribe(handler: (event: TransportEvent) => void): () => void
  close(): void
}

export interface InstallationReport {
  state: 'available' | 'absent' | 'incompatible'
  extensionId: string | null
  version: string | null
  manifestPath: string
  reason: string
}

/**
 * Read-only negotiation with an installed Pi extension. The workbench never
 * installs, upgrades or edits a Pi installation; it reports what it found and
 * what the operator has to do.
 */
export function probePiInstallation(extensionRoot: string, options: { requiresVersion?: string } = {}): InstallationReport {
  const manifestPath = join(extensionRoot, 'manifest.json')
  if (!existsSync(manifestPath)) {
    return { state: 'absent', extensionId: null, version: null, manifestPath, reason: 'No local Pi workbench extension is installed; install it in your Pi installation before adopting a Pi.' }
  }
  let manifest: Record<string, unknown>
  try {
    if (!statSync(manifestPath).isFile()) throw new Error('not a file')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { state: 'incompatible', extensionId: null, version: null, manifestPath, reason: `The installed Pi extension manifest cannot be read: ${message}` }
  }
  const extensionId = typeof manifest.id === 'string' ? manifest.id : null
  const version = typeof manifest.version === 'string' ? manifest.version : null
  if (extensionId === null || version === null) {
    return { state: 'incompatible', extensionId, version, manifestPath, reason: 'The installed Pi extension manifest has no id or version; reinstall it from a released workbench package.' }
  }
  const requires = options.requiresVersion
  if (requires !== undefined && version !== requires) {
    return { state: 'incompatible', extensionId, version, manifestPath, reason: `The installed Pi extension is ${version}; this workbench composes ${requires}. Update the Pi extension; the workbench never upgrades it for you.` }
  }
  return { state: 'available', extensionId, version, manifestPath, reason: '' }
}
