/**
 * AL-04 bounded Candidate association. One exact structured payload from the
 * current committed Run reaches the durable store through the dedicated
 * submission port; an exact duplicate is idempotent, changed or retired reuse
 * is refused before any mutation, and artifact references are re-verified on
 * disk. Start stays disabled throughout.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { decodeBridgeFrame, type BridgeFrame } from '../runner/bridge-protocol.ts'
import { createPiBridgeExtension, type PiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { WorkbenchAuthority, START_UNAVAILABLE_REASON } from '../runner/authority.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { CandidateSubmissionCoordinator } from '../runner/candidate-submission.ts'
import { WORKBENCH_PROTOCOL } from '../console/schema.ts'
import * as foundation from '../runner/index.ts'

class Stream extends EventEmitter {
  other!: Stream
  dead = false
  drop = new Set<string>()
  sent: string[] = []
  frames: BridgeFrame[] = []
  write(bytes: Buffer) {
    if (this.dead) throw Error('closed')
    const frame = decodeBridgeFrame(bytes.subarray(0, -1))
    this.sent.push(frame.type)
    this.frames.push(frame)
    if (!this.drop.has(frame.type)) this.other.emit('data', bytes)
    return true
  }
  destroy() { if (this.dead) return; this.dead = true; this.emit('close'); if (!this.other.dead) this.other.destroy() }
}
function pair() { const a = new Stream(), b = new Stream(); a.other = b; b.other = a; return { a, b } }

const PROCESS_ID = 'process-' + 'a'.repeat(32)
const EXTENSION_ID = 'extension-' + 'b'.repeat(32)
const PI_SESSION = 'pi-session'
const TASK_TEXT = 'Implement the bounded assignment loop.\nReport the changed files.'
const CONTROL_EPOCH = 1

interface Seed { assignmentId: string; attemptId: string; deliveryId: string; frameJson: string }
interface Fixture {
  root: string
  projectPath: string
  runner: ReturnType<typeof openWorkbenchRunner>
  registry: BridgeRegistry
  authority: WorkbenchAuthority
  projectId: string
  goalId: string
  streams: Array<ReturnType<typeof pair>>
  hooks: Map<string, (event: unknown, ctx: unknown) => void>
  host: Record<string, unknown>
  extension: PiBridgeExtension
  extensionTicks: Array<() => void>
  adopt: () => Promise<string>
  seed: (runId: string) => Seed
  writeArtifact: (name: string, content: string) => { path: string; digest: string; length: number }
  payload: (runId: string, seed: Seed, artifactRefs: Array<{ path: string; digest: string; length: number }>, overrides?: Partial<{ controlEpoch: number; summary: string }>) => Record<string, unknown>
  now: () => number
}

function setup(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-candidate-'))
  let now = 1000
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  execFileSync('/usr/bin/git', ['init', '--quiet', projectPath], { timeout: 5_000 })
  writeFileSync(join(projectPath, 'policy.txt'), 'policy\n')
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.name', 'Workbench Test'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.email', 'workbench-test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'add', 'policy.txt'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'commit', '-q', '-m', 'fixture'])
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, registry, clock: () => now })
  const inspection = authority.inspect(projectPath)
  const projectId = authority.confirmRegistration(inspection.inspectionId).projectId
  const goalId = 'goal-1'
  runner.store.insertGoal({ goalId, projectId, goalText: 'explicit goal', state: 'active', outcome: null, createdAt: now })
  runner.store.setMeta('selected_goal_id', goalId)

  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const host: Record<string, unknown> = { mode: 'tui', sessionManager: { getSessionId: () => PI_SESSION }, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} } }
  const streams: Array<ReturnType<typeof pair>> = []
  const extensionTicks: Array<() => void> = []
  let serial = 0
  const clientFor = (onFrame: (frame: BridgeFrame) => void, onClose: () => void) => {
    const p = pair()
    streams.push(p)
    attachBridgeStream(p.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
    return attachBridgeStream(p.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
  }
  const extension = createPiBridgeExtension({
    navigate: null,
    newId: prefix => prefix === 'process' ? PROCESS_ID : prefix === 'extension' ? EXTENSION_ID : `${prefix}-${(++serial).toString(16).padStart(32, '0')}`,
    schedule: (callback, ms) => { if (ms === 5000) extensionTicks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> },
    connect: async (onFrame, onClose) => clientFor(onFrame, onClose),
  })
  extension({ on(name: string, fn: (event: unknown, ctx: unknown) => void) { hooks.set(name, fn) } })

  new CandidateSubmissionCoordinator({ store: runner.store, registry, clock: () => now, newId: prefix => `${prefix}-${serial++}` })

  const adopt = async () => {
    hooks.get('session_start')!(null, host)
    await new Promise(resolve => setImmediate(resolve))
    const observed = [...registry.list()].find(o => o.available)!
    const proposal = authority.adoption.propose({ projectId, goalId, role: 'implementer', observedSessionId: observed.observedSessionId })
    authority.adoption.authorize(proposal.proposalId)
    return proposal.runId
  }

  const seed = (runId: string): Seed => {
    const project = runner.store.getProject(projectId)!
    const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
      name: 'Build check', summary: 'Confirm build behavior', mode: 'validator', commandSummary: 'Run fixed validator',
      definitionDraft: {
        executable: '/usr/bin/true', argv: [], cwd: project.canonicalPath, environment: [],
        resourcePaths: [join(project.canonicalPath, 'policy.txt')], timeoutMs: 1000,
        outputBytes: 4096, maxCorrections: 2, elapsedMs: 60_000,
      },
    })
    const checkJson = canonicalJson(definition)
    runner.store.putCheck({ projectId, checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson, name: definition.name, mode: definition.mode, createdAt: now })
    const observed = [...registry.list()].find(o => o.available)!
    const live = registry.currentBinding(observed.observedSessionId)!
    const assignmentId = 'assignment-1', attemptId = 'attempt-1', deliveryId = 'delivery-1'
    const bindingDigest = sha256('binding-digest')
    const runBinding = {
      executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION, extensionInstanceId: EXTENSION_ID,
      runId, goalId, bindingDigest, connectionId: live.connectionId, connectionChallenge: live.challenge,
    }
    const context = {
      projectId, executionNodeId: runner.nodeId, canonicalPath: project.canonicalPath, gitCommonDir: project.gitCommonDir,
      repositoryIdentity: project.contextDigest, headOid: project.headOid ?? 'a'.repeat(40), dirty: project.dirty,
      baselineDigest: sha256('baseline'), manifestDigest: sha256('manifest'),
    }
    const gate = { checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson }
    const frameJson = canonicalJson({
      protocol: 'omarchestra.assignment/v1', kind: 'assignment_delivery',
      deliveryId, assignmentId, attemptId, runId, projectId, goalId,
      goalText: 'explicit goal', taskText: TASK_TEXT, writeAuthority: false,
      limits: { maxCorrections: 2, elapsedMs: 60_000 }, gate, runBinding, context, deadline: now + 30_000,
    })
    runner.store.transaction(() => {
      runner.store.putAssignment({
        assignmentId, projectId, goalId, agentRunId: runId, bindingDigest, goalText: 'explicit goal', taskText: TASK_TEXT,
        writeAuthority: false, state: 'admitted', limits: { maxCorrections: 2, elapsedMs: 60_000 }, attemptCount: 0, revision: 1, createdAt: now, updatedAt: now,
      })
      runner.store.putAttempt({
        attemptId, assignmentId, ordinal: 1, state: 'admitted', runBinding, gate, context,
        limits: { maxCorrections: 2, elapsedMs: 60_000 }, writerEpoch: 1, controlEpoch: CONTROL_EPOCH, deliveryId, createdAt: now, updatedAt: now,
      })
      runner.store.acquireWriter({ projectId, assignmentId, attemptId, epoch: 1, updatedAt: now })
      runner.store.putAssignmentDelivery({ deliveryId, assignmentId, attemptId, runId, frameJson, payloadDigest: sha256(frameJson), state: 'queued', reasonCode: null, deadline: now + 30_000, createdAt: now })
    })
    return { assignmentId, attemptId, deliveryId, frameJson }
  }

  const writeArtifact = (name: string, content: string) => {
    writeFileSync(join(projectPath, name), content)
    return { path: name, digest: sha256(content), length: Buffer.byteLength(content) }
  }

  const payload = (runId: string, seeded: Seed, artifactRefs: Array<{ path: string; digest: string; length: number }>, overrides: Partial<{ controlEpoch: number; summary: string }> = {}) => ({
    assignmentId: seeded.assignmentId, attemptId: seeded.attemptId, agentRunId: runId,
    controlEpoch: overrides.controlEpoch ?? CONTROL_EPOCH, summary: overrides.summary ?? 'Implemented the bounded loop.', artifactRefs,
  })

  return { root, projectPath, runner, registry, authority, projectId, goalId, streams, hooks, host, extension, extensionTicks, adopt, seed, writeArtifact, payload, now: () => now }
}

test('one exact submission associates a pending Candidate and returns the derived identity', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  const outcome = await s.extension.submitCandidate(s.payload(runId, seeded, [artifact]))
  assert.equal(outcome.outcome, 'accepted')
  assert.ok(outcome.candidateId)
  const stored = s.runner.store.getCandidateByAttempt(seeded.attemptId)!
  assert.equal(stored.state, 'pending')
  assert.equal(stored.candidateId, outcome.candidateId)
  assert.equal(stored.digest, outcome.digest)
  assert.equal(stored.preManifestDigest, sha256('manifest'), 'the frozen admitted manifest digest is derived by the store')
  assert.equal(stored.controlEpoch, CONTROL_EPOCH)
  assert.deepEqual(stored.artifactRefs, [artifact])
  const receipts = s.streams[0].a.frames.filter(frame => frame.type === 'candidate_receipt')
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].body.outcome, 'accepted')
  assert.equal(receipts[0].body.runId, runId)
})

test('an exact duplicate stays idempotent and never inserts a second Candidate', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  const submission = s.payload(runId, seeded, [artifact])
  const first = await s.extension.submitCandidate(submission)
  const second = await s.extension.submitCandidate(structuredClone(submission))
  assert.equal(first.outcome, 'accepted')
  assert.equal(second.outcome, 'duplicate')
  assert.equal(second.candidateId, first.candidateId)
  assert.equal(second.digest, first.digest)
  assert.equal(s.runner.store.listCandidates(seeded.assignmentId).length, 1)
})

test('changed content for the same Attempt is refused before mutation', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  await s.extension.submitCandidate(s.payload(runId, seeded, [artifact]))
  const changed = await s.extension.submitCandidate(s.payload(runId, seeded, [artifact], { summary: 'A different summary.' }))
  assert.equal(changed.outcome, 'invalid')
  assert.equal(changed.reason, 'identity_conflict')
  const stored = s.runner.store.getCandidateByAttempt(seeded.attemptId)!
  assert.equal(stored.summary, 'Implemented the bounded loop.', 'the first Candidate is untouched')
})

test('a drifted control epoch is refused by the durable store', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  const outcome = await s.extension.submitCandidate(s.payload(runId, seeded, [artifact], { controlEpoch: 2 }))
  assert.equal(outcome.outcome, 'invalid')
  assert.equal(outcome.reason, 'identity_conflict')
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId), null)
})

test('retired and purged identities are refused before any Candidate row exists', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  s.runner.retireBinding({ runId, projectId: s.projectId, role: 'implementer', bindingDigest: s.runner.store.getBinding(runId)!.bindingDigest, predecessorRunId: null })
  assert.throws(
    () => s.runner.store.submitCandidate({ submission: s.payload(runId, seeded, [artifact]) as never, candidateId: 'candidate-direct', createdAt: s.now() }),
    error => (error as { code?: string }).code === 'identity_drift',
  )
  assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId), null)
})

test('missing, escaped, changed and misdeclared artifacts never associate', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  const reject = async (refs: Array<{ path: string; digest: string; length: number }>, reason: string) => {
    const outcome = await s.extension.submitCandidate(s.payload(runId, seeded, refs))
    assert.equal(outcome.outcome, 'invalid', reason)
    assert.equal(outcome.reason, reason)
    assert.equal(s.runner.store.getCandidateByAttempt(seeded.attemptId), null)
  }
  await reject([{ ...artifact, path: 'absent.patch' }], 'artifact_missing')
  await reject([{ ...artifact, digest: sha256('other') }], 'artifact_digest_mismatch')
  await reject([{ ...artifact, length: artifact.length + 1 }], 'artifact_length_mismatch')
  // A lexical escape never reaches the disk verifier.
  await reject([{ ...artifact, path: '../escape.patch' }], 'invalid_submission')
  // A symlinked component inside the Project root is refused on disk.
  symlinkSync(artifact.path, join(s.projectPath, 'link.patch'))
  await reject([{ path: 'link.patch', digest: artifact.digest, length: artifact.length }], 'artifact_escapes_project')
})

test('the extension refuses a mismatched Run and an uncommitted session without sending', async t => {
  const s = setup(t)
  const beforeAdopt = await s.extension.submitCandidate({ assignmentId: 'assignment-1', attemptId: 'attempt-1', agentRunId: 'run-x', controlEpoch: CONTROL_EPOCH, summary: 'x', artifactRefs: [] })
  assert.equal(beforeAdopt.outcome, 'invalid')
  assert.equal(beforeAdopt.reason, 'not_committed')
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  const mismatch = await s.extension.submitCandidate(s.payload('run-other', seeded, [artifact]))
  assert.equal(mismatch.outcome, 'invalid')
  assert.equal(mismatch.reason, 'run_mismatch')
  assert.equal(s.streams[0].b.sent.includes('candidate_submission'), false, 'no frame is transmitted for a refused payload')
})

test('a lost receipt leaves the association bounded to unknown without rollback', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const seeded = s.seed(runId)
  const artifact = s.writeArtifact('change.patch', 'bounded change\n')
  s.streams[0].a.drop.add('candidate_receipt')
  const pending = s.extension.submitCandidate(s.payload(runId, seeded, [artifact]))
  await new Promise(resolve => setImmediate(resolve))
  s.extensionTicks.at(-1)!()
  const outcome = await pending
  assert.equal(outcome.outcome, 'unknown')
  assert.equal(outcome.reason, 'receipt_timeout')
  assert.ok(s.runner.store.getCandidateByAttempt(seeded.attemptId), 'the durable association is never rolled back by a lost receipt')
})

test('Start remains rejected while the Candidate surface exists', () => {
  assert.equal(WORKBENCH_PROTOCOL, 'omarchestra.workbench/v1')
  assert.match(START_UNAVAILABLE_REASON, /current Runner-validated Start Review/)
  assert.equal(Object.prototype.hasOwnProperty.call(foundation, 'CandidateSubmissionCoordinator'), false, 'candidate association is not part of the foundation surface')
})
