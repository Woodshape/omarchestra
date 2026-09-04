/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-gateway-core.ts — the injected observation-only gateway. It owns one
 * disposable in-memory AgentRegistry and routes only the observation frames
 * (register, heartbeat, lifecycle, close) plus abrupt disconnect and expiry.
 * It requires `observer.register` first, rejects Adoption and runner frames
 * without mutation, publishes bounded collection projections with empty
 * choices, and isolates Companion publication failures from Pi connections.
 *
 * It performs no socket, process, or filesystem I/O; the transport is
 * injected. The manual Unix-socket layer wires a real socket into this core
 * through the `GatewayConnection` seam.
 */

import { randomBytes } from 'node:crypto'

import {
  OBSERVER_LIMITS,
  ObserverError,
  validateObserverBodyForType,
  type ObserverFrame,
} from './contracts.ts'
import { type ObservedProjection } from './telemetry-policy.ts'
import {
  AgentRegistry,
  type RegistryCapabilityIssuer,
  type RegistryClock,
  type RegistryPersistence,
} from './registry.ts'

/** The transport-facing connection the gateway sends frames back through. */
export interface GatewayConnection {
  send(type: string, messageId: string, body: Record<string, unknown>): void
  close(): void
}

/** The per-connection handle returned to the transport. */
export interface GatewaySession {
  handleFrame(frame: ObserverFrame): void
  transportClosed(error: Error | null): void
}

export interface LiveObserverGatewayOptions {
  clock: RegistryClock
  executionNodeId: string
  persistence?: RegistryPersistence
  capabilityIssuer?: RegistryCapabilityIssuer
  onProjection?: (projection: ObservedProjection) => void
}

interface GatewaySessionState {
  connection: GatewayConnection
  registered: boolean
}

/**
 * Observation-only gateway. It owns exactly one disposable in-memory
 * AgentRegistry and never touches Adoption, managed work, or a live system.
 */
export class LiveObserverGateway {
  private readonly registry: AgentRegistry
  private readonly onProjection: ((projection: ObservedProjection) => void) | null
  private readonly sessions = new Map<GatewayConnection, GatewaySessionState>()
  private messageCounter = 0

  constructor(options: LiveObserverGatewayOptions) {
    this.registry = new AgentRegistry({
      clock: options.clock,
      persistence: options.persistence ?? new InMemoryPersistence(),
      capabilityIssuer: options.capabilityIssuer ?? defaultCapabilityIssuer(),
      executionNodeId: options.executionNodeId,
    })
    this.onProjection = options.onProjection ?? null
  }

  /** Register a new transport connection and return its session handle. */
  accept(connection: GatewayConnection): GatewaySession {
    const session: GatewaySessionState = { connection, registered: false }
    this.sessions.set(connection, session)
    return {
      handleFrame: (frame) => this.handleFrame(connection, frame),
      transportClosed: (error) => this.transportClosed(connection, error),
    }
  }

  /** Current authoritative collection projection (empty choices). */
  snapshot(): ObservedProjection {
    return this.buildProjection()
  }

  /** Expire sessions whose lease has elapsed under the injected clock. */
  sweep(): void {
    this.registry.expire()
    this.publish()
  }

  /** Close every connection and discard all disposable in-memory state. */
  close(): void {
    for (const session of this.sessions.values()) {
      try {
        session.connection.close()
      } catch {
        // Cleanup is best effort and idempotent.
      }
    }
    this.sessions.clear()
    // Discard the disposable in-memory registry state; a fresh gateway run
    // requires fresh same-process registration.
    this.registry.reconstruct()
  }

  private handleFrame(connection: GatewayConnection, frame: ObserverFrame): void {
    const session = this.sessions.get(connection)
    if (session === undefined) return
    try {
      this.dispatch(connection, session, frame)
    } catch (error) {
      this.reject(connection, frame, error)
    }
  }

  private dispatch(connection: GatewayConnection, session: GatewaySessionState, frame: ObserverFrame): void {
    switch (frame.type) {
      case 'observer.register':
        this.handleRegister(connection, session, frame)
        return
      case 'observer.heartbeat':
        this.handleHeartbeat(connection, session, frame)
        return
      case 'observer.lifecycle':
        this.handleLifecycle(connection, session, frame)
        return
      case 'observer.close':
        this.handleClose(connection, session, frame)
        return
      default:
        this.rejectUnsupported(connection, frame)
    }
  }

  private handleRegister(connection: GatewayConnection, session: GatewaySessionState, frame: ObserverFrame): void {
    const body = validateObserverBodyForType(frame.type, frame.body)
    const envelope = this.registry.register(connection, body)
    session.registered = true
    connection.send('observer.registered', this.nextMessageId(), envelope)
    this.publish()
  }

  private handleHeartbeat(connection: GatewayConnection, session: GatewaySessionState, frame: ObserverFrame): void {
    this.assertRegistered(session, 'observer.heartbeat')
    const body = validateObserverBodyForType(frame.type, frame.body)
    this.registry.heartbeat(connection, body)
    this.publish()
  }

  private handleLifecycle(connection: GatewayConnection, session: GatewaySessionState, frame: ObserverFrame): void {
    this.assertRegistered(session, 'observer.lifecycle')
    const body = validateObserverBodyForType(frame.type, frame.body)
    this.registry.lifecycle(connection, body)
    this.publish()
  }

  private handleClose(connection: GatewayConnection, session: GatewaySessionState, frame: ObserverFrame): void {
    this.assertRegistered(session, 'observer.close')
    const body = validateObserverBodyForType(frame.type, frame.body)
    this.registry.close(connection, body)
    this.publish()
  }

  private transportClosed(connection: GatewayConnection, _error: Error | null): void {
    const session = this.sessions.get(connection)
    if (session === undefined) return
    const record = this.registry.transportClosed(connection)
    this.sessions.delete(connection)
    if (record !== null) this.publish()
  }

  private assertRegistered(session: GatewaySessionState, type: string): void {
    if (!session.registered) {
      throw new ObserverError('connection_not_current', `${type} requires a prior observer.register`)
    }
  }

  private rejectUnsupported(connection: GatewayConnection, frame: ObserverFrame): void {
    const adoption = frame.type === 'adoption.ack'
    const code = adoption ? 'unsupported_protocol' : 'invalid_envelope'
    const detail = adoption
      ? 'adoption frames are not supported by the observation-only gateway'
      : `observer frame type ${frame.type} is not a client frame`
    connection.send('observer.rejected', this.nextMessageId(), {
      requestMessageId: frame.messageId,
      code,
      detail,
    })
  }

  private reject(connection: GatewayConnection, frame: ObserverFrame, error: unknown): void {
    const code = error instanceof ObserverError ? error.code : 'invalid_envelope'
    const detail = boundedDetail(error instanceof Error ? error.message : String(error))
    connection.send('observer.rejected', this.nextMessageId(), {
      requestMessageId: frame.messageId,
      code,
      detail,
    })
  }

  private publish(): void {
    if (this.onProjection === null) return
    const projection = this.buildProjection()
    try {
      this.onProjection(projection)
    } catch {
      // Isolate Companion publication failures from Pi connections.
    }
  }

  private buildProjection(): ObservedProjection {
    const snapshot = this.registry.snapshot()
    return {
      observerRevision: snapshot.observerRevision,
      agents: snapshot.agents.map((agent) => ({
        observedSessionId: agent.observedSessionId,
        piStatus: agent.piStatus,
        lifecycle: agent.lifecycle,
        availability: agent.availability,
        health: agent.health,
        choices: [],
      })),
    }
  }

  private nextMessageId(): string {
    this.messageCounter += 1
    return `gateway-${this.messageCounter.toString(16).padStart(32, '0')}`
  }
}

/** Disposable in-memory persistence; never durable across a gateway run. */
class InMemoryPersistence implements RegistryPersistence {
  private state: unknown | null = null

  load(): unknown | null {
    return this.state
  }

  save(value: unknown): void {
    this.state = value
  }
}

function defaultCapabilityIssuer(): RegistryCapabilityIssuer {
  return {
    issue(purpose: 'observed' | 'connection' | 'challenge'): string {
      return `${purpose}-${randomBytes(16).toString('hex')}`
    },
  }
}

function boundedDetail(value: string): string {
  return value.length > OBSERVER_LIMITS.detailCharacters
    ? value.slice(0, OBSERVER_LIMITS.detailCharacters)
    : value
}
