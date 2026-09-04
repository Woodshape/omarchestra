/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Same-process Pi observer adapter. The adapter only uses public lifecycle and
 * UI status/title seams. It does not inspect conversation data, intercept
 * input, start another Pi session, or control a terminal or process.
 */

import { randomBytes } from 'node:crypto'

import {
  OBSERVER_CAPABILITIES,
  OBSERVER_PI_STATUS_LOCAL,
  OBSERVER_PROTOCOL_ID,
  encodeFrame,
  isObserverRunnerFrameType,
  validateAdoptionAck,
  validateAdoptionRequestAck,
  validateAdoptionCommitted,
  validateObserverBodyForType,
  validateObserverRegistered,
  type AdoptionAckBody,
  type AdoptionRequestAckBody,
  type AdoptionCommittedBody,
  type ObserverActivity,
  type ObserverFrame,
} from './contracts.ts'

/** The observer never writes the managed role-state slot. */
export const OBSERVER_STATUS_KEY = 'omarchestra-observer-status'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const MAX_HOST_PID = 2 ** 31 - 1
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CAPABILITY_MIN_CHARACTERS = 32
const PROCESS_ID_PURPOSE = 'process'
const EXTENSION_ID_PURPOSE = 'extension'
const MESSAGE_ID_PURPOSE = 'message'
const EVENT_ID_PURPOSE = 'event'

type MaybePromise<T> = T | Promise<T>

export type ObserverFrameHandler = (frame: unknown) => void

type CloseHandler = (error?: unknown) => void

export interface ObserverConnection {
  send?(type: string, messageId: string, body: Record<string, unknown>): MaybePromise<void>
  sendFrame?(frame: ObserverFrame): MaybePromise<void>
  bind?(handler: ObserverFrameHandler): MaybePromise<void | (() => void)>
  onFrame?(handler: ObserverFrameHandler): MaybePromise<void | (() => void)>
  onClose?(handler: CloseHandler): MaybePromise<void | (() => void)>
  onDisconnect?(handler: CloseHandler): MaybePromise<void | (() => void)>
  close?(): MaybePromise<void>
  readonly closed?: boolean
  readonly isClosed?: boolean
}

export interface PiExtensionContext {
  readonly mode?: string
  readonly hasUI?: boolean
  readonly isIdle?: () => boolean
  readonly hasPendingMessages?: () => boolean
  readonly sessionManager?: {
    getSessionId?: () => string
  }
  readonly ui?: {
    setStatus?: (key: string, value: string | undefined) => void
    setTitle?: (title: string) => void
  }
  readonly enableManagedBridge?: (committed: Record<string, unknown>) => MaybePromise<void>
  readonly disableManagedBridge?: () => MaybePromise<void>
}

export interface PiExtensionAPI {
  on(event: string, handler: (payload: unknown, context: PiExtensionContext) => MaybePromise<unknown>): unknown
}

export interface HeartbeatHandle {
  unref?(): void
}

export type HeartbeatScheduler = (callback: () => void, intervalMs: number) => HeartbeatHandle
export type HeartbeatCanceller = (handle: HeartbeatHandle) => void

export interface ManagedBridgePort {
  enable?(committed: Record<string, unknown>): MaybePromise<void>
  disable?(): MaybePromise<void>
}

export interface ObserverExtensionOptions {
  observerVersion?: string
  processIncarnationId?: string
  processIncarnationIdFactory?: () => string
  extensionInstanceIdFactory?: () => string
  hostPid?: number
  hostPidFactory?: () => number
  connect?: (handler: ObserverFrameHandler) => MaybePromise<ObserverConnection>
  managedBridge?: ManagedBridgePort
  scheduleHeartbeat?: HeartbeatScheduler
  cancelHeartbeat?: HeartbeatCanceller
  randomIdFactory?: (purpose: string) => string
}

interface RegisteredState {
  readonly body: ReturnType<typeof validateObserverRegistered>
}

interface AdapterState {
  readonly context: PiExtensionContext
  readonly connection: ObserverConnection
  readonly processIncarnationId: string
  readonly piSessionId: string
  readonly extensionInstanceId: string
  readonly hostPid: number
  readonly registrationAttempt: number
  readonly handlerCleanup: Array<() => void>
  sendTail: Promise<void>
  registered: RegisteredState | null
  sourceSequence: number
  heartbeat: HeartbeatHandle | null
  shuttingDown: boolean
  closed: boolean
  managed: boolean
  promptActive: boolean
  agentActive: boolean
  statusOwned: boolean
  committed: AdoptionCommittedBody | null
  committing: { proposalId: string; proposalDigest: string } | null
  lastAcknowledgement: AdoptionRequestAckBody | null
}

/**
 * Build an opt-in Pi extension factory. The factory performs no connection or
 * UI work. Session-scoped resources begin only in `session_start`.
 */
export function createObserverExtension(options: ObserverExtensionOptions = {}) {
  let processIncarnationId: string | null = options.processIncarnationId ?? null
  let registrationAttempt = 0
  let messageCounter = 0
  let extensionCounter = 0
  let starting = false
  let state: AdapterState | null = null
  let lastExtensionInstanceId: string | null = null

  const makeId = (purpose: string): string => {
    const supplied = options.randomIdFactory?.(purpose)
    const value = supplied ?? `${purpose}-${randomBytes(16).toString('hex')}`
    if (!isId(value)) throw new Error('observer identity is not bounded')
    return value
  }

  const makeProcessIncarnationId = (): string => {
    if (processIncarnationId !== null) {
      if (!isCapabilityId(processIncarnationId)) throw new Error('observer process identity is not a bounded capability')
      return processIncarnationId
    }
    if (typeof options.processIncarnationIdFactory === 'function') {
      processIncarnationId = options.processIncarnationIdFactory()
    } else {
      processIncarnationId = makeId(PROCESS_ID_PURPOSE)
    }
    if (!isCapabilityId(processIncarnationId)) throw new Error('observer process identity is not a bounded capability')
    return processIncarnationId
  }

  const makeExtensionInstanceId = (): string => {
    const value = typeof options.extensionInstanceIdFactory === 'function'
      ? options.extensionInstanceIdFactory()
      : makeId(`${EXTENSION_ID_PURPOSE}${extensionCounter++}`)
    if (!isCapabilityId(value) || value === lastExtensionInstanceId) {
      throw new Error('observer extension identity is not fresh')
    }
    lastExtensionInstanceId = value
    return value
  }

  const makeHostPid = (): number => {
    const value = typeof options.hostPidFactory === 'function'
      ? options.hostPidFactory()
      : options.hostPid ?? process.pid
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HOST_PID) {
      throw new Error('observer host diagnostic identity is not bounded')
    }
    return value
  }

  const nextMessageId = (purpose: string): string => {
    messageCounter += 1
    if (!Number.isSafeInteger(messageCounter)) throw new Error('observer message sequence exhausted')
    return `${purpose}-${messageCounter.toString(16).padStart(32, '0')}`
  }

  const nextSourceSequence = (current: AdapterState): number => {
    if (!Number.isSafeInteger(current.sourceSequence) || current.sourceSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('observer source sequence exhausted')
    }
    current.sourceSequence += 1
    return current.sourceSequence
  }

  const clearStatus = (current: AdapterState): void => {
    if (!current.statusOwned) return
    try {
      current.context.ui?.setStatus?.(OBSERVER_STATUS_KEY, undefined)
    } catch {
      // A disconnected or unavailable UI must not make shutdown unsafe.
    }
    current.statusOwned = false
  }

  const stopHeartbeat = (current: AdapterState): void => {
    const heartbeat = current.heartbeat
    current.heartbeat = null
    if (heartbeat === null) return
    try {
      (options.cancelHeartbeat ?? defaultCancelHeartbeat)(heartbeat)
    } catch {
      // Resource cleanup is best effort and remains idempotent.
    }
  }

  const detachHandlers = (current: AdapterState): void => {
    while (current.handlerCleanup.length > 0) {
      const cleanup = current.handlerCleanup.pop()
      try {
        cleanup?.()
      } catch {
        // Cleanup is best effort. The connection is already being retired.
      }
    }
  }

  const disableManagedBridge = async (current: AdapterState): Promise<void> => {
    if (!current.managed) return
    try {
      if (typeof options.managedBridge?.disable === 'function') {
        await options.managedBridge.disable()
      } else {
        await current.context.disableManagedBridge?.()
      }
    } catch {
      // Cleanup remains best effort after a committed result.
    }
  }

  const closeConnection = async (current: AdapterState): Promise<void> => {
    const connection = current.connection
    current.closed = true
    current.shuttingDown = true
    stopHeartbeat(current)
    detachHandlers(current)
    clearStatus(current)
    await disableManagedBridge(current)
    if (state === current) state = null
    try {
      await connection.close?.()
    } catch {
      // The ordinary Pi session remains usable if registry cleanup fails.
    }
  }

  const failOpen = async (current: AdapterState | null, close = true): Promise<void> => {
    if (current === null || current.closed) return
    if (close) {
      await closeConnection(current)
      return
    }
    current.closed = true
    current.shuttingDown = true
    stopHeartbeat(current)
    detachHandlers(current)
    clearStatus(current)
    await disableManagedBridge(current)
    if (state === current) state = null
  }

  const sendFrame = async (
    current: AdapterState,
    type: string,
    body: Record<string, unknown>,
    allowClosed = false,
  ): Promise<void> => {
    if ((!allowClosed && current.closed)
        || current.connection.closed === true
        || current.connection.isClosed === true
        || (current.shuttingDown && type !== 'observer.close')) {
      throw new Error('observer connection is closed')
    }
    const messageId = nextMessageId(MESSAGE_ID_PURPOSE)
    const line = encodeFrame(type, messageId, body)
    const parsed = JSON.parse(line) as { type: string; messageId: string; body: Record<string, unknown> }
    const validatedBody = validateObserverBodyForType(parsed.type, parsed.body)
    const send = current.sendTail.then(async () => {
      if (current.connection.closed === true || current.connection.isClosed === true) {
        throw new Error('observer connection is closed')
      }
      if (typeof current.connection.send === 'function') {
        await current.connection.send(parsed.type, parsed.messageId, validatedBody)
        return
      }
      if (typeof current.connection.sendFrame === 'function') {
        await current.connection.sendFrame({
          protocol: OBSERVER_PROTOCOL_ID,
          type: parsed.type,
          messageId: parsed.messageId,
          body: validatedBody,
        })
        return
      }
      throw new Error('observer connection has no send seam')
    })
    current.sendTail = send.catch(() => {})
    await send
  }

  const sendLifecycle = async (current: AdapterState, activity: ObserverActivity): Promise<void> => {
    if (current.registered === null || current.managed || current.closed) return
    await sendFrame(current, 'observer.lifecycle', {
      connectionId: current.registered.body.connectionId,
      connectionChallenge: current.registered.body.connectionChallenge,
      eventId: nextMessageId(EVENT_ID_PURPOSE),
      sourceSequence: nextSourceSequence(current),
      lifecycle: 'running',
      activity,
      health: 'healthy',
    })
  }

  const classifyActivity = (current: AdapterState): ObserverActivity => {
    if (current.shuttingDown) return 'unknown'
    if (current.promptActive) return 'waiting_for_user'
    let idle: boolean | undefined
    let pending: boolean | undefined
    try {
      idle = current.context.isIdle?.()
    } catch {
      idle = undefined
    }
    try {
      pending = current.context.hasPendingMessages?.()
    } catch {
      pending = undefined
    }
    if (pending === true) return 'busy'
    if (idle === true && current.agentActive === false) return 'idle'
    if (current.agentActive) return 'busy'
    return 'unknown'
  }

  const currentIdentityMatches = (
    current: AdapterState,
    body: AdoptionRequestAckBody,
  ): boolean => {
    if (current.registered === null || current.context.mode !== 'tui' || current.context.hasUI !== true) return false
    let activePiSessionId: string | undefined
    try {
      activePiSessionId = current.context.sessionManager?.getSessionId?.()
    } catch {
      activePiSessionId = undefined
    }
    if (activePiSessionId !== current.piSessionId) return false
    return body.observedSessionId === current.registered.body.observedSessionId
      && body.executionNodeId === current.registered.body.executionNodeId
      && body.processIncarnationId === current.processIncarnationId
      && body.piSessionId === current.piSessionId
      && body.extensionInstanceId === current.extensionInstanceId
      && body.connectionId === current.registered.body.connectionId
      && body.connectionChallenge === current.registered.body.connectionChallenge
      && body.registryRevision === current.registered.body.registryRevision
  }

  const sendAcknowledgement = async (
    current: AdapterState,
    request: AdoptionRequestAckBody,
  ): Promise<void> => {
    const activity = classifyActivity(current)
    const identityMatches = currentIdentityMatches(current, request)
    let decision: AdoptionAckBody['decision'] = 'acknowledged'
    let refusalCode: string | null = null
    if (!identityMatches) {
      decision = 'refused'
      refusalCode = 'identity_drift'
    } else if (current.managed) {
      decision = 'refused'
      refusalCode = 'already_managed'
    } else if (activity !== 'idle') {
      decision = 'refused'
      refusalCode = activity === 'unknown' ? 'reconciliation_failed' : 'session_busy'
    }

    if (current.registered === null) return
    const acknowledgement = validateAdoptionAck({
      processIncarnationId: current.processIncarnationId,
      piSessionId: current.piSessionId,
      extensionInstanceId: current.extensionInstanceId,
      connectionId: current.registered.body.connectionId,
      connectionChallenge: current.registered.body.connectionChallenge,
      proposalId: request.proposalId,
      proposalDigest: request.proposalDigest,
      acknowledgementNonce: request.acknowledgementNonce,
      registryRevision: request.registryRevision,
      sourceSequence: nextSourceSequence(current),
      decision,
      activity,
      refusalCode,
    })
    await sendFrame(current, 'adoption.ack', acknowledgement as unknown as Record<string, unknown>)
    if (decision === 'acknowledged') current.lastAcknowledgement = request
  }

  const enableManagedBridge = async (
    current: AdapterState,
    committed: AdoptionCommittedBody,
  ): Promise<void> => {
    const committedRecord = committed as unknown as Record<string, unknown>
    if (typeof options.managedBridge?.enable === 'function') {
      await options.managedBridge.enable(structuredClone(committedRecord))
    } else {
      await current.context.enableManagedBridge?.(structuredClone(committedRecord))
    }
  }

  const applyCommitted = async (
    current: AdapterState,
    committed: AdoptionCommittedBody,
  ): Promise<void> => {
    if (current.registered === null || current.closed || current.shuttingDown) return
    if (current.managed) {
      if (current.committed?.proposalId === committed.proposalId
          && current.committed.proposalDigest === committed.proposalDigest) return
      return
    }
    if (current.lastAcknowledgement === null
        || current.lastAcknowledgement.proposalId !== committed.proposalId
        || current.lastAcknowledgement.proposalDigest !== committed.proposalDigest) {
      throw new Error('committed Adoption does not match the same-process acknowledgement')
    }
    if (current.committing !== null) return
    current.committing = {
      proposalId: committed.proposalId,
      proposalDigest: committed.proposalDigest,
    }
    try {
      // Receipt of this validated, exactly acknowledged frame proves the Team
      // Runner already committed. Presentation or managed-bridge delivery may
      // degrade, but must never recreate observation or resume its telemetry.
      current.committed = committed
      current.managed = true
      stopHeartbeat(current)
      try {
        current.context.ui?.setStatus?.(OBSERVER_STATUS_KEY, committed.piStatus)
        current.statusOwned = true
        current.context.ui?.setTitle?.(committed.terminalTitleMetadata)
      } catch {
        return
      }
      try {
        await enableManagedBridge(current, committed)
      } catch {
        return
      }
    } finally {
      current.committing = null
    }
  }

  const parseIncomingFrame = (input: unknown): { type: string; body: unknown } => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('observer frame is not an object')
    }
    const value = input as Record<string, unknown>
    const fields = Object.keys(value).sort()
    if (fields.length !== 4
        || fields[0] !== 'body'
        || fields[1] !== 'messageId'
        || fields[2] !== 'protocol'
        || fields[3] !== 'type') {
      throw new Error('observer frame fields are not exact')
    }
    if (value.protocol !== OBSERVER_PROTOCOL_ID) {
      throw new Error('observer protocol is incompatible')
    }
    if (!isId(value.messageId)) {
      throw new Error('observer message identity is invalid')
    }
    if (typeof value.type !== 'string' || !isObserverRunnerFrameType(value.type)) {
      throw new Error('observer frame type is incompatible')
    }
    return { type: value.type, body: value.body }
  }

  const handleFrame = async (current: AdapterState, input: unknown): Promise<void> => {
    if (state !== current || current.closed || current.shuttingDown) return
    const frame = parseIncomingFrame(input)
    const body = validateObserverBodyForType(frame.type, frame.body)
    if (frame.type === 'observer.registered') {
      const registered = validateObserverRegistered(body)
      if (current.registered !== null) return
      if (registered.acceptedRegistrationAttempt !== current.registrationAttempt
          || registered.acceptedSourceSequence !== 1
          || registered.heartbeatIntervalMs !== DEFAULT_HEARTBEAT_INTERVAL_MS
          || registered.leaseDurationMs !== 15_000
          || registered.connectionId === undefined
          || registered.connectionChallenge === undefined) {
        throw new Error('observer registration does not match the current extension attempt')
      }
      current.registered = { body: registered }
      current.context.ui?.setStatus?.(OBSERVER_STATUS_KEY, OBSERVER_PI_STATUS_LOCAL)
      current.statusOwned = true
      const interval = Number(registered.heartbeatIntervalMs)
      const schedule = options.scheduleHeartbeat ?? defaultScheduleHeartbeat
      current.heartbeat = schedule(() => {
        void sendFrame(current, 'observer.heartbeat', {
          connectionId: registered.connectionId,
          connectionChallenge: registered.connectionChallenge,
          sourceSequence: nextSourceSequence(current),
          lifecycle: 'running',
          activity: classifyActivity(current),
          health: 'healthy',
        }).catch(() => {
          void failOpen(current, true)
        })
      }, Number.isSafeInteger(interval) && interval > 0 ? interval : DEFAULT_HEARTBEAT_INTERVAL_MS)
      current.heartbeat.unref?.()
      return
    }
    if (frame.type === 'observer.rejected') {
      await failOpen(current, true)
      return
    }
    if (frame.type === 'adoption.request_ack') {
      if (current.registered === null) return
      await sendAcknowledgement(current, validateAdoptionRequestAck(body))
      return
    }
    if (frame.type === 'adoption.committed') {
      await applyCommitted(current, validateAdoptionCommitted(body))
    }
  }

  const startSession = async (context: PiExtensionContext): Promise<void> => {
    if (starting || state !== null) return
    if (context.mode !== 'tui' || context.hasUI !== true) return
    starting = true
    try {
      if (typeof options.connect !== 'function') return
      const piSessionId = context.sessionManager?.getSessionId?.()
      if (!isId(piSessionId)) return
      const processId = makeProcessIncarnationId()
      const extensionId = makeExtensionInstanceId()
      if (processId === piSessionId || processId === extensionId || piSessionId === extensionId) return
      const hostPid = makeHostPid()
      registrationAttempt += 1
      if (!Number.isSafeInteger(registrationAttempt) || registrationAttempt < 1) return

      let connection: ObserverConnection
      let current: AdapterState | null = null
      const receive: ObserverFrameHandler = (frame) => {
        if (current === null) return
        void handleFrame(current, frame).catch(() => {
          void failOpen(current, true)
        })
      }
      try {
        connection = await options.connect(receive)
      } catch {
        return
      }
      if (!isConnection(connection, options.connect.length === 0)) return

      const active: AdapterState = {
        context,
        connection,
        processIncarnationId: processId,
        piSessionId,
        extensionInstanceId: extensionId,
        hostPid,
        registrationAttempt,
        handlerCleanup: [],
        sendTail: Promise.resolve(),
        registered: null,
        sourceSequence: 0,
        heartbeat: null,
        shuttingDown: false,
        closed: false,
        managed: false,
        promptActive: false,
        agentActive: false,
        statusOwned: false,
        committed: null,
        committing: null,
        lastAcknowledgement: null,
      }
      current = active
      state = active
      // The injected connect(handler) seam normally binds the callback. A
      // zero-argument connector may instead return an unbound connection.
      if (options.connect.length === 0) {
        if (typeof connection.bind === 'function') {
          const cleanup = await connection.bind(receive)
          if (typeof cleanup === 'function') active.handlerCleanup.push(cleanup)
        } else if (typeof connection.onFrame === 'function') {
          const cleanup = await connection.onFrame(receive)
          if (typeof cleanup === 'function') active.handlerCleanup.push(cleanup)
        } else {
          await failOpen(active, true)
          return
        }
      }
      if (typeof connection.onClose === 'function') {
        const cleanup = await connection.onClose(() => {
          void failOpen(active, false)
        })
        if (typeof cleanup === 'function') active.handlerCleanup.push(cleanup)
      }
      if (typeof connection.onDisconnect === 'function') {
        const cleanup = await connection.onDisconnect(() => {
          void failOpen(active, false)
        })
        if (typeof cleanup === 'function') active.handlerCleanup.push(cleanup)
      }
      active.sourceSequence = 1
      await sendFrame(active, 'observer.register', {
        processIncarnationId: processId,
        piSessionId,
        extensionInstanceId: extensionId,
        hostPid,
        hostMode: 'tui',
        observerVersion: options.observerVersion ?? '0.1.0',
        capabilities: [...OBSERVER_CAPABILITIES],
        registrationAttempt,
        sourceSequence: 1,
        lifecycle: 'running',
        activity: classifyActivity(active),
        health: 'healthy',
      })
    } catch {
      if (state !== null) await failOpen(state, true)
    } finally {
      starting = false
    }
  }

  const shutdownSession = async (event: unknown): Promise<void> => {
    const current = state
    if (current === null || current.closed || current.shuttingDown) return
    current.shuttingDown = true
    stopHeartbeat(current)
    if (current.registered !== null) {
      const value = event !== null && typeof event === 'object'
        ? (event as Record<string, unknown>).reason
        : undefined
      const reason = isCloseReason(value) ? value : 'quit'
      try {
        await sendFrame(current, 'observer.close', {
          connectionId: current.registered.body.connectionId,
          connectionChallenge: current.registered.body.connectionChallenge,
          sourceSequence: nextSourceSequence(current),
          reason,
        }, true)
      } catch {
        // Always close the local resource even if the close frame cannot send.
      }
    }
    await closeConnection(current)
  }

  const lifecycle = (kind: 'start' | 'settled' | 'prompt_start' | 'prompt_end') => async (): Promise<void> => {
    const current = state
    if (current === null || current.closed || current.shuttingDown || current.managed) return
    if (kind === 'start') current.agentActive = true
    if (kind === 'settled') current.agentActive = false
    if (kind === 'prompt_start') current.promptActive = true
    if (kind === 'prompt_end') current.promptActive = false
    try {
      await sendLifecycle(current, classifyActivity(current))
    } catch {
      await failOpen(current, true)
    }
  }

  const extensionFactory = (pi: PiExtensionAPI): void => {
    pi.on('session_start', async (_event, context) => {
      await startSession(context)
    })
    pi.on('session_shutdown', async (event) => {
      await shutdownSession(event)
    })
    pi.on('agent_start', lifecycle('start'))
    pi.on('agent_settled', lifecycle('settled'))
    pi.on('ui_prompt_start', lifecycle('prompt_start'))
    pi.on('ui_prompt_end', lifecycle('prompt_end'))
  }

  return extensionFactory
}

/** Default Pi extension entrypoint. Configuration is intentionally injected. */
export default function observerExtension(pi: PiExtensionAPI): void {
  createObserverExtension()(pi)
}

function isConnection(value: unknown, requireBinding: boolean): value is ObserverConnection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const connection = value as ObserverConnection
  const hasSend = typeof connection.send === 'function' || typeof connection.sendFrame === 'function'
  const hasBind = typeof connection.bind === 'function' || typeof connection.onFrame === 'function'
  const isClosed = connection.closed === true || connection.isClosed === true
  return hasSend && !isClosed && (!requireBinding || hasBind) && typeof connection.close === 'function'
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function isCapabilityId(value: unknown): value is string {
  return isId(value) && value.length >= CAPABILITY_MIN_CHARACTERS
}

function isCloseReason(value: unknown): value is 'quit' | 'reload' | 'new' | 'resume' | 'fork' {
  return value === 'quit' || value === 'reload' || value === 'new' || value === 'resume' || value === 'fork'
}

function defaultScheduleHeartbeat(callback: () => void, intervalMs: number): HeartbeatHandle {
  const handle = setInterval(callback, intervalMs) as unknown as HeartbeatHandle
  return handle
}

function defaultCancelHeartbeat(handle: HeartbeatHandle): void {
  const cancel = (handle as HeartbeatHandle & { cancel?: () => void }).cancel
  if (typeof cancel === 'function') {
    cancel()
    return
  }
  clearInterval(handle as unknown as ReturnType<typeof setInterval>)
}
