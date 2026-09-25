import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionCodes } from '../runner/session-code.ts'
import { BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, decodeBridgeFrame, encodeBridgeFrame } from '../runner/bridge-protocol.ts'
import { validateObservedSessionCard, validateManagedAgentCard } from '../console/schema.ts'
import { journeyFixture } from '../fixtures/journey.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'

test('codes are collision-checked, stable per exact incarnation and not recycled', () => {
  const candidates = ['A1B2-C3D4', 'A1B2-C3D4', 'FFFF-1234']
  const codes = new SessionCodes(() => candidates.shift()!)
  assert.equal(codes.forIdentity('first'), 'A1B2-C3D4')
  assert.equal(codes.forIdentity('first'), 'A1B2-C3D4')
  assert.equal(codes.forIdentity('second'), 'FFFF-1234')
  assert.equal(codes.forIdentity('first'), 'A1B2-C3D4')
})

test('collision retry and codebook capacity are bounded; exhaustion gives unavailable, never a duplicate', () => {
  let calls = 0
  const codes = new SessionCodes(() => { calls++; return 'AAAA-BBBB' })
  assert.equal(codes.forIdentity('first'), 'AAAA-BBBB')
  assert.equal(codes.forIdentity('second'), null)
  assert.equal(calls, 17)
  const bounded = new SessionCodes(() => 'AAAA-BBBB', 1)
  assert.equal(bounded.forIdentity('first'), 'AAAA-BBBB')
  assert.equal(bounded.forIdentity('second'), null)
  assert.equal(bounded.forIdentity('first'), 'AAAA-BBBB')
  assert.throws(() => new SessionCodes(() => '<unsafe>').forIdentity('first'), /session_code/)
})

test('the bridge capability and registered code are bounded, additive and never an authority field', () => {
  const body = { observedSessionId: 'observed', executionNodeId: 'node', connectionId: 'c'.repeat(32),
    connectionChallenge: 'd'.repeat(32), acceptedRegistrationAttempt: 1, acceptedSourceSequence: 1,
    leaseDurationMs: 15000, heartbeatIntervalMs: 5000, mode: 'observed' }
  const roundtrip = (patch: Record<string, unknown>) => decodeBridgeFrame(encodeBridgeFrame('registered', 'm', { ...body, ...patch }).subarray(0, -1))
  assert.equal(roundtrip({}).body.sessionCode, undefined, 'legacy registration stays valid')
  assert.equal(roundtrip({ sessionCode: 'AB12-CD34' }).body.sessionCode, 'AB12-CD34')
  assert.equal(roundtrip({ sessionCode: null }).body.sessionCode, null)
  for (const sessionCode of ['ab12-cd34', 'AB12', '<b>unsafe</b>', 'x'.repeat(513), 1]) assert.throws(() => roundtrip({ sessionCode }))
  assert.throws(() => roundtrip({ title: 'private' }))
  const registration = { processInstanceId: 'p'.repeat(32), piSessionId: 'session', extensionInstanceId: 'e'.repeat(32),
    hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY], registrationAttempt: 1, sourceSequence: 1,
    lifecycle: 'running', activity: 'idle', health: 'healthy' }
  assert.doesNotThrow(() => encodeBridgeFrame('register', 'r', registration))
  assert.throws(() => encodeBridgeFrame('register', 'r', { ...registration, sessionCode: 'AB12-CD34' }), 'clients cannot nominate their display code')
  assert.throws(() => encodeBridgeFrame('register', 'r', { ...registration, capabilities: [...registration.capabilities, SESSION_CODE_CAPABILITY] }))
})

test('missing code or incompatible owner never fabricates a matching footer or disrupts ordinary Pi', async () => {
  for (const compatible of [true, false]) {
    const hooks = new Map<string, (event: unknown, ctx: any) => void>()
    const slots = new Map<string, string | undefined>([['other', 'unrelated']])
    const host = { mode: 'tui', sessionManager: { getSessionId: () => 'pi-session' }, isIdle: () => true,
      ui: { setStatus(key: string, value: string | undefined) { slots.set(key, value) } } }
    createPiBridgeExtension({ schedule: () => 0 as unknown as ReturnType<typeof setTimeout>, cancel: () => {},
      connect: async (onFrame, onClose) => ({ close: onClose,
        sendFrame(type, id, body) {
          if (type !== 'register') return
          // A legacy shape from a compatible responder, or a strict older
          // owner's rejection. Neither supplies a shared display code.
          const wire = compatible ? encodeBridgeFrame('registered', id, {
            observedSessionId: 'observed', executionNodeId: 'node', connectionId: 'c'.repeat(32), connectionChallenge: 'd'.repeat(32),
            acceptedRegistrationAttempt: body.registrationAttempt, acceptedSourceSequence: body.sourceSequence,
            leaseDurationMs: 15000, heartbeatIntervalMs: 5000, mode: 'observed',
          }) : encodeBridgeFrame('rejected', id, { requestMessageId: id, code: 'incompatible_extension' })
          onFrame(decodeBridgeFrame(wire.subarray(0, -1)))
          if (!compatible) onClose()
        },
      }),
    })({ on(name, handler) { hooks.set(name, handler) } })
    hooks.get('session_start')!(null, host)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(slots.get('omarchestra-observer-status'), compatible ? 'Session code unavailable · Unassigned · observed' : undefined)
    assert.equal(slots.get('other'), 'unrelated')
    hooks.get('session_shutdown')!(null, host)
    assert.equal(slots.get('omarchestra-observer-status'), undefined)
  }
})

test('projection accepts only literal session codes or explicitly unavailable', () => {
  for (const [card, validate] of [[journeyFixture.observedSessions[0], validateObservedSessionCard],
    [journeyFixture.managedAgents[0], validateManagedAgentCard]] as const) {
    assert.equal(validate({ ...card, sessionCode: 'AB12-CD34' }).sessionCode, 'AB12-CD34')
    assert.equal(validate({ ...card, sessionCode: null }).sessionCode, null)
    for (const sessionCode of ['<b>unsafe</b>', 'observed-123', 9, 'ab12-cd34']) assert.throws(() => validate({ ...card, sessionCode }))
  }
})
