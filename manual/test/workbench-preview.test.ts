import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createPreviewController, DEFAULT_PREVIEW_FIXTURE, PREVIEW_STATES } from '../workbench-preview-controller.ts'
import { WORKBENCH_PREVIEW_RELEASE } from '../workbench-preview-release.ts'
import { LiveCompanionHost, LiveCompanionConfiguration, LiveCompanionFilesystem } from '../../prototypes/first-vertical-slice/manual/live-companion-omarchy.ts'
import { freezeCompanionRelease } from '../../prototypes/first-vertical-slice/companion/contracts.ts'
import {
  WORKBENCH_PLUGIN_ID,
  WORKBENCH_PLUGIN_VERSION,
  WORKBENCH_PRESENTATION_CONTRACT,
  WORKBENCH_PRESENTATION_DESTINATIONS,
  WORKBENCH_PROTOCOL_ID,
} from '../../packages/local-workbench-v1/companion/contracts.ts'

test('real atomic asset replacement allocates a new inode even when restoring identical bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-atomic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filesystem = new LiveCompanionFilesystem()
  const file = join(dir, 'AgentConsole.qml')
  filesystem.writeBytesAtomic(file, 'original', 'owner', 0o644)
  const original = filesystem.inspectNoFollow(file)
  filesystem.writeBytesAtomic(file, 'updated', 'owner', 0o644)
  filesystem.writeBytesAtomic(file, 'original', 'owner', 0o644)
  const restored = filesystem.inspectNoFollow(file)
  assert.equal(filesystem.readBytesNoFollow(file), 'original')
  assert.notEqual(restored.inode, original.inode, 'rewriting old bytes cannot repair an old receipt identity')
})

test('live shell.json adapter recognizes one exact owned bar entry and refuses duplicates/settings', t => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-config-bar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'shell.json'), pluginRoot = join(root, 'plugin')
  const adapter = new LiveCompanionConfiguration(path, pluginRoot)
  const config = { bar: { layout: { left: [], center: [], right: [{ id: WORKBENCH_PLUGIN_ID }] } }, plugins: [] as Array<{ id: string }> }
  writeFileSync(path, JSON.stringify(config))
  assert.deepEqual(adapter.inspect().entries, [{ pluginId: WORKBENCH_PLUGIN_ID, source: pluginRoot, enabled: true }])
  config.plugins.push({ id: WORKBENCH_PLUGIN_ID })
  writeFileSync(path, JSON.stringify(config))
  assert.equal(adapter.inspect().entries.filter(entry => entry.pluginId === WORKBENCH_PLUGIN_ID).length, 2)
  config.plugins = []
  config.bar.layout.right[0] = { id: WORKBENCH_PLUGIN_ID, unexpected: true } as any
  writeFileSync(path, JSON.stringify(config))
  assert.throws(() => adapter.inspect(), /unexpected settings/)
})

test('native preview release passes installer validation without a package-version pin', () => {
  assert.equal(freezeCompanionRelease(WORKBENCH_PREVIEW_RELEASE).version, WORKBENCH_PLUGIN_VERSION)
  assert.equal(WORKBENCH_PREVIEW_RELEASE.compatibility, null)
})

for (const previous of ['0.11.0', '0.12.0']) test(`exact installed ${previous} assets upgrade to ${WORKBENCH_PLUGIN_VERSION} and roll back without touching other bar widgets`, async () => {
  const { CompanionInstallation } = await import('../../prototypes/first-vertical-slice/companion/installation.ts')
  const { FakeOmarchy } = await import('../../prototypes/first-vertical-slice/companion/fake-omarchy.ts')
  const archive = new URL(`../../packages/local-workbench-v1/companion/retained/${previous}/`, import.meta.url)
  const oldAssets = Object.fromEntries(readdirSync(archive).map(name => [name, readFileSync(new URL(name, archive), 'utf8')]))
  const old = freezeCompanionRelease({ ...WORKBENCH_PREVIEW_RELEASE, version: previous, assets: oldAssets })
  const fake = new FakeOmarchy()
  const installer = new CompanionInstallation(fake.ports())
  const install = await installer.inspect({ operation: 'install', release: old })
  await installer.execute(install, fake.authorization.grant(install))
  const original = fake.installationFingerprint()
  const update = await installer.inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
  await installer.execute(update, fake.authorization.grant(update))
  const receipt = JSON.parse(fake.ports().receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes)
  assert.equal(receipt.previousRelease.version, previous)
  assert.deepEqual(receipt.previousRelease.assets, oldAssets)
  const rollback = await installer.inspect({ operation: 'update', release: old })
  await installer.execute(rollback, fake.authorization.grant(rollback))
  const restored = fake.installationFingerprint()
  assert.equal(restored.shellJsonBytes, original.shellJsonBytes)
  const ownedAssets = (fingerprint: typeof original) => fingerprint.pluginTree
    .filter(entry => entry.relativePath && Object.hasOwn(oldAssets, entry.relativePath))
    .map(entry => [entry.relativePath, entry.sha256])
  assert.deepEqual(ownedAssets(restored), ownedAssets(original), 'rollback restores exact old asset bytes, not inode identities')
  assert.equal(JSON.parse(fake.ports().receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes).release.version, previous)
})

test('active release updates a historical owned installation on an unfamiliar host, survives a further host upgrade and refuses stale plans', async () => {
  const { CompanionInstallation } = await import('../../prototypes/first-vertical-slice/companion/installation.ts')
  const { FakeOmarchy } = await import('../../prototypes/first-vertical-slice/companion/fake-omarchy.ts')
  const { COMPANION_RELEASE } = await import('../../prototypes/first-vertical-slice/companion/releases.ts')
  const fake = new FakeOmarchy({ compatibility: { omarchy: '4.0.3-1', quickshell: '0.3.1-1' } })
  const installer = new CompanionInstallation(fake.ports())
  const previous = await installer.inspect({ operation: 'install', release: COMPANION_RELEASE })
  await installer.execute(previous, fake.authorization.grant(previous))
  fake.host.setCompatibility({ omarchy: '4.0.4-1', quickshell: '0.3.1-1' })
  const update = await installer.inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
  await installer.execute(update, fake.authorization.grant(update))
  assert.deepEqual(JSON.parse(fake.receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes).compatibility,
    { omarchy: '4.0.4-1', quickshell: '0.3.1-1' })
  fake.host.setCompatibility({ omarchy: '4.1.0-1', quickshell: '0.4.0-1' })
  const plan = await installer.inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
  const before = fake.installationFingerprint()
  fake.host.setCompatibility({ omarchy: '4.1.1-1', quickshell: '0.4.0-1' })
  await assert.rejects(() => installer.execute(plan, fake.authorization.grant(plan)), /stale_precondition/)
  assert.deepEqual(fake.installationFingerprint(), before)
})

test('an explicit update preserves unrelated bar widgets while adding only the owned Workbench widget', async () => {
  const { CompanionInstallation } = await import('../../prototypes/first-vertical-slice/companion/installation.ts')
  const { FakeOmarchy } = await import('../../prototypes/first-vertical-slice/companion/fake-omarchy.ts')
  const { COMPANION_RELEASE } = await import('../../prototypes/first-vertical-slice/companion/releases.ts')
  const fake = new FakeOmarchy()
  fake.configuration.setShellJsonBytes(JSON.stringify({ ...JSON.parse(fake.configuration.shellJsonBytes()),
    bar: { layout: { right: [{ id: 'omarchy.tray' }] } } }))
  const installer = new CompanionInstallation(fake.ports())
  const first = await installer.inspect({ operation: 'install', release: COMPANION_RELEASE })
  await installer.execute(first, fake.authorization.grant(first))
  const originalReceiptBytes = fake.receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes
  const addWidget = () => { const config = JSON.parse(fake.configuration.shellJsonBytes());
    config.bar.layout.right.unshift({ id: 'omarchy.tailscale' }); fake.configuration.setShellJsonBytes(JSON.stringify(config)) }
  addWidget()
  const withWidget = fake.configuration.shellJsonBytes()
  const unrelated = fake.installationFingerprint()
  const plan = await installer.inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
  assert.equal(fake.receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes, originalReceiptBytes)
  assert.deepEqual(fake.installationFingerprint(), unrelated)
  await installer.execute(plan, fake.authorization.grant(plan))
  const receipt = JSON.parse(fake.receipts.inspectNoFollow(WORKBENCH_PLUGIN_ID)!.bytes)
  assert.deepEqual(JSON.parse(receipt.shellJson.preimageBytes).bar, JSON.parse(withWidget).bar)
  const postBar = JSON.parse(receipt.shellJson.postimageBytes).bar
  assert.equal(postBar.layout.right.filter((entry: any) => entry.id === WORKBENCH_PLUGIN_ID).length, 1)
  assert.deepEqual({ ...postBar, layout: { ...postBar.layout, right: postBar.layout.right.filter((entry: any) => entry.id !== WORKBENCH_PLUGIN_ID) } }, JSON.parse(withWidget).bar)
  assert.equal(receipt.previousRelease.version, COMPANION_RELEASE.version)

  for (const mutate of [
    (config: any) => { config.plugins = [{ id: 'foreign' }] },
    (config: any) => { config.idle = { lock: 1 } },
    (config: any) => { config.bar.layout.right.push({ id: WORKBENCH_PLUGIN_ID }) },
  ]) {
    const original = fake.configuration.shellJsonBytes()
    const config = JSON.parse(original); mutate(config)
    fake.configuration.setShellJsonBytes(JSON.stringify(config))
    const before = fake.installationFingerprint()
    await assert.rejects(() => installer.inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE }))
    assert.deepEqual(fake.installationFingerprint(), before)
    fake.configuration.setShellJsonBytes(original)
  }
})

test('live host checks plugin discovery API, not a fixed package version, before setup', () => {
  const observed: string[][] = []
  const command = { run(argv: readonly string[]) {
    observed.push([...argv])
    return argv[0] === 'pacman'
      ? { status: 0, stdout: 'omarchy 4.0.4-1\nquickshell 0.3.1-1\n', stderr: '' }
      : { status: 0, stdout: '[]', stderr: '' }
  } }
  assert.deepEqual(new LiveCompanionHost(command).compatibility(), { omarchy: '4.0.4-1', quickshell: '0.3.1-1' })
  assert.deepEqual(observed[1], ['omarchy-shell', 'shell', 'listPlugins'])
  const unsupported = { run(argv: readonly string[]) {
    return argv[0] === 'pacman'
      ? { status: 0, stdout: 'omarchy 4.0.4-1\nquickshell 0.3.1-1\n', stderr: '' }
      : { status: 0, stdout: 'unknown', stderr: '' }
  } }
  assert.throws(() => new LiveCompanionHost(unsupported).compatibility(), /listPlugins/)
})

test('existing installer installs the preview and updates back to a receipt-backed release through fake ports', async () => {
  const { CompanionInstallation } = await import('../../prototypes/first-vertical-slice/companion/installation.ts')
  const { FakeOmarchy } = await import('../../prototypes/first-vertical-slice/companion/fake-omarchy.ts')
  const { COMPANION_RELEASE } = await import('../../prototypes/first-vertical-slice/companion/releases.ts')
  const fake = new FakeOmarchy({ compatibility: { omarchy: '4.0.3-1', quickshell: '0.3.1-1' } })
  const installer = new CompanionInstallation(fake.ports())
  for (const [operation, release] of [['install', COMPANION_RELEASE], ['update', WORKBENCH_PREVIEW_RELEASE], ['update', COMPANION_RELEASE]] as const) {
    const plan = await installer.inspect({ operation, release })
    const result = await installer.execute(plan, fake.authorization.grant(plan))
    assert.equal(result.version, release.version)
  }
})

test('a same-version content change is a normal update, so the dock fix is reinstallable', async () => {
  const { CompanionInstallation } = await import('../../prototypes/first-vertical-slice/companion/installation.ts')
  const { FakeOmarchy } = await import('../../prototypes/first-vertical-slice/companion/fake-omarchy.ts')
  const { COMPANION_RELEASE } = await import('../../prototypes/first-vertical-slice/companion/releases.ts')
  const fake = new FakeOmarchy({ compatibility: { omarchy: '4.0.3-1', quickshell: '0.3.1-1' } })
  const installer = new CompanionInstallation(fake.ports())
  const install = async (release: unknown, operation: 'install' | 'update' = 'update') => {
    const plan = await installer.inspect({ operation, release })
    return (await installer.execute(plan, fake.authorization.grant(plan))).version
  }
  assert.equal(await install(COMPANION_RELEASE, 'install'), '0.2.0')
  assert.equal(await install(WORKBENCH_PREVIEW_RELEASE), WORKBENCH_PLUGIN_VERSION)
  const changed = { ...WORKBENCH_PREVIEW_RELEASE, assets: { ...WORKBENCH_PREVIEW_RELEASE.assets, 'WorkbenchConsole.qml': WORKBENCH_PREVIEW_RELEASE.assets['WorkbenchConsole.qml'] + '\n// fixed dock\n' } }
  assert.equal(await install(changed), WORKBENCH_PLUGIN_VERSION)
  assert.match(fake.ports().filesystem.readBytesNoFollow(fake.ports().paths.asset('WorkbenchConsole.qml')), /fixed dock/)
  assert.equal(await install(COMPANION_RELEASE), '0.2.0')
})

test('a shell older than the installed assets is refused instead of validating stale code', async () => {
  const { assertLoadedComponentIsCurrent } = await import('../local-workbench-preview.ts')
  const installedAt = '2026-09-11T10:39:33.938Z'
  const at = (iso: string) => Date.parse(iso) * 1000 + 500
  assert.doesNotThrow(() => assertLoadedComponentIsCurrent(at('2026-09-11T10:45:00.000Z'), installedAt))
  assert.throws(() => assertLoadedComponentIsCurrent(at('2026-09-11T07:49:16.000Z'), installedAt), /omarchy restart shell/)
  assert.throws(() => assertLoadedComponentIsCurrent(at('2026-09-11T10:39:33.000Z'), installedAt), /omarchy restart shell/)
  assert.throws(() => assertLoadedComponentIsCurrent(0, installedAt), /no usable plugin generation/)
  assert.throws(() => assertLoadedComponentIsCurrent(at('2026-09-11T11:00:00.000Z'), 'not-a-time'), /no usable installation time/)
})

test('a loaded shell that does not answer the task-first presentation contract is refused', async () => {
  const { assertLoadedPresentationContract } = await import('../local-workbench-preview.ts')
  const envelope = {
    protocol: WORKBENCH_PROTOCOL_ID,
    pluginId: WORKBENCH_PLUGIN_ID,
    version: WORKBENCH_PLUGIN_VERSION,
    pluginGeneration: 1,
    presentation: WORKBENCH_PRESENTATION_CONTRACT,
    destinations: [...WORKBENCH_PRESENTATION_DESTINATIONS],
  }
  assert.doesNotThrow(() => assertLoadedPresentationContract(JSON.stringify(envelope)))
  assert.throws(() => assertLoadedPresentationContract('not json'), /omarchy restart shell/)
  // The pre-redesign panel answered capabilities but had no presentation contract.
  const { presentation, ...withoutContract } = envelope
  assert.throws(() => assertLoadedPresentationContract(JSON.stringify(withoutContract)), /presentation contract/)
  assert.throws(
    () => assertLoadedPresentationContract(JSON.stringify({ ...envelope, presentation: 'phase-1-forms-v1' })),
    /presentation contract/,
  )
  assert.throws(
    () => assertLoadedPresentationContract(JSON.stringify({ ...envelope, destinations: ['overview', 'goal'] })),
    /destination set/,
  )
})

test('preview loads the addressed component before reading its generation', () => {
  const source = readFileSync(new URL('../local-workbench-preview.ts', import.meta.url), 'utf8')
  const summon = source.indexOf("ports.shell.summon(release.pluginId")
  const capabilities = source.indexOf('ports.shell.capabilities(release.pluginId)')
  assert.ok(summon > 0 && capabilities > 0, 'preview summons and reads capabilities')
  assert.ok(summon < capabilities, 'the host loads a panel only when summoned, so summon must come first')
  assert.match(source, /assertLoadedComponentIsCurrent\(capabilities\.pluginGeneration, receipt\.installedAt\)/)
  assert.match(source, /assertLoadedPresentationContract\(probeText\)/)
})

test('fixture controller composes actual QML session fences, updates, stale, hide/reopen and rejected work', () => {
  const source = readFileSync(new URL('../../packages/local-workbench-v1/console/plugin/WorkbenchConsole.qml', import.meta.url), 'utf8')
  const view: any = {
    activeSession: null, projection: null, pluginGeneration: 7, pendingIntents: [], opened: false,
    destination: 'overview', checksOrigin: 'overview', menuOpen: false, projectListOpen: false,
    confirmation: null, lastIntentResult: null, drafts: {}, startReview: null, draftError: '', confirmationAssociation: '',
    projectionWatchdog: { restart() {} },
    confirmationTimer: { restart() {}, stop() {} }, intentRequested() {},
  }
  view.root = view; vm.createContext(view)
  vm.runInContext([...source.matchAll(/^    function [\s\S]*?^    }/gm)].map(m => m[0]).join('\n'), view)
  const calls: string[] = []
  const controller = createPreviewController((method, payload) => { calls.push(method); return String(view[method](JSON.stringify(payload))) }, 'preview-test', 7)
  controller.open()
  assert.equal(view.opened, true)
  assert.equal(view.projection.fixture.active, true)
  assert.equal(controller.state, DEFAULT_PREVIEW_FIXTURE)
  assert.match(view.projection.fixture.label, /no real work/)
  for (const state of PREVIEW_STATES) { controller.select(state); controller.tick(); assert.match(view.projection.fixture.label, /no real work/) }
  controller.select('projects'); controller.tick()
  const firstProject = view.projection.selectedProjectId
  view.saveDraft(view.goalDraftKey(), 'First project draft')
  view.selectProject('project-example-2'); controller.tick(); controller.tick()
  assert.equal(view.projection.selectedProjectId, 'project-example-2')
  assert.equal(view.projection.managedAgents.length, 0)
  assert.equal(view.draftValue(view.goalDraftKey()), '')
  view.saveDraft(view.goalDraftKey(), 'Second project draft')
  view.selectProject(firstProject); controller.tick(); controller.tick()
  assert.equal(view.draftValue(view.goalDraftKey()), 'First project draft')
  controller.select(DEFAULT_PREVIEW_FIXTURE)
  controller.tick()
  view.emitIntent({ kind: 'start_assignment', target: 'run-1', payload: { goalText: 'x', checkId: 'c', checkVersion: 1 } })
  controller.tick()
  assert.equal(view.lastIntentResult.status, 'rejected')
  assert.equal(view.lastIntentResult.reasonCode, 'fixture_only_no_management')
  const before = calls.length; controller.stale(); controller.tick(); assert.equal(calls.length, before)
  view.markPresentationStale(); assert.equal(view.projection.connection, 'stale')
  controller.live(); controller.tick(); assert.equal(view.projection.connection, 'connected')
  assert.equal(view.openPreview({ session: { sessionId: 'foreign', pluginGeneration: 7 }, projection: view.projection }), false)
  assert.equal(view.updatePreview({ session: { sessionId: 'foreign', pluginGeneration: 7 }, projection: view.projection }), false)
  view.saveDraft('draft-key', 'retained')
  controller.hide(); assert.equal(view.opened, false)
  controller.open(); assert.equal(view.drafts['draft-key'], 'retained')
  controller.hide()
  assert.ok(calls.every(method => ['openPreview', 'updatePreview', 'takeIntent', 'intentResult', 'clear'].includes(method)))
})

test('the default preview state is the one realistic journey, not an all-states gallery', () => {
  assert.equal(PREVIEW_STATES[0], 'journey')
  const controller = createPreviewController(() => 'true', 'default-state', 1)
  assert.equal(controller.state, 'journey')
  assert.ok(PREVIEW_STATES.length > 1, 'developer scenarios stay opt-in by name')
  assert.equal(new Set(PREVIEW_STATES).size, PREVIEW_STATES.length)
})

test('launcher check path is no-resource and every live path refuses non-TTY', () => {
  const file = new URL('../local-workbench-preview.ts', import.meta.url)
  const run = (flag: string) => spawnSync(process.execPath, ['--experimental-strip-types', file.pathname, flag], { encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent-workbench-test-home' } })
  assert.equal(run('--check').status, 0)
  for (const flag of ['--setup', '--preview', '--restore']) {
    const result = run(flag)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /interactive terminal/)
  }
})
