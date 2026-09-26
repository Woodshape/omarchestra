import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { acquireOwnerLock } from '../runner/owner-lock.ts'
import { captureOwnedPaths, durableOwnedPaths, verifyOwnedReceipt } from '../runner/owned-resources.ts'
import { inspectRuntimeMigration, applyRuntimeMigration } from '../runner/runtime-migration.ts'
import { inspectStoreUpgrade, applyStoreUpgrade, type StoreUpgradePhase } from '../runner/store-migration.ts'
import { STORE_TABLES, STORE_V9_TABLES, STORE_V9_DDL } from '../runner/schema.ts'
import { assertSchema9ForMigration, assertSchemaShape } from '../runner/store.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'

const CLI = fileURLToPath(new URL('../../../manual/workbench-store-upgrade.ts', import.meta.url))
const MODULE = new URL('../runner/store-migration.ts', import.meta.url).href
function raw<T>(path: string, fn: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(path, { readOnly })
  try { return fn(db) } finally { db.close() }
}
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-store-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = { stateDir: join(root, 'state'), runtimeDir: join(root, 'runtime') }
  const evidenceDir = join(root, 'evidence')
  mkdirSync(evidenceDir, { mode: 0o700 })
  const runner = openWorkbenchRunner({ roots: input })
  const roots = runner.roots, nodeId = runner.nodeId, epoch = runner.epoch
  const project = join(root, 'project')
  mkdirSync(project, { mode: 0o700 })
  runner.store.putProject({ projectId: 'p', executionNodeId: nodeId, canonicalPath: project, gitCommonDir: join(project, '.git'), headOid: 'a'.repeat(40), dirty: true, contextDigest: null, revision: 4, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'g', projectId: 'p', goalText: 'Retain the original Goal', state: 'active', outcome: null, createdAt: 1 })
  const definition = { projectId: 'p', checkId: 'check', version: 1, name: 'Gate', summary: 'gate', mode: 'validator',
    commandSummary: 'true', semanticClaim: 'Configured validator exited zero; subject to candidate and resource stability.',
    executable: '/usr/bin/true', executableDigest: sha256('test-pin'), argv: [], cwd: project,
    environment: [], resources: [], timeoutMs: 1000, outputBytes: 4096, maxCorrections: 0, elapsedMs: 60000 }
  const canonical = canonicalJson(definition)
  runner.store.putCheck({ projectId: 'p', checkId: 'check', version: 1, digest: sha256(canonical), canonicalJson: canonical, name: 'Gate', mode: 'validator', createdAt: 1 })
  runner.store.putBinding({ runId: 'run', projectId: 'p', role: 'implementer', state: 'committed', bindingDigest: sha256('binding'), controlEpoch: 7,
    writerState: 'uncertain', predecessorRunId: null, generation: 1, updatedAt: 1 })
  runner.store.putBindingIdentity('run', 'g', { executionNodeId: nodeId, processInstanceId: 'process', piSessionId: 'session', extensionInstanceId: 'extension' })
  runner.store.commitMembership('run')
  runner.store.putBinding({ ...runner.store.getBinding('run')!, state: 'ready' })
  runner.store.setMeta('projection_revision', '9')
  runner.store.appendEvent({ eventId: 'event', cursor: 9, baseRevision: 8, revision: 9, kind: 'fixture_checkpoint', createdAt: 1, runId: 'run' })
  runner.store.putIntentResult({ intentId: 'intent', sessionId: 'presentation', payloadHash: sha256('envelope'), status: 'acknowledged', reasonCode: null, reason: null, detail: null, committedRevision: 9, createdAt: 1 })
  runner.fences.recordRetirement({ runId: 'retired', projectId: 'p', goalId: 'g', role: 'reviewer', bindingDigest: sha256('retired-binding'), incarnationKey: sha256('retired-incarnation'), predecessorRunId: null })
  runner.fences.markPurged('retired', 2)
  runner.fences.completePurge('retired')
  runner.close()
  // Construct the exact historical v9 layout, not a v10 file with its version
  // changed. The frozen DDL is independently pinned to b84e02f below.
  raw(roots.databasePath, db => {
    db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
    for (const table of STORE_TABLES.filter(t => !STORE_V9_TABLES.includes(t)).reverse()) db.exec(`DROP TABLE ${table.name}`)
    db.exec("INSERT INTO uncertain_effects VALUES ('retired', 'p', 2); PRAGMA user_version = 9; UPDATE meta SET value = '9' WHERE key = 'schema_version'; COMMIT")
    assertSchema9ForMigration(db, roots.databasePath)
  })
  return { root, input, roots, evidenceDir, nodeId, epoch }
}
function legacyRows(path: string) {
  return raw(path, db => Object.fromEntries(STORE_V9_TABLES.map(({ name }) => [name,
    db.prepare(`SELECT rowid AS _migration_rowid_, * FROM ${name}${name === 'meta' ? " WHERE key NOT IN ('schema_version','schema_migration_9_10')" : ''} ORDER BY rowid`).all()])), true)
}
function cli(f: ReturnType<typeof fixture>, action: '--plan' | '--apply', extra: string[] = []) {
  return spawnSync(process.execPath, ['--experimental-strip-types', CLI, action, '--state-dir', f.input.stateDir,
    '--runtime-dir', f.input.runtimeDir, '--evidence-dir', f.evidenceDir, ...extra], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' })
}

test('historical schema 9 DDL remains pinned to the b84e02f source', () => {
  assert.equal(sha256(STORE_V9_DDL), 'd1f9b1ab1112f09a0d8e770b4a451c35159cd8b1ed38f2cd0a3291c67c957d0c')
})

test('real CLI plan is read-only; exact authorized upgrade preserves every legacy row, fence and inode', t => {
  const f = fixture(t)
  const before = readFileSync(f.roots.databasePath), fenceBefore = readFileSync(f.roots.fenceDatabasePath)
  const receiptBefore = readFileSync(join(f.input.stateDir, 'ownership.json'))
  const rows = legacyRows(f.roots.databasePath), inode = lstatSync(f.roots.databasePath).ino
  const planCommand = cli(f, '--plan')
  assert.equal(planCommand.status, 0, planCommand.stderr)
  const plan = JSON.parse(planCommand.stdout)
  assert.deepEqual(readFileSync(f.roots.databasePath), before)
  assert.deepEqual(readFileSync(f.roots.fenceDatabasePath), fenceBefore)
  assert.deepEqual(readdirSync(f.evidenceDir), [])
  assert.equal(cli(f, '--apply').status, 1, 'no implicit authorization')
  assert.equal(cli(f, '--apply', ['--authorize', 'a'.repeat(64)]).status, 1)
  const applied = cli(f, '--apply', ['--authorize', plan.digest])
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(JSON.parse(applied.stdout).serviceStarted, false)
  assert.deepEqual(legacyRows(f.roots.databasePath), rows)
  assert.equal(lstatSync(f.roots.databasePath).ino, inode)
  assert.deepEqual(readFileSync(f.roots.fenceDatabasePath), fenceBefore)
  assert.deepEqual(readFileSync(join(f.input.stateDir, 'ownership.json')), receiptBefore)
  assert.deepEqual(readFileSync(join(f.evidenceDir, 'before.sqlite')), before)
  assert.equal(digest(join(f.evidenceDir, 'after.sqlite')), digest(f.roots.databasePath))
  for (const name of readdirSync(f.evidenceDir)) assert.equal(lstatSync(join(f.evidenceDir, name)).mode & 0o777, 0o600)
  raw(join(f.evidenceDir, 'before.sqlite'), db => assertSchema9ForMigration(db, 'before'), true)
  raw(join(f.evidenceDir, 'after.sqlite'), db => assertSchemaShape(db, 'after'), true)
  verifyOwnedReceipt(f.roots)()
  const reopened = openWorkbenchRunner({ roots: f.input })
  try {
    assert.equal(reopened.nodeId, f.nodeId)
    assert.equal(reopened.epoch, f.epoch + 1)
    assert.equal(reopened.store.getBinding('run')?.state, 'disconnected', 'normal recovery does not inherit readiness')
    assert.equal(reopened.store.getBinding('run')?.writerState, 'uncertain')
    assert.equal(reopened.store.getGoal('g')?.goalText, 'Retain the original Goal')
    assert.equal(reopened.store.hasUncertainEffects('p'), true, 'purged Run effects never grant writer clearance')
    assert.ok(reopened.fences.isPurged('retired'))
    assert.equal(reopened.fences.highWater('p', 'reviewer', 'g'), 1)
    assert.deepEqual(reopened.store.listAssignments(), [])
    assert.deepEqual(reopened.store.listAssignmentDeliveries(), [])
  } finally { reopened.close() }
})

test('v2 receipt repair composes with schema upgrade without replacing Project/Goal history', t => {
  const f = fixture(t)
  const receiptPath = join(f.input.stateDir, 'ownership.json')
  writeFileSync(receiptPath, JSON.stringify({ version: 2, resources: captureOwnedPaths(durableOwnedPaths(f.roots)), runtimePath: f.input.runtimeDir }))
  const before = digest(f.roots.databasePath)
  assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir), /legacy.*receipt/)
  const receiptEvidence = join(f.root, 'receipt-evidence')
  mkdirSync(receiptEvidence, { mode: 0o700 })
  applyRuntimeMigration(f.input, inspectRuntimeMigration(f.input), receiptEvidence)
  assert.equal(digest(f.roots.databasePath), before)
  applyStoreUpgrade(f.input, inspectStoreUpgrade(f.input, f.evidenceDir))
  verifyOwnedReceipt(f.roots)()
  assert.equal(raw(f.roots.databasePath, db => db.prepare('PRAGMA user_version').get()?.user_version, true), 10)
})

for (const drift of ['version', 'metadata', 'constraint', 'foreign_key', 'node', 'counter', 'check', 'fence', 'fence_missing'] as const) {
  test(`inspection refuses ${drift} drift without modifying store/fence bytes`, t => {
    const f = fixture(t)
    if (drift === 'fence_missing') renameSync(f.roots.fenceDatabasePath, join(f.root, 'preserved-fence'))
    else raw(drift === 'fence' ? f.roots.fenceDatabasePath : f.roots.databasePath, db => {
      if (drift === 'version') db.exec('PRAGMA user_version = 8')
      if (drift === 'metadata') db.exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'")
      if (drift === 'constraint') db.exec('DROP TRIGGER event_cursor_order')
      if (drift === 'foreign_key') db.exec("PRAGMA foreign_keys = OFF; UPDATE goals SET project_id = 'missing'")
      if (drift === 'node') db.exec("UPDATE meta SET value = 'other' WHERE key = 'node_id'")
      if (drift === 'counter') db.exec("UPDATE meta SET value = '-1' WHERE key = 'runner_epoch'")
      if (drift === 'check') db.exec("UPDATE check_definitions SET canonical_json = '{}'")
      if (drift === 'fence') db.exec('UPDATE vacancy_high_water SET generation = -1')
    })
    const before = digest(f.roots.databasePath)
    const fence = existsSync(f.roots.fenceDatabasePath) ? digest(f.roots.fenceDatabasePath) : null
    assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir))
    assert.equal(digest(f.roots.databasePath), before)
    if (fence) assert.equal(digest(f.roots.fenceDatabasePath), fence)
    assert.deepEqual(readdirSync(f.evidenceDir), [])
  })
}

test('missing directories, foreign runtime entries and sidecars are never created or cleaned up', t => {
  const f = fixture(t)
  const missing = join(f.root, 'missing')
  assert.throws(() => inspectStoreUpgrade({ ...f.input, stateDir: missing }, f.evidenceDir))
  assert.equal(existsSync(missing), false)
  assert.throws(() => inspectStoreUpgrade(f.input, missing))
  assert.equal(existsSync(missing), false)
  writeFileSync(join(f.input.runtimeDir, 'foreign.sock'), 'not ours')
  assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir), /runtime root is not empty/)
  assert.equal(readFileSync(join(f.input.runtimeDir, 'foreign.sock'), 'utf8'), 'not ours')
  rmSync(join(f.input.runtimeDir, 'foreign.sock')) // exact test-created fixture only
  writeFileSync(f.roots.databasePath + '-journal', 'preserve', { mode: 0o600 })
  assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir), /sidecar/)
  assert.equal(readFileSync(f.roots.databasePath + '-journal', 'utf8'), 'preserve')
})

test('evidence overlap, permissions and symlink substitution refuse', t => {
  const f = fixture(t)
  assert.throws(() => inspectStoreUpgrade(f.input, f.input.stateDir), /overlap/)
  const inside = join(f.root, 'project', 'evidence')
  mkdirSync(inside, { mode: 0o700 })
  assert.throws(() => inspectStoreUpgrade(f.input, inside), /overlap/)
  chmodSync(f.evidenceDir, 0o755)
  assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir), /private/)
  chmodSync(f.evidenceDir, 0o700)
  const plan = inspectStoreUpgrade(f.input, f.evidenceDir)
  renameSync(f.evidenceDir, f.evidenceDir + '-original')
  symlinkSync(f.evidenceDir + '-original', f.evidenceDir)
  assert.throws(() => applyStoreUpgrade(f.input, plan), /private/)
})

test('changed plans, inode substitutions and concurrent Owner refuse before backup', t => {
  const f = fixture(t)
  const plan = inspectStoreUpgrade(f.input, f.evidenceDir)
  assert.throws(() => applyStoreUpgrade(f.input, { ...plan, digest: 'bad' }), /stale|changed/)
  const lock = acquireOwnerLock({ path: f.roots.ownerDatabasePath })
  try { assert.throws(() => applyStoreUpgrade(f.input, plan), /sidecar|another workbench runner owns/) } finally { lock.release() }
  assert.deepEqual(readdirSync(f.evidenceDir), [])
  copyFileSync(f.roots.databasePath, join(f.root, 'replacement'))
  renameSync(join(f.root, 'replacement'), f.roots.databasePath)
  assert.throws(() => applyStoreUpgrade(f.input, plan), /identity changed/)
  assert.deepEqual(readdirSync(f.evidenceDir), [])
})

test('a changed source or fence invalidates an inspected plan', t => {
  const f = fixture(t)
  const plan = inspectStoreUpgrade(f.input, f.evidenceDir)
  raw(f.roots.databasePath, db => db.exec("UPDATE goals SET goal_text = 'new explicit text'"))
  assert.throws(() => applyStoreUpgrade(f.input, plan), /stale|changed/)
  const next = inspectStoreUpgrade(f.input, f.evidenceDir)
  raw(f.roots.fenceDatabasePath, db => db.exec('UPDATE vacancy_high_water SET generation = generation + 1'))
  assert.throws(() => applyStoreUpgrade(f.input, next), /stale|changed/)
  assert.deepEqual(readdirSync(f.evidenceDir), [])
})

for (const phase of ['backed_up', 'ddl_applied', 'version_updated', 'before_commit'] as StoreUpgradePhase[]) {
  test(`failure at ${phase} rolls back schema/history and preserves verified backup`, t => {
    const f = fixture(t)
    const before = digest(f.roots.databasePath), fence = digest(f.roots.fenceDatabasePath)
    assert.throws(() => applyStoreUpgrade(f.input, inspectStoreUpgrade(f.input, f.evidenceDir), {
      onPhase(current) { if (current === phase) throw Error('injected failure') },
    }), /injected failure/)
    assert.equal(digest(f.roots.databasePath), before)
    assert.equal(digest(f.roots.fenceDatabasePath), fence)
    assert.equal(digest(join(f.evidenceDir, 'before.sqlite')), before)
    assert.throws(() => inspectStoreUpgrade(f.input, f.evidenceDir), /evidence directory must be empty/)
    raw(f.roots.databasePath, db => assertSchema9ForMigration(db, 'rolled back'), true)
  })
}

test('backup tampering before commit prevents migration; corrupt evidence is retained', t => {
  const f = fixture(t), before = digest(f.roots.databasePath)
  assert.throws(() => applyStoreUpgrade(f.input, inspectStoreUpgrade(f.input, f.evidenceDir), {
    onPhase(phase) { if (phase === 'before_commit') writeFileSync(join(f.evidenceDir, 'before.sqlite'), 'changed') },
  }), /backup changed/)
  assert.equal(digest(f.roots.databasePath), before)
  assert.equal(readFileSync(join(f.evidenceDir, 'before.sqlite'), 'utf8'), 'changed')
})

for (const phase of ['ddl_applied', 'version_updated', 'before_commit', 'committed'] as StoreUpgradePhase[]) {
  test(`bounded child crash at ${phase} leaves recoverable history and no dispatch`, t => {
    const f = fixture(t), before = digest(f.roots.databasePath), rows = legacyRows(f.roots.databasePath)
    const child = join(f.root, 'crash.mjs')
    writeFileSync(child, `import {inspectStoreUpgrade,applyStoreUpgrade} from ${JSON.stringify(MODULE)};\nconst roots=${JSON.stringify(f.input)};applyStoreUpgrade(roots,inspectStoreUpgrade(roots,${JSON.stringify(f.evidenceDir)}),{onPhase(p){if(p===${JSON.stringify(phase)})process.exit(71)}})\n`)
    const result = spawnSync(process.execPath, ['--experimental-strip-types', child], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' })
    assert.equal(result.status, 71, result.stderr)
    assert.equal(digest(join(f.evidenceDir, 'before.sqlite')), before)
    // Simulate explicit SQLite journal recovery under the exact owner lock in
    // this disposable fixture. The production inspection never removes journals
    // or performs this write as a side effect of --plan.
    verifyOwnedReceipt(f.roots)()
    const lock = acquireOwnerLock({ path: f.roots.ownerDatabasePath })
    try {
      raw(f.roots.databasePath, db => {
        const version = db.prepare('PRAGMA user_version').get()?.user_version
        assert.equal(version, phase === 'committed' ? 10 : 9)
        if (version === 10) {
          assertSchemaShape(db, 'committed')
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_outbox').get()?.n, 0)
          assert.ok(db.prepare("SELECT value FROM meta WHERE key = 'schema_migration_9_10'").get())
        } else assertSchema9ForMigration(db, 'recovered')
      })
    } finally { lock.release() }
    assert.deepEqual(legacyRows(f.roots.databasePath), rows)
    assert.deepEqual(readdirSync(f.input.runtimeDir), [])
  })
}

test('post-commit evidence failure reports committed schema, never rollback success', t => {
  const f = fixture(t)
  assert.throws(() => applyStoreUpgrade(f.input, inspectStoreUpgrade(f.input, f.evidenceDir), {
    onPhase(phase) { if (phase === 'committed') throw Error('lost result') },
  }), /schema 10 committed but final evidence is incomplete/)
  raw(f.roots.databasePath, db => assertSchemaShape(db, 'committed'), true)
  assert.ok(existsSync(join(f.evidenceDir, 'before.sqlite')))
  assert.equal(existsSync(join(f.evidenceDir, 'after.sqlite')), false)
})
