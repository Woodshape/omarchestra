import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { validateDetail } from '../console/detail-schema.ts'
import { validateSnapshot } from '../console/schema.ts'
import { detailedFixture, detailFixtures } from '../fixtures/details.ts'
import { managedFixture } from '../fixtures/projections.ts'
import { journeyFixture, JOURNEY_AGENT_RUN_ID, JOURNEY_CHECK_ID } from '../fixtures/journey.ts'
import { createPresentationShell } from '../console/presentation-shell.ts'

function methods(file: string, view: any) {
  const qml = readFileSync(new URL(`../console/plugin/${file}`, import.meta.url), 'utf8')
  vm.createContext(view)
  vm.runInContext([...qml.matchAll(/^    function [\s\S]*?^    }/gm)].map(m => m[0]).join('\n'), view)
  return view
}

function rootView() {
  const view: any = {
    pluginGeneration: 0, projection: null, activeSession: null, pendingIntents: [], drafts: {}, draftError: '',
    opened: false, destination: 'overview', checksOrigin: 'overview', menuOpen: false, projectListOpen: false,
    confirmation: null, lastIntentResult: null, confirmationText: '', startReview: null,
    selectedAgentRunId: '', selectedObservedSessionId: '', selectedRole: '', selectedCheckId: '', selectedCheckVersion: 0,
    confirmDialog: { open() {}, close() {}, opened: false }, confirmationTimer: { restart() {} }, projectionWatchdog: { restart() {} },
    intentRequested() {},
  }
  view.root = view
  return methods('WorkbenchConsole.qml', view)
}

test('typed details validate in the actual snapshot, without diagnostic content', () => {
  assert.deepEqual(validateSnapshot(detailedFixture).details, detailFixtures)
  for (const detail of detailFixtures) {
    assert.throws(() => validateDetail({ ...detail, extra: true }), /field/)
    const missing = { ...detail }; delete (missing as any).kind
    assert.throws(() => validateDetail(missing))
  }
  assert.throws(() => validateDetail({ ...detailFixtures[4], excerpt: 'secret' }), /field/)
})

test('gate, context, resource, environment and handoff bounds fail closed', () => {
  const start: any = detailFixtures[1]
  for (const gate of [
    { ...start.gate, version: 0 }, { ...start.gate, digest: 'not-a-digest' },
    { ...start.gate, executable: 'relative' }, { ...start.gate, timeoutMs: 300001 },
    { ...start.gate, argv: Array(65).fill('x') },
    { ...start.gate, environment: [{ name: 'X', value: '1' }, { name: 'X', value: '2' }] },
    { ...start.gate, resources: [{ path: '/x', digest: 'changed' }] },
  ]) assert.throws(() => validateDetail({ ...start, gate }))
  assert.throws(() => validateDetail({ ...start, dirty: 'yes' }))
  assert.throws(() => validateDetail({ ...start, maxCorrections: 4 }))
  assert.throws(() => validateDetail({ ...detailFixtures[2], artifactRefs: ['../escape'] }))
  assert.throws(() => validateDetail({ ...detailFixtures[2], summary: '\u001b[31m' }))
  assert.throws(() => validateDetail({ ...detailFixtures[3], cancellationStatus: 'terminated' }))
})

test('the exact-fact detail copy states only what each committed detail proves', () => {
  const view = rootView()
  assert.match(view.detailText(detailFixtures[0]), /ACK and committed delivery must precede readiness/)
  assert.match(view.detailText(detailFixtures[1]), /Argv \(JSON, not shell\): \["-s","plan.md"\]/)
  assert.match(view.detailText(detailFixtures[1]), /This is code execution/)
  assert.match(view.detailText(detailFixtures[2]), /Claims are not proof tools stopped/)
  assert.match(view.detailText(detailFixtures[3]), /not tool\/process termination/)
  assert.match(view.detailText(detailFixtures[4]), /Filtering cannot guarantee secret removal/)
  assert.match(view.detailText(null), /Unavailable detail/)
})

test('the work surface shows the committed outcome detail for its own Assignment only', () => {
  const view = rootView()
  view.projection = journeyFixture
  assert.equal(view.workRows().length, 0)
  const withStop = {
    ...journeyFixture,
    assignments: [{
      assignmentId: 'assignment-1', projectId: journeyFixture.selectedProjectId, goalId: journeyFixture.selectedGoalId,
      agentRunId: JOURNEY_AGENT_RUN_ID, goalText: 'Ship the parser fix', state: 'attention', attemptId: 'attempt-1',
      gateId: JOURNEY_CHECK_ID, gateVersion: 3, gateResult: 'timeout', candidateRef: 'candidate-1',
      correctionCount: 0, correctionLimit: 1, diagnostics: null, artifactRefs: [],
    }],
    details: [...journeyFixture.details, {
      kind: 'stop', stopId: 'stop-1', assignmentId: 'assignment-1', dispatchRevoked: true,
      trigger: 'operator', cancellationStatus: 'acknowledged',
    }],
  }
  view.projection = withStop
  assert.equal(view.workRows().length, 1)
  assert.match(view.workRows()[0].resultText, /not tool\/process termination/)
  // A detail that belongs to a different Assignment is never borrowed.
  view.projection = { ...withStop, assignments: [{ ...withStop.assignments[0], assignmentId: 'assignment-2' }] }
  assert.equal(view.workRows()[0].resultText, '')
})

test('every committed Assignment gets its own bounded work row and its own detail', () => {
  const view = rootView()
  const base = {
    assignmentId: 'assignment-1', projectId: journeyFixture.selectedProjectId, goalId: journeyFixture.selectedGoalId,
    agentRunId: JOURNEY_AGENT_RUN_ID, goalText: 'Ship the parser fix', state: 'attention', attemptId: 'attempt-1',
    gateId: JOURNEY_CHECK_ID, gateVersion: 3, gateResult: 'timeout', candidateRef: 'candidate-1',
    correctionCount: 0, correctionLimit: 1, diagnostics: null, artifactRefs: [],
  }
  const assignments = [1, 2, 3].map(n => ({ ...base, assignmentId: `assignment-${n}` }))
  view.projection = {
    ...journeyFixture,
    assignments,
    details: [
      { kind: 'stop', stopId: 'stop-1', assignmentId: 'assignment-1', dispatchRevoked: true, trigger: 'operator', cancellationStatus: 'acknowledged' },
      { kind: 'stop', stopId: 'stop-3', assignmentId: 'assignment-3', dispatchRevoked: false, trigger: 'elapsed_limit', cancellationStatus: 'requested' },
    ],
  }
  const rows = view.workRows()
  assert.equal(rows.map((row: any) => row.assignment.assignmentId).join(','), 'assignment-1,assignment-2,assignment-3')
  assert.match(rows[0].resultText, /Stop stop-1/)
  assert.equal(rows[1].resultText, '')
  assert.match(rows[2].resultText, /Stop stop-3/)
  assert.equal(view.workTruncationNote(), '')
  // The schema bounds the collection; every supplied Assignment is reachable.
  view.projection = { ...view.projection, assignments: Array.from({ length: 11 }, (_, i) => ({ ...base, assignmentId: `assignment-${i + 1}` })) }
  assert.equal(view.workRows().length, 11)
  assert.match(view.workTruncationNote(), /Showing all 11 committed Assignments/)
})

test('presentation silence and same-revision detail changes revoke queued clicks and confirmations', () => {
  const view = rootView()
  view.pluginGeneration = detailedFixture.pluginGeneration
  view.open({ session: detailedFixture, projection: detailedFixture })
  view.requestConfirmation({ kind: 'stop', target: 'assignment-1', payload: { assignmentId: 'assignment-1' } })
  view.emitIntent({ kind: 'select_project', target: 'project-local-1', payload: { projectId: 'project-local-1' } })
  view.applyProjection({ ...detailedFixture, details: [] })
  assert.equal(view.confirmation, null)
  assert.equal(view.pendingIntents.length, 0)
  view.requestConfirmation({ kind: 'stop', target: 'assignment-1', payload: { assignmentId: 'assignment-1' } })
  view.markPresentationStale()
  assert.equal(view.projection.connection, 'stale')
  assert.equal(view.confirmation, null)
  view.emitIntent({ kind: 'stop', target: 'assignment-1', payload: { assignmentId: 'assignment-1' } })
  assert.equal(view.pendingIntents.length, 0)
})

test('all authored text labels explicitly disable rich text', () => {
  for (const file of [
    'WorkbenchConsole.qml', 'WorkbenchOverview.qml', 'WorkbenchGoal.qml', 'WorkbenchCards.qml',
    'WorkbenchAssignmentForm.qml', 'WorkbenchChecks.qml', 'WorkbenchReview.qml', 'WorkbenchBoard.qml',
  ]) {
    const source = readFileSync(new URL(`../console/plugin/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /^import qs.Ui$/m)
    // Text and Label bodies have no nested QML objects; the first closing
    // brace therefore bounds their authored properties in these components.
    for (const match of source.matchAll(/\b(?:Text|Label)\s*\{([^}]+)\}/g)) {
      assert.match(match[1], /textFormat:\s*Text\.PlainText/, `${file}: ${match[0]}`)
    }
    // TextArea also accepts the shared Text.PlainText enum value.
    for (const match of source.matchAll(/\bTextArea\s*\{([^}]+)\}/g)) assert.match(match[1], /textFormat:\s*(?:Text|TextEdit)\.PlainText/, file)
  }
})

test('drafts synchronize into the adapter and survive target changes, close and reopen', async () => {
  const view = rootView()
  view.projection = journeyFixture
  let handler: any
  const shell = createPresentationShell({
    view,
    clock: () => 0,
    source: { async connect(h) { handler = h; return { send() {}, close() {} } } },
    intentSink() { assert.fail('drafts cannot emit authority') },
  })
  await shell.start()
  handler.onSnapshot(journeyFixture)
  view.selectedAgentRunId = JOURNEY_AGENT_RUN_ID
  view.saveDraft(view.assignmentKey(), JSON.stringify({ taskText: 'retain <literal> task' }))
  shell.tick()
  assert.match(shell.adapter.getDraft('assignment:project-workbench-1:goal-parser-fix:agent-run-builder-1'), /retain <literal> task/)

  // A different target gets its own empty draft, and switching back restores it.
  view.selectedAgentRunId = 'agent-run-other'
  assert.equal(view.assignmentDraft().taskText, undefined)
  view.saveDraft(view.assignmentKey(), JSON.stringify({ taskText: 'other' }))
  view.selectedAgentRunId = JOURNEY_AGENT_RUN_ID
  assert.match(view.assignmentDraft().taskText, /retain <literal> task/)

  // A Project switch re-keys the Goal draft instead of leaking text across Projects.
  view.saveDraft(view.goalDraftKey(), 'goal draft for the first Project')
  view.projection = { ...journeyFixture, selectedProjectId: 'project-other' }
  assert.equal(view.draftValue(view.goalDraftKey()), '')
  view.projection = journeyFixture
  assert.equal(view.draftValue(view.goalDraftKey()), 'goal draft for the first Project')

  handler.onSnapshot({ ...journeyFixture, revision: journeyFixture.revision + 1 })
  shell.close()
  assert.equal(view.opened, false)
  view.open({ session: journeyFixture, projection: journeyFixture })
  assert.match(view.assignmentDraft().taskText, /retain <literal> task/)
  assert.equal(view.confirmation, null)
  assert.equal(view.setDraftState({ invalid: 'x'.repeat(24001) }), false)
})

test('an ordinary projection update keeps drafts while a re-keyed target does not inherit them', async () => {
  const view = rootView()
  let handler: any
  const shell = createPresentationShell({
    view,
    clock: () => 0,
    source: { async connect(h) { handler = h; return { send() {}, close() {} } } },
    intentSink() {},
  })
  await shell.start()
  handler.onSnapshot(journeyFixture)
  view.selectedAgentRunId = JOURNEY_AGENT_RUN_ID
  view.saveDraft(view.assignmentKey(), JSON.stringify({ taskText: 'first' }))
  shell.tick()
  handler.onSnapshot({ ...journeyFixture, revision: journeyFixture.revision + 1 })
  assert.match(view.assignmentDraft().taskText, /first/)
  view.selectedAgentRunId = 'agent-run-builder-2'
  assert.equal(view.assignmentDraft().taskText, undefined)
  shell.close()
})
