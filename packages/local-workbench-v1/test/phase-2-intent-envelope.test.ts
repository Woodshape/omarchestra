import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { WORKBENCH_PROTOCOL } from '../console/schema.ts'
import { validateAuthorityIntent } from '../runner/intent-envelope.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-envelope-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1 })
  const intent = { protocol: WORKBENCH_PROTOCOL, intentId: 'command', sessionId: 'session', pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: 0, kind: 'create_goal', target: null, payload: { projectId: 'project', goalText: 'Bound command' } }
  return { runner, authority, intent }
}

for (const [name, change] of Object.entries({
  protocol: { protocol: 'foreign' }, missing_protocol: { protocol: undefined }, extra_field: { authority: true },
  counter: { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, negative: { runnerEpoch: -1 }, nonfinite: { pluginGeneration: NaN },
  identity: { intentId: '../../wrong' }, unknown_kind: { kind: 'execute' },
  extra_payload: { payload: { projectId: 'project', goalText: 'Test', writer: true } },
  target: { kind: 'select_project', target: 'different', payload: { projectId: 'project' } },
  null_target: { kind: 'select_project', target: null, payload: { projectId: 'project' } },
  create_target: { target: 'project' }, text: { payload: { projectId: 'project', goalText: 'x'.repeat(8193) } },
  invalid_unicode: { payload: { projectId: 'project', goalText: '\ud800' } },
  coerced: { payload: { projectId: { toString() { throw Error('must not coerce') } }, goalText: 'Test' } },
})) test(`authority rejects ${name} before receipt or mutation`, t => {
  const s = fixture(t)
  const result = s.authority.handleIntent({ ...s.intent, ...change })
  assert.equal(result.status, 'rejected')
  assert.equal(result.reasonCode, 'invalid_envelope')
  assert.equal(s.runner.store.listGoals().length, 0)
  assert.equal(s.runner.store.listEvents().length, 0)
  assert.equal(s.runner.store.getIntentResult('command'), null)
  assert.equal(s.authority.currentRevision, 0)
})

test('accessors, toJSON, cycles and non-JSON values never execute or persist', t => {
  const s = fixture(t)
  let calls = 0
  const accessor = { ...s.intent }
  Object.defineProperty(accessor, 'payload', { enumerable: true, get() { calls++; throw Error('getter invoked') } })
  const cycle: any = { ...s.intent }; cycle.payload = cycle
  const proxy = new Proxy(s.intent, { ownKeys() { calls++; throw Error('proxy invoked') } })
  for (const input of [null, [], accessor, proxy, cycle, Object.create(s.intent), { ...s.intent, toJSON() { calls++; return s.intent } }, { ...s.intent, payload: new Date() }, { ...s.intent, payload: { ...s.intent.payload, data: 1n } }]) {
    assert.equal(s.authority.handleIntent(input).reasonCode, 'invalid_envelope')
  }
  assert.equal(calls, 0)
  assert.equal(s.runner.store.getIntentResult('command'), null)
})

for (const field of ['sessionId', 'pluginGeneration', 'runnerEpoch', 'expectedRevision']) test(`receipt identity includes ${field}`, t => {
  const s = fixture(t)
  const original = s.authority.handleIntent(s.intent)
  assert.equal(original.status, 'acknowledged')
  const changed = { ...s.intent, [field]: field === 'sessionId' ? 'other' : Number(s.intent[field as keyof typeof s.intent]) + 1 }
  assert.equal(s.authority.handleIntent(changed).reasonCode, 'intent_identity_conflict')
  assert.deepEqual(s.authority.handleIntent(s.intent), original)
  assert.equal(s.runner.store.listGoals().length, 1)
})

test('schema 5 receipt semantics cannot be silently reopened under the current schema', t => {
  const s = fixture(t)
  const roots = { stateDir: s.runner.roots.stateDir }, path = s.runner.roots.databasePath
  s.runner.close()
  const db = new DatabaseSync(path)
  try { db.exec("PRAGMA user_version = 5; UPDATE meta SET value = '5' WHERE key = 'schema_version'") } finally { db.close() }
  assert.throws(() => openWorkbenchRunner({ roots }), /schema version 5 is not supported/)
  const check = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 5) } finally { check.close() }
})

test('canonical key ordering preserves exact replay across restart without executing again', t => {
  const s = fixture(t)
  const result = s.authority.handleIntent(s.intent)
  const reordered = Object.fromEntries(Object.entries(s.intent).reverse())
  reordered.payload = { goalText: s.intent.payload.goalText, projectId: 'project' }
  assert.deepEqual(s.authority.handleIntent(reordered), result)
  const roots = { stateDir: s.runner.roots.stateDir }
  s.runner.close()
  const reopened = openWorkbenchRunner({ roots })
  try {
    const next = new WorkbenchAuthority({ runner: reopened, sessionId: 'new-session', pluginGeneration: 2 })
    assert.deepEqual(next.handleIntent(reordered), result)
    assert.equal(next.handleIntent({ ...s.intent, intentId: 'new-command' }).status, 'stale')
    assert.equal(reopened.store.listGoals().length, 1)
  } finally { reopened.close() }
})

test('stale requests retain their original session and never become current authority', t => {
  const s = fixture(t)
  const old = { ...s.intent, sessionId: 'old-session' }
  const result = s.authority.handleIntent(old)
  assert.equal(result.status, 'stale')
  assert.equal(result.reasonCode, 'session_changed')
  assert.equal(s.runner.store.getIntentResult(old.intentId)?.sessionId, old.sessionId)
  assert.deepEqual(s.authority.handleIntent(old), result)
  assert.equal(s.authority.handleIntent(s.intent).reasonCode, 'intent_identity_conflict')
  assert.equal(s.runner.store.listGoals().length, 0)
})

test('new valid envelopes with stale authority metadata cannot mutate', t => {
  const s = fixture(t)
  for (const [change, reason] of [[{ sessionId: 'other' }, 'session_changed'], [{ pluginGeneration: 2 }, 'plugin_generation_changed'], [{ runnerEpoch: s.runner.epoch + 1 }, 'runner_epoch_changed'], [{ expectedRevision: 1 }, 'revision_changed']] as const) {
    const input = { ...s.intent, ...change, intentId: reason }
    const result = s.authority.handleIntent(input)
    assert.equal(result.status, 'stale')
    assert.equal(result.reasonCode, reason)
    assert.deepEqual(s.authority.handleIntent(input), result)
  }
  assert.equal(s.runner.store.listGoals().length, 0)
  assert.equal(s.runner.store.listEvents().length, 0)
  assert.equal(s.authority.currentRevision, 0)
})

test('depth, array, key and aggregate byte bounds precede routing', t => {
  const s = fixture(t)
  const deep: any = {}; let current = deep
  for (let i = 0; i < 10; i++) { current.next = {}; current = current.next }
  const oversized = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, 'x'.repeat(8192)]))
  for (const [payload, message] of [[deep, /depth/], [Array(101).fill(null), /bound/], [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, null])), /bound/], [oversized, /envelope byte/]] as const) {
    assert.throws(() => validateAuthorityIntent({ ...s.intent, payload }), message)
    assert.equal(s.authority.handleIntent({ ...s.intent, payload }).reasonCode, 'invalid_envelope')
  }
  const sparse: any[] = Array(2); sparse[0] = 'first'
  assert.throws(() => validateAuthorityIntent({ ...s.intent, payload: sparse }), /sparse/)
  Object.defineProperty(sparse, '9007199254740991', { value: 'hidden', enumerable: true })
  assert.throws(() => validateAuthorityIntent({ ...s.intent, payload: sparse }), /extra properties/)
  assert.equal(s.runner.store.listEvents().length, 0)
})

for (const [kind, field] of Object.entries({ select_project: 'projectId', select_goal: 'goalId', confirm_register_project: 'registrationId', request_adoption: 'choiceId', authorize_adoption: 'proposalId', take_control: 'agentRunId', retire: 'agentRunId', purge: 'agentRunId' })) test(`${kind} cannot route a payload target different from its envelope`, t => {
  const s = fixture(t)
  s.runner.store.getIntentResult = () => { throw Error('storage reached before validation') }
  assert.equal(s.authority.handleIntent({ ...s.intent, kind, target: 'first', payload: { [field]: 'second' } }).reasonCode, 'invalid_envelope')
})

test('unavailable Assignment actions retain their real Run-target presentation shape without execution', t => {
  const s = fixture(t)
  for (const kind of ['return_to_team', 'accept', 'resume', 'retry', 'stop']) {
    const result = s.authority.handleIntent({ ...s.intent, intentId: kind, kind, target: 'run', payload: { assignmentId: 'assignment' } })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reasonCode, 'handler_unavailable')
  }
  assert.equal(s.runner.store.listEvents().length, 0)
  assert.equal(s.runner.store.listGoals().length, 0)
})

test('malformed replay cannot bypass validation or poison the saved result', t => {
  const s = fixture(t)
  const result = s.authority.handleIntent(s.intent)
  const receipt = s.runner.store.getIntentResult(s.intent.intentId)
  assert.equal(s.authority.handleIntent({ ...s.intent, hiddenAuthority: true }).reasonCode, 'invalid_envelope')
  assert.deepEqual(s.runner.store.getIntentResult(s.intent.intentId), receipt)
  assert.deepEqual(s.authority.handleIntent(s.intent), result)
  assert.equal(s.runner.store.listGoals().length, 1)
})

test('routing uses the same private data copy that was validated and fingerprinted', t => {
  const s = fixture(t)
  const lookup = s.runner.store.getIntentResult.bind(s.runner.store)
  s.runner.store.getIntentResult = id => { s.intent.payload.goalText = 'Changed after validation'; return lookup(id) }
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.runner.store.listGoals()[0].goalText, 'Bound command')
})
