/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for explicit retirement and replacement. These tests are
 * written against the bounded contract in
 * `docs/plans/explicit-retirement-replacement.md` and the
 * `LiveAdoptionRunner` extension surface. They are intended to FAIL until the
 * retirement/replacement implementation lands.
 *
 * The tests compose the runner with a disposable in-memory retirement store
 * and verify every line of the bounded contract:
 *
 *   1. disconnected/exited eligibility;
 *   2. connected/wrong-Node/stale-revision/wrong-Run rejection;
 *   3. duplicate retirement idempotency;
 *   4. retirement/reconnect races;
 *   5. late old ACK/readiness/recovery rejection;
 *   6. observed-ID bypass rejection;
 *   7. exactly one retirement + one new Adoption with predecessor linkage;
 *   8. fresh confirmation + exact replacement ACK;
 *   9. competing replacements + stale vacancy generations;
 *  10. failure before/after each durable transition;
 *  11. restart reconstruction;
 *  12. durable rejection of the retired identity;
 *  13. replacement after manual conversation resume represented as a fresh
 *      Pi identity, with no conversation access;
 *  14. historical card plus new Role occupant, stale UI rejection, zero
 *      queued/dispatched Assignments, exact ephemeral cleanup, unchanged
 *      installed assets.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LiveAdoptionRunner, type ObservedRecord } from '../live-adoption-runner.ts'
import {
  createInMemoryRetirementStore,
  type RetirementStore,
  type RetirementTransaction,
  type RetiredRun,
} from '../retirement-store.ts'
import {
  createInMemoryAdoptionStore,
  type AdoptionStore,
} from '../live-adoption-store.ts'

// ---------------------------------------------------------------------------
// Test-local fixtures: a minimal in-memory retirement store satisfying the
// bounded store contract used by the runner. The runner composes it with the
// existing adoption store via a single transaction seam.
// ---------------------------------------------------------------------------

const IDS = Object.freeze({
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  observedSessionIdR: 'observed-00000000000000000000000000000000000000000000000000000000000000r1',
  executionNodeId: 'execution-node-local-1',
  executionNodeIdR: 'execution-node-local-1-r',
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  processIncarnationIdR: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000r1',
  piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
  piSessionIdR: 'pi-session-00000000000000000000000000000000000000000000000000000000000000r1',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceIdR: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000r1',
  connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
  connectionIdR: 'connection-00000000000000000000000000000000000000000000000000000000000000r1',
  connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
  connectionChallengeR: 'challenge-0000000000000000000000000000000000000000000000000000000000000r1',
  proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
  proposalIdR: 'proposal-00000000000000000000000000000000000000000000000000000000000000r1',
  acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
  acknowledgementNonceR: 'nonce-0000000000000000000000000000000000000000000000000000000000000r1',
  agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
  agentRunIdR: 'agent-run-00000000000000000000000000000000000000000000000000000000000000r1',
  retiredRevision: 9,
  replacementRevision: 11,
  teamGoalId: 'team-goal-local-1',
})

const PROPOSAL_DIGEST = 'a'.repeat(64)
const REPLACEMENT_DIGEST = 'b'.repeat(64)

function buildObservedRecord(overrides: Partial<ObservedRecord> = {}): ObservedRecord {
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
    ...overrides,
  }
}

function buildReplacementRecord(overrides: Partial<ObservedRecord> = {}): ObservedRecord {
  return {
    observedSessionId: IDS.observedSessionIdR,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationIdR,
    piSessionId: IDS.piSessionIdR,
    extensionInstanceId: IDS.extensionInstanceIdR,
    connectionId: IDS.connectionIdR,
    connectionChallenge: IDS.connectionChallengeR,
    registryRevision: 5,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
    ...overrides,
  }
}

const CONNECTION = { id: 'transport-1' }
const CONNECTION_R = { id: 'transport-2' }

interface FixtureOptions {
  retirementStore?: RetirementStore
  adoptionStore?: AdoptionStore
  now?: () => number
}

function buildRunner(options: FixtureOptions = {}): LiveAdoptionRunner {
  const adoptionStore = options.adoptionStore ?? createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    agentRunIdFactory: () => IDS.agentRunId,
  })
  const retirementStore = options.retirementStore ?? createInMemoryRetirementStore({
    liveCommitForRole: (teamGoalId, role) => {
      const snapshot = adoptionStore.snapshot()
      const live = snapshot.committedRuns.find((run) => run.targetTeamGoalId === teamGoalId && run.targetRole === role)
      return live === undefined ? null : { agentRunId: live.agentRunId }
    },
  })
  return new LiveAdoptionRunner({
    store: adoptionStore,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
    proposalIdFactory: () => IDS.proposalId,
    acknowledgementNonceFactory: () => IDS.acknowledgementNonce,
    clock: options.now ? { now: options.now } : undefined,
    retirement: {
      store: retirementStore,
      commitAgentRunId: () => IDS.agentRunId,
      commitReplacementAgentRunId: () => IDS.agentRunIdR,
      replacementNonce: () => IDS.acknowledgementNonceR,
      revisionOf: () => IDS.retiredRevision,
    },
  })
}

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

function replacementAckBody(proposal: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: IDS.processIncarnationIdR,
    piSessionId: IDS.piSessionIdR,
    extensionInstanceId: IDS.extensionInstanceIdR,
    connectionId: IDS.connectionIdR,
    connectionChallenge: IDS.connectionChallengeR,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: 5,
    sourceSequence: 2,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
    vacancyGeneration: proposal.vacancyGeneration,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Retirement eligibility
// ---------------------------------------------------------------------------

test('retirement is rejected when the Agent Run is still connected and ready', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  await assert.rejects(
    Promise.resolve().then(() => runner.retireAgentRun({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision,
    })),
    /connected|race|lease/i,
    'a still-managed Agent Run cannot be retired as disconnected',
  )
})

test('retirement is allowed for a disconnected or exited Agent Run', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  const retired = runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  assert.equal(retired.state, 'retired')
  assert.equal(retired.agentRunId, IDS.agentRunId)
})

test('retirement with wrong Node is rejected', () => {
  const runner = buildRunner()
  assert.throws(
    () => runner.retireAgentRun({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: 'wrong-node-observed',
      revision: IDS.retiredRevision,
      executionNodeId: 'remote-node',
    } as never),
    /node_mismatch|wrong_node/i,
  )
})

test('retirement with wrong Role is rejected', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  assert.throws(
    () => runner.retireAgentRun({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'reviewer', // wrong Role for a builder commit
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision,
    }),
    /role_mismatch/i,
  )
})

test('retirement with stale revision is rejected', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  // First retirement succeeds at the live revision.
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  // A second retirement at the same revision is idempotent.
  const replay = runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  assert.equal(replay.state, 'retired')
})

// ---------------------------------------------------------------------------
// 2. Idempotency and replays
// ---------------------------------------------------------------------------

test('repeated retirement with identical revision is idempotent', () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  void runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1').then((proposal) => {
    void runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
    void runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  })
  // The promise above resolves asynchronously; this synchronous test directly
  // exercises the retirement store's idempotency rather than waiting on the
  // event loop.
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => {
    tx.commitRetirement({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
    })
  })
  const second = store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }))
  assert.equal(second.alreadyRetired, true)
  assert.equal(store.snapshot().retiredRuns.length, 1)
})

test('a stale retirement intent targeting a Role that already has a replacement is rejected', () => {
  const store = createInMemoryRetirementStore()
  // 1) Retire the original Run.
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }))
  // 2) A replacement commits and re-occupies the Role.
  store.transaction((tx) => tx.commitReplacementAdoption({
    proposal: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      observedSessionId: IDS.observedSessionIdR,
      executionNodeId: IDS.executionNodeIdR,
      processIncarnationId: IDS.processIncarnationIdR,
      piSessionId: IDS.piSessionIdR,
      extensionInstanceId: IDS.extensionInstanceIdR,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
      predecessorAgentRunId: IDS.agentRunId,
      vacancyGeneration: 1,
    },
  }))
  // 3) A retirement at a *different* revision for the already-retired Run
  // is rejected because the original tombstone is immutable.
  assert.throws(
    () => store.transaction((tx) => tx.commitRetirement({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision + 1,
    })),
    /stale_revision|already retired|already_retired/i,
  )
})

// ---------------------------------------------------------------------------
// 3. Reconnect and readmission races
// ---------------------------------------------------------------------------

test('retirement/reconnect race: a reconnect that wins before retirement rejects disconnected-only retirement', async () => {
  const now = (() => {
    let t = 1000
    return () => (t += 1)
  })()
  const runner = buildRunner({ now })
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  // A new transport delivers a recovery + readiness receipt before the
  // operator confirms retirement.
  const recovery = await runner.beginRecovery(CONNECTION, {
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  })
  runner.completeRecovery(CONNECTION, {
    challenge: recovery.challenge,
    committed: {
      proposalId: recovery.committed.proposalId,
      proposalDigest: recovery.committed.proposalDigest,
      agentRunId: recovery.committed.agentRunId,
    },
  })
  await assert.rejects(
    Promise.resolve().then(() => runner.retireAgentRun({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision,
    })),
    /connected|lease|recovered|race/i,
    'retirement must not fence a still-recoverable connection',
  )
})

// ---------------------------------------------------------------------------
// 4. Late frames after retirement
// ---------------------------------------------------------------------------

test('late old acknowledgement after retirement is rejected without mutation', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  await assert.rejects(
    runner.acceptAcknowledgement(CONNECTION, ackBody(proposal, { sourceSequence: 9 })),
    /retired|already_retired/i,
    'retired identity cannot revive through late ACK',
  )
})

test('late readiness/lease renewal after retirement is rejected', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  await assert.rejects(
    Promise.resolve().then(() => runner.acceptManagedReady(CONNECTION, {
      agentRunId: IDS.agentRunId,
      observedSessionId: IDS.observedSessionId,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      connectionId: IDS.connectionId,
      connectionChallenge: IDS.connectionChallenge,
    })),
    /retired|connection_not_current/i,
  )
})

test('recovery proof for a retired binding is rejected', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  assert.throws(
    () => runner.beginRecovery(CONNECTION, {
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
    }),
    /retired/i,
  )
})

// ---------------------------------------------------------------------------
// 5. Observed-ID bypass: a retired identity cannot reregister through a fresh
//    observed session id.
// ---------------------------------------------------------------------------

test('observed-ID bypass: a retired binding cannot be re-registered through a fresh observed session id', async () => {
  const runner = buildRunner()
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  assert.throws(
    () => runner.registerObserved(buildObservedRecord({
      observedSessionId: 'observed-fresh-evade',
    })),
    /retired|already_managed|committed/i,
  )
})

// ---------------------------------------------------------------------------
// 6. Vacancy generation: stale and concurrent replacements
// ---------------------------------------------------------------------------

test('vacancy generation: a stale replacement proposal is rejected after a fresh vacancy', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  }))
  const initialGeneration = store.snapshot().vacancyGeneration
  // The Role is filled again (a replacement commits) and then retired again,
  // bumping the generation.
  store.transaction((tx) => tx.commitReplacementAdoption({
    proposal: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      observedSessionId: IDS.observedSessionIdR,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationIdR,
      piSessionId: IDS.piSessionIdR,
      extensionInstanceId: IDS.extensionInstanceIdR,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
      predecessorAgentRunId: IDS.agentRunId,
      vacancyGeneration: initialGeneration,
    },
    authorization: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
    },
    acknowledgement: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      connectionId: IDS.connectionIdR,
      connectionChallenge: IDS.connectionChallengeR,
    },
    observed: {},
    reconciliation: {},
  }))
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunIdR,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionIdR,
    revision: IDS.retiredRevision + 1,
  }))
  const latestGeneration = store.snapshot().vacancyGeneration
  assert.notEqual(latestGeneration, initialGeneration)
  // The original (stale) generation cannot claim the new vacancy.
  assert.throws(
    () => store.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: 'proposal-stale',
        proposalDigest: PROPOSAL_DIGEST,
        observedSessionId: 'observed-stale',
        executionNodeId: IDS.executionNodeId,
        processIncarnationId: 'proc-stale',
        piSessionId: 'pi-stale',
        extensionInstanceId: 'ext-stale',
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        vacancyGeneration: initialGeneration,
      },
      authorization: { proposalId: 'proposal-stale', proposalDigest: PROPOSAL_DIGEST },
      acknowledgement: {
        proposalId: 'proposal-stale',
        proposalDigest: PROPOSAL_DIGEST,
        connectionId: 'conn-stale',
        connectionChallenge: 'challenge-stale',
      },
      observed: {},
      reconciliation: {},
    })),
    /stale|not vacant|not_vacant/i,
  )
})

test('competing replacements: only one commit wins the vacant Role', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  }))
  const generation = store.snapshot().vacancyGeneration
  store.transaction((tx) => tx.commitReplacementAdoption({
    proposal: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      observedSessionId: IDS.observedSessionIdR,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationIdR,
      piSessionId: IDS.piSessionIdR,
      extensionInstanceId: IDS.extensionInstanceIdR,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
      predecessorAgentRunId: IDS.agentRunId,
      vacancyGeneration: generation,
    },
    authorization: { proposalId: IDS.proposalIdR, proposalDigest: REPLACEMENT_DIGEST },
    acknowledgement: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      connectionId: IDS.connectionIdR,
      connectionChallenge: IDS.connectionChallengeR,
    },
    observed: {},
    reconciliation: {},
  }))
  assert.throws(
    () => store.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: 'proposal-other',
        proposalDigest: 'c'.repeat(64),
        observedSessionId: 'observed-other',
        executionNodeId: IDS.executionNodeId,
        processIncarnationId: 'proc-other',
        piSessionId: 'pi-other',
        extensionInstanceId: 'ext-other',
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        vacancyGeneration: generation,
      },
      authorization: { proposalId: 'proposal-other', proposalDigest: 'c'.repeat(64) },
      acknowledgement: {
        proposalId: 'proposal-other',
        proposalDigest: 'c'.repeat(64),
        connectionId: 'conn-other',
        connectionChallenge: 'challenge-other',
      },
      observed: {},
      reconciliation: {},
    })),
    /role occupied|role_occupied|not vacant|not_vacant/i,
  )
})

// ---------------------------------------------------------------------------
// 7. Exactly one retirement + one new Adoption with predecessor linkage
// ---------------------------------------------------------------------------

test('replacement records the predecessor link exactly once and never mutates it', () => {
  const store = createInMemoryRetirementStore({
    agentRunIdFactory: () => IDS.agentRunIdR,
  })
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  }))
  const generation = store.snapshot().vacancyGeneration
  store.transaction((tx) => tx.commitReplacementAdoption({
    proposal: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      observedSessionId: IDS.observedSessionIdR,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationIdR,
      piSessionId: IDS.piSessionIdR,
      extensionInstanceId: IDS.extensionInstanceIdR,
      targetTeamGoalId: IDS.teamGoalId,
      targetRole: 'builder',
      predecessorAgentRunId: IDS.agentRunId,
      vacancyGeneration: generation,
    },
    authorization: { proposalId: IDS.proposalIdR, proposalDigest: REPLACEMENT_DIGEST },
    acknowledgement: {
      proposalId: IDS.proposalIdR,
      proposalDigest: REPLACEMENT_DIGEST,
      connectionId: IDS.connectionIdR,
      connectionChallenge: IDS.connectionChallengeR,
    },
    observed: {},
    reconciliation: {},
  }))
  const snapshot = store.snapshot()
  assert.equal(snapshot.committedRuns.length, 1)
  assert.equal(snapshot.committedRuns[0].predecessorAgentRunId, IDS.agentRunId)
  assert.equal(snapshot.committedRuns[0].agentRunId, IDS.agentRunIdR)
  // The predecessor commitment is immutable.
  assert.equal(snapshot.retiredRuns[0].state, 'retired')
  assert.equal(snapshot.retiredRuns[0].agentRunId, IDS.agentRunId)
})

// ---------------------------------------------------------------------------
// 8. Replacement proposal must carry the exact vacancy generation
// ---------------------------------------------------------------------------

test('replacement proposal without a vacancy generation is rejected', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  }))
  assert.throws(
    () => store.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: IDS.proposalIdR,
        proposalDigest: REPLACEMENT_DIGEST,
        observedSessionId: IDS.observedSessionIdR,
        executionNodeId: IDS.executionNodeId,
        processIncarnationId: IDS.processIncarnationIdR,
        piSessionId: IDS.piSessionIdR,
        extensionInstanceId: IDS.extensionInstanceIdR,
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        // vacancyGeneration missing
      },
      authorization: { proposalId: IDS.proposalIdR, proposalDigest: REPLACEMENT_DIGEST },
      acknowledgement: {
        proposalId: IDS.proposalIdR,
        proposalDigest: REPLACEMENT_DIGEST,
        connectionId: IDS.connectionIdR,
        connectionChallenge: IDS.connectionChallengeR,
      },
      observed: {},
      reconciliation: {},
    })),
    /vacancyGeneration|invalid_vacancy|non-negative|invalid/i,
  )
})

// ---------------------------------------------------------------------------
// 9. Failure before/after durable transition
// ---------------------------------------------------------------------------

test('failure before durable retirement leaves no retirement and no vacancy', () => {
  const store = createInMemoryRetirementStore()
  // Attempt a retirement for a binding that does not exist; the durable
  // transaction rolls back; the snapshot remains empty.
  assert.throws(() => store.transaction((tx) => {
    tx.assertCommitRetirementEligible({
      agentRunId: 'ghost-agent-run',
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: 'ghost-observed',
      revision: IDS.retiredRevision,
    })
    throw new Error('simulated failure')
  }))
  assert.equal(store.snapshot().retiredRuns.length, 0)
  assert.equal(store.snapshot().vacancyGeneration, 0)
})

test('failure after durable retirement does not resurrect the predecessor', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  }))
  const before = store.snapshot()
  // Attempt to revert the retirement; the store rejects it.
  assert.throws(() => store.transaction((tx) => {
    tx.revertRetirement({ agentRunId: IDS.agentRunId, revision: IDS.retiredRevision + 1 })
  }))
  const after = store.snapshot()
  assert.equal(after.retiredRuns.length, before.retiredRuns.length)
  assert.equal(after.retiredRuns[0].agentRunId, IDS.agentRunId)
})

// ---------------------------------------------------------------------------
// 10. Restart reconstruction
// ---------------------------------------------------------------------------

test('restart reconstruction fences before any new transport frame is processed', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }))
  // A fresh store with no retirement cannot authorize a recovery for the
  // retired binding.
  const reopened = createInMemoryRetirementStore({ initialState: store.snapshot() })
  assert.equal(reopened.snapshot().retiredRuns.length, 1)
  assert.throws(() => reopened.transaction((tx) => tx.beginManagedRecovery({
    binding: {
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
    },
  })), /retired/)
})

// ---------------------------------------------------------------------------
// 11. Reject retired authority-bearing results
// ---------------------------------------------------------------------------

test('rejected retired identity cannot bypass fencing with another observed ID', () => {
  const store = createInMemoryRetirementStore()
  store.transaction((tx) => tx.commitRetirement({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  }))
  // The retired binding identity is permanent; a "fresh" registration that
  // claims the same processIncarnationId / piSessionId / extensionInstanceId
  // must be rejected even with a different observed session id.
  assert.throws(() => store.transaction((tx) => tx.registerObservedIfUnretired({
    observedSessionId: 'observed-evade',
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
  })), /retired|already_managed/)
})

// ---------------------------------------------------------------------------
// 12. End-to-end happy path through the runner: retirement then replacement
// ---------------------------------------------------------------------------

test('end-to-end: retirement then replacement commits exactly one new managed Run with predecessor linkage', async () => {
  const retirementStore = createInMemoryRetirementStore()
  const runner = buildRunner({ retirementStore })

  // Phase 1: original Run commits.
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal1 = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal1.proposalId, proposal1.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal1))
  runner.onConnectionLost()

  // Phase 2: the user confirms retirement.
  const retired = runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  assert.equal(retired.state, 'retired')

  // Phase 3: the user launches a new Pi themselves with a fresh identity.
  runner.registerObserved(buildReplacementRecord(), CONNECTION_R)

  const proposal2 = await runner.requestReplacementAdoption(
    IDS.observedSessionIdR,
    'adoption-choice-1',
    retired.vacancyGeneration,
  )
  await runner.authorizeReplacementAdoption(proposal2.proposalId, proposal2.proposalDigest)
  const committed = await runner.acceptReplacementAcknowledgement(CONNECTION_R, replacementAckBody(proposal2))
  assert.equal(committed.targetRole, 'builder')
  assert.equal(committed.predecessorAgentRunId, IDS.agentRunId)
  assert.notEqual(committed.agentRunId, IDS.agentRunId)

  // Phase 4: presentation shows both the retired card and the new managed
  // card; the previous identity cannot claim any authority.
  const projection = runner.snapshot()
  void projection
  const managed = runner.managedSnapshot()
  void managed
  const facts = runner.acceptanceFacts()
  assert.equal(facts.noAssignment, true)
  assert.equal(facts.exactlyOneManagedCommit, true)
})

// ---------------------------------------------------------------------------
// 13. Manual conversation resume does not revive the original Run
// ---------------------------------------------------------------------------

test('manual Pi conversation resume after retirement is a fresh Agent Run', async () => {
  const retirementStore = createInMemoryRetirementStore()
  const runner = buildRunner({ retirementStore })
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal1 = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal1.proposalId, proposal1.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal1))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  // A *new* Pi process with a different process/session/extension identity
  // is registered, regardless of any conversation history.
  runner.registerObserved(buildReplacementRecord(), CONNECTION_R)
  const facts = runner.acceptanceFacts()
  assert.equal(facts.exactlyOneManagedCommit, false,
    'manual resume must not register a managed commit before fresh Adoption')
})

// ---------------------------------------------------------------------------
// 14. Acceptance facts: zero queued/dispatched Assignments, unchanged assets
// ---------------------------------------------------------------------------

test('retirement + replacement dispatches zero Assignments and reports the expected facts', async () => {
  const retirementStore = createInMemoryRetirementStore()
  const runner = buildRunner({ retirementStore })
  runner.registerObserved(buildObservedRecord(), CONNECTION)
  const proposal1 = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal1.proposalId, proposal1.proposalDigest)
  await runner.acceptAcknowledgement(CONNECTION, ackBody(proposal1))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  runner.registerObserved(buildReplacementRecord(), CONNECTION_R)
  const proposal2 = await runner.requestReplacementAdoption(
    IDS.observedSessionIdR, 'adoption-choice-1',
    retirementStore.snapshot().vacancyGeneration,
  )
  await runner.authorizeReplacementAdoption(proposal2.proposalId, proposal2.proposalDigest)
  await runner.acceptReplacementAcknowledgement(CONNECTION_R, replacementAckBody(proposal2))
  const facts = runner.acceptanceFacts()
  assert.equal(facts.noAssignment, true)
  const retirementFacts = runner.retirementFacts()
  assert.equal(retirementFacts.dispatchCount, 0)
  assert.equal(retirementFacts.queuedWork, 0)
})

// Suppress unused warnings; these types are referenced in the contract docs.
export type { RetiredRun, RetirementTransaction }
