/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 3.a durability and crash-boundary tests for the live Adoption slice.
 * They exercise the durable SQLite adapter and the runner's recovery through
 * isolated disposable test state (a temp database file), never a live socket
 * or installed state.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LiveAdoptionStore } from '../../manual/live-adoption-store.ts'
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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-adoption-'))
  return path.join(dir, 'adoption.sqlite')
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

function commitInput() {
  return {
    proposal: {
      proposalId: IDS.proposalId,
      proposalDigest: PROPOSAL_DIGEST,
      observedSessionId: IDS.observedSessionId,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      connectionId: IDS.connectionId,
      connectionChallenge: IDS.connectionChallenge,
      registryRevision: 7,
      targetTeamGoalId: IDS.teamGoalId,
      targetExecutionNodeId: IDS.executionNodeId,
      targetRole: 'builder',
      createdMonotonic: 0,
      expiresMonotonic: 30000,
      acknowledgementNonce: IDS.acknowledgementNonce,
    },
    authorization: { proposalId: IDS.proposalId, proposalDigest: PROPOSAL_DIGEST },
    acknowledgement: { decision: 'acknowledged', activity: 'idle' },
    observed: observedRecord(),
    reconciliation: { activity: 'idle', sourceSequence: 2 },
  }
}

test('the durable store commits atomically and enforces role and identity uniqueness', () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const committed = store.transaction((tx) => tx.commitAdoption(commitInput()))
  assert.equal(committed.controlMode, 'managed')
  assert.equal(committed.runtimeBindingGuarantee, 'unavailable')
  assert.equal(store.snapshot().committedRuns.length, 1)
  // Duplicate role is rejected inside the transaction.
  assert.throws(() => store.transaction((tx) => tx.commitAdoption(commitInput())), /role_occupied|UNIQUE/)
  // Duplicate identity is rejected.
  assert.throws(() => store.transaction((tx) => tx.commitAdoption({
    ...commitInput(),
    proposal: { ...commitInput().proposal, proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000002', targetRole: 'reviewer' },
  })), /already_managed|UNIQUE/)
  store.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('crash recovery: a committed run survives a store reopen and is not adoptable', () => {
  const dbPath = tempDbPath()
  const first = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  first.transaction((tx) => tx.commitAdoption(commitInput()))
  first.close()

  // Reopen from the same durable file (simulated restart).
  const second = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const snapshot = second.snapshot()
  assert.equal(snapshot.committedRuns.length, 1)
  assert.equal(snapshot.committedRuns[0].proposalId, IDS.proposalId)
  assert.equal(snapshot.committedRuns[0].targetRole, 'builder')
  // The committed identity is not adoptable.
  assert.equal(second.transaction((tx) => tx.isIdentityCommitted({
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  })), true)
  assert.equal(second.transaction((tx) => tx.isRoleOccupied(IDS.teamGoalId, 'builder')), true)
  second.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

test('runner recovery after a durable commit yields exactly committed, never both', async () => {
  const dbPath = tempDbPath()
  const store = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  })
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
  })
  runner.registerObserved(observedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
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
  assert.equal(runner.commitCount, 1)
  store.close()

  // Simulated restart: a fresh runner over the same durable file.
  const restartedStore = new LiveAdoptionStore({
    databasePath: dbPath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const restarted = new LiveAdoptionRunner({
    store: restartedStore,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  const recovered = restarted.recover()
  assert.equal(recovered.committedRuns.length, 1)
  assert.equal(recovered.observedSessions.length, 0)
  assert.equal(recovered.commitCount, 1)
  restartedStore.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})
