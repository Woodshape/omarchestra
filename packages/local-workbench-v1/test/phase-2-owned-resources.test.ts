import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, unlinkSync, renameSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { DatabaseSync } from 'node:sqlite'
import { verifyBackup } from '../runner/backup.ts'
import { backupFile, readInventory, writeInventory } from '../runner/backup-inventory.ts'

function owned(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-owned-regression-'))
  const stateDir = join(root, 'state')
  const runner = openWorkbenchRunner({ roots: { stateDir } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, stateDir, runner }
}

test('missing lifetime lock cannot be recreated beside retained history', t => {
  const { runner, stateDir } = owned(t)
  unlinkSync(runner.roots.ownerDatabasePath)
  let second: ReturnType<typeof openWorkbenchRunner> | undefined
  try { assert.throws(() => { second = openWorkbenchRunner({ roots: { stateDir } }) }) }
  finally { second?.close() }
})

for (const key of ['ownerDatabasePath', 'databasePath', 'fenceDatabasePath'] as const) {
  test(`same-content replacement of ${key} is refused on reopen`, t => {
    const { runner, stateDir } = owned(t)
    runner.close()
    const path = runner.roots[key]
    copyFileSync(path, path + '.replacement')
    renameSync(path + '.replacement', path)
    let second: ReturnType<typeof openWorkbenchRunner> | undefined
    try { assert.throws(() => { second = openWorkbenchRunner({ roots: { stateDir } }) }) }
    finally { second?.close() }
  })
}

test('active owner stops serving authority after its lock path disappears', t => {
  const { runner } = owned(t)
  unlinkSync(runner.roots.ownerDatabasePath)
  assert.throws(() => runner.store.setMeta('must-not-write', 'yes'))
})

test('same-content root replacement is not a new authorized owner', t => {
  const { runner, root, stateDir } = owned(t)
  runner.close()
  renameSync(stateDir, join(root, 'old'))
  mkdirSync(stateDir, { mode: 0o700 })
  for (const file of ['manifest.json', 'workbench.sqlite', 'owner.sqlite', 'fences.sqlite', 'ownership.json']) {
    try { copyFileSync(join(root, 'old', file), join(stateDir, file)) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  let second: ReturnType<typeof openWorkbenchRunner> | undefined
  try { assert.throws(() => { second = openWorkbenchRunner({ roots: { stateDir } }) }) }
  finally { second?.close() }
})

test('weakened schema constraints are rejected even with identical column names', t => {
  const { runner, stateDir } = owned(t)
  runner.close()
  const db = new DatabaseSync(runner.roots.databasePath)
  try {
    db.exec('ALTER TABLE goals RENAME TO old_goals; CREATE TABLE goals (goal_id TEXT, project_id TEXT, goal_text TEXT, state TEXT, outcome TEXT, created_at INTEGER); DROP TABLE old_goals')
  } finally { db.close() }
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir } }), /constraint\/index\/trigger drift/)
})

test('unsafe persisted epoch is rejected rather than rounded', t => {
  const { runner, stateDir } = owned(t)
  runner.store.setMeta('runner_epoch', '9007199254740992')
  runner.close()
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir } }), /invalid persisted counter/)
})

test('unrecorded backup-shaped files are preserved, not rotated', t => {
  const { runner } = owned(t)
  runner.backup()
  writeFileSync(join(runner.roots.backupDir, 'backup-0.sqlite'), 'foreign', { mode: 0o600 })
  assert.throws(() => runner.backup())
  assert.throws(() => verifyBackup(runner.roots, '../workbench.sqlite'), /invalid backup basename/)
})

test('even matching backup hashes cannot substitute for SQLite integrity', t => {
  const { runner } = owned(t)
  const backup = runner.backup()
  const dir = runner.roots.backupDir
  const inventory = readInventory(dir)
  writeFileSync(join(dir, backup.database), 'not a SQLite database')
  const fakeDatabase = backupFile(dir, backup.database)
  writeFileSync(join(dir, backup.database.replace('.sqlite', '.json')), JSON.stringify({ ...backup, digest: fakeDatabase.digest }))
  inventory.files = inventory.files.map(f => backupFile(dir, f.name))
  writeInventory(dir, inventory)
  assert.throws(() => verifyBackup(runner.roots, backup.database))
})

test('unknown sqlite-like sidecars are not authorized by suffix', t => {
  const { runner, stateDir } = owned(t)
  runner.close()
  writeFileSync(join(stateDir, 'foreign-journal'), 'preserve me', { mode: 0o600 })
  let second: ReturnType<typeof openWorkbenchRunner> | undefined
  try { assert.throws(() => { second = openWorkbenchRunner({ roots: { stateDir } }) }) }
  finally { second?.close() }
})
