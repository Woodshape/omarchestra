import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { startNativeOwner, requestOwner } from '../runner/native-owner.ts'
import { WORKBENCH_PLUGIN_VERSION, WORKBENCH_PLUGIN_ID, WORKBENCH_PROTOCOL_ID,
  WORKBENCH_PRESENTATION_CONTRACT, WORKBENCH_PRESENTATION_DESTINATIONS } from '../companion/contracts.ts'
import { negotiateCompanion, systemDesktopCommand, type DesktopCommandPort } from '../runner/desktop-command.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'

test('installed shell accepts only an empty idle takeIntent response, not empty negotiation or mutation acknowledgements', () => {
  const argv: string[][] = []
  const fakeSpawn = ((_script: string, args: string[]) => {
    argv.push(args)
    return { status: 0, stdout: '', stderr: '', error: undefined }
  }) as unknown as typeof spawnSync
  const desktop = systemDesktopCommand(fakeSpawn)
  assert.equal(desktop.call(WORKBENCH_PLUGIN_ID, 'takeIntent', '{}'), '')
  assert.deepEqual(argv[0], ['shell', 'call', WORKBENCH_PLUGIN_ID, 'takeIntent', '{}'])
  assert.throws(() => desktop.call(WORKBENCH_PLUGIN_ID, 'capabilities', '{}'), /shell unavailable/)
  assert.throws(() => desktop.call(WORKBENCH_PLUGIN_ID, 'open', '{}'), /shell unavailable/)
})

function fakeDesktop() {
  let generation = 17, session: { sessionId: string; pluginGeneration: number } | null = null
  const projections: unknown[] = [], results: unknown[] = [], intents: string[] = [], hides: string[] = []
  const port: DesktopCommandPort = {
    call(pluginId, method, payload) {
      assert.equal(pluginId, WORKBENCH_PLUGIN_ID)
      if (method === 'capabilities') return JSON.stringify({ protocol: WORKBENCH_PROTOCOL_ID, pluginId,
        version: WORKBENCH_PLUGIN_VERSION, pluginGeneration: generation,
        capabilities: ['session.open', 'session.update', 'session.intent', 'session.hide', 'session.clear', 'session.resnapshot'] })
      if (method === 'presentationContract') return JSON.stringify({ protocol: WORKBENCH_PROTOCOL_ID, pluginId,
        version: WORKBENCH_PLUGIN_VERSION, pluginGeneration: generation,
        presentation: WORKBENCH_PRESENTATION_CONTRACT, destinations: WORKBENCH_PRESENTATION_DESTINATIONS })
      const body = JSON.parse(payload)
      if (method === 'open') { session = body.session; projections.push(body.projection); return 'true' }
      if (method === 'applyProjection') { assert.equal(body.sessionId, session?.sessionId); projections.push(body); return 'true' }
      if (method === 'takeIntent') { assert.deepEqual(body, session); return intents.shift() ?? '' }
      if (method === 'intentResult') { results.push(body); return 'true' }
      if (method === 'clear') { assert.deepEqual(body, session); session = null; return 'true' }
      throw Error('unknown desktop method')
    },
    hide(pluginId) { hides.push(pluginId) },
  }
  return { port, projections, results, intents, hides, reload() { generation++ }, generation: () => generation }
}
test('native dock Close is presentation-only; reopened view has fresh session and unchanged owner history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-close-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime')
  const desktop = fakeDesktop()
  const owner = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: desktop.port })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  const opened = await requestOwner(runtimeDir, 'open')
  assert.equal(opened.status, 'opened')
  const epoch = owner.runner.epoch
  const revision = owner.currentAuthority().currentRevision
  desktop.intents.push(JSON.stringify({ kind: 'hide_workbench', target: null, payload: { force: true } }))
  owner.tick()
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'open', 'malformed hide cannot close the dock')
  desktop.intents.push(JSON.stringify({ kind: 'hide_workbench', target: null, payload: {} }))
  owner.tick()
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'hidden')
  assert.equal(owner.runner.epoch, epoch)
  assert.equal(owner.currentAuthority().currentRevision, revision)
  assert.equal(desktop.hides.length, 1)
  assert.equal(owner.runner.store.listEvents().length, 0, 'hide created no domain event')
  const reopened = await requestOwner(runtimeDir, 'open')
  assert.equal(reopened.status, 'opened')
  assert.notEqual(reopened.sessionId, opened.sessionId)
  assert.equal(owner.runner.epoch, epoch)
})

test('first Project inspection after a long idle refreshes authority before draining the queued click', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-i-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime'), project = join(root, 'project')
  mkdirSync(project)
  assert.equal(spawnSync('git', ['init', '--quiet', project], { timeout: 5000 }).status, 0)
  const desktop = fakeDesktop()
  let now = 1000
  const owner = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: desktop.port, monotonic: () => now })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  now += 3000 // idle beyond the adapter's 2s staleness bound
  desktop.intents.push(JSON.stringify({ kind: 'inspect_project', target: null, payload: { path: project } }))
  owner.tick()
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'open')
  assert.equal((desktop.projections.at(-1) as { details: Array<{ kind: string; canonicalPath: string }> }).details
    .some(detail => detail.kind === 'registration' && detail.canonicalPath === project), true)
})

test('slow installed-shell intent readback cannot strand a valid Project inspection or close the dock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-s-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime'), project = join(root, 'project')
  mkdirSync(project)
  assert.equal(spawnSync('git', ['init', '--quiet', project], { timeout: 5000 }).status, 0)
  const desktop = fakeDesktop()
  let now = 1000
  const slow: DesktopCommandPort = {
    call(id, method, payload) {
      const response = desktop.port.call(id, method, payload)
      if (method === 'takeIntent' && response !== '') now += 2500
      return response
    },
    hide: id => desktop.port.hide(id),
  }
  const owner = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: slow, monotonic: () => now })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  desktop.intents.push(JSON.stringify({ kind: 'inspect_project', target: null, payload: { path: project } }))
  owner.tick()
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'open')
  assert.equal((desktop.projections.at(-1) as { details: Array<{ kind: string; canonicalPath: string }> }).details
    .some(detail => detail.kind === 'registration' && detail.canonicalPath === project), true)
})

test('a queued click is locally marked stale if authority changes during shell readback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-c-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime'), project = join(root, 'project')
  mkdirSync(project)
  assert.equal(spawnSync('git', ['init', '--quiet', project], { timeout: 5000 }).status, 0)
  const desktop = fakeDesktop()
  let owner: Awaited<ReturnType<typeof startNativeOwner>>
  let changed = false
  const port: DesktopCommandPort = {
    call(id, method, payload) {
      const response = desktop.port.call(id, method, payload)
      if (method === 'takeIntent' && response !== '' && !changed) {
        changed = true
        const inspected = owner.currentAuthority().inspect(project)
        owner.currentAuthority().confirmRegistration(inspected.inspectionId)
      }
      return response
    },
    hide: id => desktop.port.hide(id),
  }
  owner = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: port })
  t.after(async () => { await owner.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  desktop.intents.push(JSON.stringify({ kind: 'inspect_project', target: null, payload: { path: project } }))
  owner.tick()
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'open')
  assert.equal(owner.runner.store.listProjects().length, 1)
  assert.equal((desktop.results.at(-1) as { status: string; reasonCode: string }).status, 'stale')
  assert.equal((desktop.results.at(-1) as { status: string; reasonCode: string }).reasonCode, 'refresh_required')
})

test('one owner survives two presentation clients, status has no lock/epoch mutation and incompatible plugin is refused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-'))
  const stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime'), project = join(root, 'project')
  mkdirSync(project)
  const init = spawnSync('git', ['init', '--quiet', project], { timeout: 5000 })
  assert.equal(init.status, 0)
  const desktop = fakeDesktop()
  const owner = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: desktop.port })
  let successor: Awaited<ReturnType<typeof startNativeOwner>> | null = null
  let stopPi = () => {}
  t.after(async () => { stopPi(); await successor?.close(); await owner.close(); rmSync(root, { recursive: true, force: true }) })
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'hidden')
  const epoch = owner.runner.epoch
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  assert.equal(desktop.projections.length, 1)
  const authority = owner.currentAuthority()
  const inspection = authority.inspect(project)
  authority.confirmRegistration(inspection.inspectionId)
  const goal = authority.createGoal(authority.selectedProjectId!, 'First Team Goal')
  authority.selectGoal(goal.goalId)
  owner.tick()
  assert.equal((desktop.projections.at(-1) as { goals: unknown[] }).goals.length, 1)
  const hooks = new Map<string, (event: unknown, context: unknown) => void>()
  const statuses: Array<string | undefined> = []
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 'native-pi' }, isIdle: () => true,
    ui: { setStatus(_key: string, status: string | undefined) { statuses.push(status) } } }
  createPiBridgeExtension({ socketPath: join(runtimeDir, 'omarchestra-bridge.sock') })({
    on(event, handler) { hooks.set(event, handler as (event: unknown, context: unknown) => void) },
  })
  hooks.get('session_start')!(null, ctx)
  stopPi = () => { hooks.get('session_shutdown')!(null, ctx) }
  const observedDeadline = Date.now() + 2000
  while (owner.registry.list().length === 0 && Date.now() < observedDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(owner.registry.list()[0]?.mode, 'observed')
  owner.tick()
  const observation = (desktop.projections.at(-1) as { observedSessions: Array<{ choices: Array<{ choiceId: string }> }> }).observedSessions[0]
  desktop.intents.push(JSON.stringify({ kind: 'request_adoption', target: observation.choices[0].choiceId,
    payload: { choiceId: observation.choices[0].choiceId } }))
  owner.tick()
  const proposed = owner.runner.store.listProposals()[0]
  assert.ok(proposed)
  desktop.intents.push(JSON.stringify({ kind: 'authorize_adoption', target: proposed.proposalId, payload: { proposalId: proposed.proposalId } }))
  owner.tick()
  const receiptDeadline = Date.now() + 2000
  while ((owner.runner.store.getBinding(proposed.runId)?.state !== 'ready' || statuses.at(-1) !== `Pi ${owner.registry.list()[0].sessionCode} · implementer · ready`)
      && Date.now() < receiptDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(owner.runner.store.getBinding(proposed.runId)?.state, 'ready')
  assert.equal(statuses.at(-1), `Pi ${owner.registry.list()[0].sessionCode} · implementer · ready`)
  const hidden = await requestOwner(runtimeDir, 'hide')
  assert.equal(hidden.status, 'hidden')
  assert.equal(owner.runner.epoch, epoch)
  assert.equal((await requestOwner(runtimeDir, 'status')).goals, 1)
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  assert.equal(owner.runner.epoch, epoch)
  assert.notEqual(owner.currentAuthority().sessionId, authority.sessionId)
  desktop.reload()
  const staleStatus = await requestOwner(runtimeDir, 'status')
  assert.notEqual(staleStatus.presentation, 'open', 'status must not claim a stale loaded Companion is open')
  assert.equal(staleStatus.status, 'unavailable')
  assert.equal(owner.runner.epoch, epoch, 'status did not create a runner or advance its epoch')
  owner.tick()
  assert.equal(desktop.hides.length, 1, 'stale view must not hide the newly loaded incarnation')
  assert.equal((await requestOwner(runtimeDir, 'status')).presentation, 'hidden', 'stale loaded generation revokes presentation only')
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  assert.equal(owner.runner.store.listGoals().length, 1)
  assert.equal(owner.runner.store.getBinding(proposed.runId)?.state, 'ready')
  assert.equal((await requestOwner(runtimeDir, 'hide')).status, 'hidden')
  assert.equal(owner.runner.store.listBindings().length, 1)
  const firstEpoch = owner.runner.epoch
  await owner.close()
  successor = await startNativeOwner({ roots: { stateDir, runtimeDir }, desktop: desktop.port })
  assert.notEqual(successor.runner.epoch, firstEpoch)
  // The surviving extension retries with bounded exponential backoff (up to
  // 5s). Allow two retries under concurrent offscreen test load.
  const reconnectDeadline = Date.now() + 12_000
  while ((successor.registry.list().length === 0 || successor.runner.store.getBinding(proposed.runId)?.state !== 'ready'
      || statuses.at(-1) !== `Pi ${successor.registry.list()[0]?.sessionCode} · implementer · ready`)
      && Date.now() < reconnectDeadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(successor.registry.list().length, 1, 'same surviving Pi reconnects to successor owner')
  assert.equal(successor.runner.store.getBinding(proposed.runId)?.state, 'ready', 'surviving extension proves the new owner epoch')
  assert.equal((await requestOwner(runtimeDir, 'open')).status, 'opened')
  successor.tick()
  const recoveredCode = (desktop.projections.at(-1) as { managedAgents: Array<{ sessionCode: string }> }).managedAgents[0].sessionCode
  assert.match(recoveredCode, /^[A-F0-9]{4}-[A-F0-9]{4}$/)
  assert.equal(statuses.at(-1), `Pi ${recoveredCode} · implementer · ready`, 'new owner and surviving Pi agree on the current code')
  assert.equal(successor.runner.store.listMemberships(goal.goalId).length, 1)
  assert.equal(successor.runner.store.listBindings().length, 1)
  assert.equal(successor.runner.store.listEvents().filter(e => e.kind.startsWith('assignment')).length, 0)
})

test('a fresh session exposes durable selections past page one without expanding bounded pages', t => {
  const root = mkdtempSync(join(tmpdir(), 'n-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  for (let i = 0; i < 130; i++) runner.store.putProject({ projectId: `project-${String(i).padStart(3, '0')}`,
    executionNodeId: runner.nodeId, canonicalPath: join(root, `project-${i}`), gitCommonDir: join(root, `project-${i}/.git`),
    headOid: null, dirty: false, contextDigest: null, revision: 1, createdAt: i + 1 })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'before-hide', pluginGeneration: 1 })
  authority.selectProject('project-129')
  for (let i = 0; i < 130; i++) authority.createGoal('project-129', `Goal ${String(i).padStart(3, '0')}`)
  const selectedGoalId = authority.selectedGoalId
  const afterReopen = new WorkbenchAuthority({ runner, sessionId: 'after-hide', pluginGeneration: 1 })
  const current = () => validateSnapshot(buildSnapshot({ authority: afterReopen, adoption: afterReopen.adoption, connection: 'connected' }))
  assert.equal(current().pages?.projects.offset, 128)
  assert.equal(current().pages?.goals.offset, 128)
  assert.equal(current().projects.length, 2)
  assert.equal(current().goals.length, 2)
  assert.equal(current().selectedProject?.projectId, 'project-129')
  assert.equal(current().selectedGoal?.goalId, selectedGoalId)
  assert.equal(current().projects.some(p => p.projectId === 'project-129'), true)
  assert.equal(current().goals.some(g => g.goalId === selectedGoalId), true)
  const page = (collection: 'projects' | 'goals', offset: number) => afterReopen.handleIntent({ protocol: 'omarchestra.workbench/v1',
    intentId: `browse-${collection}`, sessionId: afterReopen.sessionId, pluginGeneration: 1, runnerEpoch: runner.epoch,
    expectedRevision: afterReopen.currentRevision, kind: 'navigate_page', target: null, payload: { collection, offset } })
  assert.equal(page('projects', 64).status, 'acknowledged')
  assert.equal(page('goals', 64).status, 'acknowledged')
  assert.equal(current().selectedProject?.projectId, 'project-129')
  assert.equal(current().selectedGoal?.goalId, selectedGoalId)
  assert.equal(current().projects.length, 64)
  assert.equal(current().goals.length, 64)
  const selected = current()
  assert.throws(() => validateSnapshot({ ...selected, selectedProject: { ...selected.selectedProject!, projectId: 'project-000' } }),
    /selected Project identity mismatch/)
  assert.throws(() => validateSnapshot({ ...selected, selectedGoal: undefined }), /paged selection must include exact selected context/)
})

test('Companion negotiation refuses missing capability, wrong version and presentation contract without opening', () => {
  const valid = fakeDesktop()
  assert.equal(negotiateCompanion(valid.port), valid.generation())
  for (const [method, tamper] of [
    ['capabilities', (record: Record<string, unknown>) => { record.capabilities = ['session.open'] }],
    ['capabilities', (record: Record<string, unknown>) => { record.version = 'incompatible' }],
    ['capabilities', (record: Record<string, unknown>) => { record.pluginId = 'wrong-plugin' }],
    ['presentationContract', (record: Record<string, unknown>) => { record.presentation = 'wrong-contract' }],
    ['presentationContract', (record: Record<string, unknown>) => { record.pluginGeneration = 999 }],
    ['presentationContract', (record: Record<string, unknown>) => { record.destinations = [] }],
  ] as const) {
    const incompatible: DesktopCommandPort = { ...valid.port,
      call(pluginId, kind, payload) {
        const response = valid.port.call(pluginId, kind, payload)
        if (kind !== method) return response
        const record = JSON.parse(response) as Record<string, unknown>
        tamper(record)
        return JSON.stringify(record)
      },
    }
    assert.throws(() => negotiateCompanion(incompatible), /incompatible|differs/, `${method} alteration must fail closed`)
  }
  assert.equal(valid.projections.length, 0)
  assert.equal(valid.hides.length, 0)
})

test('bounded Project pages expose every admitted record and reject non-adjacent navigation', t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-pages-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  for (let i = 0; i < 133; i++) runner.store.putProject({ projectId: `project-${String(i).padStart(3, '0')}`,
    executionNodeId: runner.nodeId, canonicalPath: join(root, `project-${i}`), gitCommonDir: join(root, `project-${i}/.git`),
    headOid: null, dirty: false, contextDigest: null, revision: 1, createdAt: i + 1 })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'page-session', pluginGeneration: 1 })
  const current = () => validateSnapshot(buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' }))
  let attempt = 0
  const go = (offset: number) => authority.handleIntent({ protocol: 'omarchestra.workbench/v1',
    intentId: `page-${++attempt}`, sessionId: authority.sessionId, pluginGeneration: 1, runnerEpoch: runner.epoch,
    expectedRevision: authority.currentRevision, kind: 'navigate_page', target: null, payload: { collection: 'projects', offset } })
  assert.equal(current().projects.length, 64)
  assert.deepEqual(current().pages?.projects, { offset: 0, limit: 64, total: 133, hasNext: true, hasPrevious: false })
  assert.equal(go(128).status, 'rejected')
  assert.equal(go(64).status, 'acknowledged')
  assert.equal(current().projects[0].projectId, 'project-064')
  assert.equal(go(128).status, 'acknowledged')
  assert.deepEqual(current().projects.map(p => p.projectId), ['project-128', 'project-129', 'project-130', 'project-131', 'project-132'])
  assert.equal(current().pages?.projects.hasNext, false)
  assert.equal(go(192).status, 'rejected')
  assert.equal(runner.store.listEvents().filter(e => e.kind === 'page_selected').length, 2)
  for (let i = 0; i < 130; i++) authority.createGoal('project-000', `Historical goal ${i}`)
  const history = current()
  assert.equal(history.activity.length, 64)
  assert.equal(history.pages?.activity.total, 130)
  assert.equal(history.pages?.goals.total, 130)
  assert.equal(new Set(history.activity.map(e => e.eventId)).size, 64)
  const navigate = authority.handleIntent({ protocol: 'omarchestra.workbench/v1', intentId: 'history-page',
    sessionId: authority.sessionId, pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: authority.currentRevision,
    kind: 'navigate_page', target: null, payload: { collection: 'activity', offset: 64 } })
  assert.equal(navigate.status, 'acknowledged')
  assert.equal(current().pages?.activity.total, 130)
  assert.equal(current().activity.length, 64)
  assert.notEqual(current().activity[0].eventId, history.activity.at(-1)!.eventId)
  assert.equal(current().activity[0].cursor, history.activity.at(-1)!.cursor - 1)
  assert.equal(runner.store.listEvents().length, 133)
})
