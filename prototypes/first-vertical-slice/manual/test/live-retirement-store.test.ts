/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Disposable SQLite retirement store red/green gate. Exercises the durable
 * adapter against the same disposable SQLite database used by
 * `LiveAdoptionStore`. The runner composes both stores via the same
 * `DatabaseSync` instance so retirement and adoption share a single
 * transactional boundary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { LiveAdoptionStore } from '../live-adoption-store.ts'
import { LiveRetirementStore } from '../live-retirement-store.ts'
import { ROLES } from '../../src/protocol.ts'

const IDS = {
  agentRunId: 'agent-run-00000000000000000000000000000000000000000000000000000000000000r1',
  agentRunIdR: 'agent-run-00000000000000000000000000000000000000000000000000000000000000r2',
  observedSessionId: 'observed-0000000000000000000000000000000000000000000000000000000000000001',
  observedSessionIdR: 'observed-0000000000000000000000000000000000000000000000000000000000000002',
  proposalId: 'proposal-00000000000000000000000000000000000000000000000000000000000000001',
  proposalIdR: 'proposal-00000000000000000000000000000000000000000000000000000000000000002',
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
  digest: 'a'.repeat(64),
  replacementDigest: 'b'.repeat(64),
}

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-store-'))
  return path.join(dir, 'retirement.sqlite')
}

function buildStores(databasePath: string, agentRunIdFactory: () => string) {
  const adoption = new LiveAdoptionStore({
    databasePath,
    executionNodeId: IDS.executionNodeId,
    teamGoalId: IDS.teamGoalId,
    roles: [...ROLES],
    agentRunIdFactory,
  })
  const retirement = new LiveRetirementStore({
    database: (adoption as unknown as { db: import('node:sqlite').DatabaseSync }).db,
    agentRunIdFactory,
  })
  return { adoption, retirement }
}

test('retirement schema: durable store creates retirement tables on open', () => {
  const databasePath = tempDbPath()
  const { adoption, retirement } = buildStores(databasePath, () => IDS.agentRunId)
  try {
    const snapshot = retirement.snapshot()
    assert.equal(snapshot.retiredRuns.length, 0)
    assert.equal(snapshot.committedRuns.length, 0)
    assert.equal(snapshot.vacancyGeneration, 0)
    assert.equal(snapshot.events.length, 0)
    void adoption
  } finally {
    adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable retirement is durable across reopen', () => {
  const databasePath = tempDbPath()
  const first = buildStores(databasePath, () => IDS.agentRunId)
  first.retirement.transaction((tx) => tx.commitRetirement({
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
  first.adoption.close()
  const reopened = buildStores(databasePath, () => IDS.agentRunIdR)
  try {
    const snapshot = reopened.retirement.snapshot()
    assert.equal(snapshot.retiredRuns.length, 1)
    assert.equal(snapshot.retiredRuns[0].agentRunId, IDS.agentRunId)
    assert.equal(snapshot.retiredRuns[0].executionNodeId, IDS.executionNodeId)
    assert.equal(snapshot.retiredRuns[0].processIncarnationId, IDS.processIncarnationId)
    assert.equal(snapshot.retiredRuns[0].piSessionId, IDS.piSessionId)
    assert.equal(snapshot.retiredRuns[0].extensionInstanceId, IDS.extensionInstanceId)
    assert.equal(snapshot.vacancyGeneration, 1)
    assert.equal(snapshot.events.length, 1)
    assert.equal(snapshot.events[0].type, 'retired')
  } finally {
    reopened.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable retirement idempotent on identical revision across reopen', () => {
  const databasePath = tempDbPath()
  const first = buildStores(databasePath, () => IDS.agentRunId)
  first.retirement.transaction((tx) => tx.commitRetirement({
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
  first.adoption.close()
  const reopened = buildStores(databasePath, () => IDS.agentRunIdR)
  try {
    const second = reopened.retirement.transaction((tx) => tx.commitRetirement({
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
    assert.equal(reopened.retirement.snapshot().retiredRuns.length, 1)
  } finally {
    reopened.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable retirement rejects stale revision', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunId)
  try {
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    assert.throws(() => stores.retirement.transaction((tx) => tx.commitRetirement({
      agentRunId: IDS.agentRunId,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionId,
      revision: IDS.retiredRevision - 1,
      executionNodeId: IDS.executionNodeId,
      processIncarnationId: IDS.processIncarnationId,
      piSessionId: IDS.piSessionId,
      extensionInstanceId: IDS.extensionInstanceId,
    })), /stale_revision|already retired/i)
  } finally {
    stores.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable replacement records predecessor link and survives reopen', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunIdR)
  try {
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    const generation = stores.retirement.snapshot().vacancyGeneration
    stores.retirement.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: IDS.proposalIdR,
        proposalDigest: IDS.replacementDigest,
        observedSessionId: IDS.observedSessionIdR,
        executionNodeId: IDS.executionNodeIdR,
        processIncarnationId: IDS.processIncarnationIdR,
        piSessionId: IDS.piSessionIdR,
        extensionInstanceId: IDS.extensionInstanceIdR,
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        vacancyGeneration: generation,
      },
      authorization: {},
      acknowledgement: {},
      observed: {},
      reconciliation: {},
    }))
    stores.adoption.close()
    const reopened = buildStores(databasePath, () => 'agent-run-reopen')
    try {
      const snapshot = reopened.retirement.snapshot()
      assert.equal(snapshot.retiredRuns.length, 1)
      assert.equal(snapshot.committedRuns.length, 1)
      assert.equal(snapshot.committedRuns[0].predecessorAgentRunId, IDS.agentRunId)
      assert.equal(snapshot.committedRuns[0].agentRunId, IDS.agentRunIdR)
      assert.equal(snapshot.committedRuns[0].vacancyGeneration, generation)
      assert.equal(snapshot.events.length, 2)
      assert.equal(snapshot.events[0].type, 'retired')
      assert.equal(snapshot.events[1].type, 'replaced')
    } finally {
      reopened.adoption.close()
    }
  } finally {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable replacement with stale vacancy generation is rejected', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunIdR)
  try {
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    assert.throws(() => stores.retirement.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: IDS.proposalIdR,
        proposalDigest: IDS.replacementDigest,
        observedSessionId: IDS.observedSessionIdR,
        executionNodeId: IDS.executionNodeIdR,
        processIncarnationId: IDS.processIncarnationIdR,
        piSessionId: IDS.piSessionIdR,
        extensionInstanceId: IDS.extensionInstanceIdR,
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        vacancyGeneration: 0,
      },
      authorization: {},
      acknowledgement: {},
      observed: {},
      reconciliation: {},
    })), /stale|not vacant|not_vacant/i)
  } finally {
    stores.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable beginManagedRecovery rejects a retired binding across reopen', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunId)
  try {
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    stores.adoption.close()
    const reopened = buildStores(databasePath, () => IDS.agentRunIdR)
    try {
      assert.throws(() => reopened.retirement.transaction((tx) => tx.beginManagedRecovery({
        binding: {
          executionNodeId: IDS.executionNodeId,
          processIncarnationId: IDS.processIncarnationId,
          piSessionId: IDS.piSessionId,
          extensionInstanceId: IDS.extensionInstanceId,
        },
      })), /retired|already_retired/i)
    } finally {
      reopened.adoption.close()
    }
  } finally {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable retirement transaction rollback does not leave a tombstone', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunId)
  try {
    assert.throws(() => stores.retirement.transaction((tx) => {
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
      throw new Error('boom')
    }))
    const snapshot = stores.retirement.snapshot()
    assert.equal(snapshot.retiredRuns.length, 0)
    assert.equal(snapshot.events.length, 0)
  } finally {
    stores.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable purge removes terminal history and Adoption records but preserves cursors and generation high-water', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunId)
  try {
    stores.adoption.transaction((tx) => tx.commitAdoption({
      proposal: {
        proposalId: IDS.proposalId,
        proposalDigest: IDS.digest,
        observedSessionId: IDS.observedSessionId,
        executionNodeId: IDS.executionNodeId,
        processIncarnationId: IDS.processIncarnationId,
        piSessionId: IDS.piSessionId,
        extensionInstanceId: IDS.extensionInstanceId,
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
      },
      authorization: {},
      acknowledgement: {},
      observed: {},
      reconciliation: {},
    }))
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    stores.retirement.purgeRetiredRun(IDS.agentRunId)
    assert.equal(stores.adoption.snapshot().committedRuns.length, 0)
    assert.equal(stores.adoption.snapshot().events.length, 0)
    assert.equal(stores.adoption.snapshot().cursor, 1)
    assert.equal(stores.retirement.snapshot().retiredRuns.length, 0)
    assert.equal(stores.retirement.snapshot().events.length, 0)
    assert.equal(stores.retirement.snapshot().cursor, 1)
    assert.equal(stores.retirement.snapshot().vacancyGeneration, 1)

    stores.adoption.close()
    const reopened = buildStores(databasePath, () => IDS.agentRunIdR)
    try {
      assert.equal(reopened.adoption.snapshot().committedRuns.length, 0)
      assert.equal(reopened.adoption.snapshot().cursor, 1)
      assert.equal(reopened.retirement.snapshot().retiredRuns.length, 0)
      assert.equal(reopened.retirement.snapshot().cursor, 1)
      assert.equal(reopened.retirement.snapshot().vacancyGeneration, 1)
    } finally {
      reopened.adoption.close()
    }
  } finally {
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})

test('durable purge blocks a predecessor until its retired replacement successor is purged first', () => {
  const databasePath = tempDbPath()
  const stores = buildStores(databasePath, () => IDS.agentRunIdR)
  try {
    stores.retirement.transaction((tx) => tx.commitRetirement({
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
    const generation = stores.retirement.snapshot().vacancyGeneration
    stores.retirement.transaction((tx) => tx.commitReplacementAdoption({
      proposal: {
        proposalId: IDS.proposalIdR,
        proposalDigest: IDS.replacementDigest,
        observedSessionId: IDS.observedSessionIdR,
        executionNodeId: IDS.executionNodeIdR,
        processIncarnationId: IDS.processIncarnationIdR,
        piSessionId: IDS.piSessionIdR,
        extensionInstanceId: IDS.extensionInstanceIdR,
        targetTeamGoalId: IDS.teamGoalId,
        targetRole: 'builder',
        predecessorAgentRunId: IDS.agentRunId,
        vacancyGeneration: generation,
      },
      authorization: {},
      acknowledgement: {},
      observed: {},
      reconciliation: {},
    }))
    stores.retirement.transaction((tx) => tx.commitRetirement({
      agentRunId: IDS.agentRunIdR,
      teamGoalId: IDS.teamGoalId,
      role: 'builder',
      observedSessionId: IDS.observedSessionIdR,
      revision: IDS.retiredRevision + 1,
      executionNodeId: IDS.executionNodeIdR,
      processIncarnationId: IDS.processIncarnationIdR,
      piSessionId: IDS.piSessionIdR,
      extensionInstanceId: IDS.extensionInstanceIdR,
    }))
    assert.throws(
      () => stores.retirement.purgeRetiredRun(IDS.agentRunId),
      /successor|purge_blocked/i,
    )
    stores.retirement.purgeRetiredRun(IDS.agentRunIdR)
    stores.retirement.purgeRetiredRun(IDS.agentRunId)
    const snapshot = stores.retirement.snapshot()
    assert.equal(snapshot.retiredRuns.length, 0)
    assert.equal(snapshot.committedRuns.length, 0)
    assert.equal(snapshot.events.length, 0)
    assert.equal(snapshot.vacancyGeneration, 2)
    assert.equal(snapshot.cursor, 3)
  } finally {
    stores.adoption.close()
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true })
  }
})
