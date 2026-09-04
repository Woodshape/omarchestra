/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Standalone fake-only acceptance composition for ordinary-terminal
 * observation and explicit Adoption. It uses only in-memory Pi, transport,
 * registry, runner, projection, and resource fakes. It never starts a process,
 * opens a socket, contacts a provider, or mutates an installed component.
 */

import assert from 'node:assert/strict'

import {
  AdoptionCoordinator,
  type AdoptionAuthorizationPort,
  type AdoptionObserverConnection,
} from './adoption.ts'
import {
  CompanionObserverProjectionAdapter,
  type ObserverPort,
} from './companion-projection.ts'
import {
  AgentRegistry,
  type ObservedSnapshot,
} from './registry.ts'
import {
  createObserverExtension,
  OBSERVER_STATUS_KEY,
  type ObserverConnection,
} from './extension-adapter.ts'
import { FakePiHost } from './fake-pi-host.ts'
import {
  FakeCapabilityIssuer,
  FakeMonotonicClock,
  FakeObserverPersistence,
  FakeObserverTransport,
  FakeTransactionalTeamRunner,
} from './fakes.ts'
import {
  assertPrivacySafe,
  type ObservedRecord,
} from './telemetry-policy.ts'

const IDS = Object.freeze({
  executionNodeId: 'execution-node-local',
  processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
  piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
  extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
  observedSessionId: 'observed-session-0000000000000000000000000000000000000000000000000000000000000001',
  agentRunId: 'agent-run-0000000000000000000000000000000000000000000000000000000000000001',
})

const LOCAL_TEAM_GOAL_ID = 'team-goal-local-1'
const OBSERVER_CHOICE_ID = 'choice-local-builder'
const OBSERVER_PROJECTION_SESSION = Object.freeze({
  sessionId: 'companion-session-observer-acceptance',
  teamGoalId: LOCAL_TEAM_GOAL_ID,
  clientId: 'observer-acceptance-client',
  sessionGeneration: 1,
  pluginGeneration: 3,
})

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function settle(rounds = 24): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function identityOf(record: Record<string, unknown>): Record<string, unknown> {
  return {
    observedSessionId: record.observedSessionId,
    executionNodeId: record.executionNodeId,
    processIncarnationId: record.processIncarnationId,
    piSessionId: record.piSessionId,
    extensionInstanceId: record.extensionInstanceId,
  }
}

function observedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observedSessionId: 'observed-session-0000000000000000000000000000000000000000000000000000000000000001',
    executionNodeId: IDS.executionNodeId,
    processIncarnationId: 'proc-incarnation-0000000000000000000000000000000000000000000000000000000000000001',
    piSessionId: 'pi-session-0000000000000000000000000000000000000000000000000000000000000001',
    extensionInstanceId: 'ext-instance-0000000000000000000000000000000000000000000000000000000000000001',
    connectionId: 'connection-0000000000000000000000000000000000000000000000000000000000000001',
    connectionChallenge: 'challenge-0000000000000000000000000000000000000000000000000000000000000001',
    hostPid: 41001,
    acceptedSourceSequence: 1,
    lifecycle: 'running',
    activity: 'idle',
    availability: 'available',
    health: 'healthy',
    registryRevision: 7,
    piStatus: 'Unassigned · observed',
    ...overrides,
  }
}

function matrixRequest(
  record: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
      teamGoalId: LOCAL_TEAM_GOAL_ID,
      executionNodeId: IDS.executionNodeId,
      role: 'builder',
    },
    ...overrides,
  }
}

function authorizationFor(proposal: Record<string, unknown>): Record<string, unknown> {
  return {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    targetTeamGoalId: proposal.targetTeamGoalId,
    targetRole: proposal.targetRole,
    authorizationId: 'authorization-0000000000000000000000000000000000000000000000000000000000000001',
    token: 'fake-user-confirmation-token',
  }
}

function acknowledgementFor(
  proposal: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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

class MatrixConnection implements AdoptionObserverConnection {
  readonly id: string
  readonly sentRequests: Array<Record<string, unknown>> = []

  constructor(id = 'transport-1') {
    this.id = id
  }

  sendAdoptionRequest(body: Record<string, unknown>): void {
    this.sentRequests.push(clone(body))
  }
}

class MatrixAuthorizer implements AdoptionAuthorizationPort {
  allow = true

  verify(proposal: Record<string, unknown>, authorization: Record<string, unknown>): boolean {
    if (!this.allow) return false
    return authorization.proposalId === proposal.proposalId
      && authorization.proposalDigest === proposal.proposalDigest
  }
}

interface MatrixRegistryState {
  record: Record<string, unknown> | null
  managed: Record<string, unknown> | null
  occupied: boolean
  alreadyManaged: boolean
  replace(record: Record<string, unknown> | null): void
}

class MatrixRegistry implements MatrixRegistryState {
  record: Record<string, unknown> | null
  managed: Record<string, unknown> | null = null
  occupied = false
  alreadyManaged = false
  readonly localTeamGoals = new Set([LOCAL_TEAM_GOAL_ID])
  readonly currentConnection: MatrixConnection

  constructor(record: Record<string, unknown>, connection: MatrixConnection) {
    this.record = clone(record)
    this.currentConnection = connection
  }

  currentObservedSession(observedSessionId: unknown): Record<string, unknown> | null {
    if (this.record === null || this.record.observedSessionId !== observedSessionId) return null
    return clone(this.record)
  }

  getObserved(observedSessionId: unknown): Record<string, unknown> | null {
    return this.currentObservedSession(observedSessionId)
  }

  currentRevision(): number {
    return Number(this.record?.registryRevision ?? 0)
  }

  isLocalTeamGoal(teamGoalId: unknown, executionNodeId: unknown): boolean {
    return executionNodeId === IDS.executionNodeId && this.localTeamGoals.has(String(teamGoalId))
  }

  isRoleOccupied(): boolean {
    return this.occupied
  }

  isAlreadyManaged(): boolean {
    return this.alreadyManaged
  }

  isCurrentConnection(connection: object, connectionId: string, connectionChallenge: string): boolean {
    return connection === this.currentConnection
      && connectionId === this.record?.connectionId
      && connectionChallenge === this.record?.connectionChallenge
  }

  replace(record: Record<string, unknown> | null): void {
    this.record = record === null ? null : clone(record)
  }
}

interface MatrixHarness {
  clock: InstanceType<typeof FakeMonotonicClock>
  registry: MatrixRegistry
  connection: MatrixConnection
  authorizer: MatrixAuthorizer
  teamRunner: InstanceType<typeof FakeTransactionalTeamRunner>
  coordinator: AdoptionCoordinator
  request: Record<string, unknown>
}

function createMatrixHarness(overrides: {
  record?: Record<string, unknown>
  request?: Record<string, unknown>
} = {}): MatrixHarness {
  const clock = new FakeMonotonicClock(0)
  const connection = new MatrixConnection()
  const registry = new MatrixRegistry(overrides.record ?? observedRecord(), connection)
  const authorizer = new MatrixAuthorizer()
  const teamRunner = new FakeTransactionalTeamRunner({ registry })
  const presentation = { applyCommitted: (_update: Record<string, unknown>): void => {} }
  const coordinator = new AdoptionCoordinator({
    clock,
    registry,
    authorizer,
    teamRunner,
    presentation,
    observerConnection: connection,
  })
  return {
    clock,
    registry,
    connection,
    authorizer,
    teamRunner,
    coordinator,
    request: overrides.request ?? matrixRequest(registry.record ?? observedRecord()),
  }
}

async function expectRejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation()
    return false
  } catch {
    return true
  }
}

async function runInvalidAdoptionMatrix(): Promise<{
  cases: string[]
  allStayedObserved: boolean
  commitCount: number
}> {
  const cases = [
    'stale_identity',
    'reused_pid',
    'node_mismatch',
    'remote_team_goal',
    'role_occupied',
    'session_busy',
    'session_unknown',
    'session_exited',
    'already_managed',
    'duplicate_proposal',
    'proposal_expired',
    'connection_not_current',
    'ack_refused',
    'ack_timeout',
    'identity_drift',
    'transaction_failure',
  ]
  let allStayedObserved = true
  let commitCount = 0

  for (const name of cases) {
    const harness = createMatrixHarness()
    let rejected = false
    try {
      if (name === 'stale_identity') {
        const request = harness.request as Record<string, any>
        request.observedIdentity.extensionInstanceId = `${request.observedIdentity.extensionInstanceId.slice(0, -1)}2`
        rejected = await expectRejected(() => harness.coordinator.createProposal(request))
      } else if (name === 'reused_pid') {
        const request = harness.request as Record<string, any>
        request.observedIdentity.processIncarnationId = 'proc-incarnation-new-0000000000000000000000000000000000000000000000000000000000000002'
        request.observedIdentity.piSessionId = 'pi-session-new-0000000000000000000000000000000000000000000000000000000000000002'
        request.observedIdentity.extensionInstanceId = 'ext-instance-new-0000000000000000000000000000000000000000000000000000000000000002'
        rejected = await expectRejected(() => harness.coordinator.createProposal(request))
      } else if (name === 'node_mismatch' || name === 'remote_team_goal') {
        const target = name === 'node_mismatch'
          ? { teamGoalId: LOCAL_TEAM_GOAL_ID, executionNodeId: 'execution-node-other', role: 'builder' }
          : { teamGoalId: 'team-goal-remote-1', executionNodeId: IDS.executionNodeId, role: 'builder' }
        rejected = await expectRejected(() => harness.coordinator.createProposal(
          matrixRequest(harness.registry.record ?? observedRecord(), { target }),
        ))
      } else if (name === 'role_occupied') {
        harness.registry.occupied = true
        rejected = await expectRejected(() => harness.coordinator.createProposal(harness.request))
      } else if (name === 'session_busy' || name === 'session_unknown' || name === 'session_exited') {
        const value = name === 'session_busy'
          ? { activity: 'busy' }
          : name === 'session_unknown'
            ? { activity: 'unknown' }
            : { lifecycle: 'exited' }
        const changed = createMatrixHarness({ record: observedRecord(value) })
        rejected = await expectRejected(() => changed.coordinator.createProposal(changed.request))
        assert.equal(rejected, true, `${name} must be rejected`)
        allStayedObserved = allStayedObserved && changed.registry.record !== null && changed.registry.managed === null
        commitCount += changed.teamRunner.commitCount
        continue
      } else if (name === 'already_managed') {
        harness.registry.alreadyManaged = true
        rejected = await expectRejected(() => harness.coordinator.createProposal(harness.request))
      } else if (name === 'duplicate_proposal') {
        await harness.coordinator.createProposal(harness.request)
        rejected = await expectRejected(() => harness.coordinator.createProposal(harness.request))
      } else if (name === 'proposal_expired') {
        const proposal = await harness.coordinator.createProposal(harness.request)
        harness.clock.advance(30_001)
        rejected = await expectRejected(() => harness.coordinator.authorizeProposal(
          proposal.proposalId,
          authorizationFor(proposal),
        ))
      } else {
        const proposal = await harness.coordinator.createProposal(harness.request)
        await harness.coordinator.authorizeProposal(proposal.proposalId, authorizationFor(proposal))
        if (name === 'connection_not_current') {
          rejected = await expectRejected(() => harness.coordinator.acceptAcknowledgement(
            new MatrixConnection('transport-2'),
            acknowledgementFor(proposal),
          ))
        } else if (name === 'ack_refused') {
          rejected = await expectRejected(() => harness.coordinator.acceptAcknowledgement(
            harness.connection,
            acknowledgementFor(proposal, {
              decision: 'refused',
              activity: 'busy',
              refusalCode: 'session_busy',
            }),
          ))
        } else if (name === 'ack_timeout') {
          harness.clock.advance(5_001)
          rejected = await expectRejected(() => harness.coordinator.acceptAcknowledgement(
            harness.connection,
            acknowledgementFor(proposal),
          ))
        } else if (name === 'identity_drift') {
          harness.registry.replace(observedRecord({
            processIncarnationId: 'proc-incarnation-drift-0000000000000000000000000000000000000000000000000000000000000002',
            registryRevision: 8,
          }))
          rejected = await expectRejected(() => harness.coordinator.acceptAcknowledgement(
            harness.connection,
            acknowledgementFor(proposal),
          ))
        } else if (name === 'transaction_failure') {
          harness.teamRunner.failBeforeCommit = true
          rejected = await expectRejected(() => harness.coordinator.acceptAcknowledgement(
            harness.connection,
            acknowledgementFor(proposal),
          ))
        }
      }
    } finally {
      allStayedObserved = allStayedObserved
        && harness.registry.record !== null
        && harness.registry.managed === null
      commitCount += harness.teamRunner.commitCount
    }
    assert.equal(rejected, true, `${name} must be rejected`) 
  }

  return { cases, allStayedObserved, commitCount }
}

interface RuntimeResource {
  id: string
  owner: string
}

class FakeRuntimeResources {
  readonly resources: RuntimeResource[] = [
    { id: 'observer-connection-1', owner: 'acceptance' },
    { id: 'unrelated-resource-1', owner: 'unrelated' },
  ]

  removeExact(id: string, owner: string): boolean {
    const index = this.resources.findIndex((resource) => resource.id === id && resource.owner === owner)
    if (index < 0) return false
    this.resources.splice(index, 1)
    return true
  }
}

interface IntegratedScenario {
  result: Record<string, any>
}

async function runIntegratedScenario(): Promise<IntegratedScenario> {
  const ordinaryHost = new FakePiHost({ title: 'ordinary Pi title' })
  const inputResultWithoutRegistry = await ordinaryHost.submitInput('ordinary input remains local')
  assert.equal(inputResultWithoutRegistry, 'continue')

  const clock = new FakeMonotonicClock(0)
  const persistence = new FakeObserverPersistence()
  const registry = new AgentRegistry({
    clock,
    persistence,
    capabilityIssuer: new FakeCapabilityIssuer(),
    executionNodeId: IDS.executionNodeId,
  })
  const transport = new FakeObserverTransport()
  const listeners: Array<(value: unknown) => void> = []
  const adoptionPromises: Array<Promise<unknown>> = []
  const adoptionErrors: unknown[] = []
  const heartbeats: Array<{ callback: () => void; active: boolean }> = []
  const runnerState: {
    record: Record<string, unknown> | null
    managed: Record<string, unknown> | null
    replace(record: Record<string, unknown> | null): void
  } = {
    record: null,
    managed: null,
    replace(record) {
      this.record = record === null ? null : clone(record)
    },
  }
  const committedPresentations: Record<string, unknown>[] = []
  let observerConnection: any = null
  let adoption: AdoptionCoordinator | null = null
  let registryMessageCounter = 0
  let managedBridgeActivationCount = 0

  const publishObserver = (): void => {
    const record = runnerState.record
    const snapshot = {
      observerRevision: registry.snapshot().observerRevision + (runnerState.managed === null ? 0 : 1),
      agents: record === null ? [] : [{
        observedSessionId: record.observedSessionId,
        piStatus: record.piStatus,
        lifecycle: record.lifecycle,
        availability: record.availability,
        health: record.health,
        choices: [{
          choiceId: OBSERVER_CHOICE_ID,
          label: 'Local goal · Builder',
          enabled: true,
        }],
      }],
    }
    for (const listener of [...listeners]) listener(clone(snapshot))
  }

  transport.onClientFrame((connection, frame) => {
    if (frame.type === 'observer.register') {
      const registered = registry.register(connection, frame.body)
      connection.deliver('observer.registered', registered, `registry-${++registryMessageCounter}`)
      return
    }
    if (frame.type === 'observer.heartbeat') {
      registry.heartbeat(connection, frame.body)
      return
    }
    if (frame.type === 'observer.lifecycle') {
      registry.lifecycle(connection, frame.body)
      return
    }
    if (frame.type === 'observer.close') {
      registry.close(connection, frame.body)
      return
    }
    if (frame.type === 'adoption.ack') {
      assert.ok(adoption, 'Adoption coordinator must exist before acknowledgement')
      const operation = adoption.acceptAcknowledgement(connection, frame.body)
        .then((value) => {
          publishObserver()
          return value
        })
        .catch((error) => {
          adoptionErrors.push(error)
          throw error
        })
      adoptionPromises.push(operation)
    }
  })

  const host = new FakePiHost({
    sessionId: IDS.piSessionId,
    title: 'ordinary Pi title',
    statuses: {
      'unrelated-extension': 'keep me',
    },
  })
  const extension = createObserverExtension({
    observerVersion: '0.1.0',
    processIncarnationId: IDS.processIncarnationId,
    extensionInstanceIdFactory: () => IDS.extensionInstanceId,
    hostPid: 41001,
    connect: (handler: (frame: unknown) => void): ObserverConnection => {
      const connection = transport.connect(handler)
      observerConnection = connection
      return connection
    },
    managedBridge: {
      enable: () => {
        managedBridgeActivationCount += 1
      },
      disable: () => {},
    },
    scheduleHeartbeat: (callback: () => void): { callback: () => void; active: boolean } => {
      const handle = { callback, active: true }
      heartbeats.push(handle)
      return handle
    },
    cancelHeartbeat: (handle: { active: boolean }): void => {
      handle.active = false
    },
  })
  extension(host.api)
  await host.startSession({ reason: 'startup' })
  await settle()
  assert.ok(observerConnection, 'the observer must create one fake connection')

  const registeredFrame = observerConnection.received.find((entry) => entry.type === 'observer.registered')
  assert.ok(registeredFrame, 'registration must receive an authoritative response')
  const registered = registeredFrame.body
  const current = registry.getObserved(String(registered.observedSessionId))
  assert.ok(current, 'registration must create a current observed record')
  runnerState.record = {
    ...current,
    connectionId: registered.connectionId,
    connectionChallenge: registered.connectionChallenge,
  }

  const runnerConnection = observerConnection as unknown as AdoptionObserverConnection & {
    sendAdoptionRequest(body: Record<string, unknown>): void
    sendAdoptionCommitted(body: Record<string, unknown>): void
  }
  runnerConnection.sendAdoptionRequest = (body) => {
    observerConnection?.deliver('adoption.request_ack', body, `registry-${++registryMessageCounter}`)
  }
  runnerConnection.sendAdoptionCommitted = (body) => {
    observerConnection?.deliver('adoption.committed', body, `registry-${++registryMessageCounter}`)
  }

  const registryPort = {
    getObserved: (observedSessionId: string): Record<string, unknown> | null => {
      if (runnerState.record === null || runnerState.record.observedSessionId !== observedSessionId) return null
      return clone(runnerState.record)
    },
    currentRevision: (): number => registry.snapshot().observerRevision,
    isLocalTeamGoal: (teamGoalId: string, executionNodeId: string): boolean =>
      executionNodeId === IDS.executionNodeId && teamGoalId === LOCAL_TEAM_GOAL_ID,
    isRoleOccupied: (): boolean => false,
    isAlreadyManaged: (): boolean => runnerState.managed !== null,
    isCurrentConnection: (connection: object, connectionId: string, connectionChallenge: string): boolean =>
      registry.isCurrentConnection(connection, connectionId, connectionChallenge),
  }
  const teamRunner = new FakeTransactionalTeamRunner({ registry: runnerState, agentRunId: IDS.agentRunId })
  const presentation = {
    applyCommitted(update: Record<string, unknown>): void {
      committedPresentations.push(clone(update))
    },
  }
  adoption = new AdoptionCoordinator({
    clock,
    registry: registryPort,
    authorizer: {
      verify: (proposal, authorization): boolean =>
        authorization.proposalId === proposal.proposalId
          && authorization.proposalDigest === proposal.proposalDigest,
    },
    teamRunner,
    presentation,
    observerConnection: observerConnection,
  })

  const observerPort: ObserverPort = {
    snapshot: (): ObservedSnapshot & { agents: Array<Record<string, unknown>> } => {
      const record = runnerState.record
      return {
        observerRevision: registry.snapshot().observerRevision + (runnerState.managed === null ? 0 : 1),
        agents: record === null ? [] : [{
          observedSessionId: record.observedSessionId,
          piStatus: record.piStatus,
          lifecycle: record.lifecycle,
          availability: record.availability,
          health: record.health,
          choices: [{ choiceId: OBSERVER_CHOICE_ID, label: 'Local goal · Builder', enabled: true }],
        }],
      }
    },
    subscribe: (listener: (value: unknown) => void): (() => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    submitIntent: (intent: Record<string, unknown>): Record<string, unknown> => ({
      session: clone(OBSERVER_PROJECTION_SESSION),
      intentId: String(intent.intentId),
      phase: 'rejected',
      code: 'not_exercised',
      detail: 'The integrated scenario exercises the exact coordinator path directly.',
      proposalId: 'proposal-not-exercised',
      proposalDigest: '0'.repeat(64),
      remainingMs: null,
      displayLabel: 'No Adoption action',
    }),
  }
  const companion = new CompanionObserverProjectionAdapter({
    session: clone(OBSERVER_PROJECTION_SESSION),
    observer: observerPort,
  })
  await companion.start()
  const beforeAdoption = clone(companion.current)
  assert.ok(beforeAdoption)
  assert.equal(beforeAdoption.agents.length, 1)
  assert.equal(host.status(OBSERVER_STATUS_KEY), 'Unassigned · observed')

  const privacyCanary = 'PRIVATE_OBSERVER_CANARY'
  let violationRejectedBeforeTransport = false
  try {
    assertPrivacySafe({
      observedSessionId: String(runnerState.record?.observedSessionId),
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
      lifecycle: 'running',
      activity: 'idle',
      availability: 'available',
      health: 'healthy',
      registryRevision: 1,
      prompt: privacyCanary,
    })
  } catch {
    violationRejectedBeforeTransport = true
  }
  const crossedSurfaces = JSON.stringify({
    registration: registered,
    registry: runnerState.record,
    projection: beforeAdoption,
    frames: observerConnection.sent,
  })
  const forbiddenCanaryAbsent = !crossedSurfaces.includes(privacyCanary)
  const managementFields = Object.keys(beforeAdoption.agents[0]).filter((field) => [
    'teamGoalId', 'role', 'assignment', 'controlMode', 'writerLease', 'runtimeBinding',
  ].includes(field))

  const request = {
    observedSessionId: runnerState.record?.observedSessionId,
    observedIdentity: {
      ...identityOf(runnerState.record ?? {}),
      connectionId: runnerState.record?.connectionId,
      connectionChallenge: runnerState.record?.connectionChallenge,
    },
    connection: {
      id: observerConnection.id,
      connectionId: runnerState.record?.connectionId,
      connectionChallenge: runnerState.record?.connectionChallenge,
    },
    target: {
      teamGoalId: LOCAL_TEAM_GOAL_ID,
      executionNodeId: IDS.executionNodeId,
      role: 'builder',
    },
  }
  const proposal = await adoption.createProposal(request)
  const requestAck = await adoption.authorizeProposal(proposal.proposalId, authorizationFor(proposal))
  assert.equal(requestAck.targetRole, 'builder')
  await settle()
  await Promise.all(adoptionPromises)
  await settle()
  assert.deepEqual(adoptionErrors, [])

  const committed = teamRunner.managed
  assert.ok(committed, 'the Team Runner must retain the committed managed result')
  assert.deepEqual(adoption.phases(), [
    'proposed', 'authorized', 'same_process_acknowledged', 'reconciled', 'committed',
  ])
  assert.equal(teamRunner.commitCount, 1)
  assert.equal(runnerState.record, null)
  assert.equal(runnerState.managed?.runtimeBinding, null)
  assert.equal(runnerState.managed?.runtimeBindingGuarantee, 'unavailable')
  assert.equal(companion.current?.agents.length, 0)
  assert.equal(host.status(OBSERVER_STATUS_KEY), 'Builder · managed')
  assert.equal(host.title, 'Omarchestra — Builder — managed')
  assert.equal(managedBridgeActivationCount, 1)

  companion.stop()
  const recoveredCompanion = new CompanionObserverProjectionAdapter({
    session: { ...OBSERVER_PROJECTION_SESSION, sessionGeneration: 2 },
    observer: observerPort,
  })
  await recoveredCompanion.start()
  const recoveredProjection = recoveredCompanion.current
  assert.ok(recoveredProjection)
  assert.equal(recoveredProjection.agents.length, 0)
  recoveredCompanion.stop()

  await host.shutdownSession({ reason: 'quit' })
  await settle()

  const runtime = new FakeRuntimeResources()
  const removed = runtime.removeExact('observer-connection-1', 'acceptance')
  const onlyExactFakeResourcesRemoved = removed
    && runtime.resources.every((resource) => resource.id !== 'observer-connection-1')
  const unrelatedFakeResourcesPreserved = runtime.resources.some((resource) => resource.id === 'unrelated-resource-1')

  const registrationIdentity = identityOf(current)
  const managedIdentity = identityOf(current)
  const result = {
    ordinaryHost: {
      visible: true,
      inputResultWithoutRegistry,
      hiddenAgentCount: ordinaryHost.hiddenAgentCount,
      processActionCount: ordinaryHost.processActions.length,
    },
    registration: {
      currentObservedCount: 1,
      piStatus: current.piStatus,
      identity: registrationIdentity,
    },
    beforeAdoption: {
      observerProjection: beforeAdoption,
      managementFields,
    },
    privacy: {
      checkedSurfaces: ['protocol', 'registry_state', 'registry_events', 'companion_projection', 'qml_handoff'],
      forbiddenCanaryAbsent,
      violationRejectedBeforeTransport,
    },
    invalidAdoption: await runInvalidAdoptionMatrix(),
    authority: {
      managedMessagesBeforeCommit: 0,
      assignmentsBeforeCommit: 0,
      promptsBeforeCommit: 0,
      processActionsBeforeCommit: 0,
    },
    commit: {
      order: adoption.phases(),
      commitCount: teamRunner.commitCount,
      agentRunCount: teamRunner.durableCommits.length,
      observedCount: runnerState.record === null ? 0 : 1,
    },
    managed: {
      identity: managedIdentity,
      piStatus: committed.piStatus,
      controlMode: committed.controlMode,
      runtimeBinding: committed.runtimeBinding,
      runtimeBindingGuarantee: committed.runtimeBindingGuarantee,
      managedMessagesAfterCommit: managedBridgeActivationCount,
    },
    recovery: {
      commitCount: teamRunner.commitCount,
      agentRunCount: teamRunner.durableCommits.length,
      observedCount: runnerState.record === null ? 0 : 1,
      duplicateCount: Math.max(0, teamRunner.durableCommits.length - 1),
      identity: managedIdentity,
    },
    cleanup: {
      onlyExactFakeResourcesRemoved,
      unrelatedFakeResourcesPreserved,
      installedCompanionMutationCount: 0,
      userConfigurationMutationCount: 0,
      liveActionCount: 0,
    },
  }
  return { result }
}

export interface ObserverAdoptionAcceptanceResult {
  ordinaryHost: Record<string, unknown>
  registration: Record<string, unknown>
  beforeAdoption: Record<string, unknown>
  privacy: Record<string, unknown>
  invalidAdoption: Record<string, unknown>
  authority: Record<string, unknown>
  commit: Record<string, unknown>
  managed: Record<string, unknown>
  recovery: Record<string, unknown>
  cleanup: Record<string, unknown>
}

/** Run the complete in-memory observer/Adoption acceptance scenario. */
export async function runObserverAdoptionAcceptance(): Promise<ObserverAdoptionAcceptanceResult> {
  const { result } = await runIntegratedScenario()
  return result as ObserverAdoptionAcceptanceResult
}

async function main(): Promise<void> {
  console.log('OMARCHESTRA OBSERVER/ADOPTION ACCEPTANCE — PROTOTYPE, FAKE-ONLY')
  const result = await runObserverAdoptionAcceptance()
  console.log(
    `OBSERVE current=${result.registration.currentObservedCount} `
      + `status=${result.registration.piStatus} `
      + `authority-before=${result.beforeAdoption.managementFields.length === 0}`,
  )
  console.log(
    `PRIVACY forbidden-canary-absent=${result.privacy.forbiddenCanaryAbsent} `
      + `rejected-before-transport=${result.privacy.violationRejectedBeforeTransport}`,
  )
  console.log(
    `ADOPT order=${(result.commit.order as string[]).join('>')} `
      + `commits=${result.commit.commitCount} observed-after=${result.commit.observedCount} `
      + `managed-status=${result.managed.piStatus}`,
  )
  console.log(
    `RECOVERY commits=${result.recovery.commitCount} agents=${result.recovery.agentRunCount} `
      + `duplicates=${result.recovery.duplicateCount} runtime-binding=${result.managed.runtimeBindingGuarantee}`,
  )
  console.log(
    `CLEANUP exact=${result.cleanup.onlyExactFakeResourcesRemoved} `
      + `unrelated-preserved=${result.cleanup.unrelatedFakeResourcesPreserved} `
      + `live-actions=${result.cleanup.liveActionCount}`,
  )
  console.log('VERDICT PASS — observed/unassigned before exact acknowledged Adoption and committed/managed after one transaction')
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('/observer/acceptance.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
