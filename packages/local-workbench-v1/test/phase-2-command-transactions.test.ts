import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { workbenchError } from '../runner/errors.ts'

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-command-tx-'))
  mkdirSync(join(root, 'project'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1 })
  const intent = { protocol: 'omarchestra.workbench/v1', intentId: 'create-goal', sessionId: 'session', pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: 0, kind: 'create_goal', target: null, payload: { projectId: 'project', goalText: 'Persist together' } }
  return { runner, authority, intent }
}

for (const when of ['before', 'after']) test(`receipt failure ${when} insertion rolls back effect, event, selection and revision`, t => {
  const { runner, authority, intent } = setup(t)
  const write = runner.store.putIntentResult.bind(runner.store)
  runner.store.putIntentResult = result => {
    if (when === 'after') write(result)
    throw Error('receipt fault')
  }
  assert.throws(() => authority.handleIntent(intent), /receipt fault/)
  assert.equal(runner.store.listGoals().length, 0)
  assert.equal(runner.store.listEvents().length, 0)
  assert.equal(runner.store.getMeta('selected_goal_id'), null)
  assert.equal(runner.store.getIntentResult(intent.intentId), null)
  assert.equal(authority.currentRevision, 0)
  assert.equal(runner.store.getMeta('projection_revision'), null)
  runner.store.putIntentResult = write
  const result = authority.handleIntent(intent)
  assert.equal(result.status, 'acknowledged')
  assert.equal(result.committedRevision, 1)
  assert.deepEqual(authority.handleIntent(intent), result)
  assert.equal(runner.store.listGoals().length, 1)
  assert.equal(runner.store.listEvents().length, 1)
})

test('public revision stays committed while the transaction writes its receipt', t => {
  const { runner, authority, intent } = setup(t)
  const write = runner.store.putIntentResult.bind(runner.store)
  runner.store.putIntentResult = result => {
    assert.equal(authority.currentRevision, 0)
    assert.equal(result.committedRevision, 1)
    write(result)
  }
  assert.equal(authority.handleIntent(intent).status, 'acknowledged')
  assert.equal(authority.currentRevision, 1)
})

test('failure at outer commit boundary rolls back released nested mutations', t => {
  const { runner, authority, intent } = setup(t)
  const transaction = runner.store.transaction.bind(runner.store)
  let depth = 0
  runner.store.transaction = fn => {
    depth++
    try { return transaction(() => { const result = fn(); if (depth === 1) throw Error('commit boundary fault'); return result }) }
    finally { depth-- }
  }
  assert.throws(() => authority.handleIntent(intent), /commit boundary fault/)
  assert.equal(runner.store.listGoals().length, 0)
  assert.equal(runner.store.getIntentResult(intent.intentId), null)
  assert.equal(authority.currentRevision, 0)
})

test('direct event commit does not publish revision when persistence fails', t => {
  const { runner, authority } = setup(t)
  const set = runner.store.setMeta.bind(runner.store)
  runner.store.setMeta = (key, value) => { set(key, value); if (key === 'projection_revision') throw Error('revision fault') }
  assert.throws(() => authority.commit('test', {}, () => {}), /revision fault/)
  assert.equal(authority.currentRevision, 0)
  assert.equal(runner.store.listEvents().length, 0)
})

test('direct event revision waits for the outer SQL commit boundary', t => {
  const { runner, authority } = setup(t)
  const transaction = runner.store.transaction.bind(runner.store)
  runner.store.transaction = fn => transaction(() => { fn(); throw Error('outer commit fault') })
  assert.throws(() => authority.commit('test', {}, () => {}), /outer commit fault/)
  assert.equal(authority.currentRevision, 0)
  assert.equal(authority.currentCursor, 0)
  assert.equal(runner.store.listEvents().length, 0)
})

test('wrong plugin generation cannot execute a durable command', t => {
  const { runner, authority, intent } = setup(t)
  assert.equal(authority.handleIntent({ ...intent, pluginGeneration: 2 }).status, 'stale')
  assert.equal(runner.store.listGoals().length, 0)
})

test('normalized rejection text survives replay and runner restart', t => {
  const { runner, authority, intent } = setup(t)
  const rejected = { ...intent, payload: { ...intent.payload, goalText: '' } }
  const outcome = authority.handleIntent(rejected)
  assert.equal(outcome.status, 'rejected')
  assert.ok(outcome.reason)
  assert.deepEqual(authority.handleIntent(rejected), outcome)
  const roots = { stateDir: runner.roots.stateDir }
  runner.close()
  const restarted = openWorkbenchRunner({ roots })
  try {
    const next = new WorkbenchAuthority({ runner: restarted, sessionId: 'new-session', pluginGeneration: 2 })
    assert.deepEqual(next.handleIntent(rejected), outcome)
    assert.equal(restarted.store.listGoals().length, 0)
  } finally { restarted.close() }
})

test('a typed rejection after a tentative mutation rolls back before recording rejection', t => {
  const { runner, authority, intent } = setup(t)
  const insert = runner.store.insertGoal.bind(runner.store)
  runner.store.insertGoal = goal => { insert(goal); throw workbenchError('invalid_input', 'injected domain rejection', 'test rollback') }
  const result = authority.handleIntent(intent)
  assert.equal(result.status, 'rejected')
  assert.equal(runner.store.listGoals().length, 0)
  assert.equal(runner.store.listEvents().length, 0)
  assert.equal(authority.currentRevision, 0)
  assert.deepEqual(authority.handleIntent(intent), result)
})

test('registration failure restores both SQL and its transient confirmation record', t => {
  const { runner, intent } = setup(t)
  const path = join(runner.roots.stateDir, '..', 'another-project')
  mkdirSync(path)
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, git: (argv, cwd) => {
    const facts: Record<string, string> = { 'rev-parse --show-toplevel': cwd, 'rev-parse --is-inside-work-tree': 'true', 'rev-parse --is-bare-repository': 'false', 'rev-parse --git-common-dir': '.git', 'rev-parse --git-dir': '.git', 'rev-parse --show-superproject-working-tree': '', 'rev-parse --verify HEAD': 'a'.repeat(40), 'status --porcelain': '' }
    const value = facts[argv.join(' ')]
    return { status: value === undefined ? 128 : 0, stdout: value ?? '', stderr: '' }
  } })
  const write = runner.store.putIntentResult.bind(runner.store)
  runner.store.putIntentResult = result => { write(result); throw Error('receipt fault') }
  assert.throws(() => authority.handleIntent({ ...intent, kind: 'inspect_project', payload: { path } }), /receipt fault/)
  assert.equal(authority.pendingRegistration(), null, 'failed inspection receipt cannot leave a confirmation candidate')
  assert.equal(runner.store.getIntentResult(intent.intentId), null)
  runner.store.putIntentResult = write
  const inspected = authority.inspect(path)
  const command = { ...intent, kind: 'confirm_register_project', target: inspected.inspectionId, payload: { registrationId: inspected.inspectionId } }
  runner.store.putIntentResult = result => { write(result); throw Error('receipt fault') }
  assert.throws(() => authority.handleIntent(command), /receipt fault/)
  assert.equal(runner.store.listProjects().length, 1)
  assert.equal(authority.currentRevision, 0)
  runner.store.putIntentResult = write
  assert.equal(authority.handleIntent(command).status, 'acknowledged')
  assert.equal(runner.store.listProjects().length, 2)
})

for (const kind of ['select_project', 'select_goal', 'create_check', 'configure_checks']) test(`${kind} rolls back with its receipt`, t => {
  const { runner, authority, intent } = setup(t)
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'Seed', state: 'active', outcome: null, createdAt: 1 })
  const fields = { name: 'Check', summary: 'Test definition only', mode: 'validator', commandSummary: 'true', definitionDraft: {
    executable: '/usr/bin/true', argv: [], cwd: runner.store.getProject('project')!.canonicalPath, environment: [], resourcePaths: [], timeoutMs: 1000, outputBytes: 4096, maxCorrections: 1, elapsedMs: 60000,
  } }
  const payload: Record<string, unknown> = kind === 'select_project' ? { projectId: 'project' }
    : kind === 'select_goal' ? { goalId: 'goal' } : { projectId: 'project', ...fields }
  if (kind === 'configure_checks') {
    const check = authority.createCheck('project', fields)
    Object.assign(payload, { checkId: check.checkId, checkVersion: 1 })
  }
  if (kind === 'select_goal') runner.store.setMeta('selected_project_id', 'project')
  const before = { checks: runner.store.listChecks('project'), events: runner.store.listEvents(), revision: authority.currentRevision, cursor: authority.currentCursor,
    project: runner.store.getMeta('selected_project_id'), goal: runner.store.getMeta('selected_goal_id') }
  const write = runner.store.putIntentResult.bind(runner.store)
  runner.store.putIntentResult = value => { write(value); throw Error('receipt fault') }
  assert.throws(() => authority.handleIntent({ ...intent, kind, target: kind === 'select_project' ? 'project' : kind === 'select_goal' ? 'goal' : kind === 'configure_checks' ? payload.checkId : null, payload, expectedRevision: authority.currentRevision }), /receipt fault/)
  assert.deepEqual({ checks: runner.store.listChecks('project'), events: runner.store.listEvents(), revision: authority.currentRevision, cursor: authority.currentCursor,
    project: runner.store.getMeta('selected_project_id'), goal: runner.store.getMeta('selected_goal_id') }, before)
  assert.equal(runner.store.getIntentResult(intent.intentId), null)
})
