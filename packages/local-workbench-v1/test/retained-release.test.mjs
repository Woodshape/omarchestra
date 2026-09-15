// Local Workbench v1 — retained historical release evidence.
//
// The active production catalogue is built from the mutable plugin source.
// This test proves the accepted pre-redesign 0.6.0 assets and the accepted
// task-first 0.7.0 assets (including the manual installation forwarder) are
// retained byte-for-byte outside that catalogue, so a later redesign cannot
// silently mutate the bytes it claims to preserve.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const RETAINED_ROOT = join(PACKAGE_ROOT, 'companion', 'retained')

/** Every retained version that must stay byte-reproducible. */
const RETAINED_VERSIONS = ['0.6.0', '0.7.0']
const FORWARDER = 'AgentConsole.qml'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function digestsOf(version) {
  return JSON.parse(readFileSync(join(RETAINED_ROOT, version, 'digests.json'), 'utf8'))
}

for (const version of RETAINED_VERSIONS) {
  const dir = join(RETAINED_ROOT, version)
  const manifest = digestsOf(version)
  const assetFiles = Object.keys(manifest.assets)

  test(`the retained ${version} assets exist and match their recorded digests`, () => {
    assert.equal(manifest.version, version)
    assert.equal(manifest.algorithm, 'sha256')
    assert.equal(manifest.pluginId, 'omarchestra.agent-console')
    assert.ok(manifest.capturedAtHead, 'retention records the baseline HEAD')
    assert.ok(assetFiles.length > 0, 'a retained release records its assets')
    for (const name of assetFiles) {
      const path = join(dir, name)
      assert.ok(statSync(path).isFile(), `retained asset missing: ${version}/${name}`)
      assert.equal(sha256(readFileSync(path, 'utf8')), manifest.assets[name], `retained ${version}/${name} changed since capture`)
    }
  })

  test(`the retained ${version} release reproduces the baseline assets exactly`, async () => {
    const { RETAINED_WORKBENCH_RELEASES } = await import('../companion/retained-releases.ts')
    const record = RETAINED_WORKBENCH_RELEASES[version]
    assert.ok(record, `retained ${version} record present`)
    assert.equal(record.release.version, version)
    assert.equal(record.release.pluginId, 'omarchestra.agent-console')
    assert.equal(record.release.protocol, 'omarchestra.companion/v1')
    assert.deepEqual(record.release.compatibility, { omarchy: '4.0.3-1', quickshell: '0.3.1-1' })
    for (const name of assetFiles.filter((file) => file !== FORWARDER)) {
      assert.equal(record.release.assets[name], readFileSync(join(dir, name), 'utf8'), `${version}/${name} retained release differs from retained file`)
    }
    assert.equal(record.release.assets[FORWARDER], undefined, 'the forwarder belongs to the preview release only')
    assert.equal(JSON.parse(record.release.assets['manifest.json']).entryPoints.panel, 'WorkbenchHost.qml')
  })

  test(`the retained ${version} preview release carries the manual installation forwarder`, async () => {
    const { RETAINED_WORKBENCH_RELEASES } = await import('../companion/retained-releases.ts')
    const preview = RETAINED_WORKBENCH_RELEASES[version].previewRelease
    assert.equal(preview.assets[FORWARDER], readFileSync(join(dir, FORWARDER), 'utf8'))
    assert.equal(JSON.parse(preview.assets['manifest.json']).entryPoints.panel, FORWARDER)
    assert.equal(preview.version, version)
  })
}

for (const version of RETAINED_VERSIONS) {
  const manifest = digestsOf(version)
  test(`the retained ${version} digests cover every retained file`, () => {
    const recorded = new Set(Object.keys(manifest.assets))
    assert.ok(recorded.has(FORWARDER), 'the installer forwarder is retained with its digest')
    assert.ok(recorded.has('manifest.json'), 'the retained manifest is retained with its digest')
  })
}

test('retained releases stay outside the active production catalogue', () => {
  const releasesSource = readFileSync(join(PACKAGE_ROOT, 'companion', 'releases.ts'), 'utf8')
  assert.doesNotMatch(releasesSource, /retained-releases/, 'the active catalogue must not be built from retained bytes')
  const retainedSource = readFileSync(join(PACKAGE_ROOT, 'companion', 'retained-releases.ts'), 'utf8')
  assert.doesNotMatch(retainedSource, /console['"]\s*,\s*['"]plugin['"]/, 'retained bytes must not be re-read from the mutable plugin source')
})
