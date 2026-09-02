// SPIKE — test helper. Not production code.
//
// helpers.mjs — the frozen public-seam harness. Every seam test observes the
// host ONLY through `host.request(requestJson)`; the injected ports exist so
// behavior (and forbidden behavior) is observable without any real system.
//
// Frozen public surface for task 3.a:
//   lib/index.mjs exports:
//     createTemporaryPanelHost({ fs, loader, config, scan, identity, clock })
//       -> { request(requestJson: string) -> responseJson: string }
//     createScratchRegistry({ fs, now })   (see fixtures/scratch-fs.mjs)
//
// Async model: the host schedules deferred work on the injected clock port;
// tests drive it with settle()/clock.advance(). Loader resolution is driven
// by test-controlled controller.finishLoad()/failLoad().

import assert from 'node:assert/strict'
import { createFakeFsPort } from '../fixtures/fake-fs.mjs'
import { createLoaderPort } from '../fixtures/fake-loader.mjs'
import { createConfigPort } from '../fixtures/fake-config.mjs'
import { createScanPort } from '../fixtures/fake-scan.mjs'
import { createIdentityPort } from '../fixtures/fake-identity.mjs'
import { createClockPort } from '../fixtures/fake-clock.mjs'
import { addValidSource, validManifest } from '../fixtures/panel-sources.mjs'

export {
  createFakeFsPort,
  createLoaderPort,
  makeFakePanelItem,
  createConfigPort,
  createScanPort,
  createIdentityPort,
  createClockPort,
  installedManifest,
} from '../fixtures/re-exports.mjs'

export const ROOT = '/repo/plugins'

/**
 * Dynamic import so every test fails individually with ERR_MODULE_NOT_FOUND
 * during the intended red stage instead of failing the whole file at load.
 */
export async function loadHostModule() {
  return import('../lib/index.mjs')
}

/** Build a host plus its ports. Overrides replace whole ports. */
export async function createHost(overrides = {}) {
  const mod = await loadHostModule()
  const fs = overrides.fs ?? createFakeFsPort()
  const loader = overrides.loader ?? createLoaderPort()
  const config = overrides.config ?? createConfigPort()
  const scan = overrides.scan ?? createScanPort()
  const identity = overrides.identity ?? createIdentityPort({ nonce: overrides.nonce })
  const clock = overrides.clock ?? createClockPort()
  const host = mod.createTemporaryPanelHost({ fs, loader, config, scan, identity, clock })
  return { host, deps: { fs, loader, config, scan, identity, clock } }
}

/** Serialize one request object. */
export function req(operation, extra = {}) {
  return JSON.stringify({ version: 1, operation, ...extra })
}

/** Send one request and parse the envelope with shape assertions. */
export function send(host, operation, extra = {}) {
  const requestJson = req(operation, extra)
  const responseJson = host.request(requestJson)
  assert.equal(typeof responseJson, 'string', 'request must return a string envelope')
  const parsed = JSON.parse(responseJson)
  assert.equal(parsed.version, 1, 'every envelope carries version 1')
  assert.equal(typeof parsed.operation, 'string', 'every envelope echoes its operation')
  assert.equal(typeof parsed.ok, 'boolean', 'every envelope carries a boolean ok')
  return parsed
}

/** Send raw JSON text (for malformed-request cases). */
export function sendRaw(host, requestJson) {
  const responseJson = host.request(requestJson)
  assert.equal(typeof responseJson, 'string', 'request returns a string even for malformed input')
  return JSON.parse(responseJson)
}

/** Assert one typed error envelope. */
export function expectError(parsed, code) {
  assert.equal(parsed.ok, false, `expected error envelope, got ${JSON.stringify(parsed)}`)
  assert.equal(parsed.error.code, code, `expected error code ${code}`)
  assert.equal(typeof parsed.error.message, 'string')
  assert.ok(parsed.error.message.length <= 1024, 'diagnostics stay bounded at 1024 bytes')
  assert.equal(typeof parsed.error.retryable, 'boolean')
  return parsed
}

/** Accept either code of a fail-closed family. */
export function expectErrorFamily(parsed, codes, message = 'fail-closed error family') {
  assert.equal(parsed.ok, false, message)
  assert.ok(
    codes.includes(parsed.error.code),
    `expected one of [${codes.join(', ')}], got ${parsed.error.code}`,
  )
  assert.ok(parsed.error.message.length <= 1024)
  return parsed
}

/** Run every deferred callback the host scheduled, including chained ones. */
export function settle(clock, iterations = 64) {
  for (let i = 0; i < iterations && clock.pendingCount() > 0; i += 1) {
    clock.advance(0)
  }
}

/** Advance well past the five-minute tombstone retention. */
export function settlePastTombstones(clock) {
  settle(clock)
  clock.advance(5 * 60 * 1000 + 1)
  settle(clock)
}

/**
 * Register one valid source and drive validation to a ready registration.
 * Returns the opaque registration identity.
 */
export function registerReadyPanel(host, deps, {
  root = ROOT,
  name = 'fixture-console',
  manifest = validManifest(),
} = {}) {
  const { clock, fs } = deps
  const dir = addValidSource(fs, root, name, manifest)
  const registered = send(host, 'register', { path: dir })
  assert.equal(registered.ok, true, `fixture register failed: ${JSON.stringify(registered)}`)
  settle(clock)
  const status = send(host, 'status', { operationId: registered.result.operationId })
  assert.equal(status.ok, true, `fixture status failed: ${JSON.stringify(status)}`)
  assert.equal(status.result.state, 'registered_hidden')
  return { registrationId: status.result.registrationId, pluginId: status.result.pluginId, dir }
}

/** Poll status until the operation leaves 'validating' (or maxWait hits). */
export function awaitStatus(host, clock, operationId) {
  settle(clock)
  return send(host, 'status', { operationId })
}