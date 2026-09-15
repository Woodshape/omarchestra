import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchRunner, type WorkbenchRunnerOptions } from '../runner/runner.ts'
import { incarnationKey, type PiIncarnation } from '../runner/binding-identity.ts'

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-fence-ops-'))
  let crashAt: string | null = null
  const options: WorkbenchRunnerOptions = { roots: { stateDir: join(root, 'state') }, failurePoint: phase => { if (phase === crashAt) throw Error('injected crash: ' + phase) } }
  let runner = openWorkbenchRunner(options)
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const projectId = 'project', goalId = 'goal', role = 'implementer', runId = 'run'
  runner.store.putProject({ projectId, executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  for (const id of [goalId, 'another-goal']) runner.store.insertGoal({ goalId: id, projectId, goalText: 'retained goal', state: 'active', outcome: null, createdAt: 1 })
  runner.store.putBinding({ runId, projectId, role, state: 'disconnected', bindingDigest: 'frozen', controlEpoch: 3, writerState: 'uncertain', predecessorRunId: null, generation: 1, updatedAt: 1 })
  const incarnation: PiIncarnation = { executionNodeId: runner.nodeId, processInstanceId: 'process', piSessionId: 'pi-session', extensionInstanceId: 'extension' }
  runner.bindIdentity(runId, goalId, incarnation)
  runner.store.transaction(() => {
    runner.store.appendEvent({ eventId: 'adoption', cursor: 4, baseRevision: 0, revision: 1, kind: 'adoption_committed', createdAt: 1, runId })
    runner.store.appendEvent({ eventId: 'external-result', cursor: 5, baseRevision: 1, revision: 2, kind: 'assignment_result', createdAt: 1, runId })
    runner.store.appendEvent({ eventId: 'retirement', cursor: 6, baseRevision: 2, revision: 3, kind: 'retire', createdAt: 1, runId })
  })
  const retire = () => runner.retireBinding({ runId, projectId, role, bindingDigest: 'frozen' })
  return {
    get runner() { return runner }, incarnation, goalId, projectId, runId, role, retire,
    crashAt(value: string) { crashAt = value },
    restart() { runner.close(); crashAt = null; runner = openWorkbenchRunner(options); return runner },
  }
}

for (const phase of ['retirement_ledger', 'retirement_store']) test(`retirement recovers after ${phase}`, t => {
  const s = setup(t)
  s.crashAt(phase)
  assert.throws(s.retire, /injected crash/)
  assert.throws(() => s.runner.store.listBindings(), /admission is fenced/)
  const runner = s.restart()
  assert.equal(runner.store.getBinding(s.runId)?.state, 'retired')
  assert.equal(runner.fences.isIncarnationFenced(incarnationKey(s.incarnation)), true)
  assert.equal(runner.fences.highWater(s.projectId, s.role, s.goalId), 1)
  assert.equal(runner.fences.highWater(s.projectId, s.role, 'another-goal'), 0)
  assert.equal(s.retire().generation, 1, 'duplicate retirement never advances generation')
})

for (const phase of ['purge_intent', 'purge_store', 'purge_fence']) test(`purge recovers after ${phase} without reconstructing history`, t => {
  const s = setup(t)
  s.retire()
  s.crashAt(phase)
  assert.throws(() => s.runner.purgeBinding(s.runId), /injected crash/)
  assert.throws(() => s.runner.store.listBindings(), /admission is fenced/)
  const runner = s.restart()
  assert.equal(runner.store.getBinding(s.runId), null)
  assert.equal(runner.store.getBindingIdentity(s.runId), null)
  assert.equal(runner.fences.getFence(s.runId), null)
  assert.equal(runner.fences.isPurged(s.runId), true)
  assert.equal(runner.fences.isIncarnationFenced(incarnationKey(s.incarnation)), true)
  assert.equal(runner.fences.highWater(s.projectId, s.role, s.goalId), 1)
  assert.equal(runner.store.hasUncertainEffects(s.projectId), true)
  assert.equal(runner.store.maxCursor(), 6, 'purging the last event does not rewind transport ordering')
  assert.deepEqual(runner.store.listEvents().map(e => e.eventId), ['external-result'])
  assert.equal(runner.store.getGoal(s.goalId)?.goalText, 'retained goal')
  assert.equal(runner.purgeBinding(s.runId), null, 'repeat is a no-op, not reconstructed history')
  const db = new DatabaseSync(runner.roots.fenceDatabasePath, { readOnly: true })
  try {
    const rows = db.prepare('SELECT * FROM purged_fences').all()
    assert.deepEqual(Object.keys(rows[0]).sort(), ['incarnation_key', 'run_id'])
    assert.equal(db.prepare('SELECT count(*) AS n FROM binding_fences').get()?.n, 0)
  } finally { db.close() }
  assert.equal(s.restart().store.getBinding(s.runId), null)
})

test('binding identity is immutable, Node-qualified, and rejects extra content', t => {
  const s = setup(t)
  assert.doesNotThrow(() => s.runner.store.putBindingIdentity(s.runId, s.goalId, s.incarnation))
  assert.throws(() => s.runner.store.putBindingIdentity(s.runId, 'another-goal', s.incarnation), /immutable/)
  assert.throws(() => s.runner.store.putBindingIdentity(s.runId, s.goalId, { ...s.incarnation, executionNodeId: 'wrong-node' }), /mismatch/)
  assert.throws(() => s.runner.store.putBindingIdentity(s.runId, s.goalId, { ...s.incarnation, get transcript() { throw Error('content was inspected') } } as PiIncarnation), /exactly four/)
  assert.deepEqual(s.restart().store.getBindingIdentity(s.runId)?.incarnation, s.incarnation)
})


test('only committed membership occupies a Goal Role; retired/purged identity cannot return under new IDs', t => {
  const s = setup(t)
  const original = s.runner.store.getBinding(s.runId)!
  assert.throws(() => s.runner.commitMembership(s.runId), /committed binding/)
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [])
  s.runner.store.transaction(() => {
    s.runner.store.setBindingState(s.runId, 'committed', 2)
    s.runner.commitMembership(s.runId)
  })
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [{ goalId: s.goalId, role: s.role, runId: s.runId }])
  const add = (id: string, goal: string) => {
    s.runner.store.putBinding({ ...original, runId: id, state: 'proposed' })
    s.runner.bindIdentity(id, goal, { ...s.incarnation, processInstanceId: id })
  }
  add('competitor', s.goalId)
  assert.throws(() => s.runner.store.transaction(() => {
    s.runner.store.setBindingState('competitor', 'committed', 2)
    s.runner.commitMembership('competitor')
  }), /UNIQUE/)
  assert.equal(s.runner.store.getBinding('competitor')?.state, 'proposed', 'failed claim rolls back binding state')
  add('other-goal-member', 'another-goal')
  s.runner.store.transaction(() => {
    s.runner.store.setBindingState('other-goal-member', 'committed', 2)
    s.runner.commitMembership('other-goal-member')
  })
  assert.equal(s.runner.store.listMemberships('another-goal').length, 1)
  assert.throws(() => s.runner.store.putBinding({ ...original, role: 'reviewer' }), /immutable/)
  s.retire()
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [])
  s.runner.store.putBinding({ ...original, runId: 'fresh-observed-id', state: 'proposed' })
  assert.throws(() => s.runner.bindIdentity('fresh-observed-id', s.goalId, s.incarnation), /retired incarnation/)
  s.runner.purgeBinding(s.runId)
  const runner = s.restart()
  assert.throws(() => runner.bindIdentity('fresh-observed-id', s.goalId, s.incarnation), /retired incarnation/)
  assert.equal(runner.store.listMemberships('another-goal').length, 1)
  assert.equal(runner.store.hasUncertainEffects(s.projectId), true)
})

test('minimal fences defeat stale restored history without authorizing a restore', t => {
  const s = setup(t)
  const stale = s.runner.store.getBinding(s.runId)!
  s.retire()
  s.runner.purgeBinding(s.runId)
  // Raw persistence injection represents stale store bytes, not a supported
  // restore operation. The public bindIdentity path rejects this incarnation.
  s.runner.store.putBinding(stale)
  s.runner.store.putBindingIdentity(s.runId, s.goalId, s.incarnation)
  const runner = s.restart()
  assert.equal(runner.store.getBinding(s.runId), null)
  assert.equal(runner.fences.isIncarnationFenced(incarnationKey(s.incarnation)), true)
  assert.deepEqual(runner.recovery.purgedFromFence, [s.runId])
})

for (const resource of ['databasePath', 'fenceDatabasePath'] as const) test(`old ${resource} schema is refused, not migrated or overwritten`, t => {
  const s = setup(t)
  const path = s.runner.roots[resource]
  s.runner.close()
  const db = new DatabaseSync(path)
  try { db.exec('PRAGMA user_version = 1') } finally { db.close() }
  assert.throws(() => s.restart(), /schema.*not supported|unsupported fence ledger schema/)
})

test('malformed persisted incarnation is refused before membership admission', t => {
  const s = setup(t)
  const path = s.runner.roots.databasePath
  s.runner.close()
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE binding_identities SET incarnation_json = ?').run(JSON.stringify({ ...s.incarnation, extra: 'not identity' })) } finally { db.close() }
  assert.throws(() => s.restart(), /persisted binding identity is invalid/)
})

test('interrupted ownership receipt creation cannot admit retained history or advance epoch', t => {
  const s = setup(t)
  const { stateDir, databasePath, fenceDatabasePath } = s.runner.roots
  s.runner.close()
  const beforeStore = readFileSync(databasePath), beforeFences = readFileSync(fenceDatabasePath)
  rmSync(join(stateDir, 'ownership.json'))
  assert.throws(() => s.restart(), /receipt|ownership/)
  assert.deepEqual(readFileSync(databasePath), beforeStore)
  assert.deepEqual(readFileSync(fenceDatabasePath), beforeFences)
})

for (const damage of ['missing', 'different-incarnation']) test(`retirement recovery refuses ${damage} revocation evidence`, t => {
  const s = setup(t)
  s.retire()
  const path = s.runner.roots.fenceDatabasePath
  s.runner.close()
  const db = new DatabaseSync(path)
  try {
    if (damage === 'missing') db.exec('DELETE FROM binding_fences')
    else db.prepare('UPDATE binding_fences SET incarnation_key = ?').run('f'.repeat(64))
  } finally { db.close() }
  assert.throws(() => s.restart(), /independent revocation|differs from history/)
})
