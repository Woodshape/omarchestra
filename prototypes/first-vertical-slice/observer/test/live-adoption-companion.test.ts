/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2.a red gate for the live Adoption Companion controller. These tests
 * are written against the bounded integration contract and are intended to
 * FAIL until `observer/live-adoption-companion.ts` is implemented in task 3.a.
 *
 * They cover the async request/confirmation consumption (H2), nullable
 * failure-result proposal fields (H3), and the combined authoritative
 * projection. No live resource is opened.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LiveAdoptionCompanion } from '../live-adoption-companion.ts'

const IDS = Object.freeze({
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  executionNodeId: 'execution-node-local',
  proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
  teamGoalId: 'team-goal-local-1',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

function makeCompanion() {
  const companion = new LiveAdoptionCompanion({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
  })
  companion.registerObserved({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  })
  return companion
}

test('request_adoption is consumed asynchronously and returns a bounded result', async () => {
  const companion = makeCompanion()
  const result = await companion.requestAdoption({
    intentId: 'intent-1',
    observedSessionId: IDS.observedSessionId,
    choiceId: 'adoption-choice-1',
  })
  assert.equal(result.intentId, 'intent-1')
  assert.equal(result.phase, 'proposal')
  assert.equal(result.proposalId, IDS.proposalId)
  assert.equal(result.session.teamGoalId, IDS.teamGoalId)
})

test('authorize_adoption confirms the exact proposal and returns a bounded result', async () => {
  const companion = makeCompanion()
  const proposed = await companion.requestAdoption({
    intentId: 'intent-1',
    observedSessionId: IDS.observedSessionId,
    choiceId: 'adoption-choice-1',
  })
  const result = await companion.authorizeAdoption({
    intentId: 'intent-2',
    proposalId: proposed.proposalId,
    proposalDigest: proposed.proposalDigest,
  })
  assert.equal(result.intentId, 'intent-2')
  assert.equal(result.phase, 'authorized')
})

test('a failure result may carry nullable proposal fields (H3)', async () => {
  const companion = makeCompanion()
  const result = await companion.requestAdoption({
    intentId: 'intent-3',
    observedSessionId: 'unknown-session',
    choiceId: 'adoption-choice-1',
  })
  assert.equal(result.phase, 'failed')
  assert.equal(result.proposalId, null)
  assert.equal(result.proposalDigest, null)
  assert.equal(result.code, 'session_unknown')
})

test('the combined projection publishes managed cards and Unassigned Agents from one snapshot', async () => {
  const companion = makeCompanion()
  const projection = companion.snapshot()
  assert.equal(projection.observerRevision, 0)
  assert.ok(Array.isArray(projection.agents))
  const managed = companion.managedSnapshot()
  assert.ok(Array.isArray(managed.managedCards))
})
