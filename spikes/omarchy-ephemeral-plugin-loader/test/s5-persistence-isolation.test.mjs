// SPIKE — Seam 5: persistence-isolation seam (red stage).
//
// Capability and temporary lifecycle operations never call injected config
// mutators or writers, never write through the filesystem port, and leave the
// installed registry byte-identical. Contract: contracts/temporary-panel-v1.md,
// "Persistence isolation" and "Collision rules" (rescan invalidation).

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHost, send, settle, expectError, expectErrorFamily, registerReadyPanel,
} from './helpers.mjs'
import {
  validManifest, addValidSource,
} from '../fixtures/panel-sources.mjs'
import { installedManifest } from '../fixtures/fake-scan.mjs'
import { makeFakePanelItem } from '../fixtures/fake-loader.mjs'

function assertNoPersistence(deps, context) {
  assert.equal(deps.config.calls.length, 0, `${context}: config mutator/writer must never be called`)
  assert.equal(deps.fs.writes.length, 0, `${context}: filesystem port must observe zero writes`)
}

test('the full temporary lifecycle never touches configuration or installed state', async () => {
  const { host, deps } = await createHost()
  deps.scan.setPlugins({
    'omarchy.clock': installedManifest('omarchy.clock', '/usr/share/omarchy/shell/plugins/clock'),
  })
  const installedBefore = JSON.stringify(deps.scan.installedPlugins())

  const { registrationId } = registerReadyPanel(host, deps)
  assertNoPersistence(deps, 'after register')
  send(host, 'summon', { registrationId, payload: { status: 'waiting' } })
  settle(deps.clock)
  const item = makeFakePanelItem()
  deps.loader.created[0].finishLoad(item)
  assertNoPersistence(deps, 'after summon')
  send(host, 'call', { registrationId, method: 'updateProjection', payload: { status: 'managed' } })
  send(host, 'hide', { registrationId })
  send(host, 'unregister', { registrationId })
  settle(deps.clock)
  assertNoPersistence(deps, 'after full lifecycle')

  assert.equal(
    JSON.stringify(deps.scan.installedPlugins()),
    installedBefore,
    'installed registry must remain byte-identical',
  )
})

test('capability-only sessions are completely inert', async () => {
  const { host, deps } = await createHost()
  for (let i = 0; i < 10; i += 1) send(host, 'capabilities')
  settle(deps.clock)
  assertNoPersistence(deps, 'capabilities-only session')
})

test('rejected registrations never call config writers or leave partial state', async () => {
  const { host, deps } = await createHost()
  // Every rejection class in one session.
  const rejections = [
    { path: 'relative/path' },
    { path: '/repo/plugins/../etc' },
    { path: '/missing/dir' },
  ]
  for (const request of rejections) {
    expectErrorFamily(send(host, 'register', request), ['path_invalid', 'invalid_field'])
  }
  settle(deps.clock)
  assertNoPersistence(deps, 'after rejection batch')
  assert.equal(deps.loader.created.length, 0)
})

test('a later rescan collision invalidates only the colliding temporary registration', async () => {
  const { host, deps } = await createHost()
  const a = registerReadyPanel(host, deps, { name: 'panel-a', manifest: validManifest({ id: 'spike.fixture.a' }) })
  const b = registerReadyPanel(host, deps, { name: 'panel-b', manifest: validManifest({ id: 'spike.fixture.b' }) })
  send(host, 'summon', { registrationId: b.registrationId, payload: null })
  settle(deps.clock)
  const itemB = makeFakePanelItem()
  deps.loader.created[deps.loader.created.length - 1].finishLoad(itemB)

  // The installed registry grows to collide with A's plugin id.
  const installedBefore = JSON.stringify(deps.scan.installedPlugins())
  deps.scan.setPlugins({
    'spike.fixture.a': installedManifest('spike.fixture.a', '/usr/share/omarchy/shell/plugins/somewhere'),
  })
  deps.scan.emitPluginsChanged()
  settle(deps.clock)

  const aInspect = send(host, 'inspect', { registrationId: a.registrationId })
  assert.equal(aInspect.ok, true)
  assert.equal(aInspect.result.state, 'failed_collision', 'only A becomes failed_collision')
  assert.ok(aInspect.result.lastError !== undefined, 'the collision stays inspectable')
  // A's queues were cleared and its loader unloaded.
  assert.equal(deps.loader.created.length, 1, 'only B ever created a loader')
  assert.equal(deps.loader.created[0].destroyed, false, "B's loader survives the collision invalidation")

  // B is untouched.
  const bInspect = send(host, 'inspect', { registrationId: b.registrationId })
  assert.equal(bInspect.result.state, 'summoned', 'B survives the collision invalidation')
  const callB = send(host, 'call', { registrationId: b.registrationId, method: 'updateProjection', payload: null })
  assert.equal(callB.ok, true)

  // The installed plugin itself was never disabled or unloaded.
  assert.equal(
    JSON.stringify(deps.scan.installedPlugins()).includes('spike.fixture.a'),
    true,
    'the installed colliding plugin remains present',
  )
  assertNoPersistence(deps, 'after rescan collision')
  void installedBefore

  // Removing the installed collision does not silently release A's temporary
  // claims. Only exact unregister can authorize their release.
  deps.scan.setPlugins({})
  deps.scan.emitPluginsChanged()
  expectError(send(host, 'register', { path: a.dir }), 'source_collision')

  // The failed record can still be unregistered exactly.
  const unregistered = send(host, 'unregister', { registrationId: a.registrationId })
  assert.equal(unregistered.ok, true)
  assert.equal(unregistered.result.changed, true)
  settle(deps.clock)
  assert.equal(send(host, 'register', { path: a.dir }).ok, true)
})

test('temporary records never leak into the installed registry view', async () => {
  const { host, deps } = await createHost()
  const { pluginId } = registerReadyPanel(host, deps)
  settle(deps.clock)
  const installed = deps.scan.installedPlugins()
  assert.equal(installed[pluginId], undefined, 'temporary plugin id must not appear in installedPlugins')
  assert.equal(Object.keys(installed).length, 0)
  assertNoPersistence(deps, 'registry view check')
})