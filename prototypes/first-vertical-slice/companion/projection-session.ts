/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Thin Projection Session controller for the persistent Companion Plugin.
 * It owns NO presentation state machine of its own: all snapshot baseline,
 * ordered-event, cursor, gap, duplicate, reconnect, and resnapshot semantics
 * remain in the existing console projection core and live adapter, which
 * this controller drives through the shared omarchestra.companion/v1
 * contract. Its only responsibilities are:
 *
 *   - capability discovery against the installed plugin through the injected
 *     shell port, strictly before any runner connection;
 *   - allocating one ephemeral Projection Session identity per open;
 *   - publishing validated plain handoffs to the plugin panel (summon once,
 *     then applyHandoff) and to the optional caller sink;
 *   - forwarding acknowledged, deduplicated present-agent intents;
 *   - hide and clear of ephemeral state only;
 *   - failing closed on stale plugin generations and stale sessions.
 *
 * Routine session code never imports the installation module, the fake
 * Omarchy adapters, or any storage module, and never writes Omarchy
 * configuration, plugin assets, or QML.
 */

import {
  COMPANION_PLUGIN_ID,
  COMPANION_PROTOCOL_ID,
  CompanionError,
  CompanionIntentError,
  CompanionPluginUnavailableError,
  CompanionProtocolError,
  assertRequiredCapabilities,
  validateCapabilitiesEnvelope,
  validateClearEnvelope,
  validateHideEnvelope,
  validateIntentAcknowledgementEnvelope,
  validateIntentEnvelope,
  validateOpenEnvelope,
  validateProjectionApplyEnvelope,
  type CompanionCapabilitiesEnvelope,
  type CompanionIntentResult,
  type CompanionShellPort,
  type ProjectionSessionIdentity,
} from './contracts.ts'
import {
  AgentConsoleProjection,
  type AgentConsoleHandoff,
} from '../console/projection-core.ts'
import {
  LiveProjectionAdapter,
  type ProjectionConnector,
} from '../console/live-projection-adapter.ts'

export interface ProjectionIntentRequest {
  intentId: string
  kind?: 'present_agent'
  role: string
  payload?: Record<string, unknown>
}

export interface ProjectionIntentOutcome {
  intentId: string
  result: CompanionIntentResult
  detail: string | null
}

export interface ProjectionSessionManagerOptions {
  pluginId: string
  protocol: string
  shell: CompanionShellPort
  connector: ProjectionConnector
  /** Optional extra observer of every published plain handoff. */
  sink?: (handoff: AgentConsoleHandoff) => void
  clientId?: string
}

type SessionPhase = 'idle' | 'opening' | 'active' | 'ended'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void
  let rejectValue!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Ephemeral Projection Session controller. One instance owns one reused
 * AgentConsoleProjection across all of its sessions; every session gets a
 * fresh authoritative snapshot and a new session generation.
 */
export class ProjectionSessionManager {
  readonly projection: AgentConsoleProjection

  private readonly pluginId: string
  private readonly clientId: string
  private readonly shell: CompanionShellPort
  private readonly connector: ProjectionConnector
  private readonly pendingIntents = new Map<string, Deferred<ProjectionIntentOutcome>>()
  private readonly completedIntents = new Set<string>()

  private generationCounter = 0
  private phase: SessionPhase = 'idle'
  private activeSession: ProjectionSessionIdentity | null = null
  private lastSessionIdentity: ProjectionSessionIdentity | null = null
  private adapter: LiveProjectionAdapter | null = null
  private openGate: Deferred<void> | null = null
  private summoned = false
  private hidden = false
  private lastErrorMessage: string | null = null
  private readonly sharedProjection: AgentConsoleProjection
  private readonly userSink: ((handoff: AgentConsoleHandoff) => void) | null

  constructor(options: ProjectionSessionManagerOptions) {
    if (options.pluginId !== COMPANION_PLUGIN_ID) {
      throw new CompanionError('invalid_envelope', `the Companion manager owns exactly ${COMPANION_PLUGIN_ID}`)
    }
    if (options.protocol !== 'omarchestra.companion/v1') {
      throw new CompanionProtocolError(
        'unsupported_protocol',
        `the Companion manager speaks exactly omarchestra.companion/v1, received ${String(options.protocol)}`,
      )
    }
    this.pluginId = options.pluginId
    this.shell = options.shell
    this.connector = options.connector
    this.clientId = options.clientId ?? 'omarchestra-companion-client'
    this.userSink = options.sink ?? null
    this.sharedProjection = new AgentConsoleProjection()
    this.projection = this.sharedProjection
  }

  get handoff(): AgentConsoleHandoff | null {
    return this.projection.handoff
  }

  /** Monotonic ephemeral session generation; increments on every open. */
  get sessionGeneration(): number {
    return this.generationCounter
  }

  get lastError(): string | null {
    return this.lastErrorMessage
  }

  /**
   * Capability discovery is strictly first: a foreign protocol, missing
   * capability set, or absent plugin fails closed before any runner
   * connection, panel summon, or state change.
   */
  async open(options: { teamGoalId: string }): Promise<void> {
    if (this.phase === 'opening' || this.phase === 'active' || this.activeSession !== null) {
      throw new CompanionIntentError(
        'invalid_projection_state',
        'a Projection Session is already active; hide or clear it before opening again',
      )
    }

    let discovered: CompanionCapabilitiesEnvelope
    try {
      const response = await this.shell.capabilities(this.pluginId)
      const envelope = validateCapabilitiesEnvelope(response)
      if (envelope.pluginId !== this.pluginId) {
        throw new CompanionPluginUnavailableError(
          `capability discovery answered for plugin ${envelope.pluginId}, not ${this.pluginId}`,
        )
      }
      assertRequiredCapabilities(envelope.capabilities)
      discovered = envelope
    } catch (error) {
      this.lastErrorMessage = errorMessage(error)
      throw error
    }

    const generation = ++this.generationCounter
    const identity: ProjectionSessionIdentity = {
      sessionId: `companion-session-${this.clientId}-${generation}`,
      teamGoalId: options.teamGoalId,
      clientId: this.clientId,
      sessionGeneration: generation,
      pluginGeneration: discovered.pluginGeneration,
    }
    this.activeSession = identity
    this.lastSessionIdentity = identity
    this.phase = 'opening'
    this.summoned = false
    this.hidden = false
    this.openGate = createDeferred<void>()

    this.sharedProjection.clearState()
    const adapter = new LiveProjectionAdapter({
      teamGoalId: identity.teamGoalId,
      clientId: this.clientId,
      connector: this.connector,
      projection: this.sharedProjection,
      sink: (handoff) => this.onPublished(identity, handoff),
      onPreBaselineFailure: (error) => this.onPreBaselineFailure(identity, error),
      onIntentAck: (ack) => this.onIntentAck(identity, ack),
    })
    this.adapter = adapter

    let startFailure: unknown = null
    try {
      await adapter.start()
    } catch (error) {
      startFailure = error
    }
    if (startFailure !== null) {
      this.failSession(startFailure)
      throw startFailure
    }

    await this.openGate.promise
    this.phase = 'active'
    this.lastErrorMessage = null
  }

  /**
   * Forwards one presentation intent for a present agent. The intent is
   * validated locally (active session, ready projection, present role, new
   * identity), sent exactly once, and resolved only by the runner
   * acknowledgement.
   */
  async sendIntent(request: ProjectionIntentRequest): Promise<ProjectionIntentOutcome> {
    const identity = this.activeSession
    if (this.phase !== 'active' || identity === null || this.adapter === null) {
      throw new CompanionIntentError(
        'invalid_intent',
        'intents require an active Projection Session',
      )
    }
    const handoff = this.sharedProjection.handoff
    if (handoff === null || handoff.status !== 'ready') {
      throw new CompanionIntentError(
        'invalid_projection_state',
        `intents require a ready projection; the current projection status is ${handoff?.status ?? 'unavailable'}`,
      )
    }
    if (!handoff.cards.some((card) => card.role === request.role)) {
      throw new CompanionIntentError(
        'invalid_intent',
        `intent role ${String(request.role)} is not present in the current projection`,
      )
    }
    if (request.kind !== undefined && request.kind !== 'present_agent') {
      throw new CompanionIntentError('invalid_intent', `unsupported intent kind ${String(request.kind)}`)
    }
    if (this.pendingIntents.has(request.intentId) || this.completedIntents.has(request.intentId)) {
      throw new CompanionIntentError(
        'duplicate_intent',
        `duplicate intent identity ${request.intentId} is already pending or resolved`,
      )
    }

    const envelope = validateIntentEnvelope({
      protocol: 'omarchestra.companion/v1',
      type: 'intent',
      session: identity,
      intentId: request.intentId,
      kind: 'present_agent',
      role: request.role,
      payload: request.payload ?? {},
    })

    const deferred = createDeferred<ProjectionIntentOutcome>()
    this.pendingIntents.set(request.intentId, deferred)
    try {
      this.adapter.sendProjectionIntent(envelope as unknown as Record<string, unknown>)
    } catch (error) {
      this.pendingIntents.delete(request.intentId)
      throw new CompanionIntentError(
        'invalid_projection_state',
        `the intent could not be sent over the projection connection: ${errorMessage(error)}`,
      )
    }
    return deferred.promise
  }

  /**
   * Hides the panel and clears all ephemeral state. Idempotent; never
   * disables, unloads, uninstalls, or rewrites any installation state.
   */
  async hide(): Promise<void> {
    if (this.hidden) return
    this.hidden = true
    const identity = this.activeSession ?? this.lastSessionIdentity
    if (identity !== null) {
      try {
        const envelope = validateHideEnvelope({
          protocol: 'omarchestra.companion/v1',
          type: 'hide',
          session: identity,
        })
        await Promise.resolve(this.shell.hide(this.pluginId, encodeJson(envelope)))
      } catch (error) {
        this.lastErrorMessage = errorMessage(error)
      }
    }
    if (this.phase === 'opening' || this.phase === 'active') {
      this.openGate?.reject(new CompanionIntentError('invalid_projection_state', 'the Projection Session was hidden'))
      this.endSession()
    }
  }

  /**
   * Clears all ephemeral projection state without hiding the durable plugin.
   * The next open starts from a fresh authoritative snapshot.
   */
  clear(): void {
    const identity = this.activeSession
    if (identity !== null) {
      try {
        const envelope = validateClearEnvelope({
          protocol: 'omarchestra.companion/v1',
          type: 'clear',
          session: identity,
        })
        Promise.resolve(this.shell.call(this.pluginId, 'clear', encodeJson(envelope)))
          .catch((error) => this.failSession(error))
      } catch (error) {
        this.failSession(error)
      }
    }
    if (this.phase === 'opening' || this.phase === 'active') {
      this.openGate?.reject(new CompanionIntentError('invalid_projection_state', 'the Projection Session was cleared'))
      this.endSession()
    }
  }

  // --- internals ---

  private onPublished(identity: ProjectionSessionIdentity, handoff: AgentConsoleHandoff): void {
    if (this.activeSession !== identity || this.phase === 'ended') return
    this.userSink?.(handoff)
    try {
      if (!this.summoned) {
        const openEnvelope = validateOpenEnvelope({
          protocol: 'omarchestra.companion/v1',
          ...identity,
          projection: handoff,
        })
        Promise.resolve(this.shell.summon(this.pluginId, encodeJson(openEnvelope)))
          .catch((error) => this.failSession(error))
        this.summoned = true
      }
      const applyEnvelope = validateProjectionApplyEnvelope({
        protocol: 'omarchestra.companion/v1',
        ...identity,
        status: handoff.status,
        cursor: handoff.cursor,
        cards: handoff.cards,
      })
      Promise.resolve(this.shell.call(this.pluginId, 'applyHandoff', encodeJson(applyEnvelope)))
        .catch((error) => this.failSession(error))
      this.openGate?.resolve()
    } catch (error) {
      this.failSession(error)
    }
  }

  private onPreBaselineFailure(identity: ProjectionSessionIdentity, error: unknown): void {
    if (this.activeSession !== identity) return
    this.failSession(error)
  }

  private onIntentAck(
    identity: ProjectionSessionIdentity,
    ack: { intentId: string; result: CompanionIntentResult; detail: string | null },
  ): void {
    if (this.activeSession !== identity) return
    const pending = this.pendingIntents.get(ack.intentId)
    if (pending === undefined) return
    this.pendingIntents.delete(ack.intentId)
    this.completedIntents.add(ack.intentId)
    try {
      const acknowledgement = validateIntentAcknowledgementEnvelope({
        protocol: 'omarchestra.companion/v1',
        type: 'intent_ack',
        session: identity,
        intentId: ack.intentId,
        result: ack.result,
        detail: ack.detail,
      })
      Promise.resolve(this.shell.call(this.pluginId, 'intentResult', encodeJson(acknowledgement)))
        .catch((error) => this.failSession(error))
    } catch (error) {
      this.failSession(error)
    }
    pending.resolve({ intentId: ack.intentId, result: ack.result, detail: ack.detail })
  }

  private failSession(error: unknown): void {
    this.lastErrorMessage = errorMessage(error)
    if (this.phase === 'opening' || this.phase === 'active') {
      this.endSession()
      this.openGate?.reject(error)
    }
  }

  private endSession(): void {
    this.adapter?.stop()
    this.adapter = null
    this.activeSession = null
    this.sharedProjection.clearState()
    for (const [intentId, deferred] of [...this.pendingIntents]) {
      this.pendingIntents.delete(intentId)
      deferred.reject(new CompanionIntentError(
        'invalid_projection_state',
        `the Projection Session ended before intent ${intentId} was acknowledged`,
      ))
    }
    this.phase = 'ended'
  }
}