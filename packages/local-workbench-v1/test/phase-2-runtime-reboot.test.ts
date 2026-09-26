import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { captureOwnedPaths, durableOwnedPaths, ownedPathIdentity, runtimeOwnedPaths } from '../runner/owned-resources.ts'
import { applyRuntimeMigration, inspectRuntimeMigration } from '../runner/runtime-migration.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-runtime-reboot-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime'), evidenceDir = join(root, 'evidence')
  mkdirSync(evidenceDir, { mode: 0o700 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = { stateDir, runtimeDir }
  const runner = openWorkbenchRunner({ roots: input })
  return { root, input, runner, evidenceDir }
}
function rebootRuntime(root: string, runtimeDir: string) {
  renameSync(runtimeDir, join(root, `previous-runtime-${Date.now()}-${Math.random()}`))
  mkdirSync(runtimeDir, { mode: 0o700 })
}
function legacyReceipt(runner: ReturnType<typeof openWorkbenchRunner>): string {
  const file = join(runner.roots.stateDir, 'ownership.json')
  const durable = durableOwnedPaths(runner.roots)
  const names = [...new Set([...durable, ...runtimeOwnedPaths(runner.roots)])].sort()
  const resources = captureOwnedPaths(names)
  const currentDev = resources[durable[0]].dev
  const legacyDev = currentDev === '999999' ? '999998' : '999999'
  for (const path of durable) resources[path].dev = legacyDev
  const bytes = JSON.stringify({ version: 1, resources }) + '\n'
  writeFileSync(file, bytes)
  return bytes
}
function v2Receipt(runner: ReturnType<typeof openWorkbenchRunner>): string {
  const file = join(runner.roots.stateDir, 'ownership.json')
  const paths = durableOwnedPaths(runner.roots)
  const resources = captureOwnedPaths(paths)
  const recordedDev = Object.values(resources)[0].dev === '999999' ? '999998' : '999999'
  // Simulate the same persistent inodes being reported by a different Linux
  // dev_t after reboot. Device number is the only changed legacy field.
  for (const identity of Object.values(resources)) identity.dev = recordedDev
  const bytes = JSON.stringify({ version: 2, resources, runtimePath: runner.roots.runtimeDir }) + '\n'
  writeFileSync(file, bytes)
  return bytes
}

test('new receipt retains one exact state across recreated private runtime dirs without pinning boot inodes', t => {
  const { root, input, runner } = fixture(t)
  const nodeId = runner.nodeId, epoch = runner.epoch
  runner.store.setMeta('retained-fact', 'still-here')
  runner.close()
  rebootRuntime(root, input.runtimeDir)
  const reopened = openWorkbenchRunner({ roots: input })
  try {
    assert.equal(reopened.nodeId, nodeId)
    assert.equal(reopened.epoch, epoch + 1)
    assert.equal(reopened.store.getMeta('retained-fact'), 'still-here')
    const receipt = JSON.parse(readFileSync(join(input.stateDir, 'ownership.json'), 'utf8'))
    assert.equal(receipt.version, 3)
    assert.equal(receipt.runtimePath, input.runtimeDir)
    assert.ok(!Object.keys(receipt.resources).includes(input.runtimeDir))
    assert.equal(JSON.stringify(receipt.resources).includes('"dev"'), false)
    assert.equal(Object.hasOwn(ownedPathIdentity(join(input.stateDir, 'ownership.json')), 'dev'), false)
  } finally { reopened.close() }
})

test('runtime replacement during one owner lifetime revokes all durable access', t => {
  const { root, input, runner } = fixture(t)
  rebootRuntime(root, input.runtimeDir)
  try { assert.throws(() => runner.store.listProjects(), /identity_drift|runtime directory or parent identity changed|mount identity changed/) }
  finally { runner.close() }
})

test('legacy receipt cannot start after reboot; exact lock-held migration preserves bytes and durable history', t => {
  const { root, input, runner, evidenceDir } = fixture(t)
  runner.store.setMeta('retained-fact', 'unchanged')
  const previous = legacyReceipt(runner)
  runner.close()
  rebootRuntime(root, input.runtimeDir)
  assert.throws(() => openWorkbenchRunner({ roots: input }), /legacy.*ownership receipt/)
  const plan = inspectRuntimeMigration(input)
  assert.ok(plan.driftedEphemeralPaths.includes(input.runtimeDir))
  assert.ok(plan.legacyDeviceDriftPaths.length > 0)
  const result = applyRuntimeMigration(input, plan, evidenceDir)
  assert.equal(readFileSync(result.backup, 'utf8'), previous)
  assert.equal(JSON.parse(readFileSync(join(input.stateDir, 'ownership.json'), 'utf8')).version, 3)
  const reopened = openWorkbenchRunner({ roots: input })
  try { assert.equal(reopened.store.getMeta('retained-fact'), 'unchanged') } finally { reopened.close() }
  rebootRuntime(root, input.runtimeDir)
  const afterAnotherReboot = openWorkbenchRunner({ roots: input })
  afterAnotherReboot.close()
})

test('migration inspection refuses a missing state root without creating it', t => {
  const { input, runner } = fixture(t)
  runner.close()
  rmSync(input.stateDir, { recursive: true })
  assert.throws(() => inspectRuntimeMigration(input), /state root is missing/)
  assert.equal(existsSync(input.stateDir), false)
})

test('legacy device-number drift is migration-only metadata and is never carried into v3', t => {
  const { input, runner, evidenceDir } = fixture(t)
  runner.store.setMeta('retained-fact', 'same durable history')
  const nodeId = runner.nodeId
  const previous = v2Receipt(runner)
  runner.close()

  const plan = inspectRuntimeMigration(input)
  assert.equal(plan.receiptVersion, 2)
  assert.deepEqual(plan.driftedEphemeralPaths, [])
  assert.ok(plan.legacyDeviceDriftPaths.length > 0)
  assert.ok(plan.legacyDeviceDriftPaths.every(path => Object.hasOwn(plan.nextResources[path], 'dev') === false))
  assert.equal(JSON.stringify(plan).includes('recordedDev'), false)
  assert.equal(JSON.stringify(plan).includes('currentDev'), false)
  const result = applyRuntimeMigration(input, plan, evidenceDir)
  assert.equal(readFileSync(result.backup, 'utf8'), previous)
  const receipt = JSON.parse(readFileSync(join(input.stateDir, 'ownership.json'), 'utf8'))
  assert.equal(receipt.version, 3)
  assert.deepEqual(receipt.resources, plan.nextResources)
  assert.equal(JSON.stringify(receipt.resources).includes('"dev"'), false)

  const reopened = openWorkbenchRunner({ roots: input })
  try {
    assert.equal(reopened.nodeId, nodeId)
    assert.equal(reopened.store.getMeta('retained-fact'), 'same durable history')
  } finally { reopened.close() }
})

test('v3 receipt rejects the same inode when its stable mount tuple changes', t => {
  const { input, runner } = fixture(t)
  runner.close()
  const path = join(input.stateDir, 'ownership.json')
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  const resourcePath = Object.keys(receipt.resources).find(resource => resource !== '/')!
  receipt.resources[resourcePath].mountRoot = '/@unrelated-snapshot'
  writeFileSync(path, JSON.stringify(receipt) + '\n')
  assert.throws(() => openWorkbenchRunner({ roots: input }), /owned durable filesystem or inode identity changed/)
})

test('migration refuses a substituted durable lock before touching even an evidence backup', t => {
  const { root, input, runner, evidenceDir } = fixture(t)
  legacyReceipt(runner)
  runner.close()
  rebootRuntime(root, input.runtimeDir)
  const plan = inspectRuntimeMigration(input)
  const file = join(input.stateDir, 'owner.sqlite')
  copyFileSync(file, file + '.replacement')
  renameSync(file + '.replacement', file)
  assert.throws(() => applyRuntimeMigration(input, plan, evidenceDir), /durable owned resource changed/)
  assert.deepEqual(requireFiles(evidenceDir), [])
  assert.equal(JSON.parse(readFileSync(join(input.stateDir, 'ownership.json'), 'utf8')).version, 1)
})

test('migration refuses nonempty runtime roots, stale plans and concurrent owners without cleanup', t => {
  const { root, input, runner, evidenceDir } = fixture(t)
  legacyReceipt(runner)
  assert.throws(() => applyRuntimeMigration(input, inspectRuntimeMigration(input), evidenceDir), /another workbench runner owns/)
  runner.close()
  rebootRuntime(root, input.runtimeDir)
  const plan = inspectRuntimeMigration(input)
  writeFileSync(join(input.runtimeDir, 'foreign.sock'), 'foreign')
  assert.throws(() => inspectRuntimeMigration(input), /not empty/)
  assert.deepEqual(requireFiles(input.runtimeDir), ['foreign.sock'])
  rmSync(join(input.runtimeDir, 'foreign.sock'))
  assert.throws(() => applyRuntimeMigration(input, { ...plan, digest: 'wrong' }, evidenceDir), /stale migration plan/)
  assert.deepEqual(requireFiles(evidenceDir), [])
})

test('interrupted migration preserves exact v1 receipt and the private evidence/stage for manual recovery', t => {
  const { root, input, runner, evidenceDir } = fixture(t)
  const before = legacyReceipt(runner)
  runner.close()
  rebootRuntime(root, input.runtimeDir)
  const plan = inspectRuntimeMigration(input)
  assert.throws(() => applyRuntimeMigration(input, plan, evidenceDir, { afterStage() { throw Error('injected interruption') } }), /injected interruption/)
  assert.equal(readFileSync(join(input.stateDir, 'ownership.json'), 'utf8'), before)
  assert.deepEqual(requireFiles(input.stateDir).filter(name => name.endsWith('.v3-new')), ['ownership.json.v3-new'])
  assert.equal(requireFiles(evidenceDir).length, 1)
  assert.throws(() => applyRuntimeMigration(input, plan, evidenceDir), /not a workbench resource|already exists/)
})

function requireFiles(path: string): string[] {
  return readdirSync(path).sort()
}
