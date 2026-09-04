/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only tests for the observation-only gateway core. They use an injected
 * fake clock, capability issuer, and in-memory connections. They never open a
 * socket, launch a process, or contact a live system.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OBSERVER_CAPABILITIES,
  OBSERVER_PROTOCOL_ID,
  type ObserverFrame,
} from '../contracts.ts'
import {
  LiveObserverGateway,
  type GatewayConnection,
} from '../live-gateway-core.ts'
import {
  FakeCapabilityIssuer,
  FakeMonotonicClock,
} from '../fakes.ts'

class FakeGatewayConnection implements GatewayConnection {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  closed = false

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.sent.push({ type, messageId, body })
  }

  close(): void {
    this.closed = true
  }

  last(type: string): { type: string; messageId: string; body: Record<string, unknown> } | undefined {
    return [...this.sent].reverse().find((entry) => entry.type === type)
  }
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

function lifecycleBody(values: { connectionId: string; connectionChallenge: string }, overrides: Record<string, unknown> = {}) {
  return {
    connectionId: values.connectionId,
    connectionChallenge: values.connectionChallenge,
    eventId: 'event-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 3,
    lifecycle: 'running',
    activity: 'busy',
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

function createGateway(overrides: { onProjection?: (projection: unknown) => void } = {}) {
  const clock = new FakeMonotonicClock(0)
  const capabilityIssuer = new FakeCapabilityIssuer()
  const projections: unknown[] = []
  const gateway = new LiveObserverGateway({
    clock,
    executionNodeId: 'execution-node-local',
    capabilityIssuer,
    onProjection: (projection) => {
      projections.push(projection)
      overrides.onProjection?.(projection)
    },
  })
  return { clock, capabilityIssuer, gateway, projections }
}

function registerConnection(gateway: LiveObserverGateway) {
  const connection = new FakeGatewayConnection()
  const session = gateway.accept(connection)
  return { connection, session }
}

function registerAndGetValues(gateway: LiveObserverGateway) {
  const { connection, session } = registerConnection(gateway)
  session.handleFrame(frame('observer.register', 'msg-1', registerBody()))
  const registered = connection.last('observer.registered')
  assert.ok(registered !== undefined)
  return {
    connection,
    session,
    values: {
      connectionId: registered.body.connectionId as string,
      connectionChallenge: registered.body.connectionChallenge as string,
    },
  }
}

test('registration produces observer.registered and a projection with empty choices', () => {
  const { gateway, projections } = createGateway()
  const { connection, session } = registerConnection(gateway)
  session.handleFrame(frame('observer.register', 'msg-1', registerBody()))

  const registered = connection.last('observer.registered')
  assert.ok(registered !== undefined)
  assert.equal(registered.body.piStatus, 'Unassigned · observed')
  assert.equal(registered.body.executionNodeId, 'execution-node-local')
  assert.equal(registered.body.heartbeatIntervalMs, 5000)
  assert.equal(registered.body.leaseDurationMs, 15000)
  assert.match(String(registered.body.observedSessionId), /^observed-[a-f0-9]{32}$/)

  assert.equal(projections.length, 1)
  const projection = projections[0] as { observerRevision: number; agents: Array<{ choices: unknown[] }> }
  assert.equal(projection.agents.length, 1)
  assert.deepEqual(projection.agents[0].choices, [])
})

test('a heartbeat before registration is rejected without mutation', () => {
  const { gateway, projections } = createGateway()
  const { connection, session } = registerConnection(gateway)
  session.handleFrame(frame('observer.heartbeat', 'msg-hb', heartbeatBody({
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
  })))

  const rejected = connection.last('observer.rejected')
  assert.ok(rejected !== undefined)
  assert.equal(rejected.body.code, 'connection_not_current')
  assert.equal(projections.length, 0)
  assert.equal(gateway.snapshot().agents.length, 0)
})

test('a heartbeat after registration refreshes the lease and publishes', () => {
  const { clock, gateway, projections } = createGateway()
  const { session, values } = registerAndGetValues(gateway)
  projections.length = 0

  clock.advance(5000)
  session.handleFrame(frame('observer.heartbeat', 'msg-hb', heartbeatBody(values)))
  assert.equal(projections.length, 1)
  assert.equal(gateway.snapshot().agents[0].availability, 'available')
})

test('a lifecycle frame updates the projection', () => {
  const { gateway, projections } = createGateway()
  const { session, values } = registerAndGetValues(gateway)
  projections.length = 0

  session.handleFrame(frame('observer.lifecycle', 'msg-lc', lifecycleBody(values)))
  assert.equal(projections.length, 1)
  const projection = projections[0] as { agents: Array<{ lifecycle: string }> }
  assert.equal(projection.agents[0].lifecycle, 'running')
})

test('a graceful close marks the session unavailable and publishes', () => {
  const { gateway, projections } = createGateway()
  const { session, values } = registerAndGetValues(gateway)
  projections.length = 0

  session.handleFrame(frame('observer.close', 'msg-close', closeBody(values)))
  assert.equal(projections.length, 1)
  const projection = projections[0] as { agents: Array<{ availability: string }> }
  assert.equal(projection.agents[0].availability, 'unavailable')
})

test('an abrupt disconnect marks the session unavailable', () => {
  const { gateway, projections } = createGateway()
  const { connection, session } = registerAndGetValues(gateway)
  projections.length = 0

  session.transportClosed(new Error('socket closed'))
  assert.equal(projections.length, 1)
  const projection = projections[0] as { agents: Array<{ availability: string }> }
  assert.equal(projection.agents[0].availability, 'unavailable')
  assert.equal(connection.closed, false)
})

test('expiry removes an expired session after the injected clock advances', () => {
  const { clock, gateway, projections } = createGateway()
  const { session } = registerAndGetValues(gateway)
  projections.length = 0

  clock.advance(15001)
  gateway.sweep()
  assert.equal(projections.length, 1)
  assert.equal(gateway.snapshot().agents.length, 0)
})

test('a same-session reconnect with a greater attempt allocates fresh connection values', () => {
  const { gateway } = createGateway()
  const first = registerAndGetValues(gateway)
  const firstRegistered = first.connection.last('observer.registered')
  assert.ok(firstRegistered !== undefined)

  const second = registerConnection(gateway)
  second.session.handleFrame(frame('observer.register', 'msg-2', registerBody({
    registrationAttempt: 2,
    sourceSequence: 2,
  })))
  const secondRegistered = second.connection.last('observer.registered')
  assert.ok(secondRegistered !== undefined)
  assert.notEqual(secondRegistered.body.connectionId, firstRegistered.body.connectionId)
  assert.notEqual(secondRegistered.body.connectionChallenge, firstRegistered.body.connectionChallenge)
  assert.equal(secondRegistered.body.acceptedRegistrationAttempt, 2)
  assert.equal(gateway.snapshot().agents.length, 1)
})

test('an adoption frame is rejected without mutating registry state', () => {
  const { gateway, projections } = createGateway()
  const { connection, session, values } = registerAndGetValues(gateway)
  projections.length = 0

  session.handleFrame(frame('adoption.ack', 'msg-adopt', adoptionAckBody(values)))
  const rejected = connection.last('observer.rejected')
  assert.ok(rejected !== undefined)
  assert.equal(rejected.body.code, 'unsupported_protocol')
  assert.equal(projections.length, 0)
  assert.equal(gateway.snapshot().agents.length, 1)
  assert.equal(gateway.snapshot().agents[0].availability, 'available')
})

test('a runner frame from the client is rejected as invalid', () => {
  const { gateway } = createGateway()
  const { connection, session } = registerConnection(gateway)
  session.handleFrame(frame('observer.register', 'msg-1', registerBody()))

  session.handleFrame(frame('observer.registered', 'msg-runner', {
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
  }))
  const rejected = connection.last('observer.rejected')
  assert.ok(rejected !== undefined)
  assert.equal(rejected.body.code, 'invalid_envelope')
})

test('a Companion publication failure is isolated from the Pi connection', () => {
  let fail = true
  let calls = 0
  const { gateway } = createGateway({
    onProjection: () => {
      calls += 1
      if (fail) throw new Error('Companion publication failed')
    },
  })
  const { connection, session, values } = registerAndGetValues(gateway)

  // The connection still receives observer.registered despite the publisher error.
  assert.ok(connection.last('observer.registered') !== undefined)
  assert.equal(calls, 1)

  // A subsequent heartbeat still works and the connection is not closed.
  fail = false
  session.handleFrame(frame('observer.heartbeat', 'msg-hb', heartbeatBody(values)))
  assert.equal(connection.last('observer.rejected'), undefined)
  assert.equal(connection.closed, false)
  assert.equal(calls, 2)
})

test('close closes every connection and discards state', () => {
  const { gateway } = createGateway()
  const { connection, session } = registerConnection(gateway)
  session.handleFrame(frame('observer.register', 'msg-1', registerBody()))
  gateway.close()
  assert.equal(connection.closed, true)
  assert.equal(gateway.snapshot().agents.length, 0)
})
