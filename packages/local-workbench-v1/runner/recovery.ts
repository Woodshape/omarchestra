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
}
export interface RecoverRunnerStateOptions { store: WorkbenchStore; fences: FenceLedger; clock?: () => number }
const CONNECTION_STATES: BindingState[] = ['acknowledged', 'committed', 'ready']
export function recoverRunnerState(options: RecoverRunnerStateOptions): RecoveryReport {
  const { store, fences } = options
  const now = (options.clock ?? (() => Date.now()))()
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
  const uncertainBindings = store.markUncertainInFlight(now)
  return { epoch: store.epoch, retiredFromFence, purgedFromFence, disconnectedOnRestart, uncertainBindings }
}
