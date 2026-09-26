import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchStore, type WorkbenchStore } from '../runner/store.ts'
import { inspectProjectPath } from '../runner/git-context.ts'
import { projectExecutionContextDigest, canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { prepareStartProposal, revalidateStartProposal, type StartProposalAuthority, type StartProposalRequest } from '../runner/start-proposal.ts'

const NODE = 'node-1'
const CHALLENGE = 'c'.repeat(32)

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-start-proposal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectPath = join(root, 'worktree')
  const statePath = join(root, 'state')
  mkdirSync(projectPath)
  mkdirSync(statePath)
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Workbench Test'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['config', 'user.email', 'workbench-test@example.invalid'], { cwd: projectPath })
  writeFileSync(join(projectPath, 'README.md'), 'baseline\n')
  writeFileSync(join(projectPath, 'policy.txt'), 'policy-v1\n')
  execFileSync('/usr/bin/git', ['add', 'README.md', 'policy.txt'], { cwd: projectPath })
  execFileSync('/usr/bin/git', ['commit', '-q', '-m', 'fixture'], { cwd: projectPath })

  const inspection = inspectProjectPath(projectPath)
  assert.equal(inspection.supported, true, inspection.reasons.join(','))
  const project = {
    projectId: 'project-1', executionNodeId: NODE, canonicalPath: inspection.canonicalPath,
    gitCommonDir: inspection.gitCommonDir!, headOid: inspection.headOid, dirty: inspection.dirty!,
    contextDigest: inspection.repositoryIdentity, revision: 1, createdAt: 1,
  }
  const store = openWorkbenchStore({ path: join(statePath, 'store.sqlite'), nodeId: NODE, create: true, clock: () => 100 })
  t.after(() => store.close())
  store.putProject(project)
  store.insertGoal({ goalId: 'goal-1', projectId: project.projectId, goalText: 'Ship the workbench loop', state: 'active', outcome: null, createdAt: 1 })
  store.setMeta('selected_project_id', project.projectId)
  store.setMeta('selected_goal_id', 'goal-1')

  const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
    name: 'Build check', summary: 'Confirm build behavior', mode: 'validator', commandSummary: 'Run fixed validator',
    definitionDraft: {
      executable: '/usr/bin/true', argv: [], cwd: project.canonicalPath, environment: [],
      resourcePaths: [join(project.canonicalPath, 'policy.txt')], timeoutMs: 1000,
      outputBytes: 4096, maxCorrections: 2, elapsedMs: 60_000,
    },
  })
  const checkJson = canonicalJson(definition)
  const check = {
    projectId: project.projectId, checkId: 'check-1', version: 1, digest: sha256(checkJson),
    canonicalJson: checkJson, name: definition.name, mode: definition.mode, createdAt: 1,
  }
  store.putCheck(check)

  const incarnation = {
    executionNodeId: NODE, processInstanceId: 'proc-1', piSessionId: 'session-1', extensionInstanceId: 'ext-1',
  }
  const binding = {
    runId: 'run-1', projectId: project.projectId, role: 'builder', state: 'committed' as const,
    bindingDigest: sha256('binding'), controlEpoch: 7, writerState: 'none' as const,
    predecessorRunId: null, generation: 1, updatedAt: 1,
  }
  store.putBinding(binding)
  store.putBindingIdentity(binding.runId, 'goal-1', incarnation)
  store.commitMembership(binding.runId)
  store.putBinding({ ...binding, state: 'ready' })

  const live = {
    observedSessionId: 'observed-1', incarnation,
    lifecycle: 'running', activity: 'idle', health: 'healthy', available: true,
    mode: 'committed' as const, executionContextDigest: projectExecutionContextDigest(project.canonicalPath),
    executionContextAt: 100,
    connectionId: 'i'.repeat(32), challenge: CHALLENGE,
    matchesContext: true,
  }
  let sends = 0
  const peer = { send() { sends++ }, close() {} }
  const registry = {
    listCurrent() { return [{
      observedSessionId: live.observedSessionId, sessionCode: null, navigation: null,
      incarnation: { ...live.incarnation }, lifecycle: live.lifecycle, activity: live.activity, health: live.health,
      available: live.available, mode: live.mode, executionContextDigest: live.executionContextDigest,
      executionContextAt: live.executionContextAt,
    }] },
    currentBinding(observedSessionId: string) {
      if (!live.available || observedSessionId !== live.observedSessionId) return null
      return {
        observation: this.listCurrent()[0], connectionId: live.connectionId, challenge: live.challenge, peer,
      }
    },
    assignmentLoopAvailable() { return true },
    projectContextMatches(runId: string, canonicalPath: string) {
      return runId === binding.runId && canonicalPath === project.canonicalPath && live.matchesContext && live.available
    },
  }
  let revision = 4
  const authority: StartProposalAuthority = {
    store,
    registry,
    fences: { isFenced: () => false, isIncarnationFenced: () => false },
    currentRevision: () => revision,
  }
  const request: StartProposalRequest = {
    projectId: project.projectId, goalId: 'goal-1', agentRunId: binding.runId,
    checkId: check.checkId, checkVersion: check.version,
    taskText: 'Implement the bounded assignment loop.\nReport the changed files.',
    limits: { maxCorrections: 2, elapsedMs: 60_000 }, expectedRevision: revision,
  }
  const options = {
    newId: (prefix: string) => `${prefix}fixed`,
    clock: () => 1000,
  }
  return {
    authority, request, options, store, live, project, check, peer,
    setRevision(value: number) { revision = value },
    sends: () => sends,
  }
}

function assertCode(code: string, fn: () => unknown) {
  assert.throws(fn, error => (error as { code?: string }).code === code)
}

test('legacy observer/Adoption support cannot authorize an incomplete Assignment loop', t => {
  const f = fixture(t)
  f.authority.registry!.assignmentLoopAvailable = () => false
  assert.throws(() => prepareStartProposal(f.authority, f.request, f.options), /native Candidate, fresh quiescence or operator intervention/)
  assert.equal(f.sends(), 0)
})

test('prepares and revalidates an immutable transient snapshot without persistence or dispatch', t => {
  const f = fixture(t)
  const proposal = prepareStartProposal(f.authority, f.request, f.options)

  assert.equal(proposal.confirmationId, 'confirmation-fixed')
  assert.equal(proposal.proposalDigest.length, 64)
  assert.equal(proposal.revision, 4)
  assert.equal(proposal.projectRevision, f.project.revision)
  assert.equal(proposal.assignment.assignmentId, 'assignment-fixed')
  assert.equal(proposal.assignment.goalText, 'Ship the workbench loop')
  assert.equal(proposal.assignment.taskText, f.request.taskText)
  assert.equal(proposal.attempt.attemptId, 'attempt-fixed')
  assert.equal(proposal.attempt.deliveryId, 'delivery-fixed')
  assert.equal(proposal.attempt.ordinal, 1)
  assert.equal(proposal.attempt.state, 'admitted')
  assert.equal(proposal.attempt.writerEpoch, 1)
  assert.equal(proposal.attempt.controlEpoch, 7)
  assert.equal(proposal.attempt.runBinding.connectionId, f.live.connectionId)
  assert.equal(proposal.attempt.runBinding.connectionChallenge, f.live.challenge)
  assert.equal(proposal.attempt.gate.digest, f.check.digest)
  assert.equal(proposal.attempt.gate.canonicalJson, f.check.canonicalJson)
  assert.equal(proposal.context.baselineDigest, proposal.baseline.baselineDigest)
  assert.equal(proposal.context.manifestDigest, proposal.baseline.manifestDigest)
  assert.equal(proposal.context.repositoryIdentity, f.project.contextDigest)
  assert.equal(proposal.context.headOid, proposal.baseline.headOid)
  assert.deepEqual(proposal.contextRuns.map(run => run.runId), ['run-1'])
  assert.ok(Object.isFrozen(proposal) && Object.isFrozen(proposal.attempt.runBinding) && Object.isFrozen(proposal.resolvedGate.resources))
  assert.deepEqual(f.store.listAssignments(), [])
  assert.deepEqual(f.store.listAttempts(), [])
  assert.equal(f.sends(), 0)
  assert.strictEqual(revalidateStartProposal(f.authority, proposal, f.options), proposal)
})

test('confirmation rejects changed projection and Project revisions, Run control epoch, and challenged connection', t => {
  const f = fixture(t)
  const proposal = prepareStartProposal(f.authority, f.request, f.options)
  f.setRevision(f.request.expectedRevision + 1)
  assertCode('identity_drift', () => revalidateStartProposal(f.authority, proposal, f.options))
  f.setRevision(f.request.expectedRevision)

  f.live.challenge = 'd'.repeat(32)
  assertCode('identity_drift', () => revalidateStartProposal(f.authority, proposal, f.options))

  const g = fixture(t)
  const projectProposal = prepareStartProposal(g.authority, g.request, g.options)
  g.store.putProject({ ...g.project, revision: g.project.revision + 1 })
  assertCode('identity_drift', () => revalidateStartProposal(g.authority, projectProposal, g.options))

  const h = fixture(t)
  const runProposal = prepareStartProposal(h.authority, h.request, h.options)
  const binding = h.store.getBinding('run-1')!
  h.store.putBinding({ ...binding, controlEpoch: binding.controlEpoch + 1 })
  assertCode('identity_drift', () => revalidateStartProposal(h.authority, runProposal, h.options))
})

test('confirmation rejects C9 content drift and pinned check-resource drift', t => {
  const f = fixture(t)
  const proposal = prepareStartProposal(f.authority, f.request, f.options)
  writeFileSync(join(f.project.canonicalPath, 'new-file.txt'), 'new baseline content\n')
  assertCode('identity_drift', () => revalidateStartProposal(f.authority, proposal, f.options))

  const g = fixture(t)
  const second = prepareStartProposal(g.authority, g.request, g.options)
  writeFileSync(join(g.project.canonicalPath, 'policy.txt'), 'changed check resource\n')
  assertCode('identity_drift', () => revalidateStartProposal(g.authority, second, g.options))
})

test('Start Review fails closed for non-idle, disconnected, fenced, or busy Project state', t => {
  const f = fixture(t)
  f.live.activity = 'busy'
  assertCode('invalid_input', () => prepareStartProposal(f.authority, f.request, f.options))
  f.live.activity = 'idle'
  f.live.available = false
  assertCode('invalid_input', () => prepareStartProposal(f.authority, f.request, f.options))

  const g = fixture(t)
  g.authority.fences.isFenced = () => true
  assertCode('invalid_input', () => prepareStartProposal(g.authority, g.request, g.options))

  const h = fixture(t)
  h.store.acquireWriter({ projectId: h.project.projectId, assignmentId: null, attemptId: null, epoch: 1, updatedAt: 1 })
  assertCode('invalid_input', () => prepareStartProposal(h.authority, h.request, h.options))
})

test('invalid limits, text, and stale initial revision are rejected', t => {
  const f = fixture(t)
  assertCode('invalid_input', () => prepareStartProposal(f.authority, { ...f.request, taskText: 'bad\u0000text' }, f.options))
  assertCode('invalid_input', () => prepareStartProposal(f.authority, { ...f.request, limits: { maxCorrections: 4, elapsedMs: 60_000 } }, f.options))
  f.setRevision(f.request.expectedRevision + 1)
  assertCode('invalid_input', () => prepareStartProposal(f.authority, f.request, f.options))
})

test('modified transient proposal is rejected before current-state revalidation', t => {
  const f = fixture(t)
  const proposal = structuredClone(prepareStartProposal(f.authority, f.request, f.options))
  proposal.assignment.taskText = 'substituted task'
  assertCode('identity_drift', () => revalidateStartProposal(f.authority, proposal, f.options))
})
