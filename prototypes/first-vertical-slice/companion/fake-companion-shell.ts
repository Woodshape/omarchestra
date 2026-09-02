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
  type CompanionShellPort,
} from './contracts.ts'

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
  method?: 'applyHandoff' | 'clear' | 'intentResult'
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
    visible: boolean
    cleared: boolean
    handoffs: Array<Record<string, unknown>>
    intentResults: Array<Record<string, unknown>>
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

  constructor(options: FakeCompanionShellOptions = {}) {
    this.pluginId = options.pluginId ?? COMPANION_PLUGIN_ID
    this.version = options.version ?? COMPANION_PLUGIN_VERSION
    this.protocol = options.protocol ?? COMPANION_PROTOCOL_ID
    this.declaredCapabilities = [...(options.capabilities ?? [])]
    this.installed = options.installed ?? true
    this.generation = 1
    this.panel = { visible: false, cleared: false, handoffs: [], intentResults: [] }
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
    this.records.push({ operation: 'summon', pluginId, payloadJson })
    this.panel.visible = true
    this.panel.cleared = false
    this.panel.handoffs.push(plainHandoff(envelope.projection))
  }

  call(
    pluginId: string,
    method: 'applyHandoff' | 'clear' | 'intentResult',
    payloadJson: string,
  ): void {
    this.assertKnownPlugin(pluginId)
    const body: unknown = JSON.parse(payloadJson)
    if (method === 'applyHandoff') {
      const envelope = validateProjectionApplyEnvelope(body)
      assertPluginGeneration(this.generation, envelope.pluginGeneration)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.handoffs.push(plainHandoff({
        status: envelope.status,
        cursor: envelope.cursor,
        cards: envelope.cards,
      }))
      return
    }
    if (method === 'clear') {
      const envelope = validateClearEnvelope(body)
      assertPluginGeneration(this.generation, envelope.session.pluginGeneration)
      this.records.push({ operation: 'call', pluginId, method, payloadJson })
      this.panel.cleared = true
      this.panel.handoffs = []
      return
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
    throw new CompanionError('invalid_envelope', `unsupported plugin call method ${String(method)}`)
  }

  hide(pluginId: string, payloadJson: string): void {
    this.assertKnownPlugin(pluginId)
    const envelope = validateHideEnvelope(JSON.parse(payloadJson))
    assertPluginGeneration(this.generation, envelope.session.pluginGeneration)
    this.records.push({ operation: 'hide', pluginId, payloadJson })
    this.panel.visible = false
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
    this.panel.cleared = false
    this.panel.handoffs = []
    this.panel.intentResults = []
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

  private assertKnownPlugin(pluginId: string): void {
    if (pluginId !== this.pluginId) {
      throw new CompanionPluginUnavailableError(`plugin ${pluginId} is not installed in the fake shell`)
    }
  }
}

function plainHandoff(value: { status: string; cursor: number; cards: Array<Record<string, unknown>> }): Record<string, unknown> {
  return { status: value.status, cursor: value.cursor, cards: value.cards.map((card) => ({ ...card })) }
}