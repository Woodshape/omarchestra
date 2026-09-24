import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, cpSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { defaultGitRunner, inspectProjectPath, type GitRunner } from '../runner/git-context.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'

function git(path: string, args: string[]) {
  return execFileSync('/usr/bin/git', args, { cwd: path, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } })
}
function fixture(t: test.TestContext, projectName = 'project') {
  const root = mkdtempSync(join(tmpdir(), 'wb-project-context-')), project = join(root, projectName)
  mkdirSync(project); git(project, ['init', '-q'])
  let runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  let gitPort: GitRunner = defaultGitRunner
  const makeAuthority = () => new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, git: (args, cwd) => gitPort(args, cwd) })
  let authority = makeAuthority()
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, project, get runner() { return runner }, get authority() { return authority },
    port(value: GitRunner) { gitPort = value },
    register() { return authority.confirmRegistration(authority.inspect(project).inspectionId) },
    replace() { renameSync(project, join(root, 'old')); cpSync(join(root, 'old'), project, { recursive: true }) },
    reopen() { const roots = { stateDir: runner.roots.stateDir }; runner.close(); runner = openWorkbenchRunner({ roots }); authority = makeAuthority() },
  }
}

for (const command of ['rev-parse --is-inside-work-tree', 'rev-parse --is-bare-repository', 'rev-parse --show-toplevel', 'rev-parse --git-common-dir', 'rev-parse --git-dir', 'status --porcelain', 'rev-parse --show-superproject-working-tree', 'config --includes --null --name-only --get-regexp ^filter\\..*\\.(clean|process)$', 'ls-files -z --format=%(objectmode)%x00%(path)']) {
  test(`failed ${command} is unavailable, not registrable`, t => {
    const s = fixture(t)
    const result = inspectProjectPath(s.project, (args, cwd) => args.join(' ') === command
      ? { status: 128, stdout: '', stderr: 'injected' } : defaultGitRunner(args, cwd))
    assert.equal(result.supported, false)
    assert.equal(result.executionReady, false)
    if (command === 'status --porcelain') assert.equal(result.dirty, null)
  })
}

for (const failure of [
  { status: null, stdout: '', stderr: '' },
  { status: 0, stdout: 'not porcelain\n', stderr: '' },
  { status: 0, stdout: '', stderr: '', error: Error('spawn failed') },
  { status: 0, stdout: '', stderr: '', signal: 'SIGTERM' },
  { status: 0, stdout: '\ud800', stderr: '' },
  { status: 0, stdout: 'x'.repeat((1 << 20) + 1), stderr: '' },
]) test('unsuccessful/incomplete status cannot claim clean', t => {
  const s = fixture(t)
  const result = inspectProjectPath(s.project, (args, cwd) => args[0] === 'status' ? failure : defaultGitRunner(args, cwd))
  assert.equal(result.supported, false)
  assert.equal(result.dirty, null)
})

test('unborn HEAD is supported, but failed queries against an existing or broken ref are not unborn', t => {
  const s = fixture(t)
  assert.deepEqual(inspectProjectPath(s.project).readinessReasons, ['no_head_commit'])
  git(s.project, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  const failed = inspectProjectPath(s.project, (args, cwd) => args.includes('HEAD^{commit}')
    ? { status: 128, stdout: '', stderr: 'injected' } : defaultGitRunner(args, cwd))
  assert.equal(failed.supported, false)
  assert.ok(failed.reasons.includes('unresolved_head'))
  writeFileSync(join(s.project, '.git', 'HEAD'), 'not a valid ref\n')
  assert.equal(inspectProjectPath(s.project).supported, false)
})

test('same-path replacement with identical Git contents invalidates confirmation', t => {
  const s = fixture(t), inspected = s.authority.inspect(s.project)
  s.replace()
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /context changed/)
  assert.equal(s.runner.store.listProjects().length, 0)
  const fresh = s.register()
  assert.ok(fresh.contextDigest?.startsWith('repo-v1:'))
})

test('Git common-directory replacement alone invalidates confirmation', t => {
  const s = fixture(t), inspected = s.authority.inspect(s.project)
  renameSync(join(s.project, '.git'), join(s.root, 'old-git'))
  cpSync(join(s.root, 'old-git'), join(s.project, '.git'), { recursive: true })
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /context changed/)
})

test('replacement during an inspection is unavailable', t => {
  const s = fixture(t)
  let replaced = false
  const result = inspectProjectPath(s.project, (args, cwd) => {
    if (args[0] === 'status' && !replaced) { replaced = true; s.replace() }
    return defaultGitRunner(args, cwd)
  })
  assert.equal(result.supported, false)
  assert.ok(result.reasons.includes('repository_changed_during_inspection'))
})

test('failed inspections cannot be confirmed after the failing query recovers', t => {
  const s = fixture(t)
  s.port((args, cwd) => args[0] === 'status' ? { status: 128, stdout: '', stderr: '' } : defaultGitRunner(args, cwd))
  const inspected = s.authority.inspect(s.project)
  assert.equal(inspected.dirty, null)
  validateSnapshot(buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' }))
  s.port(defaultGitRunner)
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /fresh inspection/)
})

test('registered identity survives restart and replacement blocks context-dependent operations, not history', t => {
  const s = fixture(t), project = s.register()
  const goal = s.authority.createGoal(project.projectId, 'Retain history')
  s.replace(); s.reopen()
  assert.equal(s.authority.projectContext(project.projectId).available, false)
  assert.equal(s.runner.store.getGoal(goal.goalId)?.goalText, 'Retain history')
  s.authority.selectProject(project.projectId)
  assert.throws(() => s.authority.createCheck(project.projectId, {
    name: 'Check', summary: '', mode: 'validator', commandSummary: 'not executed', definitionDraft: {},
  }), /Project context is unavailable/)
  assert.equal(s.runner.store.listChecks(project.projectId).length, 0)
  const snapshot = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  validateSnapshot(snapshot)
  assert.equal(snapshot.projects[0].dirty, null)
  assert.equal(snapshot.actions.find(a => a.kind === 'create_check')?.enabled, false)
})

test('inspection views cannot rewrite the frozen confirmation identity', t => {
  const s = fixture(t), inspected = s.authority.inspect(s.project)
  s.replace()
  const replacement = inspectProjectPath(s.project).repositoryIdentity
  inspected.repositoryIdentity = replacement
  s.authority.pendingRegistration()!.repositoryIdentity = replacement
  s.authority.currentRegistration(inspected.inspectionId)!.repositoryIdentity = replacement
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /context changed/)
})

for (const when of ['before', 'after']) test(`explicit reconfirmation preserves history/uncertainty and rolls back on ${when} receipt failure`, t => {
  const s = fixture(t), project = s.register()
  const goal = s.authority.createGoal(project.projectId, 'Keep this Goal')
  const binding = { runId: 'run', projectId: project.projectId, role: 'implementer' as const, state: 'disconnected' as const, bindingDigest: 'a'.repeat(64), controlEpoch: 1, writerState: 'uncertain' as const, predecessorRunId: null, generation: 1, updatedAt: 1 }
  s.runner.store.putBinding(binding)
  // Seed both forms of retained uncertainty through the store substrate.
  s.runner.store.putBinding({ ...binding, runId: 'purged-run', state: 'retired' })
  s.runner.store.purgeRetiredHistory('purged-run', 1)
  s.replace()
  const inspected = s.authority.inspect(s.project)
  assert.equal(inspected.reconfirmProjectId, project.projectId)
  const command = { protocol: 'omarchestra.workbench/v1', intentId: 'reconfirm', sessionId: 'session', pluginGeneration: 1,
    runnerEpoch: s.runner.epoch, expectedRevision: s.authority.currentRevision, kind: 'confirm_register_project', target: inspected.inspectionId, payload: { registrationId: inspected.inspectionId } }
  const put = s.runner.store.putIntentResult.bind(s.runner.store)
  s.runner.store.putIntentResult = record => { assert.equal(record.status, 'acknowledged'); if (when === 'after') put(record); throw Error('receipt fault') }
  assert.throws(() => s.authority.handleIntent(command), /receipt fault/)
  assert.deepEqual(s.runner.store.getProject(project.projectId), project)
  assert.equal(s.authority.projectContext(project.projectId).available, false)
  s.runner.store.putIntentResult = put
  const outcome = s.authority.handleIntent(command)
  assert.equal(outcome.status, 'acknowledged')
  assert.deepEqual(s.authority.handleIntent(command), outcome)
  assert.equal(s.runner.store.getProject(project.projectId)?.revision, project.revision + 1)
  assert.notEqual(s.runner.store.getProject(project.projectId)?.contextDigest, project.contextDigest)
  assert.equal(s.runner.store.getGoal(goal.goalId)?.goalText, 'Keep this Goal')
  assert.equal(s.runner.store.getBinding('run')?.writerState, 'uncertain')
  assert.equal(s.runner.store.hasUncertainEffects(project.projectId), true)
  assert.equal(s.runner.store.listEvents().filter(e => e.kind === 'project_context_confirmed').length, 1)
  s.reopen()
  assert.equal(s.authority.projectContext(project.projectId).available, true)
})

test('ordinary path whitespace is retained, not trimmed from Git facts', t => {
  const s = fixture(t, 'project ')
  assert.equal(s.register().canonicalPath, s.project)
})

test('a changed Git common-directory binding needs explicit reconfirmation', t => {
  const s = fixture(t), project = s.register()
  const admin = join(s.root, 'new-admin')
  renameSync(join(s.project, '.git'), admin)
  writeFileSync(join(s.project, '.git'), `gitdir: ${admin}\n`)
  assert.throws(() => s.authority.requireProjectContext(project.projectId), /Project context is unavailable/)
  const confirmed = s.register()
  assert.equal(confirmed.projectId, project.projectId)
  assert.equal(confirmed.gitCommonDir, admin)
  assert.equal(confirmed.revision, project.revision + 1)
})

test('HEAD changes after inspection require fresh confirmation', t => {
  const s = fixture(t), inspected = s.authority.inspect(s.project)
  git(s.project, ['commit', '-q', '--allow-empty', '-m', 'new HEAD'])
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /context changed/)
  assert.equal(s.register().headOid?.length, 40)
})

test('separate Git storage overlapping state or another Project is refused', t => {
  const s = fixture(t)
  const first = s.register()
  const alias = join(s.root, 'alias'); mkdirSync(alias)
  writeFileSync(join(alias, '.git'), `gitdir: ${first.gitCommonDir}\n`)
  const inspected = s.authority.inspect(alias)
  assert.equal(inspected.supported, true)
  assert.throws(() => s.authority.confirmRegistration(inspected.inspectionId), /overlaps registered Project/)
  const fake: GitRunner = (args, cwd) => {
    if (args.includes('--git-dir') || args.includes('--git-common-dir')) return { status: 0, stdout: s.runner.roots.stateDir, stderr: '' }
    return defaultGitRunner(args, cwd)
  }
  s.port(fake)
  assert.throws(() => s.authority.inspect(s.project), /state root/)
})

test('editing a check revalidates instead of trusting a cached available Project', t => {
  const s = fixture(t), project = s.register()
  const fields = { name: 'Check', summary: '', mode: 'validator', commandSummary: 'not executed', definitionDraft: {
    executable: '/usr/bin/true', argv: [], cwd: s.project, environment: [], resourcePaths: [], timeoutMs: 1000,
    outputBytes: 4096, maxCorrections: 1, elapsedMs: 60000,
  } }
  const check = s.authority.createCheck(project.projectId, fields)
  s.replace()
  assert.throws(() => s.authority.configureCheck(project.projectId, check.checkId, check.version, fields), /Project context is unavailable/)
  assert.equal(s.runner.store.latestCheck(project.projectId, check.checkId)?.version, check.version)
})

test('directory removal and thrown queries make context unavailable without deleting history', t => {
  const s = fixture(t), project = s.register()
  s.port(() => { throw Error('query unavailable') })
  s.authority.selectProject(project.projectId)
  assert.equal(s.authority.projectContext(project.projectId).dirty, null)
  assert.throws(() => s.authority.requireProjectContext(project.projectId), /Project context is unavailable/)
  s.port(defaultGitRunner)
  rmSync(s.project, { recursive: true })
  s.reopen()
  assert.equal(s.authority.projectContext(project.projectId).available, false)
  assert.equal(s.runner.store.listProjects().length, 1)
})

test('context inspection refuses external Git filters instead of executing repository code', t => {
  const s = fixture(t)
  writeFileSync(join(s.project, 'tracked'), 'before\n')
  git(s.project, ['add', 'tracked']); git(s.project, ['commit', '-q', '-m', 'fixture'])
  writeFileSync(join(s.project, 'filter-probe'), '#!/bin/sh\n: > .git/filter-ran\n/bin/cat\n', { mode: 0o700 })
  writeFileSync(join(s.project, '.gitattributes'), 'tracked filter=probe\n')
  git(s.project, ['config', 'filter.probe.clean', './filter-probe'])
  writeFileSync(join(s.project, 'tracked'), 'after!\n')
  const inspection = inspectProjectPath(s.project)
  assert.equal(existsSync(join(s.project, '.git/filter-ran')), false, 'inspection must not execute the filter')
  assert.equal(inspection.dirty, null)
  assert.ok(inspection.reasons.includes('unsupported_git_filter'))
})

test('unsafe submodule configuration is refused before parent status can recurse', t => {
  const s = fixture(t), nested = join(s.project, 'nested')
  mkdirSync(nested)
  git(nested, ['init', '-q'])
  git(nested, ['commit', '-q', '--allow-empty', '-m', 'fixture'])
  const head = git(nested, ['rev-parse', 'HEAD']).trim()
  git(s.project, ['update-index', '--add', '--cacheinfo', `160000,${head},nested`])
  git(nested, ['config', 'filter.probe.clean', '/bin/false'])
  let statusCalled = false
  const inspection = inspectProjectPath(s.project, (args, cwd) => {
    if (args[0] === 'status') statusCalled = true
    return defaultGitRunner(args, cwd)
  })
  assert.equal(statusCalled, false)
  assert.equal(inspection.dirty, null)
  assert.ok(inspection.reasons.includes('unsupported_git_filter'))
})

test('safe parent/submodule status stays supported and fsmonitor remains disabled in child Git', t => {
  const s = fixture(t), nested = join(s.project, 'nested')
  mkdirSync(nested); git(nested, ['init', '-q'])
  writeFileSync(join(nested, 'tracked'), 'before\n')
  git(nested, ['add', 'tracked']); git(nested, ['commit', '-q', '-m', 'fixture'])
  const head = git(nested, ['rev-parse', 'HEAD']).trim()
  git(s.project, ['update-index', '--add', '--cacheinfo', `160000,${head},nested`])
  git(s.project, ['commit', '-q', '-m', 'parent'])
  assert.equal(inspectProjectPath(s.project).dirty, false)
  const monitor = join(nested, '.git/monitor-probe')
  writeFileSync(monitor, '#!/bin/sh\n: > "$0.ran"\nexit 0\n', { mode: 0o700 })
  git(nested, ['config', 'core.fsmonitor', monitor])
  writeFileSync(join(nested, 'tracked'), 'after!\n')
  const inspection = inspectProjectPath(s.project)
  assert.equal(inspection.supported, true)
  assert.equal(inspection.dirty, true)
  assert.equal(existsSync(`${monitor}.ran`), false)
})

for (const stdout of ['100644', '100644\0', '040000\0tree\0', '160000\0../escape\0']) {
  test('malformed/unsupported index metadata cannot reach status', t => {
    const s = fixture(t)
    let statusCalled = false
    const inspection = inspectProjectPath(s.project, (args, cwd) => {
      if (args[0] === 'ls-files') return { status: 0, stdout, stderr: '' }
      if (args[0] === 'status') statusCalled = true
      return defaultGitRunner(args, cwd)
    })
    assert.equal(inspection.supported, false)
    assert.equal(inspection.dirty, null)
    assert.equal(statusCalled, false)
  })
}

test('submodule preflight refuses traversal beyond its 32-repository scope', t => {
  const s = fixture(t)
  let child = s.project
  for (let i = 0; i < 32; i++) { child = join(child, 'nested'); mkdirSync(join(child, '.git'), { recursive: true }) }
  let indexes = 0, statusCalled = false
  const inspection = inspectProjectPath(s.project, (args, cwd) => {
    if (args.includes('--show-toplevel')) return { status: 0, stdout: cwd, stderr: '' }
    if (args[0] === 'config') return { status: 1, stdout: '', stderr: '' }
    if (args[0] === 'ls-files') { indexes++; return { status: 0, stdout: '160000\0nested\0', stderr: '' } }
    if (args[0] === 'status') statusCalled = true
    return defaultGitRunner(args, cwd)
  })
  assert.equal(indexes, 32)
  assert.equal(statusCalled, false)
  assert.ok(inspection.reasons.includes('git_status_scope_exceeded'))
})

test('an exhausted whole-inspection budget cannot publish available facts or keep querying', t => {
  const s = fixture(t)
  let now = 0, queries = 0
  t.mock.method(performance, 'now', () => now)
  const inspection = inspectProjectPath(s.project, (args, cwd) => {
    queries++; const result = defaultGitRunner(args, cwd)
    now = 15_000
    return result
  })
  assert.equal(queries, 1)
  assert.equal(inspection.supported, false)
  assert.ok(inspection.reasons.includes('git_inspection_deadline'))
})

test('missing promisor objects cannot trigger a remote helper during inspection', t => {
  const s = fixture(t), program = join(s.project, '.git/fetch-probe')
  const marker = `${program}.ran`
  writeFileSync(program, '#!/bin/sh\n: > "$0.ran"\nexit 1\n', { mode: 0o700 })
  git(s.project, ['config', 'core.repositoryformatversion', '1'])
  git(s.project, ['config', 'extensions.partialClone', 'origin'])
  git(s.project, ['config', 'remote.origin.promisor', 'true'])
  git(s.project, ['config', 'remote.origin.url', `ext::${program}`])
  git(s.project, ['config', 'protocol.ext.allow', 'always'])
  writeFileSync(join(s.project, '.git/HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(s.project, '.git/refs/heads/main'), `${'a'.repeat(40)}\n`)
  const inspection = inspectProjectPath(s.project)
  assert.equal(existsSync(marker), false, 'inspection must not execute a remote helper')
  assert.equal(inspection.supported, false)
})

test('schema 6 cannot silently acquire schema 7 repository identity semantics', t => {
  const s = fixture(t)
  s.register()
  s.runner.close()
  const db = new DatabaseSync(s.runner.roots.databasePath)
  try { db.exec("PRAGMA user_version=6; UPDATE meta SET value='6' WHERE key='schema_version'") } finally { db.close() }
  assert.throws(() => s.reopen(), /schema version 6 is not supported/)
})

test('normal commits/edits preserve repository identity; failed live queries revoke cached availability', t => {
  const s = fixture(t), project = s.register()
  git(s.project, ['commit', '-q', '--allow-empty', '-m', 'new HEAD'])
  writeFileSync(join(s.project, 'new-file'), 'dirty')
  s.authority.selectProject(project.projectId)
  assert.equal(s.authority.projectContext(project.projectId).available, true)
  assert.equal(s.authority.projectContext(project.projectId).dirty, true)
  s.port((args, cwd) => args[0] === 'status' ? { status: 128, stdout: '', stderr: '' } : defaultGitRunner(args, cwd))
  assert.throws(() => s.authority.requireProjectContext(project.projectId), /Project context is unavailable/)
  assert.equal(s.authority.projectContext(project.projectId).dirty, null)
  s.port(defaultGitRunner)
  s.authority.inspect(s.project)
  assert.equal(s.authority.projectContext(project.projectId).available, true, 'fresh inspection can restore an unchanged registered identity')
})
