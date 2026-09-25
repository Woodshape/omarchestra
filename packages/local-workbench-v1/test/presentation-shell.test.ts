import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createPresentationShell } from '../console/presentation-shell.ts'
import { managedFixture, emptyFixture } from '../fixtures/projections.ts'
import { validateSnapshot } from '../console/schema.ts'
import { STATE_MATRIX } from '../fixtures/state-matrix.ts'

test('actual QML methods compose with injected source, adapter, feedback and close', async () => {
  const qml = readFileSync(new URL('../console/plugin/WorkbenchConsole.qml', import.meta.url), 'utf8')
  const methods = [...qml.matchAll(/^    function [\s\S]*?^    }/gm)].map(match => match[0]).join('\n')
  assert.ok(methods.includes('function takeIntent'))
  const view: any = {
    pluginGeneration: 0, projection: null, activeSession: null, pendingIntents: [],
    opened: false, destination: 'overview', checksOrigin: 'overview', menuOpen: false, projectListOpen: false,
    confirmation: null, lastIntentResult: null, drafts: {}, draftError: '', confirmationText: '', confirmationNotice: '', confirmationAssociation: '', startReview: null,
    confirmReview: { open() {}, close() { view.confirmation = null; view.confirmationNotice = ''; view.confirmationAssociation = '' }, visible: false },
    confirmationTimer: { restart() {}, stop() {} }, projectionWatchdog: { restart() {} },
    intentRequested() {},
  }
  view.root = view
  vm.createContext(view)
  vm.runInContext(methods, view)
  let handler: any
  const sent: any[] = []
  const shell = createPresentationShell({
    view, clock: () => 0,
    source: { async connect(value) { handler = value; return { send() {}, close() {} } } },
    intentSink(intent) { sent.push(intent) },
  })
  await shell.start()
  handler.onSnapshot(managedFixture)
  assert.equal(view.opened, true)
  assert.equal(view.projection.managedAgents.length, 1)
  view.emitIntent({ kind: 'select_project', target: 'project-local-1', payload: { projectId: 'project-local-1' } })
  shell.tick()
  assert.equal(sent.length, 1)
  assert.equal(view.lastIntentResult.status, 'submitted')
  assert.equal(sent[0].expectedRevision, managedFixture.revision)
  shell.tick()
  assert.equal(sent.length, 1)
  // A queued click is tied to its displayed revision, not a future snapshot.
  view.emitIntent({ kind: 'select_project', target: 'project-local-1', payload: { projectId: 'project-local-1' } })
  assert.equal(view.pendingIntents.length, 1)
  handler.onSnapshot({ ...managedFixture, revision: managedFixture.revision + 1 })
  assert.equal(view.pendingIntents.length, 0)
  shell.tick()
  assert.equal(sent.length, 1)
  handler.onSnapshot({ ...emptyFixture, sessionId: 'new-session', runnerEpoch: 2, pluginGeneration: 2 })
  assert.equal(view.projection.managedAgents.length, 0)
  assert.equal(view.pendingIntents.length, 0)
  shell.close()
  assert.equal(view.opened, false)
  assert.equal(view.projection, null)
})

test('Adoption, replacement, dirty-context and uncertain-writer design states validate', () => {
  for (const [name, fixture] of Object.entries(STATE_MATRIX)) {
    const projection = validateSnapshot(fixture)
    assert.equal(projection.fixture.active, true, name)
    assert.match(projection.fixture.label, /design fixture/)
  }
})

test('strict nested fields, booleans, controls and bounds reject before projection', () => {
  assert.throws(() => validateSnapshot({ ...managedFixture, projects: [{ ...managedFixture.projects[0], dirty: 'yes' }] }), /boolean/)
  assert.throws(() => validateSnapshot({ ...managedFixture, managedAgents: [{ ...managedFixture.managedAgents[0], secret: 'value' }] }), /unknown/)
  assert.throws(() => validateSnapshot({ ...emptyFixture, fixture: { active: true, label: '\u001b[31m' } }), /control/)
})
