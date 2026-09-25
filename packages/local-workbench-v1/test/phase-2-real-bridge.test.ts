import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeDecoder, BRIDGE_CAPABILITIES, encodeBridgeFrame } from '../runner/bridge-protocol.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { openOwnerPiBridge } from '../runner/bridge-owner.ts'
import { connectLocalPiBridge, createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { incarnationKey } from '../runner/binding-identity.ts'

class Stream extends EventEmitter {
  other!: Stream; destroyed = false; output: Buffer[] = []
  write(data: Buffer) { if (this.destroyed) throw Error('closed'); this.output.push(data); this.other.emit('data', data); return true }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('close'); if (!this.other.destroyed) this.other.destroy() }
}
function pair() { const a = new Stream(), b = new Stream(); a.other = b; b.other = a; return { a, b } }
function fixture(t: test.TestContext, autoCleanup = true) {
  const root = mkdtempSync(join(tmpdir(), 'wb-real-bridge-'))
  mkdirSync(join(root, 'runtime'), { mode: 0o700 })
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state'), runtimeDir: join(root, 'runtime') } })
  if (autoCleanup) t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, runner }
}
const register = (processInstanceId = 'process-' + 'a'.repeat(32), attempt = 1, sequence = 1) => ({ processInstanceId, piSessionId: 'session-1', extensionInstanceId: 'extension-' + 'b'.repeat(32), hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES], registrationAttempt: attempt, sourceSequence: sequence, lifecycle: 'running', activity: 'idle', health: 'healthy' })
function link(registry: BridgeRegistry) {
  const { a, b } = pair(), received: unknown[] = []
  const decoder = new BridgeDecoder()
  attachBridgeStream(a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
  const client = attachBridgeStream(b, { onFrame: (_peer, frame) => received.push(frame) })
  return { a, b, received, client }
}
const sendRegister = (client: ReturnType<typeof link>['client'], body = register()) => client.sendFrame('register', 'msg-register', body)

test('opt-in Pi package exposes the actual entry without auto-installing or dispatching', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.pi.extensions, ['./pi-extension.ts'])
  assert.equal(pkg.private, true)
})

test('bounded byte framing rejects malformed, oversized, invalid UTF-8, unknown fields and forbidden content', () => {
  const bytes = encodeBridgeFrame('register', 'msg-1', register())
  const decoder = new BridgeDecoder()
  assert.equal(decoder.push(bytes.subarray(0, 9)).length, 0)
  assert.equal(decoder.push(bytes.subarray(9)).length, 1)
  assert.equal(decoder.push(Buffer.concat([bytes, bytes])).length, 2)
  for (const chunk of [Buffer.from('{bad}\n'), Buffer.from([0xff, 10]), Buffer.from('x'.repeat(32769)), Buffer.from(JSON.stringify({ protocol: 'omarchestra.bridge/v1', type: 'heartbeat', messageId: 'm', body: { prompt: 'secret' } }) + '\n')]) {
    assert.throws(() => new BridgeDecoder().push(chunk))
  }
  assert.throws(() => encodeBridgeFrame('register', 'msg-1', { ...register(), prompt: 'sensitive' }))
  assert.throws(() => encodeBridgeFrame('register', 'msg-1', { ...register(), capabilities: ['observe.lifecycle', 'observe.lifecycle', 'managed.activate'] }))
  assert.throws(() => encodeBridgeFrame('register', 'msg-1', { ...register(), processInstanceId: 'weak' }))
})

test('exact current connection, high-water, duplicates, capacity, lease and fences', t => {
  const { runner } = fixture(t); let now = 0, serial = 0
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now, issue: prefix => `${prefix}-${(++serial).toString(16).padStart(32, '0')}` })
  const first = link(registry); sendRegister(first.client)
  const registered = (first.received[0] as { body: Record<string, unknown> }).body
  assert.equal(registry.list()[0].mode, 'observed')
  assert.equal(registry.list()[0].sessionCode, null, 'legacy extension has no invented matching footer')
  assert.equal(registry.list()[0].navigation, null, 'legacy extension has no navigation capability or target')
  assert.equal(registry.prepareNavigation('not-issued', 'request'), null)
  assert.equal(Object.hasOwn(registered, 'sessionCode'), false, 'legacy registered envelope is unchanged')
  first.client.sendFrame('heartbeat', 'heartbeat-1', { connectionId: registered.connectionId, connectionChallenge: registered.connectionChallenge, sourceSequence: 2, lifecycle: 'running', activity: 'busy', health: 'healthy' })
  assert.equal(registry.list()[0].activity, 'busy')
  first.client.sendFrame('heartbeat', 'heartbeat-1', { connectionId: registered.connectionId, connectionChallenge: registered.connectionChallenge, sourceSequence: 2, lifecycle: 'running', activity: 'busy', health: 'healthy' })
  assert.equal(registry.list()[0].available, true)
  const stale = link(registry); sendRegister(stale.client, register(undefined, 1, 3)); assert.equal(stale.a.destroyed, true)
  const next = link(registry); sendRegister(next.client, register(undefined, 2, 3))
  assert.equal(first.a.destroyed, true)
  assert.equal(registry.list().length, 1)
  assert.notEqual((next.received[0] as { body: Record<string, unknown> }).body.connectionChallenge, registered.connectionChallenge)
  const wrong = link(registry)
  wrong.client.sendFrame('heartbeat', 'forged', { connectionId: (next.received[0] as { body: Record<string, unknown> }).body.connectionId, connectionChallenge: (next.received[0] as { body: Record<string, unknown> }).body.connectionChallenge, sourceSequence: 4, lifecycle: 'running', activity: 'idle', health: 'healthy' })
  assert.equal(wrong.a.destroyed, true)
  assert.equal(registry.list()[0].activity, 'idle')
  for (let i = 1; i < 64; i++) sendRegister(link(registry).client, register('process-' + i.toString(16).padStart(32, '0')))
  assert.equal(registry.list().length, 64)
  next.client.close()
  assert.equal(registry.list().filter(record => record.available).length, 63, 'one disconnect never drops unrelated sessions')
  const excess = link(registry); sendRegister(excess.client, register('process-' + 'f'.repeat(32))); assert.equal(excess.a.destroyed, true)
  now = 15000; assert.equal(registry.list().length, 0)
  const fresh = link(registry); sendRegister(fresh.client, register(undefined, 3, 5))
  assert.equal(registry.list()[0].available, true)
  registry.close()
})

test('changed duplicate, sequence regression, wrong challenge, and Pi session switch fail closed', t => {
  const { runner } = fixture(t); const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences })
  const a = link(registry); sendRegister(a.client)
  const token = (a.received[0] as { body: Record<string, unknown> }).body
  a.client.sendFrame('heartbeat', 'same-message', { connectionId: token.connectionId, connectionChallenge: token.connectionChallenge, sourceSequence: 2, lifecycle: 'running', activity: 'idle', health: 'healthy' })
  a.client.sendFrame('heartbeat', 'same-message', { connectionId: token.connectionId, connectionChallenge: token.connectionChallenge, sourceSequence: 2, lifecycle: 'running', activity: 'busy', health: 'healthy' })
  assert.equal(a.a.destroyed, true)
  const b = link(registry); sendRegister(b.client, register(undefined, 2, 3))
  const current = (b.received[0] as { body: Record<string, unknown> }).body
  b.client.sendFrame('heartbeat', 'wrong-challenge', { connectionId: current.connectionId, connectionChallenge: token.connectionChallenge, sourceSequence: 4, lifecycle: 'running', activity: 'idle', health: 'healthy' })
  assert.equal(b.a.destroyed, true)
  const c = link(registry); sendRegister(c.client, { ...register(undefined, 3, 5), piSessionId: 'session-2' })
  assert.equal(registry.list().find(record => record.incarnation.piSessionId === 'session-1')?.available, false)
  const old = link(registry); sendRegister(old.client, register(undefined, 4, 6))
  assert.equal(registry.list().find(record => record.incarnation.piSessionId === 'session-2')?.available, false)
  const later = (old.received[0] as { body: Record<string, unknown> }).body
  old.client.sendFrame('heartbeat', 'regressed', { connectionId: later.connectionId, connectionChallenge: later.connectionChallenge, sourceSequence: 6, lifecycle: 'running', activity: 'idle', health: 'healthy' })
  assert.equal(old.a.destroyed, true)
})

test('retained membership routes to committed mode; retired incarnation cannot bypass fence with a new observed ID', t => {
  const { root, runner } = fixture(t)
  const identity = { executionNodeId: runner.nodeId, processInstanceId: register().processInstanceId, piSessionId: 'session-1', extensionInstanceId: register().extensionInstanceId }
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'goal', state: 'active', outcome: null, createdAt: 1 })
  runner.store.putBinding({ runId: 'run', projectId: 'project', role: 'implementer', state: 'committed', bindingDigest: 'digest', controlEpoch: 1, writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: 1 })
  runner.bindIdentity('run', 'goal', identity)
  runner.store.transaction(() => runner.commitMembership('run'))
  const inputs: string[] = []
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, onInput: event => inputs.push(event.eventId) })
  const first = link(registry); sendRegister(first.client)
  const body = (first.received[0] as { body: Record<string, unknown> }).body
  assert.equal(body.mode, 'committed')
  first.client.sendFrame('input_observed', 'input-msg', { connectionId: body.connectionId, connectionChallenge: body.connectionChallenge, sourceSequence: 2, eventId: 'event-1' })
  assert.deepEqual(inputs, ['event-1'])
  runner.retireBinding({ runId: 'run', projectId: 'project', role: 'implementer', bindingDigest: 'digest' })
  assert.equal(runner.fences.isIncarnationFenced(incarnationKey(identity)), true)
  first.client.sendFrame('input_observed', 'late-input', { connectionId: body.connectionId, connectionChallenge: body.connectionChallenge, sourceSequence: 3, eventId: 'event-2' })
  assert.equal(first.a.destroyed, true)
  assert.deepEqual(inputs, ['event-1'])
  const second = link(registry); sendRegister(second.client, register(undefined, 2, 3))
  assert.equal(second.a.destroyed, true)
  assert.equal(inputs.length, 1)
})

test('surviving fake Pi keeps source-only takeover evidence offline and flushes it on same-incarnation recovery', async t => {
  const { root, runner } = fixture(t)
  const identity = { executionNodeId: runner.nodeId, processInstanceId: register().processInstanceId, piSessionId: 'session-1', extensionInstanceId: register().extensionInstanceId }
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'goal', state: 'active', outcome: null, createdAt: 1 })
  runner.store.putBinding({ runId: 'run', projectId: 'project', role: 'implementer', state: 'committed', bindingDigest: 'digest', controlEpoch: 1, writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: 1 })
  runner.bindIdentity('run', 'goal', identity)
  runner.store.transaction(() => runner.commitMembership('run'))
  const inputs: string[] = []
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, onInput: event => inputs.push(event.eventId) })
  const channels: ReturnType<typeof pair>[] = [], ticks: Array<() => void> = []
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const host = { mode: 'tui', sessionManager: { getSessionId: () => 'session-1' }, isIdle: () => true, ui: { setStatus() {} } }
  createPiBridgeExtension({
    newId: prefix => prefix === 'process' ? identity.processInstanceId : prefix === 'extension' ? identity.extensionInstanceId : `${prefix}-${'c'.repeat(32)}`,
    schedule: callback => { ticks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> }, cancel: () => {},
    connect: async (onFrame, onClose) => {
      const streams = pair(); channels.push(streams)
      attachBridgeStream(streams.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
      return attachBridgeStream(streams.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
    },
  })({ on(name, callback) { hooks.set(name, callback as (event: unknown, ctx: unknown) => void) } })
  hooks.get('session_start')!(null, host)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(registry.list()[0]?.mode, 'committed')
  channels[0].a.destroy()
  const input = { source: 'interactive', get text() { throw Error('private content') } }
  hooks.get('input')!(input, host)
  assert.deepEqual(inputs, [])
  ticks.shift()?.()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(channels.length, 2)
  assert.equal(inputs.length, 1)
  assert.equal(registry.list()[0]?.mode, 'committed')
  hooks.get('session_shutdown')!(null, host)
})

test('an input write is not acknowledged when the persistence port fails', t => {
  const { root, runner } = fixture(t)
  const identity = { executionNodeId: runner.nodeId, processInstanceId: register().processInstanceId, piSessionId: 'session-1', extensionInstanceId: register().extensionInstanceId }
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'goal', state: 'active', outcome: null, createdAt: 1 })
  runner.store.putBinding({ runId: 'run', projectId: 'project', role: 'implementer', state: 'committed', bindingDigest: 'digest', controlEpoch: 1, writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: 1 })
  runner.bindIdentity('run', 'goal', identity)
  runner.store.transaction(() => runner.commitMembership('run'))
  let fail = true
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, onInput: () => { if (fail) throw Error('injected store failure') } })
  const a = link(registry); sendRegister(a.client)
  const first = (a.received[0] as { body: Record<string, unknown> }).body
  a.client.sendFrame('input_observed', 'event-msg', { connectionId: first.connectionId, connectionChallenge: first.connectionChallenge, sourceSequence: 2, eventId: 'input-event' })
  assert.equal(a.a.destroyed, true)
  assert.equal(a.received.length, 1, 'no receipt for an uncommitted takeover')
  fail = false
  const b = link(registry); sendRegister(b.client, register(undefined, 2, 3))
  const second = (b.received[0] as { body: Record<string, unknown> }).body
  b.client.sendFrame('input_observed', 'retry-msg', { connectionId: second.connectionId, connectionChallenge: second.connectionChallenge, sourceSequence: 4, eventId: 'input-event' })
  assert.equal((b.received[1] as { type: string }).type, 'input_received')
})

test('socket replacement is not unlinked on owner teardown', async t => {
  const { root, runner } = fixture(t), socket = join(root, 'runtime', 'omarchestra-bridge.sock')
  const owner = await openOwnerPiBridge(runner, socket)
  renameSync(socket, socket + '.original')
  writeFileSync(socket, 'foreign socket-path occupant')
  await assert.rejects(owner.close(), /identity_changed/)
  assert.equal(existsSync(socket), true)
  assert.equal(readFileSync(socket, 'utf8'), 'foreign socket-path occupant')
})

test('real owner-only Unix socket and fake Pi host: no content getters, fail-open, no execution', async t => {
  const { root, runner } = fixture(t, false), runtime = join(root, 'runtime')
  const socket = join(runtime, 'omarchestra-bridge.sock')
  await assert.rejects(openOwnerPiBridge(runner, join(root, 'other.sock')), /root_mismatch/)
  const owner = await openOwnerPiBridge(runner, socket)
  t.after(async () => { await owner.close(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const statuses: Array<string | undefined> = []
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 'session-1' }, isIdle: () => true, ui: { setStatus(_key: string, text: string | undefined) { statuses.push(text) } } }
  let navigationCalls = 0
  const extension = createPiBridgeExtension({ socketPath: socket, navigate: async guard => {
    assert.equal(guard(), true); navigationCalls++; return 'shown'
  } })
  t.after(() => hooks.get('session_shutdown')?.(null, ctx))
  extension({ on(name, handler) { hooks.set(name, handler as (event: unknown, ctx: unknown) => void) } })
  hooks.get('session_start')!(null, ctx)
  const deadline = Date.now() + 2000
  while ((!owner.registry.list().length || !statuses.includes(`Pi ${owner.registry.list()[0]?.sessionCode} · Unassigned · observed`)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(owner.registry.list()[0]?.mode, 'observed')
  assert.match(owner.registry.list()[0].sessionCode!, /^[A-F0-9]{4}-[A-F0-9]{4}$/)
  assert.ok(statuses.includes(`Pi ${owner.registry.list()[0].sessionCode} · Unassigned · observed`))
  // Transport boundary only; authority receipt-before-send is separately tested.
  const request = owner.registry.prepareNavigation(owner.registry.list()[0].navigation!.ticket!, 'socket-navigation')
  assert.ok(request); request()
  const focusDeadline = Date.now() + 2000
  while (owner.registry.list()[0].navigation?.state === 'checking' && Date.now() < focusDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(owner.registry.list()[0].navigation?.state, 'shown')
  assert.equal(navigationCalls, 1)
  const input = { source: 'interactive', get text() { throw Error('privacy violation') }, get length() { throw Error('privacy violation') } }
  hooks.get('input')!(input, ctx)
  assert.equal(runner.store.listBindings().length, 0)
  hooks.get('session_shutdown')!(null, ctx)
  const closeDeadline = Date.now() + 2000
  while (owner.registry.list()[0]?.available && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(owner.registry.list()[0]?.available, false)
  await assert.rejects(connectLocalPiBridge(join(runtime, 'missing.sock'), () => {}, () => {}))
})
