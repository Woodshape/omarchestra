// SPIKE — Seam 7: failure-cleanup seam (red stage).
//
// Forced failures and interruptions remove only the exact registered scratch
// resources; unrelated fake resources survive; refused resources stay pending
// and retryable; `clean` stays false until nothing is left.
//
// The registry under test is createScratchRegistry from lib/index.mjs (reused
// by the patch verifier for its own scratch state).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createHost,
  loadHostModule,
  send,
} from './helpers.mjs'
import {
  createScratchFsPort, createRealScratchFs, withRealTempDir,
} from '../fixtures/scratch-fs.mjs'

async function loadRegistry() {
  const mod = await loadHostModule()
  assert.equal(typeof mod.createScratchRegistry, 'function', 'lib/index.mjs must export createScratchRegistry')
  return mod.createScratchRegistry
}

test('forced failure removes exactly the registered scratch directories', async () => {
  const createScratchRegistry = await loadRegistry()
  const fakeFs = createScratchFsPort()
  fakeFs.addNode('/tmp/scratch-a')
  fakeFs.addNode('/tmp/scratch-b')
  fakeFs.addNode('/tmp/unrelated-fake')
  const registry = createScratchRegistry({ fs: fakeFs, now: () => 0 })
  registry.registerDirectory('/tmp/scratch-a')
  registry.registerDirectory('/tmp/scratch-b')

  // Forced failure path: cleanup removes exactly what was registered.
  registry.failNow()
  const report = registry.cleanup()
  assert.deepEqual(report.removed.sort(), ['/tmp/scratch-a', '/tmp/scratch-b'])
  assert.equal(report.refused.length, 0)
  assert.equal(report.clean, true)
  assert.deepEqual(fakeFs.removed.sort(), ['/tmp/scratch-a', '/tmp/scratch-b'])
})

test('unrelated resources survive exact cleanup', async () => {
  const createScratchRegistry = await loadRegistry()
  const fakeFs = createScratchFsPort()
  fakeFs.addNode('/tmp/scratch-owned')
  fakeFs.addNode('/tmp/scratch-unrelated')
  fakeFs.addNode('/tmp/other-owner')
  const registry = createScratchRegistry({ fs: fakeFs, now: () => 0 })
  registry.registerDirectory('/tmp/scratch-owned')
  registry.failNow()
  const report = registry.cleanup()
  assert.deepEqual(report.removed, ['/tmp/scratch-owned'])
  assert.equal(fakeFs.nodes.has('/tmp/scratch-unrelated'), true, 'unrelated resource survives')
  assert.equal(fakeFs.nodes.has('/tmp/other-owner'), true, 'foreign resource survives')
  assert.equal(report.clean, true)
})

test('symlinked scratch paths are refused, stay pending, and are retryable', async () => {
  const createScratchRegistry = await loadRegistry()
  const fakeFs = createScratchFsPort()
  fakeFs.addNode('/tmp/real-target')
  fakeFs.addSymlink('/tmp/scratch-link', '/tmp/real-target')
  fakeFs.addNode('/tmp/scratch-direct')
  const registry = createScratchRegistry({ fs: fakeFs, now: () => 0 })
  const refusedRef = registry.registerDirectory('/tmp/scratch-link')
  assert.equal(refusedRef.ok, false, 'a symlink component refuses registration')
  registry.registerDirectory('/tmp/scratch-direct')
  registry.failNow()
  const first = registry.cleanup()
  assert.deepEqual(first.removed, ['/tmp/scratch-direct'])
  assert.equal(first.clean, false, 'refused registrations keep clean false')
  assert.equal(first.refused.length, 1)
  assert.equal(fakeFs.nodes.has('/tmp/real-target'), true, 'the symlink target is never destroyed')

  // A different resource appearing at the refused path was never registered
  // and must survive. Cleanup can complete only after that path disappears.
  fakeFs.nodes.delete('/tmp/scratch-link')
  fakeFs.addNode('/tmp/scratch-link')
  const replacement = registry.cleanup()
  assert.equal(replacement.clean, false)
  assert.equal(fakeFs.nodes.has('/tmp/scratch-link'), true, 'an unrelated replacement is retained')
  assert.deepEqual(fakeFs.removed, ['/tmp/scratch-direct'])
  fakeFs.nodes.delete('/tmp/scratch-link')
  const second = registry.cleanup()
  assert.equal(second.clean, true, 'exact retry completes only after the refused path is absent')
})

test('registered scratch cleanup refuses changed type and new symlink ancestors', async () => {
  const createScratchRegistry = await loadRegistry()
  const fakeFs = createScratchFsPort()
  fakeFs.addNode('/tmp/scratch-owned')
  const registry = createScratchRegistry({ fs: fakeFs, now: () => 0 })
  assert.equal(registry.registerDirectory('/tmp/scratch-owned').ok, true)

  const original = fakeFs.nodes.get('/tmp/scratch-owned')
  fakeFs.addSymlink('/tmp', '/foreign')
  fakeFs.nodes.set('/tmp/scratch-owned', original)
  const symlinked = registry.cleanup()
  assert.equal(symlinked.clean, false)
  assert.equal(symlinked.refused[0].reason, 'symlink_component')
  assert.equal(fakeFs.nodes.has('/tmp/scratch-owned'), true)

  fakeFs.nodes.delete('/tmp')
  fakeFs.nodes.set('/tmp/scratch-owned', { ...original, kind: 'file' })
  const changedType = registry.cleanup()
  assert.equal(changedType.clean, false)
  assert.equal(changedType.refused[0].reason, 'not_directory')
  assert.equal(fakeFs.nodes.has('/tmp/scratch-owned'), true)
})

test('the real-fs cleanup registry removes only its exact directory (bounded, foreground)', async () => {
  const createScratchRegistry = await loadRegistry()
  const realFs = createRealScratchFs()
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-spike-s7-owned-'), { mode: 0o700 })
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-spike-s7-sib-'), { mode: 0o700 })
  try {
    const registry = createScratchRegistry({ fs: realFs, now: () => 0 })
    const registered = registry.registerDirectory(owned)
    assert.equal(registered.ok, true)
    registry.failNow()
    const report = registry.cleanup()
    assert.deepEqual(report.removed, [owned])
    assert.equal(report.clean, true)
    assert.equal(fs.existsSync(owned), false, 'the exact owned directory is gone')
    assert.equal(fs.existsSync(sibling), true, 'the sibling survives')
  } finally {
    for (const dir of [owned, sibling]) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* bounded */ }
    }
  }
})

test('scratch cleanup composes with host failure paths without touching hosts', async () => {
  const createScratchRegistry = await loadRegistry()
  const { host, deps } = await createHost()
  const fakeFs = createScratchFsPort()
  fakeFs.addNode('/tmp/scratch-owned')
  const registry = createScratchRegistry({ fs: fakeFs, now: () => 0 })
  registry.registerDirectory('/tmp/scratch-owned')
  registry.failNow()
  const report = registry.cleanup()
  assert.equal(report.clean, true)
  // The host session is unaffected by scratch cleanup.
  const capabilities = send(host, 'capabilities')
  assert.equal(capabilities.ok, true)
  assert.equal(deps.config.calls.length, 0)
  void createScratchRegistry
})