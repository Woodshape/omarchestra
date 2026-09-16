import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { workbenchError } from '../runner/errors.ts'
import type { ObserverPort, TransportEvent, WorkbenchFrame } from '../runner/transport.ts'

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-delivery-outbox-'))
  const roots = { stateDir: join(root, 'state') }
  let now = 1000
  let runner = openWorkbenchRunner({ roots })
  const handlers = new Set<(event: TransportEvent) => void>(), frames: WorkbenchFrame[] = []
  let onSend = (_frame: WorkbenchFrame) => {}
  const port: ObserverPort = { transportId: 'transport', send(frame) { frames.push(frame); onSend(frame) }, subscribe(handler) { handlers.add(handler); return () => { handlers.delete(handler) } }, close() { handlers.clear() } }
  let currentPort = port
  let authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, clock: () => now, transport: () => currentPort })
  t.after(() => { authority.adoption.unbind(); port.close(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  const proposal = authority.adoption.propose({ projectId: 'project', goalId: 'goal', role: 'implementer', observedSessionId: 'observed' })
  const intent = { intentId: 'authorize', sessionId: 'session', pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: authority.currentRevision, kind: 'authorize_adoption', target: proposal.proposalId, payload: { proposalId: proposal.proposalId } }
  return { get runner() { return runner }, get authority() { return authority }, proposal, intent, frames,
    send(fn: (frame: WorkbenchFrame) => void) { onSend = fn }, time(value: number) { now = value },
    replacePort() { currentPort = { ...port }; authority.adoption.bind() },
    ack() { const event: TransportEvent = { type: 'adopt_ack', runId: proposal.runId, bindingDigest: proposal.proposalDigest, nonce: proposal.nonce, transportId: 'transport', source: 'extension', detail: '' }; for (const handler of [...handlers]) handler(event) },
    restart() { authority.adoption.unbind(); runner.close(); runner = openWorkbenchRunner({ roots }); authority = new WorkbenchAuthority({ runner, sessionId: 'next', pluginGeneration: 2, transport: () => port }); return runner },
  }
}

test('authorization effect, receipt and queued frame are committed before any send', t => {
  const s = setup(t)
  s.send(frame => {
    const db = new DatabaseSync(s.runner.roots.databasePath, { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT status FROM intent_dedup WHERE intent_id = ?').get('authorize')?.status, 'acknowledged')
      assert.equal(db.prepare('SELECT state FROM bridge_deliveries WHERE frame_id = ?').get(frame.frameId)?.state, 'attempting')
      assert.equal(db.prepare('SELECT state FROM bindings WHERE run_id = ?').get(frame.runId!)?.state, 'authorized')
    } finally { db.close() }
  })
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.frames.length, 1)
  assert.equal(s.runner.store.listDeliveries()[0].state, 'written')
})

for (const fault of ['receipt-before', 'receipt-after', 'outbox']) test(`${fault} failure rolls back authorization and sends nothing`, t => {
  const s = setup(t)
  const receipt = s.runner.store.putIntentResult.bind(s.runner.store)
  const outbox = s.runner.store.putDelivery.bind(s.runner.store)
  if (fault === 'outbox') s.runner.store.putDelivery = row => { outbox(row); throw Error('injected fault') }
  else s.runner.store.putIntentResult = row => { if (fault === 'receipt-after') receipt(row); throw Error('injected fault') }
  assert.throws(() => s.authority.handleIntent(s.intent), /injected fault/)
  assert.equal(s.frames.length, 0)
  assert.equal(s.runner.store.listDeliveries().length, 0)
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'proposed')
  assert.equal(s.authority.adoption.proposalOf(s.proposal.proposalId)?.stage, 'proposed')
  assert.equal(s.runner.store.getIntentResult('authorize'), null)
  s.runner.store.putIntentResult = receipt; s.runner.store.putDelivery = outbox
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.frames.length, 1)
})

test('actual outer SQL COMMIT failure leaves no frame, receipt or authorization effect', t => {
  const s = setup(t)
  const exec = DatabaseSync.prototype.exec
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql.trim().toUpperCase() === 'COMMIT') throw Error('SQL commit fault'); return exec.call(this, sql) }
    assert.throws(() => s.authority.handleIntent(s.intent), /SQL commit fault/)
  } finally { DatabaseSync.prototype.exec = exec }
  assert.equal(s.frames.length, 0)
  assert.equal(s.runner.store.listDeliveries().length, 0)
  assert.equal(s.runner.store.getIntentResult('authorize'), null)
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'proposed')
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.frames.length, 1)
})

test('accepted-then-throwing transport yields unknown delivery, not rejected authorization or retry', t => {
  const s = setup(t)
  s.send(() => { throw Error('write outcome unknown') })
  const result = s.authority.handleIntent(s.intent)
  assert.equal(result.status, 'acknowledged')
  assert.equal(s.runner.store.listDeliveries()[0].state, 'unknown')
  assert.deepEqual(s.authority.handleIntent(s.intent), result)
  assert.equal(s.frames.length, 1)
  s.restart()
  assert.equal(s.frames.length, 1)
  assert.equal(s.runner.store.listDeliveries()[0].state, 'unknown')
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
})

test('uncertain committed-binding delivery retains the committed binding and is not replayed', t => {
  const s = setup(t)
  s.authority.handleIntent(s.intent)
  s.send(frame => { if (frame.kind === 'committed') throw Error('commit receipt lost') })
  s.ack()
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'committed')
  assert.equal(s.runner.store.listDeliveries().find(d => d.kind === 'committed')?.state, 'unknown')
  s.ack()
  assert.equal(s.frames.filter(f => f.kind === 'committed').length, 1)
  s.restart()
  assert.equal(s.frames.filter(f => f.kind === 'committed').length, 1)
})

for (const boundary of ['before_attempt', 'attempt_recorded', 'after_write']) test(`${boundary} fault preserves the receipt and restart never replays delivery`, t => {
  const s = setup(t)
  const transition = s.runner.store.transitionDelivery.bind(s.runner.store)
  s.runner.store.transitionDelivery = (id, from, to, reason) => {
    if ((boundary === 'before_attempt' && to === 'attempting') || (boundary === 'after_write' && to === 'written')) throw workbenchError('invalid_input', 'disposition fault', 'test')
    return transition(id, from, to, reason)
  }
  if (boundary === 'attempt_recorded') {
    const transaction = s.runner.store.transaction.bind(s.runner.store)
    s.runner.store.transaction = fn => {
      const result = transaction(fn)
      if (s.runner.store.listDeliveries()[0]?.state === 'attempting') throw workbenchError('invalid_input', 'disposition fault', 'test after SQL commit')
      return result
    }
  }
  assert.throws(() => s.authority.handleIntent(s.intent), /disposition fault/)
  assert.equal(s.runner.store.getIntentResult('authorize')?.status, 'acknowledged')
  assert.equal(s.runner.store.listDeliveries()[0].state, boundary === 'before_attempt' ? 'queued' : 'attempting')
  s.restart()
  assert.equal(s.runner.store.listDeliveries()[0].state, boundary === 'before_attempt' ? 'not_sent' : 'unknown')
  assert.equal(s.frames.length, boundary === 'after_write' ? 1 : 0)
  const row = s.runner.store.listDeliveries()[0]
  assert.throws(() => s.runner.store.transitionDelivery(row.frameId, row.state, 'queued', null), /never reset/)
})

test('committed-binding state and delivery intent roll back together on outbox failure', t => {
  const s = setup(t)
  s.authority.handleIntent(s.intent)
  const put = s.runner.store.putDelivery.bind(s.runner.store)
  s.runner.store.putDelivery = row => { put(row); if (row.kind === 'committed') throw Error('outbox fault') }
  assert.throws(() => s.ack(), /outbox fault/)
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'acknowledged')
  assert.equal(s.runner.store.listDeliveries().filter(row => row.kind === 'committed').length, 0)
  assert.equal(s.frames.filter(frame => frame.kind === 'committed').length, 0)
})

test('a synchronous ACK cannot arrive before receipt or pending exchange state exists', t => {
  const s = setup(t)
  s.send(frame => { if (frame.kind === 'adopt') s.ack() })
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'committed')
  assert.deepEqual(s.frames.map(frame => frame.kind), ['adopt', 'committed'])
  assert.ok(s.runner.store.listDeliveries().every(row => row.state === 'written'))
})

test('purge deletes retained delivery bodies while preserving the independent fence', t => {
  const s = setup(t)
  s.authority.handleIntent(s.intent); s.ack()
  const binding = s.runner.store.getBinding(s.proposal.runId)!
  s.authority.adoption.onTransportEvent({ type: 'disconnected', runId: '', bindingDigest: '', transportId: 'transport', source: 'extension', detail: '' })
  s.runner.retireBinding({ runId: binding.runId, projectId: binding.projectId!, role: binding.role, bindingDigest: binding.bindingDigest })
  s.runner.purgeBinding(binding.runId)
  assert.equal(s.runner.store.listDeliveries().length, 0)
  assert.equal(s.runner.fences.isPurged(binding.runId), true)
})

test('unknown delivery payload fields are refused on insertion and startup', t => {
  const s = setup(t)
  s.authority.handleIntent(s.intent)
  const delivery = s.runner.store.listDeliveries()[0]
  const frame = JSON.parse(delivery.frameJson)
  frame.payload.transcript = 'forbidden content'
  const changed = JSON.stringify(frame)
  assert.throws(() => s.runner.store.putDelivery({ ...delivery, state: 'queued', frameJson: changed }), /invalid durable bridge delivery/)
  const path = s.runner.roots.databasePath
  s.runner.close()
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE bridge_deliveries SET frame_json = ?').run(changed) } finally { db.close() }
  assert.throws(() => s.restart(), /invalid durable bridge delivery/)
})

for (const change of ['expiry', 'connection']) test(`post-commit ${change} refuses delivery without reclassifying the receipt`, t => {
  const s = setup(t)
  const write = s.runner.store.putIntentResult.bind(s.runner.store)
  s.runner.store.putIntentResult = row => { write(row); if (change === 'expiry') s.time(6000); else s.replacePort() }
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  assert.equal(s.frames.length, 0)
  assert.equal(s.runner.store.listDeliveries()[0].state, 'not_sent')
})
