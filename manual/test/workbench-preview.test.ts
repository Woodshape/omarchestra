import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createPreviewController, DEFAULT_PREVIEW_FIXTURE, PREVIEW_STATES } from '../workbench-preview-controller.ts'
import { WORKBENCH_PREVIEW_RELEASE } from '../workbench-preview-release.ts'
import { freezeCompanionRelease } from '../../prototypes/first-vertical-slice/companion/contracts.ts'
import {
  WORKBENCH_PLUGIN_ID,
  WORKBENCH_PLUGIN_VERSION,
  WORKBENCH_PRESENTATION_CONTRACT,
  WORKBENCH_PRESENTATION_DESTINATIONS,
  WORKBENCH_PROTOCOL_ID,
} from '../../packages/local-workbench-v1/companion/contracts.ts'

test('native preview release passes existing installer release validation', () => {
  assert.equal(freezeCompanionRelease(WORKBENCH_PREVIEW_RELEASE).version, WORKBENCH_PLUGIN_VERSION)
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
    confirmation: null, lastIntentResult: null, drafts: {}, startReview: null, draftError: '', confirmationText: '',
    projectionWatchdog: { restart() {} }, confirmDialog: { close() {}, opened: false }, intentRequested() {},
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
