/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * manual/live-adoption-store.ts — the disposable durable AdoptionStore adapter
 * for the live Adoption slice. It uses built-in SQLite with explicit
 * synchronous transactions and enforces uniqueness of the binding identity and
 * (teamGoalId, role) in the durable schema. It is disposable: a fresh database
 * path (or `:memory:`) is used per run and never touches installed state.
 *
 * This adapter performs no socket, process, Pi, provider, or desktop work. It
 * is the durable transaction owner for the disposable slice, not a production
 * persistence redesign.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  type AdoptionEvent,
  type AdoptionStore,
  type AdoptionTransaction,
  type BindingIdentity,
  type CommittedAdoption,
  type CommittedIdentity,
  type CommitAdoptionInput,
  type DurableAdoptionState,
  validateDurableAdoptionState,
} from '../observer/live-adoption-store.ts'
import { ROLES, type Role } from '../src/protocol.ts'

export interface LiveAdoptionStoreOptions {
  databasePath: string
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  agentRunIdFactory?: () => string
}

/**
 * SQLite-backed disposable AdoptionStore. `databasePath` may be `:memory:` for
 * isolated test state or an absolute disposable file path for crash-recovery
 * tests. Transactions are synchronous and immediate.
 */
export class LiveAdoptionStore implements AdoptionStore {
  private readonly db: DatabaseSync
  private readonly executionNodeId: string
  private readonly teamGoalId: string
  private readonly roles: Role[]
  private readonly agentRunIdFactory: () => string
  private inTransaction = false

  constructor(options: LiveAdoptionStoreOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveAdoptionStore options are required')
    }
    this.executionNodeId = requireId(options.executionNodeId, 'executionNodeId')
    this.teamGoalId = requireId(options.teamGoalId, 'teamGoalId')
    this.roles = requireRoles(options.roles)
    this.agentRunIdFactory = options.agentRunIdFactory
      ?? (() => `agent-run-${cryptoRandomId()}`)
    const databasePath = options.databasePath
    if (databasePath !== ':memory:') {
      if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
        throw new TypeError('databasePath must be ":memory:" or an absolute path')
      }
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(databasePath)
    try {
      this.db.exec('PRAGMA foreign_keys = ON')
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adoption_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        execution_node_id TEXT NOT NULL,
        team_goal_id TEXT NOT NULL,
        roles TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adopted_runs (
        proposal_id TEXT PRIMARY KEY,
        proposal_digest TEXT NOT NULL,
        agent_run_id TEXT NOT NULL UNIQUE,
        observed_session_id TEXT NOT NULL,
        execution_node_id TEXT NOT NULL,
        process_incarnation_id TEXT NOT NULL,
        pi_session_id TEXT NOT NULL,
        extension_instance_id TEXT NOT NULL,
        target_team_goal_id TEXT NOT NULL,
        target_role TEXT NOT NULL CHECK (target_role IN ('coordinator','builder','reviewer')),
        control_mode TEXT NOT NULL CHECK (control_mode = 'managed'),
        pi_status TEXT NOT NULL,
        terminal_title_metadata TEXT NOT NULL,
        runtime_binding TEXT,
        runtime_binding_guarantee TEXT NOT NULL CHECK (runtime_binding_guarantee = 'unavailable'),
        committed_at INTEGER NOT NULL,
        UNIQUE (target_team_goal_id, target_role),
        UNIQUE (execution_node_id, process_incarnation_id, pi_session_id, extension_instance_id)
      );
      CREATE TABLE IF NOT EXISTS adoption_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type = 'adopted'),
        proposal_id TEXT NOT NULL,
        observed_session_id TEXT NOT NULL,
        agent_run_id TEXT NOT NULL,
        target_team_goal_id TEXT NOT NULL,
        target_role TEXT NOT NULL
      );
    `)
    this.db.exec('CREATE TABLE IF NOT EXISTS adoption_takeovers (agent_run_id TEXT PRIMARY KEY REFERENCES adopted_runs(agent_run_id))')
    this.validateOrPersistConfiguration()
  }

  /**
   * Persist the configured Node/goal/Roles on first open and reject a reopen
   * whose constructor configuration does not match the persisted configuration.
   * A database is never silently reinterpreted with new constructor values.
   */
  private validateOrPersistConfiguration(): void {
    const config = this.db
      .prepare('SELECT * FROM adoption_config WHERE id = 1')
      .get() as Record<string, unknown> | undefined
    const rolesJson = JSON.stringify([...this.roles])
    if (config === undefined) {
      this.db
        .prepare('INSERT INTO adoption_config (id, execution_node_id, team_goal_id, roles) VALUES (1, ?, ?, ?)')
        .run(this.executionNodeId, this.teamGoalId, rolesJson)
      return
    }
    if (config.execution_node_id !== this.executionNodeId
        || config.team_goal_id !== this.teamGoalId
        || JSON.stringify(JSON.parse(String(config.roles))) !== rolesJson) {
      throw new Error('adoption configuration mismatch on reopen')
    }
  }

  transaction<T>(operation: (tx: AdoptionTransaction) => T): T {
    if (this.inTransaction) throw new Error('nested Adoption transactions are not permitted')
    this.inTransaction = true
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const result = operation(this.buildTransaction())
      if (result !== null && (typeof result === 'object' || typeof result === 'function')
          && typeof (result as { then?: unknown }).then === 'function') {
        throw new TypeError('Adoption transactions must be synchronous')
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // rollback of an already-failed transaction is best-effort
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  snapshot(): DurableAdoptionState {
    const committedRuns = this.db
      .prepare('SELECT * FROM adopted_runs ORDER BY committed_at ASC')
      .all() as Record<string, unknown>[]
    const events = this.db
      .prepare('SELECT * FROM adoption_events ORDER BY sequence ASC')
      .all() as Record<string, unknown>[]
    const cursorRow = this.db
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM adoption_events')
      .get() as { cursor: number }
    const config = this.db
      .prepare('SELECT * FROM adoption_config WHERE id = 1')
      .get() as Record<string, unknown>
    const state: DurableAdoptionState = {
      executionNodeId: String(config.execution_node_id),
      teamGoalId: String(config.team_goal_id),
      roles: JSON.parse(String(config.roles)) as Role[],
      committedRuns: committedRuns.map(rowToCommitted),
      cursor: Number(cursorRow.cursor),
      events: events.map(rowToEvent),
    }
    return validateDurableAdoptionState(state)
  }

  recordManualTakeover(agentRunId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO adoption_takeovers (agent_run_id) VALUES (?)').run(agentRunId)
  }

  isManualTakeover(agentRunId: string): boolean {
    return this.db.prepare('SELECT agent_run_id FROM adoption_takeovers WHERE agent_run_id = ?').get(agentRunId) !== undefined
  }

  close(): void {
    this.db.close()
  }

  private buildTransaction(): AdoptionTransaction {
    const store = this
    return {
      committedByIdentity: (identity) => {
        const row = store.db
          .prepare(
            `SELECT * FROM adopted_runs
             WHERE execution_node_id = ? AND process_incarnation_id = ?
               AND pi_session_id = ? AND extension_instance_id = ?`,
          )
          .get(
            identity.executionNodeId,
            identity.processIncarnationId,
            identity.piSessionId,
            identity.extensionInstanceId,
          ) as Record<string, unknown> | undefined
        return row === undefined ? null : rowToCommitted(row)
      },
      committedByProposal: (proposalId) => {
        const row = store.db
          .prepare('SELECT * FROM adopted_runs WHERE proposal_id = ?')
          .get(proposalId) as Record<string, unknown> | undefined
        return row === undefined ? null : rowToCommitted(row)
      },
      committedByBinding: (binding) => {
        const row = store.db
          .prepare(
            `SELECT * FROM adopted_runs
             WHERE execution_node_id = ? AND process_incarnation_id = ?
               AND pi_session_id = ? AND extension_instance_id = ?`,
          )
          .get(
            binding.executionNodeId,
            binding.processIncarnationId,
            binding.piSessionId,
            binding.extensionInstanceId,
          ) as Record<string, unknown> | undefined
        return row === undefined ? null : rowToCommitted(row)
      },
      isRoleOccupied: (teamGoalId, role) => {
        const row = store.db
          .prepare('SELECT 1 AS one FROM adopted_runs WHERE target_team_goal_id = ? AND target_role = ?')
          .get(teamGoalId, role)
        return row !== undefined
      },
      isIdentityCommitted: (identity) => {
        const row = store.db
          .prepare(
            `SELECT 1 AS one FROM adopted_runs
             WHERE execution_node_id = ? AND process_incarnation_id = ?
               AND pi_session_id = ? AND extension_instance_id = ?`,
          )
          .get(
            identity.executionNodeId,
            identity.processIncarnationId,
            identity.piSessionId,
            identity.extensionInstanceId,
          )
        return row !== undefined
      },
      isBindingCommitted: (binding) => {
        const row = store.db
          .prepare(
            `SELECT 1 AS one FROM adopted_runs
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
      },
      currentCursor: () => {
        const row = store.db
          .prepare('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM adoption_events')
          .get() as { cursor: number }
        return Number(row.cursor)
      },
      eventsAfter: (after) => {
        const rows = store.db
          .prepare('SELECT * FROM adoption_events WHERE sequence > ? ORDER BY sequence ASC')
          .all(after) as Record<string, unknown>[]
        return rows.map(rowToEvent)
      },
      commitAdoption: (input) => {
        const proposal = requirePlainRecord(input.proposal, 'Adoption proposal')
        const role = requireRole(proposal.targetRole, 'targetRole')
        const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
        const identity: CommittedIdentity = {
          observedSessionId: requireId(proposal.observedSessionId, 'observedSessionId'),
          executionNodeId: requireId(proposal.executionNodeId, 'executionNodeId'),
          processIncarnationId: requireId(proposal.processIncarnationId, 'processIncarnationId'),
          piSessionId: requireId(proposal.piSessionId, 'piSessionId'),
          extensionInstanceId: requireId(proposal.extensionInstanceId, 'extensionInstanceId'),
        }
        const roleLabel = role.slice(0, 1).toUpperCase() + role.slice(1)
        const committedAt = Date.now()
        const agentRunId = store.agentRunIdFactory()
        store.db
          .prepare(
            `INSERT INTO adopted_runs
             (proposal_id, proposal_digest, agent_run_id, observed_session_id, execution_node_id,
              process_incarnation_id, pi_session_id, extension_instance_id, target_team_goal_id,
              target_role, control_mode, pi_status, terminal_title_metadata, runtime_binding,
              runtime_binding_guarantee, committed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed', ?, ?, NULL, 'unavailable', ?)`,
          )
          .run(
            requireId(proposal.proposalId, 'proposalId'),
            requireDigest(proposal.proposalDigest),
            agentRunId,
            identity.observedSessionId,
            identity.executionNodeId,
            identity.processIncarnationId,
            identity.piSessionId,
            identity.extensionInstanceId,
            teamGoalId,
            role,
            `${roleLabel} · managed`,
            `Omarchestra — ${roleLabel} — managed`,
            committedAt,
          )
        const info = store.db
          .prepare(
            `INSERT INTO adoption_events
             (type, proposal_id, observed_session_id, agent_run_id, target_team_goal_id, target_role)
             VALUES ('adopted', ?, ?, ?, ?, ?)`,
          )
          .run(
            requireId(proposal.proposalId, 'proposalId'),
            identity.observedSessionId,
            agentRunId,
            teamGoalId,
            role,
          )
        const sequence = Number(info.lastInsertRowid)
        const committed: CommittedAdoption = {
          proposalId: requireId(proposal.proposalId, 'proposalId'),
          proposalDigest: requireDigest(proposal.proposalDigest),
          agentRunId,
          observedSessionId: identity.observedSessionId,
          executionNodeId: identity.executionNodeId,
          processIncarnationId: identity.processIncarnationId,
          piSessionId: identity.piSessionId,
          extensionInstanceId: identity.extensionInstanceId,
          targetTeamGoalId: teamGoalId,
          targetRole: role,
          controlMode: 'managed',
          piStatus: `${roleLabel} · managed`,
          terminalTitleMetadata: `Omarchestra — ${roleLabel} — managed`,
          runtimeBinding: null,
          runtimeBindingGuarantee: 'unavailable',
          committedAt,
        }
        void sequence
        return committed
      },
    }
  }
}

function rowToCommitted(row: Record<string, unknown>): CommittedAdoption {
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
  }
}

function rowToEvent(row: Record<string, unknown>): AdoptionEvent {
  return {
    sequence: Number(row.sequence),
    type: 'adopted',
    proposalId: String(row.proposal_id),
    observedSessionId: String(row.observed_session_id),
    agentRunId: String(row.agent_run_id),
    targetTeamGoalId: String(row.target_team_goal_id),
    targetRole: String(row.target_role) as Role,
  }
}

function requireId(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    throw new TypeError(`${where} must be a bounded identity`)
  }
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new TypeError('proposal digest must be exactly 64 lowercase hexadecimal characters')
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

function requirePlainRecord(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}
