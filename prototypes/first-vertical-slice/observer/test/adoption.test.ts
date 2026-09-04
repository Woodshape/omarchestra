/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for transactional Adoption. These tests are written against
 * the locked observer/Adoption v1 contract and are intended to FAIL until
 * `observer/adoption.ts` is implemented in Phase 4.
 *
 * The test-local ports deliberately model only fake registry, authorization,
 * current observer transport, transaction, presentation, and dispatch seams.
 * They never create a process, socket, Pi session, PTY, terminal, provider,
 * Companion installation, or live Team Runner.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

async function loadAdoption() {
  return await import('../adoption.ts')
}

async function loadFakes() {
  return await import('../fakes.ts')
}

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
})

const PROPOSAL_DIGEST = 'a'.repeat(64)

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function observedRecord(overrides: Record<string, unknown> = {}) {
  return {
    observedSessionId: IDS.observedSessionId,
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: IDS.processIncarnationId,
    piSessionId: IDS.piSessionId,
    extensionInstanceId: IDS.extensionInstanceId,
    connectionId: IDS.connectionId,
    connectionChallenge: IDS.connectionChallenge,
    // PID exists only in this fake diagnostic source. It is never used by the
    // proposal identity or the transaction authority.
    hostPid: 41001,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    registryRevision: 7,
    piStatus: 'Unassigned · observed',
    ...overrides,
  }
}

function adoptionRequest(
  record: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    observedSessionId: record.observedSessionId,
    observedIdentity: {
      observedSessionId: record.observedSessionId,
      executionNodeId: record.executionNodeId,
      processIncarnationId: record.processIncarnationId,
      piSessionId: record.piSessionId,
      extensionInstanceId: record.extensionInstanceId,
      connectionId: record.connectionId,
      connectionChallenge: record.connectionChallenge,
    },
    connection: {
      id: 'transport-1',
      connectionId: record.connectionId,
      connectionChallenge: record.connectionChallenge,
    },
    target: {
      teamGoalId: 'team-goal-local-1',
      executionNodeId: IDS.executionNodeId,
      role: 'builder',
    },
    ...overrides,
  }
}

function authorizationFor(proposal: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    targetTeamGoalId: proposal.targetTeamGoalId,
    targetRole: proposal.targetRole,
    authorizationId: 'authorization-0000000000000000000000000000000000000000000000000000000000000001',
    token: 'fake-user-confirmation-token',
    ...overrides,
  }
}

function acknowledgementFor(
  proposal: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    processIncarnationId: proposal.processIncarnationId,
    piSessionId: proposal.piSessionId,
    extensionInstanceId: proposal.extensionInstanceId,
    connectionId: proposal.connectionId,
    connectionChallenge: proposal.connectionChallenge,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    acknowledgementNonce: proposal.acknowledgementNonce,
    registryRevision: proposal.registryRevision,
    sourceSequence: 8,
    decision: 'acknowledged',
    activity: 'idle',
    refusalCode: null,
    ...overrides,
  }
}

class FakeRegistryPort {
  record: Record<string, unknown> | null
  managed: Record<string, unknown> | null = null
  readonly localTeamGoals = new Set(['team-goal-local-1'])
  readonly occupiedRoles = new Set<string>()
  alreadyManaged = false

  constructor(record: Record<string, unknown>) {
    this.record = clone(record)
  }

  currentObservedSession(observedSessionId: unknown): Record<string, unknown> | null {
    if (this.record === null || this.record.observedSessionId !== observedSessionId) return null
    return clone(this.record)
  }

  getObservedSession(observedSessionId: unknown): Record<string, unknown> | null {
    return this.currentObservedSession(observedSessionId)
  }

  currentRevision(): number {
    return Number(this.record?.registryRevision ?? 0)
  }

  isLocalTeamGoal(teamGoalId: unknown, executionNodeId: unknown): boolean {
    return executionNodeId === IDS.executionNodeId && this.localTeamGoals.has(String(teamGoalId))
  }

  isRoleOccupied(teamGoalId: unknown, role: unknown): boolean {
    return this.occupiedRoles.has(`${String(teamGoalId)}:${String(role)}`)
  }

  isAlreadyManaged(_observedSessionId: unknown): boolean {
    return this.alreadyManaged
  }

  replace(record: Record<string, unknown> | null): void {
    this.record = record === null ? null : clone(record)
  }
}

class FakeObserverConnection {
  readonly id = 'transport-1'
  readonly sent: Array<Record<string, unknown>> = []
  failOnSend = false
  closeCount = 0

  sendAdoptionRequest(body: Record<string, unknown>): void {
    if (this.failOnSend) throw new Error('fake observer request delivery failed')
    this.sent.push(clone(body))
  }

  close(): void {
    this.closeCount += 1
  }
}

class FakeAuthorizer {
  allow = true
  readonly calls: Array<Record<string, unknown>> = []

  verify(proposal: Record<string, unknown>, authorization: Record<string, unknown>): boolean {
    this.calls.push({ proposal: clone(proposal), authorization: clone(authorization) })
    if (!this.allow) throw new Error('authorization_mismatch')
    if (authorization.proposalId !== proposal.proposalId
        || authorization.proposalDigest !== proposal.proposalDigest) {
      throw new Error('authorization_mismatch')
    }
    return true
  }
}

class FakeTransactionalTeamRunner {
  readonly transactionAttempts: Array<Record<string, unknown>> = []
  readonly durableCommits: Array<Record<string, unknown>> = []
  failBeforeCommit = false
  private readonly state: { registry: FakeRegistryPort }

  constructor(state: { registry: FakeRegistryPort }) {
    this.state = state
  }

  commitAdoption(input: Record<string, unknown>): Record<string, unknown> {
    this.transactionAttempts.push(clone(input))
    if (this.failBeforeCommit) throw new Error('transaction_failed')

    const proposal = input.proposal as Record<string, unknown>
    const committed = {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      agentRunId: IDS.agentRunId,
      targetTeamGoalId: proposal.targetTeamGoalId,
      targetRole: proposal.targetRole,
      controlMode: 'managed',
      piStatus: 'Builder · managed',
      terminalTitleMetadata: 'Omarchestra — Builder — managed',
      runtimeBinding: null,
      runtimeBindingGuarantee: 'unavailable',
    }
    this.durableCommits.push(clone(committed))
    this.state.registry.managed = clone(committed)
    this.state.registry.replace(null)
    return committed
  }
}

class FakePresentationPort {
  readonly updates: Array<Record<string, unknown>> = []
  fail = false

  applyCommitted(update: Record<string, unknown>): void {
    this.updates.push(clone(update))
    if (this.fail) throw new Error('postcommit_delivery_failed')
  }
}

class FakeDispatchPort {
  readonly assignments: Array<Record<string, unknown>> = []
  readonly prompts: string[] = []
  readonly processActions: string[] = []

  dispatch(assignment: Record<string, unknown>): void {
    this.assignments.push(clone(assignment))
  }
}

async function createHarness(adoptionModule: any, fakesModule: any, overrides: {
  record?: Record<string, unknown>
  target?: Record<string, unknown>
  alreadyManaged?: boolean
} = {}) {
  const clock = new fakesModule.FakeMonotonicClock(0)
  const registry = new FakeRegistryPort(overrides.record ?? observedRecord())
  registry.alreadyManaged = overrides.alreadyManaged ?? false
  const connection = new FakeObserverConnection()
  const authorizer = new FakeAuthorizer()
  const teamRunner = new FakeTransactionalTeamRunner({ registry })
  const presentation = new FakePresentationPort()
  const dispatch = new FakeDispatchPort()

  const coordinator = new adoptionModule.AdoptionCoordinator({
    clock,
    registry,
    authorizer,
    authorization: authorizer,
    observerConnection: connection,
    teamRunner,
    transaction: teamRunner,
    presentation,
    dispatch,
  })

  return {
    clock,
    registry,
    connection,
    authorizer,
    teamRunner,
    presentation,
    dispatch,
    coordinator,
    request: adoptionRequest(registry.record ?? observedRecord(), {
      ...(overrides.target === undefined ? {} : { target: overrides.target }),
    }),
  }
}

async function modules() {
  const [adoptionModule, fakesModule] = await Promise.all([loadAdoption(), loadFakes()])
  return { adoptionModule, fakesModule }
}

async function propose(harness: any): Promise<Record<string, unknown>> {
  return await harness.coordinator.createProposal(harness.request)
}

async function authorize(harness: any, proposal: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await harness.coordinator.authorizeProposal(proposal.proposalId, authorizationFor(proposal))
}

async function acceptAcknowledgement(
  harness: any,
  proposal: Record<string, unknown>,
  transport: FakeObserverConnection = harness.connection,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await harness.coordinator.acceptAcknowledgement(
    transport,
    acknowledgementFor(proposal, overrides),
  )
}

function assertObservedXorManaged(harness: any): void {
  const observed = harness.registry.record !== null
  const managed = harness.registry.managed !== null
  assert.equal(observed !== managed, true, 'state must be exactly observed/unassigned or managed')
}

function assertNoManagedWork(harness: any): void {
  assert.deepEqual(harness.dispatch.assignments, [])
  assert.deepEqual(harness.dispatch.prompts, [])
  assert.deepEqual(harness.dispatch.processActions, [])
}

// ---------------------------------------------------------------------------
// Ordering and successful commit
// ---------------------------------------------------------------------------

test('Adoption ordering is propose → authorize → same-connection ack → reconcile → one atomic commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)

  const proposal = await propose(harness)
  assert.equal(proposal.observedSessionId, IDS.observedSessionId)
  assert.equal(proposal.targetTeamGoalId, 'team-goal-local-1')
  assert.equal(proposal.targetExecutionNodeId, IDS.executionNodeId)
  assert.equal(proposal.targetRole, 'builder')
  assert.equal(typeof proposal.proposalId, 'string')
  assert.equal(typeof proposal.proposalDigest, 'string')
  assert.equal(proposal.proposalDigest.length, 64)
  assert.equal(harness.teamRunner.transactionAttempts.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)

  const requestAck = await authorize(harness, proposal)
  assert.equal(requestAck.proposalId, proposal.proposalId)
  assert.equal(requestAck.proposalDigest, proposal.proposalDigest)
  assert.equal(requestAck.acknowledgementNonce, proposal.acknowledgementNonce)
  assert.equal(requestAck.targetRole, 'builder')
  assert.equal(harness.teamRunner.transactionAttempts.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)

  const committed = await acceptAcknowledgement(harness, proposal)
  assert.equal(harness.teamRunner.durableCommits.length, 1)
  assert.equal(harness.registry.record, null)
  assert.equal(harness.registry.managed?.agentRunId, IDS.agentRunId)
  assert.equal(committed.controlMode, 'managed')
  assert.equal(committed.runtimeBinding, null)
  assert.equal(committed.runtimeBindingGuarantee, 'unavailable')
  assert.deepEqual(harness.presentation.updates, [committed])
  assertObservedXorManaged(harness)
})

test('no assignment, prompt, process action, PTY guarantee, or Runtime Binding exists before the durable commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)

  const proposal = await propose(harness)
  assertNoManagedWork(harness)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assert.equal(harness.registry.managed, null)
  assert.match(JSON.stringify(proposal).toLowerCase(), /proposal|observed/)
  assert.doesNotMatch(JSON.stringify(proposal).toLowerCase(), /runtimebinding|pty|assignment|prompt/)

  await authorize(harness, proposal)
  assertNoManagedWork(harness)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assert.equal(harness.registry.managed, null)

  const committed = await acceptAcknowledgement(harness, proposal)
  assertNoManagedWork(harness)
  assert.equal(committed.runtimeBinding, null)
  assert.equal(committed.runtimeBindingGuarantee, 'unavailable')
  assert.notEqual(harness.teamRunner.durableCommits.length, 0)
})

// ---------------------------------------------------------------------------
// Proposal eligibility and identity matrix
// ---------------------------------------------------------------------------

test('stale identity is rejected before proposal creation and leaves observation unchanged', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  harness.request.observedIdentity.extensionInstanceId = 'ext-instance-stale-0000000000000000000000000000000000000000000000000000000000000002'

  await assert.rejects(() => propose(harness), /identity|stale|current/i)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('a reused PID cannot correlate a new process to the old observed session', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const oldRecord = observedRecord({ hostPid: 41001 })
  const harness = await createHarness(adoptionModule, fakesModule, { record: oldRecord })
  // The PID is equal, but every process/session/extension capability is new.
  harness.request.observedIdentity.processIncarnationId = 'proc-incarnation-new-0000000000000000000000000000000000000000000000000000000000000002'
  harness.request.observedIdentity.piSessionId = 'pi-session-new-0000000000000000000000000000000000000000000000000000000000000002'
  harness.request.observedIdentity.extensionInstanceId = 'ext-instance-new-0000000000000000000000000000000000000000000000000000000000000002'

  await assert.rejects(() => propose(harness), /identity|stale|current|session/i)
  assert.equal(harness.registry.record?.hostPid, 41001)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertObservedXorManaged(harness)
})

test('Node mismatch is rejected before authorization or commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule, {
    target: {
      teamGoalId: 'team-goal-local-1',
      executionNodeId: 'execution-node-other',
      role: 'builder',
    },
  })

  await assert.rejects(() => propose(harness), /node|mismatch|local/i)
  assert.equal(harness.authorizer.calls.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertObservedXorManaged(harness)
})

test('remote Team Goal is rejected even when the selected Role is otherwise vacant', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule, {
    target: {
      teamGoalId: 'team-goal-remote-1',
      executionNodeId: IDS.executionNodeId,
      role: 'builder',
    },
  })

  await assert.rejects(() => propose(harness), /remote|team.goal|local/i)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertObservedXorManaged(harness)
})

test('occupied Role is rejected before a proposal can be authorized', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  harness.registry.occupiedRoles.add('team-goal-local-1:builder')

  await assert.rejects(() => propose(harness), /role|occupied|conflict/i)
  assert.equal(harness.authorizer.calls.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertObservedXorManaged(harness)
})

for (const [name, record, expected, alreadyManaged] of [
  ['busy session', observedRecord({ activity: 'busy' }), /busy|reconcile|eligible/i, false],
  ['exited session', observedRecord({ lifecycle: 'exited' }), /exit|lifecycle|unavailable/i, false],
  ['already-managed session', observedRecord(), /already|managed|unavailable/i, true],
] as const) {
  test(`${name} cannot create an Adoption proposal`, async () => {
    const { adoptionModule, fakesModule } = await modules()
    const harness = await createHarness(adoptionModule, fakesModule, { record, alreadyManaged })

    await assert.rejects(() => propose(harness), expected)
    assert.equal(harness.authorizer.calls.length, 0)
    assert.equal(harness.teamRunner.durableCommits.length, 0)
    assertNoManagedWork(harness)
    assertObservedXorManaged(harness)
  })
}

test('unavailable or expired observation cannot be adopted', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule, {
    record: observedRecord({ availability: 'unavailable' }),
  })

  await assert.rejects(() => propose(harness), /unavailable|expired|current/i)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertObservedXorManaged(harness)
})

test('a second pending proposal is rejected and cannot create a second proposal identity', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)

  const first = await propose(harness)
  await assert.rejects(() => propose(harness), /duplicate|proposal|conflict|pending/i)
  assert.equal(harness.teamRunner.transactionAttempts.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assert.notEqual(first.proposalId, undefined)
  assertObservedXorManaged(harness)
})

test('proposal expiry is controlled by the injected monotonic clock and blocks authorization', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  harness.clock.advance(30001)

  await assert.rejects(() => authorize(harness, proposal), /proposal|expired|timeout/i)
  assert.equal(harness.connection.sent.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

// ---------------------------------------------------------------------------
// Authorization, acknowledgement, reconciliation, identity drift, and crash
// ---------------------------------------------------------------------------

test('authorization must bind the exact immutable proposal before an ack request is sent', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  harness.authorizer.allow = false

  await assert.rejects(
    () => harness.coordinator.authorizeProposal(
      proposal.proposalId,
      authorizationFor(proposal, { proposalDigest: 'b'.repeat(64) }),
    ),
    /authorization|mismatch|confirm/i,
  )
  assert.equal(harness.connection.sent.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('failure delivering the acknowledgement request leaves the session observed and unassigned', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  harness.connection.failOnSend = true

  await assert.rejects(() => authorize(harness, proposal), /deliver|connection|observer|failed/i)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('acknowledgement refusal cannot commit or dispatch managed work', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal, harness.connection, {
      decision: 'refused',
      activity: 'busy',
      refusalCode: 'session_busy',
    }),
    /ack|refus|busy/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('acknowledgement timeout is controlled by the injected monotonic clock', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  harness.clock.advance(5001)

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal),
    /ack|timeout|expired/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('equal acknowledgement fields on another transport are rejected', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  const otherTransport = new FakeObserverConnection()

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal, otherTransport),
    /connection|current|transport|identity/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('acknowledgement nonce and proposal digest must match the authorized proposal exactly', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal, harness.connection, {
      acknowledgementNonce: 'nonce-mismatch-0000000000000000000000000000000000000000000000000000000000000002',
      proposalDigest: 'b'.repeat(64),
    }),
    /nonce|digest|proposal|mismatch|stale/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('identity or registry revision drift after authorization invalidates the pending attempt', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  harness.registry.replace(observedRecord({
    processIncarnationId: 'proc-incarnation-drift-0000000000000000000000000000000000000000000000000000000000000002',
    registryRevision: 8,
  }))

  await assert.rejects(() => acceptAcknowledgement(harness, proposal), /drift|identity|revision|stale/i)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('busy reconciliation after an otherwise acknowledged proposal prevents commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal, harness.connection, { activity: 'busy' }),
    /reconcil|busy|eligible/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('unknown reconciliation refuses Adoption instead of assuming idle', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal, harness.connection, { activity: 'unknown' }),
    /unknown|reconcil|ack/i,
  )
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('transaction failure rolls back fully to observed/unassigned and performs no dispatch', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  harness.teamRunner.failBeforeCommit = true

  await assert.rejects(() => acceptAcknowledgement(harness, proposal), /transaction|commit|failed/i)
  assert.equal(harness.teamRunner.transactionAttempts.length, 1)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assert.equal(harness.registry.record?.piStatus, 'Unassigned · observed')
  assert.equal(harness.registry.managed, null)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('post-commit presentation failure preserves exactly one committed managed result', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  harness.presentation.fail = true

  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal),
    /postcommit|delivery|presentation|failed/i,
  )
  assert.equal(harness.teamRunner.transactionAttempts.length, 1)
  assert.equal(harness.teamRunner.durableCommits.length, 1)
  assert.equal(harness.registry.record, null)
  assert.equal(harness.registry.managed?.controlMode, 'managed')
  assert.equal(harness.registry.managed?.runtimeBinding, null)
  assert.equal(harness.registry.managed?.runtimeBindingGuarantee, 'unavailable')
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('replaying an already committed proposal returns the same result without a second durable commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  const first = await acceptAcknowledgement(harness, proposal)
  const second = await acceptAcknowledgement(harness, proposal)

  assert.deepEqual(second, first)
  assert.equal(harness.teamRunner.transactionAttempts.length, 1)
  assert.equal(harness.teamRunner.durableCommits.length, 1)
  assertObservedXorManaged(harness)
})

test('restart discards pending proposals and requires a fresh proposal', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)

  // A coordinator restart must discard the pending proposal: the authorized
  // acknowledgement can no longer commit it.
  harness.coordinator.reconstruct()
  await assert.rejects(
    () => acceptAcknowledgement(harness, proposal),
    /proposal|not.found|current/i,
  )
  assert.equal(harness.teamRunner.transactionAttempts.length, 0)
  assert.equal(harness.teamRunner.durableCommits.length, 0)
  assertNoManagedWork(harness)
  assertObservedXorManaged(harness)
})

test('committed state reconstructs once after restart without a second durable commit', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  const first = await acceptAcknowledgement(harness, proposal)

  // A coordinator restart must not recreate the committed Agent Run as an
  // observed session; the durable managed result reconstructs once.
  harness.coordinator.reconstruct()
  const second = await acceptAcknowledgement(harness, proposal)
  assert.deepEqual(second, first)
  assert.equal(harness.teamRunner.transactionAttempts.length, 1)
  assert.equal(harness.teamRunner.durableCommits.length, 1)
  assert.equal(harness.registry.record, null)
  assert.equal(harness.registry.managed?.controlMode, 'managed')
  assertObservedXorManaged(harness)
})

test('committed state has managed control but no fabricated Runtime Binding or PTY guarantee', async () => {
  const { adoptionModule, fakesModule } = await modules()
  const harness = await createHarness(adoptionModule, fakesModule)
  const proposal = await propose(harness)
  await authorize(harness, proposal)
  const committed = await acceptAcknowledgement(harness, proposal)

  assert.equal(committed.controlMode, 'managed')
  assert.equal(committed.runtimeBinding, null)
  assert.equal(committed.runtimeBindingGuarantee, 'unavailable')
  assert.notEqual(committed.runtimeBindingGuarantee, 'guaranteed')
  assert.notEqual(Object.hasOwn(committed, 'ptyGuarantee') && committed.ptyGuarantee, true)
  assert.equal(harness.registry.record, null)
  assert.equal(harness.registry.managed?.agentRunId, IDS.agentRunId)
})
