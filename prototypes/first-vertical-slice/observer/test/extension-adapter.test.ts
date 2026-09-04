/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only coverage for the same-process Pi observer adapter. These tests
 * use the locked public Pi extension lifecycle contract and never contact a
 * live Pi, registry, terminal, or installed plugin.
 *
 * The harness is entirely in memory. It does not start Pi, create a process,
 * open a socket, launch a provider, access a terminal, or mutate any global
 * configuration.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

async function loadAdapter() {
  return await import('../extension-adapter.ts')
}

async function loadFakeHost() {
  return await import('../fake-pi-host.ts')
}

const IDS = Object.freeze({
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  nextExtensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000002',
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  executionNodeId: 'execution-node-local',
  connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
  connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
  proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
  acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Minimal in-memory observer connection expected by createObserverExtension. */
class FakeObserverConnection {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  readonly closeCalls: number[] = []
  private handler: ((frame: unknown) => void) | null = null
  private closeHandler: ((error?: unknown) => void) | null = null
  private messageCounter = 0
  private readonly pausedSends = new Map<string, Promise<void>>()
  private readonly sendReleases = new Map<string, () => void>()

  bind(handler: (frame: unknown) => void): void {
    this.handler = handler
  }

  async send(type: string, messageId: string, body: Record<string, unknown>): Promise<void> {
    const pause = this.pausedSends.get(type)
    if (pause !== undefined) {
      this.pausedSends.delete(type)
      await pause
    }
    this.sent.push({ type, messageId, body: clone(body) })
  }

  pauseNextSend(type: string): () => void {
    let release = () => {}
    this.pausedSends.set(type, new Promise<void>((resolve) => { release = resolve }))
    this.sendReleases.set(type, release)
    return () => {
      this.sendReleases.get(type)?.()
      this.sendReleases.delete(type)
    }
  }

  close(): void {
    this.closeCalls.push(this.closeCalls.length + 1)
  }

  onClose(handler: (error?: unknown) => void): () => void {
    this.closeHandler = handler
    return () => {
      if (this.closeHandler === handler) this.closeHandler = null
    }
  }

  disconnectFromRegistry(error: Error = new Error('fake registry disconnected')): void {
    this.closeHandler?.(error)
  }

  deliver(type: string, body: Record<string, unknown>): void {
    this.deliverRaw({
      protocol: 'omarchestra.observer/v1',
      type,
      messageId: `fake-registry-${++this.messageCounter}`,
      body: clone(body),
    })
  }

  deliverRaw(frame: unknown): void {
    this.handler?.(clone(frame))
  }

  last(type: string): { type: string; messageId: string; body: Record<string, unknown> } | undefined {
    return [...this.sent].reverse().find((frame) => frame.type === type)
  }
}

function registeredBody(overrides: Record<string, unknown> = {}) {
  return {
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    acceptedRegistrationAttempt: 1,
    acceptedSourceSequence: 1,
    heartbeatIntervalMs: 5000,
    leaseDurationMs: 15000,
    registryRevision: 1,
    piStatus: 'Unassigned · observed',
    ...overrides,
  }
}

function requestAckBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: IDS.proposalId,
    proposalDigest: PROPOSAL_DIGEST,
    acknowledgementNonce: IDS.acknowledgementNonce,
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 1,
    targetTeamGoalId: 'team-goal-local-1',
    targetRole: 'builder',
    acknowledgementRemainingMs: 5000,
    ...overrides,
  }
}

function committedBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: IDS.proposalId,
    proposalDigest: PROPOSAL_DIGEST,
    agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
    targetTeamGoalId: 'team-goal-local-1',
    targetRole: 'builder',
    controlMode: 'managed',
    piStatus: 'Builder · managed',
    terminalTitleMetadata: 'Omarchestra — Builder — managed',
    runtimeBindingGuarantee: 'unavailable',
    ...overrides,
  }
}

function rejectedBody(overrides: Record<string, unknown> = {}) {
  return {
    requestMessageId: 'message-0000000000000000000000000000000000000000000000000000000000000001',
    code: 'incompatible_extension',
    detail: 'bounded locally authored detail',
    ...overrides,
  }
}

async function createHarness(adapterModule: any, fakeHostModule: any, options: {
  mode?: string
  hasUI?: boolean
  connectError?: Error
  connectFailures?: number
  newConnectionOnReconnect?: boolean
  maxReconnectAttempts?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  managedBridgeError?: Error
} = {}) {
  const host = new fakeHostModule.FakePiHost({
    sessionId: IDS.piSessionId,
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    title: 'ordinary Pi title',
    statuses: {
      'unrelated-extension': 'keep me',
      'omarchestra-role-state': 'ordinary role slot',
    },
  })
  const connection = new FakeObserverConnection()
  const connections = [connection]
  const heartbeats: Array<{ callback: () => void; intervalMs: number; active: boolean }> = []
  const reconnects: Array<{
    callback: () => void
    delayMs: number
    active: boolean
    unrefCalls: number
  }> = []
  let connectCount = 0
  let extensionCounter = 0

  const extension = adapterModule.createObserverExtension({
    observerVersion: '0.1.0',
    processIncarnationId: IDS.processIncarnationId,
    processIncarnationIdFactory: () => IDS.processIncarnationId,
    extensionInstanceIdFactory: () => extensionCounter++ === 0
      ? IDS.extensionInstanceId
      : IDS.nextExtensionInstanceId,
    connect: (handler: (frame: unknown) => void) => {
      connectCount += 1
      if (options.connectError !== undefined) throw options.connectError
      if (options.connectFailures !== undefined && connectCount <= options.connectFailures) {
        throw new Error(`injected observer connect failure ${connectCount}`)
      }
      const selected = options.newConnectionOnReconnect && connectCount > 1
        ? new FakeObserverConnection()
        : connection
      if (!connections.includes(selected)) connections.push(selected)
      selected.bind(handler)
      return selected
    },
    ...(options.managedBridgeError === undefined ? {} : {
      managedBridge: {
        enable: () => { throw options.managedBridgeError },
        disable: () => {},
      },
    }),
    scheduleHeartbeat: (callback: () => void, intervalMs: number) => {
      const handle = { callback, intervalMs, active: true }
      heartbeats.push(handle)
      return handle
    },
    cancelHeartbeat: (handle: { active?: boolean }) => {
      handle.active = false
    },
    scheduleReconnect: (callback: () => void, delayMs: number) => {
      const handle = {
        callback,
        delayMs,
        active: true,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1
        },
      }
      reconnects.push(handle)
      return handle
    },
    cancelReconnect: (handle: { active?: boolean }) => {
      handle.active = false
    },
    ...(options.maxReconnectAttempts === undefined ? {} : {
      maxReconnectAttempts: options.maxReconnectAttempts,
    }),
    ...(options.reconnectInitialDelayMs === undefined ? {} : {
      reconnectInitialDelayMs: options.reconnectInitialDelayMs,
    }),
    ...(options.reconnectMaxDelayMs === undefined ? {} : {
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    }),
  })
  extension(host.api)

  return {
    host,
    connection,
    extension,
    connectCount: () => connectCount,
    connections: () => [...connections],
    reconnects: () => [...reconnects],
    activeHeartbeats: () => heartbeats.filter((heartbeat) => heartbeat.active),
    fireReconnect: async (index = 0) => {
      const handle = reconnects[index]
      assert.ok(handle, `missing reconnect handle ${index}`)
      if (!handle.active) return
      handle.active = false
      handle.callback()
      await flush()
    },
    fireHeartbeat: async () => {
      for (const heartbeat of heartbeats.filter((candidate) => candidate.active)) heartbeat.callback()
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function observerStatusKey(adapterModule: any): string {
  assert.equal(typeof adapterModule.OBSERVER_STATUS_KEY, 'string')
  return adapterModule.OBSERVER_STATUS_KEY
}

function registerFrame(connection: FakeObserverConnection) {
  const frame = connection.last('observer.register')
  assert.ok(frame, 'session_start must send observer.register')
  return frame
}

// ---------------------------------------------------------------------------
// Lifecycle, identity, fail-open behavior, and status-slot isolation
// ---------------------------------------------------------------------------

test('the adapter starts no resource in its factory and registers only at session_start', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  assert.equal(harness.connectCount(), 0)
  assert.equal(harness.host.title, 'ordinary Pi title')
  assert.equal(harness.host.status('unrelated-extension'), 'keep me')

  await harness.host.startSession({ reason: 'startup' })
  assert.equal(harness.connectCount(), 1)
  const register = registerFrame(harness.connection)
  assert.deepEqual(Object.keys(register.body).sort(), [
    'activity',
    'capabilities',
    'extensionInstanceId',
    'health',
    'hostMode',
    'hostPid',
    'lifecycle',
    'observerVersion',
    'piSessionId',
    'processIncarnationId',
    'registrationAttempt',
    'sourceSequence',
  ].sort())
  assert.equal(register.body.processIncarnationId, IDS.processIncarnationId)
  assert.equal(register.body.piSessionId, IDS.piSessionId)
  assert.equal(register.body.extensionInstanceId, IDS.extensionInstanceId)
  assert.equal(register.body.hostMode, 'tui')
  assert.deepEqual(register.body.capabilities, [
    'observe.lifecycle',
    'adoption.acknowledge',
    'managed.activate',
  ])
})

test('process and extension identities must represent at least 128-bit injected capabilities', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const host = new fakeHostModule.FakePiHost({ sessionId: IDS.piSessionId })
  let connectCount = 0
  const extension = adapterModule.createObserverExtension({
    processIncarnationId: 'short-process-id',
    extensionInstanceIdFactory: () => 'short-extension-id',
    connect: () => {
      connectCount += 1
      return new FakeObserverConnection()
    },
  })
  extension(host.api)

  await assert.doesNotReject(() => host.startSession({ reason: 'startup' }))
  assert.equal(connectCount, 0)
})

test('registration owns one status slot, displays Unassigned observed, and leaves the native title unchanged', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  assert.equal(harness.host.status(statusKey), undefined)
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()

  assert.equal(harness.host.status(statusKey), 'Unassigned · observed')
  assert.equal(harness.host.status('unrelated-extension'), 'keep me')
  assert.equal(harness.host.status('omarchestra-role-state'), 'ordinary role slot')
  assert.equal(harness.host.title, 'ordinary Pi title')
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.equal(harness.activeHeartbeats().length, 1)
  assert.equal(harness.activeHeartbeats()[0].intervalMs, 5000)
})

test('missing or incompatible registry fails open and leaves ordinary Pi use intact', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const unavailable = await createHarness(adapterModule, fakeHostModule, {
    connectError: new Error('observer registry unavailable'),
  })
  const statusKey = observerStatusKey(adapterModule)

  await assert.doesNotReject(() => unavailable.host.startSession({ reason: 'startup' }))
  assert.equal(unavailable.host.status(statusKey), undefined)
  assert.equal(unavailable.host.title, 'ordinary Pi title')
  assert.equal(unavailable.host.status('unrelated-extension'), 'keep me')
  assert.equal(await unavailable.host.submitInput('ordinary input remains local', 'interactive'), 'continue')

  const incompatible = await createHarness(adapterModule, fakeHostModule)
  await incompatible.host.startSession({ reason: 'startup' })
  incompatible.connection.deliver('observer.rejected', rejectedBody())
  await flush()
  assert.equal(incompatible.host.status(statusKey), undefined)
  assert.equal(incompatible.host.title, 'ordinary Pi title')
  assert.equal(incompatible.host.status('unrelated-extension'), 'keep me')
  assert.equal(await incompatible.host.submitInput('ordinary input remains local', 'interactive'), 'continue')
})

test('registry disconnect clears only observer resources and leaves ordinary Pi usable', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  assert.equal(harness.activeHeartbeats().length, 1)

  harness.connection.disconnectFromRegistry()
  await flush()
  assert.equal(harness.host.status(statusKey), undefined)
  assert.equal(harness.host.status('unrelated-extension'), 'keep me')
  assert.equal(harness.host.status('omarchestra-role-state'), 'ordinary role slot')
  assert.equal(harness.host.title, 'ordinary Pi title')
  assert.equal(harness.activeHeartbeats().length, 0)
  assert.equal(await harness.host.submitInput('ordinary input remains local'), 'continue')
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
})

test('disconnect reconnects with one session identity, a fresh transport, and increasing registration/source sequences', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    newConnectionOnReconnect: true,
    reconnectInitialDelayMs: 125,
    reconnectMaxDelayMs: 250,
  })

  await harness.host.startSession({ reason: 'startup' })
  const first = registerFrame(harness.connection)
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  await harness.host.startAgent()
  await harness.host.settleAgent()
  await flush()
  harness.connection.disconnectFromRegistry()
  await flush()

  assert.equal(harness.host.status(observerStatusKey(adapterModule)), undefined)
  assert.equal(harness.activeHeartbeats().length, 0)
  assert.equal(harness.reconnects().length, 1)
  assert.equal(harness.reconnects()[0].delayMs, 125)
  assert.equal(harness.reconnects()[0].unrefCalls, 1)

  await harness.fireReconnect(0)
  assert.equal(harness.connectCount(), 2)
  const secondConnection = harness.connections()[1]
  assert.ok(secondConnection)
  const second = registerFrame(secondConnection)
  assert.equal(second.body.registrationAttempt, 2)
  assert.equal(second.body.sourceSequence, 4)
  assert.equal(second.body.processIncarnationId, first.body.processIncarnationId)
  assert.equal(second.body.piSessionId, first.body.piSessionId)
  assert.equal(second.body.extensionInstanceId, first.body.extensionInstanceId)
  assert.deepEqual(harness.host.sessionEvents.map((entry: { event: string }) => entry.event), ['session_start'])

  secondConnection.deliver('observer.registered', registeredBody({
    connectionId: `${IDS.connectionId.slice(0, -1)}2`,
    connectionChallenge: `${IDS.connectionChallenge.slice(0, -1)}2`,
    acceptedRegistrationAttempt: 2,
    acceptedSourceSequence: 4,
    registryRevision: 2,
  }))
  await flush()
  assert.equal(harness.host.status(observerStatusKey(adapterModule)), 'Unassigned · observed')
  assert.equal(harness.host.title, 'ordinary Pi title')
  assert.equal(harness.host.titleWrites.length, 0)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
  assert.equal(harness.activeHeartbeats().length, 1)
})

test('failed connections use bounded unref reconnect backoff and resume at the next source sequence', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    connectFailures: 2,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 15,
    maxReconnectAttempts: 3,
  })

  await harness.host.startSession({ reason: 'startup' })
  assert.equal(harness.connectCount(), 1)
  assert.equal(harness.reconnects().length, 1)
  assert.equal(harness.reconnects()[0].delayMs, 10)
  assert.equal(harness.reconnects()[0].unrefCalls, 1)

  await harness.fireReconnect(0)
  assert.equal(harness.connectCount(), 2)
  assert.equal(harness.reconnects().length, 2)
  assert.equal(harness.reconnects()[1].delayMs, 15)
  assert.equal(harness.reconnects()[1].unrefCalls, 1)

  await harness.fireReconnect(1)
  assert.equal(harness.connectCount(), 3)
  const register = registerFrame(harness.connection)
  assert.equal(register.body.registrationAttempt, 3)
  assert.equal(register.body.sourceSequence, 3)
})

test('reconnect retries stop at the configured bound', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    connectError: new Error('observer registry unavailable'),
    maxReconnectAttempts: 2,
    reconnectInitialDelayMs: 1,
    reconnectMaxDelayMs: 1,
  })

  await harness.host.startSession({ reason: 'startup' })
  await harness.fireReconnect(0)
  await harness.fireReconnect(1)
  assert.equal(harness.connectCount(), 3)
  assert.equal(harness.reconnects().length, 2)
  assert.equal(harness.reconnects().filter((handle) => handle.active).length, 0)
})

test('transient registry rejection clears observation and schedules a fresh connection attempt', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    newConnectionOnReconnect: true,
  })

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('observer.rejected', rejectedBody({ code: 'session_limit' }))
  await flush()

  assert.equal(harness.host.status(observerStatusKey(adapterModule)), undefined)
  assert.equal(harness.reconnects().length, 1)
  await harness.fireReconnect(0)
  const secondConnection = harness.connections()[1]
  assert.ok(secondConnection)
  const register = registerFrame(secondConnection)
  assert.equal(register.body.registrationAttempt, 2)
  assert.equal(register.body.sourceSequence, 2)
})

test('permanent incompatibility clears observation and never schedules reconnect', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('observer.rejected', rejectedBody({ code: 'incompatible_extension' }))
  await flush()

  assert.equal(harness.host.status(statusKey), undefined)
  assert.equal(harness.activeHeartbeats().length, 0)
  assert.equal(harness.reconnects().length, 0)
})

test('session shutdown cancels a pending reconnect before it can create another connection', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    connectError: new Error('observer registry unavailable'),
  })

  await harness.host.startSession({ reason: 'startup' })
  assert.equal(harness.reconnects().length, 1)
  await harness.host.shutdownSession({ reason: 'quit' })
  assert.equal(harness.reconnects()[0].active, false)
  await harness.fireReconnect(0)
  assert.equal(harness.connectCount(), 1)
})

test('non-TUI or UI-less sessions do not register as ordinary observed sessions', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const rpc = await createHarness(adapterModule, fakeHostModule, { mode: 'rpc' })
  await rpc.host.startSession({ reason: 'startup' })
  assert.equal(rpc.connectCount(), 0)
  assert.equal(rpc.connection.sent.length, 0)

  const noUi = await createHarness(adapterModule, fakeHostModule, { hasUI: false })
  await noUi.host.startSession({ reason: 'startup' })
  assert.equal(noUi.connectCount(), 0)
  assert.equal(noUi.connection.sent.length, 0)
})

test('registry frames require the exact protocol envelope and fixed lease timing', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const statusKey = observerStatusKey(adapterModule)

  const missingProtocol = await createHarness(adapterModule, fakeHostModule)
  await missingProtocol.host.startSession({ reason: 'startup' })
  missingProtocol.connection.deliverRaw({
    type: 'observer.registered',
    messageId: 'fake-registry-1',
    body: registeredBody(),
  })
  await flush()
  assert.equal(missingProtocol.host.status(statusKey), undefined)
  assert.equal(missingProtocol.connection.closeCalls.length, 1)

  const extraField = await createHarness(adapterModule, fakeHostModule)
  await extraField.host.startSession({ reason: 'startup' })
  extraField.connection.deliverRaw({
    protocol: 'omarchestra.observer/v1',
    type: 'observer.registered',
    messageId: 'fake-registry-1',
    body: registeredBody(),
    extra: true,
  })
  await flush()
  assert.equal(extraField.host.status(statusKey), undefined)
  assert.equal(extraField.connection.closeCalls.length, 1)

  const invalidTiming = await createHarness(adapterModule, fakeHostModule)
  await invalidTiming.host.startSession({ reason: 'startup' })
  invalidTiming.connection.deliver('observer.registered', registeredBody({ heartbeatIntervalMs: 1 }))
  await flush()
  assert.equal(invalidTiming.host.status(statusKey), undefined)
  assert.equal(invalidTiming.activeHeartbeats().length, 0)
})

test('concurrent public lifecycle callbacks preserve source-sequence send order', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()

  const release = harness.connection.pauseNextSend('observer.lifecycle')
  const started = harness.host.startAgent()
  await flush()
  const settled = harness.host.settleAgent()
  await flush()
  assert.equal(
    harness.connection.sent.filter((frame) => frame.type === 'observer.lifecycle').length,
    0,
    'a later lifecycle frame cannot overtake a blocked earlier frame',
  )

  release()
  await Promise.all([started, settled])
  assert.deepEqual(
    harness.connection.sent
      .filter((frame) => frame.type === 'observer.lifecycle')
      .map((frame) => frame.body.sourceSequence),
    [2, 3],
  )
})

test('session_shutdown sends close, clears only the observer slot, and is idempotent', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  await harness.host.shutdownSession({ reason: 'quit' })
  await harness.host.shutdownSession({ reason: 'quit' })

  assert.equal(harness.connection.closeCalls.length, 1)
  assert.ok(harness.connection.last('observer.close'), 'shutdown must send observer.close')
  assert.equal(harness.host.status(statusKey), undefined)
  assert.equal(harness.host.status('unrelated-extension'), 'keep me')
  assert.equal(harness.host.status('omarchestra-role-state'), 'ordinary role slot')
  assert.equal(harness.activeHeartbeats().length, 0)
})

test('a new Pi session gets a fresh extension identity and never inherits the old registration', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  const first = registerFrame(harness.connection)
  await harness.host.shutdownSession({ reason: 'new' })
  harness.host.setSessionId('pi-session-0000000000000000000000000000000000000000000000000000000000000002')
  await harness.host.startSession({ reason: 'new' })
  const second = registerFrame(harness.connection)

  assert.notEqual(second.body.extensionInstanceId, first.body.extensionInstanceId)
  assert.notEqual(second.body.piSessionId, first.body.piSessionId)
  assert.equal(second.body.registrationAttempt > Number(first.body.registrationAttempt), true)
})

// ---------------------------------------------------------------------------
// Same-process acknowledgement and pre-commit authority gate
// ---------------------------------------------------------------------------

test('only the current idle same-process extension acknowledges the exact proposal', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody())
  await flush()

  const ack = harness.connection.last('adoption.ack')
  assert.ok(ack, 'the current observer connection must receive an acknowledgement request')
  assert.equal(ack.body.processIncarnationId, IDS.processIncarnationId)
  assert.equal(ack.body.piSessionId, IDS.piSessionId)
  assert.equal(ack.body.extensionInstanceId, IDS.extensionInstanceId)
  assert.equal(ack.body.connectionId, IDS.connectionId)
  assert.equal(ack.body.connectionChallenge, IDS.connectionChallenge)
  assert.equal(ack.body.proposalId, IDS.proposalId)
  assert.equal(ack.body.proposalDigest, PROPOSAL_DIGEST)
  assert.equal(ack.body.decision, 'acknowledged')
  assert.equal(ack.body.refusalCode, null)
  assert.equal(ack.body.activity, 'idle')
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
})

test('busy and unknown activity refuse acknowledgement without changing status or enabling management', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()

  harness.host.setActivity('busy')
  harness.connection.deliver('adoption.request_ack', requestAckBody({ proposalId: `${IDS.proposalId}-busy` }))
  await flush()
  const busyAck = harness.connection.last('adoption.ack')
  assert.ok(busyAck)
  assert.equal(busyAck.body.decision, 'refused')
  assert.equal(busyAck.body.refusalCode, 'session_busy')

  harness.host.setActivity('unknown')
  harness.connection.deliver('adoption.request_ack', requestAckBody({ proposalId: `${IDS.proposalId}-unknown` }))
  await flush()
  const unknownAck = harness.connection.last('adoption.ack')
  assert.ok(unknownAck)
  assert.equal(unknownAck.body.decision, 'refused')
  assert.notEqual(unknownAck.body.refusalCode, null)
  assert.equal(harness.host.status(statusKey), 'Unassigned · observed')
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
})

test('registry revision drift is refused by the exact current observer extension', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody({ registryRevision: 7 }))
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody({ registryRevision: 8 }))
  await flush()

  const ack = harness.connection.last('adoption.ack')
  assert.ok(ack)
  assert.equal(ack.body.decision, 'refused')
  assert.equal(ack.body.refusalCode, 'identity_drift')
  assert.equal(harness.host.managedBridgeEnabled, false)
})

test('identity drift or a mismatched proposal is refused from the observer process', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody({
    processIncarnationId: 'proc-incarnation-drift-0000000000000000000000000000000000000000000000000000000000000002',
  }))
  await flush()

  const ack = harness.connection.last('adoption.ack')
  assert.ok(ack)
  assert.equal(ack.body.decision, 'refused')
  assert.match(String(ack.body.refusalCode), /identity|proposal|stale|mismatch/i)
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.deepEqual(harness.host.sentUserMessages, [])
})

test('a committed frame cannot grant management without the exact prior same-process acknowledgement', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const statusKey = observerStatusKey(adapterModule)

  const noAck = await createHarness(adapterModule, fakeHostModule)
  await noAck.host.startSession({ reason: 'startup' })
  noAck.connection.deliver('observer.registered', registeredBody())
  await flush()
  noAck.connection.deliver('adoption.committed', committedBody())
  await flush()
  assert.notEqual(noAck.host.status(statusKey), 'Builder · managed')
  assert.equal(noAck.host.title, 'ordinary Pi title')
  assert.equal(noAck.host.managedBridgeEnabled, false)

  const mismatch = await createHarness(adapterModule, fakeHostModule)
  await mismatch.host.startSession({ reason: 'startup' })
  mismatch.connection.deliver('observer.registered', registeredBody())
  await flush()
  mismatch.connection.deliver('adoption.request_ack', requestAckBody())
  await flush()
  mismatch.connection.deliver('adoption.committed', committedBody({ proposalDigest: 'b'.repeat(64) }))
  await flush()
  assert.notEqual(mismatch.host.status(statusKey), 'Builder · managed')
  assert.equal(mismatch.host.title, 'ordinary Pi title')
  assert.equal(mismatch.host.managedBridgeEnabled, false)
})

test('committed presentation switches the same status slot only after adoption commit', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody())
  await flush()
  assert.equal(harness.host.status(statusKey), 'Unassigned · observed')
  assert.equal(harness.host.title, 'ordinary Pi title')
  assert.equal(harness.host.managedBridgeEnabled, false)

  harness.connection.deliver('adoption.committed', committedBody())
  await flush()
  assert.equal(harness.host.status(statusKey), 'Builder · managed')
  assert.equal(harness.host.title, 'Omarchestra — Builder — managed')
  assert.equal(harness.host.managedBridgeEnabled, true)
  assert.equal(harness.host.status('unrelated-extension'), 'keep me')
  assert.equal(harness.activeHeartbeats().length, 0)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
})

test('postcommit bridge delivery failure never recreates observation or resumes observer telemetry', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule, {
    managedBridgeError: new Error('injected managed bridge delivery failure'),
  })
  const statusKey = observerStatusKey(adapterModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody())
  await flush()
  const lifecycleBeforeCommit = harness.connection.sent.filter((frame) => frame.type === 'observer.lifecycle').length

  harness.connection.deliver('adoption.committed', committedBody())
  await flush()
  assert.equal(harness.host.status(statusKey), 'Builder · managed')
  assert.equal(harness.host.title, 'Omarchestra — Builder — managed')
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.equal(harness.activeHeartbeats().length, 0)

  await harness.host.startAgent()
  await harness.host.settleAgent()
  assert.equal(
    harness.connection.sent.filter((frame) => frame.type === 'observer.lifecycle').length,
    lifecycleBeforeCommit,
  )
})

test('interactive input remains ordinary and no input text or length crosses the observer seam', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  const result = await harness.host.submitInput('secret conversation text', 'interactive')
  await flush()

  assert.equal(result, 'continue')
  const serialized = JSON.stringify(harness.connection.sent)
  assert.doesNotMatch(serialized, /secret conversation text/)
  assert.doesNotMatch(serialized, /charCount|inputText|editorText|prompt|response/i)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
})

test('the adapter uses only documented non-content lifecycle hooks and has no execution authority', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  assert.deepEqual(harness.host.registeredEvents(), [
    'agent_settled',
    'agent_start',
    'session_shutdown',
    'session_start',
    'ui_prompt_end',
    'ui_prompt_start',
  ])

  const adapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension-adapter.ts')
  const source = readFileSync(adapterPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.doesNotMatch(source, /node:child_process|createAgentSession|registerTool|sendUserMessage|sendMessage|appendEntry|pi\.exec|ctx\.shutdown/)
  assert.doesNotMatch(source, /\.on\(\s*['"](?:input|message_start|message_update|message_end|tool_call|tool_result|user_bash|context|before_agent_start)['"]/)
  assert.doesNotMatch(source, /setEditorText|pasteToEditor|getEditorText|terminalOutput|toolArguments|toolResults/)
  assert.deepEqual(harness.host.sentUserMessages, [])
  assert.deepEqual(harness.host.processActions, [])
  assert.equal(harness.host.hiddenAgentCount, 0)
  assert.equal(harness.host.terminalActionCount, 0)
  assert.equal(harness.host.ptyActionCount, 0)
})

test('managed bridge activation is impossible before committed and carries no fabricated Runtime Binding', async () => {
  const adapterModule = await loadAdapter()
  const fakeHostModule = await loadFakeHost()
  const harness = await createHarness(adapterModule, fakeHostModule)

  await harness.host.startSession({ reason: 'startup' })
  harness.connection.deliver('observer.registered', registeredBody())
  await flush()
  harness.connection.deliver('adoption.request_ack', requestAckBody())
  await flush()
  assert.equal(harness.host.managedBridgeEnabled, false)
  assert.deepEqual(harness.host.sentUserMessages, [])

  harness.connection.deliver('adoption.committed', committedBody())
  await flush()
  assert.equal(harness.host.managedBridgeEnabled, true)
  assert.equal(harness.host.lastCommitted?.runtimeBinding, undefined)
  assert.equal(harness.host.lastCommitted?.runtimeBindingGuarantee, 'unavailable')
  assert.notEqual(harness.host.lastCommitted?.runtimeBindingGuarantee, 'guaranteed')
})
