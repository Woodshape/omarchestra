import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkbenchAdapter,
  DEFAULT_ACK_DEADLINE_MS,
} from '../console/live-projection-adapter.ts'
import type {
  WorkbenchChannel,
  WorkbenchSource,
  WorkbenchSourceHandler,
} from '../console/live-projection-adapter.ts'
import {
  validateAction,
  validateSnapshot,
  type WorkbenchSnapshot,
} from '../console/schema.ts'
import {
  boardDisabledFixture,
  emptyFixture,
  gateFailFixture,
  gatePassFixture,
  gateTimeoutFixture,
  managedFixture,
  narrowFixture,
  retiredFixture,
  retiredLeafFixture,
  wideFixture,
} from '../fixtures/projections.ts'

class RecordingSource implements WorkbenchSource {
  handler: WorkbenchSourceHandler | null = null
  readonly messages: Array<{ type: string; body: Record<string, unknown> }> = []
  closed = false

  async connect(handler: WorkbenchSourceHandler): Promise<WorkbenchChannel> {
    this.handler = handler
    return {
      send: (type, body) => this.messages.push({ type, body }),
      close: () => { this.closed = true },
    }
  }

  snapshot(value: unknown): void {
    assert.ok(this.handler)
    this.handler.onSnapshot(value)
  }

  event(value: unknown): void {
    assert.ok(this.handler)
    this.handler.onEvent(value)
  }

  close(error: Error | null = null): void {
    assert.ok(this.handler)
    this.handler.onClose(error)
  }
}

function makeEvent(snapshot: WorkbenchSnapshot, overrides: Record<string, unknown> = {}) {
  return {
    protocol: 'omarchestra.workbench/v1',
    sessionId: snapshot.sessionId,
    runnerEpoch: snapshot.runnerEpoch,
    eventId: 'event-acceptance-1',
    cursor: snapshot.cursor + 1,
    baseRevision: snapshot.revision,
    revision: snapshot.revision + 1,
    kind: 'projection_update',
    payload: {},
    ...overrides,
  }
}

function makeAdapter(clock = () => 0) {
  const source = new RecordingSource()
  const handoffs: Array<{ connection: string; revision: number; cursor: number }> = []
  const intents: unknown[] = []
  const feedback: unknown[] = []
  const adapter = new WorkbenchAdapter({
    source,
    sink: (handoff) => handoffs.push({
      connection: handoff.connection,
      revision: handoff.revision,
      cursor: handoff.cursor,
    }),
    intentSink: (intent) => intents.push(intent),
    onFeedback: (entry) => feedback.push(entry),
    clock,
  })
  return { adapter, source, handoffs, intents, feedback }
}

test('injected adapter rejects malformed projections before establishing state', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  assert.throws(() => source.snapshot({ protocol: 'wrong' }), /protocol/)
  assert.equal(adapter.handoff, null)
  adapter.stop()
})

test('injected adapter rejects malformed nested cards and invalid cursors', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  assert.throws(() => source.snapshot({
    ...emptyFixture,
    managedAgents: [{ agentRunId: 'run-1' }],
  }), /role|piStatus|controlMode|connectionStatus/)
  assert.throws(() => source.snapshot({ ...emptyFixture, cursor: -1 }), /cursor/)
  adapter.stop()
})

test('adapter rejects a stale session event and latches projection gap', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  assert.throws(() => source.event(makeEvent(managedFixture, { sessionId: 'other-session' })), /session/)
  assert.equal(adapter.handoff?.connection, 'gap')
  adapter.stop()
})

test('adapter rejects a revision regression and publishes the gap state', async () => {
  const { adapter, source, handoffs } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  assert.throws(() => source.event(makeEvent(managedFixture, {
    revision: managedFixture.revision - 1,
  })), /revision/)
  assert.equal(adapter.handoff?.connection, 'gap')
  assert.equal(handoffs.at(-1)?.connection, 'gap')
  adapter.stop()
})

test('adapter rejects the same event identity with a changed payload', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  const event = makeEvent(managedFixture)
  source.event(event)
  assert.throws(() => source.event({ ...event, payload: { changed: true } }), /duplicate|payload/)
  assert.equal(adapter.handoff?.connection, 'gap')
  adapter.stop()
})

test('adapter requires a fresh authoritative snapshot after a cursor gap', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  assert.throws(() => source.event(makeEvent(managedFixture, { cursor: 3 })), /gap|sequence/)
  assert.equal(adapter.handoff?.connection, 'gap')
  source.snapshot({ ...managedFixture, cursor: 1, revision: 2 })
  assert.equal(adapter.handoff?.connection, 'connected')
  adapter.stop()
})

test('a new session and runner epoch can replace an obsolete projection baseline', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  const replacement = {
    ...emptyFixture,
    sessionId: 'session-replacement-1',
    pluginGeneration: managedFixture.pluginGeneration + 1,
    runnerEpoch: managedFixture.runnerEpoch + 1,
    revision: 0,
    cursor: 0,
  }
  source.snapshot(replacement)
  assert.equal(adapter.handoff?.snapshot.sessionId, replacement.sessionId)
  assert.equal(adapter.handoff?.snapshot.managedAgents.length, 0)
  adapter.stop()
})

test('lost feedback becomes unknown without an automatic resend', async () => {
  let now = 0
  const { adapter, source, intents } = makeAdapter(() => now)
  await adapter.start()
  source.snapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', {
    projectId: 'project-local-1',
  })
  now = DEFAULT_ACK_DEADLINE_MS + 1
  assert.equal(adapter.markAckDeadlines(), 1)
  assert.equal(adapter.pendingIntents[0]?.status, 'unknown')
  assert.equal(intents.length, 1)
  assert.equal(adapter.pendingIntents[0]?.intent.intentId, intent.intentId)
  adapter.stop()
})

test('identity replacement cancels confirmation but preserves drafts', async () => {
  const { adapter, source, feedback } = makeAdapter()
  await adapter.start()
  source.snapshot(managedFixture)
  adapter.setDraft('goal-1', 'preserved draft')
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  source.snapshot({
    ...emptyFixture,
    sessionId: 'session-replacement-2',
    pluginGeneration: managedFixture.pluginGeneration + 1,
    runnerEpoch: managedFixture.runnerEpoch + 1,
    revision: 0,
    cursor: 0,
  })
  const pending = adapter.pendingIntents.find((entry) => entry.intent.intentId === intent.intentId)
  assert.equal(pending?.status, 'stale')
  assert.equal(adapter.getDraft('goal-1'), 'preserved draft')
  assert.ok(feedback.some((entry) => entry.status === 'stale'))
  adapter.stop()
})

test('action availability preserves every authoritative disabled reason', () => {
  const disabled = [
    {
      kind: 'create_goal',
      target: null,
      label: null,
      enabled: false,
      reasonCode: 'project_required',
      reason: 'Select a Project before creating a Team Goal.',
    },
    {
      kind: 'start_assignment',
      target: 'project-local-1',
      label: null,
      enabled: false,
      reasonCode: 'dirty_baseline_confirmation_required',
      reason: 'Confirm the recorded dirty baseline before starting.',
    },
    {
      kind: 'take_control',
      target: 'agent-run-builder-1',
      label: null,
      enabled: false,
      reasonCode: 'projection_stale',
      reason: 'Refresh the authoritative projection before taking control.',
    },
    {
      kind: 'return_to_team',
      target: 'agent-run-builder-1',
      label: null,
      enabled: false,
      reasonCode: 'handoff_required',
      reason: 'A structured handoff is required before returning to the team.',
    },
    {
      kind: 'retry',
      target: 'assignment-1',
      label: null,
      enabled: false,
      reasonCode: 'writer_uncertain',
      reason: 'Reconcile the prior writer effects before retrying.',
    },
    {
      kind: 'authorize_adoption',
      target: 'proposal-1',
      label: null,
      enabled: false,
      reasonCode: 'proposal_expired',
      reason: 'The Adoption proposal has expired.',
    },
    {
      kind: 'purge',
      target: 'agent-run-builder-1',
      label: null,
      enabled: false,
      reasonCode: 'successor_exists',
      reason: 'Delete the replacement successor first.',
    },
    {
      kind: 'stop',
      target: 'assignment-1',
      label: null,
      enabled: false,
      reasonCode: 'cancellation_unsupported',
      reason: 'The current adapter does not advertise cooperative cancellation.',
    },
  ]
  for (const action of disabled) {
    assert.deepEqual(validateAction(action), action)
  }
})

test('original and replacement managed cards retain the same presentation contract', () => {
  const original = managedFixture.managedAgents[0]
  const replacement = {
    ...original,
    agentRunId: 'agent-run-builder-2',
    predecessorAgentRunId: original.agentRunId,
  }
  assert.deepEqual(
    {
      role: original.role,
      piStatus: original.piStatus,
      controlMode: original.controlMode,
      connectionStatus: original.connectionStatus,
      assignment: original.assignment,
      actionKinds: original.actions.map((action) => action.kind),
    },
    {
      role: replacement.role,
      piStatus: replacement.piStatus,
      controlMode: replacement.controlMode,
      connectionStatus: replacement.connectionStatus,
      assignment: replacement.assignment,
      actionKinds: replacement.actions.map((action) => action.kind),
    },
  )
  assert.equal(replacement.predecessorAgentRunId, original.agentRunId)
})

test('retired successor-blocked and leaf purge fixtures preserve authoritative reasons', () => {
  const blocked = validateSnapshot(retiredFixture).retiredRuns[0]
  const leaf = validateSnapshot(retiredLeafFixture).retiredRuns[0]
  assert.equal(blocked.canPurge, false)
  assert.match(blocked.purgeBlockedReason ?? '', /successor/i)
  assert.equal(leaf.canPurge, true)
  assert.equal(leaf.purgeBlockedReason, null)
})

test('gate fixtures distinguish pass, failure, and uncertain timeout without reviewer semantics', () => {
  const pass = validateSnapshot(gatePassFixture).assignments[0]
  const fail = validateSnapshot(gateFailFixture).assignments[0]
  const timeout = validateSnapshot(gateTimeoutFixture).assignments[0]
  assert.equal(pass.gateResult, 'pass')
  assert.equal(pass.state, 'accepted')
  assert.equal(fail.gateResult, 'fail')
  assert.equal(timeout.gateResult, 'timeout')
  assert.equal(timeout.state, 'attention')
  for (const assignment of [pass, fail, timeout]) {
    assert.equal('reviewer' in assignment, false)
  }
})

test('Board and narrow/wide fixtures remain explicit presentation states', () => {
  assert.equal(validateSnapshot(boardDisabledFixture).fixture.label, 'board disabled')
  assert.equal(validateSnapshot(narrowFixture).fixture.label, 'narrow layout')
  assert.equal(validateSnapshot(wideFixture).fixture.label, 'wide layout')
})

test('strict schema rejects unknown fields and unsafe numeric bounds', () => {
  assert.throws(
    () => validateSnapshot({ ...emptyFixture, unexpected: true }),
    /unknown|unexpected|field/,
  )
  assert.throws(
    () => validateSnapshot({ ...emptyFixture, revision: Number.MAX_SAFE_INTEGER + 1 }),
    /safe|integer|revision/,
  )
})

test('privacy schema rejects terminal controls in diagnostics and bounds corrections', () => {
  assert.throws(
    () => validateSnapshot({
      ...gateFailFixture,
      assignments: [{
        ...gateFailFixture.assignments[0],
        diagnostics: String.fromCharCode(27) + '[31mOPENAI_API_KEY=secret',
      }],
    }),
    /control|diagnostic|escape|secret/,
  )
  assert.throws(
    () => validateSnapshot({
      ...gatePassFixture,
      assignments: [{ ...gatePassFixture.assignments[0], correctionLimit: 4 }],
    }),
    /correction|limit|3/,
  )
})

test.todo('future runtime: deny two concurrent write-authorized Assignments for one Project')
test.todo('future runtime: reject validator mutation between pre-scan and acceptance')
test.todo('future runtime: retain uncertain writer after stop acknowledgement without quiescence')
test.todo('future runtime: preserve original/replacement takeover and recovery parity across restart')
test.todo('future runtime: reject same-Pi delivery retry after unknown acknowledgement')
