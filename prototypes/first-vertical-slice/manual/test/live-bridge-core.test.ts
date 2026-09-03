import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveRoleLabelBridgeCore, type LiveBridgePorts } from '../live-bridge-core.ts'
import type { DecodedFrame } from '../../src/protocol.ts'

function fixture(role: 'coordinator' | 'builder' | 'reviewer' = 'builder') {
  const titles: string[] = []
  const statuses: Array<{ key: string; value: string }> = []
  const notices: Array<{ message: string; level: string }> = []
  const outbound: Array<{ type: string; body: Record<string, unknown> }> = []
  const turns: string[] = []
  let idle = true
  const ports: LiveBridgePorts = {
    setTitle: (title) => titles.push(title),
    setStatus: (key, value) => statuses.push({ key, value }),
    notify: (message, level) => notices.push({ message, level }),
    sendFrame: (type, body) => outbound.push({ type, body }),
    isIdle: () => idle,
    sendUserMessage: (prompt) => turns.push(prompt),
    onPresentationApplied: () => {},
  }
  const core = new LiveRoleLabelBridgeCore({
    teamGoalId: 'manual-goal',
    role,
    agentRunId: `manual-${role}-run`,
    extensionInstanceId: `manual-${role}-extension`,
  }, ports)
  return {
    core, titles, statuses, notices, outbound, turns,
    setIdle(value: boolean) { idle = value },
  }
}

function presentation(role: 'coordinator' | 'builder' | 'reviewer', state: string): DecodedFrame {
  const displayRole = role[0].toUpperCase() + role.slice(1)
  return {
    type: 'presentation_update',
    messageId: `presentation-${role}-${state}`,
    body: {
      role,
      agentRunId: `manual-${role}-run`,
      eventCursor: 1,
      nativeTerminalTitle: `Omarchestra — ${displayRole} — ${state}`,
      piStatus: `${displayRole} · ${state}`,
    },
  }
}

const assignment: DecodedFrame = {
  type: 'assignment',
  messageId: 'assignment-builder',
  body: {
    assignmentId: 'manual-builder-assignment',
    role: 'builder',
    agentRunId: 'manual-builder-run',
    prompt: 'Reply exactly: MANAGED BUILDER TURN COMPLETE',
  },
}

test('applies exact validated terminal-title and Pi-status presentation strings', () => {
  const f = fixture('builder')
  f.core.handleFrame(presentation('builder', 'waiting'))
  f.core.handleFrame(presentation('builder', 'managed'))
  assert.deepEqual(f.titles, [
    'Omarchestra — Builder — waiting',
    'Omarchestra — Builder — managed',
  ])
  assert.deepEqual(f.statuses, [
    { key: 'omarchestra-role-state', value: 'Builder · waiting' },
    { key: 'omarchestra-role-state', value: 'Builder · managed' },
  ])
})

test('queues the Builder assignment until explicit start and executes it exactly once', () => {
  const f = fixture('builder')
  f.core.handleFrame(assignment)
  assert.deepEqual(f.outbound, [])
  assert.deepEqual(f.turns, [])

  assert.equal(f.core.startQueuedAssignment(), 'started')
  assert.deepEqual(f.outbound, [{
    type: 'bridge.assignment_ack',
    body: { assignmentId: 'manual-builder-assignment', ack: 'accepted' },
  }])
  assert.deepEqual(f.turns, ['Reply exactly: MANAGED BUILDER TURN COMPLETE'])

  assert.equal(f.core.startQueuedAssignment(), 'already_started')
  assert.equal(f.turns.length, 1)
})

test('refuses to start while Pi is busy without consuming the queued assignment', () => {
  const f = fixture('builder')
  f.core.handleFrame(assignment)
  f.setIdle(false)
  assert.equal(f.core.startQueuedAssignment(), 'busy')
  assert.deepEqual(f.turns, [])
  assert.deepEqual(f.outbound, [])
  f.setIdle(true)
  assert.equal(f.core.startQueuedAssignment(), 'started')
  assert.equal(f.turns.length, 1)
})

test('ordinary Builder input emits takeover; the fixed gate phrase avoids a second model turn', () => {
  const f = fixture('builder')
  const result = f.core.observeInput('Manual takeover check', 'interactive')
  assert.equal(result, 'handled')
  assert.deepEqual(f.outbound, [{
    type: 'bridge.event',
    body: {
      eventId: 'manual-builder-extension-input-1',
      sequence: 1,
      eventType: 'human_input_submitted',
      payload: { inputSource: 'interactive', charCount: 21 },
    },
  }])
  assert.deepEqual(f.turns, [])
})

test('non-gate interactive input remains human-controllable and extension input is excluded', () => {
  const f = fixture('builder')
  assert.equal(f.core.observeInput('another human message', 'interactive'), 'continue')
  assert.equal(f.core.observeInput('managed work', 'extension'), 'continue')
  assert.equal(f.outbound.length, 1)
  assert.equal(f.outbound[0].type, 'bridge.event')
})
