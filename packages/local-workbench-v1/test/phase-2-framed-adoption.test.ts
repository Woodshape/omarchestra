import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { decodeBridgeFrame, encodeBridgeFrame } from '../runner/bridge-protocol.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { incarnationKey } from '../runner/binding-identity.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'
class Stream extends EventEmitter {
  other!: Stream; dead = false; drop = new Set<string>(); sent: string[] = []
  write(bytes: Buffer) {
    if (this.dead) throw Error('closed')
    const frame = decodeBridgeFrame(bytes.subarray(0, -1)); this.sent.push(frame.type)
    if (!this.drop.has(frame.type)) this.other.emit('data', bytes)
    return true
  }
  destroy() { if (this.dead) return; this.dead = true; this.emit('close'); if (!this.other.dead) this.other.destroy() }
}
function pair() { const a = new Stream(), b = new Stream(); a.other = b; b.other = a; return { a, b } }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-framed-adopt-'))
  let now = 1000
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  const initialized = spawnSync('git', ['init', '--quiet', projectPath], { timeout: 5_000, encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, registry, clock: () => now })
  const inspection = authority.inspect(projectPath)
  assert.ok(inspection.inspectionId)
  const projectId = authority.confirmRegistration(inspection.inspectionId).projectId
  const goalId = 'goal-1'
  runner.store.insertGoal({ goalId, projectId, goalText: 'explicit goal', state: 'active', outcome: null, createdAt: now })
  runner.store.setMeta('selected_goal_id', goalId)
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const statuses: Array<string | undefined> = []
  let idle = true
  const host = { mode: 'tui', sessionManager: { getSessionId: () => 'pi-session' }, isIdle: () => idle,
    ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value) } } }
  const streams: ReturnType<typeof pair>[] = []
  const ticks: Array<() => void> = []
  let serial = 0
  const processId = 'process-' + 'a'.repeat(32), extensionId = 'extension-' + 'b'.repeat(32)
  createPiBridgeExtension({ newId: prefix => prefix === 'process' ? processId : prefix === 'extension' ? extensionId : `${prefix}-${(++serial).toString(16).padStart(32, '0')}`,
    schedule: callback => { ticks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> },
    connect: async (onFrame, onClose) => {
      const p = pair(); streams.push(p)
      attachBridgeStream(p.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
      return attachBridgeStream(p.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
    },
  })({ on(name, fn) { hooks.set(name, fn as (event: unknown, ctx: unknown) => void) } })
  return { root, runner, registry, authority, projectId, goalId, streams, hooks, host, statuses,
    time(v: number) { now = v }, idle(v: boolean) { idle = v }, async tick() { ticks.shift()?.(); await new Promise(resolve => setImmediate(resolve)) },
    async start() { hooks.get('session_start')!(null, host); await new Promise(resolve => setImmediate(resolve)) },
    async second() {
      const id = 'process-' + 'c'.repeat(32), extension = 'extension-' + 'd'.repeat(32)
      const secondHooks = new Map<string, (event: unknown, context: unknown) => void>()
      const next = { mode: 'tui', sessionManager: { getSessionId: () => 'replacement-session' }, isIdle: () => true, ui: { setStatus() {} } }
      createPiBridgeExtension({ newId: prefix => prefix === 'process' ? id : prefix === 'extension' ? extension : `${prefix}-${(++serial).toString(16).padStart(32, '0')}`,
        schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
        connect: async (onFrame, onClose) => { const p = pair(); streams.push(p)
          attachBridgeStream(p.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
          return attachBridgeStream(p.b, { onFrame: (_peer, frame) => onFrame(frame), onClose }) },
      })({ on(name, fn) { secondHooks.set(name, fn as (event: unknown, context: unknown) => void) } })
      secondHooks.get('session_start')!(null, next)
      await new Promise(resolve => setImmediate(resolve))
      return registry.list().find(o => o.incarnation.processInstanceId === id)!
    },
  }
}
test('operator intent authorizes exact framed ACK; old intent replay is read-only and other Goal hides membership', async t => {
  const s = fixture(t); await s.start()
  let serial = 0, lastEnvelope: Record<string, unknown> = {}
  function intent(kind: string, payload: Record<string, unknown>, target: string) {
    lastEnvelope = { protocol: 'omarchestra.workbench/v1', intentId: `operator-${++serial}`,
      sessionId: s.authority.sessionId, pluginGeneration: s.authority.pluginGeneration,
      runnerEpoch: s.runner.epoch, expectedRevision: s.authority.currentRevision,
      kind, target, payload }
    return s.authority.handleIntent(lastEnvelope)
  }
  const before = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  validateSnapshot(before)
  const choiceId = before.observedSessions[0].choices[0].choiceId
  assert.equal(intent('request_adoption', { choiceId }, choiceId).status, 'acknowledged')
  const proposal = s.runner.store.listProposals()[0]
  assert.ok(proposal)
  assert.equal(s.runner.store.listBindings().length, 0)
  const reviewing = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  validateSnapshot(reviewing)
  assert.equal(reviewing.details?.find(detail => detail.kind === 'adoption')?.proposalId, proposal.proposalId)
  const outcome = intent('authorize_adoption', { proposalId: proposal.proposalId }, proposal.proposalId)
  assert.equal(outcome.status, 'acknowledged')
  const originalEnvelope = { ...lastEnvelope }
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'ready')
  assert.equal(s.runner.store.listBindings().length, 1)
  const newGoal = 'goal-2'
  s.runner.store.insertGoal({ goalId: newGoal, projectId: s.projectId, goalText: 'another Goal', state: 'active', outcome: null, createdAt: 1000 })
  s.authority.selectGoal(newGoal)
  const scoped = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  validateSnapshot(scoped)
  assert.deepEqual(scoped.managedAgents, [])
  assert.deepEqual(scoped.retiredRuns, [])
  assert.equal(s.runner.store.listMemberships(s.goalId)[0]?.runId, proposal.runId)
  assert.deepEqual(s.authority.handleIntent(originalEnvelope), outcome, 'original intent replay is read-only after Goal changes')
  assert.equal(s.runner.store.listBindings().length, 1)
})

test('framed same-Pi ACK atomically commits Goal-scoped membership before delivery and readiness', async t => {
  const s = fixture(t); await s.start()
  const observed = s.registry.list()[0]
  assert.ok(observed.available)
  assert.equal(s.runner.store.listBindings().length, 0)
  const proposal = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: observed.observedSessionId })
  assert.equal(s.runner.store.listBindings().length, 0)
  assert.equal(s.runner.store.listProposals().length, 1)
  s.authority.adoption.authorize(proposal.proposalId)
  const binding = s.runner.store.getBinding(proposal.runId)
  assert.equal(binding?.state, 'ready')
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [{ goalId: s.goalId, role: 'implementer', runId: proposal.runId }])
  assert.equal(s.runner.store.listProposals().length, 0)
  assert.equal(s.runner.store.listDeliveries(proposal.runId).length, 1)
  assert.equal(s.statuses.at(-1), 'implementer · ready')
  validateSnapshot(buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' }))
  assert.equal(s.runner.store.listBindings().length, 1)
  assert.throws(() => s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: observed.observedSessionId }), /occupied/)
})

test('lost ACK expires pending-only state; no Run, Role or automatic resend', async t => {
  const s = fixture(t); await s.start()
  s.streams[0].b.drop.add('adoption_ack')
  const observed = s.registry.list()[0]
  const p = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: observed.observedSessionId })
  s.authority.adoption.authorize(p.proposalId)
  assert.equal(s.runner.store.listBindings().length, 0)
  assert.equal(s.runner.store.listProposals()[0]?.state, 'authorized')
  s.time(6000)
  assert.deepEqual(s.authority.adoption.retainedProposals(), [])
  assert.equal(s.statuses.at(-1), 'Unassigned · observed', 'expiry clears Pi pending acknowledgement without pretending to manage it')
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [])
  assert.equal(s.streams[0].a.sent.filter(type => type === 'adoption_request').length, 1)
})

test('late and wrong-connection framed ACKs cannot create a Run or occupy a Role', async t => {
  for (const violation of ['late', 'wrong_connection']) for (const variant of ['original', 'replacement']) {
    const s = fixture(t); await s.start()
    let observation = s.registry.list()[0]
    let predecessorRunId: string | null = null
    if (variant === 'replacement') {
      const original = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
        role: 'implementer', observedSessionId: observation.observedSessionId })
      s.authority.adoption.authorize(original.proposalId)
      s.streams[0].a.destroy()
      const binding = s.runner.store.getBinding(original.runId)!
      s.runner.retireBinding({ runId: original.runId, projectId: s.projectId, role: binding.role, bindingDigest: binding.bindingDigest })
      predecessorRunId = original.runId
      observation = await s.second()
    }
    const wire = s.streams.at(-1)!
    wire.b.drop.add('adoption_ack')
    const proposal = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer',
      observedSessionId: observation.observedSessionId, predecessorRunId })
    s.authority.adoption.authorize(proposal.proposalId)
    const pending = s.runner.store.getProposal(proposal.proposalId)!
    const current = s.registry.currentBinding(observation.observedSessionId)!
    if (violation === 'late') s.time(6000)
    else wire.b.drop.delete('adoption_ack')
    const wrong = violation === 'wrong_connection'
    wire.b.write(encodeBridgeFrame('adoption_ack', 'late-or-wrong-' + variant + '-' + violation,
      { proposalId: pending.proposalId, proposalDigest: pending.digest, acknowledgementNonce: pending.nonce,
        observedSessionId: pending.observedSessionId, processInstanceId: pending.incarnation.processInstanceId,
        piSessionId: pending.incarnation.piSessionId, extensionInstanceId: pending.incarnation.extensionInstanceId,
        connectionId: wrong ? 'connection-' + 'e'.repeat(32) : current.connectionId,
        connectionChallenge: current.challenge, sourceSequence: 3, decision: 'acknowledged', activity: 'idle' }))
    assert.equal(s.runner.store.getBinding(proposal.runId), null, violation)
    assert.deepEqual(s.runner.store.listMemberships(s.goalId), [], violation)
  }
})

test('lost commitment or receipt recovers only with fresh same-extension challenge and proof', async t => {
  for (const lost of ['adoption_committed', 'binding_receipt']) {
    const s = fixture(t); await s.start()
    const socket = lost === 'adoption_committed' ? s.streams[0].a : s.streams[0].b
    socket.drop.add(lost)
    const obs = s.registry.list()[0]
    const p = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: obs.observedSessionId })
    s.authority.adoption.authorize(p.proposalId)
    assert.equal(s.runner.store.getBinding(p.runId)?.state, 'committed', lost)
    s.streams[0].a.destroy()
    assert.equal(s.runner.store.getBinding(p.runId)?.state, 'disconnected')
    await s.tick()
    assert.equal(s.streams.length, 2)
    if (lost === 'adoption_committed') assert.ok(s.streams[1].a.sent.includes('recovery_request'), lost)
    assert.ok(s.streams[1].b.sent.includes('recovery_proof'), lost)
    assert.equal(s.runner.store.getBinding(p.runId)?.state, 'ready', lost)
    assert.deepEqual(s.runner.store.listMemberships(s.goalId).map(m => m.runId), [p.runId])
  }
})

test('same Goal Role is exclusive; a second Goal may independently use the same Role on another Pi', async t => {
  const s = fixture(t); await s.start()
  const first = s.registry.list()[0], second = await s.second()
  const pending = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: first.observedSessionId })
  assert.throws(() => s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: second.observedSessionId }), /reserved/)
  const goal2 = 'goal-two'
  s.runner.store.insertGoal({ goalId: goal2, projectId: s.projectId, goalText: 'another Goal', state: 'active', outcome: null, createdAt: 1000 })
  const parallel = s.authority.adoption.propose({ projectId: s.projectId, goalId: goal2,
    role: 'implementer', observedSessionId: second.observedSessionId })
  assert.equal(s.runner.store.listProposals().length, 2)
  assert.equal(s.runner.store.listBindings().length, 0)
  s.authority.adoption.authorize(parallel.proposalId)
  s.authority.adoption.authorize(pending.proposalId)
  assert.equal(s.runner.store.getBinding(parallel.runId)?.state, 'ready')
  assert.equal(s.runner.store.getBinding(pending.runId)?.state, 'ready')
  assert.deepEqual(s.runner.store.listMemberships(goal2).map(m => m.runId), [parallel.runId])
  assert.deepEqual(s.runner.store.listMemberships(s.goalId).map(m => m.runId), [pending.runId])
})

test('retired original and replacement use the same framed ACK/receipt path; purge remains leaf-only', async t => {
  const s = fixture(t); await s.start()
  const first = s.registry.list()[0]
  const original = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: first.observedSessionId })
  s.authority.adoption.authorize(original.proposalId)
  assert.equal(s.runner.store.getBinding(original.runId)?.state, 'ready')
  assert.throws(() => s.authority.adoption.retire(original.runId), /cannot be retired/)
  s.streams[0].a.destroy()
  assert.equal(s.runner.store.getBinding(original.runId)?.state, 'disconnected')
  const old = s.runner.store.getBinding(original.runId)!
  s.runner.retireBinding({ runId: old.runId, projectId: s.projectId, role: old.role, bindingDigest: old.bindingDigest })
  assert.equal(s.runner.store.listMemberships(s.goalId).length, 0)
  const observed = await s.second()
  const replacement = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: observed.observedSessionId, predecessorRunId: original.runId })
  s.authority.adoption.authorize(replacement.proposalId)
  assert.equal(s.runner.store.getBinding(replacement.runId)?.state, 'ready')
  assert.deepEqual(s.runner.store.listMemberships(s.goalId).map(m => m.runId), [replacement.runId])
  assert.equal(s.runner.store.getBinding(replacement.runId)?.predecessorRunId, original.runId)
  assert.throws(() => s.runner.purgeBinding(original.runId), /successor/)
  assert.equal(s.runner.store.listDeliveries(replacement.runId).length, 1)
  assert.equal(s.runner.store.listEvents().filter(e => e.kind === 'adoption_committed').length, 2)
})

test('superseding a recovery connection invalidates old receipts; registration alone never restores readiness', async t => {
  const s = fixture(t); await s.start()
  const observed = s.registry.list()[0]
  const proposal = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: observed.observedSessionId })
  s.authority.adoption.authorize(proposal.proposalId)
  const old = s.registry.currentBinding(observed.observedSessionId)!
  const replacement = pair()
  const inbound: string[] = []
  attachBridgeStream(replacement.a, { onFrame: (peer, frame) => s.registry.receive(peer, frame), onClose: peer => s.registry.disconnect(peer) })
  attachBridgeStream(replacement.b, { onFrame: (_peer, frame) => inbound.push(frame.type), onClose() {} })
  replacement.b.write(encodeBridgeFrame('register', 'superseding-recovery', {
    processInstanceId: observed.incarnation.processInstanceId, piSessionId: observed.incarnation.piSessionId,
    extensionInstanceId: observed.incarnation.extensionInstanceId, hostMode: 'tui',
    capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'],
    registrationAttempt: 100, sourceSequence: 100, lifecycle: 'running', activity: 'idle', health: 'healthy',
  }))
  assert.ok(inbound.includes('registered'))
  assert.ok(inbound.includes('recovery_request'))
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'disconnected')
  const current = s.registry.currentBinding(observed.observedSessionId)!
  assert.notEqual(current.connectionId, old.connectionId)
  replacement.b.write(encodeBridgeFrame('binding_receipt', 'stale-receipt', {
    connectionId: old.connectionId, connectionChallenge: old.challenge, sourceSequence: 101,
    runId: proposal.runId, bindingDigest: proposal.proposalDigest, activity: 'idle', pendingInput: false,
  }))
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'disconnected')
  assert.deepEqual(s.runner.store.listMemberships(s.goalId).map(m => m.runId), [proposal.runId])
})

test('synchronous fresh proof wins over superseded old-connection disconnect', async t => {
  const s = fixture(t); await s.start()
  const observed = s.registry.list()[0]
  const proposal = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: observed.observedSessionId })
  s.authority.adoption.authorize(proposal.proposalId)
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'ready')
  const next = pair()
  attachBridgeStream(next.a, { onFrame: (peer, frame) => s.registry.receive(peer, frame), onClose: peer => s.registry.disconnect(peer) })
  attachBridgeStream(next.b, { onFrame: (_peer, frame) => {
    if (frame.type === 'registered') {
      next.b.write(encodeBridgeFrame('recovery_proof', 'new-connection-proof', {
        runId: proposal.runId, bindingDigest: proposal.proposalDigest,
        processInstanceId: observed.incarnation.processInstanceId, piSessionId: observed.incarnation.piSessionId,
        extensionInstanceId: observed.incarnation.extensionInstanceId,
        connectionId: frame.body.connectionId, connectionChallenge: frame.body.connectionChallenge,
        sourceSequence: 101, pendingInput: false,
      }))
    }
    if (frame.type === 'adoption_committed') next.b.write(encodeBridgeFrame('binding_receipt', 'new-connection-receipt', {
      runId: proposal.runId, bindingDigest: proposal.proposalDigest, connectionId: frame.body.connectionId,
      connectionChallenge: frame.body.connectionChallenge, sourceSequence: 102, activity: 'idle', pendingInput: false,
    }))
  }, onClose() {} })
  next.b.write(encodeBridgeFrame('register', 'new-connection-registration', {
    processInstanceId: observed.incarnation.processInstanceId, piSessionId: observed.incarnation.piSessionId,
    extensionInstanceId: observed.incarnation.extensionInstanceId, hostMode: 'tui',
    capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'], registrationAttempt: 100,
    sourceSequence: 100, lifecycle: 'running', activity: 'idle', health: 'healthy',
  }))
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'ready', 'closing old socket must not undo proven new receipt')
  assert.equal(s.registry.list().filter(o => o.available && o.mode === 'committed').length, 1)
})

test('retirement wins a reconnect race; the surviving old extension cannot regain authority', async t => {
  const s = fixture(t); await s.start()
  const observed = s.registry.list()[0]
  const proposal = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId,
    role: 'implementer', observedSessionId: observed.observedSessionId })
  s.authority.adoption.authorize(proposal.proposalId)
  let serial = 0
  const retire = () => s.authority.handleIntent({ protocol: 'omarchestra.workbench/v1', intentId: `retire-${++serial}`,
    sessionId: s.authority.sessionId, pluginGeneration: s.authority.pluginGeneration, runnerEpoch: s.runner.epoch,
    expectedRevision: s.authority.currentRevision, kind: 'retire', target: proposal.runId,
    payload: { agentRunId: proposal.runId } })
  s.hooks.get('input')!({ source: 'interactive', get text() { throw Error('private input inspected') } }, s.host)
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'manual_takeover')
  assert.equal(retire().reasonCode, 'run_active', 'connected takeover cannot be retired')
  s.streams[0].a.destroy()
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'manual_takeover_disconnected')
  assert.equal(retire().status, 'acknowledged', 'freshly confirmed disconnected takeover can retire')
  await s.tick()
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'retired')
  assert.deepEqual(s.runner.store.listMemberships(s.goalId), [])
  assert.ok(s.runner.fences.isIncarnationFenced(incarnationKey(observed.incarnation)))
  assert.equal(s.registry.list().filter(o => o.available).length, 0)
})

test('terminal-leaf purge retains exact-incarnation fence and high-water across restart; saved Pi IDs cannot revive', async t => {
  const s = fixture(t); await s.start()
  const obs = s.registry.list()[0]
  const p = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: obs.observedSessionId })
  s.authority.adoption.authorize(p.proposalId)
  s.streams[0].a.destroy()
  const b = s.runner.store.getBinding(p.runId)!
  s.runner.retireBinding({ runId: b.runId, projectId: s.projectId, role: b.role, bindingDigest: b.bindingDigest })
  s.runner.purgeBinding(p.runId)
  assert.equal(s.runner.store.getBinding(p.runId), null, 'not a hidden purged card')
  assert.equal(s.runner.store.getBindingIdentity(p.runId), null)
  assert.equal(s.runner.fences.highWater(s.projectId, 'implementer', s.goalId), 1)
  s.runner.close()
  const reopened = openWorkbenchRunner({ roots: { stateDir: join(s.root, 'state') } })
  t.after(() => reopened.close())
  assert.ok(reopened.fences.isIncarnationFenced(incarnationKey(obs.incarnation)))
  assert.equal(reopened.store.getBinding(p.runId), null)
  assert.deepEqual(reopened.store.listMemberships(s.goalId), [])
  const fresh = new BridgeRegistry({ nodeId: reopened.nodeId, store: reopened.store, fences: reopened.fences, now: () => 2000 })
  const q = pair()
  attachBridgeStream(q.a, { onFrame: (peer, frame) => fresh.receive(peer, frame), onClose: peer => fresh.disconnect(peer) })
  attachBridgeStream(q.b, { onFrame() {}, onClose() {} })
  q.b.write(encodeBridgeFrame('register', 'replayed-identity', {
    processInstanceId: obs.incarnation.processInstanceId, piSessionId: obs.incarnation.piSessionId,
    extensionInstanceId: obs.incarnation.extensionInstanceId, hostMode: 'tui',
    capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'],
    registrationAttempt: 100, sourceSequence: 100, lifecycle: 'running', activity: 'idle', health: 'healthy',
  }))
  assert.deepEqual(fresh.list(), [])
  assert.equal(reopened.store.getBinding(p.runId), null)
})

test('offline interactive input on committed survivor reconciles to manual takeover before readiness', async t => {
  const s = fixture(t); await s.start()
  const obs = s.registry.list()[0]
  const p = s.authority.adoption.propose({ projectId: s.projectId, goalId: s.goalId, role: 'implementer', observedSessionId: obs.observedSessionId })
  s.authority.adoption.authorize(p.proposalId)
  assert.equal(s.runner.store.getBinding(p.runId)?.state, 'ready')
  s.streams[0].a.destroy()
  s.hooks.get('input')!({ source: 'interactive', get text() { throw Error('private input leaked') } }, s.host)
  await s.tick()
  assert.equal(s.runner.store.getBinding(p.runId)?.state, 'manual_takeover')
  assert.equal(s.statuses.at(-1), 'implementer · manual takeover')
  assert.equal(s.runner.store.listMemberships(s.goalId).length, 1)
  assert.equal(s.runner.store.listEvents().filter(e => e.kind === 'control_taken').length, 1)
  assert.equal(s.runner.store.listEvents().filter(e => e.kind === 'adoption_ready').length, 1, 'no second readiness after takeover')
})
