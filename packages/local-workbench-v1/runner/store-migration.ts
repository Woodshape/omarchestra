/** Explicit, offline schema 9 -> 10 upgrade. Not imported by Owner startup.
 * Additive DDL and version metadata commit in-place in one SQLite transaction.
 * Existing rows, revocations, ownership inodes and counters are not rewritten.
 * No restore, receipt repair, recovery, readiness or dispatch occurs here.
 */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acquireOwnerLock } from './owner-lock.ts'
import { verifyOwnedReceipt, ownedPathIdentity } from './owned-resources.ts'
import { readManifest } from './manifest.ts'
import { assertOutsideProject, resolveRoots, type WorkbenchRootsInput, type WorkbenchRoots } from './paths.ts'
import { assertSchema9ForMigration, assertSchemaShape } from './store.ts'
import { assertFenceSchema } from './fences.ts'
import { ASSIGNMENT_SCHEMA_DDL, STORE_V9_TABLES } from './schema.ts'
import { workbenchError } from './errors.ts'

const MAX_FILE_BYTES = 64 * 1024 * 1024
const MIGRATION_KEY = 'schema_migration_9_10'
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function refuse(message: string): never {
  throw workbenchError('migration_unavailable', message,
    'preserve the store, fence ledger and all evidence; stop the exact Owner and inspect a fresh explicit upgrade plan; never delete or repair state by hand')
}
function privateDirectory(path: string): void {
  if (!isAbsolute(path)) refuse('upgrade directories must be absolute')
  const s = lstatSync(path) // Missing directories are never created by inspection.
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700
      || realpathSync(path) !== resolve(path)) refuse('upgrade directory must be canonical, existing and private')
}
function boundedBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const s = fstatSync(fd), named = lstatSync(path)
    if (!s.isFile() || named.isSymbolicLink() || named.ino !== s.ino || named.dev !== s.dev || s.nlink !== 1 || s.uid !== process.getuid?.()
        || (s.mode & 0o777) !== 0o600 || s.size > MAX_FILE_BYTES) refuse('upgrade file ownership, size, mode or links are unsafe')
    const bytes = Buffer.alloc(s.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    if (length !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs) refuse('upgrade file changed during bounded read')
    return bytes.subarray(0, length)
  } finally { closeSync(fd) }
}
function fileHash(path: string): string { return hash(boundedBytes(path)) }
function openDatabase(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON')
    if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') refuse('upgrade requires DELETE journal mode')
    if (!readOnly) db.exec('PRAGMA synchronous = FULL')
    return db
  } catch (error) { db.close(); throw error }
}
function rootsForUpgrade(input: WorkbenchRootsInput, evidenceDir: string): WorkbenchRoots {
  privateDirectory(input.stateDir)
  if (input.runtimeDir) privateDirectory(input.runtimeDir)
  privateDirectory(evidenceDir)
  const roots = resolveRoots(input)
  for (const dir of [roots.stateDir, roots.runtimeDir].filter((p): p is string => p !== null)) {
    assertOutsideProject(evidenceDir, dir)
  }
  for (let dir = evidenceDir; ; dir = dirname(dir)) {
    if (readdirSync(dir).includes('.git')) refuse('upgrade evidence must be outside Git')
    if (dirname(dir) === dir) break
  }
  assertOffline(roots)
  return roots
}
function assertOffline(roots: WorkbenchRoots): void {
  if (roots.runtimeDir && readdirSync(roots.runtimeDir).length !== 0) refuse('runtime root is not empty; no socket may be removed by name')
  if (readdirSync(roots.stateDir).some(name => /(?:-journal|-wal|-shm|\.new)$/.test(name))) {
    refuse('SQLite sidecar or staged resource needs explicit recovery before upgrade')
  }
}
/** Every legacy row/counter remains byte-equivalent as SQL values, except the
 * explicitly advanced schema metadata. Row IDs are included too. */
function historyDigest(db: DatabaseSync): string {
  const digest = createHash('sha256')
  for (const { name } of STORE_V9_TABLES) {
    const where = name === 'meta' ? " WHERE key NOT IN ('schema_version', 'schema_migration_9_10')" : ''
    digest.update(JSON.stringify([name, db.prepare(`SELECT rowid AS _migration_rowid_, * FROM ${name}${where} ORDER BY rowid`).all()]))
  }
  return digest.digest('hex')
}
export interface StoreUpgradePlan {
  kind: 'omarchestra.workbench/store-upgrade'
  from: 9
  to: 10
  stateDir: string
  runtimeDir: string | null
  evidenceDir: string
  evidenceIdentity: ReturnType<typeof ownedPathIdentity>
  nodeId: string
  sourceDigest: string
  fenceDigest: string
  manifestDigest: string
  receiptDigest: string
  historyDigest: string
  digest: string
}
function inspect(roots: WorkbenchRoots, evidenceDir: string): StoreUpgradePlan {
  const guard = verifyOwnedReceipt(roots)
  const sourceDigest = fileHash(roots.databasePath), fenceDigest = fileHash(roots.fenceDatabasePath)
  const manifestDigest = fileHash(roots.manifestPath), receiptDigest = fileHash(join(roots.stateDir, 'ownership.json'))
  const manifest = readManifest(roots)
  const db = openDatabase(roots.databasePath, true)
  let history: string
  try {
    assertSchema9ForMigration(db, roots.databasePath)
    if (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value !== '9') refuse('store metadata is not schema 9')
    if (db.prepare("SELECT value FROM meta WHERE key = 'node_id'").get()?.value !== manifest.nodeId) refuse('store and manifest Node identities differ')
    if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(MIGRATION_KEY)) refuse('unexpected prior migration record')
    for (const row of db.prepare('SELECT canonical_path FROM projects').all()) assertOutsideProject(evidenceDir, String(row.canonical_path))
    history = historyDigest(db)
  } finally { db.close() }
  const fences = openDatabase(roots.fenceDatabasePath, true)
  try { assertFenceSchema(fences) } finally { fences.close() }
  guard()
  if (fileHash(roots.databasePath) !== sourceDigest || fileHash(roots.fenceDatabasePath) !== fenceDigest) refuse('upgrade source changed during inspection')
  const body = { kind: 'omarchestra.workbench/store-upgrade' as const, from: 9 as const, to: 10 as const,
    stateDir: roots.stateDir, runtimeDir: roots.runtimeDir, evidenceDir, evidenceIdentity: ownedPathIdentity(evidenceDir),
    nodeId: manifest.nodeId, sourceDigest, fenceDigest, manifestDigest, receiptDigest, historyDigest: history }
  return { ...body, digest: hash(JSON.stringify(body)) }
}
export function inspectStoreUpgrade(input: WorkbenchRootsInput, evidenceDir: string): StoreUpgradePlan {
  const roots = rootsForUpgrade(input, evidenceDir)
  if (readdirSync(evidenceDir).length !== 0) refuse('evidence directory must be empty; retain previous evidence separately')
  return inspect(roots, evidenceDir)
}
function flushDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writeExclusive(path: string, bytes: string | Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  flushDirectory(dirname(path))
}
export type StoreUpgradePhase = 'backed_up' | 'ddl_applied' | 'version_updated' | 'before_commit' | 'committed'
export interface StoreUpgradeResult { from: 9; to: 10; planDigest: string; beforeDigest: string; afterDigest: string; fenceDigest: string; evidenceDir: string }
export function applyStoreUpgrade(input: WorkbenchRootsInput, expected: StoreUpgradePlan,
  options: { onPhase?: (phase: StoreUpgradePhase) => void } = {}): StoreUpgradeResult {
  // Validate exact input before acquiring SQLite ownership (which updates only
  // the pre-existing owner lock bookkeeping, never the store or fences).
  const roots = rootsForUpgrade(input, expected.evidenceDir)
  if (!same(inspectStoreUpgrade(input, expected.evidenceDir), expected)) refuse('stale or changed upgrade plan')
  const guard = verifyOwnedReceipt(roots)
  const lock = acquireOwnerLock({ path: roots.ownerDatabasePath })
  let db: DatabaseSync | undefined, fences: DatabaseSync | undefined
  let committed = false
  try {
    guard()
    if (!same(inspect(roots, expected.evidenceDir), expected)) refuse('upgrade plan changed after ownership acquisition')
    db = openDatabase(roots.databasePath, false)
    fences = openDatabase(roots.fenceDatabasePath, false)
    db.exec('BEGIN IMMEDIATE')
    fences.exec('BEGIN IMMEDIATE') // Pin revocations against other SQLite writers too.
    if (!same(inspect(roots, expected.evidenceDir), expected)) refuse('upgrade plan changed before backup')
    const evidence = expected.evidenceDir
    const verifyEvidenceDirectory = () => {
      privateDirectory(evidence)
      if (!same(ownedPathIdentity(evidence), expected.evidenceIdentity)) refuse('evidence directory changed')
    }
    const originals: Record<string, string> = {
      'before.sqlite': roots.databasePath, 'fences.sqlite': roots.fenceDatabasePath,
      'manifest.json': roots.manifestPath, 'ownership.json': join(roots.stateDir, 'ownership.json'),
    }
    const backupHashes: Record<string, string> = {}
    for (const [name, source] of Object.entries(originals)) {
      verifyEvidenceDirectory()
      const bytes = boundedBytes(source)
      writeExclusive(join(evidence, name), bytes)
      backupHashes[name] = hash(bytes)
    }
    const planBytes = JSON.stringify({ plan: expected, backupHashes }) + '\n'
    writeExclusive(join(evidence, 'plan.json'), planBytes)
    const verifyBackups = () => {
      verifyEvidenceDirectory()
      if (fileHash(join(evidence, 'plan.json')) !== hash(planBytes)) refuse('upgrade backup metadata changed')
      for (const [name, digest] of Object.entries(backupHashes)) {
        if (fileHash(join(evidence, name)) !== digest) refuse('upgrade backup changed')
      }
      if (backupHashes['before.sqlite'] !== expected.sourceDigest || backupHashes['fences.sqlite'] !== expected.fenceDigest
          || backupHashes['manifest.json'] !== expected.manifestDigest || backupHashes['ownership.json'] !== expected.receiptDigest) refuse('backup differs from authorized source')
      const before = openDatabase(join(evidence, 'before.sqlite'), true)
      try { assertSchema9ForMigration(before, 'upgrade backup') } finally { before.close() }
      const fenceCopy = openDatabase(join(evidence, 'fences.sqlite'), true)
      try { assertFenceSchema(fenceCopy) } finally { fenceCopy.close() }
    }
    verifyBackups()
    options.onPhase?.('backed_up')
    guard()
    if (!same(inspect(roots, evidence), expected)) refuse('upgrade source changed after backup')
    db.exec(ASSIGNMENT_SCHEMA_DDL)
    options.onPhase?.('ddl_applied')
    db.exec('PRAGMA user_version = 10')
    db.prepare("UPDATE meta SET value = '10' WHERE key = 'schema_version'").run()
    options.onPhase?.('version_updated')
    assertSchemaShape(db, roots.databasePath)
    if (historyDigest(db) !== expected.historyDigest) refuse('legacy history changed during upgrade')
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(MIGRATION_KEY, JSON.stringify(expected))
    options.onPhase?.('before_commit')
    guard()
    verifyBackups()
    if (fileHash(roots.fenceDatabasePath) !== expected.fenceDigest) refuse('revocation ledger changed during upgrade')
    if (roots.runtimeDir && readdirSync(roots.runtimeDir).length !== 0) refuse('runtime became occupied during upgrade')
    db.exec('COMMIT')
    committed = true
    options.onPhase?.('committed')
    // Preserve a second verified clean snapshot of the upgraded state. A crash
    // here leaves a valid schema 10 plus its in-store plan record and old backup;
    // it never triggers rollback/restore or replays migration automatically.
    guard()
    db.exec('BEGIN IMMEDIATE')
    if (historyDigest(db) !== expected.historyDigest) refuse('legacy history changed after commit')
    verifyEvidenceDirectory()
    const after = boundedBytes(roots.databasePath)
    writeExclusive(join(evidence, 'after.sqlite'), after)
    const afterCopy = openDatabase(join(evidence, 'after.sqlite'), true)
    try { assertSchemaShape(afterCopy, 'upgraded backup') } finally { afterCopy.close() }
    const result: StoreUpgradeResult = { from: 9, to: 10, planDigest: expected.digest,
      beforeDigest: expected.sourceDigest, afterDigest: hash(after), fenceDigest: expected.fenceDigest, evidenceDir: evidence }
    writeExclusive(join(evidence, 'result.json'), JSON.stringify(result) + '\n')
    return result
  } catch (error) {
    if (committed) throw workbenchError('migration_unavailable', `schema 10 committed but final evidence is incomplete: ${error instanceof Error ? error.message : String(error)}`,
      'preserve schema 10, its schema_migration_9_10 record and the verified schema-9/fence backups; do not rerun, restore or downgrade automatically')
    throw error
  } finally {
    if (db) { try { db.exec('ROLLBACK') } catch { /* committed or unopened transaction */ } db.close() }
    if (fences) { try { fences.exec('ROLLBACK') } catch { /* no transaction */ } fences.close() }
    lock.release()
  }
}
