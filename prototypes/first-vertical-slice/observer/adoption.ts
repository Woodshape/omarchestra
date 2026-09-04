/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * The Adoption coordinator is the only observer-to-managed transition in this
 * slice. It accepts only current registry data, an exact local target, one
 * explicit authorization, and an acknowledgement from the same connection
 * that received the request. The Team Runner owns the one durable commit.
 *
 * This module performs no I/O and imports neither QML nor SQLite. All ports
 * are injected and are expected to be in-memory in automated validation.
 */

import { createHash, randomBytes } from 'node:crypto'

import {
  OBSERVER_PI_STATUS_LOCAL,
  ObserverError,
  validateAdoptionAck,
  validateAdoptionCommitted,
  validateAdoptionRequestAck,
  type AdoptionAckBody,
  type AdoptionCommittedBody,
  type AdoptionRequestAckBody,
  type ObserverActivity,
} from './contracts.ts'
import { ROLES, isBoundedId, type Role } from '../src/protocol.ts'

export const ADOPTION_PROPOSAL_TTL_MS = 30_000
export const ADOPTION_ACK_TIMEOUT_MS = 5_000
export const ADOPTION_IDEMPOTENCY_LIMIT = 256
export const ADOPTION_EVENT_LIMIT = 256

const IDENTITY_FIELDS = [
  'observedSessionId',
  'executionNodeId',
  'processIncarnationId',
  'piSessionId',
  'extensionInstanceId',
] as const

type IdentityField = (typeof IDENTITY_FIELDS)[number]

export interface AdoptionProposal {
  proposalId: string
  proposalDigest: string
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connectionId: string
  connectionChallenge: string
  registryRevision: number
  targetTeamGoalId: string
  targetExecutionNodeId: string
  targetRole: Role
  createdMonotonic: number
  expiresMonotonic: number
  acknowledgementNonce: string
}

export interface AdoptionRequest {
  observedSessionId: string
  observedIdentity: Record<string, unknown>
  connection: {
    id: string
    connectionId: string
    connectionChallenge: string
  }
  target: {
    teamGoalId: string
    executionNodeId: string
    role: Role
  }
}

export interface AdoptionAuthorization {
  proposalId: string
  proposalDigest: string
  targetTeamGoalId: string
  targetRole: Role
  authorizationId: string
  token: string
}

export interface AdoptionClock {
  now(): number
}

export interface AdoptionRegistryPort {
  getObserved?(observedSessionId: string): unknown | Promise<unknown>
  currentObservedSession?(observedSessionId: string): unknown | Promise<unknown>
  getObservedSession?(observedSessionId: string): unknown | Promise<unknown>
  currentRevision?(): number | Promise<number>
  isLocalTeamGoal?(teamGoalId: string, executionNodeId: string): boolean | Promise<boolean>
  isRoleOccupied?(teamGoalId: string, role: Role): boolean | Promise<boolean>
  isAlreadyManaged?(observedSessionId: string): boolean | Promise<boolean>
  isCurrentConnection?(
    connection: object,
    connectionId: string,
    connectionChallenge: string,
  ): boolean | Promise<boolean>
  assertCurrentConnection?(
    connection: object,
    connectionId: string,
    connectionChallenge: string,
  ): void | Promise<void>
}

export interface AdoptionObserverConnection {
  readonly id?: unknown
  sendAdoptionRequest?(body: Record<string, unknown>): void | Promise<void>
  sendAdoptionCommitted?(body: Record<string, unknown>): void | Promise<void>
  send?(type: string, messageId: string, body: Record<string, unknown>): void | Promise<void>
  close?(): void | Promise<void>
}

export interface AdoptionAuthorizationPort {
  verify(
    proposal: Record<string, unknown>,
    authorization: Record<string, unknown>,
  ): boolean | void | Promise<boolean | void>
}

export interface AdoptionTeamRunnerPort {
  commitAdoption(input: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface AdoptionPresentationPort {
  applyCommitted(update: Record<string, unknown>): void | Promise<void>
}

/** Deliberately no dispatch method is called by this coordinator. */
export interface AdoptionDispatchPort {
  dispatch?(value: Record<string, unknown>): void | Promise<void>
}

export interface AdoptionIdIssuer {
  issue(purpose: string): string
}

export interface AdoptionCoordinatorOptions {
  clock: AdoptionClock
  registry: AdoptionRegistryPort
  authorizer?: AdoptionAuthorizationPort
  authorization?: AdoptionAuthorizationPort
  teamRunner: AdoptionTeamRunnerPort
  transaction?: AdoptionTeamRunnerPort
  presentation: AdoptionPresentationPort
  observerConnection?: AdoptionObserverConnection
  dispatch?: AdoptionDispatchPort
  idIssuer?: AdoptionIdIssuer
  capabilityIssuer?: AdoptionIdIssuer
  proposalIdFactory?: () => string
  acknowledgementNonceFactory?: () => string
}

export type AdoptionPhase =
  | 'proposed'
  | 'authorized'
  | 'same_process_acknowledged'
  | 'reconciled'
  | 'committed'
  | 'failed'

export interface AdoptionEvent {
  sequence: number
  phase: AdoptionPhase
  proposalId: string
  observedSessionId: string
}

interface InternalProposal {
  readonly proposal: AdoptionProposal
  readonly connection: object
  authorization: AdoptionAuthorization | null
  ackRequest: AdoptionRequestAckBody | null
  readonly createdMonotonic: number
  readonly expiresMonotonic: number
  readonly acknowledgementNonce: string
  phase: AdoptionPhase
  acknowledgementDeadline: number | null
  acknowledgement: AdoptionAckBody | null
  reconciliation: { activity: 'idle'; sourceSequence: number } | null
}

interface CompletedAdoption {
  readonly proposal: AdoptionProposal
  readonly connection: object
  readonly acknowledgement: AdoptionAckBody
  readonly result: Record<string, unknown>
  presented: boolean
  committedDelivered: boolean
}

interface LocalIdIssuer extends AdoptionIdIssuer {
  issue(purpose: string): string
}

class DefaultIdIssuer implements LocalIdIssuer {
  issue(purpose: string): string {
    if (!isBoundedId(purpose)) throw new TypeError('Adoption ID purpose must be bounded')
    return `${purpose}-${randomBytes(16).toString('hex')}`
  }
}

/**
 * Explicit Adoption state machine. Public proposal and result values are
 * cloned/frozen at the boundary. Internal connection objects and tokens never
 * enter those values or the bounded phase log.
 */
export class AdoptionCoordinator {
  private readonly clock: AdoptionClock
  private readonly registry: AdoptionRegistryPort
  private readonly authorizer: AdoptionAuthorizationPort
  private readonly teamRunner: AdoptionTeamRunnerPort
  private readonly presentation: AdoptionPresentationPort
  private readonly observerConnection: AdoptionObserverConnection | null
  private readonly idIssuer: AdoptionIdIssuer
  private readonly proposalIdFactory: (() => string) | null
  private readonly acknowledgementNonceFactory: (() => string) | null

  private readonly pendingBySession = new Map<string, InternalProposal>()
  private readonly pendingById = new Map<string, InternalProposal>()
  private readonly completedById = new Map<string, CompletedAdoption>()
  private readonly completedOrder: string[] = []
  private readonly usedAuthorizationIds = new Set<string>()
  private commitTail: Promise<void> = Promise.resolve()
  private readonly usedAuthorizationOrder: string[] = []
  private readonly reservedAuthorizationIds = new Set<string>()
  private readonly issuedIds = new Set<string>()
  private readonly eventLog: AdoptionEvent[] = []
  private readonly locks = new Map<string, Promise<void>>()
  private eventSequence = 0

  constructor(options: AdoptionCoordinatorOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Adoption coordinator options are required')
    }
    this.clock = requireClock(options.clock)
    this.registry = requirePort(options.registry, 'registry')
    this.authorizer = requirePort(options.authorizer ?? options.authorization, 'authorization')
    this.teamRunner = requirePort(options.teamRunner ?? options.transaction, 'team runner')
    this.presentation = requirePort(options.presentation, 'presentation')
    this.observerConnection = options.observerConnection ?? null
    this.idIssuer = options.idIssuer ?? options.capabilityIssuer ?? new DefaultIdIssuer()
    this.proposalIdFactory = options.proposalIdFactory ?? null
    this.acknowledgementNonceFactory = options.acknowledgementNonceFactory ?? null
  }

  async createProposal(input: unknown): Promise<Record<string, unknown>> {
    const observedSessionId = maybeObservedSessionId(input)
    return this.withSessionLock(observedSessionId ?? '__invalid__', async () => {
      const request = parseAdoptionRequest(input)
      const current = await this.currentObserved(request.observedSessionId)
      if (current === null) fail('session_unknown', 'the observed session is not current')

      const identity = validateRequestIdentity(request)
      assertIdentityMatchesRecord(identity, current)
      const currentConnection = this.observerConnection ?? request.connection
      if (currentConnection.id !== undefined && currentConnection.id !== request.connection.id) {
        fail('connection_not_current', 'the observer connection identity is not current')
      }
      await this.assertConnectionCurrent(
        request.connection.connectionId,
        currentConnection,
        request.connection.connectionChallenge,
        current,
      )
      await this.assertEligibility(current, request.target, request.observedSessionId, true)

      if (this.pendingBySession.has(request.observedSessionId)) {
        fail('proposal_conflict', 'an Adoption proposal is already pending for this observed session')
      }

      const createdMonotonic = this.clock.now()
      const expiresMonotonic = addDeadline(createdMonotonic, ADOPTION_PROPOSAL_TTL_MS)
      const proposalId = this.issueId('proposal', this.proposalIdFactory)
      const acknowledgementNonce = this.issueId('acknowledgement', this.acknowledgementNonceFactory)
      const withoutDigest = {
        proposalId,
        observedSessionId: identity.observedSessionId,
        executionNodeId: identity.executionNodeId,
        processIncarnationId: identity.processIncarnationId,
        piSessionId: identity.piSessionId,
        extensionInstanceId: identity.extensionInstanceId,
        connectionId: request.connection.connectionId,
        connectionChallenge: request.connection.connectionChallenge,
        registryRevision: requireRevision(current.registryRevision),
        targetTeamGoalId: request.target.teamGoalId,
        targetExecutionNodeId: request.target.executionNodeId,
        targetRole: request.target.role,
        createdMonotonic,
        expiresMonotonic,
        acknowledgementNonce,
      }
      const proposal = freeze({
        ...withoutDigest,
        proposalDigest: digestProposal(withoutDigest),
      }) as AdoptionProposal
      const internal: InternalProposal = {
        proposal,
        connection: this.observerConnection ?? request.connection,
        authorization: null,
        ackRequest: null,
        createdMonotonic,
        expiresMonotonic,
        acknowledgementNonce,
        phase: 'proposed',
        acknowledgementDeadline: null,
        acknowledgement: null,
        reconciliation: null,
      }
      this.pendingBySession.set(proposal.observedSessionId, internal)
      this.pendingById.set(proposal.proposalId, internal)
      this.emit(internal)
      return freeze(cloneRecord(proposal))
    })
  }

  async authorizeProposal(proposalIdInput: unknown, authorizationInput: unknown): Promise<Record<string, unknown>> {
    const proposalId = requireId(proposalIdInput, 'proposalId')
    const pending = this.pendingById.get(proposalId)
    const sessionKey = pending?.proposal.observedSessionId ?? `proposal:${proposalId}`
    return this.withSessionLock(sessionKey, async () => {
      const internal = this.pendingById.get(proposalId)
      if (internal === undefined) {
        if (this.completedById.has(proposalId)) fail('authorization_replayed', 'the Adoption proposal is already committed')
        fail('proposal_not_found', 'the Adoption proposal is not current')
      }
      this.assertProposalLive(internal)
      const authorization = parseAuthorization(authorizationInput)
      assertAuthorizationMatches(internal.proposal, authorization)

      if (internal.phase === 'authorized' && internal.ackRequest !== null) {
        if (internal.authorization === null
            || internal.authorization.authorizationId !== authorization.authorizationId
            || canonicalJson(internal.authorization) !== canonicalJson(authorization)) {
          fail('authorization_replayed', 'a different authorization cannot replace the authorized proposal')
        }
        return cloneRecord(internal.ackRequest)
      }
      if (this.usedAuthorizationIds.has(authorization.authorizationId)
          || this.reservedAuthorizationIds.has(authorization.authorizationId)) {
        fail('authorization_replayed', 'the authorization identity has already been consumed')
      }
      this.reservedAuthorizationIds.add(authorization.authorizationId)
      try {
        let verified: boolean | void
        try {
          verified = await this.authorizer.verify(cloneRecord(internal.proposal), cloneRecord(authorization))
        } catch {
          fail('authorization_mismatch', 'the explicit authorization could not be verified')
        }
        if (verified === false) fail('authorization_mismatch', 'the explicit authorization was not accepted')

        const now = this.clock.now()
        if (now >= internal.expiresMonotonic) {
          this.invalidate(internal)
          fail('proposal_expired', 'the Adoption proposal has expired')
        }
        const acknowledgementRemainingMs = Math.min(
          ADOPTION_ACK_TIMEOUT_MS,
          internal.expiresMonotonic - now,
        )
        if (acknowledgementRemainingMs <= 0) {
          this.invalidate(internal)
          fail('proposal_expired', 'the Adoption proposal has expired')
        }

        const requestAck = validateAdoptionRequestAck({
          proposalId: internal.proposal.proposalId,
          proposalDigest: internal.proposal.proposalDigest,
          acknowledgementNonce: internal.proposal.acknowledgementNonce,
          observedSessionId: internal.proposal.observedSessionId,
          executionNodeId: internal.proposal.executionNodeId,
          processIncarnationId: internal.proposal.processIncarnationId,
          piSessionId: internal.proposal.piSessionId,
          extensionInstanceId: internal.proposal.extensionInstanceId,
          connectionId: internal.proposal.connectionId,
          connectionChallenge: internal.proposal.connectionChallenge,
          registryRevision: internal.proposal.registryRevision,
          targetTeamGoalId: internal.proposal.targetTeamGoalId,
          targetRole: internal.proposal.targetRole,
          acknowledgementRemainingMs,
        })

        internal.phase = 'authorized'
        internal.acknowledgementDeadline = addDeadline(now, ADOPTION_ACK_TIMEOUT_MS)
        internal.authorization = authorization
        internal.ackRequest = requestAck
        this.emit(internal)
        try {
          await this.sendAcknowledgementRequest(internal, requestAck)
        } catch {
          internal.phase = 'proposed'
          internal.acknowledgementDeadline = null
          internal.authorization = null
          internal.ackRequest = null
          fail('session_unavailable', 'the observer acknowledgement request could not be delivered')
        }
        this.rememberAuthorization(authorization.authorizationId)
        return cloneRecord(requestAck)
      } finally {
        this.reservedAuthorizationIds.delete(authorization.authorizationId)
      }
    })
  }

  async acceptAcknowledgement(
    transport: object,
    acknowledgementInput: unknown,
  ): Promise<Record<string, unknown>> {
    const acknowledgement = validateAdoptionAck(acknowledgementInput)
    const completed = this.completedById.get(acknowledgement.proposalId)
    const pending = this.pendingById.get(acknowledgement.proposalId)
    const sessionKey = completed?.proposal.observedSessionId
      ?? pending?.proposal.observedSessionId
      ?? `proposal:${acknowledgement.proposalId}`
    return this.withSessionLock(sessionKey, async () => {
      const done = this.completedById.get(acknowledgement.proposalId)
      if (done !== undefined) {
        assertCompletedRetry(done, transport, acknowledgement)
        await this.deliverCompleted(done)
        return cloneRecord(done.result)
      }
      const internal = this.pendingById.get(acknowledgement.proposalId)
      if (internal === undefined) fail('proposal_not_found', 'the Adoption proposal is not current')
      try {
        this.assertProposalLive(internal)
        if (internal.phase !== 'authorized' || internal.ackRequest === null || internal.acknowledgementDeadline === null) {
          fail('authorization_required', 'the Adoption proposal has not received authorization')
        }
        if (transport !== internal.connection) {
          this.invalidate(internal)
          fail('connection_not_current', 'the acknowledgement came from a different observer connection')
        }

        const now = this.clock.now()
        if (now >= internal.acknowledgementDeadline) {
          this.invalidate(internal)
          fail('ack_timeout', 'the Adoption acknowledgement window has expired')
        }
        assertAcknowledgementMatches(internal.proposal, acknowledgement)
        const current = await this.currentObserved(internal.proposal.observedSessionId)
        if (current === null) {
          this.invalidate(internal)
          fail('identity_drift', 'the observed identity is no longer current')
        }
        assertIdentityMatchesRecord(proposalIdentity(internal.proposal), current)
        await this.assertConnectionCurrent(
          internal.proposal.connectionId,
          internal.connection,
          internal.proposal.connectionChallenge,
          current,
        )
        await this.assertCurrentRevision(internal.proposal.registryRevision, current)
        assertSourceSequenceCurrent(current, acknowledgement.sourceSequence)

        if (acknowledgement.decision === 'refused') {
          this.invalidate(internal)
          fail('ack_refused', 'the observer refused the Adoption acknowledgement')
        }
        assertReconciliationActivity(acknowledgement.activity)
        await this.assertEligibility(current, {
          teamGoalId: internal.proposal.targetTeamGoalId,
          executionNodeId: internal.proposal.targetExecutionNodeId,
          role: internal.proposal.targetRole,
        }, internal.proposal.observedSessionId, false)

        internal.phase = 'same_process_acknowledged'
        internal.acknowledgement = acknowledgement
        this.emit(internal)
        internal.reconciliation = {
          activity: 'idle',
          sourceSequence: acknowledgement.sourceSequence,
        }
        internal.phase = 'reconciled'
        this.emit(internal)

        const committed = await this.withCommitLock(() => this.commit(internal))
        return cloneRecord(committed)
      } catch (error) {
        if (internal.phase !== 'proposed' && this.pendingById.get(internal.proposal.proposalId) === internal) {
          this.invalidate(internal)
        }
        throw error
      }
    })
  }

  pendingProposal(observedSessionIdInput: unknown): Record<string, unknown> | null {
    if (!isBoundedId(observedSessionIdInput)) return null
    const internal = this.pendingBySession.get(observedSessionIdInput)
    return internal === undefined ? null : freeze(cloneRecord(internal.proposal))
  }

  getProposal(proposalIdInput: unknown): Record<string, unknown> | null {
    if (!isBoundedId(proposalIdInput)) return null
    const pending = this.pendingById.get(proposalIdInput)
    if (pending !== undefined) return freeze(cloneRecord(pending.proposal))
    const completed = this.completedById.get(proposalIdInput)
    return completed === undefined ? null : freeze(cloneRecord(completed.proposal))
  }

  /**
   * Reset transient Adoption state after a coordinator restart. Durable
   * managed results remain owned by the Team Runner and are not recreated as
   * observed sessions here.
   */
  reconstruct(): void {
    this.pendingBySession.clear()
    this.pendingById.clear()
    this.reservedAuthorizationIds.clear()
    this.locks.clear()
  }

  events(): AdoptionEvent[] {
    return this.eventLog.map((event) => ({ ...event }))
  }

  phases(): AdoptionPhase[] {
    return this.events().map((event) => event.phase)
  }

  private async commit(internal: InternalProposal): Promise<Record<string, unknown>> {
    const proposal = internal.proposal
    const current = await this.currentObserved(proposal.observedSessionId)
    if (current === null) {
      this.invalidate(internal)
      fail('session_unavailable', 'the observed session is no longer current')
    }
    const authorization = internal.authorization
    const acknowledgement = internal.acknowledgement
    const reconciliation = internal.reconciliation
    if (authorization === null || acknowledgement === null || reconciliation === null) {
      fail('authorization_required', 'the Adoption transaction is missing a required phase')
    }

    // These checks are intentionally repeated immediately before the one
    // Team Runner call. No assignment, prompt, process, or dispatch port is
    // touched before that call returns a committed result.
    const latest = await this.currentObserved(proposal.observedSessionId)
    if (latest === null) {
      this.invalidate(internal)
      fail('identity_drift', 'the observed identity changed before commit')
    }
    assertIdentityMatchesRecord(proposalIdentity(proposal), latest)
    await this.assertConnectionCurrent(
      proposal.connectionId,
      internal.connection,
      proposal.connectionChallenge,
      latest,
    )
    await this.assertCurrentRevision(proposal.registryRevision, latest)
    assertSourceSequenceCurrent(latest, acknowledgement.sourceSequence)
    await this.assertEligibility(latest, {
      teamGoalId: proposal.targetTeamGoalId,
      executionNodeId: proposal.targetExecutionNodeId,
      role: proposal.targetRole,
    }, proposal.observedSessionId, false)
    const commitNow = this.clock.now()
    if (commitNow >= proposal.expiresMonotonic) {
      this.invalidate(internal)
      fail('proposal_expired', 'the Adoption proposal expired before commit')
    }
    if (internal.acknowledgementDeadline === null || commitNow >= internal.acknowledgementDeadline) {
      this.invalidate(internal)
      fail('ack_timeout', 'the Adoption acknowledgement window expired before commit')
    }

    let result: Record<string, unknown>
    try {
      result = await this.teamRunner.commitAdoption({
        proposal: cloneRecord(proposal),
        authorization: cloneRecord(authorization),
        acknowledgement: cloneRecord(acknowledgement),
        observed: cloneRecord(latest),
        reconciliation: cloneRecord(reconciliation),
      })
    } catch {
      this.invalidate(internal)
      fail('transaction_failed', 'the Team Runner Adoption transaction failed')
    }

    let committed: Record<string, unknown>
    try {
      committed = normalizeCommittedResult(result, proposal)
    } catch (error) {
      this.invalidate(internal)
      throw error
    }
    internal.phase = 'committed'
    this.emit(internal)
    this.removePending(internal)
    const done: CompletedAdoption = {
      proposal,
      connection: internal.connection,
      acknowledgement,
      result: committed,
      presented: false,
      committedDelivered: false,
    }
    this.rememberCompleted(done)

    await this.deliverCompleted(done)
    return cloneRecord(committed)
  }

  private async deliverCompleted(done: CompletedAdoption): Promise<void> {
    try {
      if (!done.presented) {
        await this.presentation.applyCommitted(cloneRecord(done.result))
        done.presented = true
      }
      if (!done.committedDelivered) {
        await this.sendCommitted(done)
        done.committedDelivered = true
      }
    } catch (error) {
      if (error instanceof ObserverError && error.code === 'postcommit_delivery_failed') throw error
      fail('postcommit_delivery_failed', 'the committed Adoption result could not be presented or delivered')
    }
  }

  private async sendAcknowledgementRequest(
    internal: InternalProposal,
    requestAck: AdoptionRequestAckBody,
  ): Promise<void> {
    const connection = internal.connection as AdoptionObserverConnection
    if (typeof connection.sendAdoptionRequest === 'function') {
      await connection.sendAdoptionRequest(cloneRecord(requestAck))
      return
    }
    if (typeof connection.send === 'function') {
      const messageId = this.issueId('message', null)
      await connection.send('adoption.request_ack', messageId, cloneRecord(requestAck))
      return
    }
    fail('session_unavailable', 'the current observer connection cannot receive an Adoption request')
  }

  private async sendCommitted(done: CompletedAdoption): Promise<void> {
    const connection = done.connection as AdoptionObserverConnection
    const body: AdoptionCommittedBody = validateAdoptionCommitted({
      proposalId: done.result.proposalId,
      proposalDigest: done.result.proposalDigest,
      agentRunId: done.result.agentRunId,
      targetTeamGoalId: done.result.targetTeamGoalId,
      targetRole: done.result.targetRole,
      controlMode: done.result.controlMode,
      piStatus: done.result.piStatus,
      terminalTitleMetadata: done.result.terminalTitleMetadata,
      runtimeBindingGuarantee: done.result.runtimeBindingGuarantee,
    })
    if (typeof connection.sendAdoptionCommitted === 'function') {
      await connection.sendAdoptionCommitted(cloneRecord(body))
      return
    }
    if (typeof connection.send === 'function') {
      const messageId = this.issueId('message', null)
      await connection.send('adoption.committed', messageId, cloneRecord(body))
    }
  }

  private async assertEligibility(
    record: Record<string, unknown>,
    target: { teamGoalId: string; executionNodeId: string; role: Role },
    observedSessionId: string,
    checkPending: boolean,
  ): Promise<void> {
    if (checkPending) {
      const pending = this.pendingBySession.get(observedSessionId)
      if (pending !== undefined) {
        if (this.clock.now() >= pending.expiresMonotonic) this.invalidate(pending)
        else fail('proposal_conflict', 'an Adoption proposal is already pending for this observed session')
      }
    }
    if (record.lifecycle === 'exited') fail('session_exited', 'the observed Pi session has exited')
    if (record.availability !== 'available') fail('session_unavailable', 'the observed Pi session is unavailable')
    if (record.activity !== 'idle') {
      if (record.activity === 'unknown') fail('session_unknown', 'the observer cannot establish an idle session')
      fail('session_busy', 'the observed Pi session is not idle')
    }
    if (record.health !== 'healthy') fail('session_unavailable', 'the observed session health is degraded')
    if (record.piStatus !== OBSERVER_PI_STATUS_LOCAL) fail('already_managed', 'the observed session is no longer unassigned')

    const recordNode = requireId(record.executionNodeId, 'executionNodeId')
    if (target.executionNodeId !== recordNode) {
      fail('node_mismatch', 'the target Execution Node is not the registry-assigned local Node')
    }
    if (typeof this.registry.isLocalTeamGoal !== 'function') {
      fail('remote_team_goal', 'the target Team Goal is not verified as local')
    }
    let local: boolean
    try {
      local = await this.registry.isLocalTeamGoal(target.teamGoalId, target.executionNodeId)
    } catch {
      fail('remote_team_goal', 'the target Team Goal is not verified as local')
    }
    if (!local) fail('remote_team_goal', 'the target Team Goal is not local to the registry Node')

    if (typeof this.registry.isRoleOccupied === 'function') {
      let occupied: boolean
      try {
        occupied = await this.registry.isRoleOccupied(target.teamGoalId, target.role)
      } catch {
        fail('role_occupied', 'the target Role is not available')
      }
      if (occupied) fail('role_occupied', 'the target Role is already occupied')
    }
    if (typeof this.registry.isAlreadyManaged === 'function') {
      let managed: boolean
      try {
        managed = await this.registry.isAlreadyManaged(observedSessionId)
      } catch {
        fail('already_managed', 'the observed session already has a managed Agent Run')
      }
      if (managed) fail('already_managed', 'the observed session already has a managed Agent Run')
    }
  }

  private async assertConnectionCurrent(
    connectionId: unknown,
    connection: object,
    connectionChallenge: unknown,
    record: Record<string, unknown>,
  ): Promise<void> {
    const id = requireId(connectionId, 'connectionId')
    if (Object.hasOwn(record, 'connectionId') && record.connectionId !== id) {
      fail('connection_not_current', 'the observer connection identity is not current')
    }
    const connectionState = connection as { closed?: unknown; isClosed?: unknown }
    if (connectionState.closed === true || connectionState.isClosed === true) {
      fail('connection_not_current', 'the observer connection is closed')
    }
    const challenge = requireId(connectionChallenge, 'connectionChallenge')
    if (Object.hasOwn(record, 'connectionChallenge')) {
      if (record.connectionChallenge !== challenge) {
        fail('connection_not_current', 'the observer connection challenge is not current')
      }
    }
    if (typeof this.registry.isCurrentConnection === 'function') {
      let current: boolean
      try {
        current = await this.registry.isCurrentConnection(connection, id, challenge)
      } catch {
        fail('connection_not_current', 'the observer connection is not current')
      }
      if (!current) fail('connection_not_current', 'the observer connection is not current')
    }
    if (typeof this.registry.assertCurrentConnection === 'function') {
      try {
        await this.registry.assertCurrentConnection(connection, id, challenge)
      } catch {
        fail('connection_not_current', 'the observer connection is not current')
      }
    }
  }

  private async assertCurrentRevision(expected: number, record: Record<string, unknown>): Promise<void> {
    const recordRevision = requireRevision(record.registryRevision)
    if (recordRevision !== expected) {
      fail('identity_drift', 'the registry revision changed during Adoption')
    }
    if (typeof this.registry.currentRevision === 'function') {
      let currentRevision: number
      try {
        currentRevision = await this.registry.currentRevision()
      } catch {
        fail('identity_drift', 'the registry revision is unavailable')
      }
      if (currentRevision !== expected) fail('identity_drift', 'the registry revision changed during Adoption')
    }
  }

  private async currentObserved(observedSessionId: string): Promise<Record<string, unknown> | null> {
    const getter = this.registry.getObserved
      ?? this.registry.currentObservedSession
      ?? this.registry.getObservedSession
    if (getter === undefined) return null
    let value: unknown
    try {
      value = await getter.call(this.registry, observedSessionId)
    } catch (error) {
      if (error instanceof ObserverError) throw error
      return null
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return cloneRecord(value as Record<string, unknown>)
  }

  private assertProposalLive(internal: InternalProposal): void {
    if (this.clock.now() >= internal.expiresMonotonic) {
      this.invalidate(internal)
      fail('proposal_expired', 'the Adoption proposal has expired')
    }
  }

  private issueId(purpose: string, factory: (() => string) | null): string {
    let value: unknown
    try {
      value = factory === null ? this.idIssuer.issue(purpose) : factory()
    } catch {
      fail('invalid_identity', 'the Adoption capability issuer failed')
    }
    if (!isBoundedId(value)) fail('invalid_identity', 'the Adoption capability issuer returned an invalid identity')
    if (this.issuedIds.has(value)) fail('invalid_identity', 'the Adoption capability issuer returned a reused identity')
    this.issuedIds.add(value)
    return value
  }

  private emit(internal: InternalProposal): void {
    if (this.eventLog.length >= ADOPTION_EVENT_LIMIT) this.eventLog.shift()
    this.eventLog.push({
      sequence: ++this.eventSequence,
      phase: internal.phase,
      proposalId: internal.proposal.proposalId,
      observedSessionId: internal.proposal.observedSessionId,
    })
  }

  private invalidate(internal: InternalProposal): void {
    internal.phase = 'failed'
    this.emit(internal)
    this.removePending(internal)
  }

  private removePending(internal: InternalProposal): void {
    if (this.pendingById.get(internal.proposal.proposalId) === internal) {
      this.pendingById.delete(internal.proposal.proposalId)
    }
    if (this.pendingBySession.get(internal.proposal.observedSessionId) === internal) {
      this.pendingBySession.delete(internal.proposal.observedSessionId)
    }
  }

  private rememberCompleted(done: CompletedAdoption): void {
    if (this.completedById.has(done.proposal.proposalId)) return
    if (this.completedOrder.length >= ADOPTION_IDEMPOTENCY_LIMIT) {
      const oldest = this.completedOrder.shift()
      if (oldest !== undefined) this.completedById.delete(oldest)
    }
    this.completedOrder.push(done.proposal.proposalId)
    this.completedById.set(done.proposal.proposalId, done)
  }

  private rememberAuthorization(authorizationId: string): void {
    if (this.usedAuthorizationIds.has(authorizationId)) return
    if (this.usedAuthorizationOrder.length >= ADOPTION_IDEMPOTENCY_LIMIT) {
      const oldest = this.usedAuthorizationOrder.shift()
      if (oldest !== undefined) this.usedAuthorizationIds.delete(oldest)
    }
    this.usedAuthorizationOrder.push(authorizationId)
    this.usedAuthorizationIds.add(authorizationId)
  }

  private withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let current!: Promise<T>
    current = previous.then(operation, operation)
    const marker = current.then(() => undefined, () => undefined)
    this.locks.set(key, marker)
    return current.finally(() => {
      if (this.locks.get(key) === marker) this.locks.delete(key)
    })
  }

  private withCommitLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.commitTail
    let release!: () => void
    this.commitTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return previous.then(operation, operation).finally(release)
  }
}

function requirePort<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new TypeError(`${name} port is required`)
  }
  return value
}

function requireClock(value: AdoptionClock): AdoptionClock {
  if (value === null || typeof value !== 'object' || typeof value.now !== 'function') {
    throw new TypeError('Adoption clock with now() is required')
  }
  return value
}

function maybeObservedSessionId(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = (input as Record<string, unknown>).observedSessionId
  return isBoundedId(value) ? value : null
}

function parseAdoptionRequest(input: unknown): AdoptionRequest {
  const value = plainObject(input, 'Adoption request')
  exactKeys(value, ['observedSessionId', 'observedIdentity', 'connection', 'target'], 'Adoption request')
  const observedSessionId = requireId(value.observedSessionId, 'observedSessionId')
  const observedIdentity = plainObject(value.observedIdentity, 'observedIdentity')
  exactKeys(observedIdentity, [...IDENTITY_FIELDS, 'connectionId', 'connectionChallenge'], 'observedIdentity')
  const connection = plainObject(value.connection, 'connection')
  exactKeys(connection, ['id', 'connectionId', 'connectionChallenge'], 'connection')
  if (!isBoundedId(connection.id)) fail('connection_not_current', 'the observer connection has no bounded identity')
  const target = plainObject(value.target, 'target')
  exactKeys(target, ['teamGoalId', 'executionNodeId', 'role'], 'Adoption target')
  const role = requireRole(target.role, 'targetRole')
  return {
    observedSessionId,
    observedIdentity,
    connection: {
      id: connection.id,
      connectionId: requireId(connection.connectionId, 'connectionId'),
      connectionChallenge: requireId(connection.connectionChallenge, 'connectionChallenge'),
    },
    target: {
      teamGoalId: requireId(target.teamGoalId, 'targetTeamGoalId'),
      executionNodeId: requireId(target.executionNodeId, 'targetExecutionNodeId'),
      role,
    },
  }
}

function validateRequestIdentity(request: AdoptionRequest): Record<IdentityField, string> & {
  connectionId: string
  connectionChallenge: string
} {
  const identity = request.observedIdentity
  const result = {
    observedSessionId: requireId(identity.observedSessionId, 'observedSessionId'),
    executionNodeId: requireId(identity.executionNodeId, 'executionNodeId'),
    processIncarnationId: requireId(identity.processIncarnationId, 'processIncarnationId'),
    piSessionId: requireId(identity.piSessionId, 'piSessionId'),
    extensionInstanceId: requireId(identity.extensionInstanceId, 'extensionInstanceId'),
    connectionId: requireId(identity.connectionId, 'connectionId'),
    connectionChallenge: requireId(identity.connectionChallenge, 'connectionChallenge'),
  }
  if (result.observedSessionId !== request.observedSessionId
      || result.connectionId !== request.connection.connectionId
      || result.connectionChallenge !== request.connection.connectionChallenge) {
    fail('identity_drift', 'the Adoption request identity is internally inconsistent')
  }
  return result
}

function proposalIdentity(proposal: AdoptionProposal): Record<IdentityField, string> {
  return {
    observedSessionId: proposal.observedSessionId,
    executionNodeId: proposal.executionNodeId,
    processIncarnationId: proposal.processIncarnationId,
    piSessionId: proposal.piSessionId,
    extensionInstanceId: proposal.extensionInstanceId,
  }
}

function assertIdentityMatchesRecord(
  identity: Record<IdentityField, string>,
  record: Record<string, unknown>,
): void {
  for (const field of IDENTITY_FIELDS) {
    if (record[field] !== identity[field]) {
      fail('identity_drift', 'the observed identity is not current')
    }
  }
}

function parseAuthorization(input: unknown): AdoptionAuthorization {
  const value = plainObject(input, 'Adoption authorization')
  exactKeys(value, [
    'proposalId', 'proposalDigest', 'targetTeamGoalId', 'targetRole', 'authorizationId', 'token',
  ], 'Adoption authorization')
  return {
    proposalId: requireId(value.proposalId, 'proposalId'),
    proposalDigest: requireDigest(value.proposalDigest),
    targetTeamGoalId: requireId(value.targetTeamGoalId, 'targetTeamGoalId'),
    targetRole: requireRole(value.targetRole, 'targetRole'),
    authorizationId: requireId(value.authorizationId, 'authorizationId'),
    token: requireBoundedText(value.token, 'authorization token', 1024),
  }
}

function assertAuthorizationMatches(proposal: AdoptionProposal, authorization: AdoptionAuthorization): void {
  if (authorization.proposalId !== proposal.proposalId
      || authorization.proposalDigest !== proposal.proposalDigest
      || authorization.targetTeamGoalId !== proposal.targetTeamGoalId
      || authorization.targetRole !== proposal.targetRole) {
    fail('authorization_mismatch', 'authorization does not bind the exact Adoption proposal')
  }
}

function assertSourceSequenceCurrent(record: Record<string, unknown>, sourceSequence: number): void {
  const prior = record.acceptedSourceSequence ?? record.lastSourceSequence
  if (prior !== undefined && (typeof prior !== 'number' || !Number.isSafeInteger(prior) || sourceSequence <= prior)) {
    fail('invalid_sequence', 'the Adoption acknowledgement source sequence is not current')
  }
}

function assertAcknowledgementMatches(proposal: AdoptionProposal, acknowledgement: AdoptionAckBody): void {
  const pairs: Array<[unknown, unknown]> = [
    [acknowledgement.processIncarnationId, proposal.processIncarnationId],
    [acknowledgement.piSessionId, proposal.piSessionId],
    [acknowledgement.extensionInstanceId, proposal.extensionInstanceId],
    [acknowledgement.connectionId, proposal.connectionId],
    [acknowledgement.connectionChallenge, proposal.connectionChallenge],
    [acknowledgement.proposalId, proposal.proposalId],
    [acknowledgement.proposalDigest, proposal.proposalDigest],
    [acknowledgement.acknowledgementNonce, proposal.acknowledgementNonce],
    [acknowledgement.registryRevision, proposal.registryRevision],
  ]
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    fail('identity_drift', 'the Adoption acknowledgement does not bind the exact proposal')
  }
}

function assertCompletedRetry(
  completed: CompletedAdoption,
  transport: object,
  acknowledgement: AdoptionAckBody,
): void {
  if (transport !== completed.connection
      || acknowledgement.proposalDigest !== completed.proposal.proposalDigest
      || acknowledgement.processIncarnationId !== completed.proposal.processIncarnationId
      || acknowledgement.piSessionId !== completed.proposal.piSessionId
      || acknowledgement.extensionInstanceId !== completed.proposal.extensionInstanceId
      || acknowledgement.connectionId !== completed.proposal.connectionId
      || acknowledgement.connectionChallenge !== completed.proposal.connectionChallenge
      || acknowledgement.acknowledgementNonce !== completed.proposal.acknowledgementNonce
      || acknowledgement.registryRevision !== completed.proposal.registryRevision
      || acknowledgement.sourceSequence !== completed.acknowledgement.sourceSequence
      || acknowledgement.activity !== completed.acknowledgement.activity
      || acknowledgement.refusalCode !== completed.acknowledgement.refusalCode
      || acknowledgement.decision !== 'acknowledged') {
    throw new ObserverError('connection_not_current', 'the completed Adoption retry is not bound to the original connection')
  }
}

function assertReconciliationActivity(activity: ObserverActivity): void {
  if (activity === 'idle') return
  if (activity === 'unknown') fail('session_unknown', 'the observer cannot establish idle activity')
  fail('session_busy', 'the observer acknowledgement reports non-idle activity')
}

function normalizeCommittedResult(
  result: Record<string, unknown>,
  proposal: AdoptionProposal,
): Record<string, unknown> {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    fail('transaction_failed', 'the Team Runner returned no committed Adoption result')
  }
  const agentRunId = result.agentRunId
  const piStatus = result.piStatus
  const terminalTitleMetadata = result.terminalTitleMetadata
  const allowedResultFields = new Set([
    'observedSessionId', 'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId',
    'proposalId', 'proposalDigest', 'agentRunId', 'targetTeamGoalId', 'targetRole', 'controlMode',
    'piStatus', 'terminalTitleMetadata', 'runtimeBinding', 'runtimeBindingGuarantee',
  ])
  if (Object.keys(result).some((key) => !allowedResultFields.has(key))) {
    fail('transaction_failed', 'the Team Runner returned an unsupported managed result field')
  }
  for (const field of ['observedSessionId', 'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId'] as const) {
    if (Object.hasOwn(result, field) && result[field] !== proposal[field]) {
      fail('transaction_failed', 'the Team Runner returned a mismatched managed identity')
    }
  }
  if (Object.hasOwn(result, 'runtimeBinding') && result.runtimeBinding !== null) {
    fail('transaction_failed', 'the Team Runner returned a Runtime Binding for the observed session')
  }
  if (!isBoundedId(agentRunId)
      || typeof piStatus !== 'string'
      || typeof terminalTitleMetadata !== 'string'
      || [...piStatus].length === 0
      || [...piStatus].length > 512
      || [...terminalTitleMetadata].length === 0
      || [...terminalTitleMetadata].length > 512
      || result.proposalId !== proposal.proposalId
      || result.proposalDigest !== proposal.proposalDigest
      || result.targetTeamGoalId !== proposal.targetTeamGoalId
      || result.targetRole !== proposal.targetRole
      || result.controlMode !== 'managed'
      || result.runtimeBindingGuarantee !== 'unavailable') {
    fail('transaction_failed', 'the Team Runner returned an invalid managed Adoption result')
  }
  // Keep only the managed result fields owned by this seam. In particular,
  // an accidental prompt, PTY flag, or arbitrary runner field cannot cross
  // into the presentation result.
  const committed: Record<string, unknown> = {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    agentRunId,
    targetTeamGoalId: proposal.targetTeamGoalId,
    targetRole: proposal.targetRole,
    controlMode: 'managed',
    piStatus,
    terminalTitleMetadata,
    runtimeBinding: null,
    runtimeBindingGuarantee: 'unavailable',
  }
  for (const field of ['observedSessionId', 'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId'] as const) {
    if (Object.hasOwn(result, field)) committed[field] = result[field]
  }
  return committed
}

function digestProposal(value: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) fail('invalid_envelope', 'Adoption identity data is not finite JSON')
  return encoded
}

function cloneRecord<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    fail('invalid_envelope', 'Adoption data must be finite cloneable values')
  }
}

function freeze<T>(value: T): T {
  return Object.freeze(value)
}

function plainObject(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_envelope', `${where} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    fail('invalid_envelope', `${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_envelope', `${where} contains an unsupported field`)
  }
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) fail('invalid_identity', `${where} is not a bounded identity`)
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    fail('invalid_envelope', 'proposal digest is not a lowercase SHA-256 value')
  }
  return input
}

function requireRole(input: unknown, where: string): Role {
  if (typeof input !== 'string' || !(ROLES as readonly string[]).includes(input)) {
    fail('invalid_envelope', `${where} is not an allowed Role`)
  }
  return input as Role
}

function requireRevision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    fail('invalid_envelope', 'registry revision is not a safe integer')
  }
  return input
}

function requireBoundedText(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > maxCharacters) {
    fail('invalid_envelope', `${where} is not bounded text`)
  }
  return input
}

function addDeadline(start: number, duration: number): number {
  if (!Number.isSafeInteger(start) || start < 0 || duration < 0 || duration > Number.MAX_SAFE_INTEGER - start) {
    fail('invalid_sequence', 'monotonic Adoption deadline is not representable')
  }
  return start + duration
}

function fail(code: ConstructorParameters<typeof ObserverError>[0], detail: string): never {
  throw new ObserverError(code, detail)
}
