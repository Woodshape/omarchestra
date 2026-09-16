import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { DatabaseSync } from 'node:sqlite'
import { workbenchError } from '../runner/errors.ts'

function setup(t: test.TestContext, kind: 'retire' | 'purge') {
  const root = mkdtempSync(join(tmpdir(), 'wb-retirement-outcome-'))
  let fault: string | null = null
  const options = { roots: { stateDir: join(root, 'state') }, failurePoint: (phase: string) => { if (fault === phase) throw Error('injected ' + phase) } }
  let runner = openWorkbenchRunner(options)
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'Test only', state: 'active', outcome: null, createdAt: 1 })
  runner.store.putBinding({ runId: 'run', projectId: 'project', role: 'builder', state: 'committed', bindingDigest: 'a'.repeat(64), controlEpoch: 1, writerState: 'uncertain', predecessorRunId: null, generation: 1, updatedAt: 1 })
  runner.bindIdentity('run', 'goal', { executionNodeId: runner.nodeId, processInstanceId: 'process', piSessionId: 'pi-session', extensionInstanceId: 'extension' })
  runner.commitMembership('run')
  runner.store.setBindingState('run', 'disconnected', 2)
  if (kind === 'purge') runner.retireBinding({ runId: 'run', projectId: 'project', role: 'builder', bindingDigest: 'a'.repeat(64) })
  let authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1 })
  const intent = { protocol: 'omarchestra.workbench/v1', intentId: 'operation', sessionId: 'session', pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: authority.currentRevision, kind, target: 'run', payload: { agentRunId: 'run' } }
  return { get runner() { return runner }, get authority() { return authority }, intent,
    fault(phase: string) { fault = phase },
    restart() { runner.close(); fault = null; runner = openWorkbenchRunner(options); authority = new WorkbenchAuthority({ runner, sessionId: 'next', pluginGeneration: 2 }); return runner },
  }
}

for (const kind of ['retire', 'purge'] as const) {
  const boundaries = kind === 'retire' ? ['retirement_ledger', 'retirement_store'] : ['purge_intent', 'purge_store', 'purge_fence']
  for (const phase of ['command_prepared', ...boundaries, 'command_effect', 'command_outcome', 'command_committed']) test(`${kind} outcome recovers after ${phase}`, t => {
    const s = setup(t, kind)
    s.fault(phase)
    assert.throws(() => s.authority.handleIntent(s.intent), /injected|admission is fenced/)
    const runner = s.restart()
    const receipt = runner.store.getIntentResult(s.intent.intentId)
    assert.equal(receipt?.status, 'acknowledged')
    assert.equal(receipt?.committedRevision, 1)
    assert.equal(runner.store.listManagementOperations().length, 0)
    assert.equal(runner.fences.highWater('project', 'builder', 'goal'), 1)
    assert.equal(runner.store.listMemberships('goal').length, 0)
    if (kind === 'retire') assert.equal(runner.store.getBinding('run')?.state, 'retired')
    else {
      assert.equal(runner.store.getBinding('run'), null)
      assert.equal(runner.fences.isPurged('run'), true)
      assert.equal(runner.store.hasUncertainEffects('project'), true)
    }
    const before = runner.store.listEvents()
    assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
    assert.deepEqual(runner.store.listEvents(), before)
    assert.equal(s.restart().store.getIntentResult(s.intent.intentId)?.committedRevision, 1)
  })
  test(`${kind} receipt insertion fault cannot become a permanent effect without an outcome`, t => {
    const s = setup(t, kind)
    const insert = s.runner.store.putIntentResult.bind(s.runner.store)
    s.runner.store.putIntentResult = row => { insert(row); throw Error('receipt fault') }
    assert.throws(() => s.authority.handleIntent(s.intent), /receipt fault/)
    const runner = s.restart()
    assert.equal(runner.store.getIntentResult(s.intent.intentId)?.status, 'acknowledged')
    assert.equal(runner.store.listManagementOperations().length, 0)
  })
}

test('connected retirement rejects before persisting an operation or revoking identity', t => {
  const s = setup(t, 'retire')
  s.runner.store.setBindingState('run', 'manual_takeover', 3)
  assert.equal(s.authority.handleIntent(s.intent).status, 'rejected')
  assert.equal(s.runner.store.listManagementOperations().length, 0)
  assert.equal(s.runner.fences.isFenced('run'), false)
})

test('post-commit cleanup failure cannot produce a rejected retirement outcome', t => {
  const s = setup(t, 'retire')
  s.authority.adoption.forgetRetired = () => { throw workbenchError('invalid_input', 'cleanup fault', 'test') }
  assert.throws(() => s.authority.handleIntent(s.intent), /cleanup fault/)
  assert.equal(s.runner.store.getIntentResult(s.intent.intentId)?.status, 'acknowledged')
  assert.equal(s.authority.currentRevision, 1)
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.runner.store.listEvents().length, 1)
})

test('a retained successor blocks purge before an operation is prepared', t => {
  const s = setup(t, 'purge')
  const binding = s.runner.store.getBinding('run')!
  s.runner.store.putBinding({ ...binding, runId: 'successor', predecessorRunId: 'run', bindingDigest: 'b'.repeat(64), state: 'disconnected' })
  assert.equal(s.authority.handleIntent(s.intent).status, 'rejected')
  assert.equal(s.runner.store.listManagementOperations().length, 0)
  assert.equal(s.runner.fences.isPurged('run'), false)
})

for (const damage of ['target', 'journal']) test(`prepared retirement refuses ${damage} drift on restart`, t => {
  const s = setup(t, 'retire')
  const path = s.runner.roots.databasePath
  s.fault('command_prepared')
  assert.throws(() => s.authority.handleIntent(s.intent), /injected/)
  s.runner.close()
  const db = new DatabaseSync(path)
  try {
    if (damage === 'target') db.exec("UPDATE bindings SET control_epoch = 2 WHERE run_id = 'run'")
    else db.exec("UPDATE management_operations SET target_json = '{}' ")
  } finally { db.close() }
  assert.throws(() => s.restart(), /target/)
  const check = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(check.prepare('SELECT count(*) AS n FROM management_operations').get()?.n, 1)
    assert.equal(check.prepare('SELECT count(*) AS n FROM intent_dedup').get()?.n, 0)
  } finally { check.close() }
})
