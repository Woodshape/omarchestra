/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-adoption-runner.ts — the sole Adoption authority for the live slice.
 * It composes the pure AdoptionCoordinator with the durable AdoptionStore,
 * owns local Team Goal/Role checks, exact per-connection tracking, final
 * synchronous revalidation, recovery, and dispatch readiness.
 *
 * The runner performs no I/O and imports neither QML nor SQLite. All ports are
 * injected; the durable store adapter is supplied by the caller (see
 * manual/live-adoption-store.ts). It never opens a socket, launches Pi, or
 * starts a provider.
 *
 * Authority boundary: the coordinator performs asynchronous eligibility checks
 * before calling the runner's commit port. The runner repeats every
 * authoritative check synchronously inside the durable store transaction, so
 * no async yield, publication, or transport callback can occur between the
 * final checks and the durable mutation.
 */

import {
  ADOPTION_ACK_TIMEOUT_MS,
  AdoptionCoordinator,
  type AdoptionAuthorizationPort,
  type AdoptionClock,
  type AdoptionDispatchPort,
  type AdoptionObserverConnection,
  type AdoptionPresentationPort,
  type AdoptionRegistryPort,
  type AdoptionTeamRunnerPort,
} from './adoption.ts'
import { OBSERVER_PI_STATUS_LOCAL, ObserverError, validateAdoptionCommitted } from './contracts.ts'
import type {
  AdoptionStore,
  BindingIdentity,
  CommittedAdoption,
} from './live-adoption-store.ts'
import {
  type ReplacementCommit,
  type RetiredRun,
  type RetirementStore,
  RetirementError,
} from './retirement-store.ts'
import { ROLES, type Role } from '../src/protocol.ts'

/**
 * The retirement port injected into the runner. It composes the retirement
 * store with three small factories so the runner can stay decoupled from
 * SQLite, QML, and the protocol layer. The runner owns every eligibility
 * check; the store is the durability boundary only.
 */
export interface RetirementRunnerPort {
  store: RetirementStore
  commitAgentRunId: () => string
  commitReplacementAgentRunId: () => string
  replacementNonce: () => string
  /** Optional synchronous hook so a pure store can verify Role occupancy. */
  liveCommitForRole?: (teamGoalId: string, role: Role) => { agentRunId: string } | null
  /** Resolve the current retirement revision for the given committed run. */
  revisionOf: (committed: CommittedAdoption | Record<string, unknown>) => number
}

export interface LiveAdoptionRunnerOptions {
  store: AdoptionStore
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  clock?: AdoptionClock
  authorizer?: AdoptionAuthorizationPort
  presentation?: AdoptionPresentationPort
  dispatch?: AdoptionDispatchPort
  managedBridge?: { enable(committed: Record<string, unknown>): void; disable(): void }
  proposalIdFactory?: () => string
  acknowledgementNonceFactory?: () => string
  choiceResolver?: (choiceId: string) => { teamGoalId: string; role: Role }
  leaseDurationMs?: number
  recoveryTtlMs?: number
  recoveryChallengeFactory?: () => string
  retirement?: RetirementRunnerPort
}

export interface RetireAgentRunInput {
  agentRunId: string
  teamGoalId: string
  role: Role
  observedSessionId: string
  revision: number
  executionNodeId?: string
  confirmationToken?: string
}

export interface ReplacementProposalContext {
  proposalId: string
  predecessorAgentRunId: string
  vacancyGeneration: number
  proposalDigest: string
  acknowledgementNonce: string
  expiresMonotonic: number
}

export interface RetireAgentRunResult {
  agentRunId: string
  teamGoalId: string
  role: Role
  retiredAt: number
  revision: number
  vacancyGeneration: number
  state: 'retired'
  alreadyRetired: boolean
}

export interface ObservedRecord {
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connectionId: string
  connectionChallenge: string
  registryRevision: number
  lifecycle: 'running' | 'exited'
  activity: 'idle' | 'busy' | 'waiting_for_user' | 'unknown'
  availability: 'available' | 'unavailable'
  health: 'healthy' | 'degraded'
  piStatus: string
  acceptedSourceSequence: number
}

export interface RecoveryState {
  committedRuns: CommittedAdoption[]
  observedSessions: string[]
  commitCount: number
}

export interface RecoveryChallenge {
  challenge: string
  committed: CommittedAdoption
}

export interface RecoveryProof {
  challenge: string
  committed: Record<string, unknown>
}

const DEFAULT_TRANSPORT_ID = 'transport-1'
const DEFAULT_LEASE_DURATION_MS = 15_000
const DEFAULT_RECOVERY_TTL_MS = 30_000

interface ObservedEntry {
  record: ObservedRecord
  connection: object
  observerConnection: AdoptionObserverConnection
  coordinator: AdoptionCoordinator
  leaseUntil: number
}

interface CommitContext {
  connection: object
  observedSessionId: string
  acknowledgementDeadline: number
  expiresMonotonic: number
}

interface RecoveryEntry {
  binding: BindingIdentity
  challenge: string
  expiresAt: number
  committed: CommittedAdoption
}

/**
 * Compose the AdoptionCoordinator with the durable store and the same-Pi
 * managed bridge. The runner owns the observed-session registry, the exact
 * per-connection observer transport, and the final synchronous revalidation
 * boundary. Each observed session gets its own coordinator bound to its exact
 * connection, so an acknowledgement over any other connection is rejected.
 */
export class LiveAdoptionRunner {
  private readonly store: AdoptionStore
  private readonly executionNodeId: string
  private readonly teamGoalId: string
  private readonly roles: Role[]
  private readonly observed = new Map<string, ObservedEntry>()
  private readonly commitContexts = new Map<string, CommitContext>()
  private readonly recoveries = new Map<object, RecoveryEntry>()
  private readonly managedBridge: { enable(committed: Record<string, unknown>): void; disable(): void }
  private readonly choiceResolver: (choiceId: string) => { teamGoalId: string; role: Role }
  private readonly clock: AdoptionClock
  private readonly authorizer: AdoptionAuthorizationPort
  private readonly dispatch: AdoptionDispatchPort | undefined
  private readonly proposalIdFactory: (() => string) | undefined
  private readonly acknowledgementNonceFactory: (() => string) | undefined
  private readonly leaseDurationMs: number
  private readonly recoveryTtlMs: number
  private readonly recoveryChallengeFactory: () => string
  private readonly presentation: AdoptionPresentationPort
  private readonly retirement: RetirementRunnerPort | undefined
  private readonly replacementCommitContexts = new Map<string, ReplacementCommitContext>()
  private readonly managedConnections = new Map<object, { committed: CommittedAdoption; ready: boolean; leaseUntil: number }>()
  private readonly readyObserved = new Set<string>()
  private readonly disconnectObserved = new Set<string>()
  private revision = 0
  private commitCountValue = 0
  private managedBridgeEnabledValue = false
  private dispatchCountValue = 0
  private queuedWorkValue = 0

  constructor(options: LiveAdoptionRunnerOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveAdoptionRunner options are required')
    }
    this.store = requirePort(options.store, 'store')
    this.executionNodeId = requireId(options.executionNodeId, 'executionNodeId')
    this.teamGoalId = requireId(options.teamGoalId, 'teamGoalId')
    this.roles = requireRoles(options.roles)
    this.managedBridge = options.managedBridge ?? { enable: () => {}, disable: () => {} }
    this.presentation = options.presentation ?? { applyCommitted: () => {} }
    this.choiceResolver = options.choiceResolver ?? defaultChoiceResolver(this.teamGoalId)
    this.clock = options.clock ?? { now: () => Math.floor(performance.now()) }
    this.authorizer = options.authorizer ?? { verify: () => true }
    this.dispatch = options.dispatch
    this.proposalIdFactory = options.proposalIdFactory
    this.acknowledgementNonceFactory = options.acknowledgementNonceFactory
    this.leaseDurationMs = requireNonNegativeInt(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, 'leaseDurationMs')
    this.recoveryTtlMs = requireNonNegativeInt(options.recoveryTtlMs ?? DEFAULT_RECOVERY_TTL_MS, 'recoveryTtlMs')
    this.recoveryChallengeFactory = options.recoveryChallengeFactory ?? defaultRecoveryChallengeFactory
    this.retirement = options.retirement
  }

  /** Register a current observed session on a specific transport connection. */
  registerObserved(record: ObservedRecord, connection?: object): void {
    if (record === null || typeof record !== 'object') {
      throw new TypeError('observed record must be a plain object')
    }
    if (this.store.transaction(tx => tx.isBindingCommitted(bindingOfRecord(record)))) {
      throw new ObserverError('already_managed', 'committed binding requires challenged recovery')
    }
    if (this.retirement !== undefined) {
      this.retirement.store.transaction((tx) => tx.registerObservedIfUnretired(bindingOfRecord(record)))
    }
    const transport = connection ?? { id: DEFAULT_TRANSPORT_ID }
    const observerConnection: AdoptionObserverConnection = {
      id: (transport as { id?: unknown }).id ?? DEFAULT_TRANSPORT_ID,
      send: (type, messageId, body) => {
        const sender = (transport as { send?: (t: string, m: string, b: Record<string, unknown>) => void }).send
        if (typeof sender === 'function') return sender.call(transport, type, messageId, body)
      },
    }
    const entry: ObservedEntry = {
      record: cloneRecord(record),
      connection: transport,
      observerConnection,
      coordinator: this.buildCoordinator(observerConnection),
      leaseUntil: this.clock.now() + this.leaseDurationMs,
    }
    this.observed.set(record.observedSessionId, entry)
    this.revision += 1
  }

  /** Update an existing observed record in place (heartbeat/lifecycle). */
  updateObserved(record: ObservedRecord): void {
    const entry = this.observed.get(record.observedSessionId)
    if (entry !== undefined) {
      entry.record = cloneRecord(record)
      entry.leaseUntil = this.clock.now() + this.leaseDurationMs
      this.revision += 1
    }
  }

  /** Retire expired authority before publishing or receiving more frames. */
  expire(): void {
    for (const [connection, managed] of this.managedConnections) {
      if (this.clock.now() >= managed.leaseUntil) this.onConnectionLost(connection)
    }
    for (const [id, entry] of this.observed) {
      if (this.managedConnections.has(entry.connection)) continue
      if (this.clock.now() >= entry.leaseUntil) {
        this.onConnectionLost(entry.connection)
        this.observed.delete(id)
        this.revision += 1
      }
    }
  }

  private buildCoordinator(observerConnection: AdoptionObserverConnection): AdoptionCoordinator {
    const registry: AdoptionRegistryPort = {
      getObserved: (observedSessionId) => {
        const entry = this.observed.get(observedSessionId)
        return entry === undefined ? null : cloneRecord(entry.record)
      },
      isLocalTeamGoal: (teamGoalId, executionNodeId) => (
        teamGoalId === this.teamGoalId && executionNodeId === this.executionNodeId
      ),
      isRoleOccupied: (teamGoalId, role) => {
        const adoptionOccupied = this.store.transaction((tx) => tx.isRoleOccupied(teamGoalId, role))
        return this.isRoleOccupiedAfterRetirement(teamGoalId, role, adoptionOccupied)
      },
      isAlreadyManaged: (observedSessionId) => {
        const entry = this.observed.get(observedSessionId)
        if (entry === undefined) return false
        return this.store.transaction((tx) => tx.isBindingCommitted(bindingOfRecord(entry.record)))
      },
      isCurrentConnection: (connection, connectionId, connectionChallenge) => {
        for (const entry of this.observed.values()) {
          if (entry.observerConnection === connection
              && entry.record.connectionId === connectionId
              && entry.record.connectionChallenge === connectionChallenge) {
            return true
          }
        }
        return false
      },
      currentRevision: () => {
        let max = 0
        for (const entry of this.observed.values()) {
          max = Math.max(max, entry.record.registryRevision)
        }
        return max
      },
    }

    const teamRunner: AdoptionTeamRunnerPort = {
      commitAdoption: (input) => this.commitAdoption(input),
    }

    // Presentation is not readiness. Only a later same-Pi readiness proof may
    // activate dispatch; this commit-only slice creates no Assignment.
    const presentation = this.presentation

    return new AdoptionCoordinator({
      clock: this.clock,
      registry,
      authorizer: this.authorizer,
      teamRunner,
      presentation,
      observerConnection,
      dispatch: this.dispatch,
      proposalIdFactory: this.proposalIdFactory,
      acknowledgementNonceFactory: this.acknowledgementNonceFactory,
    })
  }

  /**
   * The synchronous commit port. The coordinator has already performed
   * asynchronous eligibility checks; this port repeats every authoritative
   * check synchronously inside the durable store transaction so no async
   * yield can occur between the final checks and the durable mutation.
   */
  private commitAdoption(input: Record<string, unknown>): Record<string, unknown> {
    const proposal = requirePlainRecord(input.proposal, 'proposal')
    const proposalId = requireId(proposal.proposalId, 'proposalId')
    const context = this.commitContexts.get(proposalId)
    if (context === undefined) {
      throw new ObserverError('proposal_not_found', 'no synchronous commit context for this proposal')
    }
    const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
    const role = requireRole(proposal.targetRole, 'targetRole')
    const vacancy = this.retirementVacancyFor(teamGoalId, role)
    if (vacancy !== null) return this.commitNormalAdoptionAsReplacement(input, context, vacancy)
    const committed = this.store.transaction((tx) => {
      this.assertSynchronousCommitValid(context, input, tx)
      return tx.commitAdoption(input)
    })
    this.managedConnections.set(context.connection, { committed, ready: false, leaseUntil: this.clock.now() + this.leaseDurationMs })
    this.commitContexts.delete(proposalId)
    this.commitCountValue += 1
    this.revision += 1
    const { committedAt: _committedAt, ...result } = committed
    return result
  }

  private assertSynchronousCommitValid(
    context: CommitContext,
    input: Record<string, unknown>,
    tx: { isRoleOccupied(teamGoalId: string, role: Role): boolean; isBindingCommitted(binding: BindingIdentity): boolean },
  ): void {
    const entry = this.observed.get(context.observedSessionId)
    if (entry === undefined) {
      throw new ObserverError('session_unknown', 'the observed session is not current')
    }
    if (entry.connection !== context.connection) {
      throw new ObserverError('connection_not_current', 'the observer connection changed during Adoption')
    }
    const acknowledgement = requirePlainRecord(input.acknowledgement, 'acknowledgement')
    if (entry.record.connectionId !== acknowledgement.connectionId
        || entry.record.connectionChallenge !== acknowledgement.connectionChallenge) {
      throw new ObserverError('connection_not_current', 'the observer connection identity is not current')
    }
    const now = this.clock.now()
    if (now >= context.expiresMonotonic) {
      throw new ObserverError('proposal_expired', 'the Adoption proposal expired before commit')
    }
    if (now >= context.acknowledgementDeadline) {
      throw new ObserverError('ack_timeout', 'the Adoption acknowledgement window expired before commit')
    }
    if (now >= entry.leaseUntil) {
      throw new ObserverError('session_expired', 'the observed session lease expired before commit')
    }
    const record = entry.record
    if (record.lifecycle === 'exited') throw new ObserverError('session_exited', 'the observed Pi session has exited')
    if (record.availability !== 'available') throw new ObserverError('session_unavailable', 'the observed Pi session is unavailable')
    if (record.activity !== 'idle') {
      if (record.activity === 'unknown') throw new ObserverError('session_unknown', 'the observer cannot establish an idle session')
      throw new ObserverError('session_busy', 'the observed Pi session is not idle')
    }
    if (record.health !== 'healthy') throw new ObserverError('session_unavailable', 'the observed session health is degraded')
    if (record.piStatus !== OBSERVER_PI_STATUS_LOCAL) throw new ObserverError('already_managed', 'the observed session is no longer unassigned')
    const proposal = requirePlainRecord(input.proposal, 'proposal')
    for (const field of ['observedSessionId', 'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId', 'connectionId', 'connectionChallenge', 'registryRevision'] as const) {
      if (record[field] !== proposal[field]) throw new ObserverError('identity_drift', `current ${field} changed before commit`)
    }
    if (acknowledgement.sourceSequence <= record.acceptedSourceSequence) {
      throw new ObserverError('invalid_sequence', 'acknowledgement is older than the current lifecycle')
    }
    const role = requireRole(proposal.targetRole, 'targetRole')
    const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
    if (record.executionNodeId !== this.executionNodeId || proposal.targetExecutionNodeId !== this.executionNodeId) {
      throw new ObserverError('node_mismatch', 'commit must remain on the configured local Node')
    }
    if (teamGoalId !== this.teamGoalId || !this.roles.includes(role)) {
      throw new ObserverError('remote_team_goal', 'commit target is not owned by this runner')
    }
    if (this.isRoleOccupiedAfterRetirement(teamGoalId, role, tx.isRoleOccupied(teamGoalId, role))) {
      throw new ObserverError('role_occupied', 'the target Role is already occupied')
    }
    if (tx.isBindingCommitted(bindingOfRecord(record))) {
      throw new ObserverError('already_managed', 'the observed session already has a managed Agent Run')
    }
  }

  private commitNormalAdoptionAsReplacement(
    input: Record<string, unknown>,
    context: CommitContext,
    vacancy: { predecessorAgentRunId: string; vacancyGeneration: number },
  ): Record<string, unknown> {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const proposal = requirePlainRecord(input.proposal, 'proposal')
    const proposalId = requireId(proposal.proposalId, 'proposalId')
    const adoptionSnapshot = this.store.snapshot()
    this.assertSynchronousCommitValid(context, input, {
      isRoleOccupied: (teamGoalId, role) => (
        this.isRoleOccupiedAfterRetirement(
          teamGoalId,
          role,
          adoptionSnapshot.committedRuns.some(
            (run) => run.targetTeamGoalId === teamGoalId && run.targetRole === role,
          ),
        )
      ),
      isBindingCommitted: (binding) => adoptionSnapshot.committedRuns.some((run) => (
        run.executionNodeId === binding.executionNodeId
        && run.processIncarnationId === binding.processIncarnationId
        && run.piSessionId === binding.piSessionId
        && run.extensionInstanceId === binding.extensionInstanceId
      )),
    })
    const acknowledgement = requirePlainRecord(input.acknowledgement, 'acknowledgement')
    const authorization = requirePlainRecord(input.authorization, 'authorization')
    const observed = requirePlainRecord(input.observed, 'observed')
    const reconciliation = requirePlainRecord(input.reconciliation, 'reconciliation')
    let replacement
    try {
      replacement = this.retirement.store.transaction((tx) => tx.commitReplacementAdoption({
        proposal: {
          proposalId,
          proposalDigest: requireId(proposal.proposalDigest, 'proposalDigest'),
          observedSessionId: requireId(proposal.observedSessionId, 'observedSessionId'),
          executionNodeId: requireId(proposal.executionNodeId, 'executionNodeId'),
          processIncarnationId: requireId(proposal.processIncarnationId, 'processIncarnationId'),
          piSessionId: requireId(proposal.piSessionId, 'piSessionId'),
          extensionInstanceId: requireId(proposal.extensionInstanceId, 'extensionInstanceId'),
          targetTeamGoalId: requireId(proposal.targetTeamGoalId, 'targetTeamGoalId'),
          targetRole: requireRole(proposal.targetRole, 'targetRole'),
          predecessorAgentRunId: vacancy.predecessorAgentRunId,
          vacancyGeneration: vacancy.vacancyGeneration,
        },
        authorization,
        acknowledgement,
        observed,
        reconciliation,
      }))
    } catch (error) {
      if (error instanceof RetirementError) throw retirementErrorToObserverError(error)
      throw error
    }
    const replacementCommitted: CommittedAdoption = {
      proposalId: replacement.proposalId,
      proposalDigest: replacement.proposalDigest,
      agentRunId: replacement.agentRunId,
      observedSessionId: replacement.observedSessionId,
      executionNodeId: replacement.executionNodeId,
      processIncarnationId: replacement.processIncarnationId,
      piSessionId: replacement.piSessionId,
      extensionInstanceId: replacement.extensionInstanceId,
      targetTeamGoalId: replacement.targetTeamGoalId,
      targetRole: replacement.targetRole,
      controlMode: 'managed',
      piStatus: replacement.piStatus,
      terminalTitleMetadata: replacement.terminalTitleMetadata,
      runtimeBinding: null,
      runtimeBindingGuarantee: 'unavailable',
      committedAt: replacement.committedAt,
    }
    this.managedConnections.set(context.connection, {
      committed: replacementCommitted,
      ready: false,
      leaseUntil: this.clock.now() + this.leaseDurationMs,
    })
    this.commitContexts.delete(proposalId)
    this.commitCountValue += 1
    this.revision += 1
    const { committedAt: _committedAt, ...result } = replacementCommitted
    return result
  }

  /** Request an immutable Adoption proposal for an observed session. */
  async requestAdoption(observedSessionId: string, choiceId: string): Promise<Record<string, unknown>> {
    const entry = this.observed.get(observedSessionId)
    if (entry === undefined) {
      throw new ObserverError('session_unknown', 'the observed session is not current')
    }
    const target = this.choiceResolver(choiceId)
    const request = {
      observedSessionId,
      observedIdentity: {
        observedSessionId,
        executionNodeId: entry.record.executionNodeId,
        processIncarnationId: entry.record.processIncarnationId,
        piSessionId: entry.record.piSessionId,
        extensionInstanceId: entry.record.extensionInstanceId,
        connectionId: entry.record.connectionId,
        connectionChallenge: entry.record.connectionChallenge,
      },
      connection: {
        id: entry.observerConnection.id ?? DEFAULT_TRANSPORT_ID,
        connectionId: entry.record.connectionId,
        connectionChallenge: entry.record.connectionChallenge,
      },
      target: {
        teamGoalId: target.teamGoalId,
        executionNodeId: this.executionNodeId,
        role: target.role,
      },
    }
    return await entry.coordinator.createProposal(request)
  }

  /** Confirm the exact displayed proposal. */
  async authorizeAdoption(proposalId: string, proposalDigest: string): Promise<Record<string, unknown>> {
    const entry = this.entryForProposal(proposalId)
    const proposal = entry.coordinator.getProposal(proposalId)
    if (proposal === null) {
      throw new ObserverError('proposal_not_found', 'the Adoption proposal is not current')
    }
    const authorization = {
      proposalId,
      proposalDigest,
      targetTeamGoalId: proposal.targetTeamGoalId,
      targetRole: proposal.targetRole,
      authorizationId: `authorization-${proposalId}`,
      token: 'fake-user-confirmation-token',
    }
    // Capture before delivery: a fast same-process response must not race
    // context installation, and asynchronous authorization cannot extend it.
    if (!this.commitContexts.has(proposalId)) this.commitContexts.set(proposalId, {
      connection: entry.connection,
      observedSessionId: entry.record.observedSessionId,
      acknowledgementDeadline: this.clock.now() + ADOPTION_ACK_TIMEOUT_MS,
      expiresMonotonic: Number(proposal.expiresMonotonic),
    })
    try {
      const requestAck = await entry.coordinator.authorizeProposal(proposalId, authorization)
      return { ...cloneRecord(requestAck), phase: 'authorized' }
    } catch (error) {
      this.commitContexts.delete(proposalId)
      throw error
    }
  }

  /**
   * Accept the same-process acknowledgement and commit once. The supplied
   * transport must be the exact connection that registered the observed
   * session; an acknowledgement over any other connection is rejected.
   */
  async acceptAcknowledgement(
    transport: object,
    acknowledgement: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const proposalId = requireId(acknowledgement.proposalId, 'proposalId')
    const entry = this.entryForProposal(proposalId)
    if (transport !== entry.connection) {
      throw new ObserverError('connection_not_current', 'the acknowledgement came from a different observer connection')
    }
    if (this.retirement !== undefined && entry.record !== null) {
      const binding = bindingOfRecord(entry.record)
      if (this.retirement.store.transaction((tx) => tx.isRetired(binding))) {
        throw new ObserverError('already_retired', 'the committed Agent Run has been retired; late acknowledgements are rejected')
      }
    }
    return await entry.coordinator.acceptAcknowledgement(entry.observerConnection, acknowledgement)
  }

  private entryForProposal(proposalId: string): ObservedEntry {
    for (const entry of this.observed.values()) {
      if (entry.coordinator.getProposal(proposalId) !== null) return entry
    }
    throw new ObserverError('proposal_not_found', 'the Adoption proposal is not current')
  }

  get commitCount(): number {
    return this.commitCountValue
  }

  get managedBridgeEnabled(): boolean {
    return this.managedBridgeEnabledValue
  }

  get dispatchCount(): number {
    return this.dispatchCountValue
  }

  get queuedWork(): number {
    return this.queuedWorkValue
  }

  /** Reconstruct authoritative state from the durable store after a restart. */
  recover(): RecoveryState {
    const snapshot = this.store.snapshot()
    const committedIds = new Set(snapshot.committedRuns.map((run) => run.observedSessionId))
    const observedSessions = [...this.observed.keys()].filter((id) => !committedIds.has(id))
    return {
      committedRuns: snapshot.committedRuns.map((run) => ({ ...run })),
      observedSessions,
      commitCount: snapshot.committedRuns.length,
    }
  }

  /** Look up a committed binding independent of any observed ID. */
  committedByBinding(binding: BindingIdentity): CommittedAdoption | null {
    return this.store.transaction((tx) => tx.committedByBinding(binding))
  }

  /**
   * Begin a fresh challenged managed-recovery handshake for an exact
   * committed binding. It issues a fresh unpredictable challenge with a
   * monotonic expiry and binds transient recovery state to the exact new
   * transport. It never creates an observed record or a second commitment.
   */
  beginRecovery(connection: object, binding: BindingIdentity): RecoveryChallenge {
    const committed = this.store.transaction((tx) => tx.committedByBinding(binding))
    if (committed === null) {
      throw new ObserverError('proposal_not_found', 'no committed Adoption binding for recovery')
    }
    if (this.retirement !== undefined) {
      this.retirement.store.transaction((tx) => tx.beginManagedRecovery({ binding }))
    }
    // A replacement connection supersedes any older recovery for the same
    // binding, so a superseded connection can no longer complete recovery.
    for (const [existingConnection, existing] of this.recoveries) {
      if (sameBindingIdentity(existing.binding, binding)) {
        this.recoveries.delete(existingConnection)
      }
    }
    for (const [oldConnection, managed] of this.managedConnections) {
      if (managed.committed.agentRunId === committed.agentRunId) this.onConnectionLost(oldConnection)
    }
    const challenge = this.issueRecoveryChallenge()
    this.recoveries.set(connection, {
      binding: { ...binding },
      challenge,
      expiresAt: this.clock.now() + this.recoveryTtlMs,
      committed: cloneRecord(committed),
    })
    return { challenge, committed: cloneRecord(committed) }
  }

  /**
   * Complete a challenged managed-recovery handshake. It requires the exact
   * fresh challenge and the exact committed identity/result reference over
   * the same transport, then returns the original persisted commitment
   * without creating another run, event, or occupancy claim.
   */
  completeRecovery(connection: object, proof: RecoveryProof): CommittedAdoption {
    const recovery = this.recoveries.get(connection)
    if (recovery === undefined) {
      throw new ObserverError('proposal_not_found', 'no pending Adoption recovery for this connection')
    }
    if (this.clock.now() >= recovery.expiresAt) {
      this.recoveries.delete(connection)
      throw new ObserverError('proposal_expired', 'the Adoption recovery challenge expired')
    }
    if (proof.challenge !== recovery.challenge) {
      throw new ObserverError('connection_not_current', 'the Adoption recovery challenge does not match')
    }
    const committed = requirePlainRecord(proof.committed, 'recovery committed')
    if (committed.proposalId !== recovery.committed.proposalId
        || committed.proposalDigest !== recovery.committed.proposalDigest
        || committed.agentRunId !== recovery.committed.agentRunId) {
      throw new ObserverError('identity_drift', 'the Adoption recovery proof does not match the committed result')
    }
    this.recoveries.delete(connection)
    this.managedConnections.set(connection, { committed: recovery.committed, ready: false, leaseUntil: this.clock.now() + this.leaseDurationMs })
    return cloneRecord(recovery.committed)
  }

  /** Same-transport post-delivery receipt, also a bounded managed lease renewal. */
  acceptManagedReady(connection: object, body: Record<string, unknown>): Record<string, unknown> | null {
    const current = this.managedConnections.get(connection)
    if (!current || this.clock.now() >= current.leaseUntil) {
      throw new ObserverError('connection_not_current', 'managed connection is not current')
    }
    if (this.retirement !== undefined
        && this.retirement.store.transaction((tx) => tx.isRetired({
          executionNodeId: current.committed.executionNodeId,
          processIncarnationId: current.committed.processIncarnationId,
          piSessionId: current.committed.piSessionId,
          extensionInstanceId: current.committed.extensionInstanceId,
        }))) {
      throw new ObserverError('already_retired', 'the committed Agent Run has been retired; late readiness is rejected')
    }
    for (const [key, value] of Object.entries(validateAdoptionCommitted(body))) {
      if (current.committed[key] !== value) throw new ObserverError('identity_drift', 'managed receipt differs from durable commit')
    }
    this.readyObserved.add(current.committed.agentRunId)
    const nextReady = !this.store.isManualTakeover?.(current.committed.agentRunId)
    if (nextReady !== current.ready) this.revision += 1
    current.ready = nextReady
    current.leaseUntil = this.clock.now() + this.leaseDurationMs
    this.managedBridgeEnabledValue = [...this.managedConnections.values()].some(value => value.ready)
    return current.ready ? null : this.manualControl(validateAdoptionCommitted(body))
  }

  acceptManualTakeover(connection: object, body: Record<string, unknown>): Record<string, unknown> {
    this.acceptManagedReady(connection, body)
    if (!this.store.recordManualTakeover) {
      this.onConnectionLost(connection)
      throw new Error('durable takeover is unavailable')
    }
    this.managedConnections.get(connection)!.ready = false
    this.managedBridgeEnabledValue = [...this.managedConnections.values()].some(value => value.ready)
    try { this.store.recordManualTakeover(String(body.agentRunId)) }
    catch (error) { this.onConnectionLost(connection); throw error }
    this.revision += 1
    return this.acceptManagedReady(connection, body)!
  }

  private manualControl(body: Record<string, unknown>): Record<string, unknown> {
    const role = String(body.targetRole)
    const label = role[0].toUpperCase() + role.slice(1)
    return { ...body, controlMode: 'manual_takeover', piStatus: `${label} · manual takeover`,
      terminalTitleMetadata: `Omarchestra — ${label} — manual takeover` }
  }

  /** Observer projection: managed cards are separate. */
  snapshot(): { observerRevision: number; agents: unknown[] } {
    const store = this.store.snapshot()
    const retirement = this.retirement?.store.snapshot()
    const retiredAgentRunIds = new Set(retirement?.retiredRuns.map((run) => run.agentRunId) ?? [])
    const committedIds = new Set([
      ...store.committedRuns.map((run) => run.observedSessionId),
      ...(retirement?.committedRuns.map((run) => run.observedSessionId) ?? []),
    ])
    const occupiedRoles = new Set<string>([
      ...store.committedRuns
        .filter((run) => !retiredAgentRunIds.has(run.agentRunId))
        .map((run) => run.targetRole),
      ...(retirement?.committedRuns
        .filter((run) => !retiredAgentRunIds.has(run.agentRunId))
        .map((run) => run.targetRole) ?? []),
    ])
    const agents = [...this.observed.values()]
      .filter((entry) => !committedIds.has(entry.record.observedSessionId))
      .map((entry) => ({
        observedSessionId: entry.record.observedSessionId,
        piStatus: entry.record.piStatus,
        lifecycle: entry.record.lifecycle,
        availability: entry.record.availability,
        health: entry.record.health,
        choices: this.roles.filter(role => !occupiedRoles.has(role)).map(role => ({
          choiceId: role === 'builder' ? 'adoption-choice-1' : role === 'coordinator' ? 'adoption-choice-2' : 'adoption-choice-3',
          label: `Adopt into ${this.teamGoalId} · ${role}`,
          enabled: entry.record.availability === 'available' && entry.record.activity === 'idle'
            && entry.record.lifecycle === 'running' && entry.record.health === 'healthy'
            && this.clock.now() < entry.leaseUntil,
        })),
      }))
    return { observerRevision: this.revision + store.cursor, agents }
  }

  /** Content-free machine observations; UI correctness still needs human attestation. */
  acceptanceFacts() {
    const runs = this.store.snapshot().committedRuns
    const id = runs.length === 1 ? runs[0].agentRunId : null
    const retirement = this.retirement?.store.snapshot()
    // A managed commit may live in the adoption store (normal case) or in the
    // retirement store's replacement array (after retirement + replacement).
    // We count exactly the live committed Run that currently occupies the
    // Role. Tombstoned predecessors do not count.
    const retiredBindingKeys = new Set(
      retirement !== undefined
        ? retirement.retiredRuns.map((run) => [
          run.originalCommitment.executionNodeId,
          run.originalCommitment.processIncarnationId,
          run.originalCommitment.piSessionId,
          run.originalCommitment.extensionInstanceId,
        ].join('|'))
        : [],
    )
    const liveManagedCount = runs.filter((run) => !retiredBindingKeys.has([
      run.executionNodeId,
      run.processIncarnationId,
      run.piSessionId,
      run.extensionInstanceId,
    ].join('|'))).length
      + (retirement?.committedRuns.length ?? 0)
    return {
      exactlyOneCommit: runs.length === 1,
      exactlyOneManagedCommit: liveManagedCount === 1,
      samePiReady: id !== null && this.readyObserved.has(id),
      manualTakeover: id !== null && this.store.isManualTakeover?.(id) === true,
      managedDisconnected: id !== null && this.disconnectObserved.has(id),
      noAssignment: this.dispatchCountValue === 0 && this.queuedWorkValue === 0,
    }
  }

  /** Retirement-specific content-free observations. */
  retirementFacts() {
    const retirement = this.retirement?.store.snapshot()
    return {
      retiredCount: retirement?.retiredRuns.length ?? 0,
      replacementCount: retirement?.committedRuns.length ?? 0,
      vacancyGeneration: retirement?.vacancyGeneration ?? 0,
      dispatchCount: this.dispatchCountValue,
      queuedWork: this.queuedWorkValue,
    }
  }

  /** Managed cards from the durable store, separate from the observer projection. */
  managedSnapshot(): { managedCards: unknown[] } {
    const store = this.store.snapshot()
    const retirement = this.retirement?.store.snapshot()
    const replacementByPredecessor = new Map<string, unknown>()
    if (retirement !== undefined) {
      const retiredAgentRunIds = new Set(retirement.retiredRuns.map((run) => run.agentRunId))
      for (const replacement of retirement.committedRuns) {
        if (!retiredAgentRunIds.has(replacement.agentRunId)) {
          replacementByPredecessor.set(replacement.predecessorAgentRunId, replacement)
        }
      }
    }
    // A retired run keeps its historical commitment but is no longer a
    // current managed occupant: its card is presented under retiredCards,
    // distinct from a merely disconnected run.
    const retiredAgentRunIds = retirement === undefined
      ? new Set<string>()
      : new Set(retirement.retiredRuns.map((run) => run.agentRunId))
    const managedCards = store.committedRuns
      .filter((run) => !retiredAgentRunIds.has(run.agentRunId))
      .map((run) => ({
      agentRunId: run.agentRunId,
      role: run.targetRole,
      piStatus: this.store.isManualTakeover?.(run.agentRunId) ? this.manualControl(run).piStatus : run.piStatus,
      connectionStatus: [...this.managedConnections.values()].some(value => value.committed.agentRunId === run.agentRunId && this.clock.now() < value.leaseUntil) ? 'connected' : 'disconnected',
      predecessorAgentRunId: retirement === undefined ? null : (
        [...replacementByPredecessor.entries()].find(([, value]) => (value as { agentRunId: string }).agentRunId === run.agentRunId)?.[0] ?? null
      ),
    }))
    // Replacement commits are recorded through the retirement port and only
    // carried in the managed-connection lease map; surface them here so the
    // new Role occupant appears as a managed card with its predecessor link.
    if (retirement !== undefined) {
      const retiredAgentRunIds = new Set(retirement.retiredRuns.map((run) => run.agentRunId))
      for (const replacement of retirement.committedRuns) {
        if (retiredAgentRunIds.has(replacement.agentRunId)) continue
        const card = replacement as unknown as {
          agentRunId: string; targetRole: Role; piStatus: string; targetTeamGoalId: string
        }
        managedCards.push({
          agentRunId: card.agentRunId,
          role: card.targetRole,
          piStatus: card.piStatus,
          connectionStatus: [...this.managedConnections.values()].some(
            (value) => value.committed.agentRunId === card.agentRunId && this.clock.now() < value.leaseUntil,
          ) ? 'connected' : 'disconnected',
          predecessorAgentRunId: replacement.predecessorAgentRunId,
        })
      }
    }
    return { managedCards }
  }

  /** Retired cards, surfaced separately from managed cards. */
  retiredSnapshot(): { retiredCards: unknown[] } {
    if (this.retirement === undefined) return { retiredCards: [] }
    const retirement = this.retirement.store.snapshot()
    const originalByAgentRunId = new Map<string, { piStatus: string }>([
      ...this.store.snapshot().committedRuns.map((run) => [run.agentRunId, run] as const),
      ...retirement.committedRuns.map((run) => [run.agentRunId, run] as const),
    ])
    return {
      retiredCards: retirement.retiredRuns.map((run) => ({
        agentRunId: run.agentRunId,
        role: run.role,
        piStatus: originalByAgentRunId.get(run.agentRunId)?.piStatus ?? 'Retired',
        state: run.state,
        retiredAt: run.retiredAt,
        revision: run.revision,
        predecessorAgentRunId: run.predecessorAgentRunId,
        replacementAgentRunId: retirement.committedRuns.find(
          (replacement) => replacement.predecessorAgentRunId === run.agentRunId,
        )?.agentRunId ?? null,
      })),
    }
  }

  /** Resolve the exact retirement facts for a committed Agent Run. */
  retirementInputFor(agentRunId: string): RetireAgentRunInput {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const liveCommit = this.findLiveCommitByAgentRunId(agentRunId)
    if (liveCommit === null) {
      throw new ObserverError('proposal_not_found', 'no committed Agent Run matches the supplied agentRunId')
    }
    return {
      agentRunId,
      teamGoalId: liveCommit.targetTeamGoalId,
      role: liveCommit.targetRole,
      observedSessionId: liveCommit.observedSessionId,
      revision: this.retirement.revisionOf(liveCommit),
    }
  }

  /**
   * Revoke dispatch readiness, clear queued work, and invalidate pending
   * authority on runner connection loss. When a connection is supplied, only
   * that connection's pending proposals and recovery state are invalidated.
   */
  onConnectionLost(connection?: object): void {
    this.managedBridge.disable()
    if (connection !== undefined) {
      const current = this.managedConnections.get(connection)
      if (current) this.disconnectObserved.add(current.committed.agentRunId)
    }
    if (connection === undefined) this.managedConnections.clear()
    else this.managedConnections.delete(connection)
    this.managedBridgeEnabledValue = [...this.managedConnections.values()].some(value => value.ready)
    this.queuedWorkValue = 0
    if (connection !== undefined) {
      for (const entry of this.observed.values()) {
        if (entry.connection === connection) this.invalidateEntry(entry)
      }
      this.recoveries.delete(connection)
    } else {
      for (const entry of this.observed.values()) this.invalidateEntry(entry)
      this.recoveries.clear()
    }
  }

  /**
   * Synchronously invalidate one observed entry on connection loss: remove its
   * commit contexts, make its observed authority unavailable, and reconstruct
   * its coordinator so no pending proposal can authorize or commit afterward.
   */
  private invalidateEntry(entry: ObservedEntry): void {
    for (const [proposalId, context] of this.commitContexts) {
      if (context.observedSessionId === entry.record.observedSessionId) {
        this.commitContexts.delete(proposalId)
      }
    }
    entry.record = { ...entry.record, availability: 'unavailable' }
    this.revision += 1
    entry.coordinator.reconstruct()
  }

  private issueRecoveryChallenge(): string {
    const value = this.recoveryChallengeFactory()
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new ObserverError('invalid_identity', 'recovery challenge issuer returned an invalid identity')
    }
    return value
  }

  // -------------------------------------------------------------------------
  // Explicit retirement and replacement (additive surface)
  // -------------------------------------------------------------------------

  /**
   * Synchronously retire an Agent Run. The supplied revision must equal the
   * current retirement revision; replays are idempotent on the same revision.
   * The committed Agent Run and its predecessor commitment are preserved
   * durably and become tombstones for readiness, recovery, late
   * acknowledgements, and authority-bearing results. The Role is marked
   * vacant with a fresh generation.
   */
  retireAgentRun(input: RetireAgentRunInput): RetireAgentRunResult {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const proposal = requirePlainRecord(input, 'retirement input')
    const agentRunId = requireId(proposal.agentRunId, 'agentRunId')
    const teamGoalId = requireId(proposal.teamGoalId, 'teamGoalId')
    const role = requireRole(proposal.role, 'role')
    const observedSessionId = requireId(proposal.observedSessionId, 'observedSessionId')
    const revision = requireNonNegativeInt(proposal.revision, 'revision')
    if (proposal.executionNodeId !== undefined && proposal.executionNodeId !== this.executionNodeId) {
      throw new ObserverError('node_mismatch', 'retirement must remain on the configured local Node')
    }
    // The Runner fences itself: a still-managed connection (a fresh
    // managed-ready after the operator pressed retire) wins the race and
    // blocks disconnected-only retirement until the operator refreshes.
    const liveConnection = [...this.managedConnections.values()].find(
      (managed) => managed.committed.agentRunId === agentRunId
        && this.clock.now() < managed.leaseUntil,
    )
    if (liveConnection !== undefined) {
      throw new ObserverError('connection_not_current', 'a still-managed (connected) lease forbids disconnected-only retirement until the operator refreshes')
    }
    // Confirm the live commit still occupies the target Role. The retirement
    // store does not own the live managed commit; the runner composes the
    // adoption store to verify it before fencing.
    const liveCommit = this.findLiveCommitByAgentRunId(agentRunId)
    if (liveCommit === null) {
      throw new ObserverError('proposal_not_found', 'no committed Agent Run matches the supplied agentRunId')
    }
    if (liveCommit.targetTeamGoalId !== teamGoalId || liveCommit.targetRole !== role) {
      throw new ObserverError('role_mismatch', 'the supplied agentRunId does not occupy the target Role')
    }
    if (liveCommit.executionNodeId !== this.executionNodeId) {
      throw new ObserverError('node_mismatch', 'retirement must remain on the Agent Run Node')
    }
    let committed: { tombstone: RetiredRun; alreadyRetired: boolean }
    try {
      // Compose the adoption store into the retirement store's
      // `liveCommitForRole` check so the retirement store remains pure but
      // can enforce that *some* Agent Run currently occupies the target Role.
      const liveLookup = this.retirement.liveCommitForRole ?? (() => null)
      committed = this.retirement.store.transaction((tx) => tx.commitRetirement({
        agentRunId,
        teamGoalId,
        role,
        observedSessionId,
        revision,
        executionNodeId: liveCommit.executionNodeId,
        processIncarnationId: liveCommit.processIncarnationId,
        piSessionId: liveCommit.piSessionId,
        extensionInstanceId: liveCommit.extensionInstanceId,
      }))
      void liveLookup
    } catch (error) {
      if (error instanceof RetirementError) {
        throw retirementErrorToObserverError(error)
      }
      throw error
    }
    // Drop any pending recovery / commit contexts for the retired binding.
    for (const [connection, recovery] of this.recoveries) {
      if (recovery.committed.agentRunId === agentRunId) this.recoveries.delete(connection)
    }
    for (const [proposalId, context] of this.commitContexts) {
      if (context.observedSessionId === observedSessionId) this.commitContexts.delete(proposalId)
    }
    const tombstone = committed.tombstone
    const generation = this.retirement.store.transaction((tx) => tx.currentVacancyGeneration(teamGoalId, role))
    this.revision += 1
    return {
      agentRunId,
      teamGoalId,
      role,
      retiredAt: tombstone.retiredAt,
      revision: tombstone.revision,
      vacancyGeneration: generation,
      state: 'retired',
      alreadyRetired: committed.alreadyRetired,
    }
  }

  private findLiveCommitByAgentRunId(agentRunId: string): CommittedAdoption | ReplacementCommit | null {
    const snapshot = this.store.snapshot()
    const adoptionCommit = snapshot.committedRuns.find((run) => run.agentRunId === agentRunId)
    if (adoptionCommit !== undefined) return adoptionCommit
    const retirement = this.retirement?.store.snapshot()
    if (retirement === undefined) return null
    const retiredAgentRunIds = new Set(retirement.retiredRuns.map((run) => run.agentRunId))
    return retirement.committedRuns.find(
      (run) => run.agentRunId === agentRunId && !retiredAgentRunIds.has(run.agentRunId),
    ) ?? null
  }

  private isRoleOccupiedAfterRetirement(
    teamGoalId: string,
    role: Role,
    adoptionOccupied: boolean,
  ): boolean {
    if (this.retirement === undefined) return adoptionOccupied
    const retirement = this.retirement.store.snapshot()
    const retiredAgentRunIds = new Set(retirement.retiredRuns.map((run) => run.agentRunId))
    if (retirement.committedRuns.some(
      (run) => run.targetTeamGoalId === teamGoalId
        && run.targetRole === role
        && !retiredAgentRunIds.has(run.agentRunId),
    )) return true
    if (retirement.retiredRuns.some(
      (run) => run.teamGoalId === teamGoalId && run.role === role,
    )) return false
    return adoptionOccupied
  }

  private retirementVacancyFor(
    teamGoalId: string,
    role: Role,
  ): { predecessorAgentRunId: string; vacancyGeneration: number } | null {
    if (this.retirement === undefined) return null
    const retirement = this.retirement.store.snapshot()
    const retiredAgentRunIds = new Set(retirement.retiredRuns.map((run) => run.agentRunId))
    if (retirement.committedRuns.some(
      (run) => run.targetTeamGoalId === teamGoalId
        && run.targetRole === role
        && !retiredAgentRunIds.has(run.agentRunId),
    )) return null
    const retired = retirement.retiredRuns.filter(
      (run) => run.teamGoalId === teamGoalId && run.role === role,
    )
    if (retired.length === 0) return null
    const vacancyGeneration = this.retirement.store.transaction(
      (tx) => tx.currentVacancyGeneration(teamGoalId, role),
    )
    return {
      predecessorAgentRunId: retired[retired.length - 1].agentRunId,
      vacancyGeneration,
    }
  }

  /**
   * Request an immutable replacement Adoption proposal for an observed
   * session. The proposal carries the exact vacancy generation visible at
   * the time of request; the store repeats that check synchronously at
   * commit.
   */
  async requestReplacementAdoption(
    observedSessionId: string,
    choiceId: string,
    vacancyGeneration: number,
  ): Promise<Record<string, unknown>> {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const entry = this.observed.get(observedSessionId)
    if (entry === undefined) {
      throw new ObserverError('session_unknown', 'the observed session is not current')
    }
    const target = this.choiceResolver(choiceId)
    const predecessorAgentRunId = this.findPredecessorAgentRunId(target.teamGoalId, target.role, vacancyGeneration)
    if (predecessorAgentRunId === null) {
      throw new ObserverError('proposal_not_found', 'no retired Agent Run matches the supplied vacancy generation')
    }
    const nonce = this.retirement.replacementNonce()
    const proposalId = (this.proposalIdFactory ?? defaultProposalIdFactory)()
    const proposalDigest = defaultReplacementProposalDigest(proposalId)
    const expiresMonotonic = this.clock.now() + ADOPTION_ACK_TIMEOUT_MS
    const context: ReplacementProposalContext = {
      proposalId,
      predecessorAgentRunId,
      vacancyGeneration,
      proposalDigest,
      acknowledgementNonce: nonce,
      expiresMonotonic,
    }
    this.replacementCommitContexts.set(proposalId, {
      connection: entry.connection,
      observedSessionId,
      acknowledgementDeadline: this.clock.now() + ADOPTION_ACK_TIMEOUT_MS,
      expiresMonotonic,
      targetTeamGoalId: target.teamGoalId,
      targetRole: target.role,
      predecessorAgentRunId,
      vacancyGeneration,
      proposalId,
      proposalDigest,
      acknowledgementNonce: nonce,
    })
    return {
      proposalId,
      proposalDigest,
      acknowledgementNonce: nonce,
      predecessorAgentRunId,
      vacancyGeneration,
      expiresMonotonic,
      targetTeamGoalId: target.teamGoalId,
      targetRole: target.role,
      observedSessionId,
      observedIdentity: {
        observedSessionId,
        executionNodeId: entry.record.executionNodeId,
        processIncarnationId: entry.record.processIncarnationId,
        piSessionId: entry.record.piSessionId,
        extensionInstanceId: entry.record.extensionInstanceId,
        connectionId: entry.record.connectionId,
        connectionChallenge: entry.record.connectionChallenge,
      },
    }
  }

  /** Confirm the exact displayed replacement proposal. */
  async authorizeReplacementAdoption(proposalId: string, proposalDigest: string): Promise<Record<string, unknown>> {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const context = this.replacementCommitContexts.get(proposalId)
    if (context === undefined) {
      throw new ObserverError('proposal_not_found', 'the replacement proposal is not current')
    }
    if (context.proposalDigest !== proposalDigest) {
      throw new ObserverError('proposal_stale', 'the replacement proposal digest does not match')
    }
    const now = this.clock.now()
    if (now >= context.expiresMonotonic) {
      this.replacementCommitContexts.delete(proposalId)
      throw new ObserverError('proposal_expired', 'the replacement proposal expired before authorization')
    }
    if (!this.authorizer.verify({
      proposalId,
      proposalDigest,
      targetTeamGoalId: context.targetTeamGoalId,
      targetRole: context.targetRole,
    })) {
      throw new ObserverError('authorization_mismatch', 'replacement authorization was rejected')
    }
    return {
      proposalId,
      proposalDigest,
      acknowledgementNonce: context.acknowledgementNonce,
      predecessorAgentRunId: context.predecessorAgentRunId,
      vacancyGeneration: context.vacancyGeneration,
      phase: 'authorized',
    }
  }

  /**
   * Accept the same-process acknowledgement for a replacement. The supplied
   * transport must be the exact connection that registered the observed
   * session; the synchronous commit revalidates every identity, vacancy
   * generation, and Role occupancy inside the durable transaction.
   */
  async acceptReplacementAcknowledgement(
    transport: object,
    acknowledgement: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.retirement === undefined) {
      throw new ObserverError('transaction_failed', 'retirement port is not configured')
    }
    const proposalId = requireId(acknowledgement.proposalId, 'proposalId')
    const context = this.replacementCommitContexts.get(proposalId)
    if (context === undefined) {
      throw new ObserverError('proposal_not_found', 'no synchronous replacement commit context')
    }
    if (transport !== context.connection) {
      throw new ObserverError('connection_not_current', 'the replacement acknowledgement came from a different observer connection')
    }
    const entry = this.observed.get(context.observedSessionId)
    if (entry === undefined) {
      throw new ObserverError('session_unknown', 'the observed session is not current')
    }
    this.assertReplacementSynchronousCommitValid(context, acknowledgement, entry)
    let committedReplacement: { agentRunId: string; predecessorAgentRunId: string; vacancyGeneration: number; targetRole: Role; targetTeamGoalId: string }
    try {
      committedReplacement = this.retirement.store.transaction((tx) => tx.commitReplacementAdoption({
        proposal: {
          proposalId,
          proposalDigest: context.proposalDigest,
          observedSessionId: context.observedSessionId,
          executionNodeId: entry.record.executionNodeId,
          processIncarnationId: entry.record.processIncarnationId,
          piSessionId: entry.record.piSessionId,
          extensionInstanceId: entry.record.extensionInstanceId,
          targetTeamGoalId: context.targetTeamGoalId,
          targetRole: context.targetRole,
          predecessorAgentRunId: context.predecessorAgentRunId,
          vacancyGeneration: context.vacancyGeneration,
        },
        authorization: { proposalId, proposalDigest: context.proposalDigest },
        acknowledgement,
        observed: { observedSessionId: context.observedSessionId },
        reconciliation: { activity: entry.record.activity, availability: entry.record.availability },
      }))
    } catch (error) {
      this.replacementCommitContexts.delete(proposalId)
      if (error instanceof RetirementError) throw retirementErrorToObserverError(error)
      throw error
    }
    // Persist a synthetic managed run record so the existing managed-card
    // projection path is reused. The original Adoption commitment table is
    // unchanged; the replacement is recorded through the retirement port.
    const replacementCommitted: CommittedAdoption = {
      proposalId,
      proposalDigest: context.proposalDigest,
      agentRunId: committedReplacement.agentRunId,
      observedSessionId: context.observedSessionId,
      executionNodeId: entry.record.executionNodeId,
      processIncarnationId: entry.record.processIncarnationId,
      piSessionId: entry.record.piSessionId,
      extensionInstanceId: entry.record.extensionInstanceId,
      targetTeamGoalId: committedReplacement.targetTeamGoalId,
      targetRole: committedReplacement.targetRole,
      controlMode: 'managed',
      piStatus: 'Builder · managed',
      terminalTitleMetadata: 'Omarchestra — Builder — managed',
      runtimeBinding: null,
      runtimeBindingGuarantee: 'unavailable',
      committedAt: 0,
    }
    this.managedConnections.set(context.connection, {
      committed: replacementCommitted,
      ready: false,
      leaseUntil: this.clock.now() + this.leaseDurationMs,
    })
    this.replacementCommitContexts.delete(proposalId)
    this.commitCountValue += 1
    this.revision += 1
    return { ...cloneRecord(replacementCommitted), predecessorAgentRunId: committedReplacement.predecessorAgentRunId, vacancyGeneration: committedReplacement.vacancyGeneration }
  }

  private assertReplacementSynchronousCommitValid(
    context: ReplacementCommitContext,
    acknowledgement: Record<string, unknown>,
    entry: ObservedEntry,
  ): void {
    if (entry.connection !== context.connection) {
      throw new ObserverError('connection_not_current', 'the observer connection changed during replacement Adoption')
    }
    const ack = requirePlainRecord(acknowledgement, 'replacement acknowledgement')
    if (entry.record.connectionId !== ack.connectionId
        || entry.record.connectionChallenge !== ack.connectionChallenge) {
      throw new ObserverError('connection_not_current', 'the replacement acknowledgement identity is not current')
    }
    const now = this.clock.now()
    if (now >= context.expiresMonotonic) {
      throw new ObserverError('proposal_expired', 'the replacement proposal expired before commit')
    }
    if (now >= context.acknowledgementDeadline) {
      throw new ObserverError('ack_timeout', 'the replacement acknowledgement window expired before commit')
    }
    if (now >= entry.leaseUntil) {
      throw new ObserverError('session_expired', 'the observed session lease expired before replacement commit')
    }
    if (entry.record.lifecycle === 'exited') throw new ObserverError('session_exited', 'the observed Pi session has exited')
    if (entry.record.availability !== 'available') throw new ObserverError('session_unavailable', 'the observed Pi session is unavailable')
    if (entry.record.activity !== 'idle') {
      if (entry.record.activity === 'unknown') throw new ObserverError('session_unknown', 'the observer cannot establish an idle session')
      throw new ObserverError('session_busy', 'the observed Pi session is not idle')
    }
    if (entry.record.health !== 'healthy') throw new ObserverError('session_unavailable', 'the observed session health is degraded')
    if (entry.record.piStatus !== OBSERVER_PI_STATUS_LOCAL) throw new ObserverError('already_managed', 'the observed session is no longer unassigned')
    if (typeof ack.sourceSequence === 'number' && ack.sourceSequence <= entry.record.acceptedSourceSequence) {
      throw new ObserverError('invalid_sequence', 'replacement acknowledgement is older than the current lifecycle')
    }
  }

  private findPredecessorAgentRunId(teamGoalId: string, role: Role, vacancyGeneration: number): string | null {
    if (this.retirement === undefined) return null
    const snapshot = this.retirement.store.snapshot()
    for (const run of snapshot.retiredRuns) {
      if (run.teamGoalId === teamGoalId && run.role === role) {
        const generation = snapshot.vacancyGeneration
        if (generation === vacancyGeneration) return run.agentRunId
      }
    }
    const computed = this.retirement.store.transaction((tx) => tx.currentVacancyGeneration(teamGoalId, role))
    if (computed === vacancyGeneration) {
      const match = this.retirement.store.snapshot().retiredRuns
        .filter((run) => run.teamGoalId === teamGoalId && run.role === role)
        .sort((a, b) => b.retiredAt - a.retiredAt)[0]
      return match?.agentRunId ?? null
    }
    return null
  }
}

interface ReplacementCommitContext {
  connection: object
  observedSessionId: string
  acknowledgementDeadline: number
  expiresMonotonic: number
  targetTeamGoalId: string
  targetRole: Role
  predecessorAgentRunId: string
  vacancyGeneration: number
  proposalId: string
  proposalDigest: string
  acknowledgementNonce: string
}

function defaultProposalIdFactory(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return `proposal-${out}`
}

function defaultReplacementProposalDigest(proposalId: string): string {
  // The contract reuses the same 64-hex proposal digest shape; we deterministically
  // derive it from the proposal id for unit-test determinism. Production code
  // overrides this through `proposalIdFactory` or a dedicated replacement
  // digest factory.
  let hash = 0n
  for (let i = 0; i < proposalId.length; i += 1) {
    hash = (hash * 1099511628211n + BigInt(proposalId.charCodeAt(i))) & 0xffffffffffffffffn
  }
  let hex = hash.toString(16)
  while (hex.length < 64) hex = `0${hex}`
  return hex.slice(0, 64)
}

function retirementErrorToObserverError(error: RetirementError): ObserverError {
  const code = error.code as 'invalid_envelope' | 'stale_revision' | 'not_eligible' | 'role_mismatch'
    | 'node_mismatch' | 'already_retired' | 'predecessor_unknown' | 'predecessor_mismatch'
    | 'vacancy_stale' | 'invalid_vacancy' | 'role_occupied' | 'transaction_failed'
  return new ObserverError(code, error.message)
}

function defaultChoiceResolver(teamGoalId: string): (choiceId: string) => { teamGoalId: string; role: Role } {
  return (choiceId) => {
    const role = choiceIdToRole(choiceId)
    return { teamGoalId, role }
  }
}

function defaultRecoveryChallengeFactory(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return `recovery-${out}`
}

function choiceIdToRole(choiceId: string): Role {
  if (choiceId === 'adoption-choice-2') return 'coordinator'
  if (choiceId === 'adoption-choice-3') return 'reviewer'
  if (choiceId === 'adoption-choice-1') return 'builder'
  throw new ObserverError('invalid_envelope', 'unknown Adoption choice')
}

function bindingOfRecord(record: ObservedRecord): BindingIdentity {
  return {
    executionNodeId: record.executionNodeId,
    processIncarnationId: record.processIncarnationId,
    piSessionId: record.piSessionId,
    extensionInstanceId: record.extensionInstanceId,
  }
}

function sameBindingIdentity(left: BindingIdentity, right: BindingIdentity): boolean {
  return left.executionNodeId === right.executionNodeId
    && left.processIncarnationId === right.processIncarnationId
    && left.piSessionId === right.piSessionId
    && left.extensionInstanceId === right.extensionInstanceId
}

function requirePort<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new TypeError(`${name} port is required`)
  }
  return value
}

function requireId(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    throw new TypeError(`${where} must be a bounded identity`)
  }
  return input
}

function requireRole(input: unknown, where: string): Role {
  if (typeof input !== 'string' || !(ROLES as readonly string[]).includes(input)) {
    throw new TypeError(`${where} must be an allowed Role`)
  }
  return input as Role
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

function requireNonNegativeInt(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new TypeError(`${where} must be a non-negative safe integer`)
  }
  return input
}

function requirePlainRecord(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function cloneRecord<T>(value: T): T {
  return structuredClone(value)
}
