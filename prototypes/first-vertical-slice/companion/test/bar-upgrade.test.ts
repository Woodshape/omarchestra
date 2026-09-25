import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeOmarchy } from '../fake-omarchy.ts'
import { CompanionInstallation } from '../installation.ts'
import { COMPANION_PLUGIN_ID } from '../contracts.ts'

function release(version: string, bar: boolean) {
  const manifest = { schemaVersion: 1, id: COMPANION_PLUGIN_ID, name: 'Workbench', version,
    author: 'Omarchestra', license: 'MIT', description: 'Panel and bar widget',
    kinds: bar ? ['panel', 'bar-widget'] : ['panel'], activation: 'on-demand',
    entryPoints: bar ? { panel: 'AgentConsole.qml', barWidget: 'WorkbenchBarWidget.qml' } : { panel: 'AgentConsole.qml' },
    ...(bar ? { barWidget: { defaultSection: 'right' } } : {}) }
  return { pluginId: COMPANION_PLUGIN_ID, version, protocol: 'omarchestra.companion/v1',
    compatibility: { omarchy: '4.0.3-1', quickshell: '0.3.1-1' },
    assets: { 'manifest.json': JSON.stringify(manifest), 'AgentConsole.qml': 'import QtQuick\nItem {}\n',
      ...(bar ? { 'WorkbenchBarWidget.qml': 'import QtQuick\nItem {}\n' } : {}) } }
}
const panel = release('0.8.0', false), mixed = release('0.9.0', true)
async function run(fake: FakeOmarchy, operation: 'install'|'update'|'rollback'|'uninstall', source?: ReturnType<typeof release>) {
  const installer = new CompanionInstallation(fake.ports())
  const plan = await installer.inspect({ operation, release: source })
  return installer.execute(plan, fake.authorization.grant(plan))
}
function barIds(fake: FakeOmarchy): string[] {
  const config = JSON.parse(fake.configuration.shellJsonBytes())
  return Object.values(config.bar?.layout ?? {}).flat().map((entry: any) => entry.id)
}

test('panel to bar+panel uses one owned bar entry; rollback and uninstall preserve exact shell preimage', async () => {
  const fake = new FakeOmarchy()
  const original = fake.configuration.shellJsonBytes()
  await run(fake, 'install', panel)
  const panelBytes = fake.configuration.shellJsonBytes()
  await run(fake, 'update', mixed)
  assert.equal(barIds(fake).filter(id => id === COMPANION_PLUGIN_ID).length, 1)
  assert.equal(fake.configuration.enabledPluginCount(COMPANION_PLUGIN_ID), 1)
  const afterBar = fake.configuration.shellJsonBytes()
  await run(fake, 'rollback', panel)
  assert.equal(fake.configuration.shellJsonBytes(), panelBytes)
  await run(fake, 'update', mixed)
  assert.equal(fake.configuration.shellJsonBytes(), afterBar)
  await run(fake, 'uninstall')
  assert.equal(fake.configuration.shellJsonBytes(), original)
})

test('same-ID bar-to-bar update and rollback preserve placement, exact previous assets and original uninstall preimage', async () => {
  const fake = new FakeOmarchy()
  const original = fake.configuration.shellJsonBytes()
  await run(fake, 'install', panel)
  await run(fake, 'update', mixed)
  const previous = fake.fingerprint()
  const next = release('0.10.0', true)
  next.assets['WorkbenchBarWidget.qml'] = 'import QtQuick\nItem { objectName: "inline-review" }\n'
  await run(fake, 'update', next)
  assert.deepEqual(barIds(fake).filter(id => id === COMPANION_PLUGIN_ID), [COMPANION_PLUGIN_ID])
  await run(fake, 'rollback', mixed)
  assert.deepEqual(fake.fingerprint().configuration, previous.configuration)
  const pluginAssets = (entries: typeof previous.filesystem) => entries.filter(entry => entry.path.includes('/plugins/omarchestra.agent-console'))
  assert.deepEqual(pluginAssets(fake.fingerprint().filesystem), pluginAssets(previous.filesystem))
  assert.equal(JSON.parse(fake.receipts.inspectNoFollow(COMPANION_PLUGIN_ID)!.bytes).release.version, '0.9.0')
  await run(fake, 'update', next)
  await run(fake, 'uninstall')
  assert.equal(fake.configuration.shellJsonBytes(), original)
})

for (const point of ['after-plugin-assets', 'after-shell-enable']) {
  test(`fault at ${point} restores the prior exact panel entry, assets and receipt`, async () => {
    const fake = new FakeOmarchy()
    await run(fake, 'install', panel)
    const before = fake.fingerprint()
    fake.failAt(point)
    await assert.rejects(run(fake, 'update', mixed))
    assert.deepEqual(fake.fingerprint(), before)
    assert.deepEqual(barIds(fake), [])
  })
}

test('foreign and duplicated bar ownership blocks update or uninstall before mutation', async () => {
  const fake = new FakeOmarchy()
  await run(fake, 'install', panel)
  const old = fake.configuration.shellJsonBytes()
  const duplicate = JSON.parse(old)
  duplicate.bar = { layout: { right: [{ id: COMPANION_PLUGIN_ID }] } }
  fake.configuration.setShellJsonBytes(JSON.stringify(duplicate))
  const before = fake.fingerprint()
  await assert.rejects(run(fake, 'update', mixed))
  assert.deepEqual(fake.fingerprint(), before)
  fake.configuration.setShellJsonBytes(old)
  await run(fake, 'update', mixed)
  const newBytes = fake.configuration.shellJsonBytes()
  const config = JSON.parse(newBytes)
  config.bar.layout.right.push({ id: COMPANION_PLUGIN_ID })
  fake.configuration.setShellJsonBytes(JSON.stringify(config))
  const drift = fake.fingerprint()
  await assert.rejects(run(fake, 'uninstall'))
  assert.deepEqual(fake.fingerprint(), drift)
})
