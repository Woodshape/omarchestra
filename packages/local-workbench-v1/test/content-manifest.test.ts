import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultGitRunner, inspectProjectPath, type GitRunner } from '../runner/git-context.ts'
import { captureStableProjectBaseline } from '../runner/content-manifest.ts'
import type { ProjectRecord } from '../runner/store.ts'

function git(path: string, args: string[]) {
  return execFileSync('/usr/bin/git', args, {
    cwd: path, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
  })
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-content-manifest-'))
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  git(projectPath, ['init', '-q'])
  git(projectPath, ['config', 'user.name', 'test'])
  git(projectPath, ['config', 'user.email', 'test@example.invalid'])
  git(projectPath, ['commit', '-q', '--allow-empty', '-m', 'initial'])
  const inspection = inspectProjectPath(projectPath)
  assert.equal(inspection.executionReady, true)
  const project: ProjectRecord = {
    projectId: 'project_test', executionNodeId: 'node_local', canonicalPath: inspection.canonicalPath,
    gitCommonDir: inspection.gitCommonDir!, headOid: inspection.headOid, dirty: inspection.dirty!,
    contextDigest: inspection.repositoryIdentity, revision: 1, createdAt: 1,
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, projectPath, project }
}

const capture = (project: ProjectRecord, gitPort?: GitRunner, now?: () => number) =>
  captureStableProjectBaseline(project, { ...(gitPort ? { git: gitPort } : {}), ...(now ? { now } : {}) })

test('stable baseline includes tracked, ignored, and untracked worktree contents but excludes Git admin storage', t => {
  const f = fixture(t)
  writeFileSync(join(f.projectPath, '.gitignore'), 'ignored.txt\n')
  writeFileSync(join(f.projectPath, 'ignored.txt'), 'ignored payload')
  writeFileSync(join(f.projectPath, 'untracked.txt'), 'untracked payload')
  const before = capture(f.project)
  assert.equal(before.fileCount, 3)
  assert.equal(before.dirty, true)
  assert.equal(before.canonicalPath, f.projectPath)
  assert.match(before.manifestDigest, /^[a-f0-9]{64}$/)
  assert.match(before.baselineDigest, /^[a-f0-9]{64}$/)
  assert.equal(before.directoryCount, 1) // the root; the exact .git admin directory is excluded
  assert.ok(before.hashedBytes > 0)
  assert.doesNotMatch(JSON.stringify(before), /ignored payload|untracked payload/)
  assert.notEqual(before.manifestDigest, before.headDigest)

  writeFileSync(join(f.projectPath, 'ignored.txt'), 'changed ignored payload')
  const after = capture(f.project)
  assert.notEqual(after.manifestDigest, before.manifestDigest)
  assert.notEqual(after.baselineDigest, before.baselineDigest)
})

test('HEAD, index, and repository config are separately bound into the baseline', t => {
  const f = fixture(t)
  writeFileSync(join(f.projectPath, 'staged.txt'), 'stable worktree bytes')
  const before = capture(f.project)
  git(f.projectPath, ['add', 'staged.txt'])
  const indexChanged = capture(f.project)
  assert.equal(indexChanged.manifestDigest, before.manifestDigest)
  assert.notEqual(indexChanged.indexDigest, before.indexDigest)
  assert.notEqual(indexChanged.baselineDigest, before.baselineDigest)

  git(f.projectPath, ['config', 'workbench.test', 'one'])
  const configChanged = capture(f.project)
  assert.notEqual(configChanged.configDigest, indexChanged.configDigest)
  assert.notEqual(configChanged.baselineDigest, indexChanged.baselineDigest)

  git(f.projectPath, ['commit', '-q', '--allow-empty', '-m', 'advance HEAD'])
  const headChanged = capture(f.project)
  assert.notEqual(headChanged.headOid, configChanged.headOid)
  assert.notEqual(headChanged.baselineDigest, configChanged.baselineDigest)
})

test('included local Git configuration is content-bound without projecting its values', t => {
  const f = fixture(t)
  const included = join(f.root, 'included-git-config')
  writeFileSync(included, '[workbench]\nmarker = one\n')
  git(f.projectPath, ['config', '--add', 'include.path', included])
  const before = capture(f.project)
  writeFileSync(included, '[workbench]\nmarker = two\n')
  const after = capture(f.project)
  assert.doesNotMatch(JSON.stringify(before), /marker/)
  assert.notEqual(after.configDigest, before.configDigest)
  assert.notEqual(after.baselineDigest, before.baselineDigest)
})

test('permission mode changes are part of the candidate manifest', t => {
  const f = fixture(t)
  const file = join(f.projectPath, 'script.sh')
  writeFileSync(file, '#!/bin/sh\\nexit 0\\n', { mode: 0o644 })
  const before = capture(f.project)
  chmodSync(file, 0o755)
  const after = capture(f.project)
  assert.notEqual(after.manifestDigest, before.manifestDigest)
})

test('symlinks are hashed as link text and never followed', t => {
  const f = fixture(t)
  symlinkSync(join(f.root, 'missing-target-one'), join(f.projectPath, 'outside-link'))
  const one = capture(f.project)
  rmSync(join(f.projectPath, 'outside-link'))
  symlinkSync(join(f.root, 'missing-target-two'), join(f.projectPath, 'outside-link'))
  const two = capture(f.project)
  assert.notEqual(two.manifestDigest, one.manifestDigest)
  assert.equal(two.fileCount, 1)
})

test('oversized files and special files fail before content is accepted', t => {
  const f = fixture(t)
  const large = openSync(join(f.projectPath, 'oversized.bin'), 'w')
  try { ftruncateSync(large, 64 * 1024 * 1024 + 1) } finally { closeSync(large) }
  assert.throws(() => capture(f.project), /working-tree file exceeds 64 MiB/)

  rmSync(join(f.projectPath, 'oversized.bin'))
  const fifo = join(f.projectPath, 'pipe')
  execFileSync('/usr/bin/mkfifo', ['--', fifo], { timeout: 3000, killSignal: 'SIGKILL' })
  assert.throws(() => capture(f.project), /special files are unsupported/)
})

test('nested Git storage fails closed instead of silently excluding more than the registered admin directory', t => {
  const f = fixture(t)
  mkdirSync(join(f.projectPath, 'nested'))
  mkdirSync(join(f.projectPath, 'nested', '.git'))
  assert.throws(() => capture(f.project), /nested Git\/worktree storage is unsupported/)
})

test('a changed checkout between the two full scans is rejected', t => {
  const f = fixture(t)
  let inspections = 0
  const mutatingGit: GitRunner = (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree' && ++inspections === 3) {
      writeFileSync(join(f.projectPath, 'appeared-between-scans.txt'), 'not stable')
    }
    return defaultGitRunner(args, cwd)
  }
  assert.throws(() => capture(f.project, mutatingGit), /two complete checkout scans did not agree/)
})

test('repository identity drift and expired fingerprint deadlines reject baseline capture', t => {
  const f = fixture(t)
  const wrongIdentity = { ...f.project, contextDigest: 'repo-v1:' + 'f'.repeat(64) }
  assert.throws(() => capture(wrongIdentity), /registered Node\/Project\/Git identity/)

  let clock = 0
  assert.throws(() => capture(f.project, undefined, () => (clock += 30_000)), /60-second deadline/)
})
