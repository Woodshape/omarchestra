// SPIKE — Seam 1: capability seam (red stage).
//
// A versioned read-only query reports support and interface version without
// registry or config mutation. Contract: contracts/temporary-panel-v1.md,
// "Capability discovery" + limits block.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHost, send, settle } from './helpers.mjs'
import { addValidSource } from '../fixtures/panel-sources.mjs'

const LIMIT_KEYS = [
  'requestBytes', 'pathBytes', 'manifestBytes', 'entryPointBytes',
  'payloadBytes', 'methodBytes', 'registrations',
  'queuedCallsPerRegistration', 'queuedBytesPerRegistration',
]

test('capabilities reports the exact versioned contract', async () => {
  const { host } = await createHost()
  const parsed = send(host, 'capabilities')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.operation, 'capabilities')
  const result = parsed.result
  assert.equal(result.interface, 'omarchy.temporary-panel/v1')
  assert.equal(result.supported, true)
  assert.deepEqual(result.scope, ['panel'])
  assert.equal(result.registration, 'asynchronous')
  assert.equal(result.persistence, 'process-memory-only')
  assert.equal(result.restart, 'registrations-cleared')
  for (const key of LIMIT_KEYS) {
    assert.equal(typeof result.limits[key], 'number', `limits.${key} must be present`)
  }
})

test('capabilities is non-mutating: no config writes, no fs writes, no loaders', async () => {
  const { host, deps } = await createHost()
  for (let i = 0; i < 5; i += 1) send(host, 'capabilities')
  settle(deps.clock)
  assert.equal(deps.config.calls.length, 0, 'config mutator/writer must never be called')
  assert.equal(deps.fs.writes.length, 0, 'filesystem port must observe zero writes')
  assert.equal(deps.loader.created.length, 0, 'capability must not create loaders')
})

test('capabilities does not consume registration capacity', async () => {
  const { host, deps } = await createHost()
  send(host, 'capabilities')
  settle(deps.clock)
  // After any number of capability queries, a full-capacity registration
  // session must still be possible (proven via seam 2's capacity test and
  // here with at least one success).
  const dir = addValidSource(deps.fs, '/repo/plugins', 'fixture-console')
  const parsed = send(host, 'register', { path: dir })
  assert.equal(parsed.ok, true, 'capabilities must not consume registration capacity')
})