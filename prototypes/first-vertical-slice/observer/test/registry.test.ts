/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for the Agent Registry. These tests are written against
 * the locked observer/Adoption v1 contract and are intended to FAIL until
 * `observer/registry.ts` and `observer/fakes.ts` are implemented in Phase 3.
 * No production behavior is implemented here.
 *
 * The registry owns current Observed Pi Sessions over injected clock,
 * transport, and persistence ports. It keeps availability, lifecycle,
 * eligibility, and expiry distinct and never derives authority from raw
 * observer frames.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function loadRegistry() {
  return await import('../registry.ts')
}

async function loadFakes() {
  return await import('../fakes.ts')
}

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    hostPid: 41001,
    hostMode: 'tui',
    observerVersion: '0.1.0',
    capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'],
    registrationAttempt: 1,
    sourceSequence: 1,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

async function createRegistry() {
  const fakes = await loadFakes()
  const registry = await loadRegistry()
  const clock = new fakes.FakeMonotonicClock(0)
  const persistence = new fakes.FakeObserverPersistence()
  const capabilityIssuer = new fakes.FakeCapabilityIssuer()
  const instance = new registry.AgentRegistry({
    clock,
    persistence,
    capabilityIssuer,
    executionNodeId: 'execution-node-local',
  })
  return { registry, fakes, clock, persistence, capabilityIssuer, instance }
}

test('registration produces exactly one current Observed Pi Session', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody())
  assert.equal(registered.piStatus, 'Unassigned · observed')
  assert.equal(registered.executionNodeId, 'execution-node-local')
  assert.equal(registered.heartbeatIntervalMs, 5000)
  assert.equal(registered.leaseDurationMs, 15000)
  assert.match(String(registered.observedSessionId), /^observed-[a-f0-9]{32}$/)
  assert.match(String(registered.connectionId), /^connection-[a-f0-9]{32}$/)
  assert.match(String(registered.connectionChallenge), /^challenge-[a-f0-9]{32}$/)

  const snapshot = instance.snapshot()
  assert.equal(snapshot.agents.length, 1)
  assert.equal(snapshot.agents[0].piStatus, 'Unassigned · observed')
})

test('the registry snapshot contains no management or authority fields', async () => {
  const { instance } = await createRegistry()
  instance.register({ id: 'transport-1' }, registerBody())
  const snapshot = instance.snapshot()
  const serialized = JSON.stringify(snapshot)
  for (const forbidden of [
    'teamGoal', 'role', 'assignment', 'controlMode', 'writer', 'runtimeBinding',
    'prompt', 'pty', 'terminal', 'process', 'workflow', 'hostPid',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `snapshot must not contain ${forbidden}`)
  }
})

test('reconnect requires greater attempt and source sequence for the exact extension identity', async () => {
  const { instance } = await createRegistry()
  const firstConnection = { id: 'transport-1' }
  const nextConnection = { id: 'transport-2' }
  const first = instance.register(firstConnection, registerBody({ registrationAttempt: 1, sourceSequence: 3 }))

  assert.throws(
    () => instance.register(nextConnection, registerBody({ registrationAttempt: 1, sourceSequence: 4 })),
    /stale|attempt|registration/i,
  )
  assert.throws(
    () => instance.register(nextConnection, registerBody({ registrationAttempt: 2, sourceSequence: 3 })),
    /sequence|monotonic|invalid/i,
  )

  const reconnected = instance.register(nextConnection, registerBody({ registrationAttempt: 2, sourceSequence: 4 }))
  assert.equal(reconnected.acceptedRegistrationAttempt, 2)
  assert.equal(reconnected.acceptedSourceSequence, 4)
  assert.notEqual(reconnected.connectionId, first.connectionId)
  assert.notEqual(reconnected.connectionChallenge, first.connectionChallenge)
})

test('source sequence is monotonic per extension incarnation', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody({ sourceSequence: 1 }))
  const heartbeat = heartbeatBody({
    connectionId: registered.connectionId,
    connectionChallenge: registered.connectionChallenge,
    sourceSequence: 2,
  })
  instance.heartbeat(connection, heartbeat)
  // A sequence regression is rejected.
  assert.throws(
    () => instance.heartbeat(connection, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: 1,
    })),
    /sequence|monotonic|invalid/i,
  )
})

test('injected monotonic clock drives disconnect and lease expiry', async () => {
  const { instance, clock } = await createRegistry()
  const registered = instance.register({ id: 'transport-1' }, registerBody())
  assert.equal(instance.snapshot().agents.length, 1)

  // Before the lease expires the session remains current.
  clock.advance(10000)
  assert.equal(instance.snapshot().agents.length, 1)

  // After the 15s lease expires the session leaves the current registry.
  clock.advance(6000)
  instance.expire()
  assert.equal(instance.snapshot().agents.length, 0)
})

test('availability is current-transport state and close invalidates that transport immediately', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody({ lifecycle: 'exited', health: 'degraded' }))
  assert.equal(instance.snapshot().agents[0].availability, 'available')

  instance.close(connection, {
    connectionId: registered.connectionId,
    connectionChallenge: registered.connectionChallenge,
    sourceSequence: 2,
    reason: 'quit',
  })
  assert.equal(instance.snapshot().agents[0].availability, 'unavailable')
  assert.throws(
    () => instance.heartbeat(connection, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: 3,
    })),
    /connection|current/i,
  )
})

test('an abrupt transport disconnect marks the record unavailable without fabricating a close frame', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody())
  const disconnected = instance.transportClosed(connection)
  assert.equal(disconnected.availability, 'unavailable')
  assert.equal(instance.snapshot().agents[0].availability, 'unavailable')
  assert.equal(instance.transportClosed(connection), null, 'duplicate transport close is idempotent')
  assert.throws(
    () => instance.heartbeat(connection, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: 2,
    })),
    /connection|current/i,
  )
})

test('message deduplication is bounded to 256 identities per extension incarnation', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody())
  // Replaying the exact same lifecycle event returns the cached result.
  const first = instance.lifecycle(connection, {
    connectionId: registered.connectionId,
    connectionChallenge: registered.connectionChallenge,
    eventId: 'event-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'busy',
    health: 'healthy',
  })
  const replay = instance.lifecycle(connection, {
    connectionId: registered.connectionId,
    connectionChallenge: registered.connectionChallenge,
    eventId: 'event-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'busy',
    health: 'healthy',
  })
  assert.deepEqual(replay, first)
  // Reusing an ID with different bytes is a conflict.
  assert.throws(
    () => instance.lifecycle(connection, {
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      eventId: 'event-0000000000000000000000000000000000000000000000000000000000000001',
      sourceSequence: 3,
      lifecycle: 'running',
      activity: 'idle',
      health: 'healthy',
    }),
    /conflict|duplicate|message/i,
  )
})

test('authoritative reconstruction after restart requires fresh registration', async () => {
  const { instance, persistence } = await createRegistry()
  instance.register({ id: 'transport-1' }, registerBody())
  // Persist the current state.
  persistence.save(instance.snapshot())

  // A fresh registry over the same persistence must not infer current
  // observation from stale state; it requires fresh registration.
  const registry = await loadRegistry()
  const fakes = await loadFakes()
  const clock = new fakes.FakeMonotonicClock(0)
  const fresh = new registry.AgentRegistry({
    clock,
    persistence,
    capabilityIssuer: new fakes.FakeCapabilityIssuer(),
    executionNodeId: 'execution-node-local',
  })
  fresh.reconstruct()
  assert.equal(fresh.snapshot().agents.length, 0, 'restart must not infer current observation from stale state')
})

test('incompatible or absent registry fails open and creates no observed record', async () => {
  const { instance } = await createRegistry()
  // Foreign capability set is incompatible: no record, ordinary Pi remains usable.
  assert.throws(
    () => instance.register({ id: 'transport-1' }, registerBody({
      capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'foreign.capability'],
    })),
    /incompatible|capabilit/i,
  )
  assert.equal(instance.snapshot().agents.length, 0)
})

test('the registry enforces the 64-session capacity bound', async () => {
  const { instance } = await createRegistry()
  for (let index = 0; index < 64; index += 1) {
    instance.register({ id: `transport-${index}` }, registerBody({
      processIncarnationId: `proc-incarnation-${String(index).padStart(64, '0')}`,
      piSessionId: `pi-session-${String(index).padStart(64, '0')}`,
      extensionInstanceId: `ext-instance-${String(index).padStart(64, '0')}`,
      registrationAttempt: 1,
    }))
  }
  assert.equal(instance.snapshot().agents.length, 64)
  assert.throws(
    () => instance.register({ id: 'transport-65' }, registerBody({
      processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000065',
      piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000065',
      extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000065',
      registrationAttempt: 1,
    })),
    /limit|capacity|session/i,
  )
})

test('registry events are stable, ordered, persisted, and page-bounded', async () => {
  const { instance, persistence } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody())
  for (let sequence = 2; sequence <= 140; sequence += 1) {
    instance.heartbeat(connection, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: sequence,
      activity: sequence % 2 === 0 ? 'busy' : 'idle',
    }))
  }

  const events = instance.events()
  assert.equal(events.length, 128, 'one registry event page is bounded to 128 entries')
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].revision > events[index - 1].revision, 'events must be ordered by revision')
  }
  assert.deepEqual(persistence.snapshot(), {
    observerRevision: instance.snapshot().observerRevision,
  })
})

test('current transport authority uses object identity, not a caller-supplied equal transport id', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-1' }
  const registered = instance.register(connection, registerBody())
  assert.throws(
    () => instance.heartbeat({ id: 'transport-1' }, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: 2,
    })),
    /connection|current/i,
  )
  assert.equal(instance.snapshot().observerRevision, 1)
})

test('registration high-water marks survive lease expiry within one registry incarnation', async () => {
  const { instance, clock } = await createRegistry()
  instance.register({ id: 'transport-1' }, registerBody({ registrationAttempt: 3, sourceSequence: 5 }))
  clock.advance(15000)
  instance.expire()
  assert.equal(instance.snapshot().agents.length, 0)

  assert.throws(
    () => instance.register({ id: 'transport-2' }, registerBody({ registrationAttempt: 3, sourceSequence: 6 })),
    /stale|attempt|registration/i,
  )
  assert.throws(
    () => instance.register({ id: 'transport-2' }, registerBody({ registrationAttempt: 4, sourceSequence: 5 })),
    /sequence|monotonic|invalid/i,
  )
  assert.equal(
    instance.register({ id: 'transport-2' }, registerBody({ registrationAttempt: 4, sourceSequence: 6 })).acceptedRegistrationAttempt,
    4,
  )
})

test('registry rejects a capability issuer collision instead of reusing connection authority', async () => {
  const registry = await loadRegistry()
  const fakes = await loadFakes()
  const persistence = new fakes.FakeObserverPersistence()
  const first = 'capability-' + '0'.repeat(32)
  const second = 'capability-' + '1'.repeat(32)
  const issued = [first, second, first]
  const instance = new registry.AgentRegistry({
    clock: new fakes.FakeMonotonicClock(0),
    persistence,
    capabilityIssuer: { issue: () => issued.shift() ?? first },
    executionNodeId: 'execution-node-local',
  })
  assert.throws(
    () => instance.register({ id: 'transport-1' }, registerBody()),
    /capability|identity|fresh|invalid/i,
  )
  assert.equal(instance.snapshot().agents.length, 0)
  assert.equal(instance.snapshot().observerRevision, 0)
  assert.equal(persistence.snapshot(), null)
})

test('registry failures use bounded locally-authored detail without submitted identity values', async () => {
  const { instance } = await createRegistry()
  const connection = { id: 'transport-private-value' }
  const registered = instance.register(connection, registerBody({ registrationAttempt: 1 }))
  assert.throws(
    () => instance.heartbeat(connection, heartbeatBody({
      connectionId: registered.connectionId,
      connectionChallenge: registered.connectionChallenge,
      sourceSequence: 1,
    })),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message.includes(String(registered.connectionId)), false)
      assert.equal(error.message.includes('transport-private-value'), false)
      return true
    },
  )
})
