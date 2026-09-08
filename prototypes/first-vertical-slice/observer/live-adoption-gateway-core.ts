/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-adoption-gateway-core.ts — the Adoption-enabled routing core. It owns
 * one disposable AgentRegistry and the LiveAdoptionRunner, and routes the
 * observation frames (register, heartbeat, lifecycle, close), the Adoption
 * acknowledgement, and the challenged managed-recovery handshake through the
 * same composition the manual adapter uses. It leaves `live-gateway-core.ts`
 * observation-only.
 *
 * It performs no socket, process, or filesystem I/O; the transport is
 * injected. The durable store is injected; a disposable in-memory store is
 * used when none is supplied.
 */

import { randomBytes } from 'node:crypto'

import {
  OBSERVER_PI_STATUS_LOCAL,
  ObserverError,
  validateObserverBodyForType,
  type ObserverFrame,
} from './contracts.ts'
import { createInMemoryAdoptionStore } from './live-adoption-store.ts'
import {
  LiveAdoptionRunner,
  type ObservedRecord,
} from './live-adoption-runner.ts'
import {
  AgentRegistry,
  type RegistryCapabilityIssuer,
  type RegistryClock,
  type RegistryPersistence,
} from './registry.ts'
import { ROLES, type Role } from '../src/protocol.ts'

export interface LiveAdoptionGatewayOptions {
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  runner?: LiveAdoptionRunner
  clock?: RegistryClock
  capabilityIssuer?: RegistryCapabilityIssuer
  persistence?: RegistryPersistence
}

export interface GatewaySession {
  handleFrame(frame: { type: string; messageId: string; body: Record<string, unknown> }): Promise<Record<string, unknown> | undefined>
  transportClosed(error: Error | null): void
}

interface GatewaySessionState {
  connection: object
  registered: boolean
  connectionId: string | null
  connectionChallenge: string | null
  acceptedSourceSequence: number
}

/**
 * Adoption-enabled gateway. `accept(connection)` returns a session whose
 * `handleFrame` routes observation frames to the registry and runner, the
 * `adoption.ack` to the runner's same-connection acknowledgement path, and
 * the `adoption.recovery_proof` to the challenged managed-recovery path.
 */
export class LiveAdoptionGatewayCore {
  private readonly runner: LiveAdoptionRunner
  private readonly registry: AgentRegistry
  private readonly executionNodeId: string
  private readonly sessions = new Map<object, GatewaySessionState>()
  private lastCommittedFrameValue: { type: string; body: Record<string, unknown> } | null = null
  private readonly wrappedConnections = new Map<object, object>()
  private messageCounter = 0

  constructor(options: LiveAdoptionGatewayOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveAdoptionGatewayCore options are required')
    }
    const roles = requireRoles(options.roles)
    const clock = options.clock ?? { now: () => Math.floor(performance.now()) }
    this.executionNodeId = options.executionNodeId
    this.registry = new AgentRegistry({
      clock,
      persistence: options.persistence ?? new InMemoryPersistence(),
      capabilityIssuer: options.capabilityIssuer ?? defaultCapabilityIssuer(),
      executionNodeId: options.executionNodeId,
    })
    this.runner = options.runner ?? new LiveAdoptionRunner({
      store: createInMemoryAdoptionStore({
        executionNodeId: options.executionNodeId,
        teamGoalId: options.teamGoalId,
        roles,
      }),
      executionNodeId: options.executionNodeId,
      teamGoalId: options.teamGoalId,
      roles,
      clock,
      observerConnection: {
        id: 'transport-1',
        sendAdoptionRequest: () => {},
        sendAdoptionCommitted: (body) => {
          this.lastCommittedFrameValue = { type: 'adoption.committed', body: cloneRecord(body) }
        },
      },
    })
  }

  /** Register a current observed session on the underlying runner (direct seam). */
  registerObserved(record: ObservedRecord, connection?: object): void {
    if (connection === undefined) {
      this.runner.registerObserved(record)
      return
    }
    const wrapped = this.wrapConnection(connection)
    this.runner.registerObserved(record, wrapped)
  }

  /** Request an Adoption proposal (Companion request_adoption). */
  requestAdoption(observedSessionId: string, choiceId: string): Promise<Record<string, unknown>> {
    return this.runner.requestAdoption(observedSessionId, choiceId)
  }

  /** Confirm the exact proposal (Companion authorize_adoption). */
  authorizeAdoption(proposalId: string, proposalDigest: string): Promise<Record<string, unknown>> {
    return this.runner.authorizeAdoption(proposalId, proposalDigest)
  }

  /** Accept a new observer transport connection and return its session handle. */
  accept(connection: object): GatewaySession {
    const transport = this.wrappedConnections.get(connection) ?? connection
    const session: GatewaySessionState = {
      connection: transport,
      registered: false,
      connectionId: null,
      connectionChallenge: null,
      acceptedSourceSequence: 0,
    }
    if (!this.sessions.has(transport)) this.sessions.set(transport, session)
    return {
      handleFrame: (frame) => this.handleFrame(transport, frame),
      transportClosed: (error) => this.transportClosed(transport, error),
    }
  }

  /** Expire sessions whose lease has elapsed under the injected clock. */
  sweep(): void {
    this.registry.expire()
    this.runner.expire()
  }

  get commitCount(): number {
    return this.runner.commitCount
  }

  get lastCommittedFrame(): { type: string; body: Record<string, unknown> } | null {
    return this.lastCommittedFrameValue
  }

  private async handleFrame(
    connection: object,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(connection)
    if (session === undefined) return undefined
    try {
      this.sweep()
      return await this.dispatch(connection, session, frame)
    } catch (error) {
      this.reject(connection, frame, error)
      return undefined
    }
  }

  private async dispatch(
    connection: object,
    session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): Promise<Record<string, unknown> | undefined> {
    switch (frame.type) {
      case 'observer.register':
        this.handleRegister(connection, session, frame)
        return undefined
      case 'observer.heartbeat':
        this.handleHeartbeat(connection, session, frame)
        return undefined
      case 'observer.lifecycle':
        this.handleLifecycle(connection, session, frame)
        return undefined
      case 'observer.close':
        this.handleClose(connection, session, frame)
        return undefined
      case 'adoption.ack':
        return await this.handleAdoptionAck(connection, session, frame)
      case 'adoption.recovery_proof':
        this.handleRecoveryProof(connection, session, frame)
        return undefined
      default:
        this.rejectUnsupported(connection, frame)
        return undefined
    }
  }

  private handleRegister(
    connection: object,
    session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    if (session.registered) throw new ObserverError('connection_not_current', 'transport is already registered')
    const body = validateObserverBodyForType(frame.type, frame.body)
    // Check the durable binding first. A committed binding must recover
    // through a fresh challenge rather than ordinary registration.
    const binding = {
      executionNodeId: this.executionNodeId,
      processIncarnationId: String(body.processIncarnationId),
      piSessionId: String(body.piSessionId),
      extensionInstanceId: String(body.extensionInstanceId),
    }
    const committed = this.runner.committedByBinding(binding)
    if (committed !== null) {
      const recovery = this.runner.beginRecovery(connection, binding)
      connection.send('adoption.recovery_challenge', this.nextMessageId(), {
        challenge: recovery.challenge,
        committed: committedToBody(recovery.committed),
      })
      return
    }
    const envelope = this.registry.register(connection, body)
    session.registered = true
    session.connectionId = String(envelope.connectionId)
    session.connectionChallenge = String(envelope.connectionChallenge)
    session.acceptedSourceSequence = Number(envelope.acceptedSourceSequence)
    const record = recordFromEnvelope(body, envelope)
    this.runner.registerObserved(record, connection)
    connection.send('observer.registered', this.nextMessageId(), envelope)
  }

  private handleHeartbeat(
    connection: object,
    session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    this.assertRegistered(session, 'observer.heartbeat')
    const body = validateObserverBodyForType(frame.type, frame.body)
    const record = this.registry.heartbeat(connection, body)
    if (Number(body.sourceSequence) > session.acceptedSourceSequence) {
      session.acceptedSourceSequence = Number(body.sourceSequence)
      this.runner.updateObserved(recordFromRegistry(record, session))
    }
  }

  private handleLifecycle(
    connection: object,
    session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    this.assertRegistered(session, 'observer.lifecycle')
    const body = validateObserverBodyForType(frame.type, frame.body)
    const record = this.registry.lifecycle(connection, body)
    // A cached duplicate lifecycle response does not renew the runner lease.
    if (Number(body.sourceSequence) > session.acceptedSourceSequence) {
      session.acceptedSourceSequence = Number(body.sourceSequence)
      this.runner.updateObserved(recordFromRegistry(record, session))
    }
  }

  private handleClose(
    connection: object,
    session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    this.assertRegistered(session, 'observer.close')
    const body = validateObserverBodyForType(frame.type, frame.body)
    this.registry.close(connection, body)
    this.runner.onConnectionLost(connection)
  }

  private async handleAdoptionAck(
    connection: object,
    _session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    return await this.runner.acceptAcknowledgement(connection, frame.body)
  }

  private handleRecoveryProof(
    connection: object,
    _session: GatewaySessionState,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    const body = validateObserverBodyForType(frame.type, frame.body)
    const committed = this.runner.completeRecovery(connection, {
      challenge: String(body.challenge),
      committed: body.committed as Record<string, unknown>,
    })
    connection.send('adoption.committed', this.nextMessageId(), committedToBody(committed))
  }

  private transportClosed(connection: object, _error: Error | null): void {
    const session = this.sessions.get(connection)
    if (session === undefined) return
    this.registry.transportClosed(connection)
    this.sessions.delete(connection)
    this.runner.onConnectionLost(connection)
  }

  private assertRegistered(session: GatewaySessionState, type: string): void {
    if (!session.registered) {
      throw new ObserverError('connection_not_current', `${type} requires a prior observer.register`)
    }
  }

  private rejectUnsupported(
    connection: object,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
  ): void {
    connection.send('observer.rejected', this.nextMessageId(), {
      requestMessageId: frame.messageId,
      code: 'invalid_envelope',
      detail: `observer frame type ${frame.type} is not a client frame`,
    })
  }

  private reject(
    connection: object,
    frame: { type: string; messageId: string; body: Record<string, unknown> },
    error: unknown,
  ): void {
    const code = error instanceof ObserverError ? error.code : 'invalid_envelope'
    const detail = boundedDetail(error instanceof Error ? error.message : String(error))
    connection.send('observer.rejected', this.nextMessageId(), {
      requestMessageId: frame.messageId,
      code,
      detail,
    })
  }

  private wrapConnection(connection: object): object {
    const existing = this.wrappedConnections.get(connection)
    if (existing !== undefined) return existing
    const wrapped = {
      ...connection,
      send: (type: string, messageId: string, body: Record<string, unknown>) => {
        if (type === 'adoption.committed') {
          this.lastCommittedFrameValue = { type, body: cloneRecord(body) }
        }
        const sender = (connection as { send?: (t: string, m: string, b: Record<string, unknown>) => void }).send
        if (typeof sender === 'function') sender.call(connection, type, messageId, body)
      },
    }
    this.wrappedConnections.set(connection, wrapped)
    return wrapped
  }

  private nextMessageId(): string {
    this.messageCounter += 1
    return `gateway-${this.messageCounter.toString(16).padStart(32, '0')}`
  }
}

function recordFromEnvelope(
  body: Record<string, unknown>,
  envelope: Record<string, unknown>,
): ObservedRecord {
  return {
    observedSessionId: String(envelope.observedSessionId),
    executionNodeId: String(envelope.executionNodeId),
    processIncarnationId: String(body.processIncarnationId),
    piSessionId: String(body.piSessionId),
    extensionInstanceId: String(body.extensionInstanceId),
    connectionId: String(envelope.connectionId),
    connectionChallenge: String(envelope.connectionChallenge),
    registryRevision: Number(envelope.registryRevision),
    lifecycle: String(body.lifecycle) as ObservedRecord['lifecycle'],
    activity: String(body.activity) as ObservedRecord['activity'],
    availability: 'available',
    health: String(body.health) as ObservedRecord['health'],
    piStatus: OBSERVER_PI_STATUS_LOCAL,
    acceptedSourceSequence: Number(envelope.acceptedSourceSequence),
  }
}

function recordFromRegistry(
  record: Record<string, unknown>,
  session: GatewaySessionState,
): ObservedRecord {
  return {
    observedSessionId: String(record.observedSessionId),
    executionNodeId: String(record.executionNodeId),
    processIncarnationId: String(record.processIncarnationId),
    piSessionId: String(record.piSessionId),
    extensionInstanceId: String(record.extensionInstanceId),
    connectionId: session.connectionId ?? '',
    connectionChallenge: session.connectionChallenge ?? '',
    registryRevision: Number(record.registryRevision),
    lifecycle: String(record.lifecycle) as ObservedRecord['lifecycle'],
    activity: String(record.activity) as ObservedRecord['activity'],
    availability: String(record.availability) as ObservedRecord['availability'],
    health: String(record.health) as ObservedRecord['health'],
    piStatus: OBSERVER_PI_STATUS_LOCAL,
    acceptedSourceSequence: session.acceptedSourceSequence,
  }
}

function committedToBody(committed: Record<string, unknown>): Record<string, unknown> {
  return {
    proposalId: String(committed.proposalId),
    proposalDigest: String(committed.proposalDigest),
    agentRunId: String(committed.agentRunId),
    targetTeamGoalId: String(committed.targetTeamGoalId),
    targetRole: String(committed.targetRole),
    controlMode: 'managed',
    piStatus: String(committed.piStatus),
    terminalTitleMetadata: String(committed.terminalTitleMetadata),
    runtimeBindingGuarantee: 'unavailable',
  }
}

function requireRoles(input: unknown): Role[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 3) {
    throw new TypeError('roles must be a bounded non-empty array')
  }
  for (const role of input) {
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      throw new TypeError('roles must contain only allowed Roles')
    }
  }
  return [...input] as Role[]
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}

function boundedDetail(value: string): string {
  return value.length > 1024 ? value.slice(0, 1024) : value
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
