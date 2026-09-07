/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Fake-only tests for the standalone observer-only Companion panel lifecycle
 * as modeled by FakeCompanionShell. They drive the injected shell surface
 * directly through openObservedAgents / applyObservedAgents /
 * clearObservedAgents and prove:
 *
 *   - a valid empty-initial observer open makes the panel visible and a later
 *     update re-renders it without re-opening;
 *   - invalid status, shape, or non-empty choices are rejected without
 *     opening, recording a call, or mutating any state;
 *   - observer opening fabricates no Projection Session identity, managed
 *     projection, cards, or cursor;
 *   - observer clear hides the panel when observer-only and resets observer
 *     state;
 *   - observer open/update/clear never change an already-open managed
 *     session's projection, cards, cursor, identity, or visibility.
 *
 * Every test is injected and I/O-free: no socket, process, terminal, GUI,
 * Pi, provider, SSH, Boomux, systemd, or installed Companion state.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPANION_PLUGIN_ID,
} from '../contracts.ts'
import { FakeCompanionShell } from '../fake-companion-shell.ts'

type ObserverAgent = Record<string, unknown>
interface ObserverProjectionShape {
  observerRevision: number
  agents: ObserverAgent[]
}

/** A structurally valid standalone observer projection (empty choices). */
function observerProject(revision: number, agentCount = 1): ObserverProjectionShape {
  const agents: ObserverAgent[] = []
  for (let index = 0; index < agentCount; index += 1) {
    agents.push({
      observedSessionId: `observed-session-${revision}-${index}`,
      piStatus: 'Unassigned · observed',
      lifecycle: 'running',
      availability: 'available',
      health: 'healthy',
      choices: [],
    })
  }
  return { observerRevision: revision, agents }
}

/** A valid managed open envelope for summon(pluginId, payload). */
function managedOpenEnvelope(): Record<string, unknown> {
  return {
    protocol: 'omarchestra.companion/v1',
    sessionId: 'companion-session-managed',
    teamGoalId: 'team-goal-a',
    clientId: 'client-1',
    sessionGeneration: 1,
    pluginGeneration: 1,
    projection: {
      status: 'ready',
      cursor: 9,
      cards: [
        { role: 'coordinator', agentRunId: 'agent-run-coordinator', piStatus: 'Coordinator · waiting' },
        { role: 'builder', agentRunId: 'agent-run-builder', piStatus: 'Builder · managed' },
        { role: 'reviewer', agentRunId: 'agent-run-reviewer', piStatus: 'Reviewer · waiting' },
      ],
    },
  }
}

function openObserver(shell: FakeCompanionShell, projection: ObserverProjectionShape): void {
  shell.call(COMPANION_PLUGIN_ID, 'openObservedAgents', JSON.stringify({ observerProjection: projection }))
}

function applyObserver(shell: FakeCompanionShell, projection: ObserverProjectionShape): void {
  shell.call(COMPANION_PLUGIN_ID, 'applyObservedAgents', JSON.stringify({ observerProjection: projection }))
}

function clearObserver(shell: FakeCompanionShell): void {
  shell.call(COMPANION_PLUGIN_ID, 'clearObservedAgents', '{}')
}

test('a valid empty-initial observer open makes the panel visible and a later update re-renders it without reopening', () => {
  const shell = new FakeCompanionShell()
  openObserver(shell, observerProject(1, 0))

  assert.equal(shell.panel.observerOpen, true)
  assert.equal(shell.panel.visible, true)
  assert.equal(shell.panel.observerProjection.observerRevision, 1)
  assert.deepEqual(shell.panel.observerProjection.agents, [])
  assert.equal(shell.panel.managedSession, null)
  assert.equal(shell.panel.managedCursor, null)
  assert.deepEqual(shell.panel.managedCards, [])

  applyObserver(shell, observerProject(2, 1))
  // Still observer-open; the panel stays visible; projection advanced.
  assert.equal(shell.panel.observerOpen, true)
  assert.equal(shell.panel.visible, true)
  assert.equal(shell.panel.observerProjection.observerRevision, 2)
  assert.equal(shell.panel.observerProjection.agents.length, 1)
  assert.equal(shell.panel.observerProjection.agents[0].piStatus, 'Unassigned · observed')

  const methods = shell.calls().filter((call) => call.method !== undefined).map((call) => call.method)
  assert.deepEqual(methods, ['openObservedAgents', 'applyObservedAgents'])
})

test('invalid status, payload shape, session-bearing, or non-empty-choice opens are rejected without opening or mutation', () => {
  const rejectOpen = (payload: unknown): void => {
    const shell = new FakeCompanionShell()
    const callsBefore = shell.calls().length
    assert.throws(
      () => shell.call(COMPANION_PLUGIN_ID, 'openObservedAgents', JSON.stringify(payload)),
      /invalid_envelope/,
    )
    assert.equal(shell.panel.observerOpen, false, 'an invalid observer open must not open')
    assert.equal(shell.panel.visible, false, 'an invalid observer open must not show the panel')
    assert.deepEqual(shell.panel.observerProjection, { observerRevision: 0, agents: [] })
    assert.equal(shell.calls().length, callsBefore, 'an invalid observer open must record no call')
    assert.equal(shell.panel.observerProjections.length, 0)
  }

  // wrong piStatus
  const badStatus = observerProject(1, 1)
  badStatus.agents[0].piStatus = 'Runner · active'
  rejectOpen({ observerProjection: badStatus })

  // non-empty choices are never accepted by the standalone panel
  const badChoices = observerProject(1, 1)
  badChoices.agents[0].choices = [{ choiceId: 'c1', label: 'Local goal · Builder', enabled: true }]
  rejectOpen({ observerProjection: badChoices })

  // raw projection (not the exact { observerProjection } wrapper)
  rejectOpen(observerProject(1, 0))

  // session-bearing or otherwise non-exact envelope
  rejectOpen({ session: { sessionId: 'x' }, observerProjection: observerProject(1, 0) })
  rejectOpen({ observerProjection: observerProject(1, 0), extra: true })

  // malformed / non-object
  rejectOpen('not-json-object')
  rejectOpen(null)
})

test('observer opening fabricates no Projection Session identity, managed projection, cards, or cursor', () => {
  const shell = new FakeCompanionShell()
  openObserver(shell, observerProject(1, 2))

  assert.equal(shell.panel.managedSession, null)
  assert.equal(shell.panel.managedProjection, null)
  assert.deepEqual(shell.panel.managedCards, [])
  assert.equal(shell.panel.managedCursor, null)
  assert.equal(shell.panel.managedVisible, false)
  assert.deepEqual(shell.panel.handoffs, [])

  // the panel is visible solely because the observer opened it
  assert.equal(shell.panel.visible, true)
  assert.equal(shell.panel.observerOpen, true)
  assert.equal(shell.panel.observerProjection.agents.length, 2)
  assert.equal(shell.panel.observerProjections.length, 1)
})

test('observer clear hides the panel when observer-only and resets observer state without touching managed state', () => {
  const shell = new FakeCompanionShell()
  openObserver(shell, observerProject(1, 1))
  assert.equal(shell.panel.visible, true)

  clearObserver(shell)

  assert.equal(shell.panel.observerOpen, false)
  assert.equal(shell.panel.visible, false)
  assert.deepEqual(shell.panel.observerProjection, { observerRevision: 0, agents: [] })
  assert.equal(shell.panel.observerProjections.length, 1, 'clear itself records a call but adds no projection')
  assert.equal(shell.panel.managedSession, null)
  assert.deepEqual(shell.panel.managedCards, [])
  assert.equal(shell.panel.managedCursor, null)
})

test('observer open, update, and clear leave an active managed session projection and visibility untouched', () => {
  const shell = new FakeCompanionShell()
  shell.summon(COMPANION_PLUGIN_ID, JSON.stringify(managedOpenEnvelope()))
  assert.equal(shell.panel.managedVisible, true)
  assert.equal(shell.panel.visible, true)

  const managedBefore = {
    managedVisible: shell.panel.managedVisible,
    visible: shell.panel.visible,
    managedSession: structuredClone(shell.panel.managedSession),
    managedProjection: structuredClone(shell.panel.managedProjection),
    managedCards: structuredClone(shell.panel.managedCards),
    managedCursor: shell.panel.managedCursor,
    handoffsLength: shell.panel.handoffs.length,
  }

  openObserver(shell, observerProject(1, 1))
  const managedObserverProjection = observerProject(2, 1)
  managedObserverProjection.agents[0].choices = [
    { choiceId: 'choice-1', label: 'Local goal · Builder', enabled: true },
  ]
  shell.call(COMPANION_PLUGIN_ID, 'applyObservedAgents', JSON.stringify({
    session: managedBefore.managedSession,
    observerProjection: managedObserverProjection,
  }))
  clearObserver(shell)

  // managed identity, projection, cards, cursor, and visibility are intact
  assert.equal(shell.panel.managedVisible, managedBefore.managedVisible)
  assert.equal(shell.panel.visible, true, 'an already-open managed panel must stay visible after observer clear')
  assert.deepEqual(shell.panel.managedSession, managedBefore.managedSession)
  assert.deepEqual(shell.panel.managedProjection, managedBefore.managedProjection)
  assert.deepEqual(shell.panel.managedCards, managedBefore.managedCards)
  assert.equal(shell.panel.managedCursor, managedBefore.managedCursor)
  assert.equal(shell.panel.handoffs.length, managedBefore.handoffsLength)

  // observer state is independently cleared
  assert.equal(shell.panel.observerOpen, false)
  assert.deepEqual(shell.panel.observerProjection, { observerRevision: 0, agents: [] })
})

test('an invalid observer update is rejected without changing the current observer projection or call log', () => {
  const shell = new FakeCompanionShell()
  openObserver(shell, observerProject(1, 1))
  const before = structuredClone(shell.panel.observerProjection)
  const callsBefore = shell.calls().length

  const bad = observerProject(3, 1)
  bad.agents[0].choices = [{ choiceId: 'c1', label: 'Local goal · Builder', enabled: true }]
  assert.throws(
    () => applyObserver(shell, bad),
    /invalid_envelope/,
  )

  assert.deepEqual(shell.panel.observerProjection, before)
  assert.equal(shell.calls().length, callsBefore)
  assert.equal(shell.panel.observerOpen, true)
  assert.equal(shell.panel.observerProjections.length, 1)
})
