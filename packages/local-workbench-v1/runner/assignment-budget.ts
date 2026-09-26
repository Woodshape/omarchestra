/** C10 owner-epoch monotonic budget. Stored with admission, never reconstructed
 * from a wall clock or reset by a presentation-session replacement/retry. A new
 * owner cannot prove the old monotonic interval and must block continuation. */
import type { WorkbenchStore, AssignmentRecord } from './store.ts'
import { workbenchError } from './errors.ts'

const key = (id: string) => `assignment_budget_${id}`
export function armAssignmentBudget(store: WorkbenchStore, assignment: AssignmentRecord, monotonic: number): void {
  if (!Number.isFinite(monotonic) || monotonic < 0 || store.getMeta(key(assignment.assignmentId)) !== null) {
    throw workbenchError('fence_conflict', 'Assignment elapsed budget cannot be reset', 'retain the original owner-epoch budget')
  }
  store.setMeta(key(assignment.assignmentId), JSON.stringify({ epoch: store.epoch, started: monotonic, limit: assignment.limits.elapsedMs }))
}
export function assignmentRemainingMs(store: WorkbenchStore, assignment: AssignmentRecord, monotonic: number): number | null {
  try {
    const budget = JSON.parse(store.getMeta(key(assignment.assignmentId)) ?? 'null')
    if (!budget || budget.epoch !== store.epoch || budget.limit !== assignment.limits.elapsedMs
        || !Number.isFinite(budget.started) || !Number.isFinite(monotonic) || monotonic < budget.started) return null
    return Math.max(0, budget.limit - (monotonic - budget.started))
  } catch { return null }
}

// Shared by authorities across dock hide/reopen. Abort signals address only the
// Runner-owned validator child, never Pi or its process group.
const gates = new WeakMap<WorkbenchStore, Map<string, AbortController>>()
export function registerAssignmentGate(store: WorkbenchStore, assignmentId: string, controller: AbortController): () => void {
  let active = gates.get(store)
  if (!active) { active = new Map(); gates.set(store, active) }
  active.set(assignmentId, controller)
  return () => { if (active!.get(assignmentId) === controller) active!.delete(assignmentId) }
}
export function assignmentGateRunning(store: WorkbenchStore, assignmentId: string): boolean {
  return gates.get(store)?.has(assignmentId) ?? false
}
export function abortAssignmentGate(store: WorkbenchStore, assignmentId: string): void {
  gates.get(store)?.get(assignmentId)?.abort()
}
