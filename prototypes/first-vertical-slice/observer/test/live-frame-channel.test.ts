/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only tests for the bounded NDJSON observer frame channel. They use an
 * injected in-memory duplex stream and never open a socket, launch a process,
 * or contact a live system.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OBSERVER_CAPABILITIES,
  OBSERVER_LIMITS,
  encodeFrame,
  type ObserverFrame,
} from '../contracts.ts'
import {
  LiveFrameChannel,
  type DuplexStream,
  type FrameChannelHandler,
} from '../live-frame-channel.ts'

class FakeDuplexStream implements DuplexStream {
  readonly dataListeners: Array<(chunk: string) => void> = []
  readonly errorListeners: Array<(error: Error) => void> = []
  readonly closeListeners: Array<() => void> = []
  readonly written: string[] = []
  destroyed = false
  encoding = ''

  setEncoding(encoding: string): void {
    this.encoding = encoding
  }

  on(event: 'data' | 'error' | 'close', listener: (value: string | Error) => void): void {
    if (event === 'data') this.dataListeners.push(listener as (chunk: string) => void)
    else if (event === 'error') this.errorListeners.push(listener as (error: Error) => void)
    else this.closeListeners.push(listener as () => void)
  }

  write(data: string): void {
    this.written.push(data)
  }

  destroy(): void {
    this.destroyed = true
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }

  emitClose(): void {
    for (const listener of this.closeListeners) listener()
  }
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

function registerLine(): string {
  return encodeFrame('observer.register', 'msg-register-1', registerBody())
}

function createChannel() {
  const stream = new FakeDuplexStream()
  const frames: ObserverFrame[] = []
  const closes: Array<Error | null> = []
  const handler: FrameChannelHandler = {
    onFrame: (frame) => frames.push(frame),
    onClose: (error) => closes.push(error),
  }
  const channel = new LiveFrameChannel(stream, handler)
  return { stream, frames, closes, channel }
}

test('decodes a complete frame delivered in one chunk', () => {
  const { stream, frames, channel } = createChannel()
  stream.emitData(registerLine())
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'observer.register')
  assert.equal(frames[0].protocol, 'omarchestra.observer/v1')
  assert.equal(channel.isClosed, false)
})

test('decodes a frame fragmented across multiple data events', () => {
  const { stream, frames } = createChannel()
  const line = registerLine()
  const mid = Math.floor(line.length / 2)
  stream.emitData(line.slice(0, mid))
  assert.equal(frames.length, 0)
  stream.emitData(line.slice(mid))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'observer.register')
})

test('decodes multiple frames delivered in one chunk', () => {
  const { stream, frames } = createChannel()
  const first = registerLine()
  const second = encodeFrame('observer.heartbeat', 'msg-heartbeat-1', {
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
  })
  stream.emitData(`${first}${second}`)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].type, 'observer.register')
  assert.equal(frames[1].type, 'observer.heartbeat')
})

test('malformed JSON fails the channel closed', () => {
  const { stream, closes, channel } = createChannel()
  stream.emitData('{not-json}\n')
  assert.equal(channel.isClosed, true)
  assert.equal(closes.length, 1)
  assert.ok(closes[0] instanceof Error)
})

test('an oversized frame fails the channel closed', () => {
  const { stream, closes, channel } = createChannel()
  const oversized = `{"protocol":"omarchestra.observer/v1","type":"observer.register","messageId":"msg-1","body":{"pad":"${'x'.repeat(OBSERVER_LIMITS.envelopeBytes)}}}}\n`
  stream.emitData(oversized)
  assert.equal(channel.isClosed, true)
  assert.equal(closes.length, 1)
  assert.ok(closes[0] instanceof Error)
})

test('a partial buffer over the decode bound fails the channel closed', () => {
  const { stream, closes, channel } = createChannel()
  // A single unterminated line larger than the decode buffer bound.
  stream.emitData(`${'a'.repeat(OBSERVER_LIMITS.decodeBufferBytes + 1)}`)
  assert.equal(channel.isClosed, true)
  assert.equal(closes.length, 1)
  assert.ok(closes[0] instanceof Error)
})

test('send encodes a validated frame onto the stream', () => {
  const { stream, channel } = createChannel()
  channel.send('observer.registered', 'msg-registered-1', {
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    acceptedRegistrationAttempt: 1,
    acceptedSourceSequence: 1,
    heartbeatIntervalMs: 5000,
    leaseDurationMs: 15000,
    registryRevision: 1,
    piStatus: 'Unassigned · observed',
  })
  assert.equal(stream.written.length, 1)
  assert.match(stream.written[0], /"type":"observer.registered"/)
  assert.ok(stream.written[0].endsWith('\n'))
})

test('close destroys the stream and is idempotent', () => {
  const { stream, channel } = createChannel()
  channel.close()
  assert.equal(stream.destroyed, true)
  assert.equal(channel.isClosed, true)
  channel.close()
  assert.equal(stream.destroyed, true)
})

test('a stream error fails the channel closed', () => {
  const { stream, closes, channel } = createChannel()
  stream.emitError(new Error('socket error'))
  assert.equal(channel.isClosed, true)
  assert.equal(closes.length, 1)
  assert.ok(closes[0] instanceof Error)
})

test('a stream close without error reports a null close', () => {
  const { stream, closes, channel } = createChannel()
  stream.emitClose()
  assert.equal(channel.isClosed, true)
  assert.equal(closes.length, 1)
  assert.equal(closes[0], null)
})
