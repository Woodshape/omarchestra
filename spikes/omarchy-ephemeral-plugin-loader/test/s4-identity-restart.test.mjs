// SPIKE — Seam 4: identity/restart seam (red stage).
//
// Stale, wrong, duplicate, and pre-restart identities cannot affect current
// registrations; a restart creates an empty temporary registry.
// Contract: contracts/temporary-panel-v1.md, "Identity and restart semantics".

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHost, send, settle, expectError, expectErrorFamily, registerReadyPanel,
} from './helpers.mjs'
import { createIdentityPort } from '../fixtures/fake-identity.mjs'
import { addValidSource, validManifest } from '../fixtures/panel-sources.mjs'

test('malformed identities fail closed without state change', async () => {
  const { host, deps } = await createHost()
  const { registrationId } = registerReadyPanel(host, deps)
  const malformed = ['', '   ', 'x'.repeat(300), 42, null]
  for (const bad of malformed) {
    const parsed = send(host, 'hide', { registrationId: bad })
    expectErrorFamily(parsed, ['invalid_identity', 'unknown_registration'], `identity ${JSON.stringify(bad)} must fail closed`)
  }
  const inspect = send(host, 'inspect', { registrationId })
  assert.equal(inspect.result.state, 'registered_hidden', 'malformed identities change nothing')
})

test('unknown identities fail closed for every lifecycle operation', async () => {
  const { host, deps } = await createHost()
  registerReadyPanel(host, deps)
  for (const operation of ['summon', 'call', 'hide', 'unregister']) {
    const extra = operation === 'summon' || operation === 'call'
      ? { method: 'updateProjection', payload: null } : {}
    const parsed = send(host, operation, { registrationId: 'opaque-never-issued', ...extra })
    expectErrorFamily(parsed, ['unknown_registration', 'invalid_identity'], `${operation} of an unknown identity`)
  }
  const inspect = send(host, 'inspect', { registrationId: 'opaque-never-issued' })
  expectErrorFamily(inspect, ['unknown_registration', 'invalid_identity'])
})

test('one registration identity cannot affect a sibling', async () => {
  const { host, deps } = await createHost()
  const a = registerReadyPanel(host, deps, { name: 'panel-a', manifest: validManifest({ id: 'spike.fixture.a' }) })
  const b = registerReadyPanel(host, deps, { name: 'panel-b', manifest: validManifest({ id: 'spike.fixture.b' }) })
  assert.notEqual(a.registrationId, b.registrationId, 'identities are distinct')
  send(host, 'summon', { registrationId: b.registrationId, payload: null })
  settle(deps.clock)
  const unregistered = send(host, 'unregister', { registrationId: a.registrationId })
  assert.equal(unregistered.ok, true)
  settle(deps.clock)
  const inspected = send(host, 'inspect', { registrationId: b.registrationId })
  assert.equal(inspected.ok, true)
  // B was summoned but its loader never resolved (no finishLoad), so its
  // truthful state is 'loading'; the point is that it is unaffected by A.
  assert.equal(inspected.result.state, 'loading', 'sibling B is unaffected by teardown of A')
  const bLoader = deps.loader.created[deps.loader.created.length - 1]
  assert.equal(bLoader.destroyed, false, "B's loader survives A's unregister")
})

test('operation identities never grant lifecycle authority', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const registered = send(host, 'register', { path: dir })
  const operationId = registered.result.operationId
  settle(deps.clock)
  send(host, 'status', { operationId })
  for (const operation of ['summon', 'call', 'hide', 'unregister']) {
    const extra = operation === 'summon' || operation === 'call'
      ? { method: 'updateProjection', payload: null } : {}
    const parsed = send(host, operation, { registrationId: operationId, ...extra })
    expectErrorFamily(parsed, ['invalid_identity', 'unknown_registration'], `${operation} with an operation identity`)
  }
})

test('status of unknown operation identities fails closed', async () => {
  const { host } = await createHost()
  expectErrorFamily(
    send(host, 'status', { operationId: 'nope' }),
    ['unknown_operation_id', 'invalid_identity', 'unknown_registration'],
  )
})

test('shell restart: a fresh host never recognizes pre-restart identities', async () => {
  const first = await createHost({ nonce: 'nonce-one' })
  const { registrationId } = registerReadyPanel(first.host, first.deps)

  // "Restart": a fresh host instance with a fresh nonce and empty state,
  // sharing nothing but the fixture ports.
  const mod = await import('../lib/index.mjs')
  const hostTwo = mod.createTemporaryPanelHost({
    fs: first.deps.fs, loader: first.deps.loader, config: first.deps.config,
    scan: first.deps.scan, identity: createIdentityPort({ nonce: 'nonce-two' }),
    clock: first.deps.clock,
  })

  // Pre-restart identity must fail closed: recognizable -> stale, else unknown.
  expectErrorFamily(send(hostTwo, 'hide', { registrationId }), ['stale_registration', 'unknown_registration'], 'pre-restart hide')
  expectErrorFamily(send(hostTwo, 'summon', { registrationId, payload: null }), ['stale_registration', 'unknown_registration'])
  expectErrorFamily(send(hostTwo, 'unregister', { registrationId }), ['stale_registration', 'unknown_registration'])
  expectErrorFamily(send(hostTwo, 'inspect', { registrationId }), ['stale_registration', 'unknown_registration'])

  // The new shell's registry is empty and fully functional.
  const capabilities = send(hostTwo, 'capabilities')
  assert.equal(capabilities.ok, true)
  const fresh = registerReadyPanel(hostTwo, first.deps, { name: 'post-restart-console' })
  assert.notEqual(fresh.registrationId, registrationId, 'identities never revive across restarts')

  // The pre-restart identity still fails on the new host.
  expectErrorFamily(send(hostTwo, 'unregister', { registrationId }), ['stale_registration', 'unknown_registration'])
  // And the old host instance still owns exactly its own identity.
  const oldHostHide = send(first.host, 'hide', { registrationId })
  assert.equal(oldHostHide.ok, true, 'the old host instance still answers for its own identity')
})

test('pre-restart identities cannot be smuggled through status', async () => {
  const first = await createHost({ nonce: 'nonce-a' })
  const { registrationId } = registerReadyPanel(first.host, first.deps)
  const mod = await import('../lib/index.mjs')
  const hostTwo = mod.createTemporaryPanelHost({
    fs: first.deps.fs, loader: first.deps.loader, config: first.deps.config,
    scan: first.deps.scan, identity: createIdentityPort({ nonce: 'nonce-b' }),
    clock: first.deps.clock,
  })
  expectErrorFamily(
    send(hostTwo, 'status', { operationId: registrationId }),
    ['unknown_operation_id', 'invalid_identity', 'unknown_registration'],
  )
})