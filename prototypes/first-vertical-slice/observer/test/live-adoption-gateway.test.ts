/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2.a red gate for the live Adoption gateway. These tests are written
 * against the bounded integration contract and are intended to FAIL until
 * `observer/live-adoption-gateway-core.ts` is implemented in task 3.a.
 *
 * They verify the Adoption-enabled routing is separate from the observation
 * gateway, that `adoption.ack` is accepted only on the exact current
 * connection, that the durable commit happens once, and that the committed
 * frame is delivered after commit. No live resource is opened.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { LiveAdoptionGatewayCore } from '../live-adoption-gateway-core.ts'

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

function makeGateway() {
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: ['coordinator', 'builder', 'reviewer'],
  })
  gateway.registerObserved({
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
  return gateway
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

async function prepareProposal(gateway: LiveAdoptionGatewayCore) {
  const proposal = await gateway.requestAdoption(IDS.observedSessionId, 'adoption-choice-1')
  await gateway.authorizeAdoption(proposal.proposalId, proposal.proposalDigest)
  return proposal
}

test('the Adoption gateway routes adoption.ack on the exact current connection to one commit', async () => {
  const gateway = makeGateway()
  const proposal = await prepareProposal(gateway)
  const session = gateway.accept(CONNECTION)
  const committed = await session.handleFrame({
    protocol: 'omarchestra.observer/v1',
    type: 'adoption.ack',
    messageId: 'msg-1',
    body: ackBody(proposal),
  })
  assert.equal(committed.controlMode, 'managed')
  assert.equal(gateway.commitCount, 1)
  assert.equal(gateway.lastCommittedFrame.type, 'adoption.committed')
})

test('an adoption.ack from a different connection is rejected without commit', async () => {
  const gateway = makeGateway()
  const proposal = await prepareProposal(gateway)
  const session = gateway.accept({ id: 'other-transport' })
  await assert.rejects(
    session.handleFrame({
      protocol: 'omarchestra.observer/v1',
      type: 'adoption.ack',
      messageId: 'msg-1',
      body: ackBody(proposal, { connectionId: 'other-connection', connectionChallenge: 'other-challenge' }),
    }),
    undefined,
  )
  assert.equal(gateway.commitCount, 0)
})

test('the observation-only gateway remains unchanged and rejects adoption frames', async () => {
  const { LiveObserverGateway } = await import('../live-gateway-core.ts')
  const sent: Array<{ type: string; body: Record<string, unknown> }> = []
  const gateway = new LiveObserverGateway({
    clock: { now: () => 0 },
    executionNodeId: IDS.executionNodeId,
  })
  const session = gateway.accept({
    id: 'transport-1',
    send: (type: string, _messageId: string, body: Record<string, unknown>) => sent.push({ type, body }),
    close: () => {},
  })
  session.handleFrame({
    protocol: 'omarchestra.observer/v1',
    type: 'adoption.ack',
    messageId: 'msg-1',
    body: {
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      connectionId: IDS.connectionId,
      connectionChallenge: IDS.connectionChallenge,
      proposalId: IDS.proposalId,
      proposalDigest: PROPOSAL_DIGEST,
      acknowledgementNonce: IDS.acknowledgementNonce,
      registryRevision: 7,
      sourceSequence: 2,
      decision: 'acknowledged',
      activity: 'idle',
      refusalCode: null,
    },
  })
  const rejection = sent.find((frame) => frame.type === 'observer.rejected')
  assert.ok(rejection, 'observation gateway must reject an adoption frame')
  assert.equal(rejection.body.code, 'unsupported_protocol')
  assert.equal(gateway.snapshot().agents.length, 0)
})
