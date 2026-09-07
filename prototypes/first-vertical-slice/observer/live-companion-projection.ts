/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-companion-projection.ts — the narrow Companion 0.3.0 observation
 * publisher. It accepts a narrow shell port exposing only `capabilities` and
 * the standalone observer presentation calls, verifies the exact observer
 * release plus `session.observer`, validates every snapshot with the
 * standalone observer projection validator, and publishes authoritative
 * `Unassigned · observed` snapshots with empty choices.
 *
 * It performs no socket, process, or filesystem I/O and never uses
 * ProjectionSessionManager, submitObserverIntent, observedIntentResult,
 * summon, clear, hide, or any installation/enable/disable/rescan method. A
 * capability or publication failure throws and is isolated by the gateway
 * from the registry and Pi connection.
 */

import {
  COMPANION_OBSERVER_CAPABILITY,
  COMPANION_PLUGIN_ID,
  CompanionCapabilityError,
  CompanionError,
  assertRequiredCapabilities,
  validateCapabilitiesEnvelope,
  type CompanionCapabilitiesEnvelope,
  type MaybePromise,
} from '../companion/contracts.ts'
import {
  validateStandaloneObserverProjectionSnapshot,
  type ObserverProjectionSnapshot,
} from './companion-projection.ts'

/**
 * Canonical observer Companion release version. Mirrors
 * `OBSERVER_COMPANION_RELEASE_VERSION` in `companion/releases.ts`; kept local
 * so this observer-facing module does not reach the packaged release catalog.
 */
export const OBSERVER_COMPANION_RELEASE_VERSION = '0.3.0'

/** The narrow shell surface the observation publisher is allowed to use. */
export type ObserverCompanionShellMethod =
  | 'openObservedAgents'
  | 'applyObservedAgents'
  | 'clearObservedAgents'

export interface ObserverCompanionShellPort {
  capabilities(pluginId: string): MaybePromise<CompanionCapabilitiesEnvelope>
  call(pluginId: string, method: ObserverCompanionShellMethod, payloadJson: string): MaybePromise<void | string>
}

export interface LiveCompanionProjectionOptions {
  shell: ObserverCompanionShellPort
  pluginId?: string
  releaseVersion?: string
}

/**
 * Observation-only Companion publisher. It verifies the exact observer
 * release and capability once, then publishes monotonic authoritative
 * observer projections. Stale revisions are ignored; failures throw and are
 * isolated by the caller.
 */
export class LiveCompanionProjection {
  private readonly shell: ObserverCompanionShellPort
  private readonly pluginId: string
  private readonly releaseVersion: string
  private verified = false
  private lastRevision = -1
  private observerOpened = false
  private operationTail: Promise<void> = Promise.resolve()

  constructor(options: LiveCompanionProjectionOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveCompanionProjection options are required')
    }
    this.shell = requirePort(options.shell, 'shell')
    this.pluginId = options.pluginId ?? COMPANION_PLUGIN_ID
    this.releaseVersion = options.releaseVersion ?? OBSERVER_COMPANION_RELEASE_VERSION
  }

  /** Verify the exact observer release and `session.observer` capability. */
  async verify(): Promise<void> {
    await this.enqueue(async () => {
      await this.verifyUnserialized()
    })
  }

  /**
   * Publish one authoritative observer projection. Validation happens before
   * queueing or shell mutation. The first accepted revision opens the
   * standalone panel, later increasing revisions update it, and a failed
   * shell call leaves both lifecycle and revision state unchanged.
   */
  async publish(projection: unknown): Promise<void> {
    const validated = validateStandaloneObserverProjectionSnapshot(projection)
    await this.enqueue(async () => {
      await this.verifyUnserialized()
      if (validated.observerRevision <= this.lastRevision) return

      const method: ObserverCompanionShellMethod = this.observerOpened
        ? 'applyObservedAgents'
        : 'openObservedAgents'
      await this.shell.call(
        this.pluginId,
        method,
        JSON.stringify({ observerProjection: validated }),
      )
      this.lastRevision = validated.observerRevision
      this.observerOpened = true
    })
  }

  /** Clear only the observer presentation, preserving revision protection. */
  async clearObservedAgents(): Promise<void> {
    await this.enqueue(async () => {
      await this.verifyUnserialized()
      await this.shell.call(this.pluginId, 'clearObservedAgents', '{}')
      this.observerOpened = false
    })
  }

  /** Current accepted observer revision, or -1 before any publish. */
  get acceptedRevision(): number {
    return this.lastRevision
  }

  private async verifyUnserialized(): Promise<void> {
    if (this.verified) return
    const envelope = await this.shell.capabilities(this.pluginId)
    const validated = validateCapabilitiesEnvelope(envelope)
    if (validated.pluginId !== this.pluginId) {
      throw new CompanionError(
        'unsupported_compatibility',
        `Companion plugin identity differs from ${this.pluginId}`,
      )
    }
    if (validated.version !== this.releaseVersion) {
      throw new CompanionError(
        'unsupported_compatibility',
        `Companion version ${validated.version} is not the observer release ${this.releaseVersion}`,
      )
    }
    assertRequiredCapabilities(validated.capabilities)
    if (!validated.capabilities.includes(COMPANION_OBSERVER_CAPABILITY)) {
      throw new CompanionCapabilityError(
        `Companion lacks the observer capability ${COMPANION_OBSERVER_CAPABILITY}`,
      )
    }
    this.verified = true
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation)
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

function requirePort<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new TypeError(`${name} port is required`)
  }
  return value
}

export type { ObserverProjectionSnapshot }
