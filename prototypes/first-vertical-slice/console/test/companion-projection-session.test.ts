import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Companion Plugin / Projection Session seam red tests (task 1.b).
 *
 * These tests specify the persistent-plugin Projection Session lifecycle on
 * top of the EXISTING projection core and live adapter:
 *
 *   - `companion/projection-session.ts`  — thin session controller that MUST
 *     delegate to `console/projection-core.ts` (AgentConsoleProjection) and
 *     `console/live-projection-adapter.ts` (LiveProjectionAdapter) instead of
 *     defining a second cursor/state machine;
 *   - `companion/fake-companion-shell.ts` — fake of the installed Omarchy
 *     shell hosting the installed plugin (summon/call/hide surface with
 *     plugin-generation tracking and an installation mutation log).
 *
 * Contract pinned here (implemented in task 2.c against contracts.ts):
 *
 *   new ProjectionSessionManager({
 *     pluginId, protocol, shell, connector, sink?, clientId?,
 *   })
 *   - open({ teamGoalId }): omarchestra.companion/v1 capability discovery
 *     through the shell port FIRST (fail-closed on protocol mismatch, missing
 *     capabilities, or a missing plugin, before any runner connection), then
 *     the existing adapter handshake, then summon + applyHandoff ONLY after
 *     the first authoritative snapshot.
 *   - sendIntent({ intentId, kind, role, payload? }): forwards a presentation
 *     intent for a PRESENT agent (role in the current ready handoff) exactly
 *     once and resolves only from the runner intent acknowledgement.
 *   - hide(): shell hide + full ephemeral state clearing; idempotent.
 *   - clear(): clears all ephemeral projection state without hiding.
 *   - Getters: handoff, projection (the reused AgentConsoleProjection
 *     instance), sessionGeneration, lastError.
 *
 *   new FakeCompanionShell({ pluginId, version, protocol, capabilities })
 *   - capabilities(pluginId): discovery response incl. generation.
 *   - summon(pluginId, payloadJson) / call(pluginId, method, payloadJson) /
 *     hide(pluginId): recorded operations; summon/call/hide payloads carry the
 *     manager's known pluginGeneration and stale generations are rejected.
 *   - panel: { visible, cleared, handoffs, intentResults }.
 *   - calls(), mutationLog(), installationFingerprint(), reloadPlugin(),
 *     currentGeneration(), setProtocol(), setCapabilities(), setInstalled().
 *
 * Every scenario is fake-only: no Omarchy UI, shell IPC, user configuration,
 * filesystem, provider, terminal, SSH, Boomux, or systemd action.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = resolve(TEST_DIR, '..', '..')
const SESSION_MODULE = join(PROTOTYPE_ROOT, 'companion', 'projection-session.ts')
const FAKE_SHELL_MODULE = join(PROTOTYPE_ROOT, 'companion', 'fake-companion-shell.ts')

const PROTOCOL = 'omarchestra.companion/v1'
const PLUGIN_ID = 'omarchestra.agent-console'
const TEAM_GOAL_ID = 'team-goal-companion-session'
const CLIENT_ID = 'companion-session-test-client'
const SESSION_CAPABILITIES = [
  'session.open',
  'session.update',
  'session.intent',
  'session.hide',
  'session.clear',
  'session.resnapshot',
]

type CompanionModules = Record<string, any>

let modulesPromise: Promise<CompanionModules> | undefined

async function modules(): Promise<CompanionModules> {
  modulesPromise ??= Promise.all([
    import('../../companion/projection-session.ts'),
    import('../../companion/fake-companion-shell.ts'),
  ]).then(([session, shell]) => ({ ...session, ...shell }))
  return modulesPromise
}

// --- Existing-core fixtures (shared shape with projection-adapter.test.ts) ---

type AnyRole = 'coordinator' | 'builder' | 'reviewer'

const IDENTITIES: Record<AnyRole, string> = {
  coordinator: 'agent-run-coordinator-1',
  builder: 'agent-run-builder-1',
  reviewer: 'agent-run-reviewer-1',
}

const DISPLAY: Record<AnyRole, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  reviewer: 'Reviewer',
}

function roleProjection(role: AnyRole, piStatus: string): Record<string, unknown> {
  const state = piStatus.includes('manual_takeover')
    ? 'manual_takeover'
    : piStatus.includes('managed')
      ? 'managed'
      : 'waiting'
  return {
    role,
    agentRunId: IDENTITIES[role],
    terminalSessionRef: `terminal-${role}-1`,
    shellRunId: `shell-${role}-1`,
    piSessionId: `pi-session-${role}-1`,
    extensionInstanceId: `extension-${role}-1`,
    hostPid: role === 'coordinator' ? 52001 : role === 'builder' ? 52002 : 52003,
    hostMode: 'tui',
    controlMode: state === 'manual_takeover' ? 'manual_takeover' : 'managed',
    agentState: state === 'waiting' ? 'waiting' : 'working',
    assignmentState: state === 'managed' ? 'active' : state === 'manual_takeover' ? 'needs_reconciliation' : null,
    nativeTerminalTitle: `Omarchestra — ${DISPLAY[role]} — ${state}`,
    piStatus,
  }
}

function snapshot(cursor: number, labels: Partial<Record<AnyRole, string>> = {}): Record<string, unknown> {
  const roles: AnyRole[] = ['reviewer', 'coordinator', 'builder']
  return {
    cursor,
    teamGoal: {
      id: TEAM_GOAL_ID,
      goalText: 'Fake-only Companion Projection Session contract test.',
      createdAt: '2026-09-02T00:00:00.000Z',
      eventCursor: cursor,
    },
    roles: roles.map((role) => roleProjection(role, labels[role] ?? `${DISPLAY[role]} · waiting`)),
    assignment: null,
    journal: { requested: 'default', effective: 'delete', sqliteVersion: '3.53.4' },
  }
}

function event(sequence: number, eventId = `event-${sequence}`, role: AnyRole | null = 'builder'): Record<string, unknown> {
  return {
    sequence,
    eventId,
    eventType: role === null ? 'runner_restarted' : 'manual_takeover',
    role,
    payload: role === null ? { runnerPid: 99999 } : { role },
    createdAt: `2026-09-02T00:00:${String(sequence % 60).padStart(2, '0')}.000Z`,
  }
}

// --- Fake transport (same shape as the existing adapter seam fakes) ---

interface FakeHandler {
  onFrame(frame: { type: string; messageId: string; body: Record<string, unknown> }): void
  onClose(error: Error | null): void
}

class FakeChannel {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  closed = false
  private readonly handler: FakeHandler
  constructor(handler: FakeHandler) {
    this.handler = handler
  }
  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.sent.push({ type, messageId, body })
  }
  close(): void {
    this.closed = true
  }
  /** Simulate the transport closing from the runner side. */
  emitClose(error: Error | null = new Error('fake projection connection closed')): void {
    this.handler.onClose(error)
  }
  emit(type: string, body: Record<string, unknown>): void {
    this.handler.onFrame({ type, messageId: `fake-${type}-${this.sent.length}`, body })
  }
  intentFrames(): Array<{ type: string; body: Record<string, unknown> }> {
    return this.sent.filter((frame) => /intent/i.test(frame.type))
  }
}

class FakeConnector {
  readonly channels: FakeChannel[] = []
  async connect(handler: FakeHandler): Promise<FakeChannel> {
    const channel = new FakeChannel(handler)
    this.channels.push(channel)
    return channel
  }
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolveTick) => setImmediate(resolveTick))
  }
}

// --- Shared harness ---

async function harness(options: {
  shell?: Record<string, unknown>
} = {}): Promise<{
  manager: any
  shell: any
  connector: FakeConnector
  published: unknown[]
}> {
  const { ProjectionSessionManager, FakeCompanionShell } = await modules()
  const shell = new FakeCompanionShell({
    pluginId: PLUGIN_ID,
    version: '0.2.0',
    protocol: PROTOCOL,
    capabilities: [...SESSION_CAPABILITIES],
    ...options.shell,
  })
  const connector = new FakeConnector()
  const published: unknown[] = []
  const manager = new ProjectionSessionManager({
    pluginId: PLUGIN_ID,
    protocol: PROTOCOL,
    shell,
    connector,
    clientId: CLIENT_ID,
    sink: (value: unknown) => published.push(value),
  })
  return { manager, shell, connector, published }
}

async function openSession(
  manager: any,
  connector: FakeConnector,
  options: { snapshotCursor?: number; labels?: Partial<Record<AnyRole, string>> } = {},
): Promise<FakeChannel> {
  const opening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  const channel = connector.channels[0]
  assert.ok(channel, 'open must connect the projection transport after capability discovery')
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  channel.emit('snapshot', snapshot(options.snapshotCursor ?? 10, options.labels))
  await opening
  return channel
}

function applyCalls(shell: any): Array<{ method: string; body: any }> {
  return shell
    .calls()
    .filter((call: any) => call.operation === 'call' && call.method === 'applyHandoff')
    .map((call: any) => ({ method: call.method, body: JSON.parse(call.payloadJson) }))
}

function cardOf(handoff: any, role: string): any {
  return handoff?.cards?.find((card: any) => card.role === role)
}

// ---------------------------------------------------------------------------
// Capability discovery
// ---------------------------------------------------------------------------

test('open performs omarchestra.companion/v1 capability discovery before any runner connection', async () => {
  const { manager, shell, connector } = await harness()
  assert.equal(typeof manager.sessionGeneration, 'number')

  shell.holdCapabilities()
  const opening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle(5)
  assert.deepEqual(
    shell.calls().map((call: any) => call.operation),
    ['capabilities'],
    'capability discovery must be the first and only shell operation before connecting',
  )
  assert.equal(connector.channels.length, 0, 'no runner connection before capability discovery succeeds')

  shell.releaseCapabilities()
  await settle(5)
  assert.ok(connector.channels.length >= 1, 'a runner connection is created after discovery')

  const discovery = shell.calls().find((call: any) => call.operation === 'capabilities')
  assert.equal(discovery.pluginId, PLUGIN_ID)

  connector.channels[0].emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  connector.channels[0].emit('snapshot', snapshot(10) as Record<string, unknown>)
  await opening
})

test('capability discovery fails closed on a foreign protocol version without creating a session', async () => {
  const { manager, shell, connector, published } = await harness({
    shell: { protocol: 'omarchestra.companion/v0' },
  })

  await assert.rejects(() => manager.open({ teamGoalId: TEAM_GOAL_ID }), /protocol|capab|compat|version/i)
  assert.deepEqual(published, [], 'no projection value may be published from an incompatible plugin')
  assert.deepEqual(
    shell.calls().filter((call: any) => call.operation === 'summon'),
    [],
    'an incompatible plugin must never be summoned',
  )
  assert.equal(connector.channels.length, 0, 'an incompatible plugin must never reach the runner')
  assert.deepEqual(shell.mutationLog(), [])
})

test('capability discovery fails closed when the installed Companion release version differs', async () => {
  const { manager, connector } = await harness({ shell: { version: '9.9.9' } })

  const rejected = assert.rejects(
    () => manager.open({ teamGoalId: TEAM_GOAL_ID }),
    /version|compatib|0\.2\.0/i,
  )
  await settle()
  if (connector.channels[0] !== undefined) {
    connector.channels[0].emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
    connector.channels[0].emit('snapshot', snapshot(10) as Record<string, unknown>)
  }
  await rejected
  assert.equal(connector.channels.length, 0, 'a foreign installed release must never reach the runner')
})

test('capability discovery fails closed when required session capabilities are missing', async () => {
  const { manager, shell, connector } = await harness({
    shell: { capabilities: ['session.open'] },
  })

  await assert.rejects(() => manager.open({ teamGoalId: TEAM_GOAL_ID }), /capab|missing|unsupported/i)
  assert.deepEqual(
    shell.calls().filter((call: any) => call.operation === 'summon'),
    [],
  )
  assert.equal(connector.channels.length, 0)
  assert.deepEqual(shell.mutationLog(), [])
})

test('open fails closed when the Companion Plugin is not installed and never contacts the runner', async () => {
  const { manager, shell, connector } = await harness({ shell: { installed: false } })

  await assert.rejects(() => manager.open({ teamGoalId: TEAM_GOAL_ID }), /installed|missing|not.*plugin|plugin.*absent/i)
  assert.equal(connector.channels.length, 0)
  assert.deepEqual(shell.calls(), [])
  assert.deepEqual(shell.mutationLog(), [])
})

// ---------------------------------------------------------------------------
// Authoritative snapshot-before-open
// ---------------------------------------------------------------------------

test('the panel is summoned only after the first authoritative snapshot and shows its committed cards', async () => {
  const { manager, shell, connector, published } = await harness()

  const opening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  assert.equal(manager.handoff, null, 'no handoff may exist before an authoritative snapshot')
  assert.deepEqual(published, [], 'no value may be published before an authoritative snapshot')
  assert.deepEqual(
    shell.calls().filter((call: any) => call.operation === 'summon'),
    [],
    'the panel must never open on QML-authored placeholder state',
  )

  const channel = connector.channels[0]
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  channel.emit('snapshot', snapshot(10, { builder: 'Builder · managed' }))
  await opening

  const handoff = manager.handoff
  assert.equal(handoff?.status, 'ready')
  assert.equal(handoff?.cursor, 10)
  assert.equal(cardOf(handoff, 'builder')?.piStatus, 'Builder · managed')

  const summon = shell.calls().find((call: any) => call.operation === 'summon')
  assert.ok(summon, 'the validated snapshot opens the panel exactly once')
  const payload = JSON.parse(summon.payloadJson)
  assert.equal(payload.protocol, PROTOCOL, 'the summon payload carries the negotiated companion protocol')
  assert.equal(payload.teamGoalId, TEAM_GOAL_ID)
  assert.equal(typeof payload.pluginGeneration, 'number', 'the summon payload carries the plugin generation')
  assert.equal(payload.projection.status, 'ready')
  assert.equal(payload.projection.cursor, 10)

  assert.equal(shell.panel.visible, true)
  const first = applyCalls(shell)[0]
  assert.equal(first.body.status, 'ready')
  assert.equal(first.body.cursor, 10)
})

test('open waits for asynchronous summon and initial apply acknowledgement in order', async () => {
  const { ProjectionSessionManager, FakeCompanionShell } = await modules()
  const underlying = new FakeCompanionShell({
    pluginId: PLUGIN_ID,
    version: '0.2.0',
    protocol: PROTOCOL,
    capabilities: [...SESSION_CAPABILITIES],
  })
  const connector = new FakeConnector()
  const pending: Array<{ operation: string; run(): void }> = []
  const shell = {
    capabilities: (pluginId: string) => underlying.capabilities(pluginId),
    summon: (pluginId: string, payloadJson: string) => new Promise<void>((resolve, reject) => {
      pending.push({ operation: 'summon', run: () => { try { underlying.summon(pluginId, payloadJson); resolve() } catch (error) { reject(error) } } })
    }),
    call: (pluginId: string, method: 'applyHandoff' | 'clear' | 'intentResult', payloadJson: string) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ operation: method, run: () => { try { underlying.call(pluginId, method, payloadJson); resolve() } catch (error) { reject(error) } } })
      }),
    hide: (pluginId: string, payloadJson: string) => underlying.hide(pluginId, payloadJson),
  }
  const manager = new ProjectionSessionManager({ pluginId: PLUGIN_ID, protocol: PROTOCOL, shell, connector, clientId: CLIENT_ID })
  let opened = false
  const opening = manager.open({ teamGoalId: TEAM_GOAL_ID }).then(() => { opened = true })
  await settle()
  const channel = connector.channels[0]
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  channel.emit('snapshot', snapshot(10) as Record<string, unknown>)
  await settle()

  assert.deepEqual(pending.map((entry) => entry.operation), ['summon'], 'apply must wait for summon completion')
  assert.equal(opened, false, 'open must not resolve before the plugin accepts its initial projection')
  pending.shift()!.run()
  await settle()
  assert.deepEqual(pending.map((entry) => entry.operation), ['applyHandoff'])
  assert.equal(opened, false)
  pending.shift()!.run()
  await opening
  assert.equal(opened, true)
})

test('an asynchronous projection apply failure is observable and closes only the Projection Session', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)
  const originalCall = shell.call.bind(shell)
  let rejectNextApply = true
  shell.call = async (pluginId: string, method: string, payloadJson: string) => {
    if (method === 'applyHandoff' && rejectNextApply) {
      rejectNextApply = false
      throw new Error('injected asynchronous apply failure')
    }
    return originalCall(pluginId, method, payloadJson)
  }

  channel.emit('event', event(11) as Record<string, unknown>)
  await settle(8)

  assert.match(String(manager.lastError), /asynchronous apply failure/)
  assert.equal(channel.closed, true)
  assert.equal(manager.handoff, null)
})

test('an asynchronous hide failure remains observable while the session still ends', async () => {
  const { manager, shell, connector } = await harness()
  await openSession(manager, connector)
  shell.hide = async () => { throw new Error('injected asynchronous hide failure') }

  await assert.rejects(() => manager.hide(), /asynchronous hide failure/)
  assert.match(String(manager.lastError), /asynchronous hide failure/)
  assert.equal(manager.handoff, null)
})

test('separate manager instances allocate collision-resistant Projection Session identities', async () => {
  const first = await harness()
  const second = await harness()
  await openSession(first.manager, first.connector)
  await openSession(second.manager, second.connector)
  const firstId = JSON.parse(first.shell.calls().find((call: any) => call.operation === 'summon').payloadJson).sessionId
  const secondId = JSON.parse(second.shell.calls().find((call: any) => call.operation === 'summon').payloadJson).sessionId
  assert.notEqual(firstId, secondId, 'a process restart must not recreate the previous ephemeral identity')
})

test('a malformed pre-snapshot exchange never opens the panel and never fabricates cards', async () => {
  const { manager, shell, connector } = await harness()

  await assert.rejects(() => openSessionWithMalformedSnapshot(manager, connector), /snapshot|body|fields|invalid/i)
  assert.equal(manager.handoff, null, 'no handoff may be fabricated from a malformed snapshot')
  assert.deepEqual(
    shell.calls().filter((call: any) => call.operation === 'summon'),
    [],
    'an invalid snapshot must never open the panel',
  )
  assert.deepEqual(shell.mutationLog(), [])
})

async function openSessionWithMalformedSnapshot(manager: any, connector: FakeConnector): Promise<void> {
  const opening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  const channel = connector.channels[0]
  assert.ok(channel)
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  channel.emit('snapshot', { cursor: 10 } as Record<string, unknown>)
  await opening
}

// ---------------------------------------------------------------------------
// Ordered updates, gaps, duplicates, reconnect/resnapshot
// ---------------------------------------------------------------------------

test('contiguous ordered updates advance the reused projection core and resnapshot on the resume connection', async () => {
  const { manager, shell, connector, published } = await harness()
  const { AgentConsoleProjection } = await import('../projection-core.ts')
  const reference = new AgentConsoleProjection()

  const channel = await openSession(manager, connector)
  reference.initialize(snapshot(10) as any)

  channel.emit('event', event(11) as Record<string, unknown>)
  reference.acceptEvent(event(11) as any)
  assert.equal(manager.handoff?.status, 'reconnecting')
  assert.equal(manager.handoff?.cursor, 11)
  assert.equal(
    cardOf(manager.handoff, 'builder')?.piStatus,
    'Builder · waiting',
    'events retain the last authoritative cards until a cursor-matched resnapshot',
  )
  assert.deepEqual(manager.handoff, reference.handoff, 'the session must reuse the existing projection semantics')

  await settle()
  const resumed = connector.channels[1]
  assert.equal(resumed.sent[0]?.type, 'projection.hello')
  assert.equal(resumed.sent[0]?.body.resumeAfter, 11)
  resumed.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  resumed.emit('event_page', { fromCursor: 11, toCursor: 11, events: [] })
  resumed.emit('snapshot', snapshot(11, { builder: 'Builder · managed' }) as Record<string, unknown>)
  reference.resnapshot(snapshot(11, { builder: 'Builder · managed' }) as any)
  await settle()

  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(manager.handoff?.cursor, 11)
  assert.equal(cardOf(manager.handoff, 'builder')?.piStatus, 'Builder · managed')
  assert.deepEqual(manager.handoff, reference.handoff)

  const last = applyCalls(shell).at(-1)
  assert.equal(last.body.status, 'ready')
  assert.equal(last.body.cursor, 11)
  assert.equal((published.at(-1) as any)?.status, 'ready')
})

test('cursor gaps become an explicit gap on the panel without advancing the cursor or hiding the plugin', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)

  channel.emit('event', event(12) as Record<string, unknown>)
  await settle()
  assert.equal(manager.handoff?.status, 'gap')
  assert.equal(manager.handoff?.cursor, 10, 'a gap event must not advance the cursor')
  assert.equal(cardOf(manager.handoff, 'reviewer')?.piStatus, 'Reviewer · waiting')

  const last = applyCalls(shell).at(-1)
  assert.equal(last.body.status, 'gap')
  assert.equal(last.body.cursor, 10)

  assert.deepEqual(
    shell.calls().filter((call: any) => call.operation === 'hide'),
    [],
    'a presentation gap must never hide, disable, or unload the installed plugin',
  )
  assert.deepEqual(shell.mutationLog(), [])
})

test('duplicate sequences and duplicate event identities are rejected through the reused core', async () => {
  const { manager, connector } = await harness()
  const { AgentConsoleProjection } = await import('../projection-core.ts')
  const reference = new AgentConsoleProjection()
  await openSession(manager, connector)

  reference.initialize(snapshot(10) as any)

  manager.projection.acceptEvent(event(11, 'event-shared'))
  reference.acceptEvent(event(11, 'event-shared') as any)

  assert.throws(() => manager.projection.acceptEvent(event(11, 'event-other')), /duplicate|sequence|cursor/i)
  assert.throws(() => reference.acceptEvent(event(11, 'event-other')), /duplicate|sequence|cursor/i)
  assert.deepEqual(manager.handoff, reference.handoff)
  assert.equal(manager.handoff?.cursor, 11)

  assert.throws(() => manager.projection.acceptEvent(event(12, 'event-shared')), /duplicate|event/i)
  assert.deepEqual(manager.handoff, reference.handoff)
})

// ---------------------------------------------------------------------------
// Stale session and stale plugin generations
// ---------------------------------------------------------------------------

test('opening while a session is already active fails closed and preserves the active session', async () => {
  const { manager, shell, connector } = await harness()
  await openSession(manager, connector)
  const before = structuredClone(manager.handoff)
  const generation = manager.sessionGeneration

  await assert.rejects(() => manager.open({ teamGoalId: TEAM_GOAL_ID }), /active|already|hide|clear|stale/i)
  assert.deepEqual(manager.handoff, before)
  assert.equal(manager.sessionGeneration, generation)
  assert.equal(
    shell.calls().filter((call: any) => call.operation === 'summon').length,
    1,
    'no second panel summon for the still-active session',
  )
})

test('a plugin reload makes the running session stale: shell operations fail closed, the session stops, and a fresh open reconstructs identical cards', async () => {
  const { manager, shell, connector, published } = await harness()
  await openSession(manager, connector, { labels: { builder: 'Builder · managed' } })
  const cardsBefore = structuredClone(manager.handoff.cards)
  const generationBefore = shell.currentGeneration()

  shell.reloadPlugin()
  assert.notEqual(shell.currentGeneration(), generationBefore)

  // The next shell interaction from the stale session must fail closed.
  const staleChannel = connector.channels.at(-1)!
  staleChannel.emit('event', event(11) as Record<string, unknown>)
  await settle()

  assert.match(String(manager.lastError ?? ''), /stale|generation|reload|plugin/i)
  assert.deepEqual(
    connector.channels.filter((channel) => !channel.closed),
    [],
    'a stale plugin generation must close the projection connection instead of retrying forever',
  )

  const callsAfterStale = shell.calls()
  await settle(10)
  assert.deepEqual(shell.calls(), callsAfterStale, 'the stale session must not keep issuing shell operations')

  // A fresh open re-discovers the reloaded plugin and reconstructs the same
  // committed projection from a fresh authoritative snapshot.
  const reopening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  const freshChannel = connector.channels.at(-1)!
  freshChannel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  freshChannel.emit('snapshot', snapshot(10, { builder: 'Builder · managed' }) as Record<string, unknown>)
  await reopening

  assert.equal(manager.sessionGeneration, 2, 'each open creates a new ephemeral session generation')
  assert.deepEqual(manager.handoff?.cards, cardsBefore)
  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(cardOf(manager.handoff, 'builder')?.piStatus, 'Builder · managed')
  assert.equal((published.at(-1) as any)?.status, 'ready')

  const summons = shell.calls().filter((call: any) => call.operation === 'summon')
  assert.equal(summons.length, 2, 'the reloaded plugin is summoned again by the new session only')
  assert.deepEqual(shell.mutationLog(), [])
})

test('late frames from a hidden session are ignored and cannot mutate the presentation', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)

  await manager.hide()
  const hiddenState = structuredClone(manager.handoff)

  channel.emit('snapshot', snapshot(99) as Record<string, unknown>)
  channel.emit('event', event(100) as Record<string, unknown>)
  await settle()

  assert.deepEqual(manager.handoff, hiddenState, 'stale frames after hide must not resurrect state')
  assert.equal(
    applyCalls(shell).some((call) => call.body.status === 'ready' && call.body.cursor === 99),
    false,
  )
})

// ---------------------------------------------------------------------------
// Acknowledged present-agent intents
// ---------------------------------------------------------------------------

test('a callable plugin presentation intent reaches the manager and runner acknowledgement path', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)
  shell.queuePresentationIntent({
    intentId: 'intent-from-qml',
    kind: 'present_agent',
    role: 'builder',
  })

  assert.equal(await manager.pollPresentationIntent(), true)
  assert.equal(channel.intentFrames().length, 1)
  channel.emit('intent_ack', {
    intentId: 'intent-from-qml',
    result: 'accepted',
  })
  await settle()
  assert.equal(shell.panel.intentResults.at(-1)?.intentId, 'intent-from-qml')
})

test('a stale callable QML intent is visibly rejected without ending the Projection Session', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)
  shell.queuePresentationIntent({
    intentId: 'intent-stale-qml-role',
    kind: 'present_agent',
    role: 'observer',
  })

  assert.equal(await manager.pollPresentationIntent(), true)
  await settle(5)

  assert.equal(channel.intentFrames().length, 0)
  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(shell.panel.visible, true)
  assert.equal(shell.panel.intentResults.at(-1)?.intentId, 'intent-stale-qml-role')
  assert.match(String(shell.panel.intentResults.at(-1)?.result), /invalid|unavailable/)
})

test('a present-agent intent is forwarded exactly once and resolved only by the runner acknowledgement', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)

  const pending = manager.sendIntent({ intentId: 'intent-1', kind: 'present_agent', role: 'builder' })
  await settle(3)
  const frames = channel.intentFrames()
  assert.equal(frames.length, 1, 'one intent frame per accepted intent')
  assert.equal(frames[0].body.intentId, 'intent-1')
  assert.equal(frames[0].body.role, 'builder')

  channel.emit('intent_ack', { intentId: 'intent-1', result: 'accepted' })
  const result = await pending
  assert.equal(result.intentId, 'intent-1')
  assert.equal(result.result, 'accepted')

  const delivered = shell.panel.intentResults
  assert.equal(delivered.at(-1)?.intentId, 'intent-1')
  assert.equal(delivered.at(-1)?.result, 'accepted')
})

test('intents for agents that are not present, or while the projection is not ready, are rejected locally without a runner frame', async () => {
  const { manager, shell, connector } = await harness()
  const channel = await openSession(manager, connector)

  await assert.rejects(
    () => manager.sendIntent({ intentId: 'intent-unknown-role', kind: 'present_agent', role: 'observer' as AnyRole }),
    /present|unknown|role|agent/i,
  )
  assert.equal(channel.intentFrames().length, 0, 'a locally rejected intent must never reach the runner')

  channel.emit('event', event(12) as Record<string, unknown>)
  assert.equal(manager.handoff?.status, 'gap')
  await assert.rejects(
    () => manager.sendIntent({ intentId: 'intent-during-gap', kind: 'present_agent', role: 'builder' }),
    /gap|ready|unavailable|present/i,
  )
  assert.equal(channel.intentFrames().length, 0)
  assert.deepEqual(shell.panel.intentResults, [])
})

test('duplicate and already-resolved intent identities are deduplicated without a second runner frame', async () => {
  const { manager, connector } = await harness()
  const channel = await openSession(manager, connector)

  const first = manager.sendIntent({ intentId: 'intent-dup', kind: 'present_agent', role: 'coordinator' })
  await assert.rejects(
    () => manager.sendIntent({ intentId: 'intent-dup', kind: 'present_agent', role: 'coordinator' }),
    /duplicate|pending|intent/i,
  )
  assert.equal(channel.intentFrames().length, 1, 'the duplicate intent must not create a second frame')

  channel.emit('intent_ack', { intentId: 'intent-dup', result: 'accepted' })
  assert.equal((await first).result, 'accepted')

  await assert.rejects(
    () => manager.sendIntent({ intentId: 'intent-dup', kind: 'present_agent', role: 'coordinator' }),
    /duplicate|intent/i,
  )
  assert.equal(channel.intentFrames().length, 1, 'a resolved intent identity is never re-sent')
})

test('resolved intent identities are scoped to one Projection Session', async () => {
  const { manager, connector } = await harness()
  let channel = await openSession(manager, connector)
  const first = manager.sendIntent({ intentId: 'intent-session-local', role: 'builder' })
  channel.emit('intent_ack', { intentId: 'intent-session-local', result: 'accepted' })
  await first
  await manager.clear()

  const reopening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  channel = connector.channels.at(-1)!
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  channel.emit('snapshot', snapshot(20) as Record<string, unknown>)
  await reopening

  const second = manager.sendIntent({ intentId: 'intent-session-local', role: 'builder' })
  channel.emit('intent_ack', { intentId: 'intent-session-local', result: 'accepted' })
  assert.equal((await second).result, 'accepted')
})

test('an intent rejected by the runner is surfaced without changing the projection', async () => {
  const { manager, connector } = await harness()
  const channel = await openSession(manager, connector)
  const before = structuredClone(manager.handoff)

  const pending = manager.sendIntent({ intentId: 'intent-invalid', kind: 'present_agent', role: 'reviewer' })
  channel.emit('intent_ack', { intentId: 'intent-invalid', result: 'invalid' })
  const result = await pending

  assert.equal(result.intentId, 'intent-invalid')
  assert.equal(result.result, 'invalid')
  assert.deepEqual(manager.handoff, before)
})

// ---------------------------------------------------------------------------
// Hide, clear, reconnect/resnapshot
// ---------------------------------------------------------------------------

test('hide hides the panel, clears ephemeral state, and leaves installation state byte-identical', async () => {
  const { manager, shell, connector } = await harness()
  await openSession(manager, connector, { labels: { builder: 'Builder · managed' } })
  const fingerprintBefore = shell.installationFingerprint()

  await manager.hide()
  assert.equal(shell.panel.visible, false, 'the panel is hidden')
  assert.equal(manager.handoff, null, 'hiding clears the ephemeral projection state')

  const operations = shell.calls().map((call: any) => call.operation)
  assert.ok(operations.includes('hide'), 'hide reaches the shell hide operation')
  for (const forbidden of ['disable', 'unload', 'uninstall', 'writeShellJson', 'rescan', 'enable']) {
    assert.equal(operations.includes(forbidden), false, `session lifecycle must never ${forbidVerb(forbidden)}`)
  }
  assert.deepEqual(shell.mutationLog(), [], 'hiding a Team Goal session must not mutate installation state')
  assert.deepEqual(shell.installationFingerprint(), fingerprintBefore)

  await manager.hide()
  assert.equal(
    shell.calls().filter((call: any) => call.operation === 'hide').length,
    1,
    'hide is idempotent',
  )
  assert.equal(
    connector.channels.every((channel) => channel.closed),
    true,
    'the projection connection is closed',
  )
})

test('clear resets all ephemeral state without hiding, and the next open starts from a fresh authoritative snapshot', async () => {
  const { manager, shell, connector } = await harness()
  await openSession(manager, connector)
  const fingerprintBefore = shell.installationFingerprint()

  await manager.clear()
  assert.equal(manager.handoff, null, 'clear removes the ephemeral handoff')
  assert.equal(shell.panel.cleared, true, 'the panel is told to clear its ephemeral state')
  assert.equal(shell.panel.visible, true, 'clear does not hide the installed plugin')
  assert.deepEqual(shell.mutationLog(), [])
  assert.deepEqual(shell.installationFingerprint(), fingerprintBefore)

  const reopening = manager.open({ teamGoalId: TEAM_GOAL_ID })
  await settle()
  const fresh = connector.channels.at(-1)!
  fresh.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  fresh.emit('snapshot', snapshot(20) as Record<string, unknown>)
  await reopening

  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(manager.handoff?.cursor, 20)
  assert.equal(cardOf(manager.handoff, 'coordinator')?.piStatus, 'Coordinator · waiting')

  // The cleared session must not accept the old session's stale events.
  assert.throws(
    () => manager.projection.acceptEvent(event(11)),
    /sequence|gap|cursor|duplicate|stale/i,
    'stale pre-clear events must not continue a cleared session',
  )
})

test('reconnect after connection loss recovers only through a fresh authoritative snapshot', async () => {
  const { manager, shell, connector } = await harness()
  await openSession(manager, connector, { labels: { builder: 'Builder · managed' } })

  connector.channels[0].emitClose()
  await settle()

  const recovery = connector.channels.at(-1)!
  assert.notEqual(recovery, connector.channels[0], 'the adapter must reconnect through a new connection')
  assert.equal(recovery.sent[0]?.type, 'projection.hello')
  assert.equal(recovery.sent[0]?.body.resumeAfter, null, 'gap recovery uses a fresh authoritative snapshot')

  recovery.emit('hello_ack', { connectionKind: 'projection', teamGoalId: TEAM_GOAL_ID, role: null })
  recovery.emit('snapshot', snapshot(15, { builder: 'Builder · manual_takeover' }) as Record<string, unknown>)
  await settle()

  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(manager.handoff?.cursor, 15)
  assert.equal(cardOf(manager.handoff, 'builder')?.piStatus, 'Builder · manual_takeover')

  const last = applyCalls(shell).at(-1)
  assert.equal(last.body.status, 'ready')
  assert.deepEqual(shell.mutationLog(), [])
})

// ---------------------------------------------------------------------------
// Adaptation, not duplication
// ---------------------------------------------------------------------------

test('the session controller delegates to the existing projection core rather than a second state machine', async () => {
  const { manager } = await harness()
  const { AgentConsoleProjection } = await import('../projection-core.ts')

  assert.ok(
    manager.projection instanceof AgentConsoleProjection,
    'the session must drive the existing AgentConsoleProjection state machine, not a second one',
  )
})

test('the companion session modules reuse the console projection seam and never import installation or storage code', () => {
  assert.equal(existsSync(SESSION_MODULE), true, 'companion/projection-session.ts must exist')
  const sessionSource = readFileSync(SESSION_MODULE, 'utf8')

  assert.match(
    sessionSource,
    /from\s+['"][^'"]*console\/projection-core\.ts['"]/,
    'the session must import the existing projection core',
  )
  assert.match(
    sessionSource,
    /from\s+['"][^'"]*console\/live-projection-adapter\.ts['"]/,
    'the session must import the existing live adapter',
  )
  assert.doesNotMatch(sessionSource, /src\/store\.ts/, 'the session must never touch storage')
  assert.doesNotMatch(
    sessionSource,
    /installation\.ts|fake-omarchy\.ts/,
    'the session must never import installation or runtime mutation code',
  )
  assert.doesNotMatch(sessionSource, /\b(?:spawn|execFile|fork)\s*\(/, 'the session must never spawn processes')

  assert.equal(existsSync(FAKE_SHELL_MODULE), true, 'companion/fake-companion-shell.ts must exist')
  const fakeShellSource = readFileSync(FAKE_SHELL_MODULE, 'utf8')
  assert.doesNotMatch(fakeShellSource, /src\/store\.ts/, 'the fake shell must never touch storage')
  assert.doesNotMatch(fakeShellSource, /\b(?:spawn|execFile|fork)\s*\(/, 'the fake shell must never spawn processes')
})

// ---------------------------------------------------------------------------
// Presentation-only adapted QML
// ---------------------------------------------------------------------------

const MANIFEST_PATH = join(PROTOTYPE_ROOT, 'console', 'plugin', 'manifest.json')

test('the adapted plugin manifest advertises the companion protocol for capability discovery', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.id, PLUGIN_ID)
  assert.deepEqual(manifest.kinds, ['panel'])
  assert.equal(manifest.entryPoints?.panel, 'AgentConsole.qml')
  assert.equal(manifest.keepLoaded, true, 'truthful capabilities require one loaded plugin instance per shell generation')
  assert.equal(
    manifest.companion?.protocol,
    PROTOCOL,
    'the installed plugin must declare omarchestra.companion/v1 so discovery reads the real installed protocol',
  )
})

test('the adapted Agent Console QML gains session clear and presentation-intent surfaces without protocol authority', () => {
  const consoleSource = readFileSync(join(PROTOTYPE_ROOT, 'console', 'plugin', 'AgentConsole.qml'), 'utf8')
  const cardsSource = readFileSync(join(PROTOTYPE_ROOT, 'console', 'plugin', 'AgentConsoleCards.qml'), 'utf8')

  assert.match(consoleSource, /function\s+applyProjection\s*\(/, 'plain projection injection is retained')
  assert.match(consoleSource, /function\s+capabilities\s*\(/, 'the installed plugin reports its own version and generation')
  assert.match(consoleSource, /activeSession/, 'the panel retains the current opaque Projection Session identity')
  assert.match(consoleSource, /sameSession|sessionMatches/, 'stale session calls are rejected at the presentation surface')
  assert.match(consoleSource, /function\s+clear\s*\(/, 'the adapted panel exposes ephemeral state clearing')
  assert.match(consoleSource, /function\s+(?:hide|close)\s*\(/, 'the adapted panel exposes hide')
  assert.match(consoleSource, /onPresentRequested\s*:/, 'a visible card action emits a presentation intent')
  assert.match(consoleSource, /root\.intentRequested\s*\(/)
  assert.match(consoleSource, /function\s+takeIntent\s*\(/, 'the manager can collect emitted intents')
  assert.match(consoleSource, /lastIntentResult\.result/, 'the runner acknowledgement is rendered as plain data')
  assert.match(cardsSource, /signal\s+presentRequested\s*\(/)
  assert.match(cardsSource, /root\.presentRequested\s*\(/)
  assert.match(
    consoleSource + cardsSource,
    /signal\s+\w*intent\w*|function\s+emitIntent\s*\(/i,
    'the adapted panel exposes a presentation-intent surface',
  )

  // Presentation-only: no protocol, cursor math, transport, or storage logic.
  const combined = consoleSource + cardsSource
  assert.doesNotMatch(combined, /\bcursor\s*\+\s*1\b|\bsequence\b/, 'QML must never compute cursors or sequences')
  assert.doesNotMatch(
    combined,
    /\b(?:WebSocket|XMLHttpRequest|LocalStorage|sqlite|SQLite)\b/,
    'QML must not gain transport or storage dependencies',
  )
  assert.doesNotMatch(
    combined,
    /\b(?:intent_ack|projection\.hello|event_page|resumeAfter)\b/,
    'QML must not speak the projection protocol; the non-QML adapter owns it',
  )
})

test('the observer-capable release QML is byte-identical to canonical sources without rewriting 0.2.0', async () => {
  const { COMPANION_RELEASE, RELEASE_CATALOG } = await import('../../companion/releases.ts')
  assert.equal(COMPANION_RELEASE.version, '0.2.0', 'the evidenced legacy release remains immutable')
  const observerRelease = RELEASE_CATALOG['0.3.0']
  assert.ok(observerRelease, 'the observer-capable release must be additive')
  assert.notEqual(observerRelease, COMPANION_RELEASE)
  for (const file of ['AgentConsole.qml', 'AgentConsoleCards.qml', 'UnassignedAgents.qml']) {
    assert.equal(
      observerRelease.assets[file],
      readFileSync(join(PROTOTYPE_ROOT, 'console', 'plugin', file), 'utf8'),
      `${file} must have one canonical source enforced by this executable gate`,
    )
  }
})

test('adapted QML continues to render opaque committed piStatus values without label derivation', () => {
  const cardsSource = readFileSync(join(PROTOTYPE_ROOT, 'console', 'plugin', 'AgentConsoleCards.qml'), 'utf8')
  assert.match(cardsSource, /\btext\s*:[^\n;]*\.piStatus\b/)
  assert.doesNotMatch(cardsSource, /["'](?:Coordinator|Builder|Reviewer)\s*[·:-]\s*(?:waiting|managed|manual_takeover)["']/)
  assert.doesNotMatch(cardsSource, /\bpiStatus\s*\.\s*(?:split|replace|slice|substring|substr|match)\s*\(/)
})

function forbidVerb(operation: string): string {
  const verbs: Record<string, string> = {
    disable: 'disable the plugin',
    unload: 'unload the plugin',
    uninstall: 'uninstall the plugin',
    writeShellJson: 'rewrite shell.json',
    rescan: 'rescan installed plugins',
    enable: 'change plugin enablement',
  }
  return verbs[operation] ?? operation
}
