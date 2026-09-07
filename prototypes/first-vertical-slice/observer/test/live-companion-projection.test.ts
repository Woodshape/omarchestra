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
  type ObserverCompanionShellMethod,
  type ObserverCompanionShellPort,
} from '../live-companion-projection.ts'

class FakeObserverShell implements ObserverCompanionShellPort {
  capabilitiesResult: CompanionCapabilitiesEnvelope
  readonly calls: Array<{ method: string; payload: string }> = []
  readonly events: string[] = []
  failCall = false
  private callGate: Promise<void> | null = null
  private releaseCallGate: (() => void) | null = null
  private firstCallResolve: (() => void) | null = null
  readonly firstCallStarted: Promise<void>

  constructor(capabilitiesResult: CompanionCapabilitiesEnvelope) {
    this.capabilitiesResult = capabilitiesResult
    this.firstCallStarted = new Promise((resolve) => {
      this.firstCallResolve = resolve
    })
  }

  async capabilities(pluginId: string): Promise<CompanionCapabilitiesEnvelope> {
    this.events.push('capabilities')
    return this.capabilitiesResult
  }

  async call(pluginId: string, method: ObserverCompanionShellMethod, payloadJson: string): Promise<string> {
    this.calls.push({ method, payload: payloadJson })
    this.events.push(method)
    this.firstCallResolve?.()
    this.firstCallResolve = null
    if (this.callGate !== null) await this.callGate
    if (this.failCall) throw new Error('shell call failed')
    return 'true'
  }

  holdCalls(): void {
    if (this.callGate !== null) throw new Error('call gate is already held')
    this.callGate = new Promise((resolve) => {
      this.releaseCallGate = resolve
    })
  }

  releaseCalls(): void {
    const release = this.releaseCallGate
    this.releaseCallGate = null
    this.callGate = null
    release?.()
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

test('publish opens a sessionless panel with empty choices', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))

  assert.equal(shell.calls.length, 1)
  assert.equal(shell.calls[0].method, 'openObservedAgents')
  const payload = JSON.parse(shell.calls[0].payload) as {
    observerProjection: { observerRevision: number; agents: Array<{ choices: unknown[] }> }
  }
  assert.equal(payload.observerProjection.observerRevision, 1)
  assert.equal(payload.observerProjection.agents.length, 1)
  assert.deepEqual(payload.observerProjection.agents[0].choices, [])
  assert.equal(publisher.acceptedRevision, 1)
})

test('publish serializes capabilities, open, apply, and clear in observer-only order', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })

  await publisher.publish(projection(1))
  await publisher.publish(projection(2))
  await publisher.clearObservedAgents()

  assert.deepEqual(shell.events, [
    'capabilities',
    'openObservedAgents',
    'applyObservedAgents',
    'clearObservedAgents',
  ])
  assert.deepEqual(shell.calls.map((call) => call.method), [
    'openObservedAgents',
    'applyObservedAgents',
    'clearObservedAgents',
  ])
})

test('publish ignores duplicate and stale revisions, including after clear', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(2))
  await publisher.clearObservedAgents()
  assert.equal(publisher.acceptedRevision, 2)

  await publisher.publish(projection(2))
  assert.equal(shell.calls.length, 2, 'a duplicate revision must not be republished')

  await publisher.publish(projection(1))
  assert.equal(shell.calls.length, 2, 'a lower revision must not be republished')
  assert.equal(publisher.acceptedRevision, 2)

  await publisher.publish(projection(3))
  assert.equal(shell.calls[2].method, 'openObservedAgents', 'a newer revision starts a fresh observer presentation')
  assert.equal(publisher.acceptedRevision, 3)
})

test('concurrent publishes serialize shell calls and preserve open-before-apply order', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  shell.holdCalls()
  const publisher = new LiveCompanionProjection({ shell })

  const first = publisher.publish(projection(1))
  const second = publisher.publish(projection(2))
  await shell.firstCallStarted

  assert.deepEqual(shell.calls.map((call) => call.method), ['openObservedAgents'])
  shell.releaseCalls()
  await Promise.all([first, second])

  assert.deepEqual(shell.calls.map((call) => call.method), [
    'openObservedAgents',
    'applyObservedAgents',
  ])
  assert.equal(publisher.acceptedRevision, 2)
})

test('publish validates standalone projections before capability discovery or opening', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await assert.rejects(
    () => publisher.publish({ observerRevision: 1, agents: [{ observedSessionId: 'x' }] }),
    /invalid_envelope/,
  )
  await assert.rejects(
    () => publisher.publish({
      ...projection(2),
      agents: [{ ...projection(2).agents[0], choices: [{ choiceId: 'choice-1', label: 'managed', enabled: true }] }],
    }),
    /invalid_envelope/,
  )
  assert.deepEqual(shell.events, [], 'invalid data must not discover or mutate the shell')
  assert.equal(publisher.acceptedRevision, -1)
})

test('a failed open preserves lifecycle state and retries open', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  shell.failCall = true
  await assert.rejects(() => publisher.publish(projection(1)), /shell call failed/)
  assert.equal(publisher.acceptedRevision, -1, 'a failed publish must not advance the revision')

  shell.failCall = false
  await publisher.publish(projection(1))
  assert.deepEqual(shell.calls.map((call) => call.method), [
    'openObservedAgents',
    'openObservedAgents',
  ])
  assert.equal(publisher.acceptedRevision, 1)
})

test('a failed update preserves the accepted revision and retries apply', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))

  shell.failCall = true
  await assert.rejects(() => publisher.publish(projection(2)), /shell call failed/)
  assert.equal(publisher.acceptedRevision, 1)

  shell.failCall = false
  await publisher.publish(projection(2))
  assert.deepEqual(shell.calls.map((call) => call.method), [
    'openObservedAgents',
    'applyObservedAgents',
    'applyObservedAgents',
  ])
  assert.equal(publisher.acceptedRevision, 2)
})

test('a failed clear preserves the open lifecycle and accepted revision', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))

  shell.failCall = true
  await assert.rejects(() => publisher.clearObservedAgents(), /shell call failed/)
  assert.equal(publisher.acceptedRevision, 1)

  shell.failCall = false
  await publisher.publish(projection(2))
  assert.equal(shell.calls[1].method, 'clearObservedAgents')
  assert.equal(shell.calls[2].method, 'applyObservedAgents')
})

test('publish verifies capabilities lazily before the first open', async () => {
  const shell = new FakeObserverShell(observerCapabilities())
  const publisher = new LiveCompanionProjection({ shell })
  await publisher.publish(projection(1))
  assert.deepEqual(shell.events, ['capabilities', 'openObservedAgents'])
})
