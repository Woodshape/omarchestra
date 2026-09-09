/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * manual/live-retirement-store.ts — the disposable durable RetirementStore
 * adapter for the explicit retirement and replacement slice. It uses the
 * same disposable SQLite database as `LiveAdoptionStore` so retirement and
 * adoption share a single transactional boundary. It performs no socket,
 * process, Pi, provider, or desktop work. The runner composes it as a port;
 * there is no parallel registry or UI-owned state machine.
 *
 * Schema (created by `migrate()`):
 *
 *   retired_runs (
 *     agent_run_id TEXT PRIMARY KEY,
 *     team_goal_id TEXT NOT NULL,
 *     role TEXT NOT NULL CHECK (role IN ('coordinator','builder','reviewer')),
 *     observed_session_id TEXT NOT NULL,
 *     execution_node_id TEXT NOT NULL,
 *     process_incarnation_id TEXT NOT NULL,
 *     pi_session_id TEXT NOT NULL,
 *     extension_instance_id TEXT NOT NULL,
 *     retired_at INTEGER NOT NULL,
 *     revision INTEGER NOT NULL,
 *     predecessor_agent_run_id TEXT,
 *     UNIQUE (execution_node_id, process_incarnation_id, pi_session_id, extension_instance_id)
 *   )
 *   retirement_replacements (
 *     proposal_id TEXT PRIMARY KEY,
 *     proposal_digest TEXT NOT NULL,
 *     agent_run_id TEXT NOT NULL UNIQUE,
 *     observed_session_id TEXT NOT NULL,
 *     execution_node_id TEXT NOT NULL,
 *     process_incarnation_id TEXT NOT NULL,
 *     pi_session_id TEXT NOT NULL,
 *     extension_instance_id TEXT NOT NULL,
 *     target_team_goal_id TEXT NOT NULL,
 *     target_role TEXT NOT NULL CHECK (target_role IN ('coordinator','builder','reviewer')),
 *     control_mode TEXT NOT NULL CHECK (control_mode = 'managed'),
 *     pi_status TEXT NOT NULL,
 *     terminal_title_metadata TEXT NOT NULL,
 *     runtime_binding TEXT,
 *     runtime_binding_guarantee TEXT NOT NULL CHECK (runtime_binding_guarantee = 'unavailable'),
 *     committed_at INTEGER NOT NULL,
 *     predecessor_agent_run_id TEXT NOT NULL REFERENCES retired_runs(agent_run_id),
 *     vacancy_generation INTEGER NOT NULL,
 *     UNIQUE (target_team_goal_id, target_role)
 *   )
 *   retirement_events (
 *     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 *     type TEXT NOT NULL CHECK (type IN ('retired','replaced')),
 *     agent_run_id TEXT NOT NULL,
 *     team_goal_id TEXT NOT NULL,
 *     role TEXT NOT NULL,
 *     predecessor_agent_run_id TEXT,
 *     vacancy_generation INTEGER NOT NULL
 *   )
 */

import { DatabaseSync } from 'node:sqlite'

import { ROLES, isBoundedId, type Role } from '../src/protocol.ts'
import type { BindingIdentity } from '../observer/live-adoption-store.ts'
import {
  type CommitRetirementInput,
  type ReplacementAdoptionInput,
  type ReplacementCommit,
  RetirementError,
  type ReplacementProposalInput,
  type RetiredRun,
  type RetirementEvent,
  type RetirementStore,
  type RetirementStoreSnapshot,
  type RetirementTransaction,
} from '../observer/retirement-store.ts'

export interface LiveRetirementStoreOptions {
  database: DatabaseSync
  agentRunIdFactory?: () => string
}

export class LiveRetirementStore implements RetirementStore {
  private readonly db: DatabaseSync
  private readonly agentRunIdFactory: () => string
  private inTransaction = false

  constructor(options: LiveRetirementStoreOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveRetirementStore options are required')
    }
    if (!(options.database instanceof DatabaseSync)) {
      throw new TypeError('database must be a node:sqlite DatabaseSync instance')
    }
    this.db = options.database
    this.agentRunIdFactory = options.agentRunIdFactory
      ?? (() => `agent-run-${cryptoRandomId()}`)
  }

  transaction<T>(operation: (tx: RetirementTransaction) => T): T {
    if (this.inTransaction) throw new Error('nested Retirement transactions are not permitted')
    this.inTransaction = true
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const result = operation(this.buildTransaction())
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('Retirement transactions must be synchronous')
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // best-effort rollback
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  snapshot(): RetirementStoreSnapshot {
    const retiredRows = this.db
      .prepare('SELECT * FROM retired_runs ORDER BY retired_at ASC')
      .all() as Record<string, unknown>[]
    const replacementRows = this.db
      .prepare('SELECT * FROM retirement_replacements ORDER BY committed_at ASC')
      .all() as Record<string, unknown>[]
    const eventRows = this.db
      .prepare('SELECT * FROM retirement_events ORDER BY sequence ASC')
      .all() as Record<string, unknown>[]
    const cursorRow = this.db
      .prepare('SELECT cursor FROM retirement_cursor WHERE id = 1')
      .get() as { cursor: number } | undefined
    const retiredRuns = retiredRows.map(rowToRetired)
    const committedRuns = replacementRows.map(rowToReplacement)
    const events = eventRows.map(rowToEvent)
    const generationRows = this.db
      .prepare('SELECT team_goal_id, role, generation FROM retirement_vacancies')
      .all() as Array<{ team_goal_id: string; role: string; generation: number }>
    const generationRow = generationRows.reduce(
      (maximum, row) => Math.max(maximum, Number(row.generation)),
      0,
    )
    const vacancyGenerations = Object.fromEntries(
      generationRows.map((row) => [`${row.team_goal_id}|${row.role}`, Number(row.generation)]),
    )
    const last = retiredRuns[retiredRuns.length - 1]
    const vacancyGeneration = Math.max(
      Number(generationRow),
      last === undefined ? 0 : currentVacancyGenerationStatic(retiredRuns, last.teamGoalId, last.role),
    )
    return {
      retiredRuns,
      committedRuns,
      events,
      vacancyGeneration,
      vacancyGenerations,
      cursor: cursorRow === undefined ? 0 : Number(cursorRow.cursor),
    }
  }

  purgeRetiredRun(agentRunId: string): void {
    if (this.inTransaction) throw new Error('nested Retirement transactions are not permitted')
    this.inTransaction = true
    try {
      this.db.exec('BEGIN IMMEDIATE')
      this.buildTransaction().purgeRetiredRun(agentRunId)
      this.db.prepare('DELETE FROM adoption_takeovers WHERE agent_run_id = ?').run(agentRunId)
      this.db.prepare('DELETE FROM adoption_events WHERE agent_run_id = ?').run(agentRunId)
      this.db.prepare('DELETE FROM adopted_runs WHERE agent_run_id = ?').run(agentRunId)
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // best-effort rollback
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  close(): void {
    // Shared database lifecycle is owned by LiveAdoptionStore.
  }

  private buildTransaction(): RetirementTransaction {
    const store = this

    const isRetired = (binding: BindingIdentity): boolean => {
      const row = store.db
        .prepare(
          `SELECT 1 AS one FROM retired_runs
           WHERE execution_node_id = ? AND process_incarnation_id = ?
             AND pi_session_id = ? AND extension_instance_id = ?`,
        )
        .get(
          binding.executionNodeId,
          binding.processIncarnationId,
          binding.piSessionId,
          binding.extensionInstanceId,
        )
      return row !== undefined
    }

    const isRoleVacant = (teamGoalId: string, role: Role): boolean => {
      const row = store.db
        .prepare(
          `SELECT 1 AS one FROM retirement_replacements AS replacement
           WHERE replacement.target_team_goal_id = ? AND replacement.target_role = ?
             AND NOT EXISTS (
               SELECT 1 FROM retired_runs AS retired
               WHERE retired.agent_run_id = replacement.agent_run_id
             )`,
        )
        .get(teamGoalId, role)
      return row === undefined
    }

    const currentVacancyGeneration = (teamGoalId: string, role: Role): number => {
      const counter = store.db
        .prepare('SELECT generation FROM retirement_vacancies WHERE team_goal_id = ? AND role = ?')
        .get(teamGoalId, role) as { generation: number } | undefined
      const rows = store.db
        .prepare(
          `SELECT predecessor_agent_run_id FROM retired_runs
           WHERE team_goal_id = ? AND role = ? ORDER BY retired_at ASC`,
        )
        .all(teamGoalId, role) as Array<{ predecessor_agent_run_id: string | null }>
      let computed = 0
      for (const row of rows) {
        computed += row.predecessor_agent_run_id === null ? 1 : 2
      }
      return Math.max(counter === undefined ? 0 : Number(counter.generation), computed)
    }

    const retriedByBinding = (binding: BindingIdentity): RetiredRun | null => {
      const row = store.db
        .prepare(
          `SELECT * FROM retired_runs
           WHERE execution_node_id = ? AND process_incarnation_id = ?
             AND pi_session_id = ? AND extension_instance_id = ?`,
        )
        .get(
          binding.executionNodeId,
          binding.processIncarnationId,
          binding.piSessionId,
          binding.extensionInstanceId,
        ) as Record<string, unknown> | undefined
      return row === undefined ? null : rowToRetired(row)
    }

    const assertCommitRetirementEligible = (input: CommitRetirementInput): void => {
      if (!isBoundedId(input.agentRunId)) throw new RetirementError('invalid_envelope', 'agentRunId must be a bounded identity')
      if (!isBoundedId(input.teamGoalId)) throw new RetirementError('invalid_envelope', 'teamGoalId must be a bounded identity')
      if (!isBoundedId(input.observedSessionId)) throw new RetirementError('invalid_envelope', 'observedSessionId must be a bounded identity')
      if (!(ROLES as readonly string[]).includes(input.role)) throw new RetirementError('invalid_envelope', 'role must be allowed')
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
        throw new RetirementError('stale_revision', 'retirement requires a positive monotonic revision')
      }
      const existing = store.db
        .prepare('SELECT revision FROM retired_runs WHERE agent_run_id = ?')
        .get(input.agentRunId) as { revision: number } | undefined
      if (existing !== undefined && existing.revision !== input.revision) {
        throw new RetirementError('stale_revision', 'a different revision for this Agent Run is already retired')
      }
    }

    const commitRetirement = (input: CommitRetirementInput): { tombstone: RetiredRun; alreadyRetired: boolean } => {
      assertCommitRetirementEligible(input)
      const existingRow = store.db
        .prepare('SELECT * FROM retired_runs WHERE agent_run_id = ?')
        .get(input.agentRunId) as Record<string, unknown> | undefined
      if (existingRow !== undefined) {
        return { tombstone: rowToRetired(existingRow), alreadyRetired: true }
      }
      const executionNodeId = input.executionNodeId ?? ''
      const processIncarnationId = input.processIncarnationId ?? ''
      const piSessionId = input.piSessionId ?? ''
      const extensionInstanceId = input.extensionInstanceId ?? ''
      const previousGeneration = currentVacancyGeneration(input.teamGoalId, input.role)
      const retiredAt = Date.now()
      store.db
        .prepare(
          `INSERT INTO retired_runs
           (agent_run_id, team_goal_id, role, observed_session_id, execution_node_id,
            process_incarnation_id, pi_session_id, extension_instance_id,
            retired_at, revision, predecessor_agent_run_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.agentRunId,
          input.teamGoalId,
          input.role,
          input.observedSessionId,
          executionNodeId,
          processIncarnationId,
          piSessionId,
          extensionInstanceId,
          retiredAt,
          input.revision,
        )
      const newGeneration = previousGeneration + 1
      store.db
        .prepare(
          `INSERT INTO retirement_vacancies (team_goal_id, role, generation)
           VALUES (?, ?, ?)
           ON CONFLICT(team_goal_id, role) DO UPDATE SET generation = excluded.generation`,
        )
        .run(input.teamGoalId, input.role, newGeneration)
      const info = store.db
        .prepare(
          `INSERT INTO retirement_events
           (type, agent_run_id, team_goal_id, role, predecessor_agent_run_id, vacancy_generation)
           VALUES ('retired', ?, ?, ?, NULL, ?)`,
        )
        .run(
          input.agentRunId,
          input.teamGoalId,
          input.role,
          newGeneration,
        )
      void info
      const sequence = Number(info.lastInsertRowid)
      store.db
        .prepare('UPDATE retirement_cursor SET cursor = MAX(cursor, ?) WHERE id = 1')
        .run(sequence)
      const tombstone: RetiredRun = {
        agentRunId: input.agentRunId,
        teamGoalId: input.teamGoalId,
        role: input.role,
        observedSessionId: input.observedSessionId,
        executionNodeId,
        processIncarnationId,
        piSessionId,
        extensionInstanceId,
        retiredAt,
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
      return { tombstone, alreadyRetired: false }
    }

    const commitReplacementAdoption = (input: ReplacementAdoptionInput): ReplacementCommit => {
      const proposal = requirePlainRecord(input.proposal, 'replacement proposal') as Partial<ReplacementProposalInput>
      const role = requireRole(proposal.targetRole, 'targetRole')
      const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
      const predecessor = requireId(proposal.predecessorAgentRunId, 'predecessorAgentRunId')
      const generation = proposal.vacancyGeneration
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new RetirementError('invalid_vacancy', 'vacancyGeneration must be a non-negative integer')
      }
      const predecessorRow = store.db
        .prepare('SELECT team_goal_id, role FROM retired_runs WHERE agent_run_id = ?')
        .get(predecessor) as { team_goal_id: string; role: string } | undefined
      if (predecessorRow === undefined) {
        throw new RetirementError('predecessor_unknown', 'predecessorAgentRunId does not match a retired Run')
      }
      if (predecessorRow.team_goal_id !== teamGoalId || predecessorRow.role !== role) {
        throw new RetirementError('predecessor_mismatch', 'predecessor Agent Run does not occupy the target Role')
      }
      const currentGeneration = currentVacancyGeneration(teamGoalId, role)
      if (generation !== currentGeneration) {
        throw new RetirementError('vacancy_stale', 'the replacement proposal carries a stale vacancy generation')
      }
      const occupiedRow = store.db
        .prepare(
          `SELECT 1 AS one FROM retirement_replacements AS replacement
           WHERE replacement.target_team_goal_id = ? AND replacement.target_role = ?
             AND NOT EXISTS (
               SELECT 1 FROM retired_runs AS retired
               WHERE retired.agent_run_id = replacement.agent_run_id
             )`,
        )
        .get(teamGoalId, role)
      if (occupiedRow !== undefined) {
        throw new RetirementError('role_occupied', 'the target Role is not vacant')
      }
      const proposalId = requireId(proposal.proposalId, 'proposalId')
      const proposalDigest = requireDigest(proposal.proposalDigest)
      const observedSessionId = requireId(proposal.observedSessionId, 'observedSessionId')
      const executionNodeId = requireId(proposal.executionNodeId, 'executionNodeId')
      const processIncarnationId = requireId(proposal.processIncarnationId, 'processIncarnationId')
      const piSessionId = requireId(proposal.piSessionId, 'piSessionId')
      const extensionInstanceId = requireId(proposal.extensionInstanceId, 'extensionInstanceId')
      const roleLabel = role.slice(0, 1).toUpperCase() + role.slice(1)
      const committedAt = Date.now()
      const agentRunId = store.agentRunIdFactory()
      store.db
        .prepare(
          `INSERT INTO retirement_replacements
           (proposal_id, proposal_digest, agent_run_id, observed_session_id, execution_node_id,
            process_incarnation_id, pi_session_id, extension_instance_id, target_team_goal_id,
            target_role, control_mode, pi_status, terminal_title_metadata, runtime_binding,
            runtime_binding_guarantee, committed_at, predecessor_agent_run_id, vacancy_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed', ?, ?, NULL, 'unavailable', ?, ?, ?)`,
        )
        .run(
          proposalId,
          proposalDigest,
          agentRunId,
          observedSessionId,
          executionNodeId,
          processIncarnationId,
          piSessionId,
          extensionInstanceId,
          teamGoalId,
          role,
          `${roleLabel} · managed`,
          `Omarchestra — ${roleLabel} — managed`,
          committedAt,
          predecessor,
          currentGeneration,
        )
      const info = store.db
        .prepare(
          `INSERT INTO retirement_events
           (type, agent_run_id, team_goal_id, role, predecessor_agent_run_id, vacancy_generation)
           VALUES ('replaced', ?, ?, ?, ?, ?)`,
        )
        .run(
          agentRunId,
          teamGoalId,
          role,
          predecessor,
          currentGeneration,
        )
      void info
      const sequence = Number(info.lastInsertRowid)
      store.db
        .prepare('UPDATE retirement_cursor SET cursor = MAX(cursor, ?) WHERE id = 1')
        .run(sequence)
      const replacement: ReplacementCommit = {
        proposalId,
        proposalDigest,
        agentRunId,
        observedSessionId,
        executionNodeId,
        processIncarnationId,
        piSessionId,
        extensionInstanceId,
        targetTeamGoalId: teamGoalId,
        targetRole: role,
        controlMode: 'managed',
        piStatus: `${roleLabel} · managed`,
        terminalTitleMetadata: `Omarchestra — ${roleLabel} — managed`,
        runtimeBinding: null,
        runtimeBindingGuarantee: 'unavailable',
        committedAt,
        predecessorAgentRunId: predecessor,
        vacancyGeneration: currentGeneration,
      }
      return replacement
    }

    const registerObservedIfUnretired = (input: BindingIdentity & { observedSessionId: string }): void => {
      void input.observedSessionId
      if (isRetired(input)) {
        throw new RetirementError('already_retired', 'the observed identity matches a retired Agent Run')
      }
    }

    const beginManagedRecovery = (input: { binding: BindingIdentity }): void => {
      if (isRetired(input.binding)) {
        throw new RetirementError('already_retired', 'the committed Agent Run has been retired; managed recovery is forbidden')
      }
    }

    const revertRetirement = (input: { agentRunId: string; revision: number }): void => {
      void input.agentRunId
      void input.revision
      throw new RetirementError('transaction_failed', 'retirement is irreversible; revert is not permitted')
    }

    const purgeRetiredRun = (agentRunId: string): void => {
      const retired = store.db
        .prepare('SELECT 1 AS one FROM retired_runs WHERE agent_run_id = ?')
        .get(agentRunId)
      if (retired === undefined) {
        throw new RetirementError('not_retired', 'the Agent Run is not retained as retired history')
      }
      const successor = store.db
        .prepare('SELECT 1 AS one FROM retirement_replacements WHERE predecessor_agent_run_id = ?')
        .get(agentRunId)
      if (successor !== undefined) {
        throw new RetirementError('purge_blocked', 'delete the replacement successor before deleting this predecessor')
      }
      store.db.prepare('DELETE FROM retirement_events WHERE agent_run_id = ?').run(agentRunId)
      store.db.prepare('DELETE FROM retirement_replacements WHERE agent_run_id = ?').run(agentRunId)
      store.db.prepare('DELETE FROM retired_runs WHERE agent_run_id = ?').run(agentRunId)
    }

    return {
      isRetired,
      isRoleVacant,
      currentVacancyGeneration,
      retriedByBinding,
      assertCommitRetirementEligible,
      commitRetirement,
      commitReplacementAdoption,
      registerObservedIfUnretired,
      beginManagedRecovery,
      revertRetirement,
      purgeRetiredRun,
    }
  }
}

/**
 * Static helper for snapshot computation outside the active transaction.
 * Mirrors the per-tx implementation; SQL is the authoritative source.
 */
function currentVacancyGenerationStatic(retired: RetiredRun[], teamGoalId: string, role: Role): number {
  let generation = 0
  for (const run of retired) {
    if (run.teamGoalId !== teamGoalId || run.role !== role) continue
    generation += run.predecessorAgentRunId === null ? 1 : 2
  }
  return generation
}

function rowToRetired(row: Record<string, unknown>): RetiredRun {
  return {
    agentRunId: String(row.agent_run_id),
    teamGoalId: String(row.team_goal_id),
    role: String(row.role) as Role,
    observedSessionId: String(row.observed_session_id),
    executionNodeId: String(row.execution_node_id),
    processIncarnationId: String(row.process_incarnation_id),
    piSessionId: String(row.pi_session_id),
    extensionInstanceId: String(row.extension_instance_id),
    retiredAt: Number(row.retired_at),
    revision: Number(row.revision),
    predecessorAgentRunId: row.predecessor_agent_run_id === null
      ? null
      : String(row.predecessor_agent_run_id),
    originalCommitment: {
      executionNodeId: String(row.execution_node_id),
      processIncarnationId: String(row.process_incarnation_id),
      piSessionId: String(row.pi_session_id),
      extensionInstanceId: String(row.extension_instance_id),
    },
    state: 'retired',
  }
}

function rowToReplacement(row: Record<string, unknown>): ReplacementCommit {
  return {
    proposalId: String(row.proposal_id),
    proposalDigest: String(row.proposal_digest),
    agentRunId: String(row.agent_run_id),
    observedSessionId: String(row.observed_session_id),
    executionNodeId: String(row.execution_node_id),
    processIncarnationId: String(row.process_incarnation_id),
    piSessionId: String(row.pi_session_id),
    extensionInstanceId: String(row.extension_instance_id),
    targetTeamGoalId: String(row.target_team_goal_id),
    targetRole: String(row.target_role) as Role,
    controlMode: 'managed',
    piStatus: String(row.pi_status),
    terminalTitleMetadata: String(row.terminal_title_metadata),
    runtimeBinding: null,
    runtimeBindingGuarantee: 'unavailable',
    committedAt: Number(row.committed_at),
    predecessorAgentRunId: String(row.predecessor_agent_run_id),
    vacancyGeneration: Number(row.vacancy_generation),
  }
}

function rowToEvent(row: Record<string, unknown>): RetirementEvent {
  return {
    sequence: Number(row.sequence),
    type: String(row.type) as 'retired' | 'replaced',
    agentRunId: String(row.agent_run_id),
    teamGoalId: String(row.team_goal_id),
    role: String(row.role) as Role,
    predecessorAgentRunId: row.predecessor_agent_run_id === null
      ? null
      : String(row.predecessor_agent_run_id),
    vacancyGeneration: Number(row.vacancy_generation),
  }
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

function cryptoRandomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
