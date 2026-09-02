// SPIKE — Seam 3: lifecycle seam (red stage).
//
// register -> summon -> call/update -> hide -> unregister changes only the
// addressed fake registration and clears its Loader, item, and queues.
// Contract: contracts/temporary-panel-v1.md, "Lifecycle operations".

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHost, send, settle, expectError, expectErrorFamily, registerReadyPanel,
} from './helpers.mjs'
import { makeFakePanelItem } from '../fixtures/fake-loader.mjs'
import { validManifest } from '../fixtures/panel-sources.mjs'

async function readyRegistered(name = 'lifecycle-console') {
  const { host, deps } = await createHost()
  const { registrationId } = registerReadyPanel(host, deps, { name })
  return { host, deps, registrationId }
}

test('summon queues the open payload; the loaded item receives it in order', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  const summoned = send(host, 'summon', { registrationId, payload: { status: 'waiting' } })
  assert.equal(summoned.ok, true)
  assert.equal(deps.loader.created.length, 1, 'summon creates exactly one loader')
  const controller = deps.loader.created[0]
  assert.equal(controller.spec.registrationId, registrationId, 'loader is created for the addressed registration')
  assert.equal(controller.item, null, 'no delivery before the loader resolves')
  settle(deps.clock)

  const item = makeFakePanelItem()
  controller.finishLoad(item)
  assert.equal(item.openLog.length, 1, 'open payload delivered on load')
  assert.deepEqual(JSON.parse(item.openLog[0]), { status: 'waiting' })
  // Shared shell properties are injected before queue delivery.
  assert.equal(item.injected.omarchyPath, deps.loader.shared.omarchyPath)
  assert.equal(item.injected.shellToken, deps.loader.shared.shellToken)
})

test('call after summon: queued while loading (FIFO after open), immediate once loaded', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: { status: 'waiting' } })
  const queuedCall = send(host, 'call', { registrationId, method: 'updateProjection', payload: { status: 'managed' } })
  assert.equal(queuedCall.ok, true)
  assert.equal(queuedCall.result.state, 'queued', 'a call to a resolving loader reports queued')
  send(host, 'call', { registrationId, method: 'updateProjection', payload: { status: 'managed-2' } })

  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  assert.equal(item.openLog.length, 1)
  assert.deepEqual(item.callLog.map((payload) => JSON.parse(payload)), [
    { status: 'managed' },
    { status: 'managed-2' },
  ], 'queued calls preserve arrival order after the open payload')

  item.returnValue = 42
  const direct = send(host, 'call', { registrationId, method: 'updateProjection', payload: { status: 'managed' } })
  assert.equal(direct.ok, true)
  assert.equal(direct.result.value, '42', 'immediate return values convert to string')
})

test('call return values are truncated at 4096 bytes', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  const item = makeFakePanelItem()
  item.returnValue = 'z'.repeat(5000)
  deps.loader.created[0].finishLoad(item)
  const parsed = send(host, 'call', { registrationId, method: 'updateProjection', payload: null })
  assert.equal(parsed.ok, true)
  assert.ok(Buffer.byteLength(parsed.result.value, 'utf8') <= 4096, 'return value truncates at 4096 bytes')
})

test('call is rejected before any summon has started', async () => {
  const { host, registrationId } = await readyRegistered()
  expectError(send(host, 'call', { registrationId, method: 'updateProjection', payload: null }), 'not_summoned')
})

test('summon fully revalidates source metadata, manifest content, and entry point before creating a loader', async () => {
  const cases = [
    ['source permissions', ({ fs, dir }) => fs.setAttributes(dir, { mode: 0o777 })],
    ['manifest symlink', ({ fs, dir }) => fs.addSymlink(`${dir}/manifest.json`, '/changed/manifest.json')],
    ['manifest content', ({ fs, dir }) => fs.addFile(
      `${dir}/manifest.json`,
      JSON.stringify(validManifest({ name: 'Changed after registration' })),
    )],
    ['entry-point symlink', ({ fs, dir }) => fs.addSymlink(`${dir}/Panel.qml`, '/changed/Panel.qml')],
    ['entry-point owner', ({ fs, dir }) => fs.setAttributes(`${dir}/Panel.qml`, { ownerUid: 9999 })],
  ]

  for (const [name, mutate] of cases) {
    const { host, deps } = await createHost()
    const registered = registerReadyPanel(host, deps, { name: `revalidate-${name.replaceAll(' ', '-')}` })
    mutate({ fs: deps.fs, dir: registered.dir })
    expectError(
      send(host, 'summon', { registrationId: registered.registrationId, payload: null }),
      'source_changed',
    )
    assert.equal(deps.loader.created.length, 0, `${name} must fail before Loader creation`)
  }
})

test('method rules: lifecycle-reserved, underscore, syntax, missing, and throwing methods fail closed', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  for (const method of ['open', 'close', 'destroy', '_private', '1bad', 'bad name', `${'a'.repeat(65)}`]) {
    const parsed = send(host, 'call', { registrationId, method, payload: null })
    expectErrorFamily(parsed, ['invalid_method', 'invalid_field'], `method ${method} must be rejected`)
  }
  expectError(send(host, 'call', { registrationId, method: 'missingMethod', payload: null }), 'unknown_method')
  item.throwOn.updateProjection = true
  expectError(send(host, 'call', { registrationId, method: 'updateProjection', payload: null }), 'plugin_call_failed')
})

test('payload and combined open/call queue bounds fail without changing the queue', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  expectError(
    send(host, 'call', { registrationId, method: 'updateProjection', payload: { blob: 'x'.repeat(20000) } }),
    'invalid_payload',
  )
  let deep = 'leaf'
  for (let i = 0; i < 17; i += 1) deep = { n: deep }
  expectError(send(host, 'call', { registrationId, method: 'updateProjection', payload: deep }), 'invalid_payload')
  for (let i = 0; i < 31; i += 1) {
    const parsed = send(host, 'call', { registrationId, method: 'updateProjection', payload: { i } })
    assert.equal(parsed.ok, true, `call ${i} must be accepted after the queued open entry`)
  }
  expectError(
    send(host, 'call', { registrationId, method: 'updateProjection', payload: { overflow: true } }),
    'queue_full',
  )
  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  assert.equal(item.callLog.length, 31, 'the queue was not changed by the failed thirty-third entry')
  assert.deepEqual(JSON.parse(item.callLog[0]), { i: 0 })
  assert.deepEqual(JSON.parse(item.callLog[30]), { i: 30 })
})

test('multiple summons share the same 32-entry FIFO bound', async () => {
  const { host, registrationId } = await readyRegistered()
  let accepted
  for (let i = 0; i < 32; i += 1) {
    accepted = send(host, 'summon', { registrationId, payload: { i } })
    assert.equal(accepted.ok, true, `summon ${i} must fit in the combined queue`)
  }
  assert.equal(accepted.result.queued, 32)
  expectError(send(host, 'summon', { registrationId, payload: { overflow: true } }), 'queue_full')
})

test('hide unloads the object but retains registration; duplicate hide is an idempotent no-op', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  settle(deps.clock)
  assert.equal(deps.loader.created.length, 1)
  const hidden = send(host, 'hide', { registrationId })
  assert.equal(hidden.ok, true)
  assert.equal(hidden.result.changed, true)
  settle(deps.clock)
  assert.equal(deps.loader.created[0].active, false, 'hide deactivates the loader')
  assert.ok(item.closedCount >= 1, 'hide invokes close() when available')
  const again = send(host, 'hide', { registrationId })
  assert.equal(again.ok, true)
  assert.equal(again.result.changed, false, 'duplicate hide must be an idempotent no-op')
})

test('unknown or wrong identity cannot hide or affect the registration', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  expectErrorFamily(
    send(host, 'hide', { registrationId: 'totally-unknown' }),
    ['unknown_registration', 'invalid_identity'],
  )
  const inspect = send(host, 'inspect', { registrationId })
  assert.equal(inspect.ok, true)
  assert.equal(inspect.result.state, 'summoned', 'unknown identity leaves state unchanged')
  assert.equal(deps.loader.created[0].active, true)
})

test('unregister performs exact teardown of only the addressed registration', async () => {
  const { host, deps } = await createHost()
  const a = registerReadyPanel(host, deps, { name: 'panel-a', manifest: validManifest({ id: 'spike.fixture.a' }) })
  const b = registerReadyPanel(host, deps, { name: 'panel-b', manifest: validManifest({ id: 'spike.fixture.b' }) })
  send(host, 'summon', { registrationId: a.registrationId, payload: null })
  send(host, 'call', { registrationId: a.registrationId, method: 'updateProjection', payload: { n: 1 } })
  send(host, 'summon', { registrationId: b.registrationId, payload: null })
  settle(deps.clock)
  const itemB = makeFakePanelItem()
  deps.loader.created[1].finishLoad(itemB)

  const unregistered = send(host, 'unregister', { registrationId: a.registrationId })
  assert.equal(unregistered.ok, true)
  assert.equal(unregistered.result.changed, true)
  settle(deps.clock)

  assert.equal(deps.loader.created.length, 2, 'no extra loaders created')
  assert.equal(deps.loader.created[0].destroyed, true, "A's loader is destroyed")
  assert.equal(deps.loader.created[0].active, false)
  assert.equal(deps.loader.created[0].source, null, "A's loader source is cleared")
  assert.equal(deps.loader.created[1].destroyed, false, "B's loader survives")
  assert.equal(deps.loader.created[1].active, true)

  const stillThere = send(host, 'inspect', { registrationId: b.registrationId })
  assert.equal(stillThere.ok, true)
  assert.equal(stillThere.result.state, 'summoned')
  const callB = send(host, 'call', { registrationId: b.registrationId, method: 'updateProjection', payload: { n: 2 } })
  assert.equal(callB.ok, true)
  assert.equal(itemB.callLog.length, 1)
})

test('unregister retains source and ID claims until exact teardown completes', async () => {
  const { host, deps } = await createHost()
  const registered = registerReadyPanel(host, deps, { name: 'claim-during-teardown' })
  const first = send(host, 'unregister', { registrationId: registered.registrationId })
  assert.equal(first.ok, true)
  expectError(send(host, 'register', { path: registered.dir }), 'source_collision')

  settle(deps.clock)
  const afterTeardown = send(host, 'register', { path: registered.dir })
  assert.equal(afterTeardown.ok, true, 'claims release only after teardown reaches its terminal state')
})

test('unregister clears queued payloads and calls: they never reach an item', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: { first: true } })
  send(host, 'call', { registrationId, method: 'updateProjection', payload: { second: true } })
  const gone = send(host, 'unregister', { registrationId })
  assert.equal(gone.ok, true)
  assert.equal(gone.result.changed, true)
  settle(deps.clock)
  assert.equal(deps.loader.created[0].destroyed, true)
  // A late resolution for the destroyed registration delivers nothing.
  const lateItem = makeFakePanelItem()
  const controller = deps.loader.created[0]
  if (!controller.destroyed) controller.finishLoad(lateItem)
  settle(deps.clock)
  assert.equal(lateItem.openLog.length, 0, 'cleared queues never deliver')
})

test('duplicate unregister: pending response, tombstone response, then unknown', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  const first = send(host, 'unregister', { registrationId })
  assert.equal(first.ok, true)
  assert.equal(first.result.changed, true)
  settle(deps.clock)
  const tombstoned = send(host, 'unregister', { registrationId })
  assert.equal(tombstoned.ok, true)
  assert.equal(tombstoned.result.changed, false)
  assert.equal(tombstoned.result.state, 'unregistered')
  expectError(send(host, 'summon', { registrationId, payload: null }), 'unknown_registration')
  deps.clock.advance(5 * 60 * 1000 + 1)
  settle(deps.clock)
  expectError(send(host, 'unregister', { registrationId }), 'unknown_registration')
})

test('load failure is observable; failed hide is a no-op; unregister stays possible', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  settle(deps.clock)
  deps.loader.created[0].failLoad('panel exploded')
  const inspected = send(host, 'inspect', { registrationId })
  assert.equal(inspected.result.state, 'failed', 'load failure is observable')
  assert.ok(inspected.result.lastError !== undefined, 'lastError is present and bounded')
  const hidden = send(host, 'hide', { registrationId })
  assert.equal(hidden.ok, true)
  assert.equal(hidden.result.changed, false, 'hide of an already-unloaded failed registration is a no-op')
  const unregistered = send(host, 'unregister', { registrationId })
  assert.equal(unregistered.ok, true)
  assert.equal(unregistered.result.changed, true)
  settle(deps.clock)
})

test('hide while loading drops queued work; late resolution delivers nothing', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: { soon: false } })
  send(host, 'call', { registrationId, method: 'updateProjection', payload: { soon: true } })
  settle(deps.clock)
  const hidden = send(host, 'hide', { registrationId })
  assert.equal(hidden.ok, true)
  assert.equal(hidden.result.changed, true)
  const item = makeFakePanelItem()
  const controller = deps.loader.created[0]
  if (!controller.destroyed) controller.finishLoad(item)
  settle(deps.clock)
  assert.equal(item.openLog.length, 0, 'a hidden registration delivers nothing')
  const inspected = send(host, 'inspect', { registrationId })
  assert.equal(inspected.result.state, 'registered_hidden')
})

test('hide invalidates a late loader-error callback and permits a fresh summon', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: null })
  const oldLoader = deps.loader.created[0]
  send(host, 'hide', { registrationId })
  oldLoader.failLoad('late stale error')
  assert.equal(send(host, 'inspect', { registrationId }).result.state, 'registered_hidden')
  assert.equal(send(host, 'summon', { registrationId, payload: { fresh: true } }).ok, true)
})

test('source revalidation failure retains source and ID claims until unregister', async () => {
  const { host, deps } = await createHost()
  const registered = registerReadyPanel(host, deps, { name: 'failed-source-claim' })
  deps.fs.setAttributes(registered.dir, { mode: 0o777 })
  expectError(send(host, 'summon', { registrationId: registered.registrationId, payload: null }), 'source_changed')
  deps.fs.setAttributes(registered.dir, { mode: 0o755 })
  expectError(send(host, 'register', { path: registered.dir }), 'source_collision')
  send(host, 'unregister', { registrationId: registered.registrationId })
  settle(deps.clock)
  assert.equal(send(host, 'register', { path: registered.dir }).ok, true)
})

test('resummon after hide creates a fresh loader and delivers the new payload', async () => {
  const { host, deps, registrationId } = await readyRegistered()
  send(host, 'summon', { registrationId, payload: { one: 1 } })
  settle(deps.clock)
  deps.loader.created[0].finishLoad(makeFakePanelItem())
  send(host, 'hide', { registrationId })
  settle(deps.clock)
  const second = send(host, 'summon', { registrationId, payload: { two: 2 } })
  assert.equal(second.ok, true)
  settle(deps.clock)
  assert.equal(deps.loader.created.length, 2, 'hide unloads; resummon creates a fresh loader')
  const item2 = makeFakePanelItem()
  deps.loader.created[1].finishLoad(item2)
  assert.deepEqual(JSON.parse(item2.openLog[0]), { two: 2 }, 'the new payload reaches the new item')
})