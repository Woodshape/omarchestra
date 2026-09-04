/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for the telemetry policy module. These tests are written
 * against the locked observer/Adoption v1 contract and are intended to FAIL
 * until `observer/telemetry-policy.ts` is implemented in Phase 3. No
 * production behavior is implemented here.
 *
 * The telemetry policy converts allow-listed same-process lifecycle facts into
 * the observer projection and rejects forbidden or unbounded fields BEFORE
 * they cross the observer seam. It performs no I/O.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function loadPolicy() {
  return await import('../telemetry-policy.ts')
}

function allowedFacts(overrides: Record<string, unknown> = {}) {
  return {
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    ...overrides,
  }
}

test('the authoritative observed record contains exactly the allow-listed fields', async () => {
  const policy = await loadPolicy()
  const record = policy.buildObservedRecord({
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...allowedFacts(),
    registryRevision: 1,
  })
  assert.deepEqual(Object.keys(record).sort(), [
    'activity',
    'availability',
    'executionNodeId',
    'extensionInstanceId',
    'health',
    'lifecycle',
    'observedSessionId',
    'piSessionId',
    'piStatus',
    'processIncarnationId',
    'registryRevision',
  ].sort())
  assert.equal(record.piStatus, 'Unassigned · observed')
})

test('the observed record contains no management or authority fields', async () => {
  const policy = await loadPolicy()
  const record = policy.buildObservedRecord({
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...allowedFacts(),
    registryRevision: 1,
  })
  const serialized = JSON.stringify(record)
  // `processIncarnationId` is a locked (P1) pseudonymous identity field that
  // the authoritative observed record must contain, so the substring
  // `process` is excluded here. Process AUTHORITY is still excluded: the exact
  // allow-listed key-set assertion above pins the record to its 11 fields,
  // none of which is a process-control/supervision/authority field.
  for (const forbidden of [
    'teamGoal', 'role', 'assignment', 'controlMode', 'writer', 'runtimeBinding',
    'prompt', 'pty', 'terminal', 'processControl', 'processAuthority', 'workflow',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `record must not contain ${forbidden}`)
  }
})

test('forbidden telemetry classes are rejected before transport', async () => {
  const policy = await loadPolicy()
  const forbiddenSamples: Array<[string, unknown]> = [
    ['prompt', 'write the code now'],
    ['response', 'here is the implementation'],
    ['thinking', 'I should refactor this'],
    ['conversation', { role: 'user', content: 'hello' }],
    ['tool name', 'bash'],
    ['tool argument', { command: 'rm -rf /' }],
    ['tool result', 'exit code 0'],
    ['terminal output', 'building project...'],
    ['repository content', 'function main() {}'],
    ['repository path', '/home/user/project/src'],
    ['cwd', '/home/user/project'],
    ['title', 'Omarchestra — Builder — managed'],
    ['focus', 'focused'],
    ['recency', 'last active 5s ago'],
    ['display name', 'Builder'],
    ['model', 'gpt-5.6-sol'],
    ['provider', 'openai'],
    ['credential', 'sk-secret-token'],
    ['environment name', 'HOME'],
    ['environment value', '/home/user'],
    ['raw error', 'TypeError: cannot read properties'],
  ]
  for (const [label, value] of forbiddenSamples) {
    assert.throws(
      () => policy.assertPrivacySafe(allowedFacts({ [label]: value })),
      /privacy|forbidden|reject/i,
      `forbidden class ${label} must be rejected`,
    )
  }
})

test('forbidden content never enters the projection', async () => {
  const policy = await loadPolicy()
  const record = policy.buildObservedRecord({
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...allowedFacts(),
    registryRevision: 1,
  })
  const projection = policy.projectObserved(record)
  assert.deepEqual(Object.keys(projection).sort(), [
    'agents',
    'observerRevision',
  ].sort())
  const agent = projection.agents[0]
  assert.deepEqual(Object.keys(agent).sort(), [
    'availability',
    'choices',
    'health',
    'lifecycle',
    'observedSessionId',
    'piStatus',
  ].sort())
  assert.equal(agent.piStatus, 'Unassigned · observed')
  // Process, Pi-session, extension, connection, challenge, PID, and Node
  // identity must not enter QML.
  const serialized = JSON.stringify(projection)
  for (const forbidden of [
    'processIncarnationId', 'piSessionId', 'extensionInstanceId', 'connectionId',
    'connectionChallenge', 'hostPid', 'executionNodeId',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `projection must not contain ${forbidden}`)
  }
})

test('privacy violations are rejected before persistence, logging, events, or projection', async () => {
  const policy = await loadPolicy()
  // A forbidden field must throw a typed privacy_violation error.
  assert.throws(
    () => policy.assertPrivacySafe(allowedFacts({ prompt: 'secret' })),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /privacy_violation/i)
      return true
    },
  )
})

test('allow-listed lifecycle facts pass the policy unchanged', async () => {
  const policy = await loadPolicy()
  const facts = allowedFacts()
  assert.doesNotThrow(() => policy.assertPrivacySafe(facts))
  const record = policy.buildObservedRecord({
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...facts,
    registryRevision: 1,
  })
  assert.equal(record.lifecycle, 'running')
  assert.equal(record.activity, 'idle')
  assert.equal(record.health, 'healthy')
})

test('lifecycle, activity, availability, health, and eligibility remain distinct', async () => {
  const policy = await loadPolicy()
  const record = policy.buildObservedRecord({
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...allowedFacts({
      lifecycle: 'exited',
      activity: 'unknown',
      availability: 'available',
      health: 'degraded',
    }),
    registryRevision: 1,
  })
  assert.equal(record.lifecycle, 'exited')
  assert.equal(record.activity, 'unknown')
  assert.equal(record.availability, 'available', 'current transport availability is not derived from lifecycle or health')
  assert.equal(record.health, 'degraded')
  assert.equal(Object.hasOwn(record, 'eligibility'), false)
})

test('record construction requires exactly every bounded allow-listed fact', async () => {
  const policy = await loadPolicy()
  const complete = {
    observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: 'execution-node-local',
    ...allowedFacts(),
    registryRevision: 1,
  }
  const missing = { ...complete }
  delete missing.processIncarnationId
  assert.throws(() => policy.buildObservedRecord(missing), /field|identity|invalid/i)
  assert.throws(
    () => policy.buildObservedRecord({ ...complete, processIncarnationId: undefined }),
    /identity|invalid/i,
  )
})

test('privacy guard rejects non-plain or nested values under allow-listed keys', async () => {
  const policy = await loadPolicy()
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(
    () => policy.assertPrivacySafe(allowedFacts({ health: cyclic })),
    /privacy|invalid|plain|value/i,
  )
  assert.throws(
    () => policy.assertPrivacySafe(Object.create({ prompt: 'hidden' })),
    /privacy|plain|object/i,
  )
})

test('unbounded or oversized fields are rejected', async () => {
  const policy = await loadPolicy()
  assert.throws(
    () => policy.assertPrivacySafe(allowedFacts({ health: 'x'.repeat(20 * 1024) })),
    /bound|too_large|invalid/i,
  )
})
