/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake of the installed Omarchy shell hosting the explicitly installed
 * Omarchestra Companion Plugin. It implements the same `CompanionShellPort`
 * the routine Projection Session lifecycle consumes, models the installed
 * plugin panel (summon / applyHandoff / intentResult / clear / hide), tracks
 * the plugin generation across simulated reloads, and records an
 * installation mutation log plus installation fingerprint so tests can prove
 * that routine session operations never mutate installation state.
 *
 * This fake performs no I/O, launches nothing, and models only the bounded
 * runtime surface documented in docs/companion-plugin-v1.md. Installation
 * itself belongs to the separate installation seam and its own fake Omarchy
 * adapters; this module never reaches it.
 */

import {
  COMPANION_PLUGIN_ID,
  COMPANION_PLUGIN_VERSION,
  COMPANION_PROTOCOL_ID,
  CompanionError,
  CompanionPluginUnavailableError,
  StalePluginGenerationError,
  assertPluginGeneration,
  validateCapabilitiesEnvelope,
  validateClearEnvelope,
  validateHideEnvelope,
  validateIntentAcknowledgementEnvelope,
  validateOpenEnvelope,
  validateProjectionApplyEnvelope,
  type CompanionCapabilitiesEnvelope,
  type CompanionShellCallMethod,
  type CompanionShellPort,
} from './contracts.ts'
import {
  validateObserverProjectionSnapshot,
  validateStandaloneObserverProjectionSnapshot,
  type ObserverProjectionSnapshot,
} from '../observer/companion-projection.ts'

export interface FakeCompanionShellOptions {
  pluginId?: string
  version?: string
  protocol?: string
  capabilities?: readonly string[]
  installed?: boolean
}

export type FakeShellOperation = 'capabilities' | 'summon' | 'call' | 'hide'

export interface FakeCompanionShellCall {
  operation: FakeShellOperation
  pluginId: string
  method?: CompanionShellCallMethod
  payloadJson?: string
}

const MODELED_SHELL_JSON_BYTES = JSON.stringify({
  plugins: { [COMPANION_PLUGIN_ID]: { enabled: true, source: 'user' } },
})

const MODELED_RECEIPT_BYTES = JSON.stringify({ schemaVersion: 1, pluginId: COMPANION_PLUGIN_ID })

/**
 * Fake of the installed Omarchy shell surface for the Companion Plugin. The
 * panel state is a plain presentation model: it stores only validated plain
 * handoffs and intent results, exactly like the presentation-only QML panel.
 */
export class FakeCompanionShell implements CompanionShellPort {
  readonly panel: {
    /** Aggregate panel visibility, matching the QML derived visibility. */
    visible: boolean
    /** Managed lifecycle keeps its surface visible after managed clear. */
    managedVisible: boolean
    /** Current managed Projection Session identity, if one is open. */
    managedSession: Record<string, unknown> | null
    /** Current managed projection, cards, and cursor are separate state. */
    managedProjection: Record<string, unknown> | null
    managedCards: Array<Record<string, unknown>>
    managedCursor: number | null
    cleared: boolean
    handoffs: Array<Record<string, unknown>>
    intentResults: Array<Record<string, unknown>>
    /** Observer lifecycle state is independent from all managed fields. */
    observerOpen: boolean
    observerProjection: ObserverProjectionSnapshot
    observerProjections: Array<Record<string, unknown>>
  }

  private readonly pluginId: string
  private version: string
  private protocol: string
  private declaredCapabilities: string[]
  private installed: boolean
  private generation: number
  private readonly records: FakeCompanionShellCall[] = []
  private readonly mutations: Array<Record<string, unknown>> = []
  private readonly installationSnapshot: Record<string, unknown>
  private holdDepth = 0
  private readonly holdWaiters: Array<() => void> = []
  private readonly presentationIntents: Array<Record<string, unknown>> = []

  constructor(options: FakeCompanionShellOptions = {}) {
    this.pluginId = options.pluginId ?? COMPANION_PLUGIN_ID
    this.version = options.version ?? COMPANION_PLUGIN_VERSION
    this.protocol = options.protocol ?? COMPANION_PROTOCOL_ID
    this.declaredCapabilities = [...(options.capabilities ?? [])]
    this.installed = options.installed ?? true
    this.generation = 1
    this.panel = {
      visible: false,
      managedVisible: false,
      managedSession: null,
      managedProjection: null,
      managedCards: [],
      managedCursor: null,
      cleared: false,
      handoffs: [],
      intentResults: [],
      observerOpen: false,
      observerProjection: cloneObserverProjection({ observerRevision: 0, agents: [] }),
      observerProjections: [],
    }
    this.installationSnapshot = {
      pluginId: this.pluginId,
      version: this.version,
      protocol: this.protocol,
      capabilities: [...this.declaredCapabilities],
      shellJsonBytes: MODELED_SHELL_JSON_BYTES,
      receiptBytes: MODELED_RECEIPT_BYTES,
    }
  }

  // --- CompanionShellPort ---

  capabilities(pluginId: string): CompanionCapabilitiesEnvelope | Promise<CompanionCapabilitiesEnvelope> {
    this.assertKnownPlugin(pluginId)
    if (!this.installed) {
      throw new CompanionPluginUnavailableError(`plugin ${pluginId} is not installed in the fake shell`)
    }
    const envelope = validateCapabilitiesEnvelope({
      protocol: this.protocol,
      pluginId: this.pluginId,
      version: this.version,
      pluginGeneration: this.generation,
      capabilities: [...this.declaredCapabilities],
    })
    this.records.push({ operation: 'capabilities', pluginId })
    if (this.holdDepth > 0) {
      return new Promise<void>((resolveHold) => this.holdWaiters.push(resolveHold)).then(() => envelope)
    }
    return envelope
  }

  summon(pluginId: string, payloadJson: string): void {
    this.assertKnownPlugin(pluginId)
    const envelope = validateOpenEnvelope(JSON.parse(payloadJson))
    assertPluginGeneration(this.generation, envelope.pluginGeneration)
    const handoff = plainHandoff(envelope.projection)
    this.records.push({ operation: 'summon', pluginId, payloadJson })
    this.panel.managedVisible = true
    this.panel.visible = true
    this.panel.cleared = false
    this.panel.managedSession = {
      sessionId: envelope.sessionId,
      teamGoalId: envelope.teamGoalId,
      clientId: envelope.clientId,
      sessionGeneration: envelope.sessionGeneration,
      pluginGeneration: envelope.pluginGeneration,
    }
    this.setManagedProjection(handoff)
    this.panel.handoffs.push(handoff)
  }

  call(
    pluginId: string,
    method: CompanionShellCallMethod,
    payloadJson: string,
  ): void | string {
    this.assertKnownPlugin(pluginId)
    const body: unknown = JSON.parse(payloadJson)
    if (method === 'applyHandoff') {
      const envelope = validateProjectionApplyEnvelope(body)
      assertPluginGeneration(this.generation, envelope.pluginGeneration)
      const handoff = plainHandoff({
        status: envelope.status,
        cursor: envelope.cursor,
        cards: envelope.cards,
      })
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.setManagedProjection(handoff)
      this.panel.handoffs.push(handoff)
      return
    }
    if (method === 'clear') {
      const envelope = validateClearEnvelope(body)
      assertPluginGeneration(this.generation, envelope.session.pluginGeneration)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.cleared = true
      this.panel.handoffs = []
      this.panel.managedSession = null
      this.panel.managedProjection = null
      this.panel.managedCards = []
      this.panel.managedCursor = null
      // Managed clear preserves the existing managed panel visibility.
      return
    }
    if (method === 'takeIntent') {
      const envelope = body as { session?: unknown }
      const sessionEnvelope = validateHideEnvelope({
        protocol: COMPANION_PROTOCOL_ID,
        type: 'hide',
        session: envelope.session,
      })
      assertPluginGeneration(this.generation, sessionEnvelope.session.pluginGeneration)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      const intent = this.presentationIntents.shift()
      return intent === undefined ? '' : JSON.stringify(intent)
    }
    if (method === 'intentResult') {
      const envelope = validateIntentAcknowledgementEnvelope(body)
      assertPluginGeneration(this.generation, envelope.session.pluginGeneration)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.intentResults.push({
        intentId: envelope.intentId,
        result: envelope.result,
        detail: envelope.detail,
      })
      return
    }
    if (method === 'openObservedAgents') {
      // Validate before recording or mutating any presentation state. An
      // invalid observer open is indistinguishable from no open to callers.
      const projection = observerProjectionFromPayload(body, true, true)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.observerOpen = true
      this.panel.observerProjection = cloneObserverProjection(projection)
      this.panel.observerProjections.push(cloneObserverProjection(projection) as unknown as Record<string, unknown>)
      this.panel.visible = true
      return 'true'
    }
    if (method === 'applyObservedAgents') {
      const value = body as Record<string, unknown>
      const managedObserverUpdate = body !== null
        && typeof body === 'object'
        && !Array.isArray(body)
        && Object.hasOwn(value, 'session')
      if (managedObserverUpdate && !sameManagedSession(value.session, this.panel.managedSession)) {
        throw new CompanionError('stale_projection_session', 'observer update session is not current')
      }
      const projection = observerProjectionFromPayload(
        body,
        false,
        !managedObserverUpdate,
        managedObserverUpdate,
      )
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.observerProjection = cloneObserverProjection(projection)
      this.panel.observerProjections.push(cloneObserverProjection(projection) as unknown as Record<string, unknown>)
      // This is deliberately non-opening. Visibility remains whatever the
      // managed or explicit observer lifecycle already established.
      return 'true'
    }
    if (method === 'clearObservedAgents') {
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.observerOpen = false
      this.panel.observerProjection = cloneObserverProjection({ observerRevision: 0, agents: [] })
      // Observer clear can never collapse an existing managed panel.
      this.panel.visible = this.panel.managedVisible
      return 'true'
    }
    throw new CompanionError('invalid_envelope', `unsupported plugin call method ${String(method)}`)
  }

  hide(pluginId: string, payloadJson: string): void {
    this.assertKnownPlugin(pluginId)
    const envelope = validateHideEnvelope(JSON.parse(payloadJson))
    assertPluginGeneration(this.generation, envelope.session.pluginGeneration)
    this.records.push({ operation: 'hide', pluginId, payloadJson })
    this.panel.managedVisible = false
    this.panel.managedSession = null
    this.panel.managedProjection = null
    this.panel.managedCards = []
    this.panel.managedCursor = null
    this.panel.visible = this.panel.observerOpen
  }

  // --- Test surface ---

  calls(): FakeCompanionShellCall[] {
    return this.records.map((record) => ({ ...record }))
  }

  mutationLog(): Array<Record<string, unknown>> {
    return this.mutations.map((mutation) => ({ ...mutation }))
  }

  installationFingerprint(): string {
    return JSON.stringify(this.installationSnapshot)
  }

  currentGeneration(): number {
    return this.generation
  }

  /** Simulate Omarchy reloading the installed plugin: a fresh generation. */
  reloadPlugin(): void {
    this.generation += 1
    this.panel.visible = false
    this.panel.managedVisible = false
    this.panel.managedSession = null
    this.panel.managedProjection = null
    this.panel.managedCards = []
    this.panel.managedCursor = null
    this.panel.cleared = false
    this.panel.handoffs = []
    this.panel.intentResults = []
    this.panel.observerOpen = false
    this.panel.observerProjection = cloneObserverProjection({ observerRevision: 0, agents: [] })
    this.panel.observerProjections = []
  }

  setProtocol(protocol: string): void {
    this.protocol = protocol
  }

  setCapabilities(capabilities: readonly string[]): void {
    this.declaredCapabilities = [...capabilities]
  }

  setInstalled(installed: boolean): void {
    this.installed = installed
  }

  queuePresentationIntent(intent: {
    intentId: string
    kind: 'present_agent'
    role: string
    payload?: Record<string, unknown>
  }): void {
    this.presentationIntents.push({ ...intent })
  }

  /**
   * Holds every capability discovery response until releaseCapabilities is
   * called, so tests can observe the exact ordering between discovery and
   * the first runner connection.
   */
  holdCapabilities(): void {
    this.holdDepth += 1
  }

  releaseCapabilities(): void {
    if (this.holdDepth === 0) return
    this.holdDepth -= 1
    if (this.holdDepth === 0) {
      const waiters = [...this.holdWaiters]
      this.holdWaiters.length = 0
      for (const resolveHold of waiters) resolveHold()
    }
  }

  private setManagedProjection(value: Record<string, unknown>): void {
    const cards = Array.isArray(value.cards)
      ? value.cards.map((card) => ({ ...(card as Record<string, unknown>) }))
      : []
    this.panel.managedProjection = {
      ...value,
      cards,
    }
    this.panel.managedCards = cards.map((card) => ({ ...card }))
    this.panel.managedCursor = typeof value.cursor === 'number' ? value.cursor : null
  }

  private assertKnownPlugin(pluginId: string): void {
    if (pluginId !== this.pluginId) {
      throw new CompanionPluginUnavailableError(`plugin ${pluginId} is not installed in the fake shell`)
    }
  }
}

function plainHandoff(value: { status: string; cursor: number; cards: Array<Record<string, unknown>> }): Record<string, unknown> {
  return { status: value.status, cursor: value.cursor, cards: value.cards.map((card) => ({ ...card })) }
}

function cloneObserverProjection(value: ObserverProjectionSnapshot): ObserverProjectionSnapshot {
  return {
    observerRevision: value.observerRevision,
    agents: value.agents.map((agent) => ({
      observedSessionId: agent.observedSessionId,
      piStatus: agent.piStatus,
      lifecycle: agent.lifecycle,
      availability: agent.availability,
      health: agent.health,
      choices: agent.choices.map((choice) => ({ ...choice })),
    })),
  }
}

/**
 * Extract and validate an observer payload. `openObservedAgents` requires the
 * exact sessionless `{ observerProjection }` wrapper and empty choices.
 * Updates retain older projection/direct-object compatibility; only an exact
 * current managed session may carry the existing opaque Adoption choices.
 */
function observerProjectionFromPayload(
  body: unknown,
  requireWrapper: boolean,
  requireEmptyChoices: boolean,
  allowManagedSession = false,
): ObserverProjectionSnapshot {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CompanionError('invalid_envelope', 'observer payload must be an object')
  }
  const value = body as Record<string, unknown>
  if (Object.hasOwn(value, 'session') && !allowManagedSession) {
    throw new CompanionError('invalid_envelope', 'observer payload must be sessionless')
  }

  let projection: unknown
  if (requireWrapper) {
    const fields = Object.keys(value)
    if (fields.length !== 1 || fields[0] !== 'observerProjection') {
      throw new CompanionError(
        'invalid_envelope',
        'openObservedAgents payload must contain exactly observerProjection',
      )
    }
    projection = value.observerProjection
  } else {
    projection = value.observerProjection !== undefined
      ? value.observerProjection
      : value.projection !== undefined
        ? value.projection
        : value
  }

  return requireEmptyChoices
    ? validateStandaloneObserverProjectionSnapshot(projection)
    : validateObserverProjectionSnapshot(projection)
}

function sameManagedSession(
  candidate: unknown,
  current: Record<string, unknown> | null,
): boolean {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) || current === null) {
    return false
  }
  const value = candidate as Record<string, unknown>
  return value.sessionId === current.sessionId
    && value.teamGoalId === current.teamGoalId
    && value.clientId === current.clientId
    && value.sessionGeneration === current.sessionGeneration
    && value.pluginGeneration === current.pluginGeneration
}
