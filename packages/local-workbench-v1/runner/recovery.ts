/** Reconcile durable revocation intent before accepting any connection.
 * A compact purged fence is never expanded back into a Run. Restored history
 * covered by such a fence is deleted again, retaining uncertain effects.
 */
import type { FenceLedger } from './fences.ts'
import type { BindingState, WorkbenchStore } from './store.ts'
import { workbenchError } from './errors.ts'
export interface RecoveryReport {
  epoch: number
  retiredFromFence: string[]
  purgedFromFence: string[]
  disconnectedOnRestart: string[]
  uncertainBindings: string[]
  /** Assignment deliveries moved off a pre-restart unresolved state; never sent. */
  assignmentDeliveriesRecovered: string[]
  /** Project ids whose held Assignment writer became uncertain on restart. */
  uncertainWriters: string[]
  /**
   * Active Assignments whose Project writer is now uncertain. A new owner has
   * no proof of the previous live interval, so automatic continuation is
   * blocked and an explicit reconciliation is required before any next Attempt.
   */
  reconciliationRequired: string[]
}
export interface RecoverRunnerStateOptions { store: WorkbenchStore; fences: FenceLedger; clock?: () => number }
const CONNECTION_STATES: BindingState[] = ['acknowledged', 'committed', 'ready']
export function recoverRunnerState(options: RecoverRunnerStateOptions): RecoveryReport {
  const { store, fences } = options
  const now = (options.clock ?? (() => Date.now()))()
  // Pending proposals never become Runs on restart, including authorized
  // requests whose socket write may have been lost. A late ACK cannot commit.
  store.transaction(() => store.discardProposalsOnRestart())
  const retiredFromFence: string[] = [], purgedFromFence: string[] = []
  const pending = new Set(fences.listFences().filter(f => f.purgedAt !== null).map(f => f.runId))
  for (const binding of store.listBindings()) {
    const fence = fences.getFence(binding.runId)
    if (fences.isPurged(binding.runId)) pending.add(binding.runId)
    if (!fence && !fences.isPurged(binding.runId)) {
      if (binding.state === 'retired' || binding.state === 'purged') throw workbenchError('fence_missing', 'terminal history has no independent revocation', 'preserve history and locate the exact latest fence ledger')
      continue
    }
    const identity = store.getBindingIdentity(binding.runId)
    if (identity) fences.assertIncarnationFence(binding.runId, identity.incarnationKey)
    store.transaction(() => {
      store.releaseMembership(binding.runId)
      if (binding.state !== 'retired') {
        store.putBinding({ ...binding, state: 'retired', writerState: 'uncertain', generation: fence?.generation ?? binding.generation, updatedAt: now })
        if (!pending.has(binding.runId)) retiredFromFence.push(binding.runId)
      }
    })
  }
  while (pending.size) {
    let progressed = false
    for (const runId of [...pending]) {
      if (store.listBindings().some(b => b.predecessorRunId === runId)) continue
      store.purgeRetiredHistory(runId, now)
      fences.completePurge(runId)
      pending.delete(runId)
      purgedFromFence.push(runId)
      progressed = true
    }
    if (!progressed) throw workbenchError('fence_conflict', 'purge recovery has a retained descendant conflict', 'preserve the store and latest independent fences; do not recreate or rewrite lineage')
  }
  const disconnectedOnRestart: string[] = []
  for (const binding of store.listBindings()) {
    if (CONNECTION_STATES.includes(binding.state) || binding.state === 'manual_takeover') {
      store.transaction(() => store.putBinding({ ...binding, state: binding.state === 'manual_takeover' ? 'manual_takeover_disconnected' : 'disconnected', writerState: 'uncertain', updatedAt: now }))
      disconnectedOnRestart.push(binding.runId)
    }
  }
  // A new owner has no proof of the previous live connection. Never replay
  // persisted frames on startup; preserve ambiguous attempts for reconciliation.
  store.transaction(() => {
    for (const delivery of store.listDeliveries()) {
      if (delivery.state === 'queued') store.transitionDelivery(delivery.frameId, 'queued', 'not_sent', 'owner_restarted')
      if (delivery.state === 'attempting') store.transitionDelivery(delivery.frameId, 'attempting', 'unknown', 'owner_restarted')
    }
  })
  const uncertainBindings = store.markUncertainInFlight(now)
  // A new owner has no proof of any prior Assignment send. Move unresolved
  // outbox items to a terminal non-send state and never release authority.
  const assignmentDeliveriesRecovered: string[] = []
  store.transaction(() => {
    for (const delivery of store.listAssignmentDeliveries()) {
      if (delivery.state === 'queued' && store.transitionAssignmentDelivery(delivery.attemptId, 'queued', 'not_sent', 'owner_restarted')) {
        assignmentDeliveriesRecovered.push(delivery.deliveryId)
      } else if (delivery.state === 'attempting' && store.transitionAssignmentDelivery(delivery.attemptId, 'attempting', 'unknown', 'owner_restarted')) {
        assignmentDeliveriesRecovered.push(delivery.deliveryId)
      }
    }
  })
  const uncertainWriters: string[] = []
  store.transaction(() => {
    for (const writer of store.listWriters()) {
      if (writer.state === 'held' && store.markWriterUncertain(writer.projectId, now)) uncertainWriters.push(writer.projectId)
    }
  })
  // An unprovable elapsed interval never grants a fresh budget. A restart
  // retains the writer as uncertain, so the bounded correction/resume path
  // stays blocked until an explicit reconciliation clears it.
  const reconciliationRequired: string[] = []
  for (const assignment of store.listAssignments()) {
    if (assignment.state === 'accepted' || assignment.state === 'stopped' || assignment.state === 'failed') continue
    const writer = store.getWriter(assignment.projectId)
    if (writer !== null && writer.state === 'uncertain' && writer.assignmentId === assignment.assignmentId) {
      reconciliationRequired.push(assignment.assignmentId)
    }
  }
  return { epoch: store.epoch, retiredFromFence, purgedFromFence, disconnectedOnRestart, uncertainBindings, assignmentDeliveriesRecovered, uncertainWriters, reconciliationRequired }
}
