/**
 * AL-05 gate orchestration. One exact frozen check runs once per Attempt under
 * the bounded executor; the candidate checkout is double-scanned, provisional
 * outcomes are persisted truthfully, and acceptance happens only in a final
 * transaction that rechecks the Candidate, gate, context, writer/control
 * epochs, stop intent and quiescence. Every non-pass or uncertain outcome stays
 * nonaccepting, and `start_assignment` stays disabled throughout.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { armAssignmentBudget } from '../runner/assignment-budget.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { WorkbenchAuthority, START_UNAVAILABLE_REASON, type GateQuiescence } from '../runner/authority.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { buildSnapshot } from '../runner/projection.ts'

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
const PROCESS_ID = 'process-' + 'a'.repeat(32)
const EXTENSION_ID = 'extension-' + 'b'.repeat(32)
const PI_SESSION = 'pi-session'
const CONTROL_EPOCH = 1
const ASSIGNMENT_ID = 'assignment-1'
const ATTEMPT_ID = 'attempt-1'
const CANDIDATE_ID = 'candidate-1'

interface ArtifactRef { path: string; digest: string; length: number }
interface Seed { assignmentId: string; attemptId: string; candidateId: string }

interface Fixture {
  root: string
  projectPath: string
  scratchRoot: string
  checkerPath: string
  policyPath: string
  runner: ReturnType<typeof openWorkbenchRunner>
  authority: WorkbenchAuthority
  projectId: string
  goalId: string
  now: () => number
  setNow: (value: number) => void
  writeChecker: (body: string) => void
  storeCheck: (overrides?: { timeoutMs?: number; outputBytes?: number; executable?: string }) => string
  writeArtifact: (name: string, content: string) => ArtifactRef
  seed: (checkJson: string, runId: string, artifactRefs?: ArtifactRef[]) => Seed
}

function setup(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-assignment-gate-'))
  let now = 1000
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, registry, clock: () => now })

  const projectPath = join(root, 'project')
  const scratchRoot = join(root, 'scratch')
  mkdirSync(projectPath)
  mkdirSync(scratchRoot)
  const policyPath = join(projectPath, 'policy.txt')
  const checkerPath = join(projectPath, 'checker.cjs')
  writeFileSync(policyPath, 'policy-v1\n')
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

  const writeChecker = (body: string) => {
    writeFileSync(checkerPath, `#!${process.execPath}\n${body}\n`)
    chmodSync(checkerPath, 0o755)
  }

  const storeCheck = (overrides: { timeoutMs?: number; outputBytes?: number; executable?: string } = {}): string => {
    const project = runner.store.getProject(projectId)!
    const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
      name: 'Gate check', summary: 'Bounded deterministic validator', mode: 'validator',
      commandSummary: 'Run the frozen deterministic checker',
      definitionDraft: {
        executable: overrides.executable ?? checkerPath, argv: [], cwd: project.canonicalPath, environment: [],
        resourcePaths: [join(project.canonicalPath, 'policy.txt')],
        timeoutMs: overrides.timeoutMs ?? 5000, outputBytes: overrides.outputBytes ?? 4096,
        maxCorrections: 2, elapsedMs: 60_000,
      },
    })
    const checkJson = canonicalJson(definition)
    runner.store.putCheck({
      projectId, checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson,
      name: definition.name, mode: definition.mode, createdAt: now,
    })
    return checkJson
  }

  const writeArtifact = (name: string, content: string): ArtifactRef => {
    writeFileSync(join(projectPath, name), content)
    return { path: name, digest: sha256(content), length: Buffer.byteLength(content) }
  }

  const seed = (checkJson: string, runId: string, artifactRefs: ArtifactRef[] = []): Seed => {
    const project = runner.store.getProject(projectId)!
    const bindingDigest = sha256('binding-' + runId)
    const gate = { checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson }
    const context = {
      projectId, executionNodeId: runner.nodeId, canonicalPath: project.canonicalPath, gitCommonDir: project.gitCommonDir,
      repositoryIdentity: project.contextDigest, headOid: project.headOid ?? 'a'.repeat(40), dirty: project.dirty,
      baselineDigest: sha256('baseline'), manifestDigest: sha256('manifest'),
    }
    runner.store.putBinding({
      runId, projectId, role: 'implementer', state: 'committed', bindingDigest, controlEpoch: CONTROL_EPOCH,
      writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: now,
    })
    runner.store.putBindingIdentity(runId, goalId, {
      executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION, extensionInstanceId: EXTENSION_ID,
    })
    runner.store.transaction(() => {
      runner.store.putAssignment({
        assignmentId: ASSIGNMENT_ID, projectId, goalId, agentRunId: runId, bindingDigest, goalText: 'explicit goal',
        taskText: 'Implement the bounded assignment loop.', writeAuthority: false, state: 'admitted',
        limits: { maxCorrections: 2, elapsedMs: 60_000 }, attemptCount: 0, revision: 1, createdAt: now, updatedAt: now,
      })
      armAssignmentBudget(runner.store, runner.store.getAssignment(ASSIGNMENT_ID)!, now)
      runner.store.putAttempt({
        attemptId: ATTEMPT_ID, assignmentId: ASSIGNMENT_ID, ordinal: 1, state: 'admitted',
        runBinding: {
          executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION,
          extensionInstanceId: EXTENSION_ID, runId, goalId, bindingDigest, connectionId: 'connection-1', connectionChallenge: 'c'.repeat(32),
        },
        gate, context, limits: { maxCorrections: 2, elapsedMs: 60_000 }, writerEpoch: 1, controlEpoch: CONTROL_EPOCH,
        deliveryId: 'delivery-1', createdAt: now, updatedAt: now,
      })
      runner.store.acquireWriter({ projectId, assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, epoch: 1, updatedAt: now })
      for (const [from, to, revision] of [['admitted', 'dispatching', 2], ['dispatching', 'running', 3], ['running', 'candidate', 4]] as Array<[never, never, number]>) {
        runner.store.transitionAssignment(ASSIGNMENT_ID, from, to, revision, now)
        runner.store.transitionAttempt(ATTEMPT_ID, from, to, now)
      }
    })
    runner.store.submitCandidate({
      candidateId: CANDIDATE_ID, createdAt: now,
      submission: { assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, agentRunId: runId, controlEpoch: CONTROL_EPOCH, summary: 'Implemented the bounded loop.', artifactRefs },
    })
    return { assignmentId: ASSIGNMENT_ID, attemptId: ATTEMPT_ID, candidateId: CANDIDATE_ID }
  }

  return { root, projectPath, scratchRoot, checkerPath, policyPath, runner, authority, projectId, goalId, now: () => now, setNow: value => { now = value }, writeChecker, storeCheck, writeArtifact, seed }
}

const confirmedQuiescence = ({ attempt }: { attempt: import('../runner/store.ts').AttemptRecord }): GateQuiescence => ({
  runId: attempt.runBinding.runId, attemptId: attempt.attemptId, controlEpoch: attempt.controlEpoch,
  connectionId: attempt.runBinding.connectionId, connectionChallenge: attempt.runBinding.connectionChallenge,
  source: 'surviving_bridge_and_operator_reconciliation', status: 'confirmed', sequence: 1, runnerReceivedAt: 1000,
})

test('a clean passing gate is accepted and completes the Goal in one final transaction', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(0)')
  const seeded = s.seed(s.storeCheck(), 'run-pass')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, true)
  assert.equal(outcome.outcome, 'pass')
  assert.equal(outcome.reasonCode, null)
  assert.equal(s.runner.store.getAssignment(seeded.assignmentId)!.state, 'accepted')
  assert.equal(s.runner.store.getAttempt(seeded.attemptId)!.state, 'accepted')
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId)!.state, 'validated')
  const result = s.runner.store.getGateResult(seeded.attemptId)!
  assert.equal(result.state, 'accepted')
  assert.equal(result.outcome, 'pass')
  assert.equal(result.reasonCode, null)
  assert.equal(s.runner.store.getGoal(s.goalId)!.state, 'recent')
  assert.equal(s.runner.store.getGoal(s.goalId)!.outcome, 'accepted')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'none')
})

test('the default quiescence fails closed when no challenged bridge proves idle', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(0)')
  const seeded = s.seed(s.storeCheck(), 'run-quiescence')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot },
  )
  assert.equal(outcome.accepted, false, 'a validator exit alone never proves quiescence')
  assert.equal(outcome.outcome, 'unknown', 'without fresh Pi quiescence even validator launch is unavailable')
  assert.equal(outcome.reasonCode, 'quiescence_unknown')
  assert.equal(s.runner.store.getGateResult(seeded.attemptId)!.state, 'nonaccepting')
  assert.equal(s.runner.store.getAssignment(seeded.assignmentId)!.state, 'attention')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain', 'missing quiescence keeps effects uncertain')
})

test('a nonzero exit is recorded nonaccepting and keeps the writer held', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(3)')
  const seeded = s.seed(s.storeCheck(), 'run-nonzero')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'nonzero')
  assert.equal(outcome.reasonCode, 'gate_nonzero')
  assert.equal(s.runner.store.getGateResult(seeded.attemptId)!.exitCode, 3)
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId)!.state, 'rejected')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held')
})

test('an unspawnable frozen executable is a spawn_error, never a pass', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(0)')
  const checkJson = s.storeCheck()
  chmodSync(s.checkerPath, 0o644) // digest still matches the pin; only the exec bit is gone
  const seeded = s.seed(checkJson, 'run-spawn')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'spawn_error')
  assert.match(String(outcome.reasonCode), /^spawn_[a-z0-9_]+$/)
  assert.equal(s.runner.store.getGateResult(seeded.attemptId)!.state, 'nonaccepting')
})

test('a timeout is nonaccepting even when the child exits on the request', async t => {
  const s = setup(t)
  s.writeChecker('setTimeout(() => {}, 10000)')
  const seeded = s.seed(s.storeCheck({ timeoutMs: 300 }), 'run-timeout')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, graceMs: 400, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'timeout')
  assert.equal(outcome.reasonCode, 'gate_timeout')
  assert.equal(s.runner.store.getAttempt(seeded.attemptId)!.state, 'attention')
})

test('an output-cap breach is output_limit, never a pass', async t => {
  const s = setup(t)
  s.writeChecker('const blob = "x".repeat(4096); for (let i = 0; i < 200; i += 1) process.stdout.write(blob)')
  const seeded = s.seed(s.storeCheck({ outputBytes: 128 }), 'run-output')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'output_limit')
  assert.equal(outcome.reasonCode, 'gate_output_limit')
})

test('a candidate artifact mutated by the child is candidate_changed and nonaccepting', async t => {
  const s = setup(t)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  s.writeChecker('require("node:fs").appendFileSync(process.cwd() + "/change.patch", "tampered\\n")')
  const seeded = s.seed(s.storeCheck(), 'run-candidate', [artifact])
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'candidate_changed')
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId)!.state, 'rejected')
})

test('a declared validator resource changed by the child is gate_changed even on exit zero', async t => {
  const s = setup(t)
  s.writeChecker('require("node:fs").appendFileSync(process.cwd() + "/policy.txt", "mutated\\n")')
  const seeded = s.seed(s.storeCheck(), 'run-gate-changed')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'gate_changed')
  assert.equal(outcome.reasonCode, 'resource_changed_post')
})

test('a child that ignores the cooperative request stays unknown and marks the writer uncertain', async t => {
  const s = setup(t)
  s.writeChecker([
    'process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 400) })',
    'setTimeout(() => {}, 5000)',
  ].join('\n'))
  const seeded = s.seed(s.storeCheck({ timeoutMs: 200 }), 'run-unknown')
  const outcome = await s.authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, graceMs: 150, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'unknown')
  assert.equal(outcome.reasonCode, 'child_unterminated')
  assert.equal(s.runner.store.getGateResult(seeded.attemptId)!.state, 'nonaccepting')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain', 'an uncertain child never releases the writer')
  await sleep(900) // the child exits on its own afterwards; no kill escalation occurred
})

test('a durable stop recorded before acceptance refuses the pass and never releases the writer', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(0)')
  const seeded = s.seed(s.storeCheck(), 'run-stop')
  const authority = new WorkbenchAuthority({
    runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: s.now,
    onAssignmentGatePhase: phase => {
      if (phase !== 'before_acceptance') return
      s.runner.store.putStop({
        stopId: 'stop-1', assignmentId: seeded.assignmentId, trigger: 'operator', revision: 5,
        dispatchRevoked: true, cancellationStatus: 'not_requested', reasonCode: null, createdAt: s.now(), updatedAt: s.now(),
      })
    },
  })
  const outcome = await authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.outcome, 'pass', 'the validator genuinely passed; the stop is the refusal')
  assert.equal(outcome.reasonCode, 'stop_recorded')
  assert.equal(s.runner.store.getGateResult(seeded.attemptId)!.state, 'nonaccepting')
  assert.equal(s.runner.store.getAssignment(seeded.assignmentId)!.state, 'attention')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held')
})

test('a control-epoch change before acceptance refuses the pass', async t => {
  const s = setup(t)
  s.writeChecker('process.exit(0)')
  const seeded = s.seed(s.storeCheck(), 'run-epoch')
  const authority = new WorkbenchAuthority({
    runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: s.now,
    onAssignmentGatePhase: phase => {
      if (phase === 'before_acceptance') s.runner.store.setBindingControlEpoch('run-epoch', CONTROL_EPOCH + 1, s.now())
    },
  })
  const outcome = await authority.executeAssignmentGate(
    { assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, candidateId: seeded.candidateId },
    { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence },
  )
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.reasonCode, 'control_epoch_changed')
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId)!.state, 'rejected')
})

test('Git index, HEAD and configuration mutations are nonaccepting on exit zero', async t => {
  for (const operation of [['add', 'checker.cjs'], ['commit', '--allow-empty', '-q', '-m', 'changed'], ['config', 'alias.review', 'status']]) {
    await t.test(operation[0], async t => {
      const s = setup(t)
      s.writeChecker(`require('node:child_process').execFileSync('/usr/bin/git', ${JSON.stringify(operation)})`)
      const ids = s.seed(s.storeCheck(), 'run-git-drift')
      const outcome = await s.authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence })
      assert.equal(outcome.accepted, false)
      assert.equal(outcome.outcome, 'candidate_changed')
      assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held')
      const evidence = JSON.parse(s.runner.store.getGateResult(ids.attemptId)!.evidenceJson)
      assert.notEqual(evidence.preBaselineDigest, evidence.postBaselineDigest)
    })
  }
})

test('final acceptance rechecks external executable and Git context', async t => {
  for (const drift of ['executable', 'context']) {
    await t.test(drift, async t => {
      const s = setup(t), executable = join(s.root, 'external-checker.cjs')
      writeFileSync(executable, `#!${process.execPath}\nprocess.exit(0)\n`); chmodSync(executable, 0o755)
      const ids = s.seed(s.storeCheck({ executable }), 'run-final-drift')
      const authority = new WorkbenchAuthority({ runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: s.now,
        onAssignmentGatePhase: phase => {
          if (phase !== 'before_acceptance') return
          if (drift === 'executable') writeFileSync(executable, `#!${process.execPath}\nprocess.exit(1)\n`)
          else execFileSync('/usr/bin/git', ['-C', s.projectPath, 'config', 'alias.changed', 'status'], { timeout: 5000 })
        } })
      const outcome = await authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence })
      assert.equal(outcome.accepted, false)
      assert.equal(outcome.reasonCode, drift === 'executable' ? 'gate_changed' : 'context_changed_at_acceptance')
    })
  }
})

test('stale quiescence at the final transaction retains an uncertain writer', async t => {
  const s = setup(t); s.writeChecker('process.exit(0)')
  const ids = s.seed(s.storeCheck(), 'run-stale-idle')
  const authority = new WorkbenchAuthority({ runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: s.now,
    onAssignmentGatePhase: phase => { if (phase === 'before_acceptance') s.setNow(3001) } })
  const outcome = await authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence })
  assert.equal(outcome.accepted, false)
  assert.equal(outcome.reasonCode, 'quiescence_unknown')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain')
})

test('expired elapsed budget stops before launch rather than accepting late work', async t => {
  const s = setup(t); s.writeChecker('process.exit(0)')
  const ids = s.seed(s.storeCheck(), 'run-expired'); s.setNow(62000)
  await assert.rejects(s.authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence }), /elapsed limit/)
  assert.equal(s.runner.store.getStop(ids.assignmentId)!.trigger, 'elapsed_limit')
  assert.equal(s.runner.store.getGateResult(ids.attemptId), null)
})

test('wall-clock jumps do not alter the owner-epoch monotonic budget', async t => {
  const s = setup(t); s.writeChecker('process.exit(0)')
  const ids = s.seed(s.storeCheck(), 'run-monotonic')
  const authority = new WorkbenchAuthority({ runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: () => 999999, monotonic: () => 1000 })
  const outcome = await authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot, quiescence: confirmedQuiescence })
  assert.equal(outcome.accepted, true)
})

test('elapsed budget during a gate durably stops and cooperatively cancels only its child', async t => {
  const s = setup(t); s.writeChecker('setTimeout(() => process.exit(0), 2000)')
  const ids = s.seed(s.storeCheck(), 'run-budget-in-flight')
  const started = performance.now(), monotonic = () => 60000 + performance.now() - started
  const authority = new WorkbenchAuthority({ runner: s.runner, sessionId: 'session', pluginGeneration: 1, clock: s.now, monotonic })
  const outcome = await authority.executeAssignmentGate(ids, { scratchRoot: s.scratchRoot,
    quiescence: context => ({ ...confirmedQuiescence(context), runnerReceivedAt: monotonic() }) })
  assert.equal(outcome.accepted, false)
  assert.equal(s.runner.store.getStop(ids.assignmentId)!.trigger, 'elapsed_limit')
  assert.equal(s.runner.store.getAssignment(ids.assignmentId)!.state, 'stopped')
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain')
})

test('the gate surface is direct-call only and Start stays disabled', async t => {
  const s = setup(t)
  assert.match(START_UNAVAILABLE_REASON, /current Runner-validated Start Review/)
  const snapshot = buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' })
  const startAction = snapshot.actions.find(action => action.kind === 'start_assignment')
  assert.equal(startAction?.enabled, false)
})
