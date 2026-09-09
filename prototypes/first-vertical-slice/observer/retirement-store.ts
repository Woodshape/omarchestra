/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * retirement-store.ts — the pure transactional contract for explicit
 * retirement and replacement. It extends the existing single
 * `LiveAdoptionRunner` authority by adding a small durability port the runner
 * owns. It performs no I/O and imports neither QML nor SQLite; the durable
 * adapter is supplied by the caller (see manual/live-adoption-store.ts and
 * the dedicated SQLite retirement schema in the same file).
 *
 * Contract invariants (from docs/plans/explicit-retirement-replacement.md):
 *
 * - Retired commitment identities are tombstones while history is retained.
 *   After explicit purge, a minimal exact-binding fence remains and continues
 *   to forbid registration, readiness, recovery, late acknowledgements, and
 *   authority-bearing results even when the same binding returns with a fresh
 *   observed session id.
 * - Each Role carries an independent vacancy generation. A replacement
 *   proposal must carry the exact generation visible at proposal time. The
 *   store repeats that check synchronously inside the durable transaction.
 * - A successful replacement records a `predecessorAgentRunId` link to the
 *   retired Run. The predecessor commitment is never mutated by replacement;
 *   repeated retirement remains idempotent on the same revision.
 * - Failure before durable retirement rolls back without a vacancy. Failure
 *   after durable retirement cannot resurrect the predecessor.
 */

import { randomBytes } from 'node:crypto'

import { ROLES, isBoundedId, type Role } from '../src/protocol.ts'
import type { BindingIdentity, CommittedAdoption } from './live-adoption-store.ts'

export const RETIREMENT_STORE_MAX_RETIRED = 64
export const RETIREMENT_STORE_MAX_RUNS = 64

/**
 * The durable retirement tombstone. `originalCommitment` is preserved
 * unchanged so historical Adoption commitments remain immutable. The fields
 * here record only the orchestration transition.
 */
export interface RetiredRun {
  agentRunId: string
  teamGoalId: string
  role: Role
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  retiredAt: number
  revision: number
  predecessorAgentRunId: string | null
  originalCommitment: BindingIdentity
  state: 'retired'
}

/**
 * A replacement commit is a normal CommittedAdoption plus an explicit
 * `predecessorAgentRunId` and an exact `vacancyGeneration`. Both are
 * recorded durably and never change.
 */
export interface ReplacementCommit extends CommittedAdoption {
  predecessorAgentRunId: string
  vacancyGeneration: number
}

export interface RetirementStoreSnapshot {
  retiredRuns: RetiredRun[]
  committedRuns: ReplacementCommit[]
  /** Minimal non-presented fences retained after history purge. */
  purgedBindings?: BindingIdentity[]
  vacancyGeneration: number
  /** Optional per-(Team Goal, Role) high-water marks for restart reconstruction. */
  vacancyGenerations?: Record<string, number>
  events: RetirementEvent[]
  cursor: number
}

export interface RetirementEvent {
  sequence: number
  type: 'retired' | 'replaced'
  agentRunId: string
  teamGoalId: string
  role: Role
  predecessorAgentRunId: string | null
  vacancyGeneration: number
}

export interface RetirementEligibilityInput {
  agentRunId: string
  teamGoalId: string
  role: Role
  observedSessionId: string
  revision: number
  executionNodeId?: string
  /** The full binding identity of the live commit, supplied by the runner. */
  processIncarnationId?: string
  piSessionId?: string
  extensionInstanceId?: string
}

export interface CommitRetirementInput extends RetirementEligibilityInput {}

export interface ReplacementProposalInput {
  proposalId: string
  proposalDigest: string
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  targetTeamGoalId: string
  targetRole: Role
  predecessorAgentRunId: string
  vacancyGeneration: number
}

export interface ReplacementAdoptionInput {
  proposal: ReplacementProposalInput | Record<string, unknown>
  authorization: Record<string, unknown>
  acknowledgement: Record<string, unknown>
  observed: Record<string, unknown>
  reconciliation: Record<string, unknown>
}

/**
 * The transactional retirement port. The runner calls into this port from
 * its synchronous commit boundary; no async yield is permitted.
 */
/**
 * Mutable, transaction-scoped retirement operations. Each method runs inside
 * the store's serial transaction; calling a mutation outside `transaction`
 * returns undefined so the runner can verify the chain of custody before
 * mutating durable state.
 */
export interface RetirementTransaction {
  isRetired(binding: BindingIdentity): boolean
  isRoleVacant(teamGoalId: string, role: Role): boolean
  currentVacancyGeneration(teamGoalId: string, role: Role): number
  retriedByBinding(binding: BindingIdentity): RetiredRun | null
  assertCommitRetirementEligible(input: RetirementEligibilityInput): void
  commitRetirement(input: CommitRetirementInput): { tombstone: RetiredRun; alreadyRetired: boolean }
  commitReplacementAdoption(input: ReplacementAdoptionInput): ReplacementCommit
  registerObservedIfUnretired(input: BindingIdentity & { observedSessionId: string }): void
  beginManagedRecovery(input: { binding: BindingIdentity }): void
  revertRetirement(input: { agentRunId: string; revision: number }): void
  purgeRetiredRun(agentRunId: string): void
}

export interface RetirementStore {
  transaction<T>(operation: (tx: RetirementTransaction) => T): T
  snapshot(): RetirementStoreSnapshot
  close(): void
  purgeRetiredRun(agentRunId: string): void
}

export interface InMemoryRetirementStoreOptions {
  initialState?: RetirementStoreSnapshot
  agentRunIdFactory?: () => string
  /**
   * Optional hook the test fixture wires up to simulate the adoption store.
   * When set, `commitRetirement` consults the hook to verify the supplied
   * Agent Run actually occupies the target Role.
   */
  liveCommitForRole?: (teamGoalId: string, role: Role) => { agentRunId: string } | null
}

/**
 * Disposable in-memory implementation of the retirement store. The durable
 * SQLite adapter lives in `manual/live-adoption-store.ts` and shares the same
 * interface. Both are exercised by the red/green gate.
 *
 * The store enforces:
 *
 * - unique binding identity (one retirement per process/session/extension);
 * - unique (teamGoalId, role) retirement (no double retirement of the same
 *   Role until a replacement commits);
 * - vacancy generation is bumped on retirement and on re-retirement of a
 *   replacement;
 * - replacement proposals must carry the exact current generation;
 * - retired history may be purged only for a leaf; its exact binding fence
 *   remains outside the presented historical records.
 */
export function createInMemoryRetirementStore(options: InMemoryRetirementStoreOptions = {}): RetirementStore {
  const initial = options.initialState
  let retired: RetiredRun[] = initial ? initial.retiredRuns.map(cloneRetired) : []
  let committed: ReplacementCommit[] = initial ? initial.committedRuns.map(cloneReplacement) : []
  let purgedBindings: BindingIdentity[] = initial?.purgedBindings?.map(cloneBinding) ?? []
  let events: RetirementEvent[] = initial ? initial.events.map(cloneEvent) : []
  let cursor = initial ? initial.cursor : 0
  const vacancyHighWater = new Map<string, number>()
  const vacancyKey = (teamGoalId: string, role: Role): string => `${teamGoalId}|${role}`
  if (initial?.vacancyGenerations !== undefined) {
    for (const [key, value] of Object.entries(initial.vacancyGenerations)) {
      if (Number.isSafeInteger(value) && value >= 0) vacancyHighWater.set(key, value)
    }
  } else {
    for (const run of retired) {
      const key = vacancyKey(run.teamGoalId, run.role)
      const next = (vacancyHighWater.get(key) ?? 0) + (run.predecessorAgentRunId === null ? 1 : 2)
      vacancyHighWater.set(key, next)
    }
  }
  const agentRunIdFactory = options.agentRunIdFactory
    ?? (() => `agent-run-${randomBytes(16).toString('hex')}`)
  const liveCommitForRole = options.liveCommitForRole

  const bindingKey = (binding: BindingIdentity): string => (
    `${binding.executionNodeId}|${binding.processIncarnationId}|${binding.piSessionId}|${binding.extensionInstanceId}`
  )

  const tx: RetirementTransaction = {
    isRetired: (binding) => retired.some((run) => (
      run.originalCommitment.executionNodeId === binding.executionNodeId
      && run.originalCommitment.processIncarnationId === binding.processIncarnationId
      && run.originalCommitment.piSessionId === binding.piSessionId
      && run.originalCommitment.extensionInstanceId === binding.extensionInstanceId
    )) || purgedBindings.some((fence) => bindingKey(fence) === bindingKey(binding)),
    isRoleVacant: (teamGoalId, role) => {
      const retiredAgentRunIds = new Set(retired.map((run) => run.agentRunId))
      return !committed.some(
        (run) => run.targetTeamGoalId === teamGoalId
          && run.targetRole === role
          && !retiredAgentRunIds.has(run.agentRunId),
      )
    },
    currentVacancyGeneration: (teamGoalId, role) => {
      let generation = vacancyHighWater.get(vacancyKey(teamGoalId, role)) ?? 0
      for (const run of retired) {
        if (run.teamGoalId !== teamGoalId || run.role !== role) continue
        if (run.predecessorAgentRunId === null) generation = Math.max(generation, 1)
        else generation = Math.max(generation, 2)
      }
      return generation
    },
    retriedByBinding: (binding) => retired.find((run) => bindingKey(run.originalCommitment) === bindingKey(binding)) ?? null,
    assertCommitRetirementEligible: (input) => {
      const { agentRunId, teamGoalId, role, observedSessionId, revision } = input
      if (!isBoundedId(agentRunId)) throw new RetirementError('invalid_envelope', 'agentRunId must be a bounded identity')
      if (!isBoundedId(teamGoalId)) throw new RetirementError('invalid_envelope', 'teamGoalId must be a bounded identity')
      if (!isBoundedId(observedSessionId)) throw new RetirementError('invalid_envelope', 'observedSessionId must be a bounded identity')
      if (!(ROLES as readonly string[]).includes(role)) throw new RetirementError('invalid_envelope', 'role must be allowed')
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new RetirementError('stale_revision', 'retirement requires a positive monotonic revision')
      }
      const existing = retired.find((run) => run.agentRunId === agentRunId)
      if (existing !== undefined) {
        if (existing.revision === revision) return
        throw new RetirementError('stale_revision', 'a different revision for this Agent Run is already retired')
      }
      if (input.executionNodeId !== undefined && !isBoundedId(input.executionNodeId)) {
        throw new RetirementError('invalid_envelope', 'executionNodeId must be a bounded identity')
      }
      if (input.processIncarnationId !== undefined && !isBoundedId(input.processIncarnationId)) {
        throw new RetirementError('invalid_envelope', 'processIncarnationId must be a bounded identity')
      }
      if (input.piSessionId !== undefined && !isBoundedId(input.piSessionId)) {
        throw new RetirementError('invalid_envelope', 'piSessionId must be a bounded identity')
      }
      if (input.extensionInstanceId !== undefined && !isBoundedId(input.extensionInstanceId)) {
        throw new RetirementError('invalid_envelope', 'extensionInstanceId must be a bounded identity')
      }
      // The retirement store does not own the live managed commit. The runner
      // composes the adoption store to verify the live commit occupies the
      // target Role before calling `commitRetirement`. The store's eligibility
      // check is therefore purely local: it tolerates a direct caller setting
      // binding identity, but it rejects replays on a different revision and
      // never mutates durable state on its own.
    },
    commitRetirement: (input) => {
      tx.assertCommitRetirementEligible(input)
      const existing = retired.find((run) => run.agentRunId === input.agentRunId)
      if (existing !== undefined) {
        if (existing.revision !== input.revision) {
          throw new RetirementError('stale_revision', 'a different revision for this Agent Run is already retired')
        }
        return { tombstone: cloneRetired(existing), alreadyRetired: true }
      }
      if (liveCommitForRole !== undefined) {
        const retiredAgentRunIds = new Set(retired.map((item) => item.agentRunId))
        const activeReplacement = committed.find((run) => (
          run.targetTeamGoalId === input.teamGoalId
            && run.targetRole === input.role
            && !retiredAgentRunIds.has(run.agentRunId)
        ))
        const live = activeReplacement === undefined
          ? liveCommitForRole(input.teamGoalId, input.role)
          : { agentRunId: activeReplacement.agentRunId }
        if (live === null) {
          throw new RetirementError('not_eligible', 'no managed Agent Run occupies this Role to retire')
        }
        if (live.agentRunId !== input.agentRunId) {
          throw new RetirementError('role_mismatch', 'the supplied agentRunId does not occupy the target Role')
        }
      }
      const executionNodeId = input.executionNodeId ?? ''
      const processIncarnationId = input.processIncarnationId ?? ''
      const piSessionId = input.piSessionId ?? ''
      const extensionInstanceId = input.extensionInstanceId ?? ''
      const tombstone: RetiredRun = {
        agentRunId: input.agentRunId,
        teamGoalId: input.teamGoalId,
        role: input.role,
        observedSessionId: input.observedSessionId,
        executionNodeId,
        processIncarnationId,
        piSessionId,
        extensionInstanceId,
        retiredAt: 0,
        revision: input.revision,
        predecessorAgentRunId: null,
        originalCommitment: {
          executionNodeId,
          processIncarnationId,
          piSessionId,
          extensionInstanceId,
        },
        state: 'retired',
      }
      retired.push(tombstone)
      const generationKey = vacancyKey(tombstone.teamGoalId, tombstone.role)
      vacancyHighWater.set(
        generationKey,
        (vacancyHighWater.get(generationKey) ?? 0) + 1,
      )
      cursor += 1
      events.push({
        sequence: cursor,
        type: 'retired',
        agentRunId: tombstone.agentRunId,
        teamGoalId: tombstone.teamGoalId,
        role: tombstone.role,
        predecessorAgentRunId: tombstone.predecessorAgentRunId,
        vacancyGeneration: tx.currentVacancyGeneration(tombstone.teamGoalId, tombstone.role),
      })
      return { tombstone: cloneRetired(tombstone), alreadyRetired: false }
    },
    commitReplacementAdoption: (input) => {
      const proposal = requirePlainRecord(input.proposal, 'replacement proposal')
      const role = requireRole(proposal.targetRole, 'targetRole')
      const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
      const predecessor = requireId(proposal.predecessorAgentRunId, 'predecessorAgentRunId')
      const generation = proposal.vacancyGeneration
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new RetirementError('invalid_vacancy', 'vacancyGeneration must be a non-negative integer')
      }
      const predecessorTombstone = retired.find((run) => run.agentRunId === predecessor)
      if (predecessorTombstone === undefined) {
        throw new RetirementError('predecessor_unknown', 'predecessorAgentRunId does not match a retired Run')
      }
      if (predecessorTombstone.teamGoalId !== teamGoalId || predecessorTombstone.role !== role) {
        throw new RetirementError('predecessor_mismatch', 'predecessor Agent Run does not occupy the target Role')
      }
      const currentGeneration = tx.currentVacancyGeneration(teamGoalId, role)
      if (generation !== currentGeneration) {
        throw new RetirementError('vacancy_stale', 'the replacement proposal carries a stale vacancy generation')
      }
      const retiredAgentRunIds = new Set(retired.map((run) => run.agentRunId))
      if (committed.some((run) => run.targetTeamGoalId === teamGoalId
          && run.targetRole === role
          && !retiredAgentRunIds.has(run.agentRunId))) {
        throw new RetirementError('role_occupied', 'the target Role is not vacant')
      }
      const roleLabel = role.slice(0, 1).toUpperCase() + role.slice(1)
      const replacement: ReplacementCommit = {
        proposalId: requireId(proposal.proposalId, 'proposalId'),
        proposalDigest: requireDigest(proposal.proposalDigest),
        agentRunId: agentRunIdFactory(),
        observedSessionId: requireId(proposal.observedSessionId, 'observedSessionId'),
        executionNodeId: requireId(proposal.executionNodeId, 'executionNodeId'),
        processIncarnationId: requireId(proposal.processIncarnationId, 'processIncarnationId'),
        piSessionId: requireId(proposal.piSessionId, 'piSessionId'),
        extensionInstanceId: requireId(proposal.extensionInstanceId, 'extensionInstanceId'),
        targetTeamGoalId: teamGoalId,
        targetRole: role,
        controlMode: 'managed',
        piStatus: `${roleLabel} · managed`,
        terminalTitleMetadata: `Omarchestra — ${roleLabel} — managed`,
        runtimeBinding: null,
        runtimeBindingGuarantee: 'unavailable',
        committedAt: 0,
        predecessorAgentRunId: predecessor,
        vacancyGeneration: currentGeneration,
      }
      committed.push(replacement)
      cursor += 1
      events.push({
        sequence: cursor,
        type: 'replaced',
        agentRunId: replacement.agentRunId,
        teamGoalId: replacement.targetTeamGoalId,
        role: replacement.targetRole,
        predecessorAgentRunId: predecessor,
        vacancyGeneration: currentGeneration,
      })
      return cloneReplacement(replacement)
    },
    registerObservedIfUnretired: (input) => {
      if (tx.isRetired(input)) {
        throw new RetirementError('already_retired', 'the observed identity matches a retired Agent Run')
      }
    },
    beginManagedRecovery: (input) => {
      if (tx.isRetired(input.binding)) {
        throw new RetirementError('already_retired', 'the committed Agent Run has been retired; managed recovery is forbidden')
      }
    },
    revertRetirement: (input) => {
      throw new RetirementError('transaction_failed', 'retirement is irreversible; revert is not permitted')
    },
    purgeRetiredRun: (agentRunId) => {
      const target = retired.find((run) => run.agentRunId === agentRunId)
      if (target === undefined) {
        throw new RetirementError('not_retired', 'the Agent Run is not retained as retired history')
      }
      if (committed.some((run) => run.predecessorAgentRunId === agentRunId)) {
        throw new RetirementError('purge_blocked', 'delete the replacement successor before deleting this predecessor')
      }
      purgedBindings.push(cloneBinding(target.originalCommitment))
      retired = retired.filter((run) => run.agentRunId !== agentRunId)
      committed = committed.filter((run) => run.agentRunId !== agentRunId)
      events = events.filter((event) => event.agentRunId !== agentRunId)
    },
  }

  const transaction = <T>(operation: (retirementTx: RetirementTransaction) => T): T => {
    const retiredSnapshot = retired.map(cloneRetired)
    const committedSnapshot = committed.map(cloneReplacement)
    const eventsSnapshot = events.map(cloneEvent)
    const purgedBindingsSnapshot = purgedBindings.map(cloneBinding)
    const cursorSnapshot = cursor
    const highWaterSnapshot = new Map(vacancyHighWater)
    try {
      const result = operation(tx)
      if (result !== null && typeof result === 'object'
          && typeof (result as Promise<unknown>).then === 'function') {
        retired = retiredSnapshot
        committed = committedSnapshot
        events = eventsSnapshot
        purgedBindings = purgedBindingsSnapshot
        cursor = cursorSnapshot
        vacancyHighWater.clear()
        for (const [key, value] of highWaterSnapshot) vacancyHighWater.set(key, value)
        throw new TypeError('Retirement transaction callbacks must be synchronous')
      }
      return result
    } catch (error) {
      retired = retiredSnapshot
      committed = committedSnapshot
      events = eventsSnapshot
      purgedBindings = purgedBindingsSnapshot
      cursor = cursorSnapshot
      vacancyHighWater.clear()
      for (const [key, value] of highWaterSnapshot) vacancyHighWater.set(key, value)
      throw error
    }
  }

  return {
    transaction,
    snapshot: () => ({
      retiredRuns: retired.map(cloneRetired),
      committedRuns: committed.map(cloneReplacement),
      purgedBindings: purgedBindings.map(cloneBinding),
      events: events.map(cloneEvent),
      vacancyGeneration: vacancyHighWater.size === 0 ? 0 : Math.max(...vacancyHighWater.values()),
      vacancyGenerations: Object.fromEntries(vacancyHighWater),
      cursor,
    }),
    purgeRetiredRun: (agentRunId) => {
      transaction((retirementTx) => retirementTx.purgeRetiredRun(agentRunId))
    },
    close: () => {
      retired = []
      committed = []
      purgedBindings = []
      events = []
      vacancyHighWater.clear()
      cursor = 0
    },
  }
}

export class RetirementError extends Error {
  public readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RetirementError'
    this.code = code
  }
}

function cloneRetired(run: RetiredRun): RetiredRun {
  return { ...run, originalCommitment: { ...run.originalCommitment } }
}

function cloneReplacement(run: ReplacementCommit): ReplacementCommit {
  return { ...run }
}

function cloneBinding(binding: BindingIdentity): BindingIdentity {
  return { ...binding }
}

function cloneEvent(event: RetirementEvent): RetirementEvent {
  return { ...event }
}

function requirePlainRecord(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RetirementError('invalid_envelope', `${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) {
    throw new RetirementError('invalid_envelope', `${where} must be a bounded identity`)
  }
  return input
}

function requireRole(input: unknown, where: string): Role {
  if (typeof input !== 'string' || !(ROLES as readonly string[]).includes(input)) {
    throw new RetirementError('invalid_envelope', `${where} must be an allowed Role`)
  }
  return input as Role
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new RetirementError('invalid_envelope', 'proposal digest must be exactly 64 lowercase hexadecimal characters')
  }
  return input
}

export const RETIREMENT_ERROR_CODES = Object.freeze([
  'invalid_envelope',
  'stale_revision',
  'not_eligible',
  'role_mismatch',
  'node_mismatch',
  'already_retired',
  'predecessor_unknown',
  'predecessor_mismatch',
  'vacancy_stale',
  'invalid_vacancy',
  'role_occupied',
  'transaction_failed',
  'not_retired',
  'purge_blocked',
] as const)

export type RetirementErrorCode = (typeof RETIREMENT_ERROR_CODES)[number]
