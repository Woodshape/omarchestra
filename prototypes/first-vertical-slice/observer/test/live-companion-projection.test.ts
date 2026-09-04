/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only tests for the narrow Companion 0.3.0 observation publisher. They
 * inject a fake narrow shell port and never open a socket, launch a process,
 * inspect installed Companion state, or contact a live system.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPANION_CAPABILITIES,
  COMPANION_OBSERVER_CAPABILITY,
  COMPANION_PLUGIN_ID,
  COMPANION_PROTOCOL_ID,
  type CompanionCapabilitiesEnvelope,
} from '../../companion/contracts.ts'
import {
  LiveCompanionProjection,
  OBSERVER_COMPANION_RELEASE_VERSION,
  type ObserverCompanionShellPort,
} from '../live-companion-projection.ts'

class FakeObserverShell implements ObserverCompanionShellPort {
  capabilitiesResult: CompanionCapabilitiesEnvelope
  readonly calls: Array<{ method: string; payload: string }> = []
  failCall = false

  constructor(capabilitiesResult: CompanionCapabilitiesEnvelope) {
    this.capabilitiesResult = capabilitiesResult
  }

  async capabilities(pluginId: string): Promise<CompanionCapabilitiesEnvelope> {
    return this.capabilitiesResult
  }

  async call(pluginId: string, method: 'applyObservedAgents', payloadJson: string): Promise<string> {
    this.calls.push({ method, payload: payloadJson })
    if (this.failCall) throw new Error('shell call failed')
    return 'true'
  }
}

function observerCapabilities(overrides: Record<string, unknown> = {}): CompanionCapabilitiesEnvelope {
  return {
    protocol: COMPANION_PROTOCOL_ID,
    pluginId: COMPANION_PLUGIN_ID,
    version: OBSERVER_COMPANION_RELEASE_VERSION,
    pluginGeneration: 1,
    capabilities: [...COMPANION_CAPABILITIES, COMPANION_OBSERVER_CAPABILITY],
    ...overrides,
  } as CompanionCapabilitiesEnvelope
}

function projection(revision: number, overrides: Record<string, unknown> = {}) {
  return {
    observerRevision: revision,
    agents: [{
      observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
      piStatus: 'Unassigned · observed',
      lifecycle: 'running',
      availability: 'available',
      health: 'healthy',
      choices: [],
      ...overrides,
    }],
  }
}

test('verify accepts the exact observer release with session.observer', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.verify()
  assert.equal(shell.calls.length, 0)
})

test('verify rejects a non-observer release version', async () => {
  const shell = new FakeObserverShell(observerCapabilities({ version: '0.2.0' }))
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(() => publisher.verify(), /unsupported_compatibility/)
})

test('verify rejects a missing session.observer capability', async () => {
  const shell = new FakeObserverShell(observerCapabilities({
    capabilities: [...COMPANION_CAPABILITIES],
  }))
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(() => publisher.verify(), /unsupported_capability/)
})

test('verify rejects a missing baseline capability', async () => {
  const shell = new FakeObserverShell(observerCapabilities({
    capabilities: [COMPANION_CAPABILITIES[0], COMPANION_OBSERVER_CAPABILITY],
  }))
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(() => publisher.verify(), /unsupported_capability/)
})

test('verify rejects a foreign plugin identity', async () => {
  const shell = new FakeObserverShell(observerCapabilities({ pluginId: 'other.plugin' }))
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(() => publisher.verify(), /unsupported_compatibility/)
})

test('publish sends a sessionless payload with empty choices', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))

  assert.equal(shell.calls.length, 1)
  assert.equal(shell.calls[0].method, 'applyObservedAgents')
  const payload = JSON.parse(shell.calls[0].payload) as {
    observerProjection: { observerRevision: number; agents: Array<{ choices: unknown[] }> }
  }
  assert.equal(payload.observerProjection.observerRevision, 1)
  assert.equal(payload.observerProjection.agents.length, 1)
  assert.deepEqual(payload.observerProjection.agents[0].choices, [])
  assert.equal(publisher.acceptedRevision, 1)
})

test('publish ignores a stale non-increasing revision', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(2))
  assert.equal(shell.calls.length, 1)

  await publisher.publish(projection(2))
  assert.equal(shell.calls.length, 1, 'a duplicate revision must not be republished')

  await publisher.publish(projection(1))
  assert.equal(shell.calls.length, 1, 'a lower revision must not be republished')
  assert.equal(publisher.acceptedRevision, 2)
})

test('publish validates the projection and rejects an invalid snapshot', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(
    () => publisher.publish({ observerRevision: 1, agents: [{ observedSessionId: 'x' }] }),
    /invalid_envelope/,
  )
  assert.equal(shell.calls.length, 0)
})

test('a shell publication failure throws and is isolated by the caller', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  shell.failCall = true
  await assert.rejects(() => publisher.publish(projection(1)), /shell call failed/)
  assert.equal(publisher.acceptedRevision, -1, 'a failed publish must not advance the revision')
})

test('publish verifies capabilities lazily on the first call', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))
  assert.equal(shell.calls.length, 1)
  assert.equal(shell.calls[0].method, 'applyObservedAgents')
})
