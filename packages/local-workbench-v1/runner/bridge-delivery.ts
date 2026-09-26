/** Management-only delivery intent. A local write is not a Pi acknowledgement. */
import type { WorkbenchFrame } from './transport.ts'
import { decodeBridgeFrame, type BridgeFrame } from './bridge-protocol.ts'
import { workbenchError } from './errors.ts'
import { assignmentRemainingMs } from './assignment-budget.ts'
import type { AssignmentOutboxState, WorkbenchStore } from './store.ts'
import type { BridgeAssignmentEvent, BridgeRegistry, AssignmentSendResult } from './bridge-registry.ts'
export type DeliveryState = 'queued' | 'attempting' | 'written' | 'not_sent' | 'unknown'
export interface BridgeDelivery {
  frameId: string
  runId: string
  kind: 'adopt' | 'committed'
  frameJson: string
  connectionId: string
  deadline: number
  state: DeliveryState
  reasonCode: string | null
  createdAt: number
}
const ID = /^[A-Za-z0-9_-]{1,128}$/
const id = (v: unknown) => typeof v === 'string' && ID.test(v)
function invalid(): never { throw workbenchError('invalid_input', 'invalid durable bridge delivery', 'preserve the record; management frames carry only closed identity metadata') }
export function validateStoredDelivery(record: BridgeDelivery): WorkbenchFrame | BridgeFrame {
  if (typeof record.frameJson !== 'string') invalid()
  if (record.frameJson.startsWith('{"protocol":"omarchestra.bridge/v1"')) {
    if (!id(record.frameId) || !id(record.runId) || !id(record.connectionId) || record.kind !== 'committed'
        || typeof record.frameJson !== 'string' || Buffer.byteLength(record.frameJson) > 4096
        || !Number.isSafeInteger(record.deadline) || record.deadline < 0
        || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
        || !['queued', 'attempting', 'written', 'not_sent', 'unknown'].includes(record.state)
        || ![null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted'].includes(record.reasonCode)) invalid()
    if (['queued', 'attempting', 'written'].includes(record.state) && record.reasonCode !== null) invalid()
    if (record.state === 'not_sent' && !['connection_lost', 'expired', 'revoked', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
    if (record.state === 'unknown' && !['transport_error', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
    let frame: BridgeFrame
    try { frame = decodeBridgeFrame(Buffer.from(record.frameJson)) } catch { return invalid() }
    if (frame.type !== 'adoption_committed' || frame.messageId !== record.frameId || frame.body.runId !== record.runId || frame.body.connectionId !== record.connectionId) invalid()
    return frame
  }
  return validateDelivery(record)
}
export function validateDelivery(record: BridgeDelivery): WorkbenchFrame {
  if (!id(record.frameId) || !id(record.runId) || !id(record.connectionId)
      || !Number.isSafeInteger(record.deadline) || record.deadline < 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !['queued', 'attempting', 'written', 'not_sent', 'unknown'].includes(record.state)
      || ![null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted'].includes(record.reasonCode)
      || typeof record.frameJson !== 'string' || Buffer.byteLength(record.frameJson) > 4096) invalid()
  if (['queued', 'attempting', 'written'].includes(record.state) && record.reasonCode !== null) invalid()
  if (record.state === 'not_sent' && !['connection_lost', 'expired', 'revoked', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
  if (record.state === 'unknown' && !['transport_error', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
  let frame: WorkbenchFrame
  try { frame = JSON.parse(record.frameJson) } catch { return invalid() }
  if (!frame || Object.keys(frame).sort().join(',') !== 'bindingDigest,frameId,kind,nonce,payload,runId'
      || frame.frameId !== record.frameId || frame.runId !== record.runId || frame.kind !== record.kind
      || typeof frame.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(frame.bindingDigest) || !id(frame.nonce)
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) invalid()
  const payload = frame.payload
  if (record.kind === 'adopt') {
    if (Object.keys(payload).sort().join(',') !== 'executionNodeId,predecessorRunId,vacancyGeneration'
        || !id(payload.executionNodeId) || (payload.predecessorRunId !== null && !id(payload.predecessorRunId))
        || !Number.isSafeInteger(payload.vacancyGeneration) || Number(payload.vacancyGeneration) < 1) invalid()
  } else if (record.kind === 'committed') {
    if (Object.keys(payload).sort().join(',') !== 'generation,projectId,role' || !id(payload.projectId) || !id(payload.role)
        || !Number.isSafeInteger(payload.generation) || Number(payload.generation) < 1) invalid()
  } else invalid()
  return frame
}

/** The exact outcome of one committed same-Pi delivery attempt. */
export type AssignmentDeliveryOutcome = 'accepted' | 'busy' | 'duplicate' | 'invalid' | 'not_sent' | 'unknown'
export interface AssignmentDeliveryResult {
  deliveryId: string
  state: AssignmentOutboxState
  outcome: AssignmentDeliveryOutcome
  storedOutcome: 'accepted' | 'unknown' | null
  reasonCode: string | null
  replayed: boolean
}
/** One lost ACK is proved uncertain after this bounded window; reconciliation is explicit. */
export const ASSIGNMENT_ACK_DEADLINE_MS = 5_000
interface DeliveryIdentity { deliveryId: string; assignmentId: string; attemptId: string; runId: string; payloadDigest: string }
type AckWait = { kind: 'ack'; outcome: 'accepted' | 'busy' | 'duplicate' | 'invalid' | 'unknown'; storedOutcome: 'accepted' | 'unknown' | null; reason: string | null } | { kind: 'timeout' }
type ReceiptWait = { kind: 'receipt'; known: boolean; outcome: 'accepted' | 'busy' | 'invalid' | 'unknown' | null } | { kind: 'timeout' }

/**
 * AL-03 committed same-Pi delivery. It consumes the one queued outbox row an
 * admission committed, re-checks current eligibility, marks `attempting` before
 * the single wire send, and settles exactly one bounded ACK outcome. It never
 * queues a hidden turn, never resends blindly, and never clears writer
 * uncertainty on its own. Lifecycle (Assignment/Attempt) state and the durable
 * event/revision commit stay with the authority command path (AL-06/AL-07).
 */
export class AssignmentDeliveryCoordinator {
  private readonly store: WorkbenchStore
  private readonly registry: BridgeRegistry
  private readonly clock: () => number
  private readonly monotonic: () => number
  private readonly newId: (prefix: string) => string
  private readonly ackDeadlineMs: number
  private readonly schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void
  private readonly pendingAcks = new Map<string, DeliveryIdentity & { resolve: (waited: AckWait) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly pendingReceipts = new Map<string, DeliveryIdentity & { resolve: (waited: ReceiptWait) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(options: { store: WorkbenchStore; registry: BridgeRegistry; clock?: () => number; monotonic?: () => number; newId?: (prefix: string) => string; ackDeadlineMs?: number; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void }) {
    this.store = options.store
    this.registry = options.registry
    this.clock = options.clock ?? (() => Date.now())
    this.monotonic = options.monotonic ?? options.clock ?? (() => performance.now())
    this.newId = options.newId ?? (prefix => `${prefix}-${this.clock().toString(16)}`)
    this.ackDeadlineMs = options.ackDeadlineMs ?? ASSIGNMENT_ACK_DEADLINE_MS
    this.schedule = options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer })
    this.cancel = options.cancel ?? clearTimeout
    this.registry.setAssignmentHandlers({ onAck: event => this.onAck(event), onReceipt: event => this.onReceipt(event) })
  }

  /** One delivery attempt for the exact queued outbox row of this Attempt. */
  async deliver(attemptId: string): Promise<AssignmentDeliveryResult> {
    const attempt = this.store.getAttempt(attemptId)
    const delivery = this.store.getAssignmentDelivery(attemptId)
    if (!attempt || !delivery) throw workbenchError('invalid_input', 'no admitted Assignment delivery exists for this Attempt', 'admit the Assignment in one confirmed Start before delivering it')
    if (delivery.state !== 'queued') return this.replay(delivery)
    const now = this.clock()
    if (now >= delivery.deadline) { this.store.transitionAssignmentDelivery(attemptId, 'queued', 'not_sent', 'expired'); return this.result(delivery, 'not_sent', 'not_sent', null, 'expired') }
    const assignment = this.store.getAssignment(delivery.assignmentId)
    const writer = assignment ? this.store.getWriter(assignment.projectId) : null
    const remaining = assignment ? assignmentRemainingMs(this.store, assignment, this.monotonic()) : null
    if (remaining === null || remaining <= 0) {
      this.store.transitionAssignmentDelivery(attemptId, 'queued', 'not_sent', 'expired')
      return this.result(delivery, 'not_sent', 'not_sent', null, 'expired')
    }
    if (!assignment || assignment.state === 'stopped' || assignment.state === 'failed' || this.store.getStop(delivery.assignmentId)
        || !writer || writer.state !== 'held' || writer.attemptId !== attemptId || writer.epoch !== attempt.writerEpoch) {
      this.store.transitionAssignmentDelivery(attemptId, 'queued', 'not_sent', 'revoked')
      return this.result(delivery, 'not_sent', 'not_sent', null, 'revoked')
    }
    const effect = this.registry.prepareAssignmentDelivery(delivery.runId, { deliveryId: delivery.deliveryId, assignmentId: delivery.assignmentId, attemptId, payloadDigest: delivery.payloadDigest, payloadJson: delivery.frameJson, deadline: delivery.deadline, remainingMs: Math.min(remaining, delivery.deadline - now) })
    if (!effect) { this.store.transitionAssignmentDelivery(attemptId, 'queued', 'not_sent', 'connection_lost'); return this.result(delivery, 'not_sent', 'not_sent', null, 'connection_lost') }
    const waited = this.awaitAck({ deliveryId: delivery.deliveryId, assignmentId: delivery.assignmentId, attemptId, runId: delivery.runId, payloadDigest: delivery.payloadDigest })
    this.store.transitionAssignmentDelivery(attemptId, 'queued', 'attempting', null)
    const sent: AssignmentSendResult = effect()
    if (sent !== 'sent') {
      this.clearAck(delivery.deliveryId)
      if (sent === 'not_sent') { this.store.transitionAssignmentDelivery(attemptId, 'attempting', 'not_sent', 'connection_lost'); return this.result(delivery, 'not_sent', 'not_sent', null, 'connection_lost') }
      this.store.transitionAssignmentDelivery(attemptId, 'attempting', 'unknown', 'transport_error')
      this.markWriterUncertain(assignment.projectId)
      return this.result(delivery, 'unknown', 'unknown', null, 'transport_error')
    }
    const settled: AckWait = await waited
    if (settled.kind === 'timeout' || settled.outcome === 'unknown' || (settled.outcome === 'invalid' && settled.reason === 'send_failed') || (settled.outcome === 'duplicate' && settled.storedOutcome !== 'accepted')) {
      this.store.transitionAssignmentDelivery(attemptId, 'attempting', 'unknown', 'transport_error')
      this.markWriterUncertain(assignment.projectId)
      return this.result(delivery, 'unknown', 'unknown', null, 'transport_error')
    }
    if (settled.outcome === 'accepted' || settled.outcome === 'duplicate') {
      this.store.transitionAssignmentDelivery(attemptId, 'attempting', 'written', null)
      return this.result(delivery, 'written', settled.outcome, settled.storedOutcome, null)
    }
    this.store.transitionAssignmentDelivery(attemptId, 'attempting', 'not_sent', 'revoked')
    return this.result(delivery, 'not_sent', settled.outcome, null, 'revoked')
  }

  /** Query the surviving challenged extension for its durable receipt of an uncertain delivery. */
  async reconcile(attemptId: string): Promise<AssignmentDeliveryResult> {
    const attempt = this.store.getAttempt(attemptId)
    const delivery = this.store.getAssignmentDelivery(attemptId)
    if (!attempt || !delivery) throw workbenchError('invalid_input', 'no admitted Assignment delivery exists for this Attempt', 'admit the Assignment in one confirmed Start before reconciling it')
    if (delivery.state !== 'unknown') return this.replay(delivery)
    const requestId = this.newId('receipt')
    const effect = this.registry.prepareAssignmentReceiptRequest(delivery.runId, { requestId, deliveryId: delivery.deliveryId, assignmentId: delivery.assignmentId, attemptId, payloadDigest: delivery.payloadDigest })
    if (!effect) return this.result(delivery, 'unknown', 'unknown', null, delivery.reasonCode)
    const waited = this.awaitReceipt(requestId, { deliveryId: delivery.deliveryId, assignmentId: delivery.assignmentId, attemptId, runId: delivery.runId, payloadDigest: delivery.payloadDigest })
    if (effect() !== 'sent') { this.clearReceipt(requestId); return this.result(delivery, 'unknown', 'unknown', null, delivery.reasonCode) }
    const settled: ReceiptWait = await waited
    if (settled.kind === 'timeout' || !settled.known || settled.outcome === null || settled.outcome === 'unknown' || settled.outcome === 'busy' || settled.outcome === 'invalid') {
      if (settled.kind === 'receipt' && settled.known && (settled.outcome === 'busy' || settled.outcome === 'invalid')) {
        this.store.transitionAssignmentDelivery(attemptId, 'unknown', 'not_sent', 'revoked')
        return this.result(delivery, 'not_sent', settled.outcome, null, 'revoked')
      }
      return this.result(delivery, 'unknown', 'unknown', null, delivery.reasonCode)
    }
    this.store.transitionAssignmentDelivery(attemptId, 'unknown', 'written', null)
    return this.result(delivery, 'written', 'accepted', 'accepted', null)
  }

  private awaitAck(identity: DeliveryIdentity): Promise<AckWait> {
    return new Promise<AckWait>(resolve => {
      const timer = this.schedule(() => this.settleAck(identity.deliveryId, { kind: 'timeout' }), this.ackDeadlineMs)
      this.pendingAcks.set(identity.deliveryId, { ...identity, resolve, timer })
    })
  }
  private awaitReceipt(requestId: string, identity: DeliveryIdentity): Promise<ReceiptWait> {
    return new Promise<ReceiptWait>(resolve => {
      const timer = this.schedule(() => this.settleReceipt(requestId, { kind: 'timeout' }), this.ackDeadlineMs)
      this.pendingReceipts.set(requestId, { ...identity, resolve, timer })
    })
  }
  private settleAck(deliveryId: string, waited: AckWait): void {
    const entry = this.pendingAcks.get(deliveryId)
    if (!entry) return
    this.pendingAcks.delete(deliveryId); this.cancel(entry.timer); entry.resolve(waited)
  }
  private settleReceipt(requestId: string, waited: ReceiptWait): void {
    const entry = this.pendingReceipts.get(requestId)
    if (!entry) return
    this.pendingReceipts.delete(requestId); this.cancel(entry.timer); entry.resolve(waited)
  }
  private clearAck(deliveryId: string): void { const entry = this.pendingAcks.get(deliveryId); if (entry) { this.pendingAcks.delete(deliveryId); this.cancel(entry.timer) } }
  private clearReceipt(requestId: string): void { const entry = this.pendingReceipts.get(requestId); if (entry) { this.pendingReceipts.delete(requestId); this.cancel(entry.timer) } }
  private onAck(event: BridgeAssignmentEvent): void {
    const frame = event.frame
    const entry = this.pendingAcks.get(frame.body.deliveryId as string)
    if (!entry) return
    if (frame.body.assignmentId !== entry.assignmentId || frame.body.attemptId !== entry.attemptId || frame.body.runId !== entry.runId || frame.body.payloadDigest !== entry.payloadDigest) return
    this.settleAck(entry.deliveryId, { kind: 'ack', outcome: frame.body.outcome as 'accepted' | 'busy' | 'duplicate' | 'invalid' | 'unknown', storedOutcome: (frame.body.storedOutcome ?? null) as 'accepted' | 'unknown' | null, reason: (frame.body.reason ?? null) as string | null })
  }
  private onReceipt(event: BridgeAssignmentEvent): void {
    const frame = event.frame
    const entry = this.pendingReceipts.get(frame.body.requestId as string)
    if (!entry) return
    if (frame.body.deliveryId !== entry.deliveryId || frame.body.assignmentId !== entry.assignmentId || frame.body.attemptId !== entry.attemptId || frame.body.runId !== entry.runId || frame.body.payloadDigest !== entry.payloadDigest) return
    this.settleReceipt(frame.body.requestId as string, { kind: 'receipt', known: frame.body.known as boolean, outcome: (frame.body.outcome ?? null) as 'accepted' | 'busy' | 'invalid' | 'unknown' | null })
  }
  private markWriterUncertain(projectId: string): void {
    const writer = this.store.getWriter(projectId)
    if (writer?.state === 'held') this.store.markWriterUncertain(projectId, this.clock())
  }
  private replay(delivery: { deliveryId: string; state: AssignmentOutboxState; reasonCode: string | null }): AssignmentDeliveryResult {
    const outcome: AssignmentDeliveryOutcome = delivery.state === 'written' ? 'accepted' : delivery.state === 'not_sent' ? 'not_sent' : 'unknown'
    return this.result(delivery, delivery.state, outcome, null, delivery.reasonCode, true)
  }
  private result(delivery: { deliveryId: string; state: AssignmentOutboxState; reasonCode: string | null }, state: AssignmentOutboxState, outcome: AssignmentDeliveryOutcome, storedOutcome: 'accepted' | 'unknown' | null, reasonCode: string | null, replayed = false): AssignmentDeliveryResult {
    return { deliveryId: delivery.deliveryId, state, outcome, storedOutcome, reasonCode, replayed }
  }
}
