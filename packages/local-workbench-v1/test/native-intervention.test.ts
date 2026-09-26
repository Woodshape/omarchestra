import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { AssignmentDeliveryCoordinator } from '../runner/bridge-delivery.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { decodeBridgeFrame, type BridgeFrame } from '../runner/bridge-protocol.ts'
import { createPiBridgeExtension, type PiTool } from '../runner/pi-bridge-extension.ts'
import { WORKBENCH_PROTOCOL } from '../console/schema.ts'

class Stream extends EventEmitter {
  other!: Stream
  filter: (frame: BridgeFrame) => boolean = () => true
  closed = false
  write(bytes: Buffer) {
    if (this.closed) throw Error('closed')
    if (this.filter(decodeBridgeFrame(bytes.subarray(0, -1))) && !this.other.closed) this.other.emit('data', bytes)
    return true
  }
  destroy() { if (!this.closed) { this.closed = true; this.emit('close'); this.other.destroy() } }
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw Error('bounded wait expired'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-native-intervention-')), projectPath = join(root, 'project')
  mkdirSync(projectPath)
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: projectPath, timeout: 5000 })
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(projectPath, 'policy.txt'), 'fixture\n'); git(['add', '.']); git(['commit', '-qm', 'fixture'])
  const roots = { stateDir: join(root, 'state'), runtimeDir: join(root, 'runtime') }
  let runner = openWorkbenchRunner({ roots })
  let time = 1000, serial = 0, busy = false, failSend = false
  let registry = new BridgeRegistry({ store: runner.store, fences: runner.fences, nodeId: runner.nodeId, now: () => time })
  let owner!: Stream, pi!: Stream
  const streams: Stream[] = []
  const hooks = new Map<string, (event: unknown, context: any) => void>(), tools = new Map<string, PiTool>(), messages: string[] = []
  const deliveries: Promise<unknown>[] = []
  let delivery = new AssignmentDeliveryCoordinator({ store: runner.store, registry, clock: () => Date.now(), monotonic: () => time })
  let authority = new WorkbenchAuthority({ runner, registry, sessionId: 'native-intervention', pluginGeneration: 7,
    monotonic: () => time, gateScratchRoot: join(root, 'gate'), onAssignmentAdmitted: admission => { deliveries.push(delivery.deliver(admission.attemptId)) } })
  const extension = createPiBridgeExtension({ navigate: null,
    connect: async (onFrame, onClose) => {
      owner = new Stream(); pi = new Stream(); owner.other = pi; pi.other = owner; streams.push(owner)
      const connectedRegistry = registry
      attachBridgeStream(owner, { onFrame: (peer, frame) => connectedRegistry.receive(peer, frame), onClose: peer => connectedRegistry.disconnect(peer) })
      return attachBridgeStream(pi, { onFrame: (_peer, frame) => onFrame(frame), onClose })
    },
    schedule: (callback, delay) => setTimeout(callback, Math.min(delay, 50)),
  })
  extension({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool),
    sendUserMessage: text => { messages.push(text); if (failSend) throw Error('accepted then threw') } })
  t.after(() => { hooks.get('session_shutdown')?.(null, null); registry.close(); for (const stream of streams) stream.destroy(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  const inspected = authority.inspect(projectPath), project = authority.confirmRegistration(inspected.inspectionId)
  const goal = authority.createGoal(project.projectId, 'Native intervention regression')
  const check = authority.createCheck(project.projectId, { name: 'Gate', summary: 'Fixture gate', mode: 'validator', commandSummary: 'true',
    definitionDraft: { executable: '/usr/bin/true', argv: [], cwd: projectPath, environment: [], resourcePaths: [join(projectPath, 'policy.txt')],
      timeoutMs: 1000, outputBytes: 4096, maxCorrections: 1, elapsedMs: 60_000 } })
  hooks.get('session_start')!(null, { mode: 'tui', cwd: projectPath, sessionManager: { getSessionId: () => 'native-pi' },
    isIdle: () => !busy, hasPendingMessages: () => false, ui: { setStatus() {} } })
  await waitFor(() => registry.list().length === 1)
  const adoption = authority.adoption.propose({ projectId: project.projectId, goalId: goal.goalId, role: 'implementer', observedSessionId: registry.list()[0]!.observedSessionId })
  authority.adoption.authorize(adoption.proposalId)
  await waitFor(() => registry.projectContextMatches(adoption.runId, projectPath))
  const intent = (kind: string, target: string, payload: Record<string, unknown>) => ({ protocol: WORKBENCH_PROTOCOL,
    sessionId: authority.sessionId, pluginGeneration: authority.pluginGeneration, runnerEpoch: runner.epoch,
    intentId: `intent-${++serial}`, expectedRevision: authority.currentRevision, kind, target, payload })
  const send = async (kind: string, payload: Record<string, unknown>, target?: string) => {
    const envelope = intent(kind, target ?? String(payload.assignmentId ?? payload.agentRunId), payload)
    return { envelope, result: await authority.handlePresentationIntent(envelope) }
  }
  const limits = { maxCorrections: 1, elapsedMs: 60_000 }, taskText = 'Produce a bounded candidate.'
  const prepared = await send('prepare_start_review', { checkId: check.checkId, checkVersion: 1, taskText, ...limits }, adoption.runId)
  assert.equal(prepared.result.status, 'acknowledged', JSON.stringify(prepared.result))
  const proposal = authority.startReviewForProjection()!
  const started = await send('start_assignment', { confirmationId: proposal.confirmationId, agentRunId: adoption.runId,
    goalText: goal.goalText, taskText, checkId: check.checkId, checkVersion: 1, ...limits }, adoption.runId)
  assert.equal(started.result.status, 'acknowledged', JSON.stringify(started.result)); await deliveries[0]
  assert.equal(messages.length, 1, 'fixture must exercise a real Assignment delivery through the framed extension')
  const assignment = runner.store.listAssignments()[0]!, attempt = runner.store.listAttempts(assignment.assignmentId)[0]!
  const assignmentId = assignment.assignmentId
  const notes = { assignmentId, reconciliationNotes: 'Inspected tools and retained prior effects; no outstanding work.', acknowledgeRisk: true }
  const content = { summary: 'Manual changes retained, no outstanding work.', artifactRefs: [], claimedState: 'partial', outstandingEffects: 'none_reported' }
  const takeover = async () => { assert.equal((await send('take_control', { agentRunId: adoption.runId })).result.status, 'acknowledged') }
  const requestHandoff = async () => send('return_to_team', { assignmentId })
  const submit = async (value = content) => tools.get('omarchestra_submit_handoff')!.execute('handoff', value)
  const handoff = async () => {
    await takeover(); assert.equal((await requestHandoff()).result.status, 'acknowledged')
    await waitFor(() => authority.intervention!.latest(assignmentId)?.phase === 'awaiting_handoff')
    assert.equal((await submit()).content[0]!.text, '{"outcome":"accepted"}')
  }
  return { root, projectPath, get runner() { return runner }, get registry() { return registry }, get authority() { return authority },
    get owner() { return owner }, get pi() { return pi }, messages, deliveries, hooks, project, goal, check, assignment, attempt,
    async restart() {
      registry.close(); runner.close()
      runner = openWorkbenchRunner({ roots })
      registry = new BridgeRegistry({ store: runner.store, fences: runner.fences, nodeId: runner.nodeId, now: () => time })
      delivery = new AssignmentDeliveryCoordinator({ store: runner.store, registry, monotonic: () => time })
      authority = new WorkbenchAuthority({ runner, registry, sessionId: 'restarted-intervention', pluginGeneration: 8,
        monotonic: () => time, gateScratchRoot: join(root, 'gate'), onAssignmentAdmitted: admission => { deliveries.push(delivery.deliver(admission.attemptId)) } })
      authority.sweepAssignmentLimits()
      await waitFor(() => registry.controlTarget(assignment.agentRunId) !== null)
    },
    assignmentId, notes, content, takeover, requestHandoff, submit, handoff, send,
    busy(value: boolean) { busy = value }, failSend(value: boolean) { failSend = value }, async advance(ms: number) {
      while (ms > 0) { const step = Math.min(ms, 10_000); time += step; ms -= step; await new Promise(resolve => setTimeout(resolve, 60)) }
    },
    current: () => authority.intervention!.latest(assignmentId), writer: () => runner.store.getWriter(project.projectId),
    input: () => hooks.get('input')!({ source: 'interactive', text: 'PRIVATE_INPUT_MUST_NOT_BE_READ' }, null) }
}

test('native return request and receipt roll back together without calling Pi', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.takeover()
  const put = f.runner.store.putIntentResult
  f.runner.store.putIntentResult = () => { throw Error('receipt fault') }
  await assert.rejects(f.requestHandoff(), /receipt fault/)
  f.runner.store.putIntentResult = put
  assert.equal(f.current(), null); assert.equal(f.messages.length, 1)
  assert.equal(f.runner.store.listHandoffs().length, 0)
})
test('busy Pi refuses handoff without queueing a message or resuming', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.takeover(); f.busy(true)
  await f.requestHandoff(); await waitFor(() => f.current()?.phase === 'attention')
  assert.equal(f.current()?.reason, 'pi_busy'); assert.equal(f.messages.length, 1)
  assert.equal(f.writer()?.state, 'held'); assert.equal(f.runner.store.getAssignment(f.assignmentId)?.state, 'attention')
})
test('accepted-then-throw handoff remains unknown; receipt replay never calls Pi again', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.takeover(); f.failSend(true)
  const requested = await f.requestHandoff(); await waitFor(() => f.current()?.phase === 'attention')
  assert.equal(f.current()?.reason, 'handoff_delivery_unknown'); assert.equal(f.messages.length, 2)
  await f.authority.handlePresentationIntent(requested.envelope)
  assert.equal(f.messages.length, 2); assert.equal(f.deliveries.length, 1)
})
test('handoff duplicate is idempotent; changed reuse and injected identity reject', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"duplicate"}')
  assert.equal((await f.submit({ ...f.content, summary: 'Changed claim' })).content[0]!.text, '{"outcome":"invalid"}')
  assert.equal((await f.submit({ ...f.content, agentRunId: 'other' } as never)).content[0]!.text, '{"outcome":"invalid"}')
  assert.equal(f.runner.store.listHandoffs().length, 1)
})
test('manual input invalidates retained handoff even while already manual; fresh request works', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  const old = f.current()!.handoff!, epoch = old.controlEpoch
  f.input()
  assert.equal(f.runner.store.getBinding(f.assignment.agentRunId)?.controlEpoch, epoch + 1)
  assert.equal((await f.send('resume', f.notes)).result.status, 'rejected')
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"invalid"}')
  assert.equal((await f.requestHandoff()).result.status, 'acknowledged')
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"accepted"}')
  assert.notEqual(f.current()!.handoff!.handoffId, old.handoffId)
  assert.equal(f.runner.store.getHandoff(f.attempt.attemptId)!.handoffId, old.handoffId, 'never overwrite original evidence')
  assert.equal((await f.send('resume', f.notes)).result.status, 'acknowledged')
  await waitFor(() => f.current()?.phase === 'completed')
  assert.equal(f.deliveries.length, 2)
})
test('late handoff and missing risk acknowledgement cannot clear authority', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.takeover(); await f.requestHandoff(); await f.advance(30_001)
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"invalid"}')
  assert.equal((await f.send('resume', { ...f.notes, acknowledgeRisk: false })).result.reasonCode, 'invalid_envelope')
  assert.equal(f.writer()?.state, 'held'); assert.equal(f.deliveries.length, 1)
})
test('possible effects in the Pi handoff refuse operator resume', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.takeover(); await f.requestHandoff()
  assert.equal((await f.submit({ ...f.content, outstandingEffects: 'may_be_active' })).content[0]!.text, '{"outcome":"accepted"}')
  assert.equal((await f.send('resume', f.notes)).result.status, 'rejected')
  assert.equal(f.deliveries.length, 1)
})
for (const fault of ['busy', 'lost_resume_ack', 'stop_during_resume', 'receipt', 'gate_resource', 'checkout_drift', 'final_transaction'] as const)
  test(`native resume ${fault} preserves the writer and sends no second Assignment`, { timeout: 10_000 }, async t => {
    const f = await fixture(t); await f.handoff()
    if (fault === 'busy') f.busy(true)
    if (fault === 'gate_resource') writeFileSync(join(f.projectPath, 'policy.txt'), 'changed gate resource\n')
    const put = f.runner.store.putIntentResult, reconcile = f.runner.store.reconcileWriter
    if (fault === 'receipt') f.runner.store.putIntentResult = () => { throw Error('receipt fault') }
    if (fault === 'final_transaction') f.runner.store.reconcileWriter = () => { throw Error('final transaction fault') }
    f.pi.filter = frame => {
      if (frame.type === 'control_response' && frame.body.operation === 'resume') {
        if (fault === 'lost_resume_ack') return false
        if (fault === 'stop_during_resume') void f.send('stop', { assignmentId: f.assignmentId })
        if (fault === 'checkout_drift') writeFileSync(join(f.projectPath, 'new-file'), 'external drift\n')
      }
      return true
    }
    if (fault === 'receipt') await assert.rejects(f.send('resume', f.notes), /receipt fault/)
    else { assert.equal((await f.send('resume', f.notes)).result.status, 'acknowledged'); await waitFor(() => f.current()?.phase === 'attention') }
    f.runner.store.putIntentResult = put; f.runner.store.reconcileWriter = reconcile
    assert.equal(f.runner.store.listAttempts(f.assignmentId).length, 1)
    assert.equal(f.deliveries.length, 1)
    assert.equal(f.writer()?.state, fault === 'receipt' ? 'held' : 'uncertain')
    assert.equal(f.messages.length, 2, 'only original Assignment plus explicit handoff request')
  })
test('stopped writer clearance needs handoff and cannot revive or transfer the Assignment', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.send('stop', { assignmentId: f.assignmentId })
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'rejected')
  assert.equal((await f.requestHandoff()).result.status, 'acknowledged')
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"accepted"}')
  assert.equal((await f.send('resume', f.notes)).result.status, 'rejected')
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'acknowledged')
  await waitFor(() => f.current()?.phase === 'completed')
  assert.equal(f.writer()?.state, 'none'); assert.equal(f.deliveries.length, 1)
  assert.equal(f.runner.store.getAssignment(f.assignmentId)?.state, 'stopped')
  const evidence = f.runner.store.getMeta(`reconciliation_evidence_${f.current()!.requestId}`)!
  assert.equal(JSON.parse(evidence).acknowledgeRisk, true)
  assert.equal(JSON.parse(evidence).notes, f.notes.reconciliationNotes)
  assert.ok(JSON.parse(evidence).baselineDigest)
})

test('surviving Pi after Owner restart needs a new handoff; old budget never resumes', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  const identity = f.runner.store.getBindingIdentity(f.assignment.agentRunId)!.incarnationKey
  const epoch = f.runner.store.getBinding(f.assignment.agentRunId)!.controlEpoch
  await f.restart()
  assert.equal(f.runner.store.getBindingIdentity(f.assignment.agentRunId)!.incarnationKey, identity)
  assert.equal(f.runner.store.getBinding(f.assignment.agentRunId)!.controlEpoch, epoch, 'reconnect must not invent a control epoch')
  assert.equal(f.runner.store.getAssignment(f.assignmentId)?.state, 'stopped')
  assert.equal(f.writer()?.state, 'uncertain')
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'rejected', 'old-owner handoff is insufficient')
  assert.equal((await f.requestHandoff()).result.status, 'acknowledged')
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"accepted"}')
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'acknowledged')
  await waitFor(() => f.current()?.phase === 'completed')
  assert.equal(f.writer()?.state, 'none'); assert.equal(f.deliveries.length, 1)
})

test('unproven validator lifetime refuses writer clearance after surviving-Pi reconciliation', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  await f.send('stop', { assignmentId: f.assignmentId })
  f.runner.store.setMeta(`gate_lifetime_${f.attempt.attemptId}`, 'started')
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'acknowledged')
  await waitFor(() => f.current()?.phase === 'attention')
  assert.equal(f.writer()?.state, 'uncertain'); assert.equal(f.deliveries.length, 1)
})

test('retirement and purge retain the delivered Assignment writer; old handoff cannot clear it', { timeout: 10_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  await f.send('stop', { assignmentId: f.assignmentId })
  f.hooks.get('session_shutdown')!(null, null)
  for (const kind of ['retire', 'purge']) {
    const result = await f.send(kind, { agentRunId: f.assignment.agentRunId })
    assert.equal(result.result.status, 'acknowledged', JSON.stringify(result.result))
  }
  assert.equal(f.runner.store.getBinding(f.assignment.agentRunId), null)
  assert.equal((await f.send('reconcile_writer', f.notes)).result.status, 'rejected')
  assert.equal(f.writer()?.state, 'uncertain'); assert.equal(f.deliveries.length, 1)
})

test('lost handoff receipt preserves the record; exact tool replay gets duplicate without another turn', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await f.takeover(); await f.requestHandoff()
  f.owner.filter = frame => frame.type !== 'handoff_receipt'
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"unknown"}')
  assert.equal(f.current()?.phase, 'handoff')
  f.owner.filter = () => true
  assert.equal((await f.submit()).content[0]!.text, '{"outcome":"duplicate"}')
  assert.equal(f.runner.store.listHandoffs().length, 1); assert.equal(f.messages.length, 2)
})

test('fresh replacement Adoption under delivered load grants no transfer or writer clearance; purge stays leaf-only', { timeout: 15_000 }, async t => {
  const f = await fixture(t); await f.handoff()
  f.hooks.get('session_shutdown')!(null, null)
  assert.equal((await f.send('retire', { agentRunId: f.assignment.agentRunId })).result.status, 'acknowledged')
  const hooks = new Map<string, (event: unknown, context: any) => void>()
  const messages: string[] = []
  const extension = createPiBridgeExtension({ navigate: null,
    schedule: (callback, delay) => setTimeout(callback, Math.min(delay, 50)),
    connect: async (onFrame, onClose) => {
      const owner = new Stream(), pi = new Stream(); owner.other = pi; pi.other = owner
      attachBridgeStream(owner, { onFrame: (peer, frame) => f.registry.receive(peer, frame), onClose: peer => f.registry.disconnect(peer) })
      return attachBridgeStream(pi, { onFrame: (_peer, frame) => onFrame(frame), onClose })
    },
  })
  extension({ on: (name, fn) => hooks.set(name, fn), registerTool() {}, sendUserMessage: text => { messages.push(text) } })
  t.after(() => hooks.get('session_shutdown')?.(null, null))
  hooks.get('session_start')!(null, { mode: 'tui', cwd: f.projectPath, sessionManager: { getSessionId: () => 'replacement-pi' },
    isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} } })
  await waitFor(() => f.registry.list().some(agent => agent.available && agent.mode === 'observed'))
  const observed = f.registry.list().find(agent => agent.available && agent.mode === 'observed')!
  const proposal = f.authority.adoption.propose({ projectId: f.project.projectId, goalId: f.goal.goalId, role: 'implementer',
    observedSessionId: observed.observedSessionId, predecessorRunId: f.assignment.agentRunId })
  f.authority.adoption.authorize(proposal.proposalId)
  await waitFor(() => f.registry.projectContextMatches(proposal.runId, f.projectPath))
  assert.notEqual(proposal.runId, f.assignment.agentRunId)
  assert.equal(f.runner.store.getBinding(proposal.runId)?.predecessorRunId, f.assignment.agentRunId)
  assert.equal(f.writer()?.state, 'uncertain'); assert.deepEqual(messages, [])
  const start = await f.send('prepare_start_review', { checkId: f.check.checkId, checkVersion: 1, taskText: 'Must not dispatch',
    maxCorrections: 1, elapsedMs: 60_000 }, proposal.runId)
  assert.equal(start.result.status, 'rejected'); assert.match(start.result.reason!, /held or uncertain.*writer/)
  assert.equal((await f.send('purge', { agentRunId: f.assignment.agentRunId })).result.status, 'rejected')
  hooks.get('session_shutdown')!(null, null)
  for (const runId of [proposal.runId, f.assignment.agentRunId]) {
    if (runId === proposal.runId) assert.equal((await f.send('retire', { agentRunId: runId })).result.status, 'acknowledged')
    assert.equal((await f.send('purge', { agentRunId: runId })).result.status, 'acknowledged')
  }
  assert.equal(f.runner.store.listAssignments().length, 1)
  assert.equal(f.writer()?.state, 'uncertain'); assert.deepEqual(messages, [])
})

test('intervention privacy keeps source input and operator notes out of general projection', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  assert.doesNotThrow(() => f.hooks.get('input')!({ source: 'interactive', get text() { throw Error('input content was inspected') } }, null))
  await f.requestHandoff()
  const content = { ...f.content, summary: 'EXPLICIT_HANDOFF_DETAIL_ONLY' }
  assert.equal((await f.submit(content)).content[0]!.text, '{"outcome":"accepted"}')
  const notes = { ...f.notes, reconciliationNotes: 'PRIVATE_OPERATOR_EFFECT_REVIEW' }
  assert.equal((await f.send('resume', notes)).result.status, 'acknowledged')
  await waitFor(() => f.current()?.phase === 'completed')
  const { buildSnapshot } = await import('../runner/projection.ts')
  const snapshot = buildSnapshot({ authority: f.authority, adoption: f.authority.adoption, connection: 'connected' })
  assert.ok(JSON.stringify(snapshot.details).includes(content.summary), 'explicit handoff is permitted detail, not scraped telemetry')
  assert.equal(JSON.stringify(snapshot.activity).includes(content.summary), false)
  assert.equal(JSON.stringify(snapshot).includes(notes.reconciliationNotes), false)
  assert.equal(JSON.stringify(f.runner.store.listEvents()).includes(notes.reconciliationNotes), false)
  assert.equal(f.messages.some(message => message.includes(notes.reconciliationNotes)), false)
})
