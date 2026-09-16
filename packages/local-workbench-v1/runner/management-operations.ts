/** Recoverable command authorization for the independent retirement ledger.
 * Prepared authorization precedes revocation. A durable receipt is published
 * only after the revocation/history effect is reconciled. No two-DB atomicity
 * is claimed. This module has no bridge delivery or process control port.
 */
import type { WorkbenchRunner } from './runner.ts'
import type { IntentResultRecord, ManagementOperation } from './store.ts'
import { workbenchError } from './errors.ts'

export type ManagementCommandPhase = 'command_prepared' | 'command_effect' | 'command_outcome' | 'command_committed'
export type ManagementCommandResult = IntentResultRecord & { cursor: number; projectionRevision: number }
export type ManagementCommandInput = Pick<ManagementOperation, 'intentId' | 'sessionId' | 'payloadHash' | 'kind' | 'runId'>
type Owner = Pick<WorkbenchRunner, 'store' | 'fences' | 'retireBinding' | 'purgeBinding'>
const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
interface Target {
  projectId: string
  role: string
  bindingDigest: string
  predecessorRunId: string | null
  controlEpoch: number
  generation: number
  goalId: string | null
  incarnationKey: string | null
}
function refuse(message: string): never {
  throw workbenchError('fence_conflict', message, 'preserve the exact command and resources; never infer a replacement target')
}
function decodeTarget(json: string): Target {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 2048) refuse('invalid operation target size')
  let value: Target
  try { value = JSON.parse(json) } catch { return refuse('invalid operation target JSON') }
  const keys = ['projectId', 'role', 'bindingDigest', 'predecessorRunId', 'controlEpoch', 'generation', 'goalId', 'incarnationKey']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse('invalid operation target fields')
  for (const key of ['projectId', 'role'] as const) if (typeof value[key] !== 'string' || !ID.test(value[key])) refuse('invalid operation target identity')
  for (const key of ['predecessorRunId', 'goalId'] as const) if (value[key] !== null && (typeof value[key] !== 'string' || !ID.test(value[key]))) refuse('invalid operation target association')
  if (typeof value.bindingDigest !== 'string' || !HASH.test(value.bindingDigest)
      || (value.incarnationKey !== null && (typeof value.incarnationKey !== 'string' || !HASH.test(value.incarnationKey)))
      || (value.goalId === null) !== (value.incarnationKey === null)
      || !Number.isSafeInteger(value.controlEpoch) || value.controlEpoch < 0 || !Number.isSafeInteger(value.generation) || value.generation < 1) refuse('invalid operation target commitment')
  return value
}
function targetOf(owner: Owner, runId: string): Target {
  const binding = owner.store.getBinding(runId)
  if (!binding) throw workbenchError('missing_resource', 'no retained target Run', 'reload the current history; a minimal fence is not a Run')
  const identity = owner.store.getBindingIdentity(runId)
  return decodeTarget(JSON.stringify({ projectId: binding.projectId, role: binding.role, bindingDigest: binding.bindingDigest,
    predecessorRunId: binding.predecessorRunId, controlEpoch: binding.controlEpoch, generation: binding.generation,
    goalId: identity?.goalId ?? null, incarnationKey: identity?.incarnationKey ?? null }))
}
export function prepareManagementOperation(owner: Owner, input: ManagementCommandInput, now: number): ManagementOperation {
  if (![input.intentId, input.sessionId, input.runId].every(id => typeof id === 'string' && ID.test(id))
      || typeof input.payloadHash !== 'string' || !HASH.test(input.payloadHash) || !['retire', 'purge'].includes(input.kind) || !Number.isSafeInteger(now) || now < 0) refuse('invalid management command authorization')
  if (!Number.isSafeInteger(Number(owner.store.getMeta('projection_revision') ?? '0') + 1)
      || !Number.isSafeInteger(Math.max(0, owner.store.maxCursor()) + 1)) refuse('management command counters exhausted before authorization')
  const target = targetOf(owner, input.runId)
  const binding = owner.store.getBinding(input.runId)!
  if (input.kind === 'retire') {
    if (!['disconnected', 'manual_takeover_disconnected'].includes(binding.state)
        && !(binding.state === 'retired' && owner.fences.isFenced(input.runId))) {
      throw workbenchError('invalid_input', 'retirement requires a disconnected Run', 'manual control alone does not disconnect Pi')
    }
  } else {
    owner.fences.assertFence(input.runId)
    if (binding.state !== 'retired' || owner.store.listBindings().some(b => b.predecessorRunId === input.runId)) {
      throw workbenchError('invalid_input', 'purge requires a terminal retired leaf', 'purge retained successors first')
    }
  }
  return { ...input, targetJson: JSON.stringify(target), createdAt: now }
}

export function completeManagementOperation(owner: Owner, operation: ManagementOperation, options: {
  clock: () => number; newId: (prefix: string) => string; failurePoint?: (phase: ManagementCommandPhase) => void
}): ManagementCommandResult {
  const target = decodeTarget(operation.targetJson)
  if (![operation.intentId, operation.sessionId, operation.runId].every(id => typeof id === 'string' && ID.test(id))
      || typeof operation.payloadHash !== 'string' || !HASH.test(operation.payloadHash) || !['retire', 'purge'].includes(operation.kind)) refuse('invalid retained management authorization')
  const previous = owner.store.getIntentResult(operation.intentId)
  if (previous) {
    if (previous.payloadHash !== operation.payloadHash || previous.sessionId !== operation.sessionId || previous.status !== 'acknowledged'
        || previous.committedRevision === null || !Number.isSafeInteger(previous.committedRevision)) refuse('operation receipt conflicts with retained authorization')
    if (!owner.fences.isFenced(operation.runId) || (operation.kind === 'purge' && !owner.fences.isPurged(operation.runId))) refuse('operation receipt lacks its independent revocation')
    if (target.incarnationKey !== null) owner.fences.assertIncarnationFence(operation.runId, target.incarnationKey)
    owner.store.transaction(() => owner.store.deleteManagementOperation(operation.intentId))
    return { ...previous, cursor: Math.max(0, owner.store.maxCursor()), projectionRevision: Number(owner.store.getMeta('projection_revision') ?? '0') }
  }
  if (owner.fences.isPurged(operation.runId)) {
    if (operation.kind !== 'purge') refuse('retirement target was unexpectedly purged')
    if (target.incarnationKey !== null) owner.fences.assertIncarnationFence(operation.runId, target.incarnationKey)
  } else {
    const current = targetOf(owner, operation.runId)
    // Retirement may already have advanced the vacancy generation. All other
    // frozen target fields must still identify the original commitment.
    const generation = owner.fences.isFenced(operation.runId) ? target.generation : current.generation
    for (const key of Object.keys(target) as Array<keyof Target>) {
      if ((key === 'generation' ? generation : current[key]) !== target[key]) refuse('retained management target changed')
    }
    const fence = owner.fences.getFence(operation.runId)
    if (fence && (fence.projectId !== target.projectId || fence.goalId !== target.goalId || fence.role !== target.role
        || fence.bindingDigest !== target.bindingDigest || fence.incarnationKey !== target.incarnationKey || fence.predecessorRunId !== target.predecessorRunId)) refuse('retained fence differs from authorized target')
    if (operation.kind === 'retire') owner.retireBinding({ runId: operation.runId, projectId: target.projectId, role: target.role, bindingDigest: target.bindingDigest, predecessorRunId: target.predecessorRunId })
    else owner.purgeBinding(operation.runId)
  }
  options.failurePoint?.('command_effect')
  let receipt!: IntentResultRecord
  let committedCursor = 0
  owner.store.transaction(() => {
    const baseRevision = Number(owner.store.getMeta('projection_revision') ?? '0')
    const revision = baseRevision + 1, cursor = Math.max(0, owner.store.maxCursor()) + 1
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(cursor)) refuse('management command counters exhausted')
    committedCursor = cursor
    owner.store.appendEvent({ eventId: options.newId('evt-'), cursor, baseRevision, revision,
      kind: operation.kind === 'retire' ? 'retire' : 'history_purged', runId: operation.kind === 'retire' ? operation.runId : null, createdAt: options.clock() })
    owner.store.setMeta('projection_revision', String(revision))
    receipt = { intentId: operation.intentId, sessionId: operation.sessionId, payloadHash: operation.payloadHash,
      status: 'acknowledged', reasonCode: null, reason: null, detail: null, committedRevision: revision, createdAt: options.clock() }
    owner.store.putIntentResult(receipt)
    owner.store.deleteManagementOperation(operation.intentId)
    options.failurePoint?.('command_outcome')
  })
  options.failurePoint?.('command_committed')
  return { ...receipt, cursor: committedCursor, projectionRevision: receipt.committedRevision! }
}
