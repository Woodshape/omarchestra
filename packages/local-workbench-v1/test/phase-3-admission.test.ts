/**
 * AL-02 durable admission: one exact confirmed review commits the Assignment,
 * Attempt, held Project writer epoch, event/revision, complete intent receipt
 * and queued delivery outbox in one transaction. Fault, concurrency, exact
 * replay and reopen all leave no partial admission and never send or release
 * uncertain authority. `start_assignment` stays rejected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSIGNMENT_DELIVERY_TTL_MS, WorkbenchAuthority, START_UNAVAILABLE_REASON, type AdmissionPhase } from '../runner/authority.ts'
import { openWorkbenchRunner, type WorkbenchRunner } from '../runner/runner.ts'
import { inspectProjectPath } from '../runner/git-context.ts'
import { canonicalJson, projectExecutionContextDigest, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { WORKBENCH_PROTOCOL } from '../console/schema.ts'
import type { StartProposal, StartProposalRequest } from '../runner/start-proposal.ts'
import type { BridgeRegistry } from '../runner/bridge-registry.ts'

const CHALLENGE = 'c'.repeat(32)
const CONNECTION = 'i'.repeat(32)

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, error => (error as { code?: string }).code === code)
}

interface Fixture {
  stateDir: string
  runner: WorkbenchRunner
  authority: WorkbenchAuthority
  request: StartProposalRequest
  intentId: string
  buildIntent: (overrides?: Record<string, unknown>, proposal?: StartProposal) => unknown
  close: () => void
  reopen: () => WorkbenchRunner
}

function fixture(t: test.TestContext, admissionFault?: (phase: AdmissionPhase) => void): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'wb-admission-'))
  const projectPath = join(base, 'worktree')
  const stateDir = join(base, 'state')
  mkdirSync(projectPath)
  mkdirSync(stateDir, { mode: 0o700 })
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Workbench Test'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'workbench-test@example.invalid'], { cwd: projectPath })
  writeFileSync(join(projectPath, 'README.md'), 'baseline\n')
  writeFileSync(join(projectPath, 'policy.txt'), 'policy-v1\n')
  execFileSync('/usr/bin/git', ['add', 'README.md', 'policy.txt'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'fixture'], { cwd: projectPath })

  const clock = () => 1000
  let counter = 0
  const newId = (prefix: string) => `${prefix}${(counter += 1).toString().padStart(3, '0')}`
  const open = () => openWorkbenchRunner({ roots: { stateDir }, clock, newId })
  const runner = open()
  const opened = new Set<WorkbenchRunner>([runner])
  const closed = new Set<WorkbenchRunner>()
  const closeRunner = (target: WorkbenchRunner) => { if (closed.has(target)) return; target.close(); closed.add(target) }
  t.after(() => {
    for (const item of opened) if (!closed.has(item)) item.close()
    rmSync(base, { recursive: true, force: true })
  })

  const inspection = inspectProjectPath(projectPath)
  assert.equal(inspection.supported, true, inspection.reasons.join(','))
  const project = {
    projectId: 'project-1', executionNodeId: runner.nodeId, canonicalPath: inspection.canonicalPath,
    gitCommonDir: inspection.gitCommonDir!, headOid: inspection.headOid, dirty: inspection.dirty!,
    contextDigest: inspection.repositoryIdentity!, revision: 1, createdAt: 1,
  }
  runner.store.putProject(project)
  runner.store.insertGoal({ goalId: 'goal-1', projectId: 'project-1', goalText: 'Ship the workbench loop', state: 'active', outcome: null, createdAt: 1 })
  runner.store.setMeta('selected_project_id', 'project-1')
  runner.store.setMeta('selected_goal_id', 'goal-1')

  const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
    name: 'Build check', summary: 'Confirm build behavior', mode: 'validator', commandSummary: 'Run fixed validator',
    definitionDraft: {
      executable: '/usr/bin/true', argv: [], cwd: project.canonicalPath, environment: [],
      resourcePaths: [join(project.canonicalPath, 'policy.txt')], timeoutMs: 1000,
      outputBytes: 4096, maxCorrections: 2, elapsedMs: 60_000,
    },
  })
  const checkJson = canonicalJson(definition)
  runner.store.putCheck({
    projectId: 'project-1', checkId: 'check-1', version: 1, digest: sha256(checkJson),
    canonicalJson: checkJson, name: definition.name, mode: definition.mode, createdAt: 1,
  })

  const incarnation = { executionNodeId: runner.nodeId, processInstanceId: 'proc-1', piSessionId: 'session-pi', extensionInstanceId: 'ext-1' }
  const binding = {
    runId: 'run-1', projectId: 'project-1', role: 'builder', state: 'committed' as const,
    bindingDigest: sha256('binding'), controlEpoch: 7, writerState: 'none' as const,
    predecessorRunId: null, generation: 1, updatedAt: 1,
  }
  runner.store.putBinding(binding)
  runner.store.putBindingIdentity('run-1', 'goal-1', incarnation)
  runner.store.commitMembership('run-1')
  runner.store.putBinding({ ...binding, state: 'ready' })

  const observation = {
    observedSessionId: 'observed-1', sessionCode: null, navigation: null,
    incarnation: { ...incarnation }, lifecycle: 'running', activity: 'idle', health: 'healthy',
    available: true, mode: 'committed' as const,
    executionContextDigest: projectExecutionContextDigest(project.canonicalPath), executionContextAt: 1000,
  }
  const registry = {
    setManagementHandlers(): void {},
    setHandoffHandler(): void {},
    controlTarget() { return null },
    list() { return [observation] },
    listCurrent() { return [observation] },
    currentBinding(observedSessionId: string) {
      if (observedSessionId !== observation.observedSessionId) return null
      return { observation, connectionId: CONNECTION, challenge: CHALLENGE, peer: { send(): void {}, close(): void {} } }
    },
    assignmentLoopAvailable() { return true },
    projectContextMatches(runId: string, canonicalPath: string) {
      return runId === 'run-1' && canonicalPath === project.canonicalPath
    },
  }
  const authority = new WorkbenchAuthority({
    runner, sessionId: 'session-1', pluginGeneration: 1, clock, newId,
    registry: registry as unknown as BridgeRegistry,
    ...(admissionFault === undefined ? {} : { onAdmissionPhase: admissionFault }),
  })

  const request: StartProposalRequest = {
    projectId: 'project-1', goalId: 'goal-1', agentRunId: 'run-1', checkId: 'check-1', checkVersion: 1,
    taskText: 'Implement the bounded assignment loop.\nReport the changed files.',
    limits: { maxCorrections: 2, elapsedMs: 60_000 }, expectedRevision: authority.revisionOf(),
  }
  const intentId = 'intent-admit-1'
  const buildIntent = (overrides: Record<string, unknown> = {}, proposal?: StartProposal) => ({
    protocol: WORKBENCH_PROTOCOL,
    sessionId: 'session-1',
    pluginGeneration: 1,
    runnerEpoch: runner.epoch,
    intentId,
    expectedRevision: authority.revisionOf(),
    kind: 'start_assignment',
    target: 'run-1',
    payload: { confirmationId: proposal?.confirmationId ?? 'confirmation-1', agentRunId: 'run-1',
      goalText: 'Ship the workbench loop', taskText: request.taskText, checkId: 'check-1', checkVersion: 1,
      maxCorrections: request.limits.maxCorrections, elapsedMs: request.limits.elapsedMs },
    ...overrides,
  })
  return {
    stateDir, runner, authority, request, intentId, buildIntent,
    close: () => closeRunner(runner),
    reopen: () => { const next = open(); opened.add(next); return next },
  }
}

test('one exact confirmation commits Assignment, Attempt, writer, event, receipt and queued outbox atomically', t => {
  const f = fixture(t)
  const proposal = f.authority.prepareStartAssignment(f.request)
  assert.deepEqual(f.runner.store.listAssignments(), [])
  assert.deepEqual(f.runner.store.listAssignmentDeliveries(), [])

  const outcome = f.authority.confirmStartAssignment({ intent: f.buildIntent({}, proposal), proposal })
  assert.equal(outcome.status, 'acknowledged')
  assert.equal(outcome.replayed, false)
  assert.equal(outcome.writerEpoch, 1)
  assert.equal(outcome.committedRevision, 1)
  assert.equal(outcome.assignmentId, proposal.assignment.assignmentId)
  assert.equal(outcome.attemptId, proposal.attempt.attemptId)
  assert.equal(outcome.deliveryId, proposal.attempt.deliveryId)
  assert.equal(f.authority.revisionOf(), 1)

  const assignment = f.runner.store.getAssignment(outcome.assignmentId)
  assert.equal(assignment?.state, 'admitted')
  assert.equal(assignment?.revision, 1)
  assert.equal(assignment?.writeAuthority, true)
  const attempt = f.runner.store.getAttempt(outcome.attemptId)
  assert.equal(attempt?.state, 'admitted')
  assert.equal(attempt?.ordinal, 1)
  assert.equal(attempt?.deliveryId, outcome.deliveryId)
  assert.equal(attempt?.writerEpoch, 1)
  assert.equal(f.runner.store.getWriter('project-1')?.state, 'held')
  assert.equal(f.runner.store.activeAssignment('project-1')?.assignmentId, outcome.assignmentId)

  const delivery = f.runner.store.getAssignmentDelivery(outcome.attemptId)
  assert.equal(delivery?.state, 'queued')
  assert.equal(delivery?.reasonCode, null)
  assert.equal(delivery?.deadline, 1000 + ASSIGNMENT_DELIVERY_TTL_MS)
  assert.equal(delivery?.payloadDigest, sha256(delivery!.frameJson))
  assert.ok(Buffer.byteLength(delivery!.frameJson) > 0)

  const receipt = f.runner.store.getIntentResult(f.intentId)
  assert.equal(receipt?.status, 'acknowledged')
  assert.equal(receipt?.committedRevision, 1)
  assert.ok(receipt?.payloadHash && receipt.payloadHash.length === 64)
  assert.match(receipt!.detail ?? '', /assignmentId/)

  const rejected = f.authority.handleIntent(f.buildIntent({ intentId: 'intent-disabled' }, proposal))
  assert.equal(rejected.status, 'rejected')
  assert.equal(rejected.reasonCode, 'presentation_route_required')
  assert.equal(rejected.reason, 'Start confirmation is accepted only through the current presentation route.')
  assert.equal(f.runner.store.listAssignments().length, 1)
})

test('exact envelope replay reads the retained receipt and conflicting reuse is refused', t => {
  const f = fixture(t)
  const proposal = f.authority.prepareStartAssignment(f.request)
  const intent = f.buildIntent({}, proposal)
  const first = f.authority.confirmStartAssignment({ intent, proposal })
  const replay = f.authority.confirmStartAssignment({ intent, proposal })
  assert.equal(replay.replayed, true)
  assert.equal(replay.assignmentId, first.assignmentId)
  assert.equal(replay.deliveryId, first.deliveryId)
  assert.equal(f.runner.store.listAssignments().length, 1)
  assert.equal(f.runner.store.listAssignmentDeliveries().length, 1)

  const g = fixture(t)
  g.runner.store.putIntentResult({
    intentId: g.intentId, sessionId: 'session-1', payloadHash: 'f'.repeat(64), status: 'rejected',
    reasonCode: 'invalid_input', reason: 'prior', detail: null, committedRevision: null, createdAt: 1,
  })
  const stale = g.authority.prepareStartAssignment(g.request)
  expectCode('identity_drift', () => g.authority.confirmStartAssignment({ intent: g.buildIntent({}, stale), proposal: stale }))
  assert.deepEqual(g.runner.store.listAssignments(), [])
})

test('stale, tampered and revision-drifted proposals are rejected without admission', t => {
  const f = fixture(t)
  const proposal = f.authority.prepareStartAssignment(f.request)
  writeFileSync(join(f.runner.store.getProject('project-1')!.canonicalPath, 'drift.txt'), 'drifted\n')
  expectCode('identity_drift', () => f.authority.confirmStartAssignment({ intent: f.buildIntent({}, proposal), proposal }))
  assert.deepEqual(f.runner.store.listAssignments(), [])

  const g = fixture(t)
  const tampered = structuredClone(g.authority.prepareStartAssignment(g.request))
  tampered.assignment.taskText = 'substituted task'
  expectCode('identity_drift', () => g.authority.confirmStartAssignment({ intent: g.buildIntent({}, tampered), proposal: tampered }))
  assert.deepEqual(g.runner.store.listAssignments(), [])

  const h = fixture(t)
  const reviewed = h.authority.prepareStartAssignment(h.request)
  h.authority.createGoal('project-1', 'A second Goal')
  expectCode('identity_drift', () => h.authority.confirmStartAssignment({ intent: h.buildIntent({}, reviewed), proposal: reviewed }))
  assert.deepEqual(h.runner.store.listAssignments(), [])
})

test('a second concurrent start, a held writer and an uncertain writer are all refused', t => {
  const f = fixture(t)
  const first = f.authority.prepareStartAssignment(f.request)
  const second = f.authority.prepareStartAssignment(f.request)
  f.authority.confirmStartAssignment({ intent: f.buildIntent({}, first), proposal: first })
  expectCode('identity_drift', () => f.authority.confirmStartAssignment({ intent: f.buildIntent({ intentId: 'intent-2' }, second), proposal: second }))
  assert.equal(f.runner.store.listAssignments().length, 1)
  assert.equal(f.runner.store.listAssignmentDeliveries().length, 1)

  expectCode('invalid_input', () => f.authority.prepareStartAssignment({ ...f.request, expectedRevision: f.authority.revisionOf() }))

  const g = fixture(t)
  g.runner.store.acquireWriter({ projectId: 'project-1', assignmentId: null, attemptId: null, epoch: 1, updatedAt: 1 })
  assert.equal(g.runner.store.markWriterUncertain('project-1', 1), true)
  assert.equal(g.runner.store.getWriter('project-1')?.state, 'uncertain')
  expectCode('invalid_input', () => g.authority.prepareStartAssignment(g.request))
  expectCode('fence_conflict', () => g.runner.store.releaseWriter('project-1', 1))
})

test('a transaction fault at any boundary leaves no writer, outbox or receipt', t => {
  for (const phase of ['assignment_written', 'attempt_written', 'writer_held', 'delivery_queued', 'receipt_recorded'] as const) {
    const f = fixture(t, current => { if (current === phase) throw new Error(`fault:${phase}`) })
    const proposal = f.authority.prepareStartAssignment(f.request)
    assert.throws(() => f.authority.confirmStartAssignment({ intent: f.buildIntent({}, proposal), proposal }), new RegExp(`fault:${phase}`))
    assert.equal(f.runner.store.getAssignment(proposal.assignment.assignmentId), null, phase)
    assert.equal(f.runner.store.getAttempt(proposal.attempt.attemptId), null, phase)
    assert.equal(f.runner.store.getWriter('project-1'), null, phase)
    assert.deepEqual(f.runner.store.listAssignmentDeliveries(), [], phase)
    assert.equal(f.runner.store.getIntentResult(f.intentId), null, phase)
    assert.equal(f.authority.revisionOf(), 0, phase)
  }
})

test('reopen recovers queued admission as an unsent outbox and uncertain writer, never sends or releases', t => {
  const f = fixture(t)
  const proposal = f.authority.prepareStartAssignment(f.request)
  const outcome = f.authority.confirmStartAssignment({ intent: f.buildIntent({}, proposal), proposal })
  f.close()

  const reopened = f.reopen()
  assert.deepEqual(reopened.recovery.assignmentDeliveriesRecovered, [outcome.deliveryId])
  assert.deepEqual(reopened.recovery.uncertainWriters, ['project-1'])
  assert.equal(reopened.store.getWriter('project-1')?.state, 'uncertain')
  assert.equal(reopened.store.getAssignmentDelivery(outcome.attemptId)?.state, 'not_sent')
  assert.equal(reopened.store.getAssignmentDelivery(outcome.attemptId)?.reasonCode, 'owner_restarted')
  assert.equal(reopened.store.getAssignment(outcome.assignmentId)?.state, 'admitted')
  assert.equal(reopened.store.getAttempt(outcome.attemptId)?.state, 'admitted')
  assert.ok(reopened.store.listAssignmentDeliveries().every(item => item.state === 'not_sent' || item.state === 'queued'))
  expectCode('fence_conflict', () => reopened.store.releaseWriter('project-1', 1))
  reopened.close()

  const stable = f.reopen()
  assert.deepEqual(stable.recovery.assignmentDeliveriesRecovered, [])
  assert.deepEqual(stable.recovery.uncertainWriters, [])
  assert.equal(stable.store.getAssignmentDelivery(outcome.attemptId)?.state, 'not_sent')
  stable.close()
})
