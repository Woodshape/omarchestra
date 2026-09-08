/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 4.a tests for same-process managed activation and disconnect/recovery
 * of the live Adoption slice. They verify the committed managed bridge is
 * inert until a durable commit, activates only after committed delivery, and
 * deactivates on runner connection loss. No live resource is opened.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LiveAdoptionManagedBridge } from '../../manual/live-adoption-extension.ts'
import { createInMemoryAdoptionStore } from '../live-adoption-store.ts'
import { LiveAdoptionRunner } from '../live-adoption-runner.ts'

const IDS = Object.freeze({
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  executionNodeId: 'execution-node-local',
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
  connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
  proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
  acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
  teamGoalId: 'team-goal-local-1',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

const CONNECTION = { id: 'transport-1' }

function committedView() {
  return {
    proposalId: IDS.proposalId,
    proposalDigest: PROPOSAL_DIGEST,
    agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
    targetTeamGoalId: IDS.teamGoalId,
    targetRole: 'builder',
    controlMode: 'managed',
    piStatus: 'Builder · managed',
    terminalTitleMetadata: 'Omarchestra — Builder — managed',
    runtimeBindingGuarantee: 'unavailable',
  }
}

function observedRecord() {
  return {
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }
}

test('the managed bridge is inert before commit and activates only after committed delivery', () => {
  const bridge = new LiveAdoptionManagedBridge()
  assert.equal(bridge.enabled, false)
  assert.equal(bridge.committed, null)
  // Ordinary input before commit is untouched.
  assert.equal(bridge.handleInput('hello', 'interactive'), false)

  bridge.enable(committedView())
  assert.equal(bridge.enabled, true)
  assert.equal(bridge.committed.targetRole, 'builder')
  assert.equal(bridge.committed.controlMode, 'managed')
  // Managed input is consumed only by the committed bridge.
  assert.equal(bridge.handleInput('managed input', 'interactive'), true)
  // Extension-originated input is not treated as managed user input.
  assert.equal(bridge.handleInput('extension', 'extension'), false)
})

test('the managed bridge deactivates on runner connection loss and clears committed state', () => {
  const bridge = new LiveAdoptionManagedBridge()
  bridge.enable(committedView())
  assert.equal(bridge.enabled, true)
  bridge.disable()
  assert.equal(bridge.enabled, false)
  assert.equal(bridge.committed, null)
  assert.equal(bridge.handleInput('after loss', 'interactive'), false)
})

test('the runner activates the managed bridge only after commit and revokes it on connection loss', async () => {
  const store = createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const bridge = new LiveAdoptionManagedBridge()
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
    managedBridge: {
      enable: (committed) => bridge.enable(committed),
      disable: () => bridge.disable(),
    },
  })
  runner.registerObserved(observedRecord(), CONNECTION)

  // Before commit the bridge is inert.
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  assert.equal(bridge.enabled, false)

  // After commit the bridge activates.
  await runner.acceptAcknowledgement(CONNECTION, {
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 7,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
  })
  assert.equal(bridge.enabled, true)
  assert.equal(runner.managedBridgeEnabled, true)

  // Runner connection loss revokes readiness and deactivates the bridge.
  runner.onConnectionLost()
  assert.equal(bridge.enabled, false)
  assert.equal(runner.managedBridgeEnabled, false)
  assert.equal(runner.dispatchCount, 0)
})
