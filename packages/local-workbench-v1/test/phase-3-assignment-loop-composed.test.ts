import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { AssignmentDeliveryCoordinator } from '../runner/bridge-delivery.ts'
import { CandidateSubmissionCoordinator } from '../runner/candidate-submission.ts'
import { createPiBridgeExtension, type PiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { WorkbenchAuthority, type AdmissionPhase } from '../runner/authority.ts'
import { openWorkbenchRunner, type WorkbenchRunner } from '../runner/runner.ts'
import { createWorkbenchHost, type WorkbenchHost } from '../runner/host.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { ensureOwnedDirectory } from '../runner/paths.ts'
import { WORKBENCH_PROTOCOL, type WorkbenchSnapshot } from '../console/schema.ts'
import type { PresentationPort } from '../console/presentation-shell.ts'
import type { BridgeFrame } from '../runner/bridge-protocol.ts'
import { decodeBridgeFrame } from '../runner/bridge-protocol.ts'
import { prepareQtFixture } from './qt-fixture.ts'

const QT_RUNNER = process.env.QT_BIN || '/usr/lib/qt6/bin/qmltestrunner'
const PI_SESSION = 'phase3-composed-session'
class FakeStream extends EventEmitter {
  other!: FakeStream
  closed = false
  write(bytes: Buffer): boolean {
    if (this.closed) throw new Error('fake bridge closed')
    decodeBridgeFrame(bytes.subarray(0, -1))
    if (!this.other.closed) this.other.emit('data', bytes)
    return true
  }
  destroy(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    if (!this.other.closed) this.other.destroy()
  }
}
function fakePair(): { owner: FakeStream; pi: FakeStream } {
  const owner = new FakeStream(), pi = new FakeStream()
  owner.other = pi; pi.other = owner
  return { owner, pi }
}

class MemoryView implements PresentationPort {
  pluginGeneration = 0
  projection: WorkbenchSnapshot | null = null
  readonly queued: Array<{ kind: string; target: string | null; payload: Record<string, unknown> }> = []
  readonly outcomes: unknown[] = []
  open(envelope: unknown): boolean {
    const value = envelope as { projection?: WorkbenchSnapshot }
    if (!value.projection) return false
    this.projection = value.projection
    return true
  }
  applyProjection(snapshot: unknown): boolean {
    this.projection = snapshot as WorkbenchSnapshot
    return true
  }
  takeIntent(): string {
    const next = this.queued.shift()
    return next ? JSON.stringify(next) : ''
  }
  intentResult(outcome: unknown): boolean { this.outcomes.push(outcome); return true }
  close(): void {}
  enqueue(intent: { kind: string; target: string | null; payload: Record<string, unknown> }): void { this.queued.push(intent) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('bounded test wait expired')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function runQmlIntent(scratch: string, snapshot: WorkbenchSnapshot, mode: 'prepare' | 'confirm' | 'accept', values: {
  runId: string; checkId: string; checkVersion: number; taskText: string; assignmentId?: string
}): Promise<{ kind: string; target: string | null; payload: Record<string, unknown> }> {
  const qt = `import QtQuick
import QtQuick.Window
import QtTest
import "view"
Item {
  id: host
  width: 1000; height: 1200
  property var snapshot: ${JSON.stringify(snapshot)}
  property string testMode: ${JSON.stringify(mode)}
  property var emitted: null
  WorkbenchConsole {
    id: consoleView
    width: 420; height: 1100
    pluginGeneration: host.snapshot.pluginGeneration
    onIntentRequested: function(payload) { host.emitted = payload }
  }
  WorkbenchAssignmentForm {
    id: startForm
    x: 500; width: 420; height: 1100
    visible: host.testMode === "prepare"
    projection: host.snapshot
    mode: "assignment"
    selectedAgentRunId: consoleView.selectedAgentRunId
    selectedCheckId: consoleView.selectedCheckId
    selectedCheckVersion: consoleView.selectedCheckVersion
    assignmentDraft: consoleView.assignmentDraft()
    reviewBlockedReason: consoleView.reviewBlockedReason()
    onReviewStart: consoleView.captureStartReview()
  }
  WorkbenchReview {
    id: acceptPage
    x: 500; width: 420; height: 1100
    visible: host.testMode === "accept" || host.testMode === "confirm"
    projection: host.snapshot
    mode: host.testMode === "confirm" ? "start_review" : "work"
    startReview: consoleView.startReview
    startDetail: consoleView.startDetail()
    startIntent: consoleView.startConfirmationIntent()
    selectedCheck: consoleView.selectedCheck()
    rows: consoleView.workRows()
    agents: host.snapshot.managedAgents
    truncationNote: ""
    armedConfirmation: consoleView.confirmation
    onIntentRequested: function(payload) { consoleView.requestConfirmation(payload) }
  }
  TestCase {
    name: "AssignmentLoopIntent"
    when: windowShown
    function initTestCase() {
      verify(consoleView.open({ session: { sessionId: host.snapshot.sessionId,
        pluginGeneration: host.snapshot.pluginGeneration }, projection: host.snapshot }))
    }
    function test_emit() {
      if (${JSON.stringify(mode)} === "accept") {
        var action = findChild(host, ${JSON.stringify(`workbench-intervention-accept-${values.assignmentId}`)})
        verify(action !== null, "projected Accept control must be rendered")
        verify(action.enabled, action.supportingText)
        mouseClick(action, Qt.LeftButton)
        compare(consoleView.confirmation.kind, "accept")
        mouseClick(action, Qt.LeftButton)
        var accepted = JSON.parse(consoleView.takeIntent(host.snapshot))
        compare(accepted.kind, "accept")
        host.emitted = accepted
      } else {
        consoleView.goTo("assignment")
        consoleView.selectAgent(${JSON.stringify(values.runId)})
        consoleView.selectCheck(${JSON.stringify(values.checkId)}, ${values.checkVersion})
        consoleView.saveDraft(consoleView.assignmentKey(), JSON.stringify({ taskText: ${JSON.stringify(values.taskText)}, maxCorrections: 1, elapsedMs: 60000 }))
        if (${JSON.stringify(mode)} === "prepare") {
          var action = findChild(host, "workbench-start-review")
          verify(action !== null, "Start review control must be rendered")
          verify(action.enabled, action.supportingText)
          mouseClick(action, Qt.LeftButton)
          compare(host.emitted.kind, "prepare_start_review")
        } else {
          consoleView.startReview = ({ checkId: ${JSON.stringify(values.checkId)}, checkVersion: ${values.checkVersion},
            agentRunId: ${JSON.stringify(values.runId)}, taskText: ${JSON.stringify(values.taskText)},
            maxCorrections: 1, elapsedMs: 60000, association: consoleView.reviewAssociation })
          var action = findChild(host, "workbench-confirm-start")
          verify(action !== null, "Start confirmation control must be rendered")
          verify(action.enabled, action.supportingText)
          mouseClick(action, Qt.LeftButton)
          compare(consoleView.confirmation.kind, "start_assignment")
          mouseClick(action, Qt.LeftButton)
          var confirmed = JSON.parse(consoleView.takeIntent(host.snapshot))
          compare(confirmed.kind, "start_assignment")
          host.emitted = confirmed
        }
      }
      console.log("COMPOSED_INTENT:" + JSON.stringify(host.emitted))
    }
  }
}`
  writeFileSync(join(scratch, 'tst_assignment_loop.qml'), qt)
  const child = spawn(QT_RUNNER, ['-input', scratch, '-import', join(scratch, 'imports'), '-platform', 'offscreen'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'home'),
      XDG_CACHE_HOME: join(scratch, 'home'), XDG_STATE_HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
      QT_QUICK_BACKEND: 'software', QML_DISABLE_DISK_CACHE: '1', QT_QUICK_CONTROLS_STYLE: 'Basic', QT_QPA_PLATFORM: 'offscreen' },
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), 12_000)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
    child.once('error', error => resolve({ code: null, signal: null, error }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  const log = `${stdout}\n${stderr}`
  assert.equal(exit.error, undefined, log)
  assert.equal(exit.code, 0, log)
  assert.match(log, /0 failed/, log)
  const matches = [...log.matchAll(/COMPOSED_INTENT:(\{[^\n]+\})/g)]
  assert.ok(matches.length > 0, log)
  return JSON.parse(matches.at(-1)![1]!) as { kind: string; target: string | null; payload: Record<string, unknown> }
}

test('AL-07 composes real QML, adapter, Runner, SQLite, framed fake-Pi delivery, Candidate, gate and reopen', { timeout: 50_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-assignment-loop-composed-'))
  const projectPath = join(root, 'project'), stateDir = join(root, 'state'), runtimeDir = join(root, 'runtime')
  const qmlScratch = join(root, 'qml'), gateScratchRoot = ensureOwnedDirectory(join(root, 'gate'))
  mkdirSync(projectPath); mkdirSync(qmlScratch); mkdirSync(runtimeDir, { mode: 0o700 })
  prepareQtFixture(qmlScratch, true)
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projectPath, timeout: 5000 })
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Workbench Test'], { cwd: projectPath, timeout: 5000 })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'workbench-test@example.invalid'], { cwd: projectPath, timeout: 5000 })
  writeFileSync(join(projectPath, 'policy.txt'), 'gate policy\n')
  execFileSync('/usr/bin/git', ['add', 'policy.txt'], { cwd: projectPath, timeout: 5000 })
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'fixture'], { cwd: projectPath, timeout: 5000 })

  let runner: WorkbenchRunner = openWorkbenchRunner({ roots: { stateDir, runtimeDir } })
  let host: WorkbenchHost | null = null
  let bridgeClosed = false
  const streams: Array<{ owner: FakeStream; pi: FakeStream }> = []
  const hooks = new Map<string, (event: unknown, context: any) => void>()
  const sentTasks: string[] = []
  const view = new MemoryView()
  const opened: WorkbenchRunner[] = [runner]
  let faultPhase: AdmissionPhase | null = null
  let serial = 0
  const now = () => Date.now()
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => performance.now() })
  const connect = (onFrame: (frame: BridgeFrame) => void, onClose: () => void) => {
    const pair = fakePair(); streams.push(pair)
    attachBridgeStream(pair.owner, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
    return attachBridgeStream(pair.pi, { onFrame: (_peer, frame) => onFrame(frame), onClose })
  }
  const pi: Record<string, unknown> = {
    on(name: string, handler: (event: unknown, context: any) => void) { hooks.set(name, handler) },
    sendUserMessage(text: string) { sentTasks.push(text) },
  }
  const installExtension: PiBridgeExtension = createPiBridgeExtension({
    navigate: null,
    newId: prefix => `${prefix}-${(++serial).toString(16).padStart(32, '0')}`,
    schedule: (callback, delay) => setTimeout(callback, Math.min(delay, 500)),
    cancel: timer => clearTimeout(timer),
    connect,
  })
  installExtension(pi as never)
  const extension = installExtension
  let delivery!: AssignmentDeliveryCoordinator
  let authority!: WorkbenchAuthority
  const deliveryPromises: Array<Promise<unknown>> = []
  const makeAuthority = (sessionId: string) => new WorkbenchAuthority({
    runner, registry, sessionId, pluginGeneration: 7, clock: now,
    newId: prefix => `${prefix}${(++serial).toString(16).padStart(8, '0')}`,
    gateScratchRoot,
    onAdmissionPhase: phase => { if (faultPhase === phase) throw new Error(`fault:${phase}`) },
    onAssignmentAdmitted: admission => { deliveryPromises.push(delivery.deliver(admission.attemptId)) },
  })
  try {
    delivery = new AssignmentDeliveryCoordinator({ store: runner.store, registry, clock: now,
      newId: prefix => `${prefix}-${(++serial).toString(16)}` })
    authority = makeAuthority('session-composed-1')
    new CandidateSubmissionCoordinator({ store: runner.store, registry, clock: now,
      newId: prefix => `${prefix}-${(++serial).toString(16)}`,
      associate: input => authority.associateCandidate(input) })

    const inspection = authority.inspect(projectPath)
    assert.equal(inspection.supported, true, inspection.reasons.join(','))
    const project = authority.confirmRegistration(inspection.inspectionId)
    const goal = authority.createGoal(project.projectId, 'Ship the bounded assignment loop')
    const check = authority.createCheck(project.projectId, {
      name: 'Deterministic fake validator', summary: 'Zero-exit fixture only', mode: 'validator',
      commandSummary: 'Run /usr/bin/true', definitionDraft: {
        executable: '/usr/bin/true', argv: [], cwd: projectPath, environment: [],
        resourcePaths: [join(projectPath, 'policy.txt')], timeoutMs: 2000, outputBytes: 4096,
        maxCorrections: 1, elapsedMs: 60_000,
      },
    })

    hooks.get('session_start')!(null, {
      mode: 'tui', cwd: projectPath, sessionManager: { getSessionId: () => PI_SESSION },
      isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} },
    })
    await waitFor(() => registry.list().some(item => item.available))
    const observed = registry.list().find(item => item.available)!
    const proposal = authority.adoption.propose({ projectId: project.projectId, goalId: goal.goalId,
      role: 'implementer', observedSessionId: observed.observedSessionId })
    authority.adoption.authorize(proposal.proposalId)
    await waitFor(() => runner.store.getBinding(proposal.runId)?.state === 'ready')
    await waitFor(() => registry.projectContextMatches(proposal.runId, projectPath))

    host = createWorkbenchHost({ authority, view, clock: now })
    await host.start()
    assert.equal(view.projection?.selectedProjectId, project.projectId)
    assert.equal(view.projection?.selectedGoalId, goal.goalId)
    const context = { runId: proposal.runId, checkId: check.checkId, checkVersion: check.version,
      taskText: 'Write one deterministic Candidate. Do not change the Project.' }
    const directStart = authority.handleIntent({
      protocol: WORKBENCH_PROTOCOL, sessionId: authority.sessionId, pluginGeneration: authority.pluginGeneration,
      runnerEpoch: runner.epoch, intentId: 'direct-start-route-test', expectedRevision: view.projection!.revision,
      kind: 'start_assignment', target: proposal.runId, payload: { confirmationId: 'not-a-review', agentRunId: proposal.runId,
        goalText: goal.goalText, taskText: context.taskText, checkId: check.checkId, checkVersion: check.version,
        maxCorrections: 1, elapsedMs: 60_000 },
    })
    assert.equal(directStart.status, 'rejected')
    assert.equal(directStart.reasonCode, 'presentation_route_required')
    const initialPrepareAction = view.projection?.managedAgents.find(card => card.agentRunId === proposal.runId)?.actions
      .find(action => action.kind === 'prepare_start_review')
    assert.equal(initialPrepareAction?.enabled, true, JSON.stringify(initialPrepareAction))

    // The actual QML Start-review action emits a payload consumed by the real
    // WorkbenchAdapter and Runner. A revision change makes its old confirmation stale.
    const firstReview = await runQmlIntent(qmlScratch, view.projection!, 'prepare', context)
    assert.equal(firstReview.kind, 'prepare_start_review')
    view.enqueue(firstReview)
    host.tick({ heartbeat: true })
    const reviewDetail = view.projection?.details?.find(detail => detail.kind === 'start')
    assert.ok(reviewDetail && reviewDetail.kind === 'start')
    const stalePayload = (await runQmlIntent(qmlScratch, view.projection!, 'confirm', context)).payload
    const staleRevision = view.projection!.revision
    authority.commit('test_revision_advance', { projectId: project.projectId }, () => {})
    const staleOutcome = authority.handlePresentationIntent({
      protocol: WORKBENCH_PROTOCOL, sessionId: authority.sessionId, pluginGeneration: authority.pluginGeneration,
      runnerEpoch: runner.epoch, intentId: 'stale-start-confirmation', expectedRevision: staleRevision,
      kind: 'start_assignment', target: proposal.runId, payload: stalePayload,
    })
    assert.equal(staleOutcome.status, 'stale')
    assert.deepEqual(runner.store.listAssignments(), [])
    assert.deepEqual(sentTasks, [])

    // Prepare a fresh review, then inject one fault inside the atomic admission
    // transaction. No row, writer, receipt, outbox or Pi send may survive.
    host.tick({ heartbeat: true })
    const freshPrepare = await runQmlIntent(qmlScratch, view.projection!, 'prepare', context)
    view.enqueue(freshPrepare)
    host.tick({ heartbeat: true })
    const freshConfirm = await runQmlIntent(qmlScratch, view.projection!, 'confirm', context)
    assert.equal(freshConfirm.kind, 'start_assignment')
    faultPhase = 'delivery_queued'
    view.enqueue(freshConfirm)
    assert.throws(() => host!.tick({ heartbeat: true }), /fault:delivery_queued/)
    faultPhase = null
    const failedStartIntent = host.shell.adapter.pendingIntents.filter(entry => entry.intent.kind === 'start_assignment').at(-1)!.intent
    assert.equal(runner.store.getIntentResult(failedStartIntent.intentId), null)
    assert.deepEqual(runner.store.listAssignments(), [])
    assert.deepEqual(runner.store.listAssignmentDeliveries(), [])
    assert.equal(runner.store.getWriter(project.projectId), null)
    assert.deepEqual(sentTasks, [])

    // The same reviewed QML action can now be confirmed once. A durable replay
    // reads its receipt and cannot invoke the delivery coordinator a second time.
    view.enqueue(freshConfirm)
    host.tick({ heartbeat: true })
    await waitFor(() => deliveryPromises.length === 1)
    await deliveryPromises[0]
    const startIntent = host.shell.adapter.pendingIntents.filter(entry => entry.intent.kind === 'start_assignment').at(-1)!.intent
    const replay = authority.handlePresentationIntent(startIntent)
    assert.equal(replay.status, 'acknowledged')
    assert.equal(deliveryPromises.length, 1)
    assert.deepEqual(sentTasks, [context.taskText])
    const admitted = runner.store.listAssignments()[0]!
    const attempt = runner.store.listAttempts(admitted.assignmentId)[0]!
    assert.equal(runner.store.getAssignmentDelivery(attempt.attemptId)?.state, 'written')
    assert.equal(runner.store.getWriter(project.projectId)?.state, 'held')

    // The extension's dedicated structured Candidate port rejects both an old
    // Run and an old control epoch, then accepts one exact Candidate idempotently.
    const oldRun = await extension.submitCandidate({ assignmentId: admitted.assignmentId, attemptId: attempt.attemptId,
      agentRunId: 'retired-run', controlEpoch: attempt.controlEpoch, summary: 'late', artifactRefs: [] })
    assert.equal(oldRun.outcome, 'invalid')
    assert.equal(oldRun.reason, 'run_mismatch')
    const oldEpoch = await extension.submitCandidate({ assignmentId: admitted.assignmentId, attemptId: attempt.attemptId,
      agentRunId: proposal.runId, controlEpoch: attempt.controlEpoch + 1, summary: 'old epoch', artifactRefs: [] })
    assert.equal(oldEpoch.outcome, 'invalid')
    assert.equal(runner.store.getCandidateByAttempt(attempt.attemptId), null)
    const candidatePayload = { assignmentId: admitted.assignmentId, attemptId: attempt.attemptId,
      agentRunId: proposal.runId, controlEpoch: attempt.controlEpoch,
      summary: 'Candidate submitted through the dedicated structured port.', artifactRefs: [] }
    const submitted = await extension.submitCandidate(candidatePayload)
    assert.equal(submitted.outcome, 'accepted')
    const duplicate = await extension.submitCandidate(candidatePayload)
    assert.equal(duplicate.outcome, 'duplicate')
    assert.equal(runner.store.getAssignment(admitted.assignmentId)?.state, 'candidate')
    assert.equal(runner.store.listCandidates(admitted.assignmentId).length, 1)

    host.tick({ heartbeat: true })
    const candidateProjection = view.projection!
    const candidateCard = candidateProjection.assignments.find(item => item.assignmentId === admitted.assignmentId)!
    assert.equal(candidateCard.taskText, context.taskText)
    assert.equal(candidateCard.candidateRef, submitted.candidateId)
    assert.equal(candidateCard.gateResult, 'pending')
    assert.equal(candidateProjection.managedAgents.find(card => card.agentRunId === proposal.runId)?.actions
      .find(action => action.kind === 'accept')?.enabled, true)
    const acceptIntent = await runQmlIntent(qmlScratch, candidateProjection, 'accept', { ...context, assignmentId: admitted.assignmentId })
    assert.equal(acceptIntent.kind, 'accept')
    view.enqueue(acceptIntent)
    host.tick({ heartbeat: true })
    await waitFor(() => runner.store.getAssignment(admitted.assignmentId)?.state === 'accepted')
    const result = runner.store.getGateResult(attempt.attemptId)
    assert.equal(result?.outcome, 'pass')
    assert.equal(result?.state, 'accepted')
    assert.equal(runner.store.getWriter(project.projectId)?.state, 'none')
    assert.equal(execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 }), '')

    // Reopen the real SQLite store and build a fresh authoritative projection.
    // The transient review is gone, while accepted Assignment/Candidate/Gate facts remain.
    host.stop(); host = null
    hooks.get('session_shutdown')?.(null, null)
    bridgeClosed = true
    runner.close()
    runner = openWorkbenchRunner({ roots: { stateDir, runtimeDir } })
    opened.push(runner)
    const reopenedAuthority = new WorkbenchAuthority({ runner, sessionId: 'session-reopened', pluginGeneration: 7,
      clock: now, gateScratchRoot })
    const reopened = buildSnapshot({ authority: reopenedAuthority, adoption: reopenedAuthority.adoption, connection: 'disconnected' })
    const reopenedCard = reopened.assignments.find(item => item.assignmentId === admitted.assignmentId)
    assert.ok(reopenedCard)
    assert.equal(reopenedCard.state, 'accepted')
    assert.equal(reopenedCard.taskText, context.taskText)
    assert.equal(reopenedCard.candidateRef, submitted.candidateId)
    assert.equal(reopenedCard.gateResult, 'pass')
    assert.equal(reopened.details?.some(detail => detail.kind === 'start') ?? false, false)
    assert.equal(runner.store.getWriter(project.projectId)?.state, 'none')
    reopenedAuthority.runner.close()
  } finally {
    if (host) { try { host.stop() } catch {} }
    if (!bridgeClosed) { try { hooks.get('session_shutdown')?.(null, null) } catch {} }
    for (const stream of streams) { try { stream.owner.destroy() } catch {} }
    for (const openedRunner of opened) { try { openedRunner.close() } catch {} }
    rmSync(root, { recursive: true, force: true })
  }
})
