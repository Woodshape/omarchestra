/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for the strict `omarchestra.observer/v1` protocol module.
 * These tests are written against the locked observer/Adoption v1 contract
 * (docs/observer-adoption-v1.md) and are intended to FAIL until the pure
 * protocol module (`observer/contracts.ts`) is implemented in Phase 3. No
 * production behavior is implemented here.
 *
 * The protocol module performs no I/O and imports neither Adoption nor QML.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function loadProtocol() {
  return await import('../contracts.ts')
}

// ---------------------------------------------------------------------------
// Valid envelope builders (canonical, contract-conformant)
// ---------------------------------------------------------------------------

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    hostPid: 41001,
    hostMode: 'tui',
    observerVersion: '0.1.0',
    capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'managed.activate'],
    registrationAttempt: 1,
    sourceSequence: 1,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

function heartbeatBody(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 2,
    lifecycle: 'running',
    activity: 'idle',
    health: 'healthy',
    ...overrides,
  }
}

function lifecycleBody(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    eventId: 'event-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 3,
    lifecycle: 'running',
    activity: 'busy',
    health: 'healthy',
    ...overrides,
  }
}

function closeBody(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    sourceSequence: 4,
    reason: 'quit',
    ...overrides,
  }
}

function adoptionAckBody(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
    proposalDigest: 'a'.repeat(64),
    acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
    registryRevision: 1,
    sourceSequence: 5,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
    ...overrides,
  }
}

function registeredBody(overrides: Record<string, unknown> = {}) {
  return {
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    acceptedRegistrationAttempt: 1,
    acceptedSourceSequence: 1,
    heartbeatIntervalMs: 5000,
    leaseDurationMs: 15000,
    registryRevision: 1,
    piStatus: 'Unassigned · observed',
    ...overrides,
  }
}

function rejectedBody(overrides: Record<string, unknown> = {}) {
  return {
    requestMessageId: 'message-0000000000000000000000000000000000000000000000000000000000000001',
    code: 'incompatible_extension',
    detail: 'bounded locally authored detail',
    ...overrides,
  }
}

function adoptionRequestAckBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
    proposalDigest: 'a'.repeat(64),
    acknowledgementNonce: 'nonce-0000000000000000000000000000000000000000000000000000000000000001',
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    registryRevision: 1,
    targetTeamGoalId: 'team-goal-local-1',
    targetRole: 'builder',
    acknowledgementRemainingMs: 5000,
    ...overrides,
  }
}

function adoptionCommittedBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
    proposalDigest: 'a'.repeat(64),
    agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
    targetTeamGoalId: 'team-goal-local-1',
    targetRole: 'builder',
    controlMode: 'managed',
    piStatus: 'Builder · managed',
    terminalTitleMetadata: 'Omarchestra — Builder — managed',
    runtimeBindingGuarantee: 'unavailable',
    ...overrides,
  }
}

function adoptionFailedBody(overrides: Record<string, unknown> = {}) {
  return {
    proposalId: 'proposal-0000000000000000000000000000000000000000000000000000000000000001',
    code: 'transaction_failed',
    detail: 'bounded locally authored detail',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Strict envelope validation
// ---------------------------------------------------------------------------

test('protocol identifier and capabilities are exactly the locked values', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.OBSERVER_PROTOCOL_ID, 'omarchestra.observer/v1')
  assert.deepEqual(protocol.OBSERVER_CAPABILITIES, [
    'observe.lifecycle',
    'adoption.acknowledge',
    'managed.activate',
  ])
})

test('register requires exactly the locked body fields and tui host mode', async () => {
  const protocol = await loadProtocol()
  const validated = protocol.validateObserverRegister(registerBody())
  assert.equal(validated.hostMode, 'tui')
  assert.equal(validated.registrationAttempt, 1)

  // Unknown field must fail closed.
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({ extra: 'x' })),
    /fields|unknown|invalid/i,
  )
  // Non-TUI host mode must fail.
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({ hostMode: 'rpc' })),
    /tui|hostMode|invalid/i,
  )
  // Missing a required field must fail.
  const missing = registerBody()
  delete missing.piSessionId
  assert.throws(() => protocol.validateObserverRegister(missing), /fields|piSessionId|invalid/i)
})

test('capabilities must be exactly three unique entries in canonical order', async () => {
  const protocol = await loadProtocol()
  // Duplicate capability.
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({
      capabilities: ['observe.lifecycle', 'observe.lifecycle', 'managed.activate'],
    })),
    /capabilit|duplicate|invalid/i,
  )
  // Foreign capability.
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({
      capabilities: ['observe.lifecycle', 'adoption.acknowledge', 'foreign.capability'],
    })),
    /capabilit|foreign|invalid/i,
  )
  // Wrong count.
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({
      capabilities: ['observe.lifecycle', 'adoption.acknowledge'],
    })),
    /capabilit|three|invalid/i,
  )
})

test('heartbeat, lifecycle, close, and adoption.ack require exact body fields', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.validateObserverHeartbeat(heartbeatBody()).sourceSequence, 2)
  assert.equal(protocol.validateObserverLifecycle(lifecycleBody()).eventId.length > 0, true)
  assert.equal(protocol.validateObserverClose(closeBody()).reason, 'quit')
  assert.equal(protocol.validateAdoptionAck(adoptionAckBody()).decision, 'acknowledged')

  // Unknown fields fail closed on every envelope.
  assert.throws(() => protocol.validateObserverHeartbeat(heartbeatBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateObserverLifecycle(lifecycleBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateObserverClose(closeBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateObserverAdoptionAck(adoptionAckBody({ extra: 1 })), /fields|unknown|invalid/i)
})

test('close reasons are exactly quit, reload, new, resume, or fork', async () => {
  const protocol = await loadProtocol()
  for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
    assert.equal(protocol.validateObserverClose(closeBody({ reason })).reason, reason)
  }
  assert.throws(() => protocol.validateObserverClose(closeBody({ reason: 'kill' })), /reason|invalid/i)
})

test('adoption.ack decision is acknowledged or refused and refusalCode is null only for acknowledgement', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.validateAdoptionAck(adoptionAckBody()).decision, 'acknowledged')
  assert.equal(
    protocol.validateAdoptionAck(adoptionAckBody({ decision: 'refused', refusalCode: 'session_busy' })).refusalCode,
    'session_busy',
  )
  // Acknowledged with a non-null refusal code is invalid.
  assert.throws(
    () => protocol.validateAdoptionAck(adoptionAckBody({ refusalCode: 'session_busy' })),
    /refusal|decision|invalid/i,
  )
  // Unknown decision.
  assert.throws(
    () => protocol.validateAdoptionAck(adoptionAckBody({ decision: 'maybe' })),
    /decision|invalid/i,
  )
})

test('registry-to-observer envelopes require exact body fields and locked values', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.validateObserverRegistered(registeredBody()).piStatus, 'Unassigned · observed')
  assert.equal(protocol.validateObserverRejected(rejectedBody()).code, 'incompatible_extension')
  assert.equal(protocol.validateAdoptionRequestAck(adoptionRequestAckBody()).targetRole, 'builder')
  assert.equal(protocol.validateAdoptionCommitted(adoptionCommittedBody()).controlMode, 'managed')
  assert.equal(protocol.validateAdoptionCommitted(adoptionCommittedBody()).runtimeBindingGuarantee, 'unavailable')
  assert.equal(protocol.validateAdoptionFailed(adoptionFailedBody()).code, 'transaction_failed')

  // Unknown fields fail closed.
  assert.throws(() => protocol.validateObserverRegistered(registeredBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateObserverRejected(rejectedBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateAdoptionRequestAck(adoptionRequestAckBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateAdoptionCommitted(adoptionCommittedBody({ extra: 1 })), /fields|unknown|invalid/i)
  assert.throws(() => protocol.validateAdoptionFailed(adoptionFailedBody({ extra: 1 })), /fields|unknown|invalid/i)
})

test('adoption.committed controlMode is exactly managed and runtime guarantee is unavailable', async () => {
  const protocol = await loadProtocol()
  assert.throws(
    () => protocol.validateAdoptionCommitted(adoptionCommittedBody({ controlMode: 'manual_takeover' })),
    /controlMode|managed|invalid/i,
  )
  assert.throws(
    () => protocol.validateAdoptionCommitted(adoptionCommittedBody({ runtimeBindingGuarantee: 'guaranteed' })),
    /runtime|unavailable|invalid/i,
  )
})

test('proposalDigest is exactly 64 lowercase hexadecimal characters', async () => {
  const protocol = await loadProtocol()
  assert.throws(
    () => protocol.validateAdoptionAck(adoptionAckBody({ proposalDigest: 'not-a-digest' })),
    /digest|hex|invalid/i,
  )
  assert.throws(
    () => protocol.validateAdoptionAck(adoptionAckBody({ proposalDigest: 'A'.repeat(64) })),
    /digest|hex|invalid/i,
  )
})

test('hostPid is a positive integer bounded to 2^31-1 and is diagnostic only', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.validateObserverRegister(registerBody({ hostPid: 1 })).hostPid, 1)
  assert.throws(() => protocol.validateObserverRegister(registerBody({ hostPid: 0 })), /hostPid|integer|invalid/i)
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({ hostPid: 2 ** 31 })),
    /hostPid|integer|invalid/i,
  )
})

test('non-finite, cyclic, and deeply nested values are rejected', async () => {
  const protocol = await loadProtocol()
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({ sourceSequence: Number.NaN })),
    /finite|integer|invalid/i,
  )
  assert.throws(
    () => protocol.validateObserverRegister(registerBody({ sourceSequence: Number.POSITIVE_INFINITY })),
    /finite|integer|invalid/i,
  )
  // Cyclic value.
  const cyclic: Record<string, unknown> = registerBody()
  cyclic.self = cyclic
  assert.throws(() => protocol.validateObserverRegister(cyclic), /finite|acyclic|invalid/i)
})

test('envelope and decode-buffer byte bounds are enforced', async () => {
  const protocol = await loadProtocol()
  // Oversized register body must be rejected as envelope_too_large.
  const oversized = registerBody({ health: 'x'.repeat(20 * 1024) })
  assert.throws(() => protocol.validateObserverRegister(oversized), /too_large|envelope|bytes/i)

  // The incremental decoder rejects a partial buffer over 32 KiB.
  const decoder = new protocol.NdjsonDecoder()
  assert.throws(
    () => decoder.push('x'.repeat(33 * 1024)),
    /decoder|buffer|overflow|32/i,
  )
})

test('encodeFrame rejects unknown frame types and oversized frames', async () => {
  const protocol = await loadProtocol()
  assert.throws(
    () => protocol.encodeFrame('observer.unknown', 'message-1', registerBody()),
    /unknown|frame|type/i,
  )
  assert.throws(
    () => protocol.encodeFrame('observer.register', 'message-1', registerBody({ health: 'y'.repeat(20 * 1024) })),
    /too_large|frame|bytes/i,
  )
})

test('typed failures carry a stable code and bounded locally-authored detail', async () => {
  const protocol = await loadProtocol()
  const error = new protocol.ObserverError('privacy_violation', 'bounded detail')
  assert.equal(error.code, 'privacy_violation')
  assert.equal(error.detail, 'bounded detail')
  assert.ok(error instanceof Error)

  assert.throws(
    () => new protocol.ObserverError('foreign_code', 'bounded detail'),
    /code|stable|observer/i,
  )
  assert.throws(
    () => new protocol.ObserverError('privacy_violation', 'x'.repeat(1025)),
    /detail|1024|bound/i,
  )
})

test('detail and presentation bounds count Unicode characters rather than UTF-16 code units', async () => {
  const protocol = await loadProtocol()
  assert.equal(protocol.validateObserverRejected(rejectedBody({ detail: '😀'.repeat(1024) })).detail.length, 2048)
  assert.equal(
    protocol.validateAdoptionCommitted(adoptionCommittedBody({ piStatus: '😀'.repeat(512) })).piStatus.length,
    1024,
  )
  assert.throws(
    () => protocol.validateObserverRejected(rejectedBody({ detail: '😀'.repeat(1025) })),
    /detail|1024|bound/i,
  )
})

test('decoder bounds only the partial buffer, not an aggregate of complete bounded frames', async () => {
  const protocol = await loadProtocol()
  const line = protocol.encodeFrame('observer.register', 'message-1', registerBody())
  const count = Math.ceil((protocol.OBSERVER_LIMITS.decodeBufferBytes + 1) / Buffer.byteLength(line))
  const chunk = line.repeat(count)
  assert.ok(Buffer.byteLength(chunk) > protocol.OBSERVER_LIMITS.decodeBufferBytes)

  const decoder = new protocol.NdjsonDecoder()
  assert.equal(decoder.push(chunk).length, count)
})

test('failure details do not echo an unknown submitted frame type', async () => {
  const protocol = await loadProtocol()
  const submitted = 'private-submitted-frame-type'
  assert.throws(
    () => protocol.validateObserverBodyForType(submitted, {}),
    (error: unknown) => {
      assert.ok(error instanceof protocol.ObserverError)
      assert.equal(error.detail.includes(submitted), false)
      return true
    },
  )
})
