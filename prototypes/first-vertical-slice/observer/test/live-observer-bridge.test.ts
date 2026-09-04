/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only bridge integration coverage. It wires the same-process Pi
 * observer extension through the bounded observer frame channel into the
 * observation-only gateway and the narrow Companion 0.3.0 publisher, entirely
 * with in-memory fakes. It never opens a real socket, launches a process, or
 * inspects installed Companion state.
 *
 * Coverage: fragmented and multiple NDJSON frames, malformed/unknown/oversized
 * frames and partial-buffer overflow, registration, authoritative Companion
 * projection, heartbeat lease refresh, graceful and abrupt disconnect,
 * injected-clock expiry, failed initial connection, same-session reconnect
 * with greater attempt/sequence and fresh connection capabilities, projection
 * failure isolation, and fail-open Pi behavior.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OBSERVER_CAPABILITIES,
  OBSERVER_LIMITS,
  OBSERVER_PROTOCOL_ID,
  encodeFrame,
  NdjsonDecoder,
  type ObserverFrame,
} from '../contracts.ts'
import {
  OBSERVER_STATUS_KEY,
  createObserverExtension,
  type HeartbeatHandle,
  type ObserverConnection,
  type ObserverFrameHandler,
} from '../extension-adapter.ts'
import { FakePiHost } from '../fake-pi-host.ts'
import { FakeCapabilityIssuer, FakeMonotonicClock } from '../fakes.ts'
import { LiveFrameChannel, type DuplexStream } from '../live-frame-channel.ts'
import {
  LiveObserverGateway,
  type GatewaySession,
} from '../live-gateway-core.ts'
import {
  LiveCompanionProjection,
  type ObserverCompanionShellPort,
} from '../live-companion-projection.ts'
import { FakeCompanionShell } from '../../companion/fake-companion-shell.ts'
import {
  COMPANION_CAPABILITIES,
  COMPANION_OBSERVER_CAPABILITY,
  COMPANION_PLUGIN_ID,
  COMPANION_PROTOCOL_ID,
  type CompanionCapabilitiesEnvelope,
} from '../../companion/contracts.ts'
import type { ObservedProjection } from '../telemetry-policy.ts'

// ---------------------------------------------------------------------------
// In-memory duplex helpers
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

/** ObserverConnection wrapper over a client-side LiveFrameChannel. */
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

/** Deterministic controlled timer for heartbeats and reconnects. */
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

  trigger(index: number): void {
    const entry = this.entries[index]
    if (entry !== undefined && !entry.cancelled) entry.callback()
  }

  get length(): number {
    return this.entries.length
  }
}

// ---------------------------------------------------------------------------
// Observer frame builders
// ---------------------------------------------------------------------------

let messageCounter = 0
function nextMessageId(): string {
  messageCounter += 1
  return `msg-${messageCounter}`
}

function frame(type: string, messageId: string, body: Record<string, unknown>): ObserverFrame {
  return { protocol: OBSERVER_PROTOCOL_ID, type, messageId, body }
}

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
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

function heartbeatBody(values: { connectionId: string; connectionChallenge: string }, overrides: Record<string, unknown> = {}) {
  return {
    connectionId: values.connectionId,
    connectionChallenge: values.connectionChallenge,
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

function closeBody(values: { connectionId: string; connectionChallenge: string }, overrides: Record<string, unknown> = {}) {
  return {
    connectionId: values.connectionId,
    connectionChallenge: values.connectionChallenge,
    sourceSequence: 4,
    reason: 'quit',
    ...overrides,
  }
}

function adoptionAckBody(values: { connectionId: string; connectionChallenge: string }, overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    connectionId: values.connectionId,
    connectionChallenge: values.connectionChallenge,
    proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
    proposalDigest: 'a'.repeat(64),
    acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
    registryRevision: 1,
    sourceSequence: 5,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
    ...overrides,
  }
}

function connectionValues(registered: ObserverFrame | undefined) {
  assert.ok(registered !== undefined, 'missing observer.registered response')
  return {
    connectionId: registered.body.connectionId as string,
    connectionChallenge: registered.body.connectionChallenge as string,
  }
}

// ---------------------------------------------------------------------------
// Gateway harness (no Pi extension; drives the server-side frame channel)
// ---------------------------------------------------------------------------

interface GatewayConnectionEntry {
  serverDuplex: FakeDuplex
  channel: LiveFrameChannel
  session: GatewaySession
  outgoing: ObserverFrame[]
  emitRaw(bytes: string): void
  sendFrame(f: ObserverFrame): void
  last(type: string): ObserverFrame | undefined
  abrupt(): void
  close(): void
}

function observerCapabilities(): CompanionCapabilitiesEnvelope {
  return {
    protocol: COMPANION_PROTOCOL_ID,
    pluginId: COMPANION_PLUGIN_ID,
    version: '0.3.0',
    pluginGeneration: 1,
    capabilities: [...COMPANION_CAPABILITIES, COMPANION_OBSERVER_CAPABILITY],
  }
}

function createGatewayHarness(shell?: ObserverCompanionShellPort) {
  const clock = new FakeMonotonicClock(0)
  const capabilityIssuer = new FakeCapabilityIssuer()
  const effectiveShell = shell ?? new FakeCompanionShell({
    version: '0.3.0',
    capabilities: [...COMPANION_CAPABILITIES, COMPANION_OBSERVER_CAPABILITY],
  })
  const publisher = new LiveCompanionProjection({ shell: effectiveShell, pluginId: COMPANION_PLUGIN_ID })
  const projections: ObservedProjection[] = []
  const gateway = new LiveObserverGateway({
    clock,
    executionNodeId: 'execution-node-local',
    capabilityIssuer,
    onProjection: (projection) => {
      projections.push(projection)
      publisher.publish(projection).catch(() => {
        // A Companion publication failure is isolated from the gateway.
      })
    },
  })

  const connections: GatewayConnectionEntry[] = []
  const connect = (): GatewayConnectionEntry => {
    const serverDuplex = new FakeDuplex()
    const decoder = new NdjsonDecoder()
    const outgoing: ObserverFrame[] = []
    serverDuplex.onWrite = (data) => {
      for (const parsed of decoder.push(data)) outgoing.push(parsed)
    }
    let session!: GatewaySession
    const channel = new LiveFrameChannel(serverDuplex, {
      onFrame: (incoming) => session?.handleFrame(incoming),
      onClose: (error) => session?.transportClosed(error),
    })
    session = gateway.accept(channel)
    const entry: GatewayConnectionEntry = {
      serverDuplex,
      channel,
      session,
      outgoing,
      emitRaw: (bytes) => serverDuplex.emitData(bytes),
      sendFrame: (incoming) => serverDuplex.emitData(encodeFrame(incoming.type, incoming.messageId, incoming.body)),
      last: (type) => [...outgoing].reverse().find((entryFrame) => entryFrame.type === type),
      abrupt: () => serverDuplex.emitClose(),
      close: () => channel.close(),
    }
    connections.push(entry)
    return entry
  }

  return { clock, gateway, publisher, projections, connect, connections, shell: effectiveShell }
}

// ---------------------------------------------------------------------------
// Extension harness (full pipeline through the Pi extension)
// ---------------------------------------------------------------------------

function createExtensionHarness(options: { rejectConnect?: boolean } = {}) {
  const clock = new FakeMonotonicClock(0)
  const capabilityIssuer = new FakeCapabilityIssuer()
  const shell = new FakeCompanionShell({
    version: '0.3.0',
    capabilities: [...COMPANION_CAPABILITIES, COMPANION_OBSERVER_CAPABILITY],
  })
  const publisher = new LiveCompanionProjection({ shell, pluginId: COMPANION_PLUGIN_ID })
  const projections: ObservedProjection[] = []
  const gateway = new LiveObserverGateway({
    clock,
    executionNodeId: 'execution-node-local',
    capabilityIssuer,
    onProjection: (projection) => {
      projections.push(projection)
      publisher.publish(projection).catch(() => {
        // A Companion publication failure is isolated from the gateway.
      })
    },
  })
  const { client, server } = createDuplexPair()
  let session!: GatewaySession
  const serverChannel = new LiveFrameChannel(server, {
    onFrame: (incoming) => session?.handleFrame(incoming),
    onClose: (error) => session?.transportClosed(error),
  })
  session = gateway.accept(serverChannel)

  const host = new FakePiHost({
    sessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    mode: 'tui',
    hasUI: true,
  })
  const heartbeatCtrl = new FakeTimerController()
  const reconnectCtrl = new FakeTimerController()
  const extension = createObserverExtension({
    observerVersion: '0.1.0',
    connect: (receive) => {
      if (options.rejectConnect) return Promise.reject(new Error('observer transport unavailable'))
      return Promise.resolve(new FakeExtensionConnection(client, receive))
    },
    scheduleHeartbeat: (callback) => heartbeatCtrl.schedule(callback),
    cancelHeartbeat: (handle) => heartbeatCtrl.cancel(handle),
    scheduleReconnect: (callback) => reconnectCtrl.schedule(callback),
    cancelReconnect: (handle) => reconnectCtrl.cancel(handle),
  })
  extension(host.api)

  return { clock, gateway, publisher, shell, projections, host, heartbeatCtrl, reconnectCtrl }
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('a fragmented register frame still registers an observed session', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  const line = encodeFrame('observer.register', nextMessageId(), registerBody())
  const mid = Math.floor(line.length / 2)
  connection.emitRaw(line.slice(0, mid))
  assert.equal(connection.last('observer.registered'), undefined)
  connection.emitRaw(line.slice(mid))
  assert.ok(connection.last('observer.registered') !== undefined)
  assert.equal(harness.gateway.snapshot().agents.length, 1)
})

test('multiple NDJSON frames in one chunk are both handled', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  const register1 = encodeFrame('observer.register', nextMessageId(), registerBody({
    registrationAttempt: 1,
    sourceSequence: 1,
  }))
  const register2 = encodeFrame('observer.register', nextMessageId(), registerBody({
    registrationAttempt: 2,
    sourceSequence: 2,
  }))
  connection.emitRaw(`${register1}${register2}`)
  const latest = connection.last('observer.registered')
  assert.ok(latest !== undefined)
  assert.equal(latest.body.acceptedRegistrationAttempt, 2)
  assert.equal(harness.gateway.snapshot().agents.length, 1)
})

test('malformed JSON input fails the connection closed', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.emitRaw('{not-json}\n')
  assert.equal(connection.channel.isClosed, true)
})

test('an unknown frame type fails the connection closed', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.emitRaw(JSON.stringify({
    protocol: OBSERVER_PROTOCOL_ID,
    type: 'observer.unknown',
    messageId: 'msg-unknown-1',
    body: {},
  }) + '\n')
  assert.equal(connection.channel.isClosed, true)
})

test('an oversized envelope fails the connection closed', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.emitRaw(JSON.stringify({
    protocol: OBSERVER_PROTOCOL_ID,
    type: 'observer.lifecycle',
    messageId: 'msg-large-1',
    body: {
      connectionId: 'c',
      connectionChallenge: 'cc',
      eventId: 'e',
      sourceSequence: 1,
      lifecycle: 'running',
      activity: 'idle',
      health: 'healthy',
      pad: 'x'.repeat(OBSERVER_LIMITS.envelopeBytes),
    },
  }) + '\n')
  assert.equal(connection.channel.isClosed, true)
})

test('a partial buffer over the decode bound fails the connection closed', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.emitRaw('a'.repeat(OBSERVER_LIMITS.decodeBufferBytes + 1))
  assert.equal(connection.channel.isClosed, true)
})

test('registration publishes an authoritative Companion projection with empty choices', async () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  const shell = harness.shell as FakeCompanionShell

  await settle()
  assert.equal(harness.gateway.snapshot().agents.length, 1)
  assert.equal(harness.projections.length, 1)
  const projection = harness.projections[0]
  assert.equal(projection.agents[0].piStatus, 'Unassigned · observed')
  assert.deepEqual(projection.agents[0].choices, [])
  assert.ok(shell.panel.observerProjections.length >= 1, 'Companion observer seam must receive the projection')
})

test('a heartbeat refreshes the lease and prevents expiry under the injected clock', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  const values = connectionValues(connection.last('observer.registered'))

  harness.clock.advance(10_000)
  connection.sendFrame(frame('observer.heartbeat', nextMessageId(), heartbeatBody(values)))

  harness.clock.advance(10_000) // total 20_000; lease was refreshed to 10_000 + 15_000
  harness.gateway.sweep()
  assert.equal(harness.gateway.snapshot().agents.length, 1, 'heartbeat must refresh the lease')
})

test('injected-clock expiry removes an idle session after the lease elapses', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  assert.equal(harness.gateway.snapshot().agents.length, 1)

  harness.clock.advance(15_001)
  harness.gateway.sweep()
  assert.equal(harness.gateway.snapshot().agents.length, 0)
})

test('a graceful close marks the session unavailable and publishes', async () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  const values = connectionValues(connection.last('observer.registered'))

  connection.sendFrame(frame('observer.close', nextMessageId(), closeBody(values)))
  await settle()
  assert.equal(harness.gateway.snapshot().agents[0].availability, 'unavailable')
})

test('an abrupt disconnect marks the session unavailable', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))

  connection.abrupt()
  assert.equal(harness.gateway.snapshot().agents[0].availability, 'unavailable')
})

test('a same-session reconnect with a greater attempt allocates fresh connection capabilities', () => {
  const harness = createGatewayHarness()
  const first = harness.connect()
  first.sendFrame(frame('observer.register', nextMessageId(), registerBody({ registrationAttempt: 1, sourceSequence: 1 })))
  const firstRegistered = first.last('observer.registered')
  assert.ok(firstRegistered !== undefined)
  first.abrupt()

  const second = harness.connect()
  second.sendFrame(frame('observer.register', nextMessageId(), registerBody({ registrationAttempt: 2, sourceSequence: 2 })))
  const secondRegistered = second.last('observer.registered')
  assert.ok(secondRegistered !== undefined)
  assert.notEqual(secondRegistered.body.connectionId, firstRegistered.body.connectionId)
  assert.notEqual(secondRegistered.body.connectionChallenge, firstRegistered.body.connectionChallenge)
  assert.equal(secondRegistered.body.acceptedRegistrationAttempt, 2)
  assert.equal(harness.gateway.snapshot().agents.length, 1, 'reconnect must not duplicate the observed session')
})

test('an adoption frame is rejected without mutation', () => {
  const harness = createGatewayHarness()
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  const values = connectionValues(connection.last('observer.registered'))

  connection.sendFrame(frame('adoption.ack', nextMessageId(), adoptionAckBody(values)))
  const rejected = connection.last('observer.rejected')
  assert.ok(rejected !== undefined)
  assert.equal(rejected.body.code, 'unsupported_protocol')
  assert.equal(harness.gateway.snapshot().agents[0].availability, 'available')
})

test('a Companion publication failure is isolated from the Pi connection', () => {
  let fail = true
  const stub: ObserverCompanionShellPort = {
    capabilities: async () => observerCapabilities(),
    call: async (_pluginId, _method, _payload) => {
      if (fail) throw new Error('Companion publication failed')
      return 'true'
    },
  }
  const harness = createGatewayHarness(stub)
  const connection = harness.connect()
  connection.sendFrame(frame('observer.register', nextMessageId(), registerBody()))
  assert.ok(connection.last('observer.registered') !== undefined)

  // A later heartbeat still works despite the publisher failure.
  fail = false
  const values = connectionValues(connection.last('observer.registered'))
  connection.sendFrame(frame('observer.heartbeat', nextMessageId(), heartbeatBody(values)))
  assert.equal(connection.last('observer.rejected'), undefined)
  assert.equal(connection.channel.isClosed, false)
  assert.equal(harness.gateway.snapshot().agents[0].availability, 'available')
})

test('registration flows through the Pi extension and sets the owned status', async () => {
  const harness = createExtensionHarness()
  const host = harness.host

  await host.startSession()
  await settle()

  assert.equal(host.isSessionRunning, true)
  assert.equal(host.status(OBSERVER_STATUS_KEY), 'Unassigned · observed')
  assert.equal(harness.gateway.snapshot().agents.length, 1)
  assert.equal(host.hiddenAgentCount, 0)

  const shell = harness.shell as FakeCompanionShell
  assert.ok(shell.panel.observerProjections.length >= 1)
})

test('a failed initial connection keeps Pi usable (fail open)', async () => {
  const harness = createExtensionHarness({ rejectConnect: true })
  const host = harness.host

  await host.startSession()
  assert.equal(host.isSessionRunning, true)
  assert.equal(host.hiddenAgentCount, 0)
  assert.equal(harness.gateway.snapshot().agents.length, 0)
})
