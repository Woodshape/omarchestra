// SPIKE — Seam 2: registration seam (red stage).
//
// Valid fake panel manifests register once; malformed, non-panel, escaped,
// symlinked, non-owned, oversized, and colliding sources fail without partial
// state. Contract: contracts/temporary-panel-v1.md, "Registration",
// "Path and source rules", "Manifest bounds", "Collision rules".

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHost, send, sendRaw, settle, expectError, expectErrorFamily,
} from './helpers.mjs'
import {
  validManifest, addValidSource, addRawManifestSource,
  oversizedManifest, nestedObject,
} from '../fixtures/panel-sources.mjs'
import { installedManifest } from '../fixtures/fake-scan.mjs'

test('valid fake panel registers once: validating -> registered_hidden', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const parsed = send(host, 'register', { path: dir })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.result.state, 'validating')
  assert.equal(typeof parsed.result.operationId, 'string')
  assert.ok(parsed.result.operationId.length > 0)
  assert.ok(Buffer.byteLength(parsed.result.operationId, 'utf8') <= 256, 'operation identity bounded to 256 bytes')

  settle(deps.clock)
  const status = send(host, 'status', { operationId: parsed.result.operationId })
  assert.equal(status.ok, true)
  assert.equal(status.result.state, 'registered_hidden')
  assert.equal(typeof status.result.registrationId, 'string')
  assert.ok(Buffer.byteLength(status.result.registrationId, 'utf8') <= 256, 'registration identity bounded to 256 bytes')
  assert.equal(status.result.pluginId, 'spike.fixture.console')
  // Identities are opaque and distinct.
  assert.notEqual(status.result.registrationId, parsed.result.operationId)
  assert.notEqual(status.result.registrationId, 'spike.fixture.console')
  assert.ok(!status.result.registrationId.includes('/repo/plugins'), 'identity must not encode the source path')
  assert.equal(deps.loader.created.length, 0, 'registration alone must not create a loader')
})

test('re-registration of the same canonical source fails without aliasing', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const first = send(host, 'register', { path: dir })
  settle(deps.clock)
  send(host, 'status', { operationId: first.result.operationId })
  expectError(send(host, 'register', { path: dir }), 'source_collision')
})

test('relative, noncanonical, NUL, newline, oversized, missing, and wrong-type paths fail closed', async () => {
  const { host, deps } = await createHost()
  addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const cases = [
    'repo/plugins/fixture-console',                                  // not absolute
    '/repo/plugins/../plugins/fixture-console',                      // noncanonical
    '/repo/plugins/fixture-console/../fixture-console',              // noncanonical
    '/repo/plugins/missing-console',                                 // missing
    '/repo/plugins/fixture-console/manifest.json',                   // a file, not a directory
  ]
  for (const path of cases) {
    const parsed = send(host, 'register', { path })
    expectErrorFamily(parsed, ['path_invalid', 'invalid_field'], `path ${path} must fail closed`)
  }
  expectErrorFamily(send(host, 'register', { path: '/repo/plugins/bad\u0000name' }), ['path_invalid', 'invalid_field'])
  expectErrorFamily(send(host, 'register', { path: '/repo/plugins/bad\nname' }), ['path_invalid', 'invalid_field'])
  expectErrorFamily(send(host, 'register', { path: `/${'x'.repeat(4200)}` }), ['path_invalid', 'request_too_large'])
})

test('symlink components are rejected at source, manifest, and entry point', async () => {
  const { host, deps } = await createHost()
  // 1. symlinked source directory
  deps.fs.addDirectory('/repo/plugins/real-console')
  deps.fs.addFile('/repo/plugins/real-console/manifest.json', JSON.stringify(validManifest()))
  deps.fs.addFile('/repo/plugins/real-console/Panel.qml', '// x')
  deps.fs.addSymlink('/repo/plugins/link-console', '/repo/plugins/real-console')
  expectError(send(host, 'register', { path: '/repo/plugins/link-console' }), 'symlink_component')

  // 2. symlinked manifest.json
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  deps.fs.removeNode(`${dir}/manifest.json`)
  deps.fs.addSymlink(`${dir}/manifest.json`, '/elsewhere/manifest.json')
  expectError(send(host, 'register', { path: dir }), 'symlink_component')

  // 3. symlinked entry-point file
  deps.fs.removeNode(dir)
  const dir2 = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  deps.fs.removeNode(`${dir2}/Panel.qml`)
  deps.fs.addSymlink(`${dir2}/Panel.qml`, '/elsewhere/Panel.qml')
  expectErrorFamily(send(host, 'register', { path: dir2 }), ['symlink_component', 'entry_point_invalid'])
})

test('non-owned and group/world-writable sources fail closed', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  deps.fs.setAttributes(dir, { ownerUid: 9999 })
  expectError(send(host, 'register', { path: dir }), 'path_not_owned')

  const dir2 = addValidSource(deps.fs, '/repo/plugins', 'loose-console')
  deps.fs.setAttributes(dir2, { mode: 0o777 })
  expectError(send(host, 'register', { path: dir2 }), 'source_unsafe')
})

test('manifest bounds: too large, invalid JSON, non-object, over-deep, over-long id', async () => {
  const { host, deps } = await createHost()
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'big-console', JSON.stringify(oversizedManifest())) }),
    'manifest_too_large',
  )
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'badjson-console', '{not json') }),
    'manifest_invalid',
  )
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'arr-console', '[1,2,3]') }),
    'manifest_invalid',
  )
  const deep = validManifest({ id: 'spike.fixture.deep', extra: nestedObject(18) })
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'deep-console', JSON.stringify(deep), { 'Panel.qml': '// x' }) }),
    'manifest_invalid',
  )
  const longId = validManifest({ id: `spike.${'x'.repeat(130)}` })
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'longid-console', JSON.stringify(longId), { 'Panel.qml': '// x' }) }),
    'manifest_invalid',
  )
})

test('non-panel scopes are rejected: service, bar, bar-widget, overlay, menu, mixed', async () => {
  const { host, deps } = await createHost()
  const scopes = [
    ['service'], ['bar'], ['bar-widget'], ['overlay'], ['menu'],
    ['panel', 'service'], ['panel', 'menu'],
  ]
  for (const kinds of scopes) {
    const slug = kinds.join('-').replace(/[^a-z-]/g, '')
    const manifest = validManifest({ id: `spike.fixture.scope-${slug}`, kinds })
    const dir = addRawManifestSource(deps.fs, '/repo/plugins', `scope-${slug}`, JSON.stringify(manifest), { 'Panel.qml': '// x' })
    expectError(send(host, 'register', { path: dir }), 'panel_scope_required')
  }
  const extraKey = validManifest({ id: 'spike.fixture.extra-key', entryPoints: { panel: 'Panel.qml', service: 'Service.qml' } })
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'extra-key', JSON.stringify(extraKey), { 'Panel.qml': '// x', 'Service.qml': '// x' }) }),
    'panel_scope_required',
  )
  const noPanel = validManifest({ id: 'spike.fixture.no-panel', entryPoints: { overlay: 'Panel.qml' } })
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'no-panel', JSON.stringify(noPanel), { 'Panel.qml': '// x' }) }),
    'panel_scope_required',
  )
})

test('entry-point escapes fail closed: absolute, traversal, oversized, missing file', async () => {
  const { host, deps } = await createHost()
  const escapes = ['/etc/passwd', '../../escape.qml', 'sub/../../../escape.qml', `${'y'.repeat(1100)}.qml`]
  escapes.forEach((entry, index) => {
    const manifest = validManifest({ id: `spike.fixture.escape-${index}`, entryPoints: { panel: entry } })
    const dir = addRawManifestSource(deps.fs, '/repo/plugins', `escape-${index}`, JSON.stringify(manifest), {})
    expectErrorFamily(
      send(host, 'register', { path: dir }),
      ['entry_point_invalid', 'path_invalid', 'symlink_component'],
      `entry point ${entry.slice(0, 24)} must fail closed`,
    )
  })
  const ghost = validManifest({ id: 'spike.fixture.ghost', entryPoints: { panel: 'Missing.qml' } })
  expectError(
    send(host, 'register', { path: addRawManifestSource(deps.fs, '/repo/plugins', 'ghost-console', JSON.stringify(ghost), {}) }),
    'entry_point_invalid',
  )
})

test('id collisions: omarchy prefix, installed first-party and third-party, temporary id', async () => {
  const { host, deps } = await createHost()
  deps.scan.setPlugins({
    'omarchy.clock': installedManifest('omarchy.clock', '/usr/share/omarchy/shell/plugins/panels/clock'),
    'someone.existing': installedManifest('someone.existing', '/home/user/.config/omarchy/plugins/existing'),
  })

  const reserved = addRawManifestSource(deps.fs, '/repo/plugins', 'reserved', JSON.stringify(validManifest({ id: 'omarchy.evil' })), { 'Panel.qml': '// x' })
  expectError(send(host, 'register', { path: reserved }), 'plugin_id_collision')

  const firstParty = addRawManifestSource(deps.fs, '/repo/plugins', 'fp-clock', JSON.stringify(validManifest({ id: 'omarchy.clock' })), { 'Panel.qml': '// x' })
  expectError(send(host, 'register', { path: firstParty }), 'plugin_id_collision')

  const thirdParty = addRawManifestSource(deps.fs, '/repo/plugins', 'tp', JSON.stringify(validManifest({ id: 'someone.existing' })), { 'Panel.qml': '// x' })
  expectError(send(host, 'register', { path: thirdParty }), 'plugin_id_collision')

  const a = addRawManifestSource(deps.fs, '/repo/plugins', 'dup-a', JSON.stringify(validManifest({ id: 'spike.fixture.dup' })), { 'Panel.qml': '// x' })
  const first = send(host, 'register', { path: a })
  settle(deps.clock)
  send(host, 'status', { operationId: first.result.operationId })
  const b = addRawManifestSource(deps.fs, '/repo/plugins', 'dup-b', JSON.stringify(validManifest({ id: 'spike.fixture.dup' })), { 'Panel.qml': '// x' })
  expectError(send(host, 'register', { path: b }), 'plugin_id_collision')
})

test('installed source-directory collision is rejected', async () => {
  const { host, deps } = await createHost()
  const installedSource = '/home/user/.config/omarchy/plugins/installed.one'
  deps.fs.addDirectory(installedSource)
  deps.fs.addFile(`${installedSource}/manifest.json`, JSON.stringify(validManifest({ id: 'installed.one' })))
  deps.fs.addFile(`${installedSource}/Panel.qml`, '// x')
  deps.scan.setPlugins({ 'installed.one': installedManifest('installed.one', installedSource) })
  expectError(send(host, 'register', { path: installedSource }), 'source_collision')
})

test('registration while the installed scan is unresolved is retryably busy', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  deps.scan.setState('scanning')
  const parsed = send(host, 'register', { path: dir })
  expectError(parsed, 'registry_busy')
  assert.equal(parsed.error.retryable, true)
  deps.scan.setState('idle')
  assert.equal(send(host, 'register', { path: dir }).ok, true)
})

test('byte-identical duplicate request while validating is retryably duplicate_pending', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const requestJson = JSON.stringify({ version: 1, operation: 'register', path: dir })
  const first = sendRaw(host, requestJson)
  assert.equal(first.ok, true)
  const second = sendRaw(host, requestJson)
  expectError(second, 'duplicate_pending')
  assert.equal(second.error.retryable, true)
})

test('capacity: seventeenth concurrent registration is retryably exceeded', async () => {
  const { host, deps } = await createHost()
  for (let i = 0; i < 16; i += 1) {
    const id = `spike.fixture.cap${String(i).padStart(2, '0')}`
    const dir = addValidSource(deps.fs, '/repo/plugins', `cap-${String(i).padStart(2, '0')}`, validManifest({ id }))
    const parsed = send(host, 'register', { path: dir })
    assert.equal(parsed.ok, true, `slot ${i} must be accepted`)
  }
  const extraDir = addValidSource(deps.fs, '/repo/plugins', 'cap-extra', validManifest({ id: 'spike.fixture.capextra' }))
  const over = send(host, 'register', { path: extraDir })
  expectError(over, 'capacity_exceeded')
  assert.equal(over.error.retryable, true)
  settle(deps.clock)
  // All 16 are now active registrations, so capacity stays full.
  expectError(send(host, 'register', { path: extraDir }), 'capacity_exceeded')
})

test('rejections leave no partial state: zero loaders, later register works', async () => {
  const { host, deps } = await createHost()
  const bad = addRawManifestSource(deps.fs, '/repo/plugins', 'bad-console', '{ broken')
  const rejected = send(host, 'register', { path: bad })
  expectError(rejected, 'manifest_invalid')
  assert.equal(rejected.result, undefined, 'error envelopes carry no lifecycle authority')
  settle(deps.clock)
  assert.equal(deps.loader.created.length, 0, 'no loader may ever exist for a rejected source')
  // A later valid registration is unaffected.
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const good = send(host, 'register', { path: dir })
  assert.equal(good.ok, true, 'rejection must not consume capacity')
  settle(deps.clock)
  const st = send(host, 'status', { operationId: good.result.operationId })
  assert.equal(st.result.state, 'registered_hidden')
})

test('asynchronous validation failure surfaces as an inspectable rejected state', async () => {
  const { host, deps } = await createHost()
  const dir = addValidSource(deps.fs, '/repo/plugins', 'late-failure-console')
  const parsed = send(host, 'register', { path: dir })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.result.state, 'validating')
  // The source changes after acceptance but before validation completes;
  // the operation must land in the contract's 'rejected' state machine node.
  deps.fs.removeNode(`${dir}/manifest.json`)
  settle(deps.clock)
  const status = send(host, 'status', { operationId: parsed.result.operationId })
  assert.equal(status.ok, true)
  assert.equal(status.result.state, 'rejected')
  assert.ok(
    status.result.error === undefined
    || status.result.error.code === 'path_invalid'
    || status.result.error.code === 'manifest_invalid',
    'failure detail stays typed and bounded',
  )
  assert.equal(deps.loader.created.length, 0)
})

test('envelope discipline: bad JSON, non-object, bad/missing version, unknown operation', async () => {
  const { host } = await createHost()
  expectError(sendRaw(host, 'not json at all'), 'bad_json')
  expectError(sendRaw(host, '[1,2,3]'), 'bad_json')
  expectError(sendRaw(host, '"just a string"'), 'bad_json')
  const versionTwo = sendRaw(host, JSON.stringify({ version: 2, operation: 'capabilities' }))
  expectError(versionTwo, 'unsupported_version')
  const missingVersion = sendRaw(host, JSON.stringify({ operation: 'capabilities' }))
  expectErrorFamily(missingVersion, ['unsupported_version', 'invalid_field'])
  expectError(send(host, 'teleport'), 'unknown_operation')
})

test('request size bound is enforced', async () => {
  const { host } = await createHost()
  const padded = JSON.stringify({ version: 1, operation: 'register', path: '/repo/x', pad: 'y'.repeat(33000) })
  expectError(sendRaw(host, padded), 'request_too_large')
})