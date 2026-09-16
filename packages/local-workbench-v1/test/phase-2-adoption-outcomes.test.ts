import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import type { TransportEvent, WorkbenchFrame, ObserverPort } from '../runner/transport.ts'

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-adoption-outcome-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  const handlers = new Set<(event: TransportEvent) => void>(), frames: WorkbenchFrame[] = []
  const port: ObserverPort = { transportId: 'port', send: frame => { frames.push(frame) }, subscribe: handler => { handlers.add(handler); return () => { handlers.delete(handler) } }, close: () => handlers.clear() }
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1, transport: () => port })
  t.after(() => { authority.adoption.unbind(); port.close(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  runner.store.putProject({ projectId: 'project', executionNodeId: runner.nodeId, canonicalPath: join(root, 'project'), gitCommonDir: join(root, 'project/.git'), headOid: null, dirty: false, contextDigest: null, revision: 0, createdAt: 1 })
  runner.store.insertGoal({ goalId: 'goal', projectId: 'project', goalText: 'Test', state: 'active', outcome: null, createdAt: 1 })
  runner.store.setMeta('selected_project_id', 'project')
  runner.store.setMeta('selected_goal_id', 'goal')
  const emit = (event: Partial<TransportEvent> & Pick<TransportEvent, 'type'>) => {
    const frame: TransportEvent = { runId: '', bindingDigest: '', transportId: 'port', source: 'extension', detail: '', ...event }
    for (const handler of [...handlers]) handler(frame)
  }
  emit({ type: 'session_observed', observedSessionId: 'observed', role: 'implementer' })
  const intent = { intentId: 'request', sessionId: 'session', pluginGeneration: 1, runnerEpoch: runner.epoch, expectedRevision: 0,
    kind: 'request_adoption', target: null, payload: { choiceId: authority.observedChoices[0].choiceId } as Record<string, unknown> }
  return { runner, authority, intent, frames, emit }
}

for (const when of ['before', 'after']) test(`request Adoption receipt failure ${when} insertion restores the observation and proposal`, t => {
  const s = setup(t)
  const observations = s.authority.observedChoices
  const write = s.runner.store.putIntentResult.bind(s.runner.store)
  s.runner.store.putIntentResult = row => { if (when === 'after') write(row); throw Error('receipt fault') }
  assert.throws(() => s.authority.handleIntent(s.intent), /receipt fault/)
  assert.equal(s.runner.store.listBindings().length, 0)
  assert.equal(s.runner.store.listEvents().length, 0)
  assert.equal(s.authority.currentRevision, 0)
  assert.equal(s.authority.adoption.retainedProposals().length, 0)
  assert.deepEqual(s.authority.observedChoices, observations)
  assert.equal(s.runner.store.getIntentResult('request'), null)
  assert.equal(s.frames.length, 0)
  s.runner.store.putIntentResult = write
  const result = s.authority.handleIntent(s.intent)
  assert.equal(result.status, 'acknowledged')
  assert.deepEqual(s.authority.handleIntent(s.intent), result)
  assert.equal(s.authority.adoption.retainedProposals().length, 1)
  assert.equal(s.runner.store.listBindings().length, 1)
  assert.equal(s.frames.length, 0, 'requesting Adoption does not deliver an adopt frame')
})

test('Take control outcome rolls back with its effect and replays without a second epoch bump', t => {
  const s = setup(t)
  assert.equal(s.authority.handleIntent(s.intent).status, 'acknowledged')
  const proposal = s.authority.adoption.retainedProposals()[0]
  s.authority.adoption.authorize(proposal.proposalId)
  const identity = { runId: proposal.runId, bindingDigest: proposal.proposalDigest, nonce: proposal.nonce }
  s.emit({ type: 'adopt_ack', ...identity })
  s.emit({ type: 'readiness', ...identity })
  const before = s.runner.store.getBinding(proposal.runId)!, revision = s.authority.currentRevision
  const command = { ...s.intent, intentId: 'control', kind: 'take_control', expectedRevision: revision, payload: { agentRunId: proposal.runId } }
  const write = s.runner.store.putIntentResult.bind(s.runner.store)
  s.runner.store.putIntentResult = row => { write(row); throw Error('receipt fault') }
  assert.throws(() => s.authority.handleIntent(command), /receipt fault/)
  assert.deepEqual(s.runner.store.getBinding(proposal.runId), before)
  assert.equal(s.runner.store.getIntentResult('control'), null)
  assert.equal(s.authority.currentRevision, revision)
  s.runner.store.putIntentResult = write
  const result = s.authority.handleIntent(command)
  assert.equal(result.status, 'acknowledged')
  assert.deepEqual(s.authority.handleIntent(command), result)
  assert.equal(s.runner.store.getBinding(proposal.runId)?.controlEpoch, before.controlEpoch + 1)
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'manual_takeover')
})

test('operator Take control cannot grant management to an uncommitted proposal', t => {
  const s = setup(t)
  s.authority.handleIntent(s.intent)
  const proposal = s.authority.adoption.retainedProposals()[0]
  const result = s.authority.handleIntent({ ...s.intent, intentId: 'early-control', kind: 'take_control', expectedRevision: s.authority.currentRevision, payload: { agentRunId: proposal.runId } })
  assert.equal(result.status, 'rejected')
  assert.equal(s.runner.store.getBinding(proposal.runId)?.state, 'proposed')
  assert.equal(s.runner.store.getBinding(proposal.runId)?.controlEpoch, 0)
})
