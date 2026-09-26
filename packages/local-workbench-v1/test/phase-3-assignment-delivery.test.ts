/**
 * AL-03 committed same-Pi delivery. One queued outbox row is sent once on the
 * exact challenged committed connection, the extension deduplicates by stable
 * delivery identity, and lost ACK / accepted-then-throw / disconnect /
 * duplicate / conflicting / restart all stay bounded: no hidden queue, no blind
 * resend, and writer uncertainty is only cleared by explicit reconciliation.
 * Start stays disabled throughout.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { decodeBridgeFrame, encodeBridgeFrame, type BridgeFrame } from '../runner/bridge-protocol.ts'
import { armAssignmentBudget } from '../runner/assignment-budget.ts'
import { assignmentMessage, createPiBridgeExtension, type CandidateTool } from '../runner/pi-bridge-extension.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { canonicalJson, sha256 } from '../runner/canonical-hash.ts'
import { resolveCheckDefinition } from '../runner/check-definition.ts'
import { CandidateSubmissionCoordinator } from '../runner/candidate-submission.ts'
import installNativeExtension from '../pi-extension.ts'
import { AssignmentDeliveryCoordinator } from '../runner/bridge-delivery.ts'
import { WORKBENCH_PROTOCOL } from '../console/schema.ts'
import { START_UNAVAILABLE_REASON } from '../runner/authority.ts'
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

interface Fixture {
  root: string
  runner: ReturnType<typeof openWorkbenchRunner>
  registry: BridgeRegistry
  authority: WorkbenchAuthority
  projectId: string
  goalId: string
  streams: Array<ReturnType<typeof pair>>
  hooks: Map<string, (event: unknown, ctx: unknown) => void>
  host: Record<string, unknown>
  calls: string[]
  tools: Map<string, CandidateTool>
  heartbeat: () => void
  deadlineTicks: Array<() => void>
  coordinator: AssignmentDeliveryCoordinator
  adopt: () => Promise<string>
  seed: (runId: string) => { assignmentId: string; attemptId: string; deliveryId: string; frameJson: string }
  taskText: string
  now: () => number
  setNow: (value: number) => void
}

function setup(t: TestContext, options: { unsupportedApi?: boolean; sendThenThrow?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-delivery-'))
  let now = 1000
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  const initialized = execFileSync('/usr/bin/git', ['init', '--quiet', projectPath], { timeout: 5_000, encoding: 'utf8' })
  void initialized
  writeFileSync(join(projectPath, 'policy.txt'), 'policy\n')
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.name', 'Workbench Test'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.email', 'workbench-test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'add', 'policy.txt'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'commit', '-q', '-m', 'fixture'])
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, registry, clock: () => now })
  const inspection = authority.inspect(projectPath)
  assert.ok(inspection.inspectionId)
  const projectId = authority.confirmRegistration(inspection.inspectionId).projectId
  const goalId = 'goal-1'
  runner.store.insertGoal({ goalId, projectId, goalText: 'explicit goal', state: 'active', outcome: null, createdAt: now })
  runner.store.setMeta('selected_goal_id', goalId)

  const calls: string[] = []
  const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const host: Record<string, unknown> = { mode: 'tui', cwd: projectPath, sessionManager: { getSessionId: () => PI_SESSION }, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} } }
  const streams: Array<ReturnType<typeof pair>> = []
  const deadlineTicks: Array<() => void> = []
  const extensionTicks: Array<() => void> = []
  const tools = new Map<string, CandidateTool>()
  let serial = 0
  const clientFor = (onFrame: (frame: BridgeFrame) => void, onClose: () => void) => {
    const p = pair()
    streams.push(p)
    attachBridgeStream(p.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
    return attachBridgeStream(p.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
  }
  const makePi = () => {
    const pi: Record<string, unknown> = { on(name: string, fn: (event: unknown, ctx: unknown) => void) { hooks.set(name, fn) }, registerTool(tool: CandidateTool) { tools.set(tool.name, tool) } }
    if (!options.unsupportedApi) {
      pi.sendUserMessage = (text: string) => { calls.push(text); if (options.sendThenThrow) throw Error('accepted_then_threw') }
    }
    return pi
  }
  createPiBridgeExtension({
    navigate: null,
    newId: prefix => prefix === 'process' ? PROCESS_ID : prefix === 'extension' ? EXTENSION_ID : `${prefix}-${(++serial).toString(16).padStart(32, '0')}`,
    schedule: callback => { extensionTicks.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> },
    connect: async (onFrame, onClose) => clientFor(onFrame, onClose),
  })(makePi() as never)

  const coordinator = new AssignmentDeliveryCoordinator({
    store: runner.store, registry, clock: () => now, newId: prefix => `${prefix}-${serial++}`,
    schedule: callback => { deadlineTicks.push(callback); return deadlineTicks.length as unknown as ReturnType<typeof setTimeout> },
    cancel: () => {},
  })

  const adopt = async () => {
    hooks.get('session_start')!(null, host)
    await new Promise(resolve => setImmediate(resolve))
    const observed = [...registry.list()].find(o => o.available)!
    const proposal = authority.adoption.propose({ projectId, goalId, role: 'implementer', observedSessionId: observed.observedSessionId })
    authority.adoption.authorize(proposal.proposalId)
    extensionTicks.shift()!()
    return proposal.runId
  }

  const seed = (runId: string) => {
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
    const bindingDigest = runner.store.getBinding(runId)!.bindingDigest!
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
      deliveryId, assignmentId, attemptId, runId, projectId, goalId, controlEpoch: 1,
      goalText: 'explicit goal', taskText: TASK_TEXT, writeAuthority: false,
      limits: { maxCorrections: 2, elapsedMs: 60_000 }, gate, runBinding, context, deadline: now + 30_000,
    })
    runner.store.transaction(() => {
      runner.store.putAssignment({
        assignmentId, projectId, goalId, agentRunId: runId, bindingDigest, goalText: 'explicit goal', taskText: TASK_TEXT,
        writeAuthority: false, state: 'admitted', limits: { maxCorrections: 2, elapsedMs: 60_000 }, attemptCount: 0, revision: 1, createdAt: now, updatedAt: now,
      })
      armAssignmentBudget(runner.store, runner.store.getAssignment(assignmentId)!, now)
      runner.store.putAttempt({
        attemptId, assignmentId, ordinal: 1, state: 'admitted', runBinding, gate, context,
        limits: { maxCorrections: 2, elapsedMs: 60_000 }, writerEpoch: 1, controlEpoch: 1, deliveryId, createdAt: now, updatedAt: now,
      })
      runner.store.acquireWriter({ projectId, assignmentId, attemptId, epoch: 1, updatedAt: now })
      runner.store.putAssignmentDelivery({ deliveryId, assignmentId, attemptId, runId, frameJson, payloadDigest: sha256(frameJson), state: 'queued', reasonCode: null, deadline: now + 30_000, createdAt: now })
    })
    return { assignmentId, attemptId, deliveryId, frameJson }
  }

  return { root, runner, registry, authority, projectId, goalId, streams, hooks, host, calls, tools, heartbeat: () => extensionTicks.shift()!(), deadlineTicks, coordinator, adopt, seed, taskText: TASK_TEXT, now: () => now, setNow: value => { now = value } }
}

test('one committed delivery sends exactly one bounded same-Pi turn and settles accepted', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const { attemptId, deliveryId } = s.seed(runId)
  const result = await s.coordinator.deliver(attemptId)
  assert.deepEqual(result, { deliveryId, state: 'written', outcome: 'accepted', storedOutcome: null, reasonCode: null, replayed: false })
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)], 'the admitted task plus explicit Candidate instructions reaches the Pi API once')
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.state, 'written')
  assert.equal(s.runner.store.getWriter(s.projectId)?.state, 'held', 'a proven delivery keeps the writer held')
  const ack = s.streams[0].b.frames.filter(frame => frame.type === 'assignment_ack')
  assert.equal(ack.length, 1)
  assert.equal(ack[0].body.outcome, 'accepted')
  assert.equal(ack[0].body.runId, runId)
})

test('duplicate and conflicting frames never create a second turn and preserve the stored outcome', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const { attemptId } = s.seed(runId)
  await s.coordinator.deliver(attemptId)
  const replay = await s.coordinator.deliver(attemptId)
  assert.equal(replay.replayed, true)
  assert.equal(replay.outcome, 'accepted')
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)])
  const original = s.streams[0].a.frames.find(frame => frame.type === 'assignment_delivery')!
  // Exact wire duplicate: the extension returns the stored outcome.
  s.streams[0].a.write(encodeBridgeFrame('assignment_delivery', 'duplicate-frame', { ...original.body }))
  const duplicates = s.streams[0].b.frames.filter(frame => frame.type === 'assignment_ack' && frame.body.outcome === 'duplicate')
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].body.storedOutcome, 'accepted')
  // Conflicting reuse of the same delivery id with different bytes is refused.
  const conflicting = { ...original.body, payloadJson: canonicalJson({ protocol: 'omarchestra.assignment/v1', kind: 'assignment_delivery', deliveryId: 'delivery-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', runId, taskText: 'other' }) }
  s.streams[0].a.write(encodeBridgeFrame('assignment_delivery', 'conflicting-frame', { ...conflicting, payloadDigest: sha256(conflicting.payloadJson) }))
  assert.equal(s.streams[0].b.frames.some(frame => frame.type === 'assignment_ack' && frame.body.reason === 'delivery_conflict'), true)
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)], 'neither duplicate nor conflict ever opens another turn')
})

test('a lost ACK becomes unknown and uncertain, then explicit receipt reconciliation recovers written without releasing the writer', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const { attemptId, deliveryId } = s.seed(runId)
  s.streams[0].b.drop.add('assignment_ack')
  const pending = s.coordinator.deliver(attemptId)
  await new Promise(resolve => setImmediate(resolve))
  s.deadlineTicks.shift()!()
  const lost = await pending
  assert.equal(lost.outcome, 'unknown')
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.state, 'unknown')
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.reasonCode, 'transport_error')
  assert.equal(s.runner.store.getWriter(s.projectId)?.state, 'uncertain', 'lost ACK leaves the writer uncertain')
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)])
  s.streams[0].b.drop.delete('assignment_ack')
  const reconciled = await s.coordinator.reconcile(attemptId)
  assert.deepEqual(reconciled, { deliveryId, state: 'written', outcome: 'accepted', storedOutcome: 'accepted', reasonCode: null, replayed: false })
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.state, 'written')
  assert.equal(s.runner.store.getWriter(s.projectId)?.state, 'uncertain', 'reconciliation never silently clears writer uncertainty')
  assert.throws(() => s.runner.store.releaseWriter(s.projectId, s.now()), error => (error as { code?: string }).code === 'fence_conflict')
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)], 'reconciliation queries the receipt; it never resends')
})

test('busy and unsupported peers refuse without queueing a hidden turn', async t => {
  const busy = setup(t)
  const busyRun = await busy.adopt()
  const busyIds = busy.seed(busyRun)
  ;(busy.host as { isIdle: () => boolean }).isIdle = () => false
  const busyResult = await busy.coordinator.deliver(busyIds.attemptId)
  assert.equal(busyResult.outcome, 'busy')
  assert.equal(busyResult.state, 'not_sent')
  assert.equal(busyResult.reasonCode, 'revoked')
  assert.deepEqual(busy.calls, [], 'busy refuses without creating a turn')
  const busyReplay = await busy.coordinator.deliver(busyIds.attemptId)
  assert.equal(busyReplay.replayed, true)
  assert.equal(busyReplay.state, 'not_sent')

  const unsupported = setup(t, { unsupportedApi: true })
  const unsupportedRun = await unsupported.adopt()
  const unsupportedIds = unsupported.seed(unsupportedRun)
  const unsupportedResult = await unsupported.coordinator.deliver(unsupportedIds.attemptId)
  assert.equal(unsupportedResult.outcome, 'invalid')
  assert.equal(unsupportedResult.state, 'not_sent')
  assert.equal(unsupported.streams[0].b.frames.some(frame => frame.type === 'assignment_ack' && frame.body.outcome === 'invalid' && frame.body.reason === 'unsupported'), true)
})

test('an accepted-then-throw send is unproven and never re-sent as a second turn', async t => {
  const s = setup(t, { sendThenThrow: true })
  const runId = await s.adopt()
  const { attemptId } = s.seed(runId)
  const result = await s.coordinator.deliver(attemptId)
  assert.equal(result.outcome, 'unknown')
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.state, 'unknown')
  assert.equal(s.runner.store.getWriter(s.projectId)?.state, 'uncertain')
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)], 'the API was invoked once and the throw is reported, never retried')
  const replay = await s.coordinator.deliver(attemptId)
  assert.equal(replay.replayed, true)
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)])
  const original = s.streams[0].a.frames.find(frame => frame.type === 'assignment_delivery')!
  s.streams[0].a.write(encodeBridgeFrame('assignment_delivery', 'throw-duplicate', { ...original.body }))
  assert.deepEqual(s.calls, [assignmentMessage(TASK_TEXT)], 'a duplicate cannot repeat an unproven API invocation')
  const receipt = await s.coordinator.reconcile(attemptId)
  assert.equal(receipt.state, 'unknown')
  const stopped = s.authority.stopAssignment({ assignmentId: 'assignment-1' })
  assert.equal(stopped.writerState, 'uncertain', 'stop never releases effects of a throwing send')
})

test('a disconnect before send leaves the delivery not_sent with no turn and no receipt', async t => {
  const s = setup(t)
  const runId = await s.adopt()
  const { attemptId } = s.seed(runId)
  s.streams[0].a.destroy()
  const result = await s.coordinator.deliver(attemptId)
  assert.equal(result.outcome, 'not_sent')
  assert.equal(result.state, 'not_sent')
  assert.equal(s.runner.store.getAssignmentDelivery(attemptId)?.state, 'not_sent')
  assert.deepEqual(s.calls, [])
  const reconciled = await s.coordinator.reconcile(attemptId)
  assert.equal(reconciled.replayed, true)
  assert.deepEqual(s.calls, [])
  assert.equal(s.authority.stopAssignment({ assignmentId: 'assignment-1' }).writerState, 'uncertain',
    'stop records successfully but cannot erase pre-existing coverage uncertainty')
})

test('restart never inherits dedup identity: recovery makes delivery unknown and a surviving-but-reloaded extension reports no receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-delivery-restart-'))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { mode: 0o700 })
  const projectPath = join(root, 'project')
  mkdirSync(projectPath)
  execFileSync('/usr/bin/git', ['init', '--quiet', projectPath], { timeout: 5_000 })
  writeFileSync(join(projectPath, 'policy.txt'), 'policy\n')
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.name', 'Workbench Test'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'config', 'user.email', 'workbench-test@example.invalid'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'add', 'policy.txt'])
  execFileSync('/usr/bin/git', ['-C', projectPath, 'commit', '-q', '-m', 'fixture'])
  let now = 1000
  let runner = openWorkbenchRunner({ roots: { stateDir }, clock: () => now })
  const opened = new Set([runner])
  t.after(() => { for (const item of opened) item.close(); rmSync(root, { recursive: true, force: true }) })
  const bootstrap = () => {
    const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
    const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, registry, clock: () => now })
    const inspection = authority.inspect(projectPath)
    const projectId = authority.confirmRegistration(inspection.inspectionId).projectId
    runner.store.insertGoal({ goalId: 'goal-1', projectId, goalText: 'explicit goal', state: 'active', outcome: null, createdAt: now })
    runner.store.setMeta('selected_goal_id', 'goal-1')
    return { registry, authority, projectId }
  }
  const connectPeers = (registry: BridgeRegistry, hooks: Map<string, (event: unknown, ctx: unknown) => void>) => {
    const streams: Array<ReturnType<typeof pair>> = []
    createPiBridgeExtension({
      navigate: null,
      newId: prefix => prefix === 'process' ? PROCESS_ID : prefix === 'extension' ? EXTENSION_ID : `${prefix}-${Math.random().toString(16).slice(2).padEnd(32, '0')}`,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      connect: async (onFrame, onClose) => {
        const p = pair()
        streams.push(p)
        attachBridgeStream(p.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
        return attachBridgeStream(p.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
      },
    })({ on(name, fn) { hooks.set(name, fn as never) }, sendUserMessage: () => {} } as never)
    return streams
  }
  const first = bootstrap()
  const firstHooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const firstStreams = connectPeers(first.registry, firstHooks)
  const host = { mode: 'tui', sessionManager: { getSessionId: () => PI_SESSION }, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} } }
  firstHooks.get('session_start')!(null, host)
  await new Promise(resolve => setImmediate(resolve))
  const observed = first.registry.list().find(o => o.available)!
  const proposal = first.authority.adoption.propose({ projectId: first.projectId, goalId: 'goal-1', role: 'implementer', observedSessionId: observed.observedSessionId })
  first.authority.adoption.authorize(proposal.proposalId)
  const runId = proposal.runId
  const project = runner.store.getProject(first.projectId)!
  const definition = resolveCheckDefinition(project, { checkId: 'check-1', version: 1 }, {
    name: 'Build check', summary: 'Confirm build behavior', mode: 'validator', commandSummary: 'Run fixed validator',
    definitionDraft: { executable: '/usr/bin/true', argv: [], cwd: project.canonicalPath, environment: [], resourcePaths: [join(project.canonicalPath, 'policy.txt')], timeoutMs: 1000, outputBytes: 4096, maxCorrections: 2, elapsedMs: 60_000 },
  })
  const checkJson = canonicalJson(definition)
  runner.store.putCheck({ projectId: first.projectId, checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson, name: definition.name, mode: definition.mode, createdAt: now })
  const live = first.registry.currentBinding(observed.observedSessionId)!
  const runBinding = { executionNodeId: runner.nodeId, processInstanceId: PROCESS_ID, piSessionId: PI_SESSION, extensionInstanceId: EXTENSION_ID, runId, goalId: 'goal-1', bindingDigest: sha256('binding-digest'), connectionId: live.connectionId, connectionChallenge: live.challenge }
  const context = { projectId: first.projectId, executionNodeId: runner.nodeId, canonicalPath: project.canonicalPath, gitCommonDir: project.gitCommonDir, repositoryIdentity: project.contextDigest, headOid: project.headOid ?? 'a'.repeat(40), dirty: project.dirty, baselineDigest: sha256('baseline'), manifestDigest: sha256('manifest') }
  const gate = { checkId: 'check-1', version: 1, digest: sha256(checkJson), canonicalJson: checkJson }
  const frameJson = canonicalJson({ protocol: 'omarchestra.assignment/v1', kind: 'assignment_delivery', deliveryId: 'delivery-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', runId, projectId: first.projectId, goalId: 'goal-1', goalText: 'explicit goal', taskText: TASK_TEXT, writeAuthority: false, limits: { maxCorrections: 2, elapsedMs: 60_000 }, gate, runBinding, context, deadline: now + 30_000 })
  runner.store.transaction(() => {
    runner.store.putAssignment({ assignmentId: 'assignment-1', projectId: first.projectId, goalId: 'goal-1', agentRunId: runId, bindingDigest: sha256('binding-digest'), goalText: 'explicit goal', taskText: TASK_TEXT, writeAuthority: false, state: 'admitted', limits: { maxCorrections: 2, elapsedMs: 60_000 }, attemptCount: 0, revision: 1, createdAt: now, updatedAt: now })
    runner.store.putAttempt({ attemptId: 'attempt-1', assignmentId: 'assignment-1', ordinal: 1, state: 'admitted', runBinding, gate, context, limits: { maxCorrections: 2, elapsedMs: 60_000 }, writerEpoch: 1, controlEpoch: 1, deliveryId: 'delivery-1', createdAt: now, updatedAt: now })
    runner.store.acquireWriter({ projectId: first.projectId, assignmentId: 'assignment-1', attemptId: 'attempt-1', epoch: 1, updatedAt: now })
    runner.store.putAssignmentDelivery({ deliveryId: 'delivery-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', runId, frameJson, payloadDigest: sha256(frameJson), state: 'queued', reasonCode: null, deadline: now + 30_000, createdAt: now })
  })
  // A crash after the write-ahead `attempting` marker, before any ACK is durable.
  assert.equal(runner.store.transitionAssignmentDelivery('attempt-1', 'queued', 'attempting', null), true)
  firstStreams[0].a.destroy()
  runner.close()
  opened.delete(runner)
  now = 5000
  runner = openWorkbenchRunner({ roots: { stateDir }, clock: () => now })
  opened.add(runner)
  assert.equal(runner.store.getAssignmentDelivery('attempt-1')?.state, 'unknown')
  assert.equal(runner.store.getAssignmentDelivery('attempt-1')?.reasonCode, 'owner_restarted')
  assert.equal(runner.store.getWriter(first.projectId)?.state, 'uncertain')
  // A reloaded/replacement extension re-registers on the surviving committed Run
  // but has no inherited receipt identity.
  const secondRegistry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => now })
  const secondHooks = new Map<string, (event: unknown, ctx: unknown) => void>()
  const secondStreams = connectPeers(secondRegistry, secondHooks)
  void secondStreams
  secondHooks.get('session_start')!(null, host)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondRegistry.list()[0].mode, 'committed', 'the surviving binding still authorizes the replacement extension')
  const deadlineTicks: Array<() => void> = []
  const coordinator = new AssignmentDeliveryCoordinator({ store: runner.store, registry: secondRegistry, clock: () => now, newId: prefix => `${prefix}-x`, schedule: callback => { deadlineTicks.push(callback); return deadlineTicks.length as unknown as ReturnType<typeof setTimeout> }, cancel: () => {} })
  const reconciled = await coordinator.reconcile('attempt-1')
  assert.equal(reconciled.outcome, 'unknown', 'no surviving receipt leaves the delivery uncertain')
  assert.equal(runner.store.getAssignmentDelivery('attempt-1')?.state, 'unknown')
  assert.equal(runner.store.getWriter(first.projectId)?.state, 'uncertain', 'restart never clears writer uncertainty')
})

test('the native package entry registers a bounded Candidate tool without opening a session', async () => {
  const tools = new Map<string, CandidateTool>()
  installNativeExtension({ on() {}, registerTool(tool) { tools.set(tool.name, tool) } })
  const tool = tools.get('omarchestra_submit_candidate')!
  assert.ok(tool)
  assert.equal((await tool.execute('unmanaged', { summary: 'not assigned', artifactRefs: [] })).details.outcome, 'invalid')
})

test('registered Candidate tool derives identity only from the delivered Assignment', async t => {
  const s = setup(t), tool = s.tools.get('omarchestra_submit_candidate')!
  new CandidateSubmissionCoordinator({ store: s.runner.store, registry: s.registry, clock: s.now,
    associate: input => s.authority.associateCandidate(input) })
  const run = await s.adopt(), ids = s.seed(run)
  assert.equal((await tool.execute('before', { summary: 'done', artifactRefs: [] })).details.outcome, 'invalid')
  await s.coordinator.deliver(ids.attemptId)
  assert.equal((await tool.execute('spoof', { assignmentId: 'other', summary: 'done', artifactRefs: [] })).details.outcome, 'invalid')
  const result = (await tool.execute('valid', { summary: 'done', artifactRefs: [] })).details
  assert.equal(result.outcome, 'accepted')
  assert.equal(s.runner.store.getCandidate(result.candidateId!)!.attemptId, ids.attemptId)
  assert.equal((await tool.execute('duplicate', { summary: 'done', artifactRefs: [] })).details.outcome, 'duplicate')
  s.hooks.get('input')!({ source: 'interactive' }, s.host)
  assert.equal((await tool.execute('takeover', { summary: 'late', artifactRefs: [] })).details.outcome, 'invalid')
  s.hooks.get('session_shutdown')!(null, s.host)
  assert.equal((await tool.execute('ended', { summary: 'late', artifactRefs: [] })).details.outcome, 'invalid')
})

test('final dispatch refuses epoch drift and fresh or unreported Pi cwd drift', async t => {
  for (const drift of ['epoch', 'reported_context', 'unreported_context', 'stale_context', 'budget']) {
    await t.test(drift, async t => {
      const s = setup(t), run = await s.adopt(), ids = s.seed(run)
      if (drift === 'epoch') s.runner.store.setBindingControlEpoch(run, 2, s.now())
      if (drift.includes('context') && drift !== 'stale_context') s.host.cwd = s.root
      if (drift === 'reported_context') s.heartbeat()
      if (drift === 'stale_context') s.setNow(8000)
      if (drift === 'budget') s.setNow(62000)
      const result = await s.coordinator.deliver(ids.attemptId)
      assert.equal(result.state, 'not_sent')
      assert.deepEqual(s.calls, [])
    })
  }
})

test('operator and source takeover atomically pause Assignment state and outbox', async t => {
  for (const route of ['input', 'dock']) {
    await t.test(route, async t => {
      const s = setup(t), run = await s.adopt(), ids = s.seed(run)
      if (route === 'input') s.hooks.get('input')!({ source: 'interactive' }, s.host)
      else {
        const outcome = s.authority.handlePresentationIntent({ protocol: WORKBENCH_PROTOCOL, sessionId: 'session', pluginGeneration: 1,
          runnerEpoch: s.runner.epoch, intentId: 'take-control', expectedRevision: s.authority.currentRevision,
          kind: 'take_control', target: run, payload: { agentRunId: run } })
        assert.equal((await outcome).status, 'acknowledged')
      }
      assert.equal(s.runner.store.getBinding(run)!.controlEpoch, 2)
      assert.equal(s.runner.store.getAssignment(ids.assignmentId)!.state, 'attention')
      assert.equal(s.runner.store.getAttempt(ids.attemptId)!.state, 'attention')
      assert.equal(s.runner.store.getAssignmentDelivery(ids.attemptId)!.state, 'not_sent')
      assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'held')
      assert.equal((await s.coordinator.deliver(ids.attemptId)).state, 'not_sent')
      assert.deepEqual(s.calls, [])
      s.authority.recordAssignmentHandoff({ attemptId: ids.attemptId, claimedState: 'partial', summary: 'Explicit handoff', artifactRefs: [], outstandingEffects: 'unknown' })
      assert.equal(s.runner.store.getAssignment(ids.assignmentId)!.state, 'reconciling')
    })
  }
})

test('quiescence uses a fresh exact query, not cached idle; lost replies stay unknown', async t => {
  const s = setup(t), run = await s.adopt(), ids = s.seed(run)
  await s.coordinator.deliver(ids.attemptId)
  s.setNow(4000) // cached idle now exceeds C9's two-second bound
  s.host.isIdle = () => false
  const busy = await s.registry.queryAttemptQuiescence(ids.attemptId)
  assert.equal(busy?.status, 'active')
  assert.equal(s.registry.quiescenceCurrent(busy!), false)
  s.host.isIdle = () => true
  const fresh = await s.registry.queryAttemptQuiescence(ids.attemptId)
  assert.equal(fresh?.status, 'confirmed')
  assert.equal(s.registry.quiescenceCurrent(fresh!), true)
  s.setNow(6001)
  assert.equal(s.registry.quiescenceCurrent(fresh!), false)
  s.streams[0].b.drop.add('quiescence_report')
  assert.equal(await s.registry.queryAttemptQuiescence(ids.attemptId), null)
  s.streams[0].b.drop.delete('quiescence_report')
  s.streams[0].a.destroy()
  assert.equal(s.runner.store.getWriter(s.projectId)!.state, 'uncertain', 'lost coverage is not cleared by idle')
  assert.equal(await s.registry.queryAttemptQuiescence(ids.attemptId), null)
})

test('Start remains rejected while the delivery surface exists', () => {
  assert.equal(WORKBENCH_PROTOCOL, 'omarchestra.workbench/v1')
  assert.match(START_UNAVAILABLE_REASON, /current Runner-validated Start Review/)
  assert.equal(Object.prototype.hasOwnProperty.call(foundation, 'AssignmentDeliveryCoordinator'), false, 'delivery coordination is not part of the foundation surface')
})
