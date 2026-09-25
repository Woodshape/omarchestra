import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { createRunnerSource, createWorkbenchHost } from '../runner/host.ts'
import type { WorkbenchSnapshot, WorkbenchFeedback } from '../console/schema.ts'
import type { PresentationPort } from '../console/presentation-shell.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-source-outcome-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.setMeta('selected_project_id', 'project')
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1 })
  let now = 0, visible: WorkbenchSnapshot | null = null, fail = false, rejectFeedback = false
  const order: string[] = [], feedback: WorkbenchFeedback[] = [], requests: string[] = []
  const view: PresentationPort = {
    pluginGeneration: 1,
    open(input) { visible = (input as { projection: WorkbenchSnapshot }).projection; order.push(`snapshot:${visible.revision}`); return true },
    applyProjection(input) { if (fail) return false; visible = input as WorkbenchSnapshot; order.push(`snapshot:${visible.revision}`); return true },
    takeIntent() { return requests.shift() ?? '' },
    intentResult(input) { const value = input as WorkbenchFeedback;
      if (rejectFeedback && value.status === 'acknowledged') return false
      feedback.push(value); order.push(value.status);
      if (value.status === 'acknowledged') assert.ok(visible && visible.revision >= (value.committedRevision ?? 0), 'success must follow displayed commitment')
      return true }, close() {},
  }
  const host = createWorkbenchHost({ authority, view, clock: () => now })
  t.after(() => host.stop())
  return { runner, authority, host, view, order, feedback, requests, clock: () => now, time(value: number) { now = value }, fail(value: boolean) { fail = value },
    rejectFeedback(value: boolean) { rejectFeedback = value },
    createGoal() { requests.push(JSON.stringify({ kind: 'create_goal', target: null, payload: { projectId: 'project', goalText: 'Persist before success' } })) } }
}

test('host publishes committed snapshot before resolving its own intent', async t => {
  const s = fixture(t)
  await s.host.start()
  s.createGoal()
  s.host.tick()
  assert.equal(s.runner.store.listGoals().length, 1)
  assert.ok(s.order.indexOf('snapshot:1') < s.order.indexOf('acknowledged'))
  assert.equal(s.host.shell.adapter.pendingIntents[0].status, 'acknowledged')
})

test('failed projection publication leaves a durable receipt but no displayed success', async t => {
  const s = fixture(t)
  await s.host.start()
  s.fail(true)
  s.createGoal()
  assert.throws(() => s.host.tick(), /presentation update rejected/)
  assert.equal(s.runner.store.listGoals().length, 1)
  assert.equal(s.feedback.filter(f => f.status === 'acknowledged').length, 0)
  s.fail(false)
  s.time(6000)
  s.host.tick()
  assert.equal(s.runner.store.listGoals().length, 1, 'publication recovery does not rerun the command')
  assert.equal(s.feedback.at(-1)?.status, 'acknowledged')
})

test('rejected view feedback remains unresolved until presentation accepts it', async t => {
  const s = fixture(t)
  await s.host.start()
  s.rejectFeedback(true)
  s.createGoal()
  assert.throws(() => s.host.tick(), /presentation feedback rejected/)
  assert.equal(s.runner.store.listGoals().length, 1)
  assert.equal(s.host.shell.adapter.pendingIntents[0].status, 'submitted')
  assert.equal(s.feedback.filter(f => f.status === 'acknowledged').length, 0)
  s.rejectFeedback(false)
  s.host.tick()
  assert.equal(s.host.shell.adapter.pendingIntents[0].status, 'acknowledged')
  assert.equal(s.feedback.filter(f => f.status === 'acknowledged').length, 1)
})

test('idle source heartbeats preserve freshness, but absence still becomes stale', async t => {
  const s = fixture(t)
  await s.host.start()
  for (const time of [1001, 2002, 3003]) { s.time(time); s.host.tick(); assert.equal(s.host.shell.adapter.handoff?.connection, 'connected') }
  s.time(6004)
  assert.equal(s.host.shell.adapter.checkStaleness(), true)
})

test('closed channels cannot retain the subscriber or operate on its replacement', async t => {
  const s = fixture(t)
  const source = createRunnerSource(s.authority, 'connected', { clock: s.clock })
  let first = 0, second = 0
  const a = await source.source.connect({ onSnapshot() { first++ }, onEvent() {}, onClose() {} })
  a.close()
  const b = await source.source.connect({ onSnapshot() { second++ }, onEvent() {}, onClose() {} })
  assert.throws(() => a.send('request_snapshot', { sessionId: 'session' }), /closed/)
  a.close()
  b.send('request_snapshot', { sessionId: 'session' })
  assert.equal(first, 1)
  assert.equal(second, 2)
  assert.equal(s.runner.epoch, 1)
  b.close()
})

test('same-owner reconnect recovers a lost outcome without dispatching it again', async t => {
  const s = fixture(t)
  await s.host.start()
  const publish = s.host.source.publishOutcome
  s.host.source.publishOutcome = () => { throw Error('notification lost') }
  s.createGoal()
  assert.throws(() => s.host.tick(), /notification lost/)
  assert.equal(s.runner.store.listGoals().length, 1)
  s.host.source.publishOutcome = publish
  s.host.source.close(new Error('presentation lost'))
  await s.host.start()
  assert.equal(s.host.shell.adapter.pendingIntents[0].status, 'acknowledged')
  assert.equal(s.feedback.at(-1)?.status, 'acknowledged')
  assert.equal(s.runner.store.listGoals().length, 1)
  assert.equal(s.runner.epoch, 1)
})

test('presentation without a live navigation ticket and unimplemented recovery return truthful unavailable outcomes', t => {
  const s = fixture(t)
  for (const kind of ['present', 'recover']) {
    const result = s.authority.handleIntent({ protocol: 'omarchestra.workbench/v1', intentId: kind, sessionId: 'session', pluginGeneration: 1, runnerEpoch: s.runner.epoch,
      expectedRevision: 0, kind, target: 'run', payload: {} })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reasonCode, kind === 'present' ? 'navigation_unavailable' : 'handler_unavailable')
    assert.equal(result.committedRevision, null)
  }
  assert.equal(s.runner.store.listEvents().length, 0)
})

test('completed receipts do not exhaust the bounded pending queue', async t => {
  const s = fixture(t)
  await s.host.start()
  for (let i = 0; i < 20; i++) { s.createGoal(); s.host.tick() }
  assert.equal(s.runner.store.listGoals().length, 20)
  assert.ok(s.host.shell.adapter.pendingIntents.length <= 16)
})

test('a fresh presentation adapter cannot reuse the previous adapter intent IDs', async t => {
  const s = fixture(t)
  await s.host.start()
  s.createGoal(); s.host.tick()
  const first = s.host.shell.adapter.pendingIntents[0].intent.intentId
  s.host.stop()
  const next = createWorkbenchHost({ authority: s.authority, view: s.view, clock: s.clock })
  t.after(() => next.stop())
  await next.start()
  s.createGoal(); next.tick()
  assert.notEqual(next.shell.adapter.pendingIntents[0].intent.intentId, first)
  assert.equal(s.runner.store.listGoals().length, 2)
})

test('outcome query checks the complete original envelope and never re-executes a command', async t => {
  const s = fixture(t)
  const intent = { protocol: 'omarchestra.workbench/v1', sessionId: 'session', pluginGeneration: 1, runnerEpoch: s.runner.epoch,
    intentId: 'query-test', expectedRevision: 0, kind: 'create_goal', target: null, payload: { projectId: 'project', goalText: 'Once' } }
  const result = s.authority.handleIntent(intent)
  assert.equal(result.status, 'acknowledged')
  const source = createRunnerSource(s.authority)
  const receipts: WorkbenchFeedback[] = []
  const channel = await source.source.connect({ onSnapshot() {}, onEvent() {}, onClose() {}, onOutcome(value: unknown) { receipts.push(value as WorkbenchFeedback) } })
  channel.send('query_intent', { intent })
  assert.equal(receipts.at(-1)?.status, 'acknowledged')
  channel.send('query_intent', { intent: { ...intent, payload: { ...intent.payload, goalText: 'Different' } } })
  assert.equal(receipts.at(-1)?.status, 'rejected')
  assert.equal(receipts.at(-1)?.reasonCode, 'intent_identity_conflict')
  for (const changed of [{ sessionId: 'other' }, { expectedRevision: 1 }, { pluginGeneration: 2 }, { runnerEpoch: intent.runnerEpoch + 1 }]) {
    channel.send('query_intent', { intent: { ...intent, ...changed } })
    assert.equal(receipts.at(-1)?.reasonCode, 'intent_identity_conflict')
  }
  assert.throws(() => channel.send('query_intent', { intent: { ...intent, extra: true } }), /invalid outcome query envelope/)
  const events = s.runner.store.listEvents()
  channel.send('query_intent', { intent: { ...intent, intentId: 'missing' } })
  assert.equal(receipts.at(-1)?.status, 'unknown')
  assert.equal(s.runner.store.getIntentResult('missing'), null)
  assert.throws(() => channel.send('request_snapshot', { sessionId: 'other' }), /session mismatch/)
  assert.throws(() => channel.send('execute', { intent }), /unsupported/)
  assert.deepEqual(s.runner.store.listEvents(), events)
  assert.equal(s.runner.store.listGoals().length, 1)
  channel.close()
})
