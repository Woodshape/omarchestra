/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for the additive Companion observer projection. These tests
 * intentionally fail until `observer/companion-projection.ts` and the observer
 * additions to the Companion contract are implemented in Phase 6.
 *
 * Fixed public seam:
 *
 *   new CompanionObserverProjectionAdapter({ session, observer, sink,
 *     resultSink })
 *   - start() obtains one authoritative observer snapshot and subscribes.
 *   - current returns a cloned plain observer projection.
 *   - acceptSnapshot(session, snapshot) validates a current-session update.
 *   - submitIntent(session, intent) validates, forwards, and returns one
 *     bounded observer intent result.
 *   - stop() unsubscribes and clears only ephemeral observer presentation.
 *
 * This module is separate from AgentConsoleHandoff, its three managed cards,
 * the Team Runner cursor, LiveProjectionAdapter, and present_agent.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function loadProjection() {
  return await import('../companion-projection.ts')
}

const SESSION = Object.freeze({
  sessionId: 'companion-session-observer-1',
  teamGoalId: 'team-goal-console-1',
  clientId: 'observer-console-client-1',
  sessionGeneration: 1,
  pluginGeneration: 3,
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

function observerSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    observerRevision: 7,
    agents: [
      {
        observedSessionId: 'observed-session-1',
        piStatus: 'Unassigned · observed',
        lifecycle: 'running',
        availability: 'available',
        health: 'healthy',
        choices: [
          {
            choiceId: 'adoption-choice-1',
            label: 'Local goal · Builder',
            enabled: true,
          },
        ],
      },
    ],
    ...overrides,
  }
}

function proposalResult(overrides: Record<string, unknown> = {}) {
  return {
    session: clone(SESSION),
    intentId: 'observer-intent-request-1',
    phase: 'proposal',
    code: 'proposal_ready',
    detail: 'Confirm this exact current proposal.',
    proposalId: 'proposal-observer-1',
    proposalDigest: 'a'.repeat(64),
    remainingMs: 30000,
    displayLabel: 'Adopt as Local goal · Builder',
    ...overrides,
  }
}

function committedResult(overrides: Record<string, unknown> = {}) {
  return {
    session: clone(SESSION),
    intentId: 'observer-intent-authorize-1',
    phase: 'committed',
    code: 'committed',
    detail: 'Adoption committed.',
    proposalId: 'proposal-observer-1',
    proposalDigest: 'a'.repeat(64),
    remainingMs: null,
    displayLabel: 'Builder · managed',
    ...overrides,
  }
}

class FakeObserverPort {
  readonly submitted: Array<Record<string, unknown>> = []
  private value = observerSnapshot()
  private listener: ((value: unknown) => void) | null = null
  result: Record<string, unknown> = proposalResult()
  unsubscribed = 0

  snapshot(): Record<string, unknown> {
    return clone(this.value)
  }

  subscribe(listener: (value: unknown) => void): () => void {
    this.listener = listener
    return () => {
      this.unsubscribed += 1
      this.listener = null
    }
  }

  submitIntent(intent: Record<string, unknown>): Record<string, unknown> {
    this.submitted.push(clone(intent))
    return clone(this.result)
  }

  publish(value: Record<string, unknown>): void {
    this.value = clone(value)
    this.listener?.(clone(value))
  }
}

function staleSession(overrides: Record<string, unknown> = {}) {
  return { ...SESSION, sessionGeneration: 2, ...overrides }
}

async function harness() {
  const module = await loadProjection()
  const observer = new FakeObserverPort()
  const published: unknown[] = []
  const results: unknown[] = []
  const adapter = new module.CompanionObserverProjectionAdapter({
    session: clone(SESSION),
    observer,
    sink: (value: unknown) => published.push(clone(value)),
    resultSink: (value: unknown) => results.push(clone(value)),
  })
  return { module, observer, published, results, adapter }
}

test('observer capability is additive and leaves the six managed capabilities unchanged', async () => {
  const contracts = await import('../../companion/contracts.ts')
  assert.deepEqual(contracts.COMPANION_CAPABILITIES, [
    'session.open',
    'session.update',
    'session.intent',
    'session.hide',
    'session.clear',
    'session.resnapshot',
  ])
  assert.equal(contracts.COMPANION_OBSERVER_CAPABILITY, 'session.observer')
  assert.equal(contracts.COMPANION_CAPABILITIES.includes('session.observer'), false)
  const discovered = contracts.validateCapabilitiesEnvelope({
    protocol: 'omarchestra.companion/v1',
    pluginId: 'omarchestra.agent-console',
    version: '0.3.0',
    pluginGeneration: 3,
    capabilities: [...contracts.COMPANION_CAPABILITIES, 'session.observer'],
  })
  assert.equal(discovered.capabilities.includes('session.observer'), true)
  assert.doesNotThrow(() => contracts.assertRequiredCapabilities(discovered.capabilities))
})

test('plain observer projection is authoritative, bounded, and separate from the managed handoff', async () => {
  const { adapter, published } = await harness()
  await adapter.start()

  assert.deepEqual(adapter.current, observerSnapshot())
  assert.deepEqual(published, [observerSnapshot()])
  assert.deepEqual(Object.keys(adapter.current).sort(), ['agents', 'observerRevision'])
  assert.deepEqual(Object.keys(adapter.current.agents[0]).sort(), [
    'availability', 'choices', 'health', 'lifecycle', 'observedSessionId', 'piStatus',
  ].sort())
  assert.equal(adapter.current.agents[0].piStatus, 'Unassigned · observed')
  assert.equal(Object.hasOwn(adapter.current, 'cursor'), false, 'observer revision must not become the Team Runner cursor')
  assert.equal(Object.hasOwn(adapter.current, 'cards'), false, 'managed cards remain in AgentConsoleHandoff')

  const callerCopy = adapter.current
  callerCopy.agents.length = 0
  assert.equal(adapter.current.agents.length, 1, 'presentation callers cannot mutate authoritative adapter state')
})

test('observer projection exposes only opaque choices and no identity or management authority', async () => {
  const { adapter } = await harness()
  await adapter.start()
  const encoded = JSON.stringify(adapter.current)

  for (const forbidden of [
    'processIncarnationId', 'piSessionId', 'extensionInstanceId', 'connectionId',
    'connectionChallenge', 'hostPid', 'executionNodeId', 'teamGoalId', 'role',
    'assignment', 'controlMode', 'writerLease', 'runtimeBinding', 'prompt', 'pty',
  ]) {
    assert.equal(encoded.includes(forbidden), false, `QML projection must not contain ${forbidden}`)
  }
  assert.deepEqual(Object.keys(adapter.current.agents[0].choices[0]).sort(), [
    'choiceId', 'enabled', 'label',
  ])
})

test('forbidden or unknown content is rejected before observer presentation', async () => {
  const { module } = await harness()
  const forbidden = observerSnapshot({
    agents: [{
      ...observerSnapshot().agents[0],
      prompt: 'private prompt text',
    }],
  })

  assert.throws(
    () => module.validateObserverProjectionSnapshot(forbidden),
    /invalid|field|privacy|prompt/i,
  )
  assert.doesNotMatch(JSON.stringify(module.EMPTY_OBSERVER_PROJECTION ?? {}), /private prompt text/)
})

test('observer revisions are monotonic and stale updates cannot replace current presentation', async () => {
  const { adapter, observer } = await harness()
  await adapter.start()
  observer.publish(observerSnapshot({ observerRevision: 8, agents: [] }))
  assert.equal(adapter.current.observerRevision, 8)
  assert.deepEqual(adapter.current.agents, [])

  assert.throws(
    () => adapter.acceptSnapshot(clone(SESSION), observerSnapshot({ observerRevision: 7 })),
    /revision|stale|current/i,
  )
  assert.equal(adapter.current.observerRevision, 8)
})

test('request_adoption forwards only current session, intent, observed-session, and opaque choice identities', async () => {
  const { adapter, observer, results } = await harness()
  await adapter.start()

  const result = await adapter.submitIntent(clone(SESSION), {
    intentId: 'observer-intent-request-1',
    kind: 'request_adoption',
    observedSessionId: 'observed-session-1',
    choiceId: 'adoption-choice-1',
  })

  assert.deepEqual(observer.submitted, [{
    intentId: 'observer-intent-request-1',
    kind: 'request_adoption',
    observedSessionId: 'observed-session-1',
    choiceId: 'adoption-choice-1',
  }])
  assert.deepEqual(result, proposalResult())
  assert.deepEqual(results, [proposalResult()])
  assert.doesNotMatch(JSON.stringify(observer.submitted), /teamGoalId|executionNodeId|targetRole|registryRevision/)
})

test('authorize_adoption forwards only the exact proposal identity displayed for confirmation', async () => {
  const { adapter, observer } = await harness()
  await adapter.start()
  observer.result = committedResult()

  const result = await adapter.submitIntent(clone(SESSION), {
    intentId: 'observer-intent-authorize-1',
    kind: 'authorize_adoption',
    proposalId: 'proposal-observer-1',
    proposalDigest: 'a'.repeat(64),
  })

  assert.deepEqual(observer.submitted.at(-1), {
    intentId: 'observer-intent-authorize-1',
    kind: 'authorize_adoption',
    proposalId: 'proposal-observer-1',
    proposalDigest: 'a'.repeat(64),
  })
  assert.deepEqual(result, committedResult())
})

test('stale Projection Session rejects both request and confirmation before the observer port', async () => {
  const { adapter, observer } = await harness()
  await adapter.start()

  await assert.rejects(
    () => adapter.submitIntent(staleSession(), {
      intentId: 'stale-request',
      kind: 'request_adoption',
      observedSessionId: 'observed-session-1',
      choiceId: 'adoption-choice-1',
    }),
    /stale|session|generation/i,
  )
  await assert.rejects(
    () => adapter.submitIntent(staleSession({ pluginGeneration: 4 }), {
      intentId: 'stale-confirmation',
      kind: 'authorize_adoption',
      proposalId: 'proposal-observer-1',
      proposalDigest: 'a'.repeat(64),
    }),
    /stale|session|generation/i,
  )
  assert.deepEqual(observer.submitted, [])
})

test('intent validation rejects target authority supplied by QML and malformed proposal digests', async () => {
  const { adapter, observer } = await harness()
  await adapter.start()

  await assert.rejects(
    () => adapter.submitIntent(clone(SESSION), {
      intentId: 'authority-from-qml',
      kind: 'request_adoption',
      observedSessionId: 'observed-session-1',
      choiceId: 'adoption-choice-1',
      teamGoalId: 'team-goal-forged',
      role: 'builder',
    }),
    /invalid|field|intent|authority/i,
  )
  await assert.rejects(
    () => adapter.submitIntent(clone(SESSION), {
      intentId: 'bad-digest',
      kind: 'authorize_adoption',
      proposalId: 'proposal-observer-1',
      proposalDigest: 'not-a-digest',
    }),
    /digest|invalid|intent/i,
  )
  assert.deepEqual(observer.submitted, [])
})

test('observer intent results have exact fields and bounded plain data', async () => {
  const { module } = await harness()
  assert.deepEqual(module.validateObserverIntentResult(proposalResult()), proposalResult())
  assert.deepEqual(module.validateObserverIntentResult(committedResult()), committedResult())

  assert.throws(
    () => module.validateObserverIntentResult(proposalResult({ detail: 'x'.repeat(1025) })),
    /bound|detail|large|1024/i,
  )
  assert.throws(
    () => module.validateObserverIntentResult(proposalResult({ extra: true })),
    /field|invalid|result/i,
  )
  assert.throws(
    () => module.validateObserverIntentResult(proposalResult({ remainingMs: 30001 })),
    /remaining|duration|invalid|30000/i,
  )
})

test('stop clears only ephemeral observer presentation and unsubscribes once', async () => {
  const { adapter, observer } = await harness()
  await adapter.start()
  adapter.stop()
  adapter.stop()

  assert.equal(adapter.current, null)
  assert.equal(observer.unsubscribed, 1)
  assert.deepEqual(observer.submitted, [])
})
