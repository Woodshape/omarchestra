import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkbenchAdapter } from '../console/live-projection-adapter.ts'
import type { WorkbenchChannel, WorkbenchSource, WorkbenchSourceHandler } from '../console/live-projection-adapter.ts'
import { managedFixture, emptyFixture } from '../fixtures/projections.ts'

class FakeSource implements WorkbenchSource {
  handler: WorkbenchSourceHandler | null = null
  async connect(handler: WorkbenchSourceHandler): Promise<WorkbenchChannel> {
    this.handler = handler
    return { send: () => {}, close: () => {} }
  }
}

function makeAdapter(clock = () => 0) {
  const source = new FakeSource()
  const feedback: unknown[] = []
  const adapter = new WorkbenchAdapter({
    source,
    sink: () => {},
    intentSink: () => {},
    onFeedback: (f) => feedback.push(f),
    clock,
  })
  return { adapter, source, feedback }
}

test('reconnect fences captured callbacks and keeps drafts without restarting the owner', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  const old = source.handler!
  old.onSnapshot(managedFixture)
  adapter.setDraft('goal-1', 'keep')
  old.onClose(new Error('lost presentation'))
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  old.onSnapshot({ ...managedFixture, revision: managedFixture.revision + 1, cursor: managedFixture.cursor + 1 })
  old.onClose(new Error('late close'))
  assert.equal(adapter.handoff?.revision, managedFixture.revision)
  assert.equal(adapter.handoff?.connection, 'connected')
  assert.equal(adapter.getDraft('goal-1'), 'keep')
  adapter.stop()
  source.handler!.onSnapshot({ ...managedFixture, revision: managedFixture.revision + 1, cursor: managedFixture.cursor + 1 })
  assert.equal(adapter.handoff?.revision, managedFixture.revision)
})

test('drafts survive ordinary projection updates', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  adapter.setDraft('goal-1', 'draft text')
  source.handler!.onSnapshot(managedFixture) // ordinary update, same identity
  assert.equal(adapter.getDraft('goal-1'), 'draft text')
  adapter.stop()
})

test('a session identity change invalidates pending confirmations but preserves drafts', async () => {
  const { adapter, source, feedback } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  adapter.setDraft('goal-1', 'draft text')
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  // New session identity arrives.
  const newSession = { ...managedFixture, sessionId: 'session-workbench-2', revision: 5 }
  source.handler!.onSnapshot(newSession)
  const pending = adapter.pendingIntents.find((p) => p.intent.intentId === intent.intentId)
  assert.equal(pending.status, 'stale')
  assert.equal(pending.reasonCode, 'identity_changed')
  // Draft text is preserved (not an active confirmation).
  assert.equal(adapter.getDraft('goal-1'), 'draft text')
  adapter.stop()
})

test('a runner epoch change invalidates pending confirmations', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  const newEpoch = { ...managedFixture, runnerEpoch: managedFixture.runnerEpoch + 1, revision: 3 }
  source.handler!.onSnapshot(newEpoch)
  const pending = adapter.pendingIntents.find((p) => p.intent.intentId === intent.intentId)
  assert.equal(pending.status, 'stale')
  adapter.stop()
})

test('a relevant revision change invalidates pending confirmations', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  const intent = adapter.emitIntent('select_project', 'project-local-1', { projectId: 'project-local-1' })
  const newRevision = { ...managedFixture, revision: managedFixture.revision + 1 }
  source.handler!.onSnapshot(newRevision)
  const pending = adapter.pendingIntents.find((p) => p.intent.intentId === intent.intentId)
  assert.equal(pending.status, 'stale')
  adapter.stop()
})

test('checkStaleness latches stale after the staleness bound', async () => {
  let now = 0
  const { adapter, source } = makeAdapter(() => now)
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  now = 3000 // > 2000ms default
  const latched = adapter.checkStaleness()
  assert.equal(latched, true)
  assert.equal(adapter.projection.handoff.connection, 'gap')
  adapter.stop()
})

test('a fresh snapshot clears the stale latch', async () => {
  let now = 0
  const { adapter, source } = makeAdapter(() => now)
  await adapter.start()
  source.handler!.onSnapshot(managedFixture)
  now = 3000
  adapter.checkStaleness()
  now = 3001
  source.handler!.onSnapshot(managedFixture)
  assert.equal(adapter.projection.handoff.connection, 'connected')
  adapter.stop()
})

test('empty fixture renders no managed agents', async () => {
  const { adapter, source } = makeAdapter()
  await adapter.start()
  source.handler!.onSnapshot(emptyFixture)
  assert.equal(adapter.handoff.snapshot.managedAgents.length, 0)
  adapter.stop()
})
