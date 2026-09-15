import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { AdoptionManager, DEFAULT_PROPOSAL_TTL_MS } from '../runner/adoption.ts'
import type { ObserverPort, TransportEvent, WorkbenchFrame } from '../runner/transport.ts'

/** Object-event seam, NOT a real Pi bridge or a framed-channel test. */
class Port implements ObserverPort {
  readonly transportId: string
  constructor(transportId = 'transport') { this.transportId = transportId }
  sent: WorkbenchFrame[] = []
  handlers = new Set<(event: TransportEvent) => void>()
  captured: Array<(event: TransportEvent) => void> = []
  send(frame: WorkbenchFrame) { this.sent.push(frame) }
  subscribe(handler: (event: TransportEvent) => void) {
    this.handlers.add(handler); this.captured.push(handler)
    return () => { this.handlers.delete(handler) }
  }
  close() { this.handlers.clear() }
  emit(event: TransportEvent) { for (const handler of [...this.handlers]) handler(event) }
}
function fixture(t: test.TestContext, predecessorRunId: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'wb-adoption-exchange-'))
  let now = 1000, id = 0
  let port: Port | null = new Port()
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1,
    clock: () => now, newId: prefix => `${prefix}${++id}` })
  const manager = new AdoptionManager(authority, () => port)
  manager.bind()
  t.after(() => { manager.unbind(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  const proposal = manager.propose({ projectId: 'project', goalId: 'goal', role: 'builder', observedSessionId: 'observed', predecessorRunId })
  const event = (type: TransportEvent['type'], changes: Record<string, unknown> = {}): TransportEvent => ({
    type, runId: proposal.runId, bindingDigest: proposal.proposalDigest, transportId: 'transport',
    nonce: proposal.nonce, source: 'extension', detail: '', ...changes,
  })
  return { runner, authority, manager, proposal, event, original: port!, setPort(value: Port | null) { port = value },
    time(value: number) { now = value },
    commits() { return runner.store.listEvents().filter(e => e.kind === 'adoption_committed').length },
  }
}

for (const predecessor of [null, 'predecessor']) {
  const label = predecessor ? 'replacement' : 'original'
  test(`${label}: proposal deadline also bounds an ACK after late authorization`, t => {
    const s = fixture(t, predecessor)
    s.time(1000 + DEFAULT_PROPOSAL_TTL_MS - 1)
    s.manager.authorize(s.proposal.proposalId)
    s.time(1000 + DEFAULT_PROPOSAL_TTL_MS)
    assert.throws(() => s.original.emit(s.event('adopt_ack')), /expired/)
    assert.equal(s.commits(), 0)
    assert.equal(s.original.sent.filter(f => f.kind === 'committed').length, 0)
  })
  test(`${label}: wrong connection, missing nonce and changed nonce never commit`, t => {
    const s = fixture(t, predecessor)
    s.manager.authorize(s.proposal.proposalId)
    for (const changes of [{ transportId: 'wrong-connection' }, { nonce: undefined }, { nonce: 'wrong-nonce' }]) {
      assert.throws(() => s.original.emit(s.event('adopt_ack', changes)), /connection|digest|nonce/)
      assert.equal(s.commits(), 0)
    }
    s.original.emit(s.event('adopt_ack'))
    s.original.emit(s.event('adopt_ack'))
    assert.equal(s.commits(), 1)
    assert.equal(s.original.sent.filter(f => f.kind === 'committed').length, 1)
  })
  test(`${label}: ACK deadline is exclusive at its exact boundary`, t => {
    const s = fixture(t, predecessor)
    s.manager.authorize(s.proposal.proposalId)
    s.time(6000)
    assert.throws(() => s.original.emit(s.event('adopt_ack')), /expired/)
    assert.equal(s.commits(), 0)
  })
}

test('authorization refuses at the exact proposal expiry boundary', t => {
  const s = fixture(t)
  s.time(1000 + DEFAULT_PROPOSAL_TTL_MS)
  assert.throws(() => s.manager.authorize(s.proposal.proposalId), /expired/)
  assert.equal(s.original.sent.length, 0)
})

test('same-labelled port replacement and captured callbacks cannot inherit an exchange', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  const replacement = new Port('transport')
  const oldHandler = s.original.captured[0]
  s.setPort(replacement)
  s.manager.bind()
  // Stale callback must be inert even if a transport invokes it after unsubscribe.
  oldHandler(s.event('adopt_ack'))
  assert.equal(s.commits(), 0)
  assert.equal(s.original.handlers.size, 0)
  assert.throws(() => replacement.emit(s.event('adopt_ack')), /connection|exchange/)
  assert.equal(s.commits(), 0)
})

test('wrong-connection readiness, input and disconnect leave the current binding unchanged', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  s.original.emit(s.event('adopt_ack'))
  for (const type of ['readiness', 'input_observed', 'disconnected'] as const) {
    assert.throws(() => s.original.emit(s.event(type, { transportId: 'foreign', source: 'interactive' })), /connection/)
    assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'committed')
  }
  s.original.emit(s.event('readiness'))
  const revision = s.authority.currentRevision
  s.original.emit(s.event('readiness'))
  assert.equal(s.authority.currentRevision, revision, 'duplicate readiness is mutation-free')
})

test('disconnect does not mutate a Run belonging to another connection', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  s.original.emit(s.event('adopt_ack'))
  const own = s.runner.store.getBinding(s.proposal.runId)!
  s.runner.store.putBinding({ ...own, runId: 'unrelated-run', role: 'reviewer', state: 'ready' })
  s.original.emit(s.event('disconnected'))
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'disconnected')
  assert.equal(s.runner.store.getBinding('unrelated-run')?.state, 'ready')
  assert.equal(s.original.handlers.size, 0)
})

test('unbind fences direct and captured callbacks and repeated bind retains one listener', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  s.manager.bind()
  assert.equal(s.original.handlers.size, 1)
  const oldHandler = s.original.captured[0]
  s.manager.unbind()
  oldHandler(s.event('adopt_ack'))
  assert.equal(s.commits(), 0)
  assert.throws(() => s.manager.onTransportEvent(s.event('adopt_ack')), /connection/)
})

test('ordinary input during authorization cancels the exchange, not grants manual control', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  s.original.emit(s.event('input_observed', { source: 'interactive' }))
  assert.equal(s.runner.store.getBinding(s.proposal.runId)?.state, 'authorized')
  assert.equal(s.runner.store.listEvents().filter(e => e.kind === 'control_taken').length, 0)
  assert.throws(() => s.original.emit(s.event('adopt_ack')), /failed/)
  assert.equal(s.commits(), 0)
})

test('expiry is revalidated immediately before the commitment', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  const commit = s.authority.commit.bind(s.authority)
  s.authority.commit = (kind, payload, mutate) => {
    const revision = commit(kind, payload, mutate)
    if (kind === 'adoption_acknowledged') s.time(6000)
    return revision
  }
  assert.throws(() => s.original.emit(s.event('adopt_ack')), /expired/)
  assert.equal(s.commits(), 0)
  assert.equal(s.original.sent.filter(f => f.kind === 'committed').length, 0)
})

test('connection is revalidated immediately before commitment and delivery', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  const commit = s.authority.commit.bind(s.authority)
  const replacement = new Port('transport')
  s.authority.commit = (kind, payload, mutate) => {
    const revision = commit(kind, payload, mutate)
    if (kind === 'adoption_acknowledged') s.setPort(replacement)
    return revision
  }
  assert.throws(() => s.original.emit(s.event('adopt_ack')), /connection/)
  assert.equal(s.commits(), 0)
  assert.equal(replacement.sent.length, 0)
})

test('stored binding drift between acknowledgement and commitment is refused', t => {
  const s = fixture(t)
  s.manager.authorize(s.proposal.proposalId)
  const commit = s.authority.commit.bind(s.authority)
  s.authority.commit = (kind, payload, mutate) => {
    const revision = commit(kind, payload, mutate)
    if (kind === 'adoption_acknowledged') {
      const binding = s.runner.store.getBinding(s.proposal.runId)!
      s.runner.store.putBinding({ ...binding, role: 'different-role' })
    }
    return revision
  }
  assert.throws(() => s.original.emit(s.event('adopt_ack')), /frozen proposal/)
  assert.equal(s.commits(), 0)
  assert.equal(s.original.sent.filter(f => f.kind === 'committed').length, 0)
})

test('failed or synchronously disconnected subscriptions do not become active exchanges', t => {
  const s = fixture(t)
  const failed = new Port()
  failed.subscribe = () => { throw Error('subscribe failed') }
  s.setPort(failed)
  assert.throws(() => s.manager.bind(), /subscribe failed/)
  assert.throws(() => s.manager.authorize(s.proposal.proposalId), /transport/)
  const disconnected = new Port()
  let released = false
  disconnected.subscribe = handler => {
    handler(s.event('disconnected'))
    return () => { released = true }
  }
  s.setPort(disconnected)
  s.manager.bind()
  assert.equal(released, true)
  assert.throws(() => s.manager.authorize(s.proposal.proposalId), /transport/)
  assert.equal(s.commits(), 0)
})

test('returned proposal views cannot rewrite frozen authorization identity or expiry', t => {
  const s = fixture(t)
  const original = { ...s.proposal }
  s.proposal.nonce = 'tampered'
  s.proposal.expiresAt = Number.MAX_SAFE_INTEGER
  s.manager.retainedProposals()[0].nonce = 'also-tampered'
  s.manager.proposalOf(original.proposalId)!.expiresAt = Number.MAX_SAFE_INTEGER
  assert.equal(s.manager.proposalOf(original.proposalId)?.nonce, original.nonce)
  s.time(original.expiresAt)
  assert.throws(() => s.manager.authorize(original.proposalId), /expired/)
  assert.equal(s.commits(), 0)
})
