import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { BRIDGE_CAPABILITIES, decodeBridgeFrame, encodeBridgeFrame } from '../runner/bridge-protocol.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-session-eligibility-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => 1000 })
  t.after(() => { registry.close(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'view', pluginGeneration: 1, registry, clock: () => 1000 })
  const project = join(root, 'project'); mkdirSync(project)
  const git = spawnSync('git', ['init', '-q', project], { timeout: 5000, encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  const projectId = authority.confirmRegistration(authority.inspect(project).inspectionId).projectId
  runner.store.insertGoal({ goalId: 'goal', projectId, goalText: 'fixture', state: 'active', outcome: null, createdAt: 1000 })
  runner.store.setMeta('selected_goal_id', 'goal')
  function observe(letter: string, activity = 'idle', health = 'healthy') {
    let registered: Record<string, unknown> = {}, sequence = 1
    const peer = { send(bytes: Buffer) { const frame = decodeBridgeFrame(bytes.subarray(0, -1)); if (frame.type === 'registered') registered = frame.body }, close() {} }
    registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('register', 'register-' + letter, {
      processInstanceId: 'process-' + letter.repeat(32), extensionInstanceId: 'extension-' + letter.repeat(32), piSessionId: 'session-' + letter,
      hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES], registrationAttempt: 1, sourceSequence: sequence,
      lifecycle: 'running', activity, health,
    }).subarray(0, -1)))
    return { id: registered.observedSessionId as string, disconnect() { registry.disconnect(peer) },
      heartbeat(activity: string, health = 'healthy') {
        sequence++
        registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('heartbeat', 'heartbeat-' + sequence, {
          connectionId: registered.connectionId, connectionChallenge: registered.connectionChallenge,
          sourceSequence: sequence, lifecycle: 'running', activity, health,
        }).subarray(0, -1)))
      } }
  }
  const snapshot = () => validateSnapshot(buildSnapshot({ authority, adoption: authority.adoption, connection: 'connected' }))
  return { runner, authority, registry, observe, snapshot, projectId }
}

test('two connected running sessions expose the actual reason for different Adoption choices', t => {
  const s = fixture(t), busy = s.observe('a', 'busy'), idle = s.observe('b')
  let rows = s.snapshot().observedSessions
  assert.deepEqual(rows.map(r => [r.availability, r.lifecycle]), [['available', 'running'], ['available', 'running']])
  assert.deepEqual(rows.map(r => r.activity), ['busy', 'idle'])
  assert.equal(rows[0].adoptionReasonCode, 'session_busy')
  assert.match(rows[0].adoptionReason!, /busy/i)
  assert.deepEqual(rows[0].choices, [])
  assert.equal(rows[1].adoptionReason, null)
  assert.ok(rows[1].choices.some(c => c.role === 'implementer'))
  const choice = rows[1].choices[0].choiceId
  busy.heartbeat('idle')
  rows = s.snapshot().observedSessions
  assert.ok(rows.every(r => r.choices.length > 0 && r.adoptionReason === null))
  assert.equal(rows.find(r => r.observedSessionId === idle.id)!.choices[0].choiceId, choice, 'unchanged heartbeat retains exact choice')
  assert.equal(s.runner.store.listBindings().length, 0)
})

for (const [activity, health, code] of [
  ['unknown', 'healthy', 'activity_unknown'], ['waiting_for_user', 'healthy', 'waiting_for_user'],
  ['idle', 'degraded', 'session_unhealthy'],
]) test(`unavailable Adoption explains ${code}`, t => {
  const s = fixture(t); s.observe('a', activity, health)
  const row = s.snapshot().observedSessions[0]
  assert.equal(row.activity, activity); assert.equal(row.health, health)
  assert.equal(row.adoptionReasonCode, code); assert.ok(row.adoptionReason)
  assert.deepEqual(row.choices, [])
})

test('disconnected observation and missing Goal have distinct reasons', t => {
  const s = fixture(t), a = s.observe('a')
  a.disconnect()
  assert.equal(s.snapshot().observedSessions[0].adoptionReasonCode, 'session_unavailable')
  s.observe('b'); s.runner.store.setMeta('selected_goal_id', '')
  const row = s.snapshot().observedSessions[1]
  assert.equal(row.adoptionReasonCode, 'goal_required'); assert.deepEqual(row.choices, [])
})

test('an idle choice captured before busy activity cannot request Adoption', t => {
  const s = fixture(t), a = s.observe('a')
  const before = s.snapshot(), choiceId = before.observedSessions[0].choices[0].choiceId
  a.heartbeat('busy')
  const result = s.authority.handleIntent({ protocol: before.protocol, intentId: 'stale-idle-choice',
    sessionId: before.sessionId, pluginGeneration: before.pluginGeneration, runnerEpoch: before.runnerEpoch,
    expectedRevision: before.revision, kind: 'request_adoption', target: choiceId, payload: { choiceId } })
  assert.equal(result.status, 'rejected')
  assert.equal(s.runner.store.listProposals().length, 0)
  assert.equal(s.runner.store.listBindings().length, 0)
  assert.equal(s.snapshot().observedSessions[0].adoptionReasonCode, 'session_busy')
})

test('the snapshot validator rejects missing or unbounded eligibility facts', t => {
  const s = fixture(t); s.observe('a')
  for (const patch of [{ activity: undefined }, { activity: 'pretend_idle' },
    { adoptionReason: 'x'.repeat(513) }, { adoptionReasonCode: 42 }]) {
    const snapshot = s.snapshot()
    Object.assign(snapshot.observedSessions[0], patch)
    assert.throws(() => validateSnapshot(snapshot))
  }
})

test('reservation blocks competing Role choices and pending authorization cannot ignore activity', t => {
  const s = fixture(t), a = s.observe('a'), b = s.observe('b')
  const p = s.authority.adoption.propose({ projectId: s.projectId, goalId: 'goal', observedSessionId: a.id, role: 'implementer' })
  let rows = s.snapshot().observedSessions
  assert.equal(rows[0].choices[0].actionKind, 'authorize_adoption')
  assert.ok(rows[1].choices.every(c => c.role !== 'implementer'))
  // Reserve the other Role as well: the second row should explain the absence.
  s.authority.adoption.propose({ projectId: s.projectId, goalId: 'goal', observedSessionId: b.id, role: 'reviewer' })
  s.observe('c')
  assert.equal(s.snapshot().observedSessions[2].adoptionReasonCode, 'roles_unavailable')
  a.heartbeat('busy')
  const row = s.snapshot().observedSessions[0]
  assert.equal(row.adoptionReasonCode, 'session_busy')
  assert.equal(row.choices[0].enabled, false)
  assert.throws(() => s.authority.adoption.authorize(p.proposalId), /activity changed/)
  assert.equal(s.runner.store.listBindings().length, 0)
})
