/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * manual/live-adoption-extension.ts — the same-Pi Adoption extension
 * entrypoint. It composes the observer extension with an explicit managed
 * bridge port that activates only after a committed `adoption.committed`
 * frame. The managed bridge owns managed input handling exclusively; the
 * observer collector never handles managed input. Importing or constructing
 * this factory performs no socket, filesystem, process, or UI work.
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  createObserverExtension,
  type HeartbeatCanceller,
  type HeartbeatScheduler,
  type PiExtensionAPI,
  type ObserverExtensionOptions,
  type ObserverConnection,
  type ObserverFrameHandler,
  type ReconnectCanceller,
  type ReconnectScheduler,
} from '../observer/extension-adapter.ts'
import { connectObserverSocket } from './live-observer-transport.ts'

export interface LiveAdoptionExtensionOptions {
  connect?: ObserverExtensionOptions['connect']
  socketPath?: string
  observerVersion?: string
  processIncarnationId?: string
  processIncarnationIdFactory?: () => string
  extensionInstanceIdFactory?: () => string
  hostPid?: number
  hostPidFactory?: () => number
  scheduleHeartbeat?: HeartbeatScheduler
  cancelHeartbeat?: HeartbeatCanceller
  scheduleReconnect?: ReconnectScheduler
  cancelReconnect?: ReconnectCanceller
  maxReconnectAttempts?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  randomIdFactory?: (purpose: string) => string
  managedBridge?: LiveAdoptionManagedBridge
}

export interface CommittedAdoptionView {
  proposalId: string
  proposalDigest: string
  agentRunId: string
  targetTeamGoalId: string
  targetRole: string
  controlMode: 'managed'
  piStatus: string
  terminalTitleMetadata: string
  runtimeBindingGuarantee: 'unavailable'
}

/**
 * The committed managed bridge for an adopted ordinary Pi. It is inert until
 * `enable(committed)` is called after a durable commit, and it owns managed
 * source-only input observation exclusively. `handleInput` reports whether a
 * durable takeover notification is needed; Pi always receives input unchanged.
 */
export class LiveAdoptionManagedBridge {
  private enabledValue = false
  private committedValue: CommittedAdoptionView | null = null
  private readonly onActivate: ((committed: CommittedAdoptionView) => void) | null
  private readonly onDeactivate: (() => void) | null

  constructor(options: {
    onActivate?: (committed: CommittedAdoptionView) => void
    onDeactivate?: () => void
  } = {}) {
    this.onActivate = options.onActivate ?? null
    this.onDeactivate = options.onDeactivate ?? null
  }

  get enabled(): boolean {
    return this.enabledValue
  }

  get committed(): CommittedAdoptionView | null {
    return this.committedValue === null ? null : structuredClone(this.committedValue)
  }

  /** Activate only after a committed, validated Adoption result. */
  enable(committed: Record<string, unknown>): void {
    const view = normalizeCommitted(committed)
    this.committedValue = view
    this.enabledValue = true
    this.onActivate?.(view)
  }

  /** Deactivate on runner connection loss or explicit cleanup. */
  disable(): void {
    this.enabledValue = false
    this.committedValue = null
    this.onDeactivate?.()
  }

  /**
   * Detect interactive input only after commit. Content is never inspected or
   * consumed; the manual factory sends a content-free takeover notification.
   */
  handleInput(_text: string, source: unknown): boolean {
    if (!this.enabledValue) return false
    if (source !== 'interactive') return false
    return true
  }
}

/**
 * Build the manual Adoption extension without opening its socket. The path is
 * resolved inside the injected connect callback so importing or constructing
 * this factory remains side-effect free.
 */
export function createLiveAdoptionExtension(options: LiveAdoptionExtensionOptions = {}) {
  const managedBridge = options.managedBridge ?? new LiveAdoptionManagedBridge()
  let connection: ObserverConnection | null = null
  let lastCommitted: Record<string, unknown> | null = null
  let pendingTakeover = false
  let candidateProposalId: string | null = null
  const notifyTakeover = async () => {
    const current = connection
    if (!lastCommitted || !current?.send || current.closed || current.isClosed) return
    try { await current.send('adoption.takeover', `takeover-${randomUUID()}`, lastCommitted) }
    catch { managedBridge.disable(); await current.close?.() }
  }
  const observe = createObserverExtension({
    managedRecovery: true,
    observerVersion: options.observerVersion,
    processIncarnationId: options.processIncarnationId,
    processIncarnationIdFactory: options.processIncarnationIdFactory,
    extensionInstanceIdFactory: options.extensionInstanceIdFactory,
    hostPid: options.hostPid,
    hostPidFactory: options.hostPidFactory,
    scheduleHeartbeat: options.scheduleHeartbeat,
    cancelHeartbeat: options.cancelHeartbeat,
    scheduleReconnect: options.scheduleReconnect,
    cancelReconnect: options.cancelReconnect,
    maxReconnectAttempts: options.maxReconnectAttempts ?? 32,
    reconnectInitialDelayMs: options.reconnectInitialDelayMs,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    randomIdFactory: options.randomIdFactory,
    managedBridge: {
      enable: async (committed) => {
        lastCommitted = structuredClone(committed)
        managedBridge.enable(committed)
        // Input during gateway loss still belongs to this committed Agent Run.
        // Reconcile its source-only takeover before sending a readiness receipt.
        if (pendingTakeover) await notifyTakeover()
      },
      disable: () => managedBridge.disable(),
    },
    connect: async handler => {
      const receive: ObserverFrameHandler = frame => {
        const value = frame as { type?: unknown; body?: { proposalId?: unknown } } | null
        if (!lastCommitted && value?.type === 'adoption.request_ack'
            && typeof value.body?.proposalId === 'string' && value.body.proposalId !== candidateProposalId) {
          candidateProposalId = value.body.proposalId
          pendingTakeover = false
        }
        handler(frame)
      }
      const opened = await (options.connect ?? (receiver => connectObserverSocket(resolveSocketPath(options.socketPath), receiver)))(receive)
      connection = opened
      await opened.onClose?.(() => { if (connection === opened) connection = null })
      return opened
    },
  })
  return (pi: PiExtensionAPI) => {
    observe(pi)
    pi.on('input', async event => {
      // Content is never read, forwarded, persisted, transformed, or consumed.
      const source = event && typeof event === 'object' ? (event as { source?: unknown }).source : undefined
      if ((lastCommitted !== null || candidateProposalId !== null) && source === 'interactive') {
        pendingTakeover = true
        await notifyTakeover()
      }
      return { action: 'continue' }
    })
    pi.on('session_shutdown', () => {
      lastCommitted = null
      candidateProposalId = null
      pendingTakeover = false
      connection = null
    })
  }
}

/** Pi loads this function in the ordinary visible process. */
export default function liveAdoptionExtension(pi: PiExtensionAPI): void {
  createLiveAdoptionExtension()(pi)
}

function resolveSocketPath(explicitPath: string | undefined): string {
  const socketPath = explicitPath ?? process.env.OMARCHESTRA_ADOPTION_SOCKET
  if (socketPath === undefined || !path.isAbsolute(socketPath)) {
    throw new Error('OMARCHESTRA_ADOPTION_SOCKET must be an absolute Unix-socket path')
  }
  return socketPath
}

function normalizeCommitted(input: Record<string, unknown>): CommittedAdoptionView {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('committed Adoption result must be a plain object')
  }
  const view: CommittedAdoptionView = {
    proposalId: requireId(input.proposalId, 'proposalId'),
    proposalDigest: requireDigest(input.proposalDigest),
    agentRunId: requireId(input.agentRunId, 'agentRunId'),
    targetTeamGoalId: requireId(input.targetTeamGoalId, 'targetTeamGoalId'),
    targetRole: requireRole(input.targetRole),
    controlMode: 'managed',
    piStatus: requireText(input.piStatus, 'piStatus', 512),
    terminalTitleMetadata: requireText(input.terminalTitleMetadata, 'terminalTitleMetadata', 512),
    runtimeBindingGuarantee: 'unavailable',
  }
  if (input.controlMode !== 'managed' || input.runtimeBindingGuarantee !== 'unavailable') {
    throw new TypeError('committed Adoption result must be managed with no Runtime Binding guarantee')
  }
  return view
}

function requireId(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    throw new TypeError(`${where} must be a bounded identity`)
  }
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new TypeError('proposalDigest must be exactly 64 lowercase hexadecimal characters')
  }
  return input
}

function requireRole(input: unknown): string {
  if (typeof input !== 'string' || !['coordinator', 'builder', 'reviewer'].includes(input)) {
    throw new TypeError('targetRole must be an allowed Role')
  }
  return input
}

function requireText(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > maxCharacters) {
    throw new TypeError(`${where} must be bounded text`)
  }
  return input
}
