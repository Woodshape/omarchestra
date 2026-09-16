import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkbenchAdapter,
  INTENT_KINDS,
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_CONFIRMATION_TTL_MS,
} from '../console/live-projection-adapter.ts'
import type { WorkbenchChannel, WorkbenchSource, WorkbenchSourceHandler } from '../console/live-projection-adapter.ts'
import { managedFixture } from '../fixtures/projections.ts'
import { journeyFixture, journeyDefinitionDraft } from '../fixtures/journey.ts'

class FakeSource implements WorkbenchSource {
  handler: WorkbenchSourceHandler | null = null
  async connect(handler: WorkbenchSourceHandler): Promise<WorkbenchChannel> {
    this.handler = handler
    return { send: () => {}, close: () => {} }
  }
}

function makeAdapter(clock = () => 0) {
  const source = new FakeSource()
  const handoffs: unknown[] = []
  const intents: unknown[] = []
  const feedback: unknown[] = []
  const adapter = new WorkbenchAdapter({
    source,
    sink: (h) => handoffs.push(h),
    intentSink: (i) => intents.push(i),
    onFeedback: (f) => feedback.push(f),
    clock,
  })
  return { adapter, source, handoffs, intents, feedback }
}

test('adapter start connects to the injected source', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  assert.ok(source.handler !== null)
  adapter.stop()
})

test('emitIntent requires an authoritative snapshot', async () => {
  const { adapter } = makeAdapter()
  await adapter.start()
  assert.throws(() => adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' }))
  adapter.stop()
})

test('emitIntent captures session/revision and emits a validated intent', async () => {
  const { adapter, source, intents } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  assert.equal(intent.sessionId, managedFixture.sessionId)
  assert.equal(intent.expectedRevision, managedFixture.revision)
  assert.equal(intent.kind, 'select_project')
  assert.equal(intents.length, 1)
  adapter.stop()
})

test('emitIntent rejects an unsupported kind', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  assert.throws(() => adapter.emitIntent('not_a_kind', null, {}))
  adapter.stop()
})

test('emitIntent rejects emission from gap state', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  adapter.projection.markGap('gap')
  assert.throws(() => adapter.emitIntent('select_project', null, { projectId: 'project-local-1' }))
  adapter.stop()
})

test('feedback waits for the committed snapshot and then resolves once', async () => {
  const { adapter, source, feedback } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  const outcome = {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    target: intent.target,
    originRevision: intent.expectedRevision,
    status: 'acknowledged',
    reasonCode: null,
    committedRevision: managedFixture.revision + 1,
  }
  assert.throws(() => adapter.applyFeedback(outcome), /not been displayed/)
  source.handler!.onOutcome!(outcome)
  assert.equal(adapter.pendingIntents[0].status, 'submitted')
  source.handler!.onSnapshot({ ...managedFixture, revision: managedFixture.revision + 1, cursor: managedFixture.cursor + 1 })
  adapter.applyFeedback(outcome) // duplicate does not notify the view again
  const pending = adapter.pendingIntents[0]
  assert.equal(pending.status, 'acknowledged')
  assert.equal(pending.committedRevision, managedFixture.revision + 1)
  assert.equal(feedback.length, 2) // submitted + acknowledged
  adapter.stop()
})

test('applyFeedback rejects a mismatched session', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  assert.throws(() => adapter.applyFeedback({
    intentId: intent.intentId,
    sessionId: 'other-session',
    target: intent.target,
    originRevision: intent.expectedRevision,
    status: 'acknowledged',
    reasonCode: null,
    committedRevision: null,
  }))
  adapter.stop()
})

test('applyFeedback rejects a mismatched origin revision', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  assert.throws(() => adapter.applyFeedback({
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    target: intent.target,
    originRevision: intent.expectedRevision + 1,
    status: 'acknowledged',
    reasonCode: null,
    committedRevision: null,
  }))
  adapter.stop()
})

test('markAckDeadlines marks submitted intents unknown after the deadline', async () => {
  let now = 0
  const { adapter, source } = makeAdapter(() => now)
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  now = DEFAULT_ACK_DEADLINE_MS + 1
  const changed = adapter.markAckDeadlines()
  assert.equal(changed, 1)
  assert.equal(adapter.pendingIntents[0].status, 'unknown')
  adapter.stop()
})

test('expireConfirmations marks submitted intents expired after the TTL', async () => {
  let now = 0
  const { adapter, source } = makeAdapter(() => now)
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  now = DEFAULT_CONFIRMATION_TTL_MS + 1
  const changed = adapter.expireConfirmations()
  assert.equal(changed, 1)
  assert.equal(adapter.pendingIntents[0].status, 'expired')
  adapter.stop()
})

test('INTENT_KINDS covers the essential actions', () => {
  for (const kind of [
    'select_project', 'create_goal', 'request_adoption', 'authorize_adoption',
    'start_assignment', 'take_control', 'return_to_team', 'accept', 'resume',
    'retry', 'retire', 'purge', 'stop', 'recover', 'present',
  ]) {
    assert.ok(INTENT_KINDS.includes(kind), kind)
  }
})

test('an omitted required payload field rejects instead of defaulting', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  assert.throws(() => adapter.emitIntent('select_project', 'project-local-1', {}), /missing intent payload field projectId/)
  adapter.stop()
})

test('an unknown payload field rejects instead of passing through', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  assert.throws(
    () => adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1', extra: 'x' }),
    /unknown intent payload field extra/,
  )
  adapter.stop()
})

test('advanced check drafts reject malformed data and invented authority', async () => {
  const { validateCheckDraft } = await import('../console/detail-schema.ts')
  assert.deepEqual(validateCheckDraft(journeyDefinitionDraft), journeyDefinitionDraft)
  for (const patch of [
    { executable: 'node' }, { cwd: '/tmp/../other' }, { argv: 'node --test' },
    { argv: Array(65).fill('x') }, { environment: [{ name: 'A', value: 'x' }, { name: 'A', value: 'y' }] },
    { resourcePaths: ['/x/../escape'] }, { timeoutMs: 0 }, { maxCorrections: 4 },
    { elapsedMs: 1.5 }, { outputBytes: 65537 }, { digest: 'a'.repeat(64) },
  ]) assert.throws(() => validateCheckDraft({ ...journeyDefinitionDraft, ...patch }))
})

test('configure_checks carries exactly the closed check-definition fields', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(journeyFixture)
  const check = journeyFixture.checks[0]
  const intent = adapter.emitIntent('configure_checks', check.checkId, {
    projectId: journeyFixture.selectedProjectId,
    checkId: check.checkId,
    checkVersion: check.version,
    name: check.name,
    summary: check.summary,
    mode: check.mode,
    commandSummary: check.commandSummary,
    definitionDraft: journeyDefinitionDraft,
  })
  assert.equal(intent.kind, 'configure_checks')
  assert.equal(intent.payload.checkVersion, check.version)
  adapter.stop()
})

test('configure_checks rejects a mode outside the closed runner union', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(journeyFixture)
  const check = journeyFixture.checks[0]
  assert.throws(() => adapter.emitIntent('configure_checks', check.checkId, {
    projectId: journeyFixture.selectedProjectId,
    checkId: check.checkId,
    checkVersion: check.version,
    name: check.name,
    summary: check.summary,
    mode: 'manual_review',
    commandSummary: check.commandSummary,
    definitionDraft: journeyDefinitionDraft,
  }), /mode/)
  adapter.stop()
})

test('a Goal-scoped committed action is emittable without widening the projection', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  const withGoalAction = structuredClone(journeyFixture)
  withGoalAction.goals[0].actions = [{
    kind: 'stop', target: 'assignment-1', label: 'Stop assignment', enabled: true, reasonCode: null, reason: null,
  }]
  source.handler!.onSnapshot(withGoalAction)
  const intent = adapter.emitIntent('stop', 'assignment-1', { assignmentId: 'assignment-1' })
  assert.equal(intent.kind, 'stop')
  adapter.stop()
})
