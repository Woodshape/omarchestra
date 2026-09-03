import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  EventRecord,
  Role,
  RoleProjectionValue,
  SnapshotBody,
} from '../../src/protocol.ts'

async function createProjection() {
  const { AgentConsoleProjection } = await import('../projection-core.ts')
  return new AgentConsoleProjection()
}

const IDENTITIES: Record<Role, string> = {
  coordinator: 'agent-run-coordinator-1',
  builder: 'agent-run-builder-1',
  reviewer: 'agent-run-reviewer-1',
}

const DISPLAY: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  reviewer: 'Reviewer',
}

function roleProjection(
  role: Role,
  piStatus: string = `${DISPLAY[role]} · waiting`,
): RoleProjectionValue {
  const state = piStatus.includes('manual_takeover') ? 'manual_takeover'
    : piStatus.includes('managed') ? 'managed'
      : 'waiting'
  return {
    role,
    agentRunId: IDENTITIES[role],
    terminalSessionRef: `terminal-${role}-1`,
    shellRunId: `shell-${role}-1`,
    piSessionId: `pi-session-${role}-1`,
    extensionInstanceId: `extension-${role}-1`,
    hostPid: role === 'coordinator' ? 51001 : role === 'builder' ? 51002 : 51003,
    hostMode: 'tui',
    controlMode: state === 'manual_takeover' ? 'manual_takeover' : 'managed',
    agentState: state === 'managed' || state === 'manual_takeover' ? 'working' : 'waiting',
    assignmentState: state === 'managed' ? 'active'
      : state === 'manual_takeover' ? 'needs_reconciliation'
        : null,
    nativeTerminalTitle: `Omarchestra — ${DISPLAY[role]} — ${state}`,
    piStatus,
  }
}

function snapshot(
  cursor: number,
  labels: Partial<Record<Role, string>> = {},
): SnapshotBody {
  // Deliberately non-canonical input order. The handoff contract owns one
  // stable Coordinator, Builder, Reviewer presentation order.
  const roles: Role[] = ['reviewer', 'coordinator', 'builder']
  return {
    cursor,
    teamGoal: {
      id: 'team-goal-console-test',
      goalText: 'Fake-only Agent Console projection contract test.',
      createdAt: '2026-09-02T00:00:00.000Z',
      eventCursor: cursor,
    },
    roles: roles.map((role) => roleProjection(role, labels[role])),
    assignment: null,
    journal: {
      requested: 'default',
      effective: 'delete',
      sqliteVersion: '3.53.4',
    },
  }
}

function event(
  sequence: number,
  eventId: string = `event-${sequence}`,
  role: Role | null = 'builder',
): EventRecord {
  return {
    sequence,
    eventId,
    eventType: role === null ? 'runner_restarted' : 'manual_takeover',
    role,
    payload: role === null ? { runnerPid: 99999 } : { role },
    createdAt: `2026-09-02T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
  }
}

function builderCard(projection: { handoff: { cards: Array<{ role: Role; piStatus: string }> } | null }) {
  return projection.handoff?.cards.find((candidate) => candidate.role === 'builder')
}

test('authoritative snapshot initializes exactly three canonically ordered committed cards', async () => {
  const projection = await createProjection()
  assert.equal(projection.handoff, null, 'no values are fabricated before an authoritative snapshot')

  projection.initialize(snapshot(10, {
    // Intentionally does not agree with the other state fields. The adapter
    // must preserve the runner-committed string rather than derive a label.
    builder: 'Builder · runner-committed-opaque-label',
  }))

  assert.deepEqual(projection.handoff, {
    status: 'ready',
    cursor: 10,
    cards: [
      {
        role: 'coordinator',
        agentRunId: 'agent-run-coordinator-1',
        piStatus: 'Coordinator · waiting',
      },
      {
        role: 'builder',
        agentRunId: 'agent-run-builder-1',
        piStatus: 'Builder · runner-committed-opaque-label',
      },
      {
        role: 'reviewer',
        agentRunId: 'agent-run-reviewer-1',
        piStatus: 'Reviewer · waiting',
      },
    ],
  })
})

test('events cannot initialize the projection before an authoritative snapshot', async () => {
  const projection = await createProjection()
  assert.throws(
    () => projection.acceptEvent(event(1)),
    /authoritative snapshot/i,
  )
  assert.equal(projection.handoff, null)
})

test('initialization rejects missing or duplicate fixed roles', async () => {
  const missing = snapshot(10)
  missing.roles = missing.roles.slice(0, 2)
  const missingProjection = await createProjection()
  assert.throws(() => missingProjection.initialize(missing), /exactly three|roles/i)
  assert.equal(missingProjection.handoff, null)

  const duplicate = snapshot(10)
  duplicate.roles[2] = { ...duplicate.roles[2], role: 'coordinator' }
  const duplicateProjection = await createProjection()
  assert.throws(() => duplicateProjection.initialize(duplicate), /unique|roles/i)
  assert.equal(duplicateProjection.handoff, null)
})

test('ordered events retain old cards until a cursor-matched authoritative resnapshot', async () => {
  const projection = await createProjection()
  projection.initialize(snapshot(10))

  projection.acceptEvent(event(11))
  projection.acceptEvent(event(12, 'event-12', null))
  assert.equal(projection.handoff?.status, 'reconnecting')
  assert.equal(projection.handoff?.cursor, 12)
  assert.equal(builderCard(projection)?.piStatus, 'Builder · waiting')

  projection.resnapshot(snapshot(12, { builder: 'Builder · manual_takeover' }))
  assert.equal(projection.handoff?.status, 'ready')
  assert.equal(projection.handoff?.cursor, 12)
  assert.equal(builderCard(projection)?.piStatus, 'Builder · manual_takeover')
})

test('an event sequence gap is rejected and made explicit without advancing the cursor', async () => {
  const projection = await createProjection()
  projection.initialize(snapshot(10))

  assert.throws(() => projection.acceptEvent(event(12)), /gap|sequence|cursor/i)
  assert.equal(projection.handoff?.status, 'gap')
  assert.equal(projection.handoff?.cursor, 10)
  assert.equal(builderCard(projection)?.piStatus, 'Builder · waiting')
})

test('duplicate sequences and duplicate event identities are rejected', async () => {
  const duplicateSequence = await createProjection()
  duplicateSequence.initialize(snapshot(10))
  duplicateSequence.acceptEvent(event(11, 'event-shared'))
  assert.throws(
    () => duplicateSequence.acceptEvent(event(11, 'event-other')),
    /duplicate|sequence|cursor/i,
  )
  assert.equal(duplicateSequence.handoff?.status, 'gap')
  assert.equal(duplicateSequence.handoff?.cursor, 11)

  const duplicateIdentity = await createProjection()
  duplicateIdentity.initialize(snapshot(10))
  duplicateIdentity.acceptEvent(event(11, 'event-shared'))
  assert.throws(
    () => duplicateIdentity.acceptEvent(event(12, 'event-shared')),
    /duplicate|event/i,
  )
  assert.equal(duplicateIdentity.handoff?.status, 'gap')
  assert.equal(duplicateIdentity.handoff?.cursor, 11)
})

test('malformed snapshot and event bodies are rejected by protocol validation', async () => {
  const malformedSnapshot = await createProjection()
  assert.throws(() => malformedSnapshot.initialize({}), /snapshot|body|fields/i)
  assert.equal(malformedSnapshot.handoff, null)

  const malformedEvent = await createProjection()
  malformedEvent.initialize(snapshot(10))
  assert.throws(() => malformedEvent.acceptEvent({ sequence: 11 }), /event|body|fields/i)
  assert.equal(malformedEvent.handoff?.status, 'gap')
  assert.equal(malformedEvent.handoff?.cursor, 10)
})

test('a reconnect snapshot cursor must equal the last accepted ordered event cursor', async () => {
  const projection = await createProjection()
  projection.initialize(snapshot(10))
  projection.acceptEvent(event(11))

  assert.throws(() => projection.resnapshot(snapshot(12)), /cursor/i)
  assert.equal(projection.handoff?.status, 'gap')
  assert.equal(projection.handoff?.cursor, 11)
})

test('resnapshot rejects stale role-to-Agent-Run identity bindings', async () => {
  for (const staleSnapshot of [
    (() => {
      const value = snapshot(11)
      const builder = value.roles.find((role) => role.role === 'builder')!
      builder.agentRunId = 'agent-run-builder-replaced'
      return value
    })(),
    (() => {
      const value = snapshot(11)
      const coordinator = value.roles.find((role) => role.role === 'coordinator')!
      const reviewer = value.roles.find((role) => role.role === 'reviewer')!
      ;[coordinator.agentRunId, reviewer.agentRunId] = [reviewer.agentRunId, coordinator.agentRunId]
      return value
    })(),
  ]) {
    const projection = await createProjection()
    projection.initialize(snapshot(10))
    projection.acceptEvent(event(11))
    assert.throws(() => projection.resnapshot(staleSnapshot), /identity|agent.?run|role/i)
    assert.equal(projection.handoff?.status, 'gap')
    assert.equal(projection.handoff?.cursor, 11)
  }
})

test('explicit gap recovery requires a fresh authoritative snapshot and preserves identities', async () => {
  const projection = await createProjection()
  projection.initialize(snapshot(10))
  projection.markGap('runner reported retained-history gap')

  assert.equal(projection.handoff?.status, 'gap')
  assert.throws(() => projection.resnapshot(snapshot(15)), /gap|recover|fresh/i)
  assert.equal(projection.handoff?.status, 'gap')

  projection.recover(snapshot(15, { builder: 'Builder · manual_takeover' }))
  assert.equal(projection.handoff?.status, 'ready')
  assert.equal(projection.handoff?.cursor, 15)
  assert.equal(builderCard(projection)?.piStatus, 'Builder · manual_takeover')

  const stale = snapshot(16)
  stale.roles.find((role) => role.role === 'reviewer')!.agentRunId = 'stale-reviewer-run'
  projection.markGap('second explicit gap')
  assert.throws(() => projection.recover(stale), /identity|agent.?run|role/i)
  assert.equal(projection.handoff?.status, 'gap')
  assert.equal(projection.handoff?.cursor, 15)
})

interface FakeTransportHandler {
  onFrame(frame: { type: string; messageId: string; body: Record<string, unknown> }): void
  onClose(error: Error | null): void
}

class FakeProjectionChannel {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  closed = false
  private readonly handler: FakeTransportHandler
  constructor(handler: FakeTransportHandler) {
    this.handler = handler
  }
  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.sent.push({ type, messageId, body })
  }
  close(): void {
    this.closed = true
  }
  emit(type: string, body: Record<string, unknown>): void {
    this.handler.onFrame({ type, messageId: `fake-${type}`, body })
  }
}

class FakeProjectionConnector {
  readonly channels: FakeProjectionChannel[] = []
  async connect(handler: FakeTransportHandler): Promise<FakeProjectionChannel> {
    const channel = new FakeProjectionChannel(handler)
    this.channels.push(channel)
    return channel
  }
}

function helloAck() {
  return {
    connectionKind: 'projection',
    teamGoalId: 'team-goal-console-test',
    role: null,
  }
}

async function settleConnections(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('runtime adapter uses injected transport and sink, then resnapshots after live events', async () => {
  const { LiveProjectionAdapter } = await import('../live-projection-adapter.ts')
  const connector = new FakeProjectionConnector()
  const published: unknown[] = []
  const adapter = new LiveProjectionAdapter({
    teamGoalId: 'team-goal-console-test',
    clientId: 'console-test-client',
    connector,
    sink: (value: unknown) => published.push(value),
  })

  await adapter.start()
  const first = connector.channels[0]
  assert.deepEqual(first.sent.map((frame) => [frame.type, frame.body.resumeAfter]), [
    ['projection.hello', null],
  ])
  first.emit('hello_ack', helloAck())
  first.emit('snapshot', snapshot(10) as unknown as Record<string, unknown>)
  assert.equal((published.at(-1) as { status: string }).status, 'ready')

  first.emit('event', event(11) as unknown as Record<string, unknown>)
  assert.equal((published.at(-1) as { status: string }).status, 'reconnecting')
  await settleConnections()
  assert.equal(first.closed, true)
  const second = connector.channels[1]
  assert.deepEqual(second.sent.map((frame) => [frame.type, frame.body.resumeAfter]), [
    ['projection.hello', 11],
  ])

  second.emit('hello_ack', helloAck())
  second.emit('event_page', { fromCursor: 11, toCursor: 11, events: [] })
  second.emit('snapshot', snapshot(11, { builder: 'Builder · manual_takeover' }) as unknown as Record<string, unknown>)
  const final = published.at(-1) as { status: string; cursor: number; cards: Array<{ role: Role; piStatus: string }> }
  assert.equal(final.status, 'ready')
  assert.equal(final.cursor, 11)
  assert.equal(final.cards.find((card) => card.role === 'builder')?.piStatus, 'Builder · manual_takeover')
  adapter.stop()
})

test('runtime adapter makes malformed input an explicit gap and recovers only from a fresh snapshot', async () => {
  const { LiveProjectionAdapter } = await import('../live-projection-adapter.ts')
  const connector = new FakeProjectionConnector()
  const published: Array<{ status: string; cursor: number }> = []
  const adapter = new LiveProjectionAdapter({
    teamGoalId: 'team-goal-console-test',
    clientId: 'console-test-recovery',
    connector,
    sink: (value: { status: string; cursor: number }) => published.push(value),
  })

  await adapter.start()
  const first = connector.channels[0]
  first.emit('hello_ack', helloAck())
  first.emit('snapshot', snapshot(10) as unknown as Record<string, unknown>)
  first.emit('event', { sequence: 11 })
  assert.equal(published.at(-1)?.status, 'gap')
  assert.equal(published.at(-1)?.cursor, 10)

  await settleConnections()
  const recovery = connector.channels[1]
  assert.deepEqual(recovery.sent.map((frame) => [frame.type, frame.body.resumeAfter]), [
    ['projection.hello', null],
  ])
  recovery.emit('hello_ack', helloAck())
  recovery.emit('snapshot', snapshot(15, { builder: 'Builder · manual_takeover' }) as unknown as Record<string, unknown>)
  assert.equal(published.at(-1)?.status, 'ready')
  assert.equal(published.at(-1)?.cursor, 15)
  adapter.stop()
})
