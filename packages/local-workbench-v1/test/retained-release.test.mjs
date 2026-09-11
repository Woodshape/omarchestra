// Local Workbench v1 — retained historical release evidence.
//
// The active production catalogue is built from the mutable plugin source.
// This test proves the pre-redesign 0.6.0 assets (including the manual
// installation forwarder) are retained byte-for-byte outside that catalogue,
// so the redesign cannot silently mutate the bytes it claims to preserve.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const RETAINED_DIR = join(PACKAGE_ROOT, 'companion', 'retained', '0.6.0')

const ASSET_FILES = [
  'manifest.json',
  'WorkbenchConsole.qml',
  'WorkbenchHost.qml',
  'WorkbenchOverview.qml',
  'WorkbenchDetail.qml',
  'WorkbenchCards.qml',
  'WorkbenchForms.qml',
  'WorkbenchBoard.qml',
  'AgentConsole.qml',
]

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

test('the retained 0.6.0 assets exist and match their recorded digests', () => {
  const manifest = JSON.parse(readFileSync(join(RETAINED_DIR, 'digests.json'), 'utf8'))
  assert.equal(manifest.version, '0.6.0')
  assert.equal(manifest.algorithm, 'sha256')
  assert.equal(manifest.pluginId, 'omarchestra.agent-console')
  assert.ok(manifest.capturedAtHead, 'retention records the baseline HEAD')
  for (const name of ASSET_FILES) {
    const path = join(RETAINED_DIR, name)
    assert.ok(statSync(path).isFile(), `retained asset missing: ${name}`)
    assert.equal(sha256(readFileSync(path, 'utf8')), manifest.assets[name], `retained ${name} changed since capture`)
  }
})

test('the retained 0.6.0 release reproduces the baseline assets exactly', async () => {
  const { RETAINED_WORKBENCH_RELEASES } = await import('../companion/retained-releases.ts')
  const record = RETAINED_WORKBENCH_RELEASES['0.6.0']
  assert.ok(record, 'retained 0.6.0 record present')
  assert.equal(record.release.version, '0.6.0')
  assert.equal(record.release.pluginId, 'omarchestra.agent-console')
  assert.equal(record.release.protocol, 'omarchestra.companion/v1')
  assert.deepEqual(record.release.compatibility, { omarchy: '4.0.3-1', quickshell: '0.3.1-1' })
  for (const name of ASSET_FILES.filter((file) => file !== 'AgentConsole.qml')) {
    assert.equal(record.release.assets[name], readFileSync(join(RETAINED_DIR, name), 'utf8'), `${name} retained release differs from retained file`)
  }
  assert.equal(record.release.assets['AgentConsole.qml'], undefined, 'the forwarder belongs to the preview release only')
  assert.equal(JSON.parse(record.release.assets['manifest.json']).entryPoints.panel, 'WorkbenchHost.qml')
})

test('the retained 0.6.0 preview release carries the manual installation forwarder', async () => {
  const { RETAINED_WORKBENCH_RELEASES } = await import('../companion/retained-releases.ts')
  const preview = RETAINED_WORKBENCH_RELEASES['0.6.0'].previewRelease
  assert.equal(preview.assets['AgentConsole.qml'], readFileSync(join(RETAINED_DIR, 'AgentConsole.qml'), 'utf8'))
  assert.equal(JSON.parse(preview.assets['manifest.json']).entryPoints.panel, 'AgentConsole.qml')
  assert.equal(preview.version, '0.6.0')
})

test('retained releases stay outside the active production catalogue', () => {
  const releasesSource = readFileSync(join(PACKAGE_ROOT, 'companion', 'releases.ts'), 'utf8')
  assert.doesNotMatch(releasesSource, /retained-releases/, 'the active catalogue must not be built from retained bytes')
  const retainedSource = readFileSync(join(PACKAGE_ROOT, 'companion', 'retained-releases.ts'), 'utf8')
  assert.doesNotMatch(retainedSource, /console['"]\s*,\s*['"]plugin['"]/, 'retained bytes must not be re-read from the mutable plugin source')
})
