/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * registry.ts — the Agent Registry for the observer/Adoption milestone. It
 * owns current Observed Pi Sessions over injected clock, transport, and
 * persistence ports. It keeps availability, lifecycle, eligibility, and
 * expiry distinct, enforces registration/reconnect high-water marks, monotonic
 * source sequences, bounded deduplication, and ordered authoritative
 * snapshots/events. On restart it requires fresh registration for current
 * observation.
 *
 * This module performs no I/O and imports neither Adoption nor QML. It consumes
 * the pure observer protocol (`contracts.ts`) and the telemetry allow-list
 * (`telemetry-policy.ts`). The fake clock/persistence/transport are injected.
 */

import {
  OBSERVER_PI_STATUS_LOCAL,
  ObserverError,
  validateObserverClose,
  validateObserverHeartbeat,
  validateObserverLifecycle,
  validateObserverRegister,
  type ObserverActivity,
  type ObserverAvailability,
  type ObserverHealth,
  type ObserverLifecycle,
} from './contracts.ts'
import { buildObservedRecord, type ObservedRecord } from './telemetry-policy.ts'

export const OBSERVER_HEARTBEAT_INTERVAL_MS = 5000
export const OBSERVER_LEASE_DURATION_MS = 15000
export const OBSERVER_MAX_SESSIONS = 64
export const OBSERVER_DEDUP_LIMIT = 256

export interface RegistryClock {
  now(): number
}

export interface RegistryPersistence {
  load(): unknown | null
  save(value: unknown): void
}

/** Trusted port that issues unpredictable capabilities with at least 128 bits. */
export interface RegistryCapabilityIssuer {
  issue(purpose: 'observed' | 'connection' | 'challenge'): string
}

export interface AgentRegistryOptions {
  clock: RegistryClock
  persistence: RegistryPersistence
  capabilityIssuer: RegistryCapabilityIssuer
  executionNodeId: string
}

export interface ObservedSessionAgent {
  observedSessionId: string
  piStatus: typeof OBSERVER_PI_STATUS_LOCAL
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  availability: ObserverAvailability
  health: ObserverHealth
  registryRevision: number
}

export interface ObservedSnapshot {
  observerRevision: number
  agents: ObservedSessionAgent[]
}

export interface RegistryEvent {
  revision: number
  type: 'registered' | 'reconnected' | 'heartbeat' | 'lifecycle' | 'closed' | 'expired'
  observedSessionId: string
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  availability: ObserverAvailability
  health: ObserverHealth
}

interface ObservedSession {
  observedSessionId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connection: object | null
  connectionId: string
  connectionChallenge: string
  acceptedRegistrationAttempt: number
  acceptedSourceSequence: number
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  health: ObserverHealth
  availability: ObserverAvailability
  leaseUntil: number
  registryRevision: number
  dedup: Map<string, { bytes: string; result: ObservedRecord }>
}

interface ExtensionHighWater {
  registrationAttempt: number
  sourceSequence: number
}

export class AgentRegistry {
  private readonly clock: RegistryClock
  private readonly persistence: RegistryPersistence
  private readonly capabilityIssuer: RegistryCapabilityIssuer
  private readonly executionNodeId: string
  private readonly sessions = new Map<string, ObservedSession>()
  private readonly highWater = new Map<string, ExtensionHighWater>()
  private readonly issuedCapabilities = new Set<string>()
  private readonly eventLog: RegistryEvent[] = []
  private registryRevision = 0

  constructor(options: AgentRegistryOptions) {
    this.clock = options.clock
    this.persistence = options.persistence
    this.capabilityIssuer = options.capabilityIssuer
    if (!isBoundedIdentity(options.executionNodeId)) {
      throw new ObserverError('invalid_identity', 'registry Execution Node identity must be a bounded ASCII identity')
    }
    this.executionNodeId = options.executionNodeId
  }

  register(connection: object, body: unknown): Record<string, unknown> {
    const validated = validateObserverRegister(body)
    const key = extensionKey(validated.processIncarnationId, validated.piSessionId, validated.extensionInstanceId)
    const accepted = this.highWater.get(key)
    if (accepted !== undefined) {
      if (validated.registrationAttempt <= accepted.registrationAttempt) {
        throw new ObserverError('stale_registration', 'registration attempt is not greater than the accepted attempt')
      }
      if (validated.sourceSequence <= accepted.sourceSequence) {
        throw new ObserverError('invalid_sequence', 'registration source sequence is not greater than the accepted sequence')
      }
    }

    const existing = this.sessions.get(key)
    if (existing === undefined && this.sessions.size >= OBSERVER_MAX_SESSIONS) {
      throw new ObserverError('session_limit', `registry already holds ${OBSERVER_MAX_SESSIONS} observed sessions`)
    }

    const connectionId = this.issueCapability('connection')
    const connectionChallenge = this.issueCapability('challenge')
    const observedSessionId = existing?.observedSessionId ?? this.issueCapability('observed')
    const revision = this.advanceRevision()
    this.highWater.set(key, {
      registrationAttempt: validated.registrationAttempt,
      sourceSequence: validated.sourceSequence,
    })

    if (existing !== undefined) {
      existing.connection = connection
      existing.connectionId = connectionId
      existing.connectionChallenge = connectionChallenge
      existing.acceptedRegistrationAttempt = validated.registrationAttempt
      existing.acceptedSourceSequence = validated.sourceSequence
      existing.lifecycle = validated.lifecycle
      existing.activity = validated.activity
      existing.health = validated.health
      existing.availability = 'available'
      existing.leaseUntil = this.clock.now() + OBSERVER_LEASE_DURATION_MS
      existing.registryRevision = revision
      this.emit('reconnected', existing)
      return this.registeredEnvelope(existing)
    }

    const session: ObservedSession = {
      observedSessionId,
      processIncarnationId: validated.processIncarnationId,
      piSessionId: validated.piSessionId,
      extensionInstanceId: validated.extensionInstanceId,
      connection,
      connectionId,
      connectionChallenge,
      acceptedRegistrationAttempt: validated.registrationAttempt,
      acceptedSourceSequence: validated.sourceSequence,
      lifecycle: validated.lifecycle,
      activity: validated.activity,
      health: validated.health,
      availability: 'available',
      leaseUntil: this.clock.now() + OBSERVER_LEASE_DURATION_MS,
      registryRevision: revision,
      dedup: new Map(),
    }
    this.sessions.set(key, session)
    this.emit('registered', session)
    return this.registeredEnvelope(session)
  }

  heartbeat(connection: object, body: unknown): ObservedRecord {
    const validated = validateObserverHeartbeat(body)
    const session = this.resolveCurrent(connection, validated.connectionId, validated.connectionChallenge)
    if (validated.sourceSequence <= session.acceptedSourceSequence) {
      throw new ObserverError('invalid_sequence', 'source sequence is not greater than the accepted sequence')
    }
    const changed = session.lifecycle !== validated.lifecycle
      || session.activity !== validated.activity
      || session.health !== validated.health
    const revision = changed ? this.advanceRevision() : session.registryRevision
    session.acceptedSourceSequence = validated.sourceSequence
    session.lifecycle = validated.lifecycle
    session.activity = validated.activity
    session.health = validated.health
    session.leaseUntil = this.clock.now() + OBSERVER_LEASE_DURATION_MS
    this.updateSourceHighWater(session)
    if (changed) {
      session.registryRevision = revision
      this.emit('heartbeat', session)
    }
    return this.recordFor(session)
  }

  lifecycle(connection: object, body: unknown): ObservedRecord {
    const validated = validateObserverLifecycle(body)
    const session = this.resolveCurrent(connection, validated.connectionId, validated.connectionChallenge)

    const cached = session.dedup.get(validated.eventId)
    if (cached !== undefined) {
      const bytes = JSON.stringify(validated)
      if (cached.bytes === bytes) {
        return { ...cached.result }
      }
      throw new ObserverError('message_id_conflict', 'event identity was reused with different bytes')
    }

    if (validated.sourceSequence <= session.acceptedSourceSequence) {
      throw new ObserverError('invalid_sequence', 'source sequence is not greater than the accepted sequence')
    }
    const revision = this.advanceRevision()
    session.acceptedSourceSequence = validated.sourceSequence
    session.lifecycle = validated.lifecycle
    session.activity = validated.activity
    session.health = validated.health
    session.leaseUntil = this.clock.now() + OBSERVER_LEASE_DURATION_MS
    session.registryRevision = revision
    this.updateSourceHighWater(session)
    const result = this.recordFor(session)
    if (session.dedup.size >= OBSERVER_DEDUP_LIMIT) {
      const oldest = session.dedup.keys().next().value
      if (oldest !== undefined) session.dedup.delete(oldest)
    }
    session.dedup.set(validated.eventId, { bytes: JSON.stringify(validated), result: { ...result } })
    this.emit('lifecycle', session)
    return result
  }

  close(connection: object, body: unknown): ObservedRecord {
    const validated = validateObserverClose(body)
    const session = this.resolveCurrent(connection, validated.connectionId, validated.connectionChallenge)
    if (validated.sourceSequence <= session.acceptedSourceSequence) {
      throw new ObserverError('invalid_sequence', 'source sequence is not greater than the accepted sequence')
    }
    const revision = this.advanceRevision()
    session.acceptedSourceSequence = validated.sourceSequence
    session.connection = null
    session.availability = 'unavailable'
    session.registryRevision = revision
    this.updateSourceHighWater(session)
    this.emit('closed', session)
    return this.recordFor(session)
  }

  /** Mark an exact current transport unavailable after an abrupt disconnect. */
  transportClosed(connection: object): ObservedRecord | null {
    const session = [...this.sessions.values()].find((candidate) => candidate.connection === connection)
    if (session === undefined) return null
    const revision = this.advanceRevision()
    session.connection = null
    session.availability = 'unavailable'
    session.registryRevision = revision
    this.emit('closed', session)
    return this.recordFor(session)
  }

  /** Sweep sessions whose lease has expired under the injected monotonic clock. */
  expire(): void {
    const now = this.clock.now()
    for (const [key, session] of this.sessions) {
      if (session.leaseUntil <= now) {
        const revision = this.advanceRevision()
        this.sessions.delete(key)
        session.registryRevision = revision
        this.emit('expired', session)
      }
    }
  }

  snapshot(): ObservedSnapshot {
    return {
      observerRevision: this.registryRevision,
      agents: [...this.sessions.values()].map((session) => ({
        observedSessionId: session.observedSessionId,
        piStatus: OBSERVER_PI_STATUS_LOCAL,
        lifecycle: session.lifecycle,
        activity: session.activity,
        availability: session.availability,
        health: session.health,
        registryRevision: session.registryRevision,
      })),
    }
  }

  events(): RegistryEvent[] {
    return this.eventLog.map((event) => ({ ...event }))
  }

  /** Full authoritative observed record for a current session (Adoption path). */
  getObserved(observedSessionId: string): ObservedRecord | null {
    for (const session of this.sessions.values()) {
      if (session.observedSessionId === observedSessionId) return this.recordFor(session)
    }
    return null
  }

  /** Exact transport/challenge authority check for the Adoption seam. */
  isCurrentConnection(connection: object, connectionId: string, connectionChallenge: string): boolean {
    return [...this.sessions.values()].some(
      (session) => session.connection === connection
        && session.connectionId === connectionId
        && session.connectionChallenge === connectionChallenge,
    )
  }

  /**
   * Restart recovery. Durable committed state may restore the monotonic
   * revision, but observed sessions are NOT current after a restart: they
   * require fresh same-process registration.
   */
  reconstruct(): void {
    const persisted = this.persistence.load()
    if (persisted !== null && typeof persisted === 'object' && 'observerRevision' in (persisted as Record<string, unknown>)) {
      const base = Number((persisted as Record<string, unknown>).observerRevision)
      if (Number.isSafeInteger(base) && base > this.registryRevision) {
        this.registryRevision = base
      }
    }
    this.sessions.clear()
    this.highWater.clear()
    this.eventLog.length = 0
  }

  private registeredEnvelope(session: ObservedSession): Record<string, unknown> {
    return {
      observedSessionId: session.observedSessionId,
      executionNodeId: this.executionNodeId,
      connectionId: session.connectionId,
      connectionChallenge: session.connectionChallenge,
      acceptedRegistrationAttempt: session.acceptedRegistrationAttempt,
      acceptedSourceSequence: session.acceptedSourceSequence,
      heartbeatIntervalMs: OBSERVER_HEARTBEAT_INTERVAL_MS,
      leaseDurationMs: OBSERVER_LEASE_DURATION_MS,
      registryRevision: session.registryRevision,
      piStatus: OBSERVER_PI_STATUS_LOCAL,
    }
  }

  private recordFor(session: ObservedSession): ObservedRecord {
    return buildObservedRecord({
      observedSessionId: session.observedSessionId,
      executionNodeId: this.executionNodeId,
      processIncarnationId: session.processIncarnationId,
      piSessionId: session.piSessionId,
      extensionInstanceId: session.extensionInstanceId,
      lifecycle: session.lifecycle,
      activity: session.activity,
      availability: session.availability,
      health: session.health,
      registryRevision: session.registryRevision,
    })
  }

  private resolveCurrent(connection: object, connectionId: string, connectionChallenge: string): ObservedSession {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.connection === connection
        && candidate.connectionId === connectionId
        && candidate.connectionChallenge === connectionChallenge,
    )
    if (session === undefined) {
      throw new ObserverError('connection_not_current', 'the transport is not a current observed session')
    }
    return session
  }

  private emit(type: RegistryEvent['type'], session: ObservedSession): void {
    if (this.eventLog.length >= 128) this.eventLog.shift()
    this.eventLog.push({
      revision: session.registryRevision,
      type,
      observedSessionId: session.observedSessionId,
      lifecycle: session.lifecycle,
      activity: session.activity,
      availability: session.availability,
      health: session.health,
    })
  }

  private issueCapability(purpose: 'observed' | 'connection' | 'challenge'): string {
    const value = this.capabilityIssuer.issue(purpose)
    if (!isBoundedIdentity(value) || value.length < 32 || this.issuedCapabilities.has(value)) {
      throw new ObserverError('invalid_identity', 'registry capability issuer returned an invalid or reused identity')
    }
    this.issuedCapabilities.add(value)
    return value
  }

  private advanceRevision(): number {
    if (this.registryRevision >= Number.MAX_SAFE_INTEGER) {
      throw new ObserverError('invalid_sequence', 'registry revision is exhausted')
    }
    const revision = this.registryRevision + 1
    this.persistence.save({ observerRevision: revision })
    this.registryRevision = revision
    return revision
  }

  private updateSourceHighWater(session: ObservedSession): void {
    this.highWater.set(
      extensionKey(session.processIncarnationId, session.piSessionId, session.extensionInstanceId),
      {
        registrationAttempt: session.acceptedRegistrationAttempt,
        sourceSequence: session.acceptedSourceSequence,
      },
    )
  }
}

function extensionKey(processIncarnationId: string, piSessionId: string, extensionInstanceId: string): string {
  return `${processIncarnationId}|${piSessionId}|${extensionInstanceId}`
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
