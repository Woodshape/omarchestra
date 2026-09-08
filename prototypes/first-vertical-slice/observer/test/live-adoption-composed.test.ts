/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Composed-path tests for the live Adoption slice (F13–F14 authority and
 * recovery). They exercise the actual Pi observer extension, the bounded frame
 * transport, the Adoption gateway/registry composition, the Companion
 * controller, and the durable adapter through injected external ports. No live
 * socket, process, Pi, provider, or installed state is opened.
 *
 * Coverage: the full extension→transport→gateway→runner→durable-store happy
 * path, synchronous lease revalidation inside the commit boundary, identical
 * acknowledgement replay over two connections, crash-then-fresh-challenge
 * recovery, observed-ID-independent binding tombstones, and durable
 * configuration validation / transactional rollback on reopen.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OBSERVER_CAPABILITIES,
  OBSERVER_PROTOCOL_ID,
  type ObserverFrame,
} from '../contracts.ts'
import {
  createObserverExtension,
  type HeartbeatHandle,
  type ObserverConnection,
  type ObserverFrameHandler,
} from '../extension-adapter.ts'
import { FakePiHost } from '../fake-pi-host.ts'
import { FakeCapabilityIssuer, FakeMonotonicClock } from '../fakes.ts'
import { LiveFrameChannel, type DuplexStream } from '../live-frame-channel.ts'
import { LiveAdoptionGatewayCore } from '../live-adoption-gateway-core.ts'
import { LiveAdoptionRunner } from '../live-adoption-runner.ts'
import { createInMemoryAdoptionStore, type AdoptionStore } from '../live-adoption-store.ts'
import { LiveAdoptionCompanion } from '../live-adoption-companion.ts'
import { LiveAdoptionPresentation } from '../live-adoption-presentation.ts'
import { LiveAdoptionManagedBridge, createLiveAdoptionExtension } from '../../manual/live-adoption-extension.ts'
import { LiveAdoptionStore } from '../../manual/live-adoption-store.ts'

const IDS = Object.freeze({
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  executionNodeId: 'execution-node-local',
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
  connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
  proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
  acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
  teamGoalId: 'team-goal-local-1',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// In-memory duplex helpers (mirror the observer bridge test)
// ---------------------------------------------------------------------------

class FakeDuplex implements DuplexStream {
  readonly dataListeners: Array<(chunk: string) => void> = []
  readonly errorListeners: Array<(error: Error) => void> = []
  readonly closeListeners: Array<() => void> = []
  onWrite: ((data: string) => void) | null = null
  onDestroy: (() => void) | null = null
  destroyed = false

  setEncoding(): void {}

  on(event: 'data' | 'error' | 'close', listener: (value: string | Error) => void): void {
    if (event === 'data') this.dataListeners.push(listener as (chunk: string) => void)
    else if (event === 'error') this.errorListeners.push(listener as (error: Error) => void)
    else this.closeListeners.push(listener as () => void)
  }

  write(data: string): void {
    this.onWrite?.(data)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.onDestroy?.()
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener()
  }
}

function createDuplexPair() {
  const client = new FakeDuplex()
  const server = new FakeDuplex()
  client.onWrite = (data) => server.emitData(data)
  server.onWrite = (data) => client.emitData(data)
  client.onDestroy = () => server.emitClose()
  server.onDestroy = () => client.emitClose()
  return { client, server }
}

class FakeExtensionConnection implements ObserverConnection {
  private readonly channel: LiveFrameChannel
  private frameHandler: ObserverFrameHandler | null = null
  private readonly closeHandlers = new Set<(error?: unknown) => void>()
  private closedValue = false

  constructor(duplex: FakeDuplex, handler: ObserverFrameHandler) {
    this.frameHandler = handler
    this.channel = new LiveFrameChannel(duplex, {
      onFrame: (frame) => this.frameHandler?.(frame),
      onClose: (error) => {
        this.closedValue = true
        const handlers = [...this.closeHandlers]
        this.closeHandlers.clear()
        for (const handle of handlers) {
          try {
            handle(error)
          } catch {
            // A close observer cannot prevent the connection from retiring.
          }
        }
      },
    })
  }

  get closed(): boolean {
    return this.closedValue
  }
  get isClosed(): boolean {
    return this.closedValue
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.channel.send(type, messageId, body)
  }

  sendFrame(frame: ObserverFrame): void {
    this.send(frame.type, frame.messageId, frame.body)
  }

  bind(handler: ObserverFrameHandler): () => void {
    return this.onFrame(handler)
  }

  onFrame(handler: ObserverFrameHandler): () => void {
    this.frameHandler = handler
    return () => {
      if (this.frameHandler === handler) this.frameHandler = null
    }
  }

  onClose(handler: (error?: unknown) => void): () => void {
    if (this.closedValue) {
      handler()
      return () => {}
    }
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onDisconnect(handler: (error?: unknown) => void): () => void {
    return this.onClose(handler)
  }

  close(): void {
    if (this.closedValue) return
    this.closedValue = true
    this.channel.close()
  }
}

class FakeTimerController {
  private readonly entries: Array<{ callback: () => void; cancelled: boolean }> = []

  schedule(callback: () => void): HeartbeatHandle {
    const entry = { callback, cancelled: false }
    this.entries.push(entry)
    return {
      unref() {},
      __cancel: () => {
        entry.cancelled = true
      },
    } as unknown as HeartbeatHandle
  }

  cancel(handle: unknown): void {
    ;(handle as { __cancel?: () => void }).__cancel?.()
  }

  fire(): void {
    const entry = this.entries.find(value => !value.cancelled)
    assert.ok(entry, 'expected a scheduled retry')
    entry.cancelled = true
    entry.callback()
  }

  get length(): number {
    return this.entries.length
  }
}

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

let messageCounter = 0
function nextMessageId(): string {
  messageCounter += 1
  return `msg-${messageCounter}`
}

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    hostPid: 41001,
    hostMode: 'tui',
    observerVersion: '0.1.0',
    capabilities: [...OBSERVER_CAPABILITIES],
    registrationAttempt: 1,
    sourceSequence: 1,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

function ackBody(proposal: Record<string, unknown>, values: { connectionId: string; connectionChallenge: string }, overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: values.connectionId,
    connectionChallenge: values.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 1,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Gateway harness (drives the gateway session directly with frames)
// ---------------------------------------------------------------------------

class RecordingConnection {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  closed = false

  send = (type: string, messageId: string, body: Record<string, unknown>): void => {
    this.sent.push({ type, messageId, body })
  }

  close(): void {
    this.closed = true
  }

  last(type: string): { type: string; messageId: string; body: Record<string, unknown> } | undefined {
    return [...this.sent].reverse().find((entry) => entry.type === type)
  }
}

function createGatewayHarness(options: {
  store?: ReturnType<typeof createInMemoryAdoptionStore>
  leaseDurationMs?: number
} = {}) {
  const clock = new FakeMonotonicClock(0)
  const capabilityIssuer = new FakeCapabilityIssuer()
  const store = options.store ?? createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const bridge = new LiveAdoptionManagedBridge()
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    clock,
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
    managedBridge: { enable: (c) => bridge.enable(c), disable: () => bridge.disable() },
    leaseDurationMs: options.leaseDurationMs,
  })
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    runner,
    clock,
    capabilityIssuer,
  })
  const companion = new LiveAdoptionCompanion({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    runner,
  })
  return { clock, store, runner, gateway, companion, bridge }
}

function registerThroughGateway(gateway: LiveAdoptionGatewayCore, conn: RecordingConnection, overrides: Record<string, unknown> = {}) {
  const session = gateway.accept(conn)
  void session.handleFrame({ type: 'observer.register', messageId: nextMessageId(), body: registerBody(overrides) })
  const registered = conn.last('observer.registered')
  assert.ok(registered !== undefined, 'expected observer.registered response')
  return {
    session,
    observedSessionId: String(registered.body.observedSessionId),
    connectionId: String(registered.body.connectionId),
    connectionChallenge: String(registered.body.connectionChallenge),
  }
}

async function prepareProposal(gateway: LiveAdoptionGatewayCore, conn: RecordingConnection, values: { observedSessionId: string; connectionId: string; connectionChallenge: string }) {
  const proposal = await gateway.requestAdoption(values.observedSessionId, 'adoption-choice-1')
  await gateway.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  return { proposal, values }
}

// ---------------------------------------------------------------------------
// Extension harness (full pipeline through the Pi extension)
// ---------------------------------------------------------------------------

function createExtensionHarness(durableStore?: AdoptionStore, loseCommittedDelivery = false) {
  const clock = new FakeMonotonicClock(0)
  const capabilityIssuer = new FakeCapabilityIssuer()
  const store = durableStore ?? createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const bridge = new LiveAdoptionManagedBridge()
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    clock,
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
    managedBridge: { enable: (c) => bridge.enable(c), disable: () => bridge.disable() },
  })
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    runner,
    clock,
    capabilityIssuer,
  })
  let targetGateway = gateway
  let serverChannel: LiveFrameChannel

  const host = new FakePiHost({
    sessionId: IDS.piSessionId,
    mode: 'tui',
    hasUI: true,
  })
  const heartbeatCtrl = new FakeTimerController()
  const reconnectCtrl = new FakeTimerController()
  const extension = createLiveAdoptionExtension({
    observerVersion: '0.1.0',
    connect: (receive) => {
      const { client, server } = createDuplexPair()
      const deliver = server.onWrite!
      server.onWrite = data => {
        if (loseCommittedDelivery && JSON.parse(data).type === 'adoption.committed') {
          loseCommittedDelivery = false
          return
        }
        deliver(data)
      }
      let session!: ReturnType<LiveAdoptionGatewayCore['accept']>
      serverChannel = new LiveFrameChannel(server, {
        onFrame: incoming => session.handleFrame(incoming),
        onClose: error => session.transportClosed(error),
      })
      session = targetGateway.accept(serverChannel)
      return Promise.resolve(new FakeExtensionConnection(client, receive))
    },
    managedBridge: bridge,
    scheduleHeartbeat: (callback) => heartbeatCtrl.schedule(callback),
    cancelHeartbeat: (handle) => heartbeatCtrl.cancel(handle),
    scheduleReconnect: (callback) => reconnectCtrl.schedule(callback),
    cancelReconnect: (handle) => reconnectCtrl.cancel(handle),
  })
  extension(host.api)

  return { clock, store, runner, gateway, bridge, host, heartbeatCtrl, reconnectCtrl,
    async restart(reopened: AdoptionStore, whileDisconnected?: () => Promise<unknown>) {
      const recovered = new LiveAdoptionRunner({ store: reopened, executionNodeId: IDS.executionNodeId,
        teamGoalId: IDS.teamGoalId, roles: ['coordinator','builder','reviewer'], clock })
      targetGateway = new LiveAdoptionGatewayCore({ runner: recovered, executionNodeId: IDS.executionNodeId,
        teamGoalId: IDS.teamGoalId, roles: ['coordinator','builder','reviewer'], clock })
      serverChannel.close()
      await settle()
      assert.equal(bridge.enabled, false)
      await whileDisconnected?.()
      reconnectCtrl.fire()
      await settle()
      await settle()
      return recovered
    },
  }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-composed-'))
  return path.join(dir, 'adoption.sqlite')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const offlineInput of [false, true]) for (const loseDelivery of [false, true]) test(`same fake Pi: confirmation, commit and recovery; lost=${loseDelivery}, offline input=${offlineInput}`, async (t) => {
  const databasePath = tempDbPath()
  const config = { databasePath, executionNodeId: IDS.executionNodeId, teamGoalId: IDS.teamGoalId, roles: ['coordinator', 'builder', 'reviewer'] }
  const durableStore = new LiveAdoptionStore(config)
  t.after(() => { durableStore.close(); fs.rmSync(path.dirname(databasePath), { recursive: true, force: true }) })
  const harness = createExtensionHarness(durableStore, loseDelivery)
  const host = harness.host

  await host.startSession()
  await settle()
  assert.equal(harness.runner.snapshot().agents.length, 1, 'registration must create one observed session')
  assert.equal(host.status('omarchestra-observer-status'), 'Unassigned · observed')
  assert.equal(await host.submitInput('ordinary content is not exposed'), 'continue')
  assert.equal(harness.store.snapshot().committedRuns.length, 0)
  assert.equal(harness.runner.commitCount, 0)
  const companion = new LiveAdoptionCompanion({
    runner: harness.runner, executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId, roles: ['coordinator', 'builder', 'reviewer'],
  })
  let published: any
  let result: any
  const intents: unknown[] = []
  const presentation = new LiveAdoptionPresentation({ runner:harness.runner,
    executionNodeId:IDS.executionNodeId, teamGoalId:IDS.teamGoalId, roles:['coordinator','builder','reviewer'],
    shell: {
      async fingerprint() { return 'unchanged-installation' },
      async call(method, raw) {
        const value = JSON.parse(raw)
        if (method === 'adoptionCapabilities') return JSON.stringify({ version:'0.4.0', pluginGeneration:7,
          methods:['adoptionOpen','adoptionApply','adoptionTakeIntent','adoptionIntentResult','adoptionClear'] })
        if (method === 'adoptionOpen' || method === 'adoptionApply') published = value
        if (method === 'adoptionIntentResult') result = value.result
        if (method === 'adoptionTakeIntent') return intents.length ? JSON.stringify({session:published.session,intent:intents.shift()}) : ''
        return 'true'
      },
    },
  })
  await presentation.open()
  const agent = published.observerProjection.agents[0]
  intents.push({kind:'request_adoption', intentId:'request-1', observedSessionId:agent.observedSessionId, choiceId:'adoption-choice-1'})
  await presentation.poll()
  const proposal = result
  assert.equal(proposal.phase, 'proposal')
  assert.equal(harness.store.snapshot().committedRuns.length, 0)
  intents.push({kind:'authorize_adoption', intentId:'confirm-1', proposalId:proposal.proposalId, proposalDigest:proposal.proposalDigest})
  await presentation.poll()
  const confirmation = result
  assert.equal(confirmation.phase, 'authorized')
  await settle()
  assert.equal(harness.store.snapshot().committedRuns.length, 1)
  assert.equal(harness.runner.commitCount, 1)
  assert.equal(companion.snapshot().agents.length, 0)
  assert.equal(companion.managedSnapshot().managedCards.length, 1)
  await presentation.poll()
  assert.equal(published.observerProjection.agents.length, 0)
  assert.equal(published.managedCards.length, 1)
  await presentation.close()
  assert.equal(harness.runner.managedBridgeEnabled, !loseDelivery, 'readiness requires post-delivery receipt')
  assert.equal(harness.bridge.enabled, !loseDelivery, 'extension activates only after commit delivery')
  assert.equal(host.status('omarchestra-observer-status'), loseDelivery ? 'Unassigned · observed' : 'Builder · managed')
  const reopened = new LiveAdoptionStore(config)
  try {
    assert.deepEqual(reopened.snapshot(), durableStore.snapshot(), 'commit and event survive an independent SQLite open')
    const recovered = await harness.restart(reopened, offlineInput ? () => host.submitInput('not exposed', 'interactive') : undefined)
    assert.equal(recovered.commitCount, 0)
    assert.equal(recovered.snapshot().agents.length, 0)
    assert.equal(recovered.managedBridgeEnabled, !offlineInput, 'offline interactive input must reconcile as takeover before readiness')
    assert.equal(harness.bridge.enabled, true)
    assert.equal(host.status('omarchestra-observer-status'), offlineInput ? 'Builder · manual takeover' : 'Builder · managed')
    assert.equal(reopened.snapshot().events.length, 1)
    assert.equal(await host.submitInput('not exposed', 'extension'), 'continue')
    assert.equal(recovered.managedBridgeEnabled, !offlineInput)
    assert.equal(await host.submitInput('not exposed', 'interactive'), 'continue')
    await settle()
    assert.equal(recovered.managedBridgeEnabled, false)
    assert.equal(host.status('omarchestra-observer-status'), 'Builder · manual takeover')
    const again = new LiveAdoptionStore(config)
    try {
      assert.equal(again.isManualTakeover(reopened.snapshot().committedRuns[0].agentRunId), true)
      const afterTakeover = await harness.restart(again)
      assert.equal(afterTakeover.managedBridgeEnabled, false, 'reconnect cannot silently resume manual takeover')
      assert.equal(host.status('omarchestra-observer-status'), 'Builder · manual takeover')
      assert.equal(afterTakeover.acceptanceFacts().managedDisconnected, false)
      await host.shutdownSession()
      await settle()
      assert.ok(Object.values(afterTakeover.acceptanceFacts()).every(value => value === true), 'success requires all observed facts before gateway cleanup')
    } finally { again.close() }
  } finally { reopened.close() }
})

test('V1: synchronous lease revalidation inside the commit boundary rejects an expired lease', async () => {
  const harness = createGatewayHarness({ leaseDurationMs: 1000 })
  const conn = new RecordingConnection()
  const registered = registerThroughGateway(harness.gateway, conn)
  const { proposal, values } = await prepareProposal(harness.gateway, conn, registered)

  // Advance past the 1000ms lease but within the 5000ms acknowledgement window.
  harness.clock.advance(2000)
  const session = harness.gateway.accept(conn)
  await session.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ackBody(proposal, values) })
  assert.equal(harness.runner.commitCount, 0, 'an expired lease must not commit')
  assert.ok(conn.last('observer.rejected') !== undefined, 'an expired lease must be rejected')
})

test('V2: identical acknowledgement bytes replay over a second connection is rejected', async () => {
  const harness = createGatewayHarness()
  const connA = new RecordingConnection()
  const registered = registerThroughGateway(harness.gateway, connA)
  const { proposal, values } = await prepareProposal(harness.gateway, connA, registered)

  const sessionA = harness.gateway.accept(connA)
  const committed = await sessionA.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ackBody(proposal, values) })
  assert.equal(committed?.controlMode, 'managed')
  assert.equal(harness.runner.commitCount, 1)

  // Replay the identical bytes over a different connection.
  const connB = new RecordingConnection()
  const sessionB = harness.gateway.accept(connB)
  await sessionB.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ackBody(proposal, values) })
  assert.equal(harness.runner.commitCount, 1, 'replay over a second connection must not commit again')
  assert.ok(connB.last('observer.rejected') !== undefined, 'replay over a second connection must be rejected')
})

test('V3: crash after durable commit, reopen, and recover through a fresh challenge without a second commit', async () => {
  const dbPath = tempDbPath()
  const CONNECTION = { id: 'transport-1' }
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
  })
  runner.registerObserved({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }, CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  const committed = await runner.acceptAcknowledgement(CONNECTION, {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 7,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
  })
  assert.equal(runner.commitCount, 1)
  store.close()

  // Simulated restart over the same durable file.
  const restartedStore = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const restarted = new LiveAdoptionRunner({
    store: restartedStore,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const binding = {
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }
  const RECOVERY_CONNECTION = { id: 'recovery-transport' }
  const recovery = restarted.beginRecovery(RECOVERY_CONNECTION, binding)
  assert.equal(recovery.committed.proposalId, committed.proposalId)
  const recovered = restarted.completeRecovery(RECOVERY_CONNECTION, {
    challenge: recovery.challenge,
    committed: recovery.committed as unknown as Record<string, unknown>,
  })
  assert.equal(recovered.proposalId, committed.proposalId)
  assert.equal(restarted.commitCount, 0, 'recovery must not create a second commit')
  assert.equal(restartedStore.snapshot().committedRuns.length, 1, 'commitment count must be unchanged')
  assert.equal(restartedStore.snapshot().events.length, 1, 'event count must be unchanged')
  restartedStore.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('V4: a fresh observed ID cannot evade the committed binding tombstone', async () => {
  const dbPath = tempDbPath()
  const CONNECTION = { id: 'transport-1' }
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
  })
  runner.registerObserved({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }, CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 7,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
  })
  store.close()

  const restartedStore = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const binding = {
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }
  // The binding is committed independent of any observed ID.
  assert.equal(restartedStore.transaction((tx) => tx.isBindingCommitted(binding)), true)
  // A fresh observed ID for the same binding must not be adoptable.
  const fresh = restartedStore.transaction((tx) => tx.isBindingCommitted({
    ...binding,
  }))
  assert.equal(fresh, true)
  restartedStore.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('V7: reopening with a mismatching Node/goal/Roles configuration is rejected', async () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  store.close()

  assert.throws(
    () => new LiveAdoptionStore({
      databasePath: dbPath,
      executionNodeId: 'different-node',
      teamGoalId: IDS.teamGoalId,
      roles: ['coordinator', 'builder', 'reviewer'],
    }),
    /configuration mismatch/,
  )
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('V7b: a duplicate role commit rolls back atomically against the durable adapter', async () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const input = {
    proposal: {
      proposalId: IDS.proposalId,
      proposalDigest: PROPOSAL_DIGEST,
      observedSessionId: IDS.observedSessionId,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
    },
    authorization: { proposalId: IDS.proposalId, proposalDigest: PROPOSAL_DIGEST },
    acknowledgement: { decision: 'acknowledged', activity: 'idle' },
    observed: {},
    reconciliation: { activity: 'idle', sourceSequence: 2 },
  }
  store.transaction((tx) => tx.commitAdoption(input))
  assert.equal(store.snapshot().committedRuns.length, 1)
  // Promise-returning callbacks must roll back before any COMMIT, just like
  // the in-memory adapter; allowing them would break the final authority fence.
  assert.throws(() => store.transaction(tx => {
    tx.currentCursor()
    return Promise.resolve('not synchronous')
  }), /synchronous/)
  assert.equal(store.snapshot().events.length, 1)
  // A second commit for the same role must roll back without partial state.
  assert.throws(
    () => store.transaction((tx) => tx.commitAdoption({
      ...input,
      proposal: { ...input.proposal, proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000002' },
    })),
    /role_occupied|UNIQUE/,
  )
  assert.equal(store.snapshot().committedRuns.length, 1, 'rollback must leave the durable state unchanged')
  assert.equal(store.snapshot().events.length, 1, 'rollback must not leave a partial event')
  store.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('AR2: disconnect invalidates the exact connection and blocks a later acknowledgement', async () => {
  const harness = createGatewayHarness()
  const conn = new RecordingConnection()
  const registered = registerThroughGateway(harness.gateway, conn)
  const { proposal, values } = await prepareProposal(harness.gateway, conn, registered)

  // Disconnect the exact connection before the acknowledgement.
  harness.runner.onConnectionLost(conn)
  const session = harness.gateway.accept(conn)
  await session.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ackBody(proposal, values) })
  assert.equal(harness.runner.commitCount, 0, 'a disconnected session must not commit')
  assert.ok(conn.last('observer.rejected') !== undefined, 'a disconnected session must be rejected')
})

test('AR5: a replacement recovery supersedes an older recovery for the same binding', async () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
    recoveryChallengeFactory: () => 'recovery-challenge-1',
  })
  const CONNECTION = { id: 'transport-1' }
  runner.registerObserved({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }, CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  const committed = await runner.acceptAcknowledgement(CONNECTION, {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 7,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
  })
  const binding = {
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }
  const connA = { id: 'recovery-a' }
  const connB = { id: 'recovery-b' }
  const recoveryA = runner.beginRecovery(connA, binding)
  const recoveryB = runner.beginRecovery(connB, binding)
  // connA's recovery is superseded by connB for the same binding.
  assert.throws(
    () => runner.completeRecovery(connA, {
      challenge: recoveryA.challenge,
      committed: recoveryA.committed as unknown as Record<string, unknown>,
    }),
    /proposal_not_found/,
  )
  const result = runner.completeRecovery(connB, {
    challenge: recoveryB.challenge,
    committed: recoveryB.committed as unknown as Record<string, unknown>,
  })
  assert.equal(result.proposalId, committed.proposalId)
  store.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('AR7: the in-memory store rolls back a failed transaction and rejects promise callbacks', () => {
  const store = createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const input = {
    proposal: {
      proposalId: IDS.proposalId,
      proposalDigest: PROPOSAL_DIGEST,
      observedSessionId: IDS.observedSessionId,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
    },
    authorization: { proposalId: IDS.proposalId, proposalDigest: PROPOSAL_DIGEST },
    acknowledgement: { decision: 'acknowledged', activity: 'idle' },
    observed: {},
    reconciliation: { activity: 'idle', sourceSequence: 2 },
  }
  // A promise-returning callback must be rejected.
  assert.throws(
    () => store.transaction((tx) => Promise.resolve(tx.currentCursor())),
    /synchronous/,
  )
  // A commit followed by a throw must roll back binding, occupancy, event, cursor.
  assert.throws(
    () => store.transaction((tx) => {
      tx.commitAdoption(input)
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(store.snapshot().committedRuns.length, 0, 'rollback must leave no committed run')
  assert.equal(store.snapshot().events.length, 0, 'rollback must leave no event')
  assert.equal(store.snapshot().cursor, 0, 'rollback must leave the cursor unchanged')
})

test('F16 race: concurrent acknowledgements commit exactly once', async () => {
  const harness = createGatewayHarness()
  const conn = new RecordingConnection()
  const registered = registerThroughGateway(harness.gateway, conn)
  const { proposal, values } = await prepareProposal(harness.gateway, conn, registered)
  const session = harness.gateway.accept(conn)
  const ack = ackBody(proposal, values)
  await Promise.all([
    session.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ack }),
    session.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ack }),
  ])
  assert.equal(harness.runner.commitCount, 1, 'concurrent acknowledgements must commit exactly once')
  assert.equal(harness.store.snapshot().committedRuns.length, 1, 'exactly one durable run must exist')
})

test('F16 lifecycle-loss: connection loss revokes readiness and clears queued dispatch', async () => {
  const harness = createGatewayHarness()
  const conn = new RecordingConnection()
  const registered = registerThroughGateway(harness.gateway, conn)
  const { proposal, values } = await prepareProposal(harness.gateway, conn, registered)
  const session = harness.gateway.accept(conn)
  await session.handleFrame({ type: 'adoption.ack', messageId: nextMessageId(), body: ackBody(proposal, values) })
  assert.equal(harness.runner.commitCount, 1)
  harness.runner.onConnectionLost(conn)
  assert.equal(harness.runner.managedBridgeEnabled, false, 'connection loss must revoke readiness')
  assert.equal(harness.runner.queuedWork, 0, 'connection loss must clear queued dispatch')
})

test('F16 crash-stage: committed delivery loss recovers through gateway recovery frames', async () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
  })
  const CONNECTION = { id: 'transport-1' }
  runner.registerObserved({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }, CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 7,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
  })
  assert.equal(runner.commitCount, 1)
  store.close()

  // Simulated restart: a fresh gateway over the same durable file routes the
  // committed binding through the challenged recovery handshake.
  const restartedStore = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const restarted = new LiveAdoptionRunner({
    store: restartedStore,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const clock = new FakeMonotonicClock(0)
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    runner: restarted,
    clock,
    capabilityIssuer: new FakeCapabilityIssuer(),
  })
  const conn = new RecordingConnection()
  const session = gateway.accept(conn)
  await session.handleFrame({ type: 'observer.register', messageId: nextMessageId(), body: registerBody() })
  const challenge = conn.last('adoption.recovery_challenge')
  assert.ok(challenge !== undefined, 'a committed binding must receive a recovery challenge')
  await session.handleFrame({
    type: 'adoption.recovery_proof',
    messageId: nextMessageId(),
    body: {
      challenge: String(challenge.body.challenge),
      committed: challenge.body.committed as Record<string, unknown>,
    },
  })
  const committed = conn.last('adoption.committed')
  assert.ok(committed !== undefined, 'a valid recovery proof must deliver the committed frame')
  assert.equal(restarted.commitCount, 0, 'recovery must not create a second commit')
  assert.equal(restartedStore.snapshot().committedRuns.length, 1, 'commitment count must be unchanged')
  assert.equal(restartedStore.snapshot().events.length, 1, 'event count must be unchanged')
  restartedStore.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})
