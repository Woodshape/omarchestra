/** PROTOTYPE — NOT PRODUCTION. Fake-only authority regression gate. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveAdoptionRunner } from '../live-adoption-runner.ts'
import { LiveAdoptionGatewayCore } from '../live-adoption-gateway-core.ts'
import { createInMemoryAdoptionStore } from '../live-adoption-store.ts'
import { OBSERVER_CAPABILITIES } from '../contracts.ts'

function setup() {
  let now = 0
  const clock = { now: () => now }
  const store = createInMemoryAdoptionStore({ executionNodeId: 'local', teamGoalId: 'goal', roles: ['builder'] })
  const runner = new LiveAdoptionRunner({ store, executionNodeId: 'local', teamGoalId: 'goal', roles: ['builder'], clock })
  const gateway = new LiveAdoptionGatewayCore({ runner, executionNodeId: 'local', teamGoalId: 'goal', roles: ['builder'], clock })
  const connection = {
    frames: [] as any[],
    send(type: string, messageId: string, body: any) { this.frames.push({type, messageId, body}) },
    close() {},
  }
  const session = gateway.accept(connection)
  const register = { processIncarnationId: 'p'.repeat(32), piSessionId: 'pi-session', extensionInstanceId: 'e'.repeat(32), hostPid: 42, hostMode: 'tui', observerVersion: '0.1.0', capabilities: [...OBSERVER_CAPABILITIES], registrationAttempt: 1, sourceSequence: 1, lifecycle: 'running', activity: 'idle', health: 'healthy' }
  return { runner, store, gateway, connection, session, register, advance: (n: number) => { now += n } }
}

test('gateway and class transport compose registration, confirmation and commit without losing this', async () => {
  const h = setup()
  await h.session.handleFrame({type: 'observer.register', messageId: 'r', body: h.register})
  const registered = h.connection.frames.find(f => f.type === 'observer.registered').body
  const proposal = await h.gateway.requestAdoption(registered.observedSessionId, 'adoption-choice-1')
  await h.gateway.authorizeAdoption(proposal.proposalId as string, proposal.proposalDigest as string)
  const request = h.connection.frames.find(f => f.type === 'adoption.request_ack')?.body
  assert.ok(request, 'real transport method must be invoked with its receiver')
  assert.equal(h.runner.managedBridgeEnabled, false)
  const result = await h.session.handleFrame({type:'adoption.ack', messageId:'ack', body:{
    processIncarnationId: h.register.processIncarnationId, piSessionId:h.register.piSessionId, extensionInstanceId:h.register.extensionInstanceId,
    connectionId:request.connectionId, connectionChallenge:request.connectionChallenge,
    proposalId:request.proposalId, proposalDigest:request.proposalDigest, acknowledgementNonce:request.acknowledgementNonce,
    registryRevision:request.registryRevision, sourceSequence:2, decision:'acknowledged', activity:'idle', refusalCode:null,
  }})
  assert.equal(result?.controlMode, 'managed')
  assert.equal(h.store.snapshot().committedRuns.length, 1)
  assert.equal(h.runner.managedBridgeEnabled, false, 'writing a committed frame is not a readiness acknowledgement')
})

test('expiry is propagated from authoritative gateway to runner presentation and choices', async () => {
  const h = setup()
  await h.session.handleFrame({type:'observer.register',messageId:'r',body:h.register})
  const before = h.runner.snapshot()
  assert.equal(before.agents.length, 1)
  assert.ok((before.agents[0] as any).choices.length > 0, 'vacant local Role is actionable')
  h.advance(15001)
  h.gateway.sweep()
  assert.equal(h.runner.snapshot().agents.length, 0)
  assert.ok(h.runner.snapshot().observerRevision > before.observerRevision)
})

for (const invalidation of ['busy', 'disconnect', 'expiry'] as const) {
  test(`gateway ${invalidation} during asynchronous acknowledgement prevents commit`, async () => {
    const h = setup()
    await h.session.handleFrame({type:'observer.register', messageId:'register', body:h.register})
    const registered = h.connection.frames.find(f => f.type === 'observer.registered').body
    const proposal = await h.gateway.requestAdoption(registered.observedSessionId, 'adoption-choice-1')
    await h.gateway.authorizeAdoption(proposal.proposalId as string, proposal.proposalDigest as string)
    const request = h.connection.frames.find(f => f.type === 'adoption.request_ack').body
    const pending = h.session.handleFrame({type:'adoption.ack', messageId:'ack', body:{
      processIncarnationId:h.register.processIncarnationId, piSessionId:h.register.piSessionId, extensionInstanceId:h.register.extensionInstanceId,
      connectionId:request.connectionId, connectionChallenge:request.connectionChallenge,
      proposalId:request.proposalId, proposalDigest:request.proposalDigest, acknowledgementNonce:request.acknowledgementNonce,
      registryRevision:request.registryRevision, sourceSequence:2, decision:'acknowledged', activity:'idle', refusalCode:null,
    }})
    if (invalidation === 'disconnect') h.session.transportClosed(null)
    else if (invalidation === 'expiry') { h.advance(15001); h.gateway.sweep() }
    else await h.session.handleFrame({type:'observer.heartbeat',messageId:'busy',body:{
      connectionId:request.connectionId, connectionChallenge:request.connectionChallenge,
      sourceSequence:3, lifecycle:'running', activity:'busy', health:'healthy',
    }})
    await pending
    assert.equal(h.store.snapshot().committedRuns.length, 0)
    assert.equal(h.store.snapshot().events.length, 0)
    assert.equal(h.runner.managedBridgeEnabled, false)
  })
}

test('unknown choice cannot silently select Builder', async () => {
  const h = setup()
  await h.session.handleFrame({type:'observer.register',messageId:'r',body:h.register})
  const id = (h.runner.snapshot().agents[0] as any).observedSessionId
  await assert.rejects(h.gateway.requestAdoption(id, 'not-a-choice'), /choice|invalid/)
})
