/**
 * Local Workbench v1 Phase 2 — durable SQLite store (contract C3).
 *
 * One runner owns this database. Settings are explicit and verified: foreign
 * keys ON, rollback journal DELETE, synchronous FULL, busy timeout 1000 ms,
 * `BEGIN IMMEDIATE` for every authority transaction. Schema version and the
 * declared table shape are validated before any frame is accepted. Clean
 * shutdown closes connections without deleting history.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { workbenchError } from './errors.ts'
import { assertNodeId } from './identity.ts'
import { validateDelivery, type BridgeDelivery, type DeliveryState } from './bridge-delivery.ts'
import { incarnationKey, validateIncarnation, type BindingIdentity, type PiIncarnation } from './binding-identity.ts'
import { OWNED_FILE_MODE } from './paths.ts'
import { REQUIRED_JOURNAL_MODE, REQUIRED_PRAGMAS, STORE_DDL, STORE_SCHEMA_VERSION, STORE_TABLES } from './schema.ts'

export const BINDING_STATES = [
  'proposed',
  'authorized',
  'acknowledged',
  'committed',
  'ready',
  'manual_takeover',
  'manual_takeover_disconnected',
  'disconnected',
  'retired',
  'purged',
] as const
export type BindingState = (typeof BINDING_STATES)[number]

/** States whose effects are unknown after an unclean stop. */
export const UNCERTAIN_BINDING_STATES: BindingState[] = ['proposed', 'authorized', 'acknowledged']

export const WRITER_STATES = ['none', 'held', 'uncertain'] as const
export type WriterState = (typeof WRITER_STATES)[number]

export interface BindingRecord {
  runId: string
  projectId: string | null
  role: string | null
  state: BindingState
  bindingDigest: string | null
  controlEpoch: number
  writerState: WriterState
  predecessorRunId: string | null
  generation: number | null
  updatedAt: number
}

export interface ProjectRecord {
  projectId: string
  executionNodeId: string
  canonicalPath: string
  gitCommonDir: string
  headOid: string | null
  dirty: boolean
  contextDigest: string | null
  revision: number
  createdAt: number
}

export interface GoalRecord {
  goalId: string
  projectId: string
  goalText: string
  state: 'active' | 'recent'
  outcome: string | null
  createdAt: number
}

export interface CheckRecord {
  projectId: string
  checkId: string
  version: number
  digest: string
  canonicalJson: string
  name: string
  mode: string
  createdAt: number
}

export interface EventRecord {
  runId?: string | null
  eventId: string
  cursor: number
  baseRevision: number
  revision: number
  kind: string
  createdAt: number
}

export interface IntentResultRecord {
  reason?: string | null
  detail?: string | null
  intentId: string
  sessionId: string
  /** Schema 6 authority receipts hash the complete validated original envelope. */
  payloadHash: string
  status: string
  reasonCode: string | null
  committedRevision: number | null
  createdAt: number
}

export interface ManagementOperation {
  intentId: string
  sessionId: string
  /** Same complete-envelope fingerprint as the eventual authority receipt. */
  payloadHash: string
  kind: 'retire' | 'purge'
  runId: string
  targetJson: string
  createdAt: number
}

export interface WorkbenchStore {
  readonly path: string
  readonly nodeId: string
  readonly epoch: number
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  transaction<T>(fn: () => T): T
  putBinding(binding: BindingRecord): void
  getBinding(runId: string): BindingRecord | null
  listBindings(): BindingRecord[]
  putBindingIdentity(runId: string, goalId: string, incarnation: PiIncarnation): void
  getBindingIdentity(runId: string): BindingIdentity | null
  commitMembership(runId: string): void
  releaseMembership(runId: string): void
  listMemberships(goalId: string): Array<{ goalId: string; role: string; runId: string }>
  purgeRetiredHistory(runId: string, now: number): void
  hasUncertainEffects(projectId: string): boolean
  setBindingState(runId: string, state: BindingState, updatedAt: number): void
  setBindingControlEpoch(runId: string, controlEpoch: number, updatedAt: number): void
  markUncertainInFlight(updatedAt: number): string[]
  putProject(project: ProjectRecord): void
  getProject(projectId: string): ProjectRecord | null
  listProjects(): ProjectRecord[]
  insertGoal(goal: GoalRecord): void
  getGoal(goalId: string): GoalRecord | null
  listGoals(projectId?: string): GoalRecord[]
  setGoalState(goalId: string, state: GoalRecord['state'], outcome: string | null): void
  putCheck(check: CheckRecord): void
  getCheck(projectId: string, checkId: string, version: number): CheckRecord | null
  latestCheck(projectId: string, checkId: string): CheckRecord | null
  listChecks(projectId: string): CheckRecord[]
  appendEvent(event: EventRecord): void
  listEvents(): EventRecord[]
  maxCursor(): number
  putDelivery(delivery: BridgeDelivery): void
  listDeliveries(runId?: string): BridgeDelivery[]
  transitionDelivery(frameId: string, from: DeliveryState, to: DeliveryState, reasonCode: string | null): boolean
  putManagementOperation(operation: ManagementOperation): void
  listManagementOperations(): ManagementOperation[]
  deleteManagementOperation(intentId: string): void
  putIntentResult(record: IntentResultRecord): void
  getIntentResult(intentId: string): IntentResultRecord | null
  integrityCheck(): string
  backupTo(target: string): void
  close(): void
}

interface StoreOptions {
  path: string
  nodeId: string
  create: boolean
  clock?: () => number
}

function sqliteFailure(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  throw workbenchError('store_unavailable', `cannot open store ${path}: ${message}`, 'close other workbench processes, then re-run; do not delete the database')
}

function openDatabase(path: string, options: StoreOptions): DatabaseSync {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path)
  } catch (error) {
    sqliteFailure(path, error)
  }
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 1000')
    // Detect a foreign journal mode before switching it: a durable root must
    // already be in the required rollback-journal mode, and the runner never
    // silently rewrites a property another writer chose.
    const observed = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    const observedMode = String(observed.journal_mode ?? '').toLowerCase()
    if (observedMode !== REQUIRED_JOURNAL_MODE) {
      throw workbenchError('schema_drift', `journal_mode is ${observedMode}`, 'stop other processes using this database and re-run; do not edit the database')
    }
    db.exec('PRAGMA synchronous = FULL')
    // SQLite creates files with umask-derived modes; C3 requires owner-only.
    try { chmodSync(path, OWNED_FILE_MODE) } catch { /* existing file may already be correct */ }
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    sqliteFailure(path, error)
  }
  try {
    if (options.create) {
      db.exec(STORE_DDL)
      db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
    }
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    sqliteFailure(path, error)
  }
  return db
}

function readPragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  return row ? row[name] : undefined
}

export function assertSchemaShape(db: DatabaseSync, path: string): void {
  const version = Number(readPragma(db, 'user_version'))
  if (version !== STORE_SCHEMA_VERSION) {
    throw workbenchError(
      'unsupported_schema',
      `store schema version ${version} is not supported (expected ${STORE_SCHEMA_VERSION})`,
      'open this root with the workbench version that created it; migration requires an exclusive owner and a verified backup',
    )
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  const present = new Map(tables.map(entry => [entry.name, entry]))
  for (const spec of STORE_TABLES) {
    if (!present.has(spec.name)) {
      throw workbenchError('schema_drift', `store is missing table ${spec.name}`, 'restore the latest verified backup; do not add or drop tables by hand')
    }
    const columns = new Set((db.prepare(`PRAGMA table_info(${spec.name})`).all() as Array<{ name: string }>).map(entry => entry.name))
    for (const column of spec.columns) {
      if (!columns.has(column)) {
        throw workbenchError('schema_drift', `table ${spec.name} is missing column ${column}`, 'restore the latest verified backup; do not edit schema by hand')
      }
    }
  }
  for (const spec of STORE_TABLES) present.delete(spec.name)
  if (present.size > 0) {
    const extra = [...present.keys()].join(', ')
    throw workbenchError('schema_drift', `store has unexpected tables: ${extra}`, 'restore the latest verified backup; unknown tables are never dropped automatically')
  }
  // Compare SQLite's own canonical schema representation, including constraints,
  // indexes and triggers. Matching column names alone accepts weakened tables.
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec(STORE_DDL)
    const shape = (connection: DatabaseSync) => connection.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()
    if (JSON.stringify(shape(db)) !== JSON.stringify(shape(reference))) {
      throw workbenchError('schema_drift', `constraint/index/trigger drift in ${path}`, 'use the exact supported schema; never repair unknown history automatically')
    }
  } finally { reference.close() }
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || String(Object.values(integrity[0])[0]).toLowerCase() !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw workbenchError('integrity_failure', `integrity/foreign key check failed for ${path}`, 'preserve the damaged database; do not keep writing')
  }
  for (const row of db.prepare('SELECT * FROM bridge_deliveries').all()) validateDelivery(rowToDelivery(row))
  const identityNode = db.prepare("SELECT value FROM meta WHERE key = 'node_id'").get()?.value
  for (const row of db.prepare('SELECT i.*, b.project_id, g.project_id AS goal_project_id, p.execution_node_id FROM binding_identities i LEFT JOIN bindings b USING (run_id) LEFT JOIN goals g ON g.goal_id = i.goal_id LEFT JOIN projects p ON p.project_id = b.project_id').all()) {
    try {
      const identity = validateIncarnation(JSON.parse(String(row.incarnation_json)))
      if (incarnationKey(identity) !== row.incarnation_key || row.project_id !== row.goal_project_id || identity.executionNodeId !== row.execution_node_id || identity.executionNodeId !== identityNode) throw Error('identity association drift')
    } catch {
      throw workbenchError('schema_drift', 'persisted binding identity is invalid', 'preserve exact identity; do not reconstruct it from paths or Run IDs')
    }
  }
  if (db.prepare("SELECT 1 FROM role_memberships m JOIN binding_identities i USING (run_id) JOIN bindings b USING (run_id) WHERE m.goal_id != i.goal_id OR m.role IS NOT b.role OR b.state IN ('proposed', 'authorized', 'acknowledged') LIMIT 1").get()) {
    throw workbenchError('schema_drift', 'persisted Role membership association is invalid', 'a proposal never occupies a Goal Role')
  }
  for (const table of STORE_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string; type: string }>
    for (const column of columns.filter(c => c.type.toUpperCase() === 'INTEGER')) {
      const invalid = db.prepare(`SELECT 1 FROM ${table.name} WHERE ${column.name} IS NOT NULL AND
        (typeof(${column.name}) != 'integer' OR ${column.name} < 0 OR ${column.name} > 9007199254740991) LIMIT 1`).get()
      if (invalid) throw workbenchError('schema_drift', `invalid integer ${table.name}.${column.name}`, 'preserve and inspect corrupt history; counters cannot be rounded or reset')
    }
  }
  for (const key of ['runner_epoch', 'projection_revision', 'event_cursor']) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    if (row && (!/^(0|[1-9][0-9]*)$/.test(row.value) || !Number.isSafeInteger(Number(row.value)))) {
      throw workbenchError('schema_drift', `invalid persisted counter ${key}`, 'preserve the original counter; do not round or reset it')
    }
  }
}

export function openWorkbenchStore(options: StoreOptions): WorkbenchStore {
  const { path } = options
  const nodeId = assertNodeId(options.nodeId)
  const clock = options.clock ?? (() => Date.now())
  const db = openDatabase(path, options)
  try {
    assertSchemaShape(db, path)
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    throw error
  }
  db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)

  const storedNode = db.prepare('SELECT value FROM meta WHERE key = ?').get('node_id') as { value?: string } | undefined
  if (storedNode?.value !== undefined) {
    if (storedNode.value !== nodeId) {
      try { db.close() } catch { /* already failing */ }
      throw workbenchError('identity_drift', `store Node identity ${storedNode.value} does not match ownership manifest ${nodeId}`, 'restore the ownership manifest and store from the same backup; do not delete either file')
    }
  } else {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('node_id', nodeId)
  }
  const storedSchema = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  if (storedSchema?.value !== undefined && Number(storedSchema.value) !== STORE_SCHEMA_VERSION) {
    try { db.close() } catch { /* already failing */ }
    throw workbenchError('unsupported_schema', `store metadata schema ${storedSchema.value} is not supported`, 'migration requires an exclusive owner and a verified backup')
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION))

  const currentEpoch = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get('runner_epoch') as { value?: string } | undefined)?.value ?? '0')
  if (!Number.isSafeInteger(currentEpoch + 1)) {
    db.close()
    throw workbenchError('schema_drift', 'runner epoch exhausted', 'preserve history; do not reset the epoch')
  }
  let epoch = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    epoch = currentEpoch + 1
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('runner_epoch', String(epoch))
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already failing */ }
    try { db.close() } catch { /* already failing */ }
    sqliteFailure(path, error)
  }

  let transactionDepth = 0
  let savepointSequence = 0
  function transaction<T>(fn: () => T): T {
    const savepoint = transactionDepth === 0 ? null : `command_${++savepointSequence}`
    db.exec(savepoint === null ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    transactionDepth++
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('store transactions must be synchronous')
      db.exec(savepoint === null ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      try {
        if (savepoint === null) db.exec('ROLLBACK')
        else db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`)
      } catch { /* preserve the original failure */ }
      throw error
    } finally { transactionDepth-- }
  }

  return {
    path,
    nodeId,
    epoch,
    getMeta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
      return row?.value ?? null
    },
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
    },
    transaction,
    putBinding(binding) {
      const frozen = db.prepare('SELECT b.* FROM bindings b JOIN binding_identities i USING (run_id) WHERE b.run_id = ?').get(binding.runId)
      if (frozen && (frozen.project_id !== binding.projectId || frozen.role !== binding.role || frozen.binding_digest !== binding.bindingDigest || frozen.predecessor_run_id !== binding.predecessorRunId)) {
        throw workbenchError('identity_drift', 'binding commitment fields are immutable', 'create a separately authorized Run; never retarget existing identity')
      }
      db.prepare(
        `INSERT INTO bindings (run_id, project_id, role, state, binding_digest, control_epoch, writer_state, predecessor_run_id, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           project_id = excluded.project_id, role = excluded.role, state = excluded.state,
           binding_digest = excluded.binding_digest, control_epoch = excluded.control_epoch,
           writer_state = excluded.writer_state, predecessor_run_id = excluded.predecessor_run_id,
           generation = excluded.generation, updated_at = excluded.updated_at`,
      ).run(
        binding.runId, binding.projectId, binding.role, binding.state, binding.bindingDigest,
        binding.controlEpoch, binding.writerState, binding.predecessorRunId, binding.generation, binding.updatedAt,
      )
    },
    getBinding(runId) {
      const row = db.prepare('SELECT * FROM bindings WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
      return row ? rowToBinding(row) : null
    },
    listBindings() {
      return (db.prepare('SELECT * FROM bindings ORDER BY run_id').all() as Array<Record<string, unknown>>).map(rowToBinding)
    },
    putBindingIdentity(runId, goalId, incarnation) {
      const verified = validateIncarnation(incarnation)
      const binding = db.prepare('SELECT project_id FROM bindings WHERE run_id = ?').get(runId) as { project_id: string } | undefined
      const goal = db.prepare('SELECT g.project_id, p.execution_node_id FROM goals g JOIN projects p USING (project_id) WHERE goal_id = ?').get(goalId) as { project_id: string; execution_node_id: string } | undefined
      if (!binding || !goal || binding.project_id !== goal.project_id || verified.executionNodeId !== nodeId || goal.execution_node_id !== nodeId) {
        throw workbenchError('identity_drift', 'binding Goal/Project/Node identity mismatch', 'confirm the exact Goal and bridge incarnation')
      }
      const key = incarnationKey(verified)
      const existing = db.prepare('SELECT goal_id, incarnation_key FROM binding_identities WHERE run_id = ?').get(runId) as { goal_id: string; incarnation_key: string } | undefined
      if (existing) {
        if (existing.goal_id !== goalId || existing.incarnation_key !== key) throw workbenchError('identity_drift', 'binding identity is immutable', 'create a fresh authorized binding; never retarget a Run')
        return
      }
      db.prepare('INSERT INTO binding_identities VALUES (?, ?, ?, ?)').run(runId, goalId, JSON.stringify(verified), key)
    },
    getBindingIdentity(runId) {
      const row = db.prepare('SELECT * FROM binding_identities WHERE run_id = ?').get(runId) as { goal_id: string; incarnation_json: string; incarnation_key: string } | undefined
      if (!row) return null
      const incarnation = validateIncarnation(JSON.parse(row.incarnation_json))
      if (incarnationKey(incarnation) !== row.incarnation_key) throw workbenchError('identity_drift', 'incarnation digest changed', 'preserve the original binding')
      return { runId, goalId: row.goal_id, incarnation, incarnationKey: row.incarnation_key }
    },
    commitMembership(runId) {
      const row = db.prepare('SELECT i.goal_id, b.role, b.state FROM binding_identities i JOIN bindings b USING (run_id) WHERE run_id = ?').get(runId)
      if (!row || row.state !== 'committed' || typeof row.role !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.role)) throw workbenchError('invalid_input', 'membership requires an exact committed binding and Role', 'proposals and acknowledgements are not members')
      // The caller commits binding state, this insertion and the outcome in
      // one store transaction. SQL uniqueness is the final occupancy arbiter.
      db.prepare('INSERT INTO role_memberships VALUES (?, ?, ?)').run(String(row.goal_id), row.role, runId)
    },
    releaseMembership(runId) { db.prepare('DELETE FROM role_memberships WHERE run_id = ?').run(runId) },
    listMemberships(goalId) {
      return db.prepare('SELECT * FROM role_memberships WHERE goal_id = ? ORDER BY role').all(goalId).map(row => ({ goalId: String(row.goal_id), role: String(row.role), runId: String(row.run_id) }))
    },
    purgeRetiredHistory(runId, now) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM bindings WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
        if (!row) return
        if (!['retired', 'purged'].includes(String(row.state))) throw workbenchError('invalid_input', 'purge requires retired history', 'retire the exact Run first')
        if (db.prepare('SELECT 1 FROM bindings WHERE predecessor_run_id = ?').get(runId)) throw workbenchError('invalid_input', 'purge requires a leaf', 'purge successors first')
        if (row.writer_state !== 'none' && row.project_id !== null) {
          db.prepare('INSERT OR IGNORE INTO uncertain_effects VALUES (?, ?, ?)').run(runId, String(row.project_id), now)
        }
        db.prepare("DELETE FROM events WHERE run_id = ? AND (kind LIKE 'adoption_%' OR kind IN ('control_taken', 'retire', 'purge'))").run(runId)
        db.prepare('DELETE FROM bindings WHERE run_id = ?').run(runId)
      })
    },
    hasUncertainEffects(projectId) {
      return !!db.prepare('SELECT 1 FROM uncertain_effects WHERE project_id = ? LIMIT 1').get(projectId)
    },
    setBindingState(runId, state, updatedAt) {
      const info = db.prepare('UPDATE bindings SET state = ?, updated_at = ? WHERE run_id = ?').run(state, updatedAt, runId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `binding ${runId} does not exist`, 'recreate the binding through explicit Adoption; do not insert rows by hand')
      }
    },
    setBindingControlEpoch(runId, controlEpoch, updatedAt) {
      const info = db.prepare('UPDATE bindings SET control_epoch = ?, updated_at = ? WHERE run_id = ?').run(controlEpoch, updatedAt, runId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `binding ${runId} does not exist`, 'recreate the binding through explicit Adoption; do not insert rows by hand')
      }
    },
    markUncertainInFlight(updatedAt) {
      const rows = db.prepare('SELECT run_id FROM bindings WHERE state IN (?, ?, ?)').all(...UNCERTAIN_BINDING_STATES) as Array<{ run_id: string }>
      for (const row of rows) {
        db.prepare("UPDATE bindings SET writer_state = 'uncertain', updated_at = ? WHERE run_id = ?").run(updatedAt, row.run_id)
      }
      return rows.map(row => row.run_id)
    },
    putProject(project) {
      db.prepare(
        `INSERT INTO projects (project_id, execution_node_id, canonical_path, git_common_dir, head_oid, dirty, context_digest, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           execution_node_id = excluded.execution_node_id, canonical_path = excluded.canonical_path,
           git_common_dir = excluded.git_common_dir, head_oid = excluded.head_oid, dirty = excluded.dirty,
           context_digest = excluded.context_digest, revision = excluded.revision, created_at = excluded.created_at`,
      ).run(
        project.projectId, project.executionNodeId, project.canonicalPath, project.gitCommonDir,
        project.headOid, project.dirty ? 1 : 0, project.contextDigest, project.revision, project.createdAt,
      )
    },
    getProject(projectId) {
      const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined
      return row ? rowToProject(row) : null
    },
    listProjects() {
      return (db.prepare('SELECT * FROM projects ORDER BY created_at, project_id').all() as Array<Record<string, unknown>>).map(rowToProject)
    },
    insertGoal(goal) {
      db.prepare('INSERT INTO goals (goal_id, project_id, goal_text, state, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(goal.goalId, goal.projectId, goal.goalText, goal.state, goal.outcome, goal.createdAt)
    },
    setGoalState(goalId, state, outcome) {
      const info = db.prepare('UPDATE goals SET state = ?, outcome = ? WHERE goal_id = ?').run(state, outcome, goalId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `goal ${goalId} does not exist`, 'select the Goal from the committed projection; do not insert rows by hand')
      }
    },
    putCheck(check) {
      db.prepare(
        `INSERT INTO check_definitions (project_id, check_id, version, digest, canonical_json, name, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, check_id, version) DO UPDATE SET
           digest = excluded.digest, canonical_json = excluded.canonical_json, name = excluded.name, mode = excluded.mode`,
      ).run(check.projectId, check.checkId, check.version, check.digest, check.canonicalJson, check.name, check.mode, check.createdAt)
    },
    getCheck(projectId, checkId, version) {
      const row = db.prepare('SELECT * FROM check_definitions WHERE project_id = ? AND check_id = ? AND version = ?')
        .get(projectId, checkId, version) as Record<string, unknown> | undefined
      return row ? rowToCheck(row) : null
    },
    latestCheck(projectId, checkId) {
      const row = db.prepare('SELECT * FROM check_definitions WHERE project_id = ? AND check_id = ? ORDER BY version DESC LIMIT 1')
        .get(projectId, checkId) as Record<string, unknown> | undefined
      return row ? rowToCheck(row) : null
    },
    listChecks(projectId) {
      return (db.prepare('SELECT * FROM check_definitions WHERE project_id = ? ORDER BY check_id, version').all(projectId) as Array<Record<string, unknown>>).map(rowToCheck)
    },
    appendEvent(event) {
      db.prepare('INSERT INTO events (event_id, cursor, base_revision, revision, kind, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(event.eventId, event.cursor, event.baseRevision, event.revision, event.kind, event.createdAt, event.runId ?? null)
    },
    listEvents() {
      return (db.prepare('SELECT * FROM events ORDER BY cursor').all() as Array<Record<string, unknown>>).map(rowToEvent)
    },
    maxCursor() {
      const row = db.prepare('SELECT MAX(cursor) AS cursor FROM events').get() as { cursor?: number | null } | undefined
      const retained = db.prepare("SELECT value FROM meta WHERE key = 'event_cursor'").get() as { value: string } | undefined
      return Math.max(row?.cursor === null || row?.cursor === undefined ? -1 : Number(row.cursor), retained ? Number(retained.value) : -1)
    },
    getGoal(goalId) {
      const row = db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined
      return row ? rowToGoal(row) : null
    },
    listGoals(projectId) {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM goals ORDER BY created_at, goal_id').all()
        : db.prepare('SELECT * FROM goals WHERE project_id = ? ORDER BY created_at, goal_id').all(projectId)
      return (rows as Array<Record<string, unknown>>).map(rowToGoal)
    },
    putDelivery(delivery) {
      validateDelivery(delivery)
      if (delivery.state !== 'queued' || delivery.reasonCode !== null) throw workbenchError('invalid_input', 'new delivery must be queued', 'never invent a completed send')
      db.prepare('INSERT INTO bridge_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(delivery.frameId, delivery.runId, delivery.kind, delivery.frameJson, delivery.connectionId, delivery.deadline, delivery.state, delivery.reasonCode, delivery.createdAt)
    },
    listDeliveries(runId) {
      const rows = runId === undefined ? db.prepare('SELECT * FROM bridge_deliveries ORDER BY created_at, frame_id').all()
        : db.prepare('SELECT * FROM bridge_deliveries WHERE run_id = ? ORDER BY created_at, frame_id').all(runId)
      return rows.map(rowToDelivery)
    },
    transitionDelivery(frameId, from, to, reasonCode) {
      if (!(from === 'queued' && ['attempting', 'not_sent'].includes(to)) && !(from === 'attempting' && ['written', 'unknown'].includes(to))) throw workbenchError('invalid_input', 'delivery transitions never reset an attempt', 'unknown delivery requires explicit reconciliation, not retry')
      if (![null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted'].includes(reasonCode)) throw workbenchError('invalid_input', 'invalid delivery reason', 'use a bounded delivery disposition')
      const current = db.prepare('SELECT * FROM bridge_deliveries WHERE frame_id = ?').get(frameId)
      if (!current || current.state !== from) return false
      validateDelivery({ ...rowToDelivery(current), state: to, reasonCode })
      return Number(db.prepare('UPDATE bridge_deliveries SET state = ?, reason_code = ? WHERE frame_id = ? AND state = ?').run(to, reasonCode, frameId, from).changes) === 1
    },
    putManagementOperation(operation) {
      db.prepare('INSERT INTO management_operations VALUES (?, ?, ?, ?, ?, ?, ?)').run(operation.intentId, operation.sessionId, operation.payloadHash, operation.kind, operation.runId, operation.targetJson, operation.createdAt)
    },
    listManagementOperations() {
      return db.prepare('SELECT * FROM management_operations ORDER BY created_at, intent_id').all().map(row => ({
        intentId: String(row.intent_id), sessionId: String(row.session_id), payloadHash: String(row.payload_hash), kind: String(row.kind) as ManagementOperation['kind'],
        runId: String(row.run_id), targetJson: String(row.target_json), createdAt: Number(row.created_at),
      }))
    },
    deleteManagementOperation(intentId) { db.prepare('DELETE FROM management_operations WHERE intent_id = ?').run(intentId) },
    putIntentResult(record) {
      db.prepare(
        `INSERT INTO intent_dedup (intent_id, session_id, payload_hash, status, reason_code, committed_revision, created_at, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(intent_id) DO NOTHING`,
      ).run(record.intentId, record.sessionId, record.payloadHash, record.status, record.reasonCode, record.committedRevision, record.createdAt, record.reason ?? null, record.detail ?? null)
    },
    getIntentResult(intentId) {
      const row = db.prepare('SELECT * FROM intent_dedup WHERE intent_id = ?').get(intentId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        intentId: String(row.intent_id), sessionId: String(row.session_id), payloadHash: String(row.payload_hash),
        status: String(row.status), reasonCode: row.reason_code === null ? null : String(row.reason_code),
        reason: row.reason === null ? null : String(row.reason), detail: row.detail === null ? null : String(row.detail),
        committedRevision: row.committed_revision === null ? null : Number(row.committed_revision), createdAt: Number(row.created_at),
      }
    },
    integrityCheck() {
      return String(readPragma(db, 'integrity_check') ?? 'ok')
    },
    backupTo(target) {
      const escaped = target.replace(/'/g, "''")
      db.exec(`VACUUM INTO '${escaped}'`)
    },
    close() {
      try { db.close() } catch { /* closing is best-effort on shutdown */ }
    },
  }
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    projectId: String(row.project_id),
    executionNodeId: String(row.execution_node_id),
    canonicalPath: String(row.canonical_path),
    gitCommonDir: String(row.git_common_dir),
    headOid: row.head_oid === null ? null : String(row.head_oid),
    dirty: Number(row.dirty) !== 0,
    contextDigest: row.context_digest === null ? null : String(row.context_digest),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
  }
}

function rowToDelivery(row: Record<string, unknown>): BridgeDelivery {
  return { frameId: String(row.frame_id), runId: String(row.run_id), kind: String(row.kind) as BridgeDelivery['kind'], frameJson: String(row.frame_json), connectionId: String(row.connection_id), deadline: Number(row.deadline), state: String(row.state) as DeliveryState, reasonCode: row.reason_code === null ? null : String(row.reason_code), createdAt: Number(row.created_at) }
}

function rowToBinding(row: Record<string, unknown>): BindingRecord {
  return {
    runId: String(row.run_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    role: row.role === null ? null : String(row.role),
    state: String(row.state) as BindingState,
    bindingDigest: row.binding_digest === null ? null : String(row.binding_digest),
    controlEpoch: Number(row.control_epoch),
    writerState: String(row.writer_state) as WriterState,
    predecessorRunId: row.predecessor_run_id === null ? null : String(row.predecessor_run_id),
    generation: row.generation === null ? null : Number(row.generation),
    updatedAt: Number(row.updated_at),
  }
}

function rowToCheck(row: Record<string, unknown>): CheckRecord {
  return {
    projectId: String(row.project_id),
    checkId: String(row.check_id),
    version: Number(row.version),
    digest: String(row.digest),
    canonicalJson: String(row.canonical_json),
    name: String(row.name),
    mode: String(row.mode),
    createdAt: Number(row.created_at),
  }
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    eventId: String(row.event_id),
    cursor: Number(row.cursor),
    baseRevision: Number(row.base_revision),
    revision: Number(row.revision),
    kind: String(row.kind),
    createdAt: Number(row.created_at),
  }
}

function rowToGoal(row: Record<string, unknown>): GoalRecord {
  return {
    goalId: String(row.goal_id), projectId: String(row.project_id), goalText: String(row.goal_text),
    state: String(row.state) as GoalRecord['state'], outcome: row.outcome === null ? null : String(row.outcome), createdAt: Number(row.created_at),
  }
}

/** Verified durability settings for tests and documentation. */
export function describeStoreSettings(store: WorkbenchStore): Record<string, unknown> {
  return {
    path: store.path,
    nodeId: store.nodeId,
    epoch: store.epoch,
    integrity: store.integrityCheck(),
    journalMode: REQUIRED_JOURNAL_MODE,
    synchronous: REQUIRED_PRAGMAS.synchronous,
    foreignKeys: REQUIRED_PRAGMAS.foreign_keys,
    busyTimeoutMs: REQUIRED_PRAGMAS.busy_timeout,
    schemaVersion: STORE_SCHEMA_VERSION,
    fileMode: OWNED_FILE_MODE.toString(8),
  }
}
