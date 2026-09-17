// Local Workbench v1 — Phase 2 P2.1 runner foundation tests.
//
// Durable-root, ownership, schema, fencing, recovery and backup invariants,
// exercised only against disposable roots under a temp directory with
// injected clock/id sources. No live service, no user state, no dispatch:
// these tests must never deliver an Assignment or execute a check.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  assertMigrationPreconditions,
  assertNoSymlink,
  assertOutsideProject,
  createBackup,
  describeBackupSupport,
  describeStoreSettings,
  isWorkbenchError,
  openFenceLedger,
  openWorkbenchRunner,
  openWorkbenchStore,
  planMigration,
  readManifest,
  resolveRoots,
  restoreBackup,
  verifyBackup,
  type BindingRecord,
} from '../runner/index.ts'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER_INDEX = join(PACKAGE_ROOT, 'runner', 'index.ts')

const CHILD_SOURCE = `const [, , runnerUrl, stateDir, mode] = process.argv
const mod = await import(runnerUrl)
try {
  const runner = mod.openWorkbenchRunner({ roots: { stateDir } })
  if (mode === 'crash') process.exit(0)
  process.stdout.write('RESULT:ok:' + runner.nodeId + '\\n')
  runner.close()
} catch (error) {
  process.stdout.write('RESULT:error:' + (error && error.code ? error.code : 'unknown') + '\\n')
}
`

interface Scaffold {
  root: string
  stateDir: string
  childPath: string
}

function scaffold(t: { after(fn: () => void): void }): Scaffold {
  const root = mkdtempSync(join(tmpdir(), 'omarchestra-wb-foundation-'))
  const stateDir = join(root, 'state')
  const childPath = join(root, 'child.mjs')
  writeFileSync(childPath, CHILD_SOURCE)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, stateDir, childPath }
}

function runChild(s: Scaffold, mode: string) {
  const flags = process.execArgv.filter(arg => arg.startsWith('-') && !arg.startsWith('--test'))
  return spawnSync(
    process.execPath,
    [...flags, s.childPath, pathToFileURL(RUNNER_INDEX).href, s.stateDir, mode],
    { encoding: 'utf8', timeout: 30_000 },
  )
}

function withDatabase(path: string, fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path)
  try {
    fn(db)
  } finally {
    db.close()
  }
}

function binding(runId: string, state: BindingRecord['state'], extra: Partial<BindingRecord> = {}): BindingRecord {
  return {
    runId,
    projectId: 'proj-1',
    role: 'implementer',
    state,
    bindingDigest: `digest-${runId}`,
    controlEpoch: 0,
    writerState: 'none',
    predecessorRunId: null,
    generation: null,
    updatedAt: 1,
    ...extra,
  }
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(isWorkbenchError(error), `expected WorkbenchError, received ${String(error)}`)
    assert.equal(error.code, code)
    assert.equal(typeof error.recovery, 'string')
    assert.ok(error.recovery.length > 0, 'every rejection names a recovery action')
    return true
  }
}

test('a fresh runner creates an owner-only root with a durable identity', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(runner.ownershipHeld, true)
  assert.equal(runner.epoch, 1)
  assert.equal(statSync(s.stateDir).mode & 0o777, 0o700)
  for (const name of ['manifest.json', 'workbench.sqlite', 'owner.sqlite', 'fences.sqlite']) {
    assert.equal(statSync(join(s.stateDir, name)).mode & 0o777, 0o600, `${name} must be owner-only`)
  }
  const settings = describeStoreSettings(runner.store)
  assert.equal(settings.journalMode, 'delete')
  assert.equal(settings.foreignKeys, 1)
  assert.equal(settings.synchronous, 2)
  assert.equal(settings.busyTimeoutMs, 1000)
  assert.equal(settings.integrity, 'ok')
  const nodeId = runner.nodeId
  const manifest = readManifest(runner.roots)
  assert.equal(manifest.nodeId, nodeId)
  assert.equal(manifest.ownerId, nodeId)
  runner.close()
  runner.close() // idempotent

  const second = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(second.nodeId, nodeId, 'identity survives reopen')
  assert.equal(second.epoch, 2, 'each runner start increments the durable epoch')
  second.close()

  const third = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(third.epoch, 3)
  third.close()
})

test('identity is random and independent of path, clock or pid', (t) => {
  const a = scaffold(t)
  const b = scaffold(t)
  const first = openWorkbenchRunner({ roots: { stateDir: a.stateDir } })
  const second = openWorkbenchRunner({ roots: { stateDir: b.stateDir } })
  assert.notEqual(first.nodeId, second.nodeId)
  assert.match(first.nodeId, /^node-[0-9a-f]{32}$/)
  first.close()
  second.close()

  const fixed = scaffold(t)
  const deterministic = openWorkbenchRunner({ roots: { stateDir: fixed.stateDir }, newId: () => 'node-fixed', clock: () => 1000 })
  assert.equal(deterministic.nodeId, 'node-fixed')
  assert.equal(readManifest(deterministic.roots).createdAt, 1000)
  deterministic.close()
})

test('a second owner is refused and never takes over by inspection', (t) => {
  const s = scaffold(t)
  const first = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: s.stateDir } }), expectCode('second_owner'))
  // Refusal must not disturb the owner: its history stays open and writable.
  first.store.transaction(() => first.store.putBinding(binding('run-keep', 'ready')))
  assert.equal(first.store.getBinding('run-keep')?.state, 'ready')
  first.close()
  const after = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  // A restart never assumes a surviving connection: readiness is reconstructed
  // as disconnected while membership stays retained.
  assert.equal(after.store.getBinding('run-keep')?.state, 'disconnected')
  after.close()
})

test('ownership excludes another process and is released on process exit', (t) => {
  const s = scaffold(t)
  const created = runChild(s, 'attempt')
  assert.equal(created.status, 0, created.stderr)
  assert.match(created.stdout, /RESULT:ok:/)
  const childNodeId = created.stdout.trim().split(':')[2]

  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(runner.nodeId, childNodeId, 'the owner reads the identity the first process created')
  const blocked = runChild(s, 'attempt')
  assert.equal(blocked.status, 0, blocked.stderr)
  assert.match(blocked.stdout, /RESULT:error:second_owner/)
  runner.close()

  const released = runChild(s, 'attempt')
  assert.match(released.stdout, /RESULT:ok:/)

  // An unclean exit releases the OS lock; ownership evidence still governs reopen.
  const crash = runChild(s, 'crash')
  assert.equal(crash.status, 0, crash.stderr)
  const reopen = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(reopen.nodeId, childNodeId)
  reopen.close()
})

test('symlinked owned paths and ancestors are refused', (t) => {
  const s = scaffold(t)
  const realDir = join(s.root, 'real-state')
  mkdirSync(realDir, { mode: 0o700 })
  const link = join(s.root, 'link-state')
  symlinkSync(realDir, link)
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: link } }), expectCode('unsafe_path'))
  assert.throws(() => assertNoSymlink(link), expectCode('unsafe_path'))

  const realParent = join(s.root, 'real-parent')
  mkdirSync(realParent, { mode: 0o700 })
  const linkParent = join(s.root, 'link-parent')
  symlinkSync(realParent, linkParent)
  assert.throws(
    () => openWorkbenchRunner({ roots: { stateDir: join(linkParent, 'state') } }),
    expectCode('unsafe_path'),
  )
})

test('unexpected state entries and interrupted manifest writes fail closed', (t) => {
  const s = scaffold(t)
  openWorkbenchRunner({ roots: { stateDir: s.stateDir } }).close()
  writeFileSync(join(s.stateDir, 'stray.txt'), 'x')
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: s.stateDir } }), expectCode('unexpected_resource'))
  rmSync(join(s.stateDir, 'stray.txt'), { force: true })

  writeFileSync(join(s.stateDir, 'manifest.json.new'), '{}\n')
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: s.stateDir } }), expectCode('manifest_drift'))
  rmSync(join(s.stateDir, 'manifest.json.new'), { force: true })

  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(runner.epoch, 2)
  runner.close()
})

test('manifest drift, missing resources and identity drift are distinguished', (t) => {
  const cases: Array<{ name: string; mutate: (s: Scaffold) => void; code: string }> = [
    { name: 'unknown manifest field', mutate: s => writeJson(join(s.stateDir, 'manifest.json'), { ...readJson(join(s.stateDir, 'manifest.json')), extra: 1 }), code: 'manifest_drift' },
    { name: 'wrong manifest kind', mutate: s => writeJson(join(s.stateDir, 'manifest.json'), { ...readJson(join(s.stateDir, 'manifest.json')), kind: 'other/kind' }), code: 'manifest_drift' },
    { name: 'unsupported manifest schema', mutate: s => writeJson(join(s.stateDir, 'manifest.json'), { ...readJson(join(s.stateDir, 'manifest.json')), schemaVersion: 2 }), code: 'unsupported_schema' },
    { name: 'changed node identity', mutate: s => writeJson(join(s.stateDir, 'manifest.json'), { ...readJson(join(s.stateDir, 'manifest.json')), nodeId: 'node-other' }), code: 'identity_drift' },
    { name: 'deleted manifest beside history', mutate: s => rmSync(join(s.stateDir, 'manifest.json')), code: 'manifest_missing' },
    { name: 'missing fence ledger', mutate: s => rmSync(join(s.stateDir, 'fences.sqlite')), code: 'missing_resource' },
  ]
  for (const { name, mutate, code } of cases) {
    const s = scaffold(t)
    openWorkbenchRunner({ roots: { stateDir: s.stateDir } }).close()
    mutate(s)
    assert.throws(() => openWorkbenchRunner({ roots: { stateDir: s.stateDir } }), expectCode(code), name)
  }
})

test('store schema and pragma drift block startup', (t) => {
  const make = () => {
    const s = scaffold(t)
    openWorkbenchRunner({ roots: { stateDir: s.stateDir } }).close()
    return s
  }

  const versioned = make()
  withDatabase(join(versioned.stateDir, 'workbench.sqlite'), db => db.exec('PRAGMA user_version = 99'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: versioned.stateDir } }), expectCode('unsupported_schema'))

  const dropped = make()
  withDatabase(join(dropped.stateDir, 'workbench.sqlite'), db => db.exec('DROP TABLE events'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: dropped.stateDir } }), expectCode('schema_drift'))

  const extra = make()
  withDatabase(join(extra.stateDir, 'workbench.sqlite'), db => db.exec('CREATE TABLE stray (a TEXT)'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: extra.stateDir } }), expectCode('schema_drift'))

  const wal = make()
  withDatabase(join(wal.stateDir, 'workbench.sqlite'), db => db.exec('PRAGMA journal_mode = WAL'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: wal.stateDir } }), expectCode('schema_drift'))

  const ledger = make()
  withDatabase(join(ledger.stateDir, 'fences.sqlite'), db => db.exec('DROP TABLE vacancy_high_water'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: ledger.stateDir } }), expectCode('schema_drift'))

  const ledgerVersion = make()
  withDatabase(join(ledgerVersion.stateDir, 'fences.sqlite'), db => db.exec('PRAGMA user_version = 7'))
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir: ledgerVersion.stateDir } }), expectCode('unsupported_schema'))
})

test('the store validates node identity and the ledger shape directly', (t) => {
  const s = scaffold(t)
  const roots = resolveRoots({ stateDir: s.stateDir })
  const store = openWorkbenchStore({ path: roots.databasePath, nodeId: 'node-direct', create: true })
  assert.equal(store.epoch, 1)
  assert.equal(store.getMeta('node_id'), 'node-direct')
  assert.equal(store.integrityCheck(), 'ok')
  store.close()
  assert.throws(
    () => openWorkbenchStore({ path: roots.databasePath, nodeId: 'node-other', create: false }),
    expectCode('identity_drift'),
  )
  assert.throws(
    () => openWorkbenchStore({ path: roots.databasePath, nodeId: 'bad id!', create: false }),
    expectCode('invalid_input'),
  )
  const ledger = openFenceLedger({ path: roots.fenceDatabasePath, create: true })
  assert.deepEqual(ledger.listFences(), [])
  assert.equal(ledger.integrityCheck(), 'ok')
  assert.throws(() => ledger.assertFence('run-none'), expectCode('fence_missing'))
  ledger.close()
})

test('retirement is fenced write-ahead, purge is leaf-only, generations never reuse', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  const retire = (runId: string, predecessorRunId: string | null = null) =>
    runner.retireBinding({ runId, projectId: 'proj-1', role: 'implementer', bindingDigest: `digest-${runId}`, predecessorRunId })

  runner.store.transaction(() => runner.store.putBinding(binding('run-a', 'ready')))
  const first = retire('run-a')
  assert.equal(first.generation, 1)
  assert.equal(first.predecessorRunId, null)
  assert.equal(runner.store.getBinding('run-a')?.state, 'retired')
  assert.equal(runner.store.getBinding('run-a')?.writerState, 'uncertain', 'a retirement retains writer uncertainty')
  assert.equal(runner.fences.highWater('proj-1', 'implementer'), 1)
  assert.equal(retire('run-a').generation, 1, 'fencing the same run is idempotent')

  runner.store.transaction(() => runner.store.putBinding(binding('run-b', 'ready')))
  assert.throws(() => runner.purgeBinding('run-b'), expectCode('fence_missing'))
  assert.equal(runner.store.getBinding('run-b')?.state, 'ready', 'a failed purge mutates nothing')
  assert.equal(retire('run-b').generation, 2)
  runner.purgeBinding('run-b')
  assert.equal(runner.store.getBinding('run-b'), null)
  assert.equal(runner.fences.isPurged('run-b'), true)
  assert.equal(runner.fences.getFence('run-b'), null)

  runner.store.transaction(() => runner.store.putBinding(binding('run-c', 'ready', { predecessorRunId: 'run-a' })))
  assert.throws(() => runner.purgeBinding('run-a'), expectCode('invalid_input'), 'an active successor blocks purge')
  assert.equal(runner.store.getBinding('run-a')?.state, 'retired', 'the blocked purge left the leaf untouched')
  assert.equal(retire('run-c', 'run-a').generation, 3)
  assert.throws(
    () => runner.fences.assertVacancyGeneration('proj-1', 'implementer', 2),
    expectCode('fence_conflict'),
  )
  assert.throws(
    () => runner.fences.assertVacancyGeneration('proj-1', 'implementer', 3),
    expectCode('fence_conflict'),
    'a replacement must advance beyond the retained high-water mark',
  )
  assert.doesNotThrow(() => runner.fences.assertVacancyGeneration('proj-1', 'implementer', 4))
  // Purge is strictly newest-first: even a retired successor still retains the
  // reference, so the predecessor is not a leaf yet.
  assert.throws(() => runner.purgeBinding('run-a'), expectCode('invalid_input'))
  runner.purgeBinding('run-c')
  runner.purgeBinding('run-a')
  runner.close()

  const reopened = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(reopened.fences.listFences().length, 0, 'full retirement records are gone')
  for (const runId of ['run-a', 'run-b', 'run-c']) assert.equal(reopened.fences.isPurged(runId), true)
  assert.equal(reopened.fences.highWater('proj-1', 'implementer'), 3)
  assert.equal(reopened.store.getBinding('run-a'), null)
  assert.equal(reopened.store.hasUncertainEffects('proj-1'), true)
  assert.deepEqual(reopened.recovery.retiredFromFence, [])
  reopened.close()
})

test('recovery makes retained fences win and keeps unfinished work uncertain', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  // Simulate a crash between the fence commit and the store retire commit.
  runner.store.transaction(() => runner.store.putBinding(binding('run-fenced', 'acknowledged')))
  runner.fences.recordRetirement({ runId: 'run-fenced', projectId: 'proj-1', role: 'implementer', bindingDigest: 'digest-run-fenced', predecessorRunId: null })
  runner.store.transaction(() => runner.store.putBinding(binding('run-inflight', 'authorized')))
  runner.store.transaction(() => runner.store.putBinding(binding('run-committed', 'committed')))
  runner.close()

  const recovered = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.deepEqual(recovered.recovery.retiredFromFence, ['run-fenced'])
  const fenced = recovered.store.getBinding('run-fenced')
  assert.equal(fenced?.state, 'retired')
  assert.equal(fenced?.writerState, 'uncertain')
  assert.equal(fenced?.generation, 1)
  const inflight = recovered.store.getBinding('run-inflight')
  assert.equal(inflight?.state, 'authorized')
  assert.equal(inflight?.writerState, 'uncertain')
  assert.ok(recovered.recovery.uncertainBindings.includes('run-inflight'))
  const committed = recovered.store.getBinding('run-committed')
  assert.equal(committed?.state, 'disconnected', 'a restart never assumes a surviving connection')
  assert.equal(committed?.writerState, 'uncertain', 'a disconnected Run is not a clean writer')
  assert.ok(recovered.recovery.disconnectedOnRestart.includes('run-committed'))
  recovered.close()

  const stable = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.deepEqual(stable.recovery.retiredFromFence, [], 'recovery is idempotent')
  stable.close()
})

test('clean shutdown preserves projects, goals and intent dedup evidence', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  runner.store.transaction(() => runner.store.putProject({
    projectId: 'proj-1',
    executionNodeId: 'node-1',
    canonicalPath: '/tmp/unrelated-project',
    gitCommonDir: '/tmp/unrelated-project/.git',
    headOid: 'a'.repeat(40),
    dirty: false,
    contextDigest: 'ctx',
    revision: 1,
    createdAt: 10,
  }))
  runner.store.transaction(() => runner.store.insertGoal({ goalId: 'goal-1', projectId: 'proj-1', goalText: 'Ship Phase 2 foundation', state: 'active', outcome: null, createdAt: 20 }))
  runner.store.putIntentResult({ intentId: 'intent-1', sessionId: 'session-1', payloadHash: 'hash-1', status: 'applied', reasonCode: null, committedRevision: 1, createdAt: 30 })
  assert.equal(runner.store.getProject('proj-1')?.canonicalPath, '/tmp/unrelated-project')
  runner.close()

  const reopened = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.equal(reopened.store.listProjects().length, 1)
  const goal = reopened.store.getGoal('goal-1')
  assert.equal(goal?.goalText, 'Ship Phase 2 foundation')
  assert.equal(goal?.state, 'active')
  assert.equal(reopened.store.listGoals('proj-1').length, 1)
  assert.equal(reopened.store.getIntentResult('intent-1')?.status, 'applied')
  reopened.store.putIntentResult({ intentId: 'intent-1', sessionId: 'session-1', payloadHash: 'hash-1', status: 'duplicate', reasonCode: null, committedRevision: 1, createdAt: 31 })
  assert.equal(reopened.store.getIntentResult('intent-1')?.status, 'applied', 'intent dedup is first-write-wins')
  // A goal that references an unknown Project is refused by the foreign key.
  assert.throws(
    () => reopened.store.transaction(() => reopened.store.insertGoal({ goalId: 'goal-2', projectId: 'proj-missing', goalText: 'x', state: 'active', outcome: null, createdAt: 40 })),
    /FOREIGN KEY|constraint/i,
  )
  reopened.close()
})

test('backups require ownership, verify by digest, and retain two', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  const roots = runner.roots
  assert.throws(
    () => createBackup({ store: runner.store, roots, ownershipHeld: false }),
    expectCode('backup_precondition'),
  )

  let now = 1_000
  const first = createBackup({ store: runner.store, roots, ownershipHeld: true, clock: () => now++ })
  assert.ok(existsSync(join(roots.backupDir, first.database)))
  assert.equal(statSync(join(roots.backupDir, first.database)).mode & 0o777, 0o600)
  assert.deepEqual(verifyBackup(roots, first.database).digest, first.digest)

  assert.throws(() => verifyBackup(roots, 'backup-999.sqlite'), expectCode('backup_unavailable'))

  createBackup({ store: runner.store, roots, ownershipHeld: true, clock: () => now++ })
  const latest = createBackup({ store: runner.store, roots, ownershipHeld: true, clock: () => now++ })
  const retained = readdirSync(roots.backupDir).filter(name => name.endsWith('.sqlite'))
  assert.equal(retained.length, 2, 'older backups this module created are rotated')
  assert.ok(!retained.includes(first.database))
  writeFileSync(join(roots.backupDir, latest.database), 'tampered')
  assert.throws(() => verifyBackup(roots, latest.database), expectCode('integrity_failure'))
  assert.throws(() => createBackup({ store: runner.store, roots, ownershipHeld: true, clock: () => now++ }), expectCode('integrity_failure'))
  assert.equal(readFileSync(join(roots.backupDir, latest.database), 'utf8'), 'tampered', 'damaged evidence is preserved, never rotated away')
  runner.close()
})

test('migration and restore report only what is genuinely supported', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  const roots = runner.roots
  assert.deepEqual(planMigration(7), { from: 7, to: 7, steps: [], requiredBackup: false })
  assert.throws(() => planMigration(6), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(5), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(4), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(3), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(2), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(1), expectCode('migration_unavailable'))
  assert.throws(() => planMigration(0), expectCode('migration_unavailable'))
  assert.deepEqual(
    assertMigrationPreconditions(roots, 7, { ownershipHeld: false, backupDatabase: null }),
    { from: 7, to: 7, steps: [], requiredBackup: false },
    'no forward step means no backup or ownership precondition is invented',
  )
  const support = describeBackupSupport()
  assert.equal(support.backupsSupported, true)
  assert.equal(support.migrationsSupported, false)
  assert.equal(support.restoreSupported, false)
  assert.equal(support.reasons.length, 3)
  assert.throws(() => restoreBackup(), expectCode('restore_unavailable'))
  runner.close()
})

test('root validation helpers reject overlap and non-canonical inputs', (t) => {
  const s = scaffold(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: s.stateDir } })
  assert.throws(() => assertOutsideProject(s.stateDir, s.stateDir), expectCode('unsafe_path'))
  assert.throws(() => assertOutsideProject(s.stateDir, s.root), expectCode('unsafe_path'))
  assert.throws(() => assertOutsideProject(s.stateDir, join(s.stateDir, 'proj')), expectCode('unsafe_path'))
  assert.doesNotThrow(() => assertOutsideProject(s.stateDir, '/tmp/unrelated-project'))
  assert.throws(() => resolveRoots({ stateDir: 'relative/path' }), expectCode('invalid_input'))
  assert.throws(() => resolveRoots({ stateDir: '/' }), expectCode('unsafe_path'))
  const described = runner.describe() as Record<string, unknown>
  assert.equal(described.ownershipHeld, true)
  assert.equal(described.nodeId, runner.nodeId)
  runner.close()
})

test('the foundation exposes no dispatch, delivery, or live-system surface', () => {
  const files = ['errors', 'paths', 'identity', 'manifest', 'schema', 'store', 'owner-lock', 'fences', 'backup', 'recovery', 'runner', 'index']
    .map(name => join(PACKAGE_ROOT, 'runner', `${name}.ts`))
  const forbidden = [
    /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/,
    /dispatchAssignment|sendUserMessage|deliver\w*Assignment|runValidator|executeCheck\b/,
    /node:child_process|node:net|node:http|node:dgram/,
    /\bhomedir\b|XDG_|\.config\/|\.local\/state|\.env\b|credentials|\bprovider\b/,
  ]
  for (const path of files) {
    const value = readFileSync(path, 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(value, pattern, `forbidden token ${String(pattern)} in ${path}`)
    }
  }
  const index = readFileSync(join(PACKAGE_ROOT, 'runner', 'index.ts'), 'utf8')
  assert.doesNotMatch(index, /prototypes|spikes/, 'the runner imports no prototype or spike runtime code')
})

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
