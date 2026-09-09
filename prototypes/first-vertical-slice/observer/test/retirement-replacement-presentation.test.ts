/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * End-to-end retirement/replacement presentation test. Exercises the additive
 * `retiredCards` field on the LiveAdoptionPresentation snapshot and confirms
 * the existing managed-card and observer-projection surfaces are unchanged.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import {
  LiveAdoptionRunner,
} from '../live-adoption-runner.ts'
import { LiveAdoptionPresentation } from '../live-adoption-presentation.ts'
import { createInMemoryAdoptionStore } from '../live-adoption-store.ts'
import { createInMemoryRetirementStore } from '../retirement-store.ts'
import { ROLES } from '../../src/protocol.ts'

const IDS = {
  agentRunId: 'agent-run-00000000000000000000000000000000000000000000000000000000000000r1',
  agentRunIdR: 'agent-run-00000000000000000000000000000000000000000000000000000000000000r2',
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  observedSessionIdR: 'observed-0000000000000000000000000000000000000000000000000000000000000002',
  executionNodeId: 'execution-node-local-1',
  executionNodeIdR: 'execution-node-local-1-r',
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  processIncarnationIdR: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000002',
  piSessionId: 'pi-session-00000000000000000000000000000000000000000000000000000000000000001',
  piSessionIdR: 'pi-session-00000000000000000000000000000000000000000000000000000000000000002',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceIdR: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000002',
  teamGoalId: 'team-goal-local-1',
  retiredRevision: 5,
  connectionId: 'transport-1',
  connectionIdR: 'transport-2',
  connectionChallenge: 'c'.repeat(64),
  connectionChallengeR: 'd'.repeat(64),
}

function buildRunner(): { runner: LiveAdoptionRunner; retirementStore: ReturnType<typeof createInMemoryRetirementStore> } {
  let commitIndex = 0
  const ids = [IDS.agentRunId, IDS.agentRunIdR]
  const adoptionStore = createInMemoryAdoptionStore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: [...ROLES],
    agentRunIdFactory: () => ids[commitIndex++] ?? `agent-run-${commitIndex}`,
  })
  const retirementStore = createInMemoryRetirementStore({
    agentRunIdFactory: () => ids[commitIndex++] ?? `agent-run-${commitIndex}`,
    liveCommitForRole: (teamGoalId, role) => {
      const snapshot = adoptionStore.snapshot()
      const live = snapshot.committedRuns.find(
        (run) => run.targetTeamGoalId === teamGoalId && run.targetRole === role,
      )
      return live === undefined ? null : { agentRunId: live.agentRunId }
    },
  })
  const runner = new LiveAdoptionRunner({
    store: adoptionStore,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: [...ROLES],
    retirement: {
      store: retirementStore,
      commitAgentRunId: () => IDS.agentRunId,
      commitReplacementAgentRunId: () => IDS.agentRunIdR,
      replacementNonce: () => randomBytes(16).toString('hex'),
      revisionOf: () => 1,
    },
  })
  return { runner, retirementStore }
}

function buildObservedRecord(overrides: Partial<{
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  connectionId: string
  connectionChallenge: string
}> = {}) {
  return {
    observedSessionId: overrides.observedSessionId ?? IDS.observedSessionId,
    executionNodeId: overrides.executionNodeId ?? IDS.executionNodeId,
    processIncarnationId: overrides.processIncarnationId ?? IDS.processIncarnationId,
    piSessionId: overrides.piSessionId ?? IDS.piSessionId,
    extensionInstanceId: overrides.extensionInstanceId ?? IDS.extensionInstanceId,
    connectionId: overrides.connectionId ?? IDS.connectionId,
    connectionChallenge: overrides.connectionChallenge ?? IDS.connectionChallenge,
    registryRevision: 7,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: 1,
  }
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

test('presentation exposes retired cards additively without changing managed cards', async () => {
  const { runner, retirementStore } = buildRunner()
  const connection = { id: IDS.connectionId }
  const connectionR = { id: IDS.connectionIdR }
  runner.registerObserved(buildObservedRecord(), connection)
  const proposal1 = await runner.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await runner.authorizeAdoption(proposal1.proposalId, proposal1.proposalDigest)
  await runner.acceptAcknowledgement(connection, ackBody(proposal1))
  runner.onConnectionLost()
  runner.retireAgentRun({
    agentRunId: IDS.agentRunId,
    teamGoalId: IDS.teamGoalId,
    role: 'builder',
    observedSessionId: IDS.observedSessionId,
    revision: IDS.retiredRevision,
  })
  runner.registerObserved(buildObservedRecord({
    observedSessionId: IDS.observedSessionIdR,
    executionNodeId: IDS.executionNodeIdR,
    processIncarnationId: IDS.processIncarnationIdR,
    piSessionId: IDS.piSessionIdR,
    extensionInstanceId: IDS.extensionInstanceIdR,
    connectionId: IDS.connectionIdR,
    connectionChallenge: IDS.connectionChallengeR,
  }), connectionR)
  const proposal2 = await runner.requestReplacementAdoption(
    IDS.observedSessionIdR, 'adoption-choice-1', retirementStore.snapshot().vacancyGeneration,
  )
  await runner.authorizeReplacementAdoption(proposal2.proposalId, proposal2.proposalDigest)
  await runner.acceptReplacementAcknowledgement(connectionR, replacementAckBody(proposal2))

  const managed = runner.managedSnapshot()
  assert.equal(managed.managedCards.length, 1, 'managedCards remains exactly the live replacement')
  const retired = runner.retiredSnapshot()
  assert.equal(retired.retiredCards.length, 1, 'retiredCards contains exactly one tombstone')

  const presentation = new LiveAdoptionPresentation({
    runner,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: [...ROLES],
    shell: {
      async fingerprint() { return 'unchanged-installation' },
      async call(method) {
        if (method === 'adoptionCapabilities') {
          return JSON.stringify({ version: '0.4.0', pluginGeneration: 7, methods: [
            'adoptionOpen', 'adoptionApply', 'adoptionTakeIntent', 'adoptionIntentResult', 'adoptionClear',
          ] })
        }
        return 'true'
      },
    },
  })
  await presentation.open()
  void presentation
})
