/**
 * AL-06 intervention. Stop durably revokes future dispatch first and never
 * claims Pi/tool termination; a superseded control epoch fences stale Candidate
 * and pass results; takeover pauses automatic delivery and retains the writer;
 * return-to-team is one exact structured handoff followed by explicit
 * reconciliation; correction stays inside the persisted limits and restart
 * blocks automatic continuation through an uncertain writer. `start_assignment`
 * stays disabled.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner, type WorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority, START_UNAVAILABLE_REASON } from '../runner/authority.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { handoffDigest } from '../runner/store.ts'
import { buildSnapshot } from '../runner/projection.ts'

const PROCESS_ID = 'process-' + 'a'.repeat(32)
const EXTENSION_ID = 'extension-' + 'b'.repeat(32)
const PI_SESSION = 'pi-session'
const ASSIGNMENT_ID = 'assignment-1'
const ATTEMPT_ID = 'attempt-1'
const DELIVERY_ID = 'delivery-1'

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, error => (error as { code?: string }).code === code)
}

type SeedState = 'admitted' | 'running' | 'candidate' | 'validating' | 'attention'

interface SeedOptions {
  state?: SeedState
  maxCorrections?: number
  elapsedMs?: number
  delivery?: boolean
}

interface Seed {
  assignmentId: string
  attemptId: string
  deliveryId: string
  runId: string
  checkJson: string
  executableDigest: string
}

interface Fixture {
  root: string
  stateDir: string
  runner: WorkbenchRunner
  authority: WorkbenchAuthority
  projectId: string
  goalId: string
  now: () => number
  setNow: (value: number) => void
  seed: (runId: string, options?: SeedOptions) => Seed
  seedValidating: (runId: string) => Seed & { candidateId: string; candidateDigest: string }
  reopen: () => WorkbenchRunner
}

const CHAIN: Array<{ state: SeedState; revision: number }> = [
  { state: 'admitted', revision: 1 },
  { state: 'dispatching' as SeedState, revision: 2 },
  { state: 'running', revision: 3 },
  { state: 'candidate', revision: 4 },
  { state: 'validating' as SeedState, revision: 5 },
  { state: 'attention', revision: 6 },
]

const TARGET_INDEX: Record<SeedState, number> = { admitted: 0, running: 2, candidate: 3, validating: 4, attention: 5 }

function setup(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-assignment-intervention-'))
  const stateDir = join(root, 'state')
  let now = 1000
  const open = () => openWorkbenchRunner({ roots: { stateDir } })
  const runner = open()
  const opened = new Set<WorkbenchRunner>([runner])
  const closed = new Set<WorkbenchRunner>()
  const closeRunner = (target: WorkbenchRunner) => { if (closed.has(target)) return; target.close(); closed.add(target) }
  t.after(() => {
    for (const item of opened) if (!closed.has(item)) item.close()
    rmSync(root, { recursive: true, force: true })
  })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, clock: () => now })

  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  writeFileSync(join(projectPath, 'policy.txt'), 'policy-v1\n')
  execFileSync('/usr/bin/git', ['init', '--quiet', projectPath], { timeout: 5_000 })
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.name', 'Workbench Test'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.email', 'workbench-test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'add', 'policy.txt'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'commit', '-q', '-m', 'fixture'])

  const inspection = authority.inspect(projectPath)
  const projectId = authority.confirmRegistration(inspection.inspectionId).projectId
  const goalId = 'goal-1'
  runner.store.insertGoal({ goalId, projectId, goalText: 'explicit goal', state: 'active', outcome: null, createdAt: now })
  runner.store.setMeta('selected_goal_id', goalId)

  const storeCheck = (): { checkJson: string; executableDigest: string } => {
    const project = runner.store.getProject(projectId)!
    const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
      name: 'Gate check', summary: 'Bounded deterministic validator', mode: 'validator',
      commandSummary: 'Run the frozen deterministic checker',
      definitionDraft: {
        executable: '/usr/bin/true', argv: [], cwd: project.canonicalPath, environment: [],
        resourcePaths: [join(project.canonicalPath, 'policy.txt')],
        timeoutMs: 5000, outputBytes: 4096, maxCorrections: 2, elapsedMs: 60_000,
      },
    })
    const checkJson = canonicalJson(definition)
    runner.store.putCheck({
      projectId, checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson,
      name: definition.name, mode: definition.mode, createdAt: now,
    })
    return { checkJson, executableDigest: definition.executableDigest }
  }

  const seed = (runId: string, options: SeedOptions = {}): Seed => {
    const project = runner.store.getProject(projectId)!
    const { checkJson, executableDigest } = storeCheck()
    const bindingDigest = sha256('binding-' + runId)
    const gate = { checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson }
    const context = {
      projectId, executionNodeId: runner.nodeId, canonicalPath: project.canonicalPath, gitCommonDir: project.gitCommonDir,
      repositoryIdentity: project.contextDigest, headOid: project.headOid ?? 'a'.repeat(40), dirty: project.dirty,
      baselineDigest: sha256('baseline'), manifestDigest: sha256('manifest'),
    }
    const limits = { maxCorrections: options.maxCorrections ?? 2, elapsedMs: options.elapsedMs ?? 60_000 }
    runner.store.putBinding({
      runId, projectId, role: 'implementer', state: 'ready', bindingDigest, controlEpoch: 1,
      writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: now,
    })
    runner.store.putBindingIdentity(runId, goalId, {
      executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION, extensionInstanceId: EXTENSION_ID,
    })
    runner.store.transaction(() => {
      runner.store.putAssignment({
        assignmentId: ASSIGNMENT_ID, projectId, goalId, agentRunId: runId, bindingDigest, goalText: 'explicit goal',
        taskText: 'Implement the bounded assignment loop.', writeAuthority: false, state: 'admitted',
        limits, attemptCount: 0, revision: 1, createdAt: now, updatedAt: now,
      })
      runner.store.putAttempt({
        attemptId: ATTEMPT_ID, assignmentId: ASSIGNMENT_ID, ordinal: 1, state: 'admitted',
        runBinding: {
          executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION,
          extensionInstanceId: EXTENSION_ID, runId, goalId, bindingDigest, connectionId: 'connection-1', connectionChallenge: 'c'.repeat(32),
        },
        gate, context, limits, writerEpoch: 1, controlEpoch: 1, deliveryId: DELIVERY_ID, createdAt: now, updatedAt: now,
      })
      runner.store.acquireWriter({ projectId, assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, epoch: 1, updatedAt: now })
      if (options.delivery !== false) {
        runner.store.putAssignmentDelivery({
          deliveryId: DELIVERY_ID, assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, runId, frameJson: '{}',
          payloadDigest: sha256('{}'), state: 'queued', reasonCode: null, deadline: now + 30_000, createdAt: now,
        })
      }
      const target = TARGET_INDEX[options.state ?? 'running']
      for (let i = 1; i <= target; i += 1) {
        const from = CHAIN[i - 1]!.state
        const to = CHAIN[i]!
        runner.store.transitionAssignment(ASSIGNMENT_ID, from, to.state, to.revision, now)
        runner.store.transitionAttempt(ATTEMPT_ID, from, to.state, now)
      }
    })
    return { assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, deliveryId: DELIVERY_ID, runId, checkJson, executableDigest }
  }

  const seedValidating = (runId: string): Seed & { candidateId: string; candidateDigest: string } => {
    const seeded = seed(runId, { state: 'candidate' })
    runner.store.submitCandidate({
      candidateId: 'candidate-1', createdAt: now,
      submission: {
        assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, agentRunId: runId,
        controlEpoch: 1, summary: 'Implemented the bounded loop.', artifactRefs: [],
      },
    })
    const candidate = runner.store.getCandidateByAttempt(seeded.attemptId)!
    runner.store.transitionAssignment(seeded.assignmentId, 'candidate', 'validating', 5, now)
    runner.store.transitionAttempt(seeded.attemptId, 'candidate', 'validating', now)
    const attempt = runner.store.getAttempt(seeded.attemptId)!
    runner.store.putGateResult({
      resultId: 'result-1', assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: candidate.candidateId,
      gateDigest: attempt.gate.digest, executableDigest: seeded.executableDigest, outcome: 'pass',
      preManifestDigest: attempt.context.manifestDigest, postManifestDigest: attempt.context.manifestDigest,
      exitCode: 0, reasonCode: null, evidenceJson: '{}', state: 'provisional', revision: 1, createdAt: now,
    })
    return { ...seeded, candidateId: candidate.candidateId, candidateDigest: candidate.digest }
  }

  const reopen = (): WorkbenchRunner => {
    closeRunner(runner)
    const next = open()
    opened.add(next)
    return next
  }

  return {
    root, stateDir, runner, authority, projectId, goalId,
    now: () => now, setNow: (value: number) => { now = value },
    seed, seedValidating, reopen,
  }
}

test('stop revokes queued dispatch, records a durable stop, and retains the writer as uncertain', t => {
  const s = setup(t)
  s.seed('run-stop')
  const outcome = s.authority.stopAssignment({ assignmentId: ASSIGNMENT_ID })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.dispatchRevoked, true)
  assert.equal(outcome.writerState, 'uncertain', 'a dispatched but unacknowledged Attempt retains the writer')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'stopped')
  assert.equal(s.runner.store.getAttempt(ATTEMPT_ID)!.state, 'stopped')
  const delivery = s.runner.store.getAssignmentDelivery(ATTEMPT_ID)!
  assert.equal(delivery.state, 'not_sent')
  assert.equal(delivery.reasonCode, 'revoked')
  const stop = s.runner.store.getStop(ASSIGNMENT_ID)!
  assert.equal(stop.trigger, 'operator')
  assert.equal(stop.cancellationStatus, 'not_requested', 'cancellation is a separate untested capability, never implied by stop')
  assert.equal(stop.dispatchRevoked, true)
})

test('stop replay returns the exact committed stop and never dispatches again', t => {
  const s = setup(t)
  s.seed('run-stop-replay')
  const first = s.authority.stopAssignment({ assignmentId: ASSIGNMENT_ID })
  const second = s.authority.stopAssignment({ assignmentId: ASSIGNMENT_ID })
  assert.equal(second.replayed, true)
  assert.equal(second.stopId, first.stopId)
  assert.equal(s.runner.store.listStops().length, 1)
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain')
})

test('stop before any send releases the writer because no effect is possible', t => {
  const s = setup(t)
  s.seed('run-stop-early', { state: 'admitted' })
  const outcome = s.authority.stopAssignment({ assignmentId: ASSIGNMENT_ID })
  assert.equal(outcome.writerState, 'none')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'stopped')
  assert.equal(s.runner.store.getAssignmentDelivery(ATTEMPT_ID)!.state, 'not_sent')
})

test('stop is refused for a terminal accepted Assignment', t => {
  const s = setup(t)
  s.seed('run-stop-terminal', { state: 'validating' })
  s.runner.store.transitionAssignment(ASSIGNMENT_ID, 'validating', 'accepted', 9, s.now())
  expectCode('fence_conflict', () => s.authority.stopAssignment({ assignmentId: ASSIGNMENT_ID }))
})

test('takeover advances the control epoch, pauses dispatch, and retains the writer', t => {
  const s = setup(t)
  s.seed('run-takeover')
  const outcome = s.authority.takeAssignmentControl({ assignmentId: ASSIGNMENT_ID })
  assert.equal(outcome.controlEpoch, 2)
  assert.equal(s.runner.store.getBinding('run-takeover')!.controlEpoch, 2)
  assert.equal(s.runner.store.getBinding('run-takeover')!.state, 'manual_takeover')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'attention')
  assert.equal(s.runner.store.getAttempt(ATTEMPT_ID)!.state, 'attention')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held', 'already running tools may continue')
  assert.equal(s.runner.store.getAssignmentDelivery(ATTEMPT_ID)!.state, 'not_sent')
})

test('a stale Candidate from a superseded control epoch never writes', t => {
  const s = setup(t)
  s.seed('run-stale-candidate')
  s.authority.takeAssignmentControl({ assignmentId: ASSIGNMENT_ID })
  expectCode('identity_drift', () => s.runner.store.submitCandidate({
    candidateId: 'candidate-late', createdAt: s.now(),
    submission: {
      assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, agentRunId: 'run-stale-candidate',
      controlEpoch: 1, summary: 'Late candidate.', artifactRefs: [],
    },
  }))
  assert.equal(s.runner.store.getCandidateByAttempt(ATTEMPT_ID), null)
})

test('a late pass under a superseded control epoch is nonaccepting', t => {
  const s = setup(t)
  const seeded = s.seedValidating('run-late-pass')
  // A takeover advances the Run control epoch without rewriting the frozen Attempt.
  s.runner.store.setBindingControlEpoch('run-late-pass', 2, s.now())
  s.runner.store.setBindingState('run-late-pass', 'manual_takeover', s.now())
  const attempt = s.runner.store.getAttempt(ATTEMPT_ID)!
  const resolution = s.runner.store.resolveGateAcceptance({
    resultId: 'result-1', assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, candidateId: seeded.candidateId,
    candidateDigest: seeded.candidateDigest, gateDigest: attempt.gate.digest, executableDigest: seeded.executableDigest,
    outcome: 'pass', postManifestDigest: attempt.context.manifestDigest, acceptanceManifestDigest: attempt.context.manifestDigest,
    acceptanceScanError: null, quiescenceConfirmed: true, quiescenceReason: null, revision: 2, updatedAt: s.now(),
  })
  assert.deepEqual(resolution, { accepted: false, reasonCode: 'control_epoch_changed' })
  assert.equal(s.runner.store.getGateResult(ATTEMPT_ID)!.state, 'nonaccepting')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'attention')
})

test('a handoff is refused before an explicit takeover', t => {
  const s = setup(t)
  s.seed('run-handoff-early', { state: 'attention' })
  expectCode('fence_conflict', () => s.authority.recordAssignmentHandoff({
    attemptId: ATTEMPT_ID, claimedState: 'partial', summary: 'Half done.', artifactRefs: [], outstandingEffects: 'unknown',
  }))
})

test('return-to-team records one structured handoff and enters reconciliation', t => {
  const s = setup(t)
  s.seed('run-handoff')
  s.authority.takeAssignmentControl({ assignmentId: ASSIGNMENT_ID })
  const outcome = s.authority.recordAssignmentHandoff({
    attemptId: ATTEMPT_ID, claimedState: 'candidate', summary: 'Implemented, tests unrun.', artifactRefs: [],
    outstandingEffects: 'may_be_active',
  })
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'reconciling')
  const stored = s.runner.store.getHandoff(ATTEMPT_ID)!
  assert.equal(stored.handoffId, outcome.handoffId)
  assert.equal(stored.controlEpoch, 2)
  assert.equal(stored.claimedState, 'candidate')
  assert.equal(outcome.digest, handoffDigest({
    assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, agentRunId: 'run-handoff', controlEpoch: 2,
    claimedState: 'candidate', summary: 'Implemented, tests unrun.', artifactRefs: [], outstandingEffects: 'may_be_active',
  }))
})

test('reconciliation refuses a stale projection revision', t => {
  const s = setup(t)
  s.seed('run-stale-reconcile', { state: 'attention' })
  expectCode('fence_conflict', () => s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'retry', expectedRevision: s.authority.revisionOf() - 1,
  }))
})

test('an explicit retry creates the next Attempt under the same frozen gate', t => {
  const s = setup(t)
  const seeded = s.seed('run-retry', { state: 'attention' })
  const prior = s.runner.store.getAttempt(ATTEMPT_ID)!
  const outcome = s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'retry', expectedRevision: s.authority.revisionOf(),
  })
  assert.equal(outcome.status, 'admitted')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'dispatching')
  assert.equal(s.runner.store.getAttempt(ATTEMPT_ID)!.state, 'rejected')
  const next = s.runner.store.getAttempt(outcome.attemptId!)!
  assert.equal(next.ordinal, 2)
  assert.equal(next.state, 'dispatching')
  assert.equal(next.gate.digest, prior.gate.digest, 'the frozen gate never changes between Attempts')
  assert.equal(next.runBinding.runId, seeded.runId)
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.attemptCount, 2)
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held')
  assert.equal(s.runner.store.getWriter(s.projectId)!.epoch, 2)
  assert.equal(s.runner.store.getAssignmentDelivery(outcome.attemptId!)!.state, 'queued')
  assert.equal(s.runner.store.getAssignmentDelivery(ATTEMPT_ID)!.state, 'not_sent')
})

test('a resume requires the exact retained handoff and readiness', t => {
  const s = setup(t)
  s.seed('run-resume')
  s.authority.takeAssignmentControl({ assignmentId: ASSIGNMENT_ID })
  const handoff = s.authority.recordAssignmentHandoff({
    attemptId: ATTEMPT_ID, claimedState: 'candidate', summary: 'Done.', artifactRefs: [], outstandingEffects: 'none_reported',
  })
  expectCode('fence_conflict', () => s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'resume', expectedRevision: s.authority.revisionOf(),
  }))
  expectCode('fence_conflict', () => s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'resume', expectedRevision: s.authority.revisionOf(), handoffId: 'handoff-other',
  }))
  s.runner.store.setBindingState('run-resume', 'ready', s.now())
  const outcome = s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'resume', expectedRevision: s.authority.revisionOf(), handoffId: handoff.handoffId,
  })
  assert.equal(outcome.status, 'admitted')
  assert.equal(s.runner.store.getAttempt(outcome.attemptId!)!.ordinal, 2)
})

test('an exhausted correction budget stops dispatch instead of granting a new Attempt', t => {
  const s = setup(t)
  s.seed('run-budget', { state: 'attention', maxCorrections: 0 })
  const outcome = s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'retry', expectedRevision: s.authority.revisionOf(),
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.reasonCode, 'attempt_limit_exhausted')
  assert.equal(s.runner.store.getAssignment(ASSIGNMENT_ID)!.state, 'stopped')
  assert.equal(s.runner.store.getStop(ASSIGNMENT_ID)!.trigger, 'attempt_limit')
  assert.equal(s.runner.store.listAttempts(ASSIGNMENT_ID).length, 1)
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain')
})

test('an elapsed budget stops dispatch instead of granting a new Attempt', t => {
  const s = setup(t)
  s.seed('run-elapsed', { state: 'attention', elapsedMs: 1000 })
  s.setNow(2000)
  const outcome = s.authority.reconcileAssignment({
    assignmentId: ASSIGNMENT_ID, decision: 'retry', expectedRevision: s.authority.revisionOf(),
  })
  assert.equal(outcome.status, 'stopped')
  assert.equal(outcome.reasonCode, 'elapsed_limit_exhausted')
  assert.equal(s.runner.store.getStop(ASSIGNMENT_ID)!.trigger, 'elapsed_limit')
})

test('restart reports an active Assignment whose uncertain writer blocks continuation', t => {
  const s = setup(t)
  s.seed('run-restart')
  const reopened = s.reopen()
  assert.deepEqual(reopened.recovery.uncertainWriters, [s.projectId])
  assert.deepEqual(reopened.recovery.reconciliationRequired, [ASSIGNMENT_ID])
  assert.equal(reopened.store.getWriter(s.projectId)!.state, 'uncertain')
  assert.equal(reopened.store.getAssignment(ASSIGNMENT_ID)!.state, 'running', 'recovery mutates no Assignment lifecycle')
})

test('start_assignment stays disabled during every intervention path', t => {
  const s = setup(t)
  s.seed('run-disabled')
  assert.match(START_UNAVAILABLE_REASON, /current Runner-validated Start Review/)
  const snapshot = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  const startAction = snapshot.actions.find(action => action.kind === 'start_assignment')
  assert.equal(startAction?.enabled, false)
})
