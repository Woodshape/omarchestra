/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2.a red gate for the live Adoption runner. These tests are written
 * against the bounded integration contract
 * (docs/live-adoption-integration-contract.md) and are intended to FAIL until
 * `observer/live-adoption-runner.ts` is implemented in task 3.a.
 *
 * The test-local ports model only fake registry, authorization, current
 * observer transport, durable store, presentation, managed bridge, and
 * dispatch seams. They never create a process, socket, Pi session, PTY,
 * terminal, provider, Companion installation, or live Team Runner.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LiveAdoptionRunner } from '../live-adoption-runner.ts'
import type { AdoptionStore, AdoptionTransaction, CommittedAdoption } from '../live-adoption-store.ts'

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
  agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  teamGoalId: 'team-goal-local-1',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

/** Minimal in-memory durable store implementing the AdoptionStore contract. */
class FakeAdoptionStore implements AdoptionStore {
  private committed: CommittedAdoption[] = []
  private cursor = 0

  transaction<T>(operation: (tx: AdoptionTransaction) => T): T {
    const tx: AdoptionTransaction = {
      committedByIdentity: () => null,
      committedByProposal: (proposalId) => this.committed.find((run) => run.proposalId === proposalId) ?? null,
      committedByBinding: () => null,
      isRoleOccupied: () => false,
      isIdentityCommitted: () => false,
      isBindingCommitted: () => false,
      currentCursor: () => this.cursor,
      eventsAfter: () => [],
      commitAdoption: (input) => {
        const proposal = input.proposal as Record<string, unknown>
        const committed: CommittedAdoption = {
          proposalId: String(proposal.proposalId),
          proposalDigest: String(proposal.proposalDigest),
          agentRunId: IDS.agentRunId,
          observedSessionId: IDS.observedSessionId,
          executionNodeId: IDS.executionNodeId,
          processIncarnationId: IDS.processIncarnationId,
          piSessionId: IDS.piSessionId,
          extensionInstanceId: IDS.extensionInstanceId,
          targetTeamGoalId: IDS.teamGoalId,
          targetRole: 'builder',
          controlMode: 'managed',
          piStatus: 'Builder · managed',
          terminalTitleMetadata: 'Omarchestra — Builder — managed',
          runtimeBinding: null,
          runtimeBindingGuarantee: 'unavailable',
          committedAt: 0,
        }
        this.committed.push(committed)
        this.cursor += 1
        return committed
      },
    }
    return operation(tx)
  }

  snapshot() {
    return {
      executionNodeId: IDS.executionNodeId,
      teamGoalId: IDS.teamGoalId,
      roles: ['coordinator', 'builder', 'reviewer'],
      committedRuns: [...this.committed],
      cursor: this.cursor,
      events: [],
    }
  }

  close(): void {}
}

function makeRunner() {
  const runner = new LiveAdoptionRunner({
    store: new FakeAdoptionStore(),
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
  })
  runner.registerObserved({
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
  }, CONNECTION)
  return runner
}

const CONNECTION = { id: 'transport-1' }

function ackBody(proposal: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  }
}

test('happy path: propose -> authorize -> same-connection ack -> reconcile -> one atomic commit -> managed presentation', async () => {
  const runner = makeRunner()
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  assert.equal(proposal.proposalId, IDS.proposalId)
  const confirmed = await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  assert.equal(confirmed.phase, 'authorized')
  const committed = await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  assert.equal(committed.controlMode, 'managed')
  assert.equal(committed.runtimeBindingGuarantee, 'unavailable')
  assert.equal(runner.commitCount, 1)
  assert.equal(runner.managedBridgeEnabled, true)
  assert.equal(runner.dispatchCount, 0)
})

test('no authority or prompt dispatch before the durable commit', async () => {
  const runner = makeRunner()
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  assert.equal(runner.dispatchCount, 0)
  assert.equal(runner.managedBridgeEnabled, false)
})

test('rejection matrix grants no authority and leaves the session observed/unassigned', async () => {
  const runner = makeRunner()
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  const cases = [
    { name: 'stale identity', ack: { processIncarnationId: 'stale-proc' } },
    { name: 'reused PID', ack: { connectionId: 'reused-connection' } },
    { name: 'Node mismatch', ack: { executionNodeId: 'remote-node' } },
    { name: 'remote Team Goal', ack: { targetTeamGoalId: 'remote-goal' } },
    { name: 'occupied Role', ack: { targetRole: 'builder' } },
    { name: 'busy session', ack: { activity: 'busy' } },
    { name: 'unknown session', ack: { activity: 'unknown' } },
    { name: 'exited session', ack: { lifecycle: 'exited' } },
    { name: 'refusal', ack: { decision: 'refused', refusalCode: 'session_busy' } },
    { name: 'timeout', ack: { sourceSequence: 0 } },
    { name: 'duplicate', ack: { proposalId: 'duplicate-proposal' } },
    { name: 'disconnect', ack: { connectionChallenge: 'stale-challenge' } },
    { name: 'identity drift', ack: { extensionInstanceId: 'drifted-ext' } },
  ]
  for (const entry of cases) {
    await assert.rejects(
      runner.acceptAcknowledgement(CONNECTION, ackBody(proposal, entry.ack)),
      undefined,
      `expected rejection for ${entry.name}`,
    )
  }
  assert.equal(runner.commitCount, 0)
  assert.equal(runner.managedBridgeEnabled, false)
})

test('crash after durable commit but before committed delivery reconstructs exactly committed, never both', async () => {
  const runner = makeRunner()
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  const recovered = runner.recover()
  assert.equal(recovered.committedRuns.length, 1)
  assert.equal(recovered.observedSessions.length, 0)
  assert.equal(recovered.commitCount, 1)
})

test('runner connection loss immediately revokes dispatch readiness and clears queued work', async () => {
  const runner = makeRunner()
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  assert.equal(runner.managedBridgeEnabled, false)
  assert.equal(runner.dispatchCount, 0)
  assert.equal(runner.queuedWork, 0)
})
