import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkbenchProjection, ProjectionStateError } from '../console/projection-core.ts'
import { validateSnapshot } from '../console/schema.ts'
import { managedFixture, emptyFixture } from '../fixtures/projections.ts'

function eventFor(snapshot, overrides = {}) {
  return {
    protocol: 'omarchestra.workbench/v1',
    sessionId: snapshot.sessionId,
    runnerEpoch: snapshot.runnerEpoch,
    eventId: 'event-1',
    cursor: snapshot.cursor + 1,
    baseRevision: snapshot.revision,
    revision: snapshot.revision + 1,
    kind: 'agent_connected',
    payload: {},
    ...overrides,
  }
}

test('initialize requires a validated snapshot and establishes a baseline', () => {
  const projection = new WorkbenchProjection()
  const handoff = projection.initialize(managedFixture)
  assert.equal(handoff.connection, 'connected')
  assert.equal(handoff.revision, managedFixture.revision)
  assert.equal(handoff.cursor, managedFixture.cursor)
  assert.equal(handoff.snapshot.managedAgents.length, 1)
})

test('initialize rejects a malformed snapshot', () => {
  const projection = new WorkbenchProjection()
  assert.throws(() => projection.initialize({ protocol: 'wrong' }), ProjectionStateError)
})

test('initialize twice rejects', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(() => projection.initialize(emptyFixture), ProjectionStateError)
})

test('acceptEvent advances cursor by exactly one', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  const handoff = projection.acceptEvent(eventFor(managedFixture))
  assert.equal(handoff.cursor, managedFixture.cursor + 1)
  assert.equal(handoff.revision, managedFixture.revision + 1)
})

test('acceptEvent rejects a cursor gap', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(
    () => projection.acceptEvent(eventFor(managedFixture, { cursor: managedFixture.cursor + 2 })),
    ProjectionStateError,
  )
})

test('acceptEvent rejects a stale/duplicate cursor', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(
    () => projection.acceptEvent(eventFor(managedFixture, { cursor: managedFixture.cursor })),
    ProjectionStateError,
  )
})

test('acceptEvent rejects a baseRevision mismatch', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(
    () => projection.acceptEvent(eventFor(managedFixture, { baseRevision: managedFixture.revision + 5 })),
    ProjectionStateError,
  )
})

test('acceptEvent rejects a runner epoch change', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(
    () => projection.acceptEvent(eventFor(managedFixture, { runnerEpoch: managedFixture.runnerEpoch + 1 })),
    ProjectionStateError,
  )
})

test('acceptEvent rejects a session change', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(
    () => projection.acceptEvent(eventFor(managedFixture, { sessionId: 'other-session' })),
    ProjectionStateError,
  )
})

test('exact duplicate event is ignored, not applied twice', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  const first = projection.acceptEvent(eventFor(managedFixture))
  const second = projection.acceptEvent(eventFor(managedFixture))
  assert.equal(first.cursor, second.cursor)
  assert.equal(second.cursor, managedFixture.cursor + 1)
})

test('markGap latches gap state and recover restores from a fresh snapshot', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  const gap = projection.markGap('connection lost')
  assert.equal(gap.connection, 'gap')
  assert.equal(gap.fault, 'connection lost')
  const recovered = projection.recover(managedFixture)
  assert.equal(recovered.connection, 'connected')
  assert.equal(recovered.fault, null)
})

test('recover rejects a snapshot older than the accepted cursor', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  projection.acceptEvent(eventFor(managedFixture))
  projection.markGap('gap')
  const older = { ...managedFixture, cursor: managedFixture.cursor }
  assert.throws(() => projection.recover(older), ProjectionStateError)
})

test('recover is permitted only from gap state', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  assert.throws(() => projection.recover(managedFixture), ProjectionStateError)
})

test('clearState resets so a fresh snapshot can initialize', () => {
  const projection = new WorkbenchProjection()
  projection.initialize(managedFixture)
  projection.clearState()
  const handoff = projection.initialize(emptyFixture)
  assert.equal(handoff.snapshot.managedAgents.length, 0)
})

test('all fixtures validate as snapshots', async () => {
  const { ALL_FIXTURES } = await import('../fixtures/projections.ts')
  for (const [name, fixture] of Object.entries(ALL_FIXTURES)) {
    const validated = validateSnapshot(fixture)
    assert.equal(validated.protocol, 'omarchestra.workbench/v1', name)
  }
})
