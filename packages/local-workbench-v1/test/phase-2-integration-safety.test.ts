import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { createBackup } from '../runner/backup.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { inspectProjectPath } from '../runner/git-context.ts'
import { buildSnapshot } from '../runner/projection.ts'

function scratch(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-integration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function git(cwd: string, args: string[]) {
  return execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', timeout: 5000,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: ['ignore', 'pipe', 'pipe'] })
}

test('backup collisions preserve existing database, metadata and symlink targets', t => {
  const root = scratch(t)
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  try {
    const options = { store: runner.store, roots: runner.roots, ownershipHeld: true, clock: () => 1000 }
    createBackup(options)
    const db = join(runner.roots.backupDir, 'backup-1000.sqlite')
    const metadata = join(runner.roots.backupDir, 'backup-1000.json')
    const bytes = readFileSync(db)
    const receipt = readFileSync(metadata)
    assert.throws(() => createBackup(options), /already exists/)
    assert.deepEqual(readFileSync(db), bytes)
    assert.deepEqual(readFileSync(metadata), receipt)
    const foreign = join(root, 'foreign')
    writeFileSync(foreign, 'preserve')
    symlinkSync(foreign, join(runner.roots.backupDir, 'backup-1001.json'))
    assert.throws(() => createBackup({ ...options, clock: () => 1001 }), /already exists/)
    assert.equal(readFileSync(foreign, 'utf8'), 'preserve')
  } finally { runner.close() }
})

test('actual submodule roots are refused and Git inspection retains index bytes', t => {
  const root = scratch(t)
  const source = join(root, 'source')
  const parent = join(root, 'parent')
  for (const dir of [source, parent]) {
    mkdirSync(dir)
    git(dir, ['init', '-q'])
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'disposable fixture'])
  }
  git(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'module'])
  const index = join(parent, '.git', 'index')
  const before = readFileSync(index)
  assert.equal(inspectProjectPath(parent).supported, true)
  const module = inspectProjectPath(join(parent, 'module'))
  assert.equal(module.supported, false)
  assert.ok(module.reasons.includes('submodule_repository'))
  assert.deepEqual(readFileSync(index), before)
})

test('a Project containing the runner state root cannot be registered', t => {
  const root = scratch(t)
  git(root, ['init', '-q'])
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  try {
    const authority = new WorkbenchAuthority({ runner, sessionId: 'session-test', pluginGeneration: 1 })
    assert.throws(() => authority.inspect(root), /state root/)
    assert.equal(runner.store.listProjects().length, 0)
  } finally { runner.close() }
})

test('restart preserves manual control but revokes its connection and readiness', t => {
  const root = scratch(t)
  const roots = { stateDir: join(root, 'state') }
  const first = openWorkbenchRunner({ roots })
  first.store.transaction(() => first.store.putBinding({
    runId: 'run-test', projectId: 'project-test', role: 'implementer', state: 'manual_takeover',
    bindingDigest: 'a'.repeat(64), controlEpoch: 4, writerState: 'uncertain', predecessorRunId: null,
    generation: 1, updatedAt: 1,
  }))
  first.close()
  const runner = openWorkbenchRunner({ roots })
  try {
    const authority = new WorkbenchAuthority({ runner, sessionId: 'session-test', pluginGeneration: 1 })
    const snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(runner.store.getBinding('run-test')?.state, 'manual_takeover_disconnected')
    assert.equal(snapshot.managedAgents[0].controlMode, 'manual_takeover')
    assert.equal(snapshot.managedAgents[0].connectionStatus, 'disconnected')
    assert.equal(runner.store.getBinding('run-test')?.controlEpoch, 4)
    assert.equal(runner.store.getBinding('run-test')?.writerState, 'uncertain')
  } finally { runner.close() }
})
