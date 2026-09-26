/** Independent revocations. Ledger intent commits before store history changes.
 * A purged fence retains only a Run replay key and optional exact-incarnation
 * hash. Pending purge rows retain recovery context until store deletion commits.
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { workbenchError } from './errors.ts'
export const FENCE_LEDGER_SCHEMA_VERSION = 2
const FENCE_DDL = `
CREATE TABLE binding_fences (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  goal_id TEXT,
  role TEXT,
  binding_digest TEXT,
  incarnation_key TEXT,
  generation INTEGER NOT NULL,
  predecessor_run_id TEXT,
  retired_at INTEGER NOT NULL,
  purged_at INTEGER
);
CREATE TABLE vacancy_high_water (
  project_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (project_id, goal_id, role)
);
CREATE TABLE purged_fences (run_id TEXT PRIMARY KEY, incarnation_key TEXT);
`
export interface BindingFence {
  runId: string
  projectId: string
  goalId: string | null
  role: string | null
  bindingDigest: string | null
  incarnationKey: string | null
  generation: number
  predecessorRunId: string | null
  retiredAt: number
  purgedAt: number | null
}
export interface RecordRetirementInput {
  runId: string
  projectId: string
  goalId?: string | null
  role: string | null
  bindingDigest: string | null
  incarnationKey?: string | null
  predecessorRunId: string | null
}
export interface FenceLedger {
  readonly path: string
  recordRetirement(input: RecordRetirementInput): BindingFence
  getFence(runId: string): BindingFence | null
  listFences(): BindingFence[]
  highWater(projectId: string, role: string | null, goalId?: string | null): number
  isFenced(runId: string): boolean
  isIncarnationFenced(key: string): boolean
  assertIncarnationFence(runId: string, key: string): void
  isPurged(runId: string): boolean
  assertFence(runId: string): BindingFence
  markPurged(runId: string, purgedAt: number): void
  completePurge(runId: string): void
  assertVacancyGeneration(projectId: string, role: string | null, generation: number, goalId?: string | null): void
  integrityCheck(): string
  close(): void
}
export interface FenceLedgerOptions { path: string; create: boolean; clock?: () => number }
function rowToFence(row: Record<string, unknown>): BindingFence {
  const text = (key: string) => row[key] === null ? null : String(row[key])
  return { runId: String(row.run_id), projectId: String(row.project_id), goalId: text('goal_id'), role: text('role'),
    bindingDigest: text('binding_digest'), incarnationKey: text('incarnation_key'), generation: Number(row.generation),
    predecessorRunId: text('predecessor_run_id'), retiredAt: Number(row.retired_at), purgedAt: row.purged_at === null ? null : Number(row.purged_at) }
}
/** Read-only validation shared by startup and explicit upgrade inspection. */
export function assertFenceSchema(db: DatabaseSync): void {
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw workbenchError('schema_drift', 'fence ledger requires DELETE journal mode', 'preserve the ledger')
  if (db.prepare('PRAGMA user_version').get()?.user_version !== FENCE_LEDGER_SCHEMA_VERSION) throw workbenchError('unsupported_schema', 'unsupported fence ledger schema', 'use its original workbench version; never reconstruct lost revocations')
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec(FENCE_DDL)
    const shape = (connection: DatabaseSync) => connection.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
    if (JSON.stringify(shape(db)) !== JSON.stringify(shape(reference))) throw workbenchError('schema_drift', 'fence schema drift', 'preserve the ledger')
  } finally { reference.close() }
  for (const [table, columns] of [['binding_fences', ['generation', 'retired_at', 'purged_at']], ['vacancy_high_water', ['generation']]] as const) {
    for (const column of columns) if (db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND (typeof(${column}) != 'integer' OR ${column} < 0 OR ${column} > 9007199254740991) LIMIT 1`).get()) throw workbenchError('schema_drift', 'unsafe fence counter', 'never reset or round generations')
  }
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw workbenchError('integrity_failure', 'fence integrity check failed', 'preserve the ledger')
}

export function openFenceLedger(options: FenceLedgerOptions): FenceLedger {
  const clock = options.clock ?? (() => Date.now())
  const db = new DatabaseSync(options.path)
  try {
    chmodSync(options.path, 0o600)
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL')
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw workbenchError('schema_drift', 'fence ledger requires DELETE journal mode', 'preserve the ledger')
    if (options.create) { db.exec(FENCE_DDL); db.exec(`PRAGMA user_version = ${FENCE_LEDGER_SCHEMA_VERSION}`) }
    assertFenceSchema(db)
  } catch (error) { db.close(); throw error }
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function getFence(runId: string): BindingFence | null {
    const row = db.prepare('SELECT * FROM binding_fences WHERE run_id = ?').get(runId)
    return row ? rowToFence(row) : null
  }
  function isPurged(runId: string): boolean { return !!db.prepare('SELECT 1 FROM purged_fences WHERE run_id = ?').get(runId) }
  function requireFence(runId: string): BindingFence {
    const fence = getFence(runId)
    if (!fence) throw workbenchError('fence_missing', `no retained retirement history for ${runId}`, 'a minimal purged fence is not an Agent Run or recoverable commitment')
    return fence
  }
  function highWater(projectId: string, role: string | null, goalId: string | null = null): number {
    const row = db.prepare('SELECT generation FROM vacancy_high_water WHERE project_id = ? AND goal_id = ? AND role = ?').get(projectId, goalId ?? '', role ?? '')
    return row ? Number(row.generation) : 0
  }
  return {
    path: options.path,
    recordRetirement(input) {
      return transaction(() => {
        if (isPurged(input.runId)) throw workbenchError('fence_conflict', 'purged Run cannot be recreated', 'retain the minimal fence')
        const existing = getFence(input.runId)
        if (existing) {
          if (existing.projectId !== input.projectId || existing.goalId !== (input.goalId ?? null) || existing.role !== input.role
              || existing.bindingDigest !== input.bindingDigest || existing.incarnationKey !== (input.incarnationKey ?? null)
              || existing.predecessorRunId !== input.predecessorRunId) throw workbenchError('fence_conflict', 'retirement identity changed', 'never retarget a fence')
          return existing
        }
        if (input.incarnationKey != null && !/^[a-f0-9]{64}$/.test(input.incarnationKey)) throw workbenchError('invalid_input', 'invalid incarnation key', 'use the stored exact-incarnation digest')
        const generation = highWater(input.projectId, input.role, input.goalId) + 1
        if (!Number.isSafeInteger(generation)) throw workbenchError('fence_conflict', 'vacancy generation exhausted', 'never reset a high-water mark')
        const retiredAt = clock()
        db.prepare('INSERT INTO binding_fences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(input.runId, input.projectId, input.goalId ?? null, input.role, input.bindingDigest, input.incarnationKey ?? null, generation, input.predecessorRunId, retiredAt)
        db.prepare('INSERT INTO vacancy_high_water VALUES (?, ?, ?, ?) ON CONFLICT(project_id, goal_id, role) DO UPDATE SET generation = excluded.generation').run(input.projectId, input.goalId ?? '', input.role ?? '', generation)
        return requireFence(input.runId)
      })
    },
    getFence,
    listFences() { return db.prepare('SELECT * FROM binding_fences ORDER BY generation, run_id').all().map(rowToFence) },
    highWater,
    isPurged,
    isFenced(runId) { return isPurged(runId) || getFence(runId) !== null },
    isIncarnationFenced(key) {
      return !!db.prepare('SELECT 1 FROM binding_fences WHERE incarnation_key = ? UNION ALL SELECT 1 FROM purged_fences WHERE incarnation_key = ? LIMIT 1').get(key, key)
    },
    assertIncarnationFence(runId, key) {
      const row = db.prepare('SELECT incarnation_key FROM binding_fences WHERE run_id = ? UNION ALL SELECT incarnation_key FROM purged_fences WHERE run_id = ?').get(runId, runId)
      if (!row || row.incarnation_key !== key) throw workbenchError('fence_conflict', 'retained incarnation fence differs from history', 'preserve both resources; never reconstruct or overwrite a revocation')
    },
    assertFence: requireFence,
    markPurged(runId, now) {
      requireFence(runId)
      transaction(() => db.prepare('UPDATE binding_fences SET purged_at = COALESCE(purged_at, ?) WHERE run_id = ?').run(now, runId))
    },
    completePurge(runId) {
      transaction(() => {
        if (isPurged(runId)) return
        const fence = requireFence(runId)
        if (fence.purgedAt === null) throw workbenchError('fence_conflict', 'purge intent not durable', 'record the exact purge authorization before deleting history')
        db.prepare('INSERT INTO purged_fences VALUES (?, ?)').run(runId, fence.incarnationKey)
        db.prepare('DELETE FROM binding_fences WHERE run_id = ?').run(runId)
      })
    },
    assertVacancyGeneration(projectId, role, generation, goalId) {
      if (!Number.isSafeInteger(generation) || generation <= highWater(projectId, role, goalId)) throw workbenchError('fence_conflict', 'stale vacancy generation', 'use the current Goal-scoped vacancy generation')
    },
    integrityCheck() { return String(db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unavailable') },
    close() { try { db.close() } catch { /* idempotent disposal */ } },
  }
}
