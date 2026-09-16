/**
 * Local Workbench v1 Phase 2 — authority acceptance.
 *
 * Drives the runnable management journey through the runner authority with
 * injected Git facts and an injected observer transport over disposable
 * storage. Asserts that Phase 2 never delivers an Assignment and never runs
 * an acceptance check.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProjectPath, type GitRunner } from '../runner/git-context.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateDetail } from '../console/detail-schema.ts'
import { validateSnapshot } from '../console/schema.ts'
import type { ObserverPort, TransportEvent, WorkbenchFrame } from '../runner/transport.ts'
import { encodeFrame, decodeFrame, probePiInstallation } from '../runner/transport.ts'

class FakePort implements ObserverPort {
  readonly transportId = 'transport-1'
  readonly sent: WorkbenchFrame[] = []
  private handlers: Array<(event: TransportEvent) => void> = []
  send(frame: WorkbenchFrame): void { this.sent.push(frame) }
  subscribe(handler: (event: TransportEvent) => void): () => void {
    this.handlers.push(handler)
    return () => { this.handlers = this.handlers.filter(item => item !== handler) }
  }
  close(): void { this.handlers = [] }
  emit(event: Partial<TransportEvent> & { type: TransportEvent['type'] }): void {
    const full: TransportEvent = {
      runId: '', bindingDigest: '', transportId: this.transportId, source: 'extension', detail: '', ...event,
    }
    for (const handler of [...this.handlers]) handler(full)
  }
  last(kind: string): WorkbenchFrame | undefined {
    return [...this.sent].reverse().find(frame => frame.kind === kind)
  }
}

/** Deterministic Git facts; the real `git` binary is exercised separately. */
function gitFixture(overrides: Record<string, string | null> = {}): GitRunner {
  const table: Record<string, string | null> = {
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --is-bare-repository': 'false',
    'rev-parse --git-common-dir': '.git',
    'rev-parse --git-dir': '.git',
    'rev-parse --show-superproject-working-tree': '',
    'rev-parse --verify HEAD': 'a'.repeat(40),
    'status --porcelain': '',
    ...overrides,
  }
  return (argv, cwd) => {
    const key = argv.join(' ')
    if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${cwd}\n`, stderr: '' }
    const value = table[key]
    if (value === undefined || value === null) return { status: 128, stdout: '', stderr: 'unavailable' }
    return { status: 0, stdout: `${value}\n`, stderr: '' }
  }
}

function scratch(): { root: string; project: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'lw-p2-auth-'))
  const root = join(base, 'state')
  const project = join(base, 'project')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(project, { recursive: true })
  return { root, project, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

function openAuthority(roots: { stateDir: string }, port: FakePort, project: string, overrides: { ackDeadlineMs?: number } = {}) {
  let tick = 1_000
  const clock = () => (tick += 10)
  let counter = 0
  const newId = (prefix: string) => `${prefix}${(counter += 1).toString().padStart(4, '0')}-${'0'.repeat(20)}`
  const runner = openWorkbenchRunner({ roots, clock, newId })
  const authority = new WorkbenchAuthority({
    runner,
    sessionId: 'sess-1',
    pluginGeneration: 7,
    clock,
    newId,
    git: gitFixture(),
    transport: () => port,
    ...overrides,
  })
  return { runner, authority, clock, newId, project }
}

let intentCounter = 0
function intent(authority: WorkbenchAuthority, kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  intentCounter += 1
  const targetField = ({ select_project: 'projectId', select_goal: 'goalId', confirm_register_project: 'registrationId', configure_checks: 'checkId', request_adoption: 'choiceId', authorize_adoption: 'proposalId', take_control: 'agentRunId', retire: 'agentRunId', purge: 'agentRunId' } as Record<string, string>)[kind]
  return authority.handleIntent({
    protocol: 'omarchestra.workbench/v1',
    intentId: `intent-${intentCounter}`,
    sessionId: authority.sessionId,
    pluginGeneration: authority.pluginGeneration,
    runnerEpoch: authority.runner.epoch,
    expectedRevision: authority.currentRevision,
    kind,
    target: targetField ? payload[targetField] : null,
    payload,
    ...overrides,
  } as never)
}

test('Phase 2 management journey: register, goals, checks, dedup, restart', () => {
  const store = scratch()
  const port = new FakePort()
  const closed: Array<() => void> = []
  let deliveryAttempts = 0
  const deliveryPort = { deliver: () => { deliveryAttempts += 1; throw new Error('Phase 2 must not deliver an Assignment') } }
  try {
    // --- registration -----------------------------------------------------
    let { runner, authority } = openAuthority({ stateDir: store.root }, port, store.project)
    closed.push(() => runner.close())

    const inspected = intent(authority, 'inspect_project', { path: store.project })
    assert.equal(inspected.status, 'acknowledged')

    let snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    validateSnapshot(snapshot)
    assert.equal(snapshot.fixture.active, false)
    assert.equal(snapshot.details?.length, 1)
    const registration = validateDetail(snapshot.details?.[0])
    assert.equal(registration.kind, 'registration')
    assert.equal(registration.supported, true)
    assert.equal(registration.executionReady, true)
    const registrationId = (registration as { registrationId: string }).registrationId

    const registered = intent(authority, 'confirm_register_project', { registrationId })
    assert.equal(registered.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    validateSnapshot(snapshot)
    assert.equal(snapshot.projects.length, 1)
    assert.equal(snapshot.selectedProjectId, snapshot.projects[0].projectId)
    assert.equal(snapshot.projects[0].canonicalPath, store.project)
    const projectId = snapshot.projects[0].projectId

    // Duplicate registration is refused, not silently merged.
    const again = intent(authority, 'inspect_project', { path: store.project })
    assert.equal(again.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const secondRegistrationId = (validateDetail(snapshot.details?.[0]) as { registrationId: string }).registrationId
    const duplicate = intent(authority, 'confirm_register_project', { registrationId: secondRegistrationId })
    assert.equal(duplicate.status, 'rejected')
    assert.equal(duplicate.reasonCode, 'invalid_input')

    // --- two sequential Team Goals ---------------------------------------
    const first = intent(authority, 'create_goal', { projectId, goalText: 'First committed Team Goal' })
    assert.equal(first.status, 'acknowledged')
    const second = intent(authority, 'create_goal', { projectId, goalText: 'Second committed Team Goal' })
    assert.equal(second.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    validateSnapshot(snapshot)
    assert.deepEqual(snapshot.goals.map(goal => goal.goalText), ['First committed Team Goal', 'Second committed Team Goal'])
    assert.equal(snapshot.selectedGoalId, snapshot.goals[1].goalId)

    // --- configured check, then a versioned edit --------------------------
    const draft = {
      executable: '/usr/bin/true', argv: ['--check'], cwd: store.project,
      environment: [], resourcePaths: [], timeoutMs: 1000, outputBytes: 4096,
      maxCorrections: 1, elapsedMs: 60000,
    }
    const created = intent(authority, 'create_check', {
      projectId, name: 'Unit tests', summary: 'Runs the unit suite', mode: 'validator',
      commandSummary: 'true --check', definitionDraft: draft,
    })
    assert.equal(created.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    validateSnapshot(snapshot)
    assert.equal(snapshot.checks.length, 1)
    assert.equal(snapshot.checks[0].version, 1)
    const checkId = snapshot.checks[0].checkId
    const firstDigest = snapshot.checks[0].digest

    const edited = intent(authority, 'configure_checks', {
      projectId, checkId, checkVersion: 1, name: 'Unit tests', summary: 'Runs the unit suite twice',
      mode: 'validator', commandSummary: 'true --check', definitionDraft: draft,
    })
    assert.equal(edited.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.checks[0].version, 2)
    assert.notEqual(snapshot.checks[0].digest, firstDigest)

    // A stale version edit is refused rather than overwriting.
    const staleEdit = intent(authority, 'configure_checks', {
      projectId, checkId, checkVersion: 1, name: 'Unit tests', summary: 'stale',
      mode: 'validator', commandSummary: 'true', definitionDraft: draft,
    })
    assert.equal(staleEdit.status, 'rejected')
    assert.equal(staleEdit.reasonCode, 'invalid_input')

    // --- intent deduplication and staleness -------------------------------
    const originalRevision = authority.currentRevision
    const dedup = authority.handleIntent({
      protocol: 'omarchestra.workbench/v1',
      intentId: 'intent-dedup', sessionId: authority.sessionId, pluginGeneration: 7,
      runnerEpoch: authority.runner.epoch, expectedRevision: authority.currentRevision,
      kind: 'create_goal', target: null, payload: { projectId, goalText: 'Deduplicated Goal' },
    } as never)
    assert.equal(dedup.status, 'acknowledged')
    const replay = authority.handleIntent({
      protocol: 'omarchestra.workbench/v1',
      intentId: 'intent-dedup', sessionId: authority.sessionId, pluginGeneration: 7,
      runnerEpoch: authority.runner.epoch, expectedRevision: originalRevision,
      kind: 'create_goal', target: null, payload: { projectId, goalText: 'Deduplicated Goal' },
    } as never)
    assert.equal(replay.status, 'acknowledged')
    assert.equal(replay.committedRevision, dedup.committedRevision)
    const conflict = authority.handleIntent({
      protocol: 'omarchestra.workbench/v1',
      intentId: 'intent-dedup', sessionId: authority.sessionId, pluginGeneration: 7,
      runnerEpoch: authority.runner.epoch, expectedRevision: replay.committedRevision,
      kind: 'create_goal', target: null, payload: { projectId, goalText: 'Different payload' },
    } as never)
    assert.equal(conflict.status, 'rejected')
    assert.equal(conflict.reasonCode, 'intent_identity_conflict')

    const stale = authority.handleIntent({
      protocol: 'omarchestra.workbench/v1',
      intentId: 'intent-stale', sessionId: authority.sessionId, pluginGeneration: 7,
      runnerEpoch: authority.runner.epoch, expectedRevision: 0,
      kind: 'create_goal', target: null, payload: { projectId, goalText: 'Stale Goal' },
    } as never)
    assert.equal(stale.status, 'stale')
    assert.equal(stale.reasonCode, 'revision_changed')

    // --- Phase 2 never starts work ----------------------------------------
    const start = intent(authority, 'start_assignment', { goalText: 'do work', checkId, checkVersion: 2 }, { target: 'run' })
    assert.equal(start.status, 'rejected')
    assert.equal(start.reasonCode, 'handler_unavailable')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const startAction = snapshot.actions.find(action => action.kind === 'start_assignment')
    assert.equal(startAction?.enabled, false)
    assert.equal(snapshot.assignments.length, 0)
    assert.equal(deliveryAttempts, 0)
    void deliveryPort

    const revisionBefore = authority.currentRevision
    const goalCount = snapshot.goals.length
    // --- restart: nothing durable is lost ---------------------------------
    runner.close()
    const restarted = openAuthority({ stateDir: store.root }, port, store.project)
    closed.push(() => restarted.runner.close())
    assert.ok(restarted.runner.epoch > 1)
    const resumed = buildSnapshot({ authority: restarted.authority, adoption: restarted.authority.adoption, connection: 'connected' })
    validateSnapshot(resumed)
    assert.equal(resumed.projects.length, 1)
    assert.equal(resumed.goals.length, goalCount)
    assert.equal(resumed.checks.length, 1)
    assert.equal(resumed.checks[0].version, 2)
    assert.equal(resumed.revision, revisionBefore)
    assert.equal(resumed.runnerEpoch, restarted.runner.epoch)
    assert.equal(deliveryAttempts, 0)
  } finally {
    for (const close of closed) { try { close() } catch { /* already closed */ } }
    store.cleanup()
  }
})

test('Phase 2 adoption journey: propose, authorize, ack, commit, ready, takeover, retire, replace, purge', () => {
  const store = scratch()
  const port = new FakePort()
  const closed: Array<() => void> = []
  try {
    const { runner, authority } = openAuthority({ stateDir: store.root }, port, store.project)
    closed.push(() => runner.close())

    intent(authority, 'inspect_project', { path: store.project })
    let snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const registrationId = (validateDetail(snapshot.details?.[0]) as { registrationId: string }).registrationId
    assert.equal(intent(authority, 'confirm_register_project', { registrationId }).status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const projectId = snapshot.projects[0].projectId
    assert.equal(intent(authority, 'create_goal', { projectId, goalText: 'Adopt one Pi' }).status, 'acknowledged')

    // The extension reports one visible Pi session; the runner turns it into a choice.
    port.emit({ type: 'session_observed', observedSessionId: 'pi-session-1', role: 'implementer' })
    assert.equal(authority.observedChoices.length, 1)
    const choiceId = authority.observedChoices[0].choiceId

    // A Proposal is not Adoptable until the operator asks for it.
    const proposed = intent(authority, 'request_adoption', { choiceId })
    assert.equal(proposed.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    validateSnapshot(snapshot)
    assert.equal(snapshot.observedSessions.length, 1)
    assert.equal(snapshot.observedSessions[0].choices[0].actionKind, 'authorize_adoption')
    const proposalId = snapshot.observedSessions[0].choices[0].choiceId
    assert.equal(snapshot.managedAgents.length, 0)

    const authorized = intent(authority, 'authorize_adoption', { proposalId })
    assert.equal(authorized.status, 'acknowledged')
    const adoptFrame = port.last('adopt')
    assert.ok(adoptFrame, 'authorization must ask the exact transport to adopt')
    assert.ok(adoptFrame.bindingDigest)
    // The frame is content-free: no Goal text, no check definition.
    assert.equal(encodeFrame(adoptFrame), encodeFrame(decodeFrame(encodeFrame(adoptFrame))))
    assert.ok(!Object.values(adoptFrame.payload).some(value => typeof value === 'string' && value.includes('Adopt one Pi')))

    // A mismatched acknowledgement is refused.
    assert.throws(() => port.emit({
      type: 'adopt_ack', runId: adoptFrame.runId ?? '', bindingDigest: 'f'.repeat(64), nonce: adoptFrame.nonce ?? '',
    }), { name: 'WorkbenchError' })

    port.emit({ type: 'adopt_ack', runId: adoptFrame.runId ?? '', bindingDigest: adoptFrame.bindingDigest ?? '', nonce: adoptFrame.nonce ?? '' })
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.managedAgents.length, 1)
    assert.equal(snapshot.managedAgents[0].piStatus, 'committed')
    const runId = snapshot.managedAgents[0].agentRunId
    assert.equal(snapshot.managedAgents[0].predecessorAgentRunId, null)

    // Delivery receipt (readiness) follows the committed binding.
    const committedFrame = port.last('committed')
    assert.equal(committedFrame?.runId, runId)
    port.emit({ type: 'readiness', runId, bindingDigest: committedFrame?.bindingDigest ?? '' })
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.managedAgents[0].piStatus, 'ready')

    // Extension-originated input does not take control.
    port.emit({ type: 'input_observed', runId, source: 'extension' })
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.managedAgents[0].piStatus, 'ready')

    // Interactive input revokes readiness and takes control; it never revives a
    // Run and never leaves readiness standing.
    port.emit({ type: 'input_observed', runId, source: 'interactive' })
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.managedAgents[0].piStatus, 'manual_takeover')
    assert.equal(snapshot.managedAgents[0].controlMode, 'manual_takeover')
    assert.equal(runner.store.getBinding(runId)?.controlEpoch, 2, 'takeover bumps the per-Run control epoch')

    // A duplicate acknowledgement after the exchange is stable: it can never
    // re-commit the Run or emit a second delivery.
    const commitmentsBefore = port.sent.filter(frame => frame.kind === 'committed').length
    port.emit({ type: 'adopt_ack', runId, bindingDigest: adoptFrame.bindingDigest ?? '', nonce: adoptFrame.nonce ?? '' })
    assert.equal(port.sent.filter(frame => frame.kind === 'committed').length, commitmentsBefore)
    assert.equal(runner.store.getBinding(runId)?.state, 'manual_takeover')

    // Manual control is still connected and cannot authorize retirement.
    assert.equal(intent(authority, 'retire', { agentRunId: runId }).status, 'rejected')
    port.emit({ type: 'disconnected' })
    assert.equal(runner.store.getBinding(runId)?.state, 'manual_takeover_disconnected')
    const retired = intent(authority, 'retire', { agentRunId: runId })
    assert.equal(retired.status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    assert.equal(snapshot.retiredRuns.length, 1)
    assert.equal(snapshot.retiredRuns[0].canPurge, true)
    const fence = runner.fences.getFence(runId)
    assert.equal(fence?.generation, 1)

    // Explicitly open a new fake subscription lifetime; disconnect does not
    // silently reconnect the old exchange, even on this reused fake port.
    authority.adoption.bind()
    // A late acknowledgement for a retired Run is refused: the retained fence
    // wins over every inbound frame and never resurrects the binding.
    assert.throws(
      () => port.emit({ type: 'adopt_ack', runId, bindingDigest: adoptFrame.bindingDigest ?? '', nonce: adoptFrame.nonce ?? '' }),
      { name: 'WorkbenchError' },
    )
    assert.throws(
      () => port.emit({ type: 'readiness', runId, bindingDigest: adoptFrame.bindingDigest ?? '' }),
      { name: 'WorkbenchError' },
    )
    assert.throws(
      () => port.emit({ type: 'input_observed', runId, source: 'interactive' }),
      { name: 'WorkbenchError' },
    )
    assert.equal(runner.store.getBinding(runId)?.state, 'retired')

    // Replacement reuses the same path with an immutable predecessor and a new generation.
    port.emit({ type: 'session_observed', observedSessionId: 'pi-session-2', role: 'implementer' })
    const nextChoice = authority.observedChoices.at(-1)?.choiceId ?? ''
    assert.equal(intent(authority, 'request_adoption', { choiceId: nextChoice }).status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const nextProposal = snapshot.observedSessions.find(card =>
      card.choices.some(choice => choice.actionKind === 'authorize_adoption'))
    const nextProposalId = nextProposal?.choices[0].choiceId ?? ''
    assert.equal(intent(authority, 'authorize_adoption', { proposalId: nextProposalId }).status, 'acknowledged')
    const secondAdopt = port.last('adopt')
    assert.equal(secondAdopt?.payload.predecessorRunId, runId)
    assert.equal(secondAdopt?.payload.vacancyGeneration, 2)
    port.emit({ type: 'adopt_ack', runId: secondAdopt?.runId ?? '', bindingDigest: secondAdopt?.bindingDigest ?? '', nonce: secondAdopt?.nonce ?? '' })
    port.emit({ type: 'readiness', runId: secondAdopt?.runId ?? '', bindingDigest: secondAdopt?.bindingDigest ?? '' })
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const replacementRunId = snapshot.managedAgents[0].agentRunId
    assert.equal(snapshot.managedAgents[0].predecessorAgentRunId, runId)
    assert.equal(snapshot.retiredRuns[0].replacementAgentRunId, replacementRunId)

    // Purge is leaf-only, but only after the successor is retired too.
    const purgeBlocked = intent(authority, 'purge', { agentRunId: runId })
    assert.equal(purgeBlocked.status, 'rejected')
    assert.equal(purgeBlocked.reasonCode, 'invalid_input')

    // Take control uses the Run identity the card carries, and it is what makes
    // a ready Run retirable.
    assert.equal(intent(authority, 'take_control', { agentRunId: replacementRunId }).status, 'acknowledged')
    assert.equal(runner.store.getBinding(replacementRunId)?.state, 'manual_takeover')
    port.emit({ type: 'input_observed', runId: replacementRunId, source: 'interactive' })
    assert.equal(intent(authority, 'retire', { agentRunId: replacementRunId }).status, 'rejected')
    port.emit({ type: 'disconnected' })
    assert.equal(intent(authority, 'retire', { agentRunId: replacementRunId }).status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    const replacementCard = snapshot.retiredRuns.find(card => card.agentRunId === replacementRunId)
    assert.equal(replacementCard?.predecessorAgentRunId, runId)
    assert.equal(replacementCard?.canPurge, true)
    // Newest-first purge: the successor leaf goes before the predecessor.
    assert.equal(intent(authority, 'purge', { agentRunId: runId }).status, 'rejected')
    assert.equal(intent(authority, 'purge', { agentRunId: replacementRunId }).status, 'acknowledged')
    assert.equal(intent(authority, 'purge', { agentRunId: runId }).status, 'acknowledged')
    snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
    // A purged Run is gone from the projection; the durable fence remains.
    assert.equal(snapshot.retiredRuns.length, 0)
    assert.equal(runner.store.getBinding(runId), null)
    assert.equal(runner.store.getBinding(replacementRunId), null)
    assert.equal(runner.fences.getFence(runId), null)
    assert.equal(runner.fences.isPurged(runId), true)
    assert.equal(runner.fences.isPurged(replacementRunId), true)
    assert.equal(runner.fences.listFences().length, 0)

    // The successor can never reuse the purged vacancy generation.
    assert.throws(() => runner.fences.assertVacancyGeneration(projectId, 'implementer', 1), { name: 'WorkbenchError' })
  } finally {
    for (const close of closed) { try { close() } catch { /* already closed */ } }
    store.cleanup()
  }
})

test('an expired adopt acknowledgement is refused and never commits', () => {
  const store = scratch()
  const port = new FakePort()
  try {
    // A zero-length window makes the exchange expire before the delivery lands.
    const { runner, authority } = openAuthority({ stateDir: store.root }, port, store.project, { ackDeadlineMs: 0 })
    try {
      intent(authority, 'inspect_project', { path: store.project })
      const snapshotBefore = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
      const registrationId = (validateDetail(snapshotBefore.details?.[0]) as { registrationId: string }).registrationId
      intent(authority, 'confirm_register_project', { registrationId })
      const projectId = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' }).projects[0].projectId
      intent(authority, 'create_goal', { projectId, goalText: 'Expire one exchange' })
      port.emit({ type: 'session_observed', observedSessionId: 'pi-expiring', role: 'implementer' })
      const choiceId = authority.observedChoices[0].choiceId
      intent(authority, 'request_adoption', { choiceId })
      const proposalId = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
        .observedSessions[0].choices[0].choiceId
      intent(authority, 'authorize_adoption', { proposalId })
      const queued = runner.store.listDeliveries()[0]
      assert.equal(queued.state, 'not_sent', 'a zero-length deadline cannot release an adopt frame')
      assert.equal(port.last('adopt'), undefined)
      const adoptFrame = decodeFrame(queued.frameJson) // forged late reply to the expired queued exchange
      assert.throws(
        () => port.emit({ type: 'adopt_ack', runId: adoptFrame?.runId ?? '', bindingDigest: adoptFrame?.bindingDigest ?? '', nonce: adoptFrame?.nonce ?? '' }),
        { name: 'WorkbenchError' },
      )
      // The refusal is total: no commitment, no delivery, no readiness.
      assert.equal(port.sent.filter(frame => frame.kind === 'committed').length, 0)
      const binding = runner.store.getBinding(adoptFrame?.runId ?? '')
      assert.equal(binding?.state, 'authorized')
    } finally {
      runner.close()
    }
  } finally {
    store.cleanup()
  }
})

test('a disconnected occupant blocks a new adoption for the same Role', () => {
  const store = scratch()
  const port = new FakePort()
  try {
    const { runner, authority } = openAuthority({ stateDir: store.root }, port, store.project)
    try {
      intent(authority, 'inspect_project', { path: store.project })
      const registrationId = (validateDetail(buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' }).details?.[0]) as { registrationId: string }).registrationId
      intent(authority, 'confirm_register_project', { registrationId })
      const projectId = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' }).projects[0].projectId
      intent(authority, 'create_goal', { projectId, goalText: 'Occupy one Role' })

      const adopt = (sessionId: string) => {
        port.emit({ type: 'session_observed', observedSessionId: sessionId, role: 'implementer' })
        intent(authority, 'request_adoption', { choiceId: authority.observedChoices.at(-1)?.choiceId ?? '' })
        const proposalId = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
          .observedSessions.find(card => card.choices.some(choice => choice.actionKind === 'authorize_adoption'))?.choices[0].choiceId ?? ''
        intent(authority, 'authorize_adoption', { proposalId })
        const frame = port.last('adopt')
        assert.ok(frame)
        return frame
      }

      const first = adopt('pi-occupant-1')
      port.emit({ type: 'adopt_ack', runId: first.runId ?? '', bindingDigest: first.bindingDigest ?? '', nonce: first.nonce ?? '' })
      port.emit({ type: 'readiness', runId: first.runId ?? '', bindingDigest: first.bindingDigest ?? '' })
      // The connection drops, but the Role membership and its occupancy stay.
      port.emit({ type: 'disconnected' })
      assert.equal(runner.store.getBinding(first.runId ?? '')?.state, 'disconnected')

      authority.adoption.bind() // new fake connection lifetime, not recovery of the first Run
      const second = adopt('pi-occupant-2')
      assert.throws(
        () => port.emit({ type: 'adopt_ack', runId: second.runId ?? '', bindingDigest: second.bindingDigest ?? '', nonce: second.nonce ?? '' }),
        { name: 'WorkbenchError' },
      )
      assert.equal(runner.store.getBinding(second.runId ?? '')?.state, 'disconnected')
      // Only the first occupant ever received a commitment.
      assert.deepEqual(
        port.sent.filter(frame => frame.kind === 'committed').map(frame => frame.runId),
        [first.runId],
      )
    } finally {
      runner.close()
    }
  } finally {
    store.cleanup()
  }
})

test('real Git inspection resolves a disposable repository without writing', () => {
  const store = scratch()
  try {
    execFileSync('git', ['init', '-q', store.project], { stdio: 'ignore' })
    const inspection = inspectProjectPath(store.project)
    assert.equal(inspection.isRepository, true)
    assert.equal(inspection.supported, true)
    assert.equal(inspection.executionReady, false)
    assert.deepEqual(inspection.readinessReasons, ['no_head_commit'])
    assert.deepEqual(inspection.reasons, [])
    // A primary checkout owns its own git dir: the two resolve to one path.
    assert.equal(inspection.gitDir, inspection.gitCommonDir)

    // A linked worktree shares the primary checkout's Git history, so it can
    // never be its own Project: two Projects must not own the same storage.
    execFileSync('git', ['-C', store.project, 'commit', '-q', '--allow-empty', '-m', 'base'],
      { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'workbench', GIT_AUTHOR_EMAIL: 'w@example.invalid', GIT_COMMITTER_NAME: 'workbench', GIT_COMMITTER_EMAIL: 'w@example.invalid' } })
    const linked = `${store.root}-linked`
    execFileSync('git', ['-C', store.project, 'worktree', 'add', '-q', linked, 'HEAD'], { stdio: 'ignore' })
    try {
      const linkedInspection = inspectProjectPath(linked)
      assert.equal(linkedInspection.supported, false)
      assert.ok(linkedInspection.reasons.includes('linked_worktree_or_shared_git_dir'), linkedInspection.reasons.join(','))
    } finally {
      rmSync(linked, { recursive: true, force: true })
    }
  } finally {
    store.cleanup()
  }
})

test('registration refuses overlapping Project storage in both directions', () => {
  const store = scratch()
  const port = new FakePort()
  try {
    const { runner, authority } = openAuthority({ stateDir: store.root }, port, store.project)
    try {
      const register = (path: string) => {
        intent(authority, 'inspect_project', { path })
        const snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' })
        const registrationId = (validateDetail(snapshot.details?.[0]) as { registrationId: string }).registrationId
        return intent(authority, 'confirm_register_project', { registrationId })
      }
      const nested = join(store.project, 'packages')
      mkdirSync(nested, { recursive: true })
      assert.equal(register(store.project).status, 'acknowledged')
      const nestedResult = register(nested)
      assert.equal(nestedResult.status, 'rejected')
      assert.equal(nestedResult.reasonCode, 'invalid_input')
      assert.equal(runner.store.listProjects().length, 1)
    } finally {
      runner.close()
    }
  } finally {
    store.cleanup()
  }
})

test('installation negotiation never writes to a Pi installation', () => {
  const store = scratch()
  try {
    const absent = probePiInstallation(store.project)
    assert.equal(absent.state, 'absent')
    assert.match(absent.reason, /install/i)
  } finally {
    store.cleanup()
  }
})
