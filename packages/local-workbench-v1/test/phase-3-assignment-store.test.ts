import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkbenchStore, candidateDigest, handoffDigest } from '../runner/store.ts'
import { STORE_SCHEMA_VERSION } from '../runner/schema.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { describeBackupSupport, planMigration } from '../runner/backup.ts'

const NODE = 'node-1'
const H40 = 'a'.repeat(40)
const CHALLENGE = 'c'.repeat(32)

function makeCheck(f: { projectId: string; checkId: string; canonicalPath: string }) {
  const definition = {
    projectId: f.projectId, checkId: f.checkId, version: 1, name: 'Gate', summary: 'gate', mode: 'validator',
    commandSummary: 'true', semanticClaim: 'Configured validator exited zero; subject to candidate and resource stability.',
    executable: '/usr/bin/true', executableDigest: sha256('/usr/bin/true'), argv: [], cwd: f.canonicalPath,
    environment: [], resources: [], timeoutMs: 1000, outputBytes: 4096, maxCorrections: 2, elapsedMs: 60000,
  }
  const canonical = canonicalJson(definition)
  const digest = sha256(canonical)
  return { check: { projectId: f.projectId, checkId: f.checkId, version: 1, digest, canonicalJson: canonical, name: 'Gate', mode: 'validator', createdAt: 1 }, digest, canonical }
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-assignment-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  const path = join(stateDir, 'store.sqlite')
  const store = openWorkbenchStore({ path, nodeId: NODE, create: true, clock: () => 1000 })
  t.after(() => store.close())
  const projectId = 'project-1', goalId = 'goal-1', runId = 'run-1', checkId = 'gate-1'
  const project = { projectId, executionNodeId: NODE, canonicalPath: stateDir, gitCommonDir: join(stateDir, '.git'), headOid: H40, dirty: false, contextDigest: null, revision: 1, createdAt: 1 }
  store.putProject(project)
  store.insertGoal({ goalId, projectId, goalText: 'Ship the loop', state: 'active', outcome: null, createdAt: 1 })
  const { check, digest: gateDigest, canonical: gateJson } = makeCheck({ projectId, checkId, canonicalPath: stateDir })
  store.putCheck(check)
  return { root, stateDir, path, store, projectId, goalId, runId, checkId, project, check, gateDigest, gateJson }
}

function assignment(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: 'assignment-1', projectId: f.projectId, goalId: f.goalId, agentRunId: f.runId,
    bindingDigest: sha256('binding'), goalText: 'Ship the loop', taskText: 'Do the task', writeAuthority: true,
    state: 'admitted' as const, limits: { maxCorrections: 2, elapsedMs: 60000 }, attemptCount: 0, revision: 1,
    createdAt: 10, updatedAt: 10, ...overrides,
  }
}

function attempt(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt-1', assignmentId: 'assignment-1', ordinal: 1, state: 'admitted' as const,
    runBinding: {
      executionNodeId: NODE, processInstanceId: 'proc-1', piSessionId: 'session-1', extensionInstanceId: 'ext-1',
      runId: f.runId, goalId: f.goalId, bindingDigest: sha256('binding'), connectionId: 'connection-1', connectionChallenge: CHALLENGE,
    },
    gate: { checkId: f.checkId, version: 1, digest: f.gateDigest, canonicalJson: f.gateJson },
    context: {
      projectId: f.projectId, executionNodeId: NODE, canonicalPath: f.stateDir, gitCommonDir: join(f.stateDir, '.git'),
      repositoryIdentity: sha256('repo'), headOid: H40, dirty: false, baselineDigest: sha256('baseline'), manifestDigest: sha256('manifest'),
    },
    limits: { maxCorrections: 2, elapsedMs: 60000 }, writerEpoch: 1, controlEpoch: 0, deliveryId: null,
    createdAt: 20, updatedAt: 20, ...overrides,
  }
}

function delivery(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const frameJson = JSON.stringify({ protocol: 'omarchestra.bridge/v1', kind: 'assignment', attemptId: 'attempt-1' })
  return {
    deliveryId: 'delivery-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', runId: f.runId,
    frameJson, payloadDigest: sha256(frameJson), state: 'queued' as const, reasonCode: null, deadline: 999, createdAt: 25, ...overrides,
  }
}

function candidate(overrides: Record<string, unknown> = {}) {
  const base = {
    candidateId: 'candidate-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', agentRunId: 'run-1',
    controlEpoch: 0, summary: 'ran the task', artifactRefs: [{ path: 'src/a.ts', digest: sha256('a'), length: 3 }],
    digest: '', preManifestDigest: sha256('pre'), state: 'pending' as const, createdAt: 30, ...overrides,
  }
  if (!base.digest) base.digest = candidateDigest(base as never)
  return base
}

function gateResult(f: ReturnType<typeof fixture>, candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    resultId: 'result-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', candidateId,
    gateDigest: f.gateDigest, executableDigest: sha256('/usr/bin/true'), outcome: 'pass' as const,
    preManifestDigest: sha256('pre'), postManifestDigest: sha256('post'), exitCode: 0, reasonCode: null,
    evidenceJson: JSON.stringify({ exitCode: 0 }), state: 'provisional' as const, revision: 1, createdAt: 40, ...overrides,
  }
}

function handoff(overrides: Record<string, unknown> = {}) {
  const base = {
    handoffId: 'handoff-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', agentRunId: 'run-1',
    controlEpoch: 0, claimedState: 'partial' as const, summary: 'ran out of budget',
    artifactRefs: [], outstandingEffects: 'unknown' as const, digest: '', createdAt: 60, ...overrides,
  }
  if (!base.digest) base.digest = handoffDigest(base as never)
  return base
}

test('fresh store is schema 10 with an empty one-Assignment lifecycle substrate', t => {
  const f = fixture(t)
  assert.equal(STORE_SCHEMA_VERSION, 10)
  assert.equal(f.store.getMeta('schema_version'), '10')
  assert.deepEqual(f.store.listAssignments(), [])
  assert.deepEqual(f.store.listAttempts(), [])
  assert.deepEqual(f.store.listWriters(), [])
  assert.deepEqual(f.store.listAssignmentDeliveries(), [])
  assert.deepEqual(f.store.listCandidates(), [])
  assert.deepEqual(f.store.listGateResults(), [])
  assert.deepEqual(f.store.listStops(), [])
  assert.deepEqual(f.store.listHandoffs(), [])
  assert.equal(f.store.activeAssignment(f.projectId), null)
  assert.equal(f.store.getWriter(f.projectId), null)
  assert.deepEqual(planMigration(10), { from: 10, to: 10, steps: [], requiredBackup: false })
  assert.deepEqual(planMigration(9), { from: 9, to: 10, steps: ['add_assignment_lifecycle'], requiredBackup: true })
  assert.equal(describeBackupSupport().migrationsSupported, true)
})

test('schema 9 stores are refused without modifying their bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-assignment-refuse-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  const path = join(stateDir, 'store.sqlite')
  const created = openWorkbenchStore({ path, nodeId: NODE, create: true, clock: () => 1000 })
  created.close()
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA user_version = 9')
  raw.close()
  const before = readFileSync(path)
  assert.throws(() => openWorkbenchStore({ path, nodeId: NODE, create: false }), /schema version 9 is not supported/)
  assert.deepEqual(readFileSync(path), before)
})

test('one transaction commits assignment, attempt, writer lease and outbox atomically', t => {
  const f = fixture(t)
  f.store.transaction(() => {
    f.store.putAssignment(assignment(f))
    f.store.putAttempt(attempt(f))
    f.store.acquireWriter({ projectId: f.projectId, assignmentId: 'assignment-1', attemptId: 'attempt-1', epoch: 1, updatedAt: 22 })
    f.store.putAssignmentDelivery(delivery(f))
  })
  const stored = f.store.activeAssignment(f.projectId)
  assert.equal(stored?.assignmentId, 'assignment-1')
  assert.equal(stored?.attemptCount, 1)
  const attemptRow = f.store.getAttempt('attempt-1')
  assert.equal(attemptRow?.ordinal, 1)
  assert.equal(attemptRow?.deliveryId, 'delivery-1')
  assert.equal(f.store.getWriter(f.projectId)?.state, 'held')
  assert.equal(f.store.getAssignmentDelivery('attempt-1')?.state, 'queued')
  assert.equal(f.store.listAttempts('assignment-1').length, 1)
})

test('a rolled-back lifecycle transaction leaves no partial record', t => {
  const f = fixture(t)
  assert.throws(() => f.store.transaction(() => {
    f.store.putAssignment(assignment(f))
    throw new Error('operator aborted admission')
  }), /operator aborted admission/)
  assert.equal(f.store.getAssignment('assignment-1'), null)
  assert.deepEqual(f.store.listAssignments(), [])
})

test('only one active Assignment may occupy a Project', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  assert.throws(() => f.store.putAssignment(assignment(f, { assignmentId: 'assignment-2' })), /active Assignment already occupies this Project/)
  assert.equal(f.store.listAssignments().length, 1)
  assert.equal(f.store.transitionAssignment('assignment-1', 'admitted', 'stopped', 2, 11), true)
  f.store.putAssignment(assignment(f, { assignmentId: 'assignment-2', revision: 1 }))
  assert.equal(f.store.listAssignments().length, 2)
  assert.equal(f.store.activeAssignment(f.projectId)?.assignmentId, 'assignment-2')
})

test('writer lease is single-holder with a strictly increasing epoch', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  const held = f.store.acquireWriter({ projectId: f.projectId, assignmentId: 'assignment-1', attemptId: null, epoch: 1, updatedAt: 22 })
  assert.equal(held.state, 'held')
  assert.throws(() => f.store.acquireWriter({ projectId: f.projectId, assignmentId: null, attemptId: null, epoch: 2, updatedAt: 23 }), /already has a held writer lease/)
  f.store.releaseWriter(f.projectId, 24)
  assert.equal(f.store.getWriter(f.projectId)?.state, 'none')
  assert.equal(f.store.getWriter(f.projectId)?.epoch, 1)
  assert.throws(() => f.store.acquireWriter({ projectId: f.projectId, assignmentId: null, attemptId: null, epoch: 1, updatedAt: 25 }), /does not advance/)
  assert.equal(f.store.acquireWriter({ projectId: f.projectId, assignmentId: null, attemptId: null, epoch: 2, updatedAt: 25 }).state, 'held')
  assert.equal(f.store.markWriterUncertain(f.projectId, 26), true)
  assert.equal(f.store.getWriter(f.projectId)?.state, 'uncertain')
  assert.throws(() => f.store.releaseWriter(f.projectId, 27), /uncertain writer lease cannot be released/)
  assert.equal(f.store.markWriterUncertain(f.projectId, 28), false)
})

test('lifecycle transitions are guarded against illegal and terminal moves', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  assert.equal(f.store.transitionAssignment('assignment-1', 'running', 'candidate', 2, 11), false)
  assert.throws(() => f.store.transitionAssignment('assignment-1', 'accepted', 'running', 2, 11), /illegal Assignment transition accepted -> running/)
  assert.throws(() => f.store.transitionAssignment('assignment-1', 'bogus' as never, 'running', 2, 11), /unknown Assignment state/)
  assert.equal(f.store.transitionAssignment('assignment-1', 'admitted', 'dispatching', 2, 11), true)
  f.store.putAttempt(attempt(f))
  assert.throws(() => f.store.transitionAttempt('attempt-1', 'accepted', 'rejected', 21), /illegal Attempt transition/)
  assert.equal(f.store.transitionAttempt('attempt-1', 'admitted', 'dispatching', 21), true)
  assert.equal(f.store.transitionAttempt('attempt-1', 'running', 'candidate', 21), false)
})

test('attempt ordinals advance sequentially with the Assignment counter', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  assert.throws(() => f.store.putAttempt(attempt(f, { attemptId: 'attempt-2', ordinal: 3 })), /next sequential ordinal/)
  assert.throws(() => f.store.putAttempt(attempt(f, { attemptId: 'attempt-2', ordinal: 1 })), /next sequential ordinal/)
  assert.equal(f.store.getAssignment('assignment-1')?.attemptCount, 1)
  f.store.putAttempt(attempt(f, { attemptId: 'attempt-2', ordinal: 2 }))
  assert.equal(f.store.getAssignment('assignment-1')?.attemptCount, 2)
  assert.deepEqual(f.store.listAttempts('assignment-1').map(a => a.ordinal), [1, 2])
})

test('candidate bounds, one-per-attempt and canonical digest are enforced', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  const tooMany = Array.from({ length: 17 }, (_, i) => ({ path: `src/f${i}.ts`, digest: sha256(String(i)), length: 1 }))
  assert.throws(() => f.store.putCandidate(candidate({ artifactRefs: tooMany })), /at most 16/)
  assert.throws(() => f.store.putCandidate(candidate({ artifactRefs: [{ path: '../escape', digest: sha256('x'), length: 1 }] })), /artifact ref path is invalid/)
  assert.throws(() => f.store.putCandidate(candidate({ summary: 'x'.repeat(8193) })), /exceeds 8192 bytes/)
  assert.throws(() => f.store.putCandidate(candidate({ digest: sha256('wrong') })), /digest does not match its canonical content/)
  const stored = candidate()
  f.store.putCandidate(stored)
  assert.equal(f.store.getCandidateByAttempt('attempt-1')?.digest, stored.digest)
  assert.throws(() => f.store.putCandidate(candidate({ candidateId: 'candidate-2' })), /already has a Candidate/)
  assert.equal(f.store.setCandidateState('candidate-1', 'validated'), true)
  assert.equal(f.store.getCandidate('candidate-1')?.state, 'validated')
})

test('gate result is one-per-attempt, bound to the frozen gate and cannot accept a failing outcome', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  const stored = candidate()
  f.store.putCandidate(stored)
  assert.throws(() => f.store.putGateResult(gateResult(f, 'candidate-1', { state: 'accepted', outcome: 'nonzero', exitCode: 1 })), /only a passing gate result can be accepted/)
  assert.throws(() => f.store.putGateResult(gateResult(f, 'candidate-1', { gateDigest: sha256('other') })), /does not match its Attempt, Candidate, or frozen gate digest/)
  f.store.putGateResult(gateResult(f, 'candidate-1'))
  assert.equal(f.store.getGateResult('attempt-1')?.outcome, 'pass')
  assert.throws(() => f.store.putGateResult(gateResult(f, 'candidate-1', { resultId: 'result-2' })), /already has a gate result/)
  assert.equal(f.store.transitionGateResult('result-1', 'provisional', 'accepted', 2), true)
  assert.equal(f.store.transitionGateResult('result-1', 'provisional', 'accepted', 3), false)
  assert.throws(() => f.store.transitionGateResult('result-1', 'accepted', 'provisional', 4), /only resolve a provisional result/)
})

test('one stop per Assignment and one handoff per Attempt retain their canonical digests', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  f.store.putStop({ stopId: 'stop-1', assignmentId: 'assignment-1', trigger: 'operator', revision: 2, dispatchRevoked: true, cancellationStatus: 'requested', reasonCode: 'operator_stop', createdAt: 50, updatedAt: 50 })
  assert.throws(() => f.store.putStop({ stopId: 'stop-2', assignmentId: 'assignment-1', trigger: 'elapsed_limit', revision: 3, dispatchRevoked: true, cancellationStatus: 'requested', reasonCode: null, createdAt: 51, updatedAt: 51 }), /already has a durable stop/)
  assert.equal(f.store.setStopCancellation('stop-1', 'acknowledged', 52), true)
  assert.equal(f.store.getStop('assignment-1')?.cancellationStatus, 'acknowledged')
  const stored = handoff()
  f.store.putHandoff(stored)
  assert.equal(f.store.getHandoff('attempt-1')?.digest, stored.digest)
  assert.throws(() => f.store.putHandoff(handoff({ handoffId: 'handoff-2' })), /already has a structured handoff/)
  assert.throws(() => f.store.putHandoff(handoff({ digest: sha256('wrong') })), /digest does not match its canonical content/)
})

test('assignment delivery outbox tracks uncertainty without resetting the attempt', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  f.store.putAssignmentDelivery(delivery(f))
  assert.throws(() => f.store.putAssignmentDelivery(delivery(f, { deliveryId: 'delivery-2' })), /does not match its frozen Attempt/)
  assert.equal(f.store.transitionAssignmentDelivery('attempt-1', 'queued', 'attempting', null), true)
  assert.equal(f.store.transitionAssignmentDelivery('attempt-1', 'attempting', 'unknown', 'owner_restarted'), true)
  assert.equal(f.store.transitionAssignmentDelivery('attempt-1', 'queued', 'attempting', null), false)
  // Receipt reconciliation may settle an unknown attempt forward, or refuse it,
  // but it never resets the attempt and never blindly resends.
  assert.equal(f.store.transitionAssignmentDelivery('attempt-1', 'unknown', 'written', null), true)
  assert.equal(f.store.getAssignmentDelivery('attempt-1')?.state, 'written')
  assert.throws(() => f.store.transitionAssignmentDelivery('attempt-1', 'written', 'attempting', null), /never reset or blindly resend/)
  assert.equal(f.store.getAssignmentDelivery('attempt-1')?.state, 'written')
})

test('reopen re-validates every lifecycle row and refuses corrupt persisted bytes', t => {
  const f = fixture(t)
  f.store.putAssignment(assignment(f))
  f.store.putAttempt(attempt(f))
  f.store.acquireWriter({ projectId: f.projectId, assignmentId: 'assignment-1', attemptId: 'attempt-1', epoch: 1, updatedAt: 22 })
  f.store.putAssignmentDelivery(delivery(f))
  f.store.putCandidate(candidate())
  f.store.putGateResult(gateResult(f, 'candidate-1'))
  f.store.putStop({ stopId: 'stop-1', assignmentId: 'assignment-1', trigger: 'operator', revision: 2, dispatchRevoked: true, cancellationStatus: 'requested', reasonCode: null, createdAt: 50, updatedAt: 50 })
  f.store.putHandoff(handoff())
  f.store.close()
  const reopened = openWorkbenchStore({ path: f.path, nodeId: NODE, create: false, clock: () => 2000 })
  assert.equal(reopened.listAssignments().length, 1)
  assert.equal(reopened.listAttempts().length, 1)
  assert.equal(reopened.listWriters()[0]?.state, 'held')
  assert.equal(reopened.listAssignmentDeliveries().length, 1)
  assert.equal(reopened.listCandidates().length, 1)
  assert.equal(reopened.listGateResults().length, 1)
  assert.equal(reopened.listStops().length, 1)
  assert.equal(reopened.listHandoffs().length, 1)
  reopened.close()

  const corrupt = new DatabaseSync(f.path)
  corrupt.exec("UPDATE assignments SET limits_json = '{'")
  corrupt.close()
  assert.throws(() => openWorkbenchStore({ path: f.path, nodeId: NODE, create: false }), /persisted Assignment is invalid/)
})
