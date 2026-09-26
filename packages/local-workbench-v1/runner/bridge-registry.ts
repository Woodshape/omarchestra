import { incarnationKey, type PiIncarnation } from './binding-identity.ts'
import { projectExecutionContextDigest } from './canonical-hash.ts'
import { bridgeId, encodeBridgeFrame, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY, PROJECT_CONTEXT_CAPABILITY, ASSIGNMENT_DELIVERY_CAPABILITY, CANDIDATE_SUBMISSION_CAPABILITY, QUIESCENCE_CAPABILITY, type BridgeFrame } from './bridge-protocol.ts'
import { SessionCodes } from './session-code.ts'
import type { WorkbenchStore } from './store.ts'
import type { FenceLedger } from './fences.ts'

export const BRIDGE_LEASE_MS = 15_000
export const BRIDGE_HEARTBEAT_MS = 5_000
export interface BridgePeer { send(bytes: Buffer): void; close(): void }
export type NavigationState = 'idle' | 'checking' | 'shown' | 'unavailable' | 'unknown'
export interface ObservedPi { observedSessionId: string; sessionCode: string | null; navigation: { ticket: string | null; state: NavigationState } | null; incarnation: PiIncarnation; lifecycle: string; activity: string; health: string; available: boolean; mode: 'observed' | 'committed'; executionContextDigest: string | null; executionContextAt: number | null }
export interface BridgeSourceInput { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; sourceSequence: number; eventId: string }
/** Trusted S5 callback, called only on the exact current transport object. */
export interface BridgeAdoptionAck { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; peer: BridgePeer; frame: BridgeFrame }
/** One same-Pi assignment ACK or durable-receipt reply from the exact committed connection. */
export interface BridgeAssignmentEvent { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; peer: BridgePeer; frame: BridgeFrame }
/** One bounded C6 Candidate submission from the exact committed connection. */
export interface BridgeCandidateEvent { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; peer: BridgePeer; frame: BridgeFrame }
/** One-shot, currentness-checked send captured from a committed connection. */
export type AssignmentSendResult = 'sent' | 'not_sent' | 'unknown'
type Entry = { key: string; sessionCode: string | null; navigation: { ticket: string; sequence: number; requestId: string | null; deadline: number; state: NavigationState } | null; identity: PiIncarnation; peer: BridgePeer | null; connectionId: string; challenge: string; observedId: string; attempt: number; sequence: number; deadline: number; lifecycle: string; activity: string; health: string; mode: 'observed' | 'committed'; executionContextSupported: boolean; executionContextDigest: string | null; executionContextAt: number | null; assignmentDeliverySupported: boolean; candidateSubmissionSupported: boolean; quiescenceSupported: boolean; dedup: Map<string, string> }
export interface AttemptQuiescence {
  runId: string; attemptId: string; controlEpoch: number; connectionId: string; connectionChallenge: string
  source: 'surviving_bridge_and_operator_reconciliation' | 'validator_exit'
  status: 'confirmed' | 'active' | 'unknown'; sequence: number; runnerReceivedAt: number
}
function refuse(code: string): never { throw new Error(code) }
/** One instance belongs to one runner owner, not to a presentation client. */
export class BridgeRegistry {
  private readonly records = new Map<string, Entry>()
  private readonly codes = new SessionCodes()
  private readonly quiescence = new Map<string, { entry: Entry; attemptId: string; controlEpoch: number; settle: (proof: AttemptQuiescence | null) => void }>()
  private readonly water = new Map<string, { attempt: number; sequence: number }>()
  private readonly peers = new Map<BridgePeer, Entry>()
  private management: { onAdoptionAck?: (event: BridgeAdoptionAck) => void; onBindingReceipt?: (event: BridgeAdoptionAck) => void; onRecoveryProof?: (event: BridgeAdoptionAck) => void; onRegistered?: (event: BridgeAdoptionAck) => void; onDisconnected?: (event: { incarnation: PiIncarnation; connectionId: string }) => void; onInput?: (event: BridgeSourceInput) => void } | null = null
  /** AL-03 delivery is orthogonal to adoption; one handler pair is bound by its coordinator, not by setManagementHandlers. */
  private assignment: { onAck?: (event: BridgeAssignmentEvent) => void; onReceipt?: (event: BridgeAssignmentEvent) => void } = {}
  /** AL-04 Candidate association is orthogonal to delivery; one handler is bound by its coordinator. */
  private candidate: { onSubmission?: (event: BridgeCandidateEvent) => void } = {}
  /** onInput must commit the takeover marker before returning; otherwise do not supply it. */
  private readonly options: { nodeId: string; store: WorkbenchStore; fences: FenceLedger; now?: () => number; issue?: (prefix: string) => string; onInput?: (event: BridgeSourceInput) => void; onAdoptionAck?: (event: BridgeAdoptionAck) => void }
  constructor(options: { nodeId: string; store: WorkbenchStore; fences: FenceLedger; now?: () => number; issue?: (prefix: string) => string; onInput?: (event: BridgeSourceInput) => void; onAdoptionAck?: (event: BridgeAdoptionAck) => void }) { this.options = options }
  setManagementHandlers(handlers: NonNullable<BridgeRegistry['management']>): void {
    if (this.management) refuse('management_already_bound')
    this.management = handlers
  }
  /** Exactly one AL-03 coordinator owns delivery callbacks for this registry. */
  setAssignmentHandlers(handlers: { onAck?: (event: BridgeAssignmentEvent) => void; onReceipt?: (event: BridgeAssignmentEvent) => void }): void {
    if (this.assignment.onAck || this.assignment.onReceipt) refuse('assignment_handlers_already_bound')
    this.assignment = handlers
  }
  /** Exactly one AL-04 coordinator owns Candidate submission for this registry. */
  setCandidateHandler(handlers: { onSubmission?: (event: BridgeCandidateEvent) => void }): void {
    if (this.candidate.onSubmission) refuse('candidate_handlers_already_bound')
    this.candidate = handlers
  }
  private now() { return (this.options.now ?? (() => performance.now()))() }
  private issue(prefix: string) { const value = (this.options.issue ?? bridgeId)(prefix); if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) refuse('invalid_identity'); return value }
  private snapshot(entry: Entry): ObservedPi {
    const available = entry.peer !== null && this.now() < entry.deadline
    const n = entry.navigation
    return { observedSessionId: entry.observedId, sessionCode: available ? entry.sessionCode : null,
      navigation: available && n ? { ticket: n.ticket, state: n.state === 'checking' && this.now() >= n.deadline ? 'unknown' : n.state }
        : n?.state === 'checking' ? { ticket: null, state: 'unknown' } : null,
      incarnation: { ...entry.identity }, lifecycle: entry.lifecycle, activity: entry.activity, health: entry.health, available, mode: entry.mode,
      executionContextDigest: available && entry.executionContextSupported ? entry.executionContextDigest : null,
      executionContextAt: available && entry.executionContextSupported ? entry.executionContextAt : null }
  }
  list(): ObservedPi[] { this.expire(); return this.listCurrent() }
  /** No callback/SQL effects; safe to inspect inside an operator transaction. */
  listCurrent(): ObservedPi[] { return [...this.records.values()].map(entry => this.snapshot(entry)) }
  current(observedId: string): ObservedPi | null { this.expire(); const entry = [...this.records.values()].find(record => record.observedId === observedId); return entry ? this.snapshot(entry) : null }
  currentBinding(observedId: string): { observation: ObservedPi; connectionId: string; challenge: string; peer: BridgePeer } | null {
    // Pure lookup: expiring a lease here could commit a disconnect inside an
    // unrelated operator SQL command and then roll that durable effect back.
    const entry = [...this.records.values()].find(e => e.observedId === observedId && e.peer && this.now() < e.deadline)
    return entry?.peer ? { observation: this.snapshot(entry), connectionId: entry.connectionId, challenge: entry.challenge, peer: entry.peer } : null
  }
  /** Management may send ONLY on a fresh exact current connection, never by observed ID alone. */
  markCommitted(observedId: string, connectionId: string, challenge: string): void {
    const entry = [...this.records.values()].find(e => e.observedId === observedId)
    if (!entry?.peer || entry.connectionId !== connectionId || entry.challenge !== challenge || this.now() >= entry.deadline) refuse('connection_not_current')
    entry.mode = 'committed'
  }
  currentPeer(observedId: string, connectionId: string, challenge: string): BridgePeer | null {
    const entry = [...this.records.values()].find(e => e.observedId === observedId)
    return entry?.peer && this.now() < entry.deadline && entry.connectionId === connectionId && entry.challenge === challenge ? entry.peer : null
  }
  /** Fresh, challenged same-Pi context match for a committed Run. This is a
   * momentary eligibility fact, never Adoption identity or a durable claim. */
  projectContextMatches(runId: string, canonicalProjectPath: string, maxAgeMs = BRIDGE_HEARTBEAT_MS + 1000): boolean {
    const binding = this.options.store.getBinding(runId)
    const identity = this.options.store.getBindingIdentity(runId)
    const project = binding?.projectId ? this.options.store.getProject(binding.projectId) : null
    const goal = identity ? this.options.store.getGoal(identity.goalId) : null
    if (!binding || binding.state !== 'ready' || !binding.projectId || !identity || !project || !goal
        || identity.incarnation.executionNodeId !== this.options.nodeId || project.executionNodeId !== this.options.nodeId
        || goal.projectId !== binding.projectId || project.canonicalPath !== canonicalProjectPath
        || this.options.fences.isFenced(runId) || this.options.fences.isIncarnationFenced(identity.incarnationKey)
        || !this.options.store.listMemberships(identity.goalId).some(member => member.runId === runId)) return false
    const entry = this.records.get(identity.incarnationKey), now = this.now()
    return !!entry && entry.mode === 'committed' && entry.peer !== null && now < entry.deadline
      && entry.executionContextSupported && entry.executionContextDigest === projectExecutionContextDigest(canonicalProjectPath)
      && entry.executionContextAt !== null && now >= entry.executionContextAt && now - entry.executionContextAt <= maxAgeMs
  }
  /** Execution requires the current extension's native Candidate and fresh
   * quiescence ports. Older observer/Adoption peers remain discoverable. */
  assignmentLoopAvailable(runId: string): boolean {
    const identity = this.options.store.getBindingIdentity(runId)
    const entry = identity && this.records.get(identity.incarnationKey)
    return !!entry?.peer && entry.mode === 'committed' && this.now() < entry.deadline
      && entry.assignmentDeliverySupported && entry.candidateSubmissionSupported && entry.quiescenceSupported
  }
  /** Prepare without sending. Caller persists the intent receipt before invoking
   * this one-shot effect. No automatic replay after failure or owner restart. */
  prepareNavigation(ticket: string, requestId: string): (() => void) | null {
    const entry = [...this.records.values()].find(e => e.navigation?.ticket === ticket)
    if (!entry?.peer || this.now() >= entry.deadline || this.options.fences.isIncarnationFenced(entry.key)
        || (entry.navigation!.state === 'checking' && this.now() < entry.navigation!.deadline)) return null
    const peer = entry.peer, connection = entry.connectionId
    let used = false
    return () => {
      if (used) return
      used = true
      const n = entry.navigation!
      if (entry.peer !== peer || this.peers.get(peer) !== entry || entry.connectionId !== connection || this.now() >= entry.deadline
          || this.options.fences.isIncarnationFenced(entry.key)) { n.state = 'unknown'; return }
      n.sequence++; n.requestId = requestId; n.deadline = this.now() + 5000; n.state = 'checking'
      try { peer.send(encodeBridgeFrame('focus_request', bridgeId('focus'), {
        requestId, requestSequence: n.sequence, connectionId: entry.connectionId, connectionChallenge: entry.challenge,
        observedSessionId: entry.observedId, processInstanceId: entry.identity.processInstanceId,
        piSessionId: entry.identity.piSessionId, extensionInstanceId: entry.identity.extensionInstanceId, remainingMs: 5000,
      })) } catch { n.state = 'unknown' }
    }
  }
  /** Full frozen Attempt resolver, shared by dispatch and quiescence. Reconnect
   * cannot silently substitute a new connection for the operator-reviewed one. */
  private exactAttempt(attemptId: string): Entry | null {
    const store = this.options.store, attempt = store.getAttempt(attemptId)
    if (!attempt) return null
    const assignment = store.getAssignment(attempt.assignmentId), run = attempt.runBinding
    const binding = store.getBinding(run.runId), identity = store.getBindingIdentity(run.runId)
    const project = assignment && store.getProject(assignment.projectId)
    const writer = project && store.getWriter(project.projectId)
    if (!assignment || !project || !binding || !identity || binding.state !== 'ready'
        || binding.controlEpoch !== attempt.controlEpoch || binding.bindingDigest !== run.bindingDigest
        || assignment.agentRunId !== run.runId || identity.goalId !== assignment.goalId
        || identity.incarnationKey !== incarnationKey({ executionNodeId: run.executionNodeId, processInstanceId: run.processInstanceId, piSessionId: run.piSessionId, extensionInstanceId: run.extensionInstanceId }) || this.options.fences.isFenced(run.runId)
        || this.options.fences.isIncarnationFenced(identity.incarnationKey)
        || !writer || writer.state !== 'held' || writer.assignmentId !== assignment.assignmentId
        || writer.attemptId !== attemptId || writer.epoch !== attempt.writerEpoch || store.getStop(assignment.assignmentId)
        || ['accepted', 'stopped', 'failed'].includes(assignment.state)
        || project.canonicalPath !== attempt.context.canonicalPath || project.gitCommonDir !== attempt.context.gitCommonDir
        || project.contextDigest !== attempt.context.repositoryIdentity) return null
    const entry = this.records.get(identity.incarnationKey)
    if (!entry?.peer || entry.mode !== 'committed' || this.now() >= entry.deadline
        || entry.connectionId !== run.connectionId || entry.challenge !== run.connectionChallenge) return null
    return entry
  }

  /** Explicit fresh same-process activity query; no cached idle report proves
   * quiescence. Lost coverage/reconnect requires separate reconciliation. */
  queryAttemptQuiescence(attemptId: string): Promise<AttemptQuiescence | null> {
    const entry = this.exactAttempt(attemptId), attempt = this.options.store.getAttempt(attemptId)
    if (!entry?.quiescenceSupported || !attempt) return Promise.resolve(null)
    const requestId = bridgeId('quiescence')
    return new Promise(resolve => {
      const timer = setTimeout(() => settle(null), 2000)
      const settle = (proof: AttemptQuiescence | null) => { clearTimeout(timer); this.quiescence.delete(requestId); resolve(proof) }
      this.quiescence.set(requestId, { entry, attemptId, controlEpoch: attempt.controlEpoch, settle })
      try { entry.peer!.send(encodeBridgeFrame('quiescence_request', requestId, {
        connectionId: entry.connectionId, connectionChallenge: entry.challenge, requestId,
        runId: attempt.runBinding.runId, attemptId, controlEpoch: attempt.controlEpoch,
      })) } catch { settle(null) }
    })
  }

  quiescenceCurrent(proof: AttemptQuiescence): boolean {
    const entry = this.exactAttempt(proof.attemptId), now = this.now()
    return !!entry && proof.status === 'confirmed' && proof.source === 'surviving_bridge_and_operator_reconciliation'
      && entry.connectionId === proof.connectionId && entry.challenge === proof.connectionChallenge
      && entry.sequence === proof.sequence && now >= proof.runnerReceivedAt && now - proof.runnerReceivedAt <= 2000
  }

  /** Prepare without sending. Caller persists `attempting` before invoking this
   * one-shot effect. Returns `not_sent` when currentness changed, `unknown` when
   * the local socket write itself failed, and never replays after a failure. */
  prepareAssignmentDelivery(runId: string, delivery: { deliveryId: string; assignmentId: string; attemptId: string; payloadDigest: string; payloadJson: string; deadline: number; remainingMs: number }): (() => AssignmentSendResult) | null {
    const entry = this.exactAttempt(delivery.attemptId)
    const stored = this.options.store.getAssignmentDelivery(delivery.attemptId)
    if (!entry?.peer || !entry.assignmentDeliverySupported || !stored || stored.runId !== runId
        || stored.frameJson !== delivery.payloadJson || stored.payloadDigest !== delivery.payloadDigest
        || !Number.isFinite(delivery.remainingMs) || delivery.remainingMs <= 0) return null
    const projectPath = this.options.store.getAttempt(delivery.attemptId)!.context.canonicalPath
    if (!this.projectContextMatches(runId, projectPath) || entry.lifecycle !== 'running' || entry.health !== 'healthy') return null
    // Owner wall-clock deadlines never mix with the registry's monotonic clock.
    const expires = this.now() + Math.min(delivery.remainingMs, 5000)
    const peer = entry.peer, connection = entry.connectionId, challenge = entry.challenge
    let used = false
    return () => {
      if (used) return 'not_sent'
      used = true
      if (this.exactAttempt(delivery.attemptId) !== entry || entry.peer !== peer || this.peers.get(peer) !== entry
          || this.now() >= expires || !this.projectContextMatches(runId, projectPath)
          || entry.lifecycle !== 'running' || entry.health !== 'healthy') return 'not_sent'
      try {
        peer.send(encodeBridgeFrame('assignment_delivery', bridgeId('assignment'), {
          connectionId: connection, connectionChallenge: challenge,
          deliveryId: delivery.deliveryId, assignmentId: delivery.assignmentId, attemptId: delivery.attemptId, runId,
          payloadDigest: delivery.payloadDigest, payloadJson: delivery.payloadJson, deliveryDeadline: delivery.deadline,
        }))
        return 'sent'
      } catch { return 'unknown' }
    }
  }
  /** Prepare a durable-receipt query on the same exact current committed connection. */
  prepareAssignmentReceiptRequest(runId: string, query: { requestId: string; deliveryId: string; assignmentId: string; attemptId: string; payloadDigest: string }): (() => AssignmentSendResult) | null {
    const binding = this.options.store.getBinding(runId), identity = this.options.store.getBindingIdentity(runId)
    if (!binding || !identity) return null
    const entry = this.records.get(identity.incarnationKey), now = this.now()
    if (!entry?.peer || entry.mode !== 'committed' || !entry.assignmentDeliverySupported || now >= entry.deadline
        || this.options.fences.isIncarnationFenced(entry.key) || this.options.fences.isFenced(runId)) return null
    const peer = entry.peer, connection = entry.connectionId, challenge = entry.challenge
    let used = false
    return () => {
      if (used) return 'not_sent'
      used = true
      const currentIdentity = this.options.store.getBindingIdentity(runId)
      if (entry.peer !== peer || this.peers.get(peer) !== entry || entry.connectionId !== connection || entry.challenge !== challenge
          || this.now() >= entry.deadline || this.options.fences.isIncarnationFenced(entry.key)
          || this.options.fences.isFenced(runId) || currentIdentity?.incarnationKey !== entry.key) return 'not_sent'
      try {
        peer.send(encodeBridgeFrame('assignment_receipt_request', bridgeId('assignment-receipt'), {
          connectionId: connection, connectionChallenge: challenge,
          requestId: query.requestId, deliveryId: query.deliveryId, assignmentId: query.assignmentId, attemptId: query.attemptId, runId,
          payloadDigest: query.payloadDigest,
        }))
        return 'sent'
      } catch { return 'unknown' }
    }
  }
  /** Prepare one Candidate receipt on the same exact current committed connection. */
  prepareCandidateReceipt(runId: string, receipt: { submissionId: string; payloadDigest: string; outcome: 'accepted' | 'duplicate' | 'invalid'; candidateId: string | null; digest: string | null; reason: string | null }): (() => AssignmentSendResult) | null {
    const binding = this.options.store.getBinding(runId), identity = this.options.store.getBindingIdentity(runId)
    if (!binding || binding.state === 'retired' || binding.state === 'purged' || !identity) return null
    const entry = this.records.get(identity.incarnationKey), now = this.now()
    if (!entry?.peer || entry.mode !== 'committed' || !entry.candidateSubmissionSupported || now >= entry.deadline
        || this.options.fences.isIncarnationFenced(entry.key) || this.options.fences.isFenced(runId)) return null
    const peer = entry.peer, connection = entry.connectionId, challenge = entry.challenge
    let used = false
    return () => {
      if (used) return 'not_sent'
      used = true
      const currentIdentity = this.options.store.getBindingIdentity(runId)
      if (entry.peer !== peer || this.peers.get(peer) !== entry || entry.connectionId !== connection || entry.challenge !== challenge
          || this.now() >= entry.deadline || this.options.fences.isIncarnationFenced(entry.key)
          || this.options.fences.isFenced(runId) || currentIdentity?.incarnationKey !== entry.key) return 'not_sent'
      try {
        peer.send(encodeBridgeFrame('candidate_receipt', bridgeId('candidate-receipt'), {
          connectionId: connection, connectionChallenge: challenge, runId, submissionId: receipt.submissionId,
          payloadDigest: receipt.payloadDigest, outcome: receipt.outcome, candidateId: receipt.candidateId,
          digest: receipt.digest, reason: receipt.reason,
        }))
        return 'sent'
      } catch { return 'unknown' }
    }
  }
  receive(peer: BridgePeer, frame: BridgeFrame): void {
    if (frame.type === 'register') { this.register(peer, frame); return }
    const entry = this.peers.get(peer)
    if (!entry || entry.peer !== peer || this.now() >= entry.deadline) refuse('connection_not_current')
    if (this.options.fences.isIncarnationFenced(entry.key)) refuse('fence_conflict')
    const body = frame.body
    if (frame.type === 'heartbeat' && Object.hasOwn(body, 'executionContextDigest') && !entry.executionContextSupported) refuse('invalid_bridge_envelope')
    if (frame.type === 'registered' || frame.type === 'rejected' || frame.type === 'input_received'
        || frame.type === 'adoption_request' || frame.type === 'adoption_committed' || frame.type === 'recovery_request' || frame.type === 'focus_request'
        || frame.type === 'assignment_delivery' || frame.type === 'assignment_receipt_request' || frame.type === 'candidate_receipt' || frame.type === 'quiescence_request') refuse('invalid_bridge_envelope')
    if (body.connectionId !== entry.connectionId || body.connectionChallenge !== entry.challenge) refuse('connection_not_current')
    const serialized = JSON.stringify(frame)
    const prior = entry.dedup.get(frame.messageId)
    if (prior !== undefined) { if (prior !== serialized) refuse('message_id_conflict'); return }
    const seq = body.sourceSequence as number
    if (seq <= entry.sequence) refuse('invalid_sequence')
    // A previous connection's last sequence cannot be replayed after reconnect.
    const water = this.water.get(entry.key)
    if (water && seq <= water.sequence) refuse('invalid_sequence')
    if (frame.type === 'adoption_ack' && (!(this.management?.onAdoptionAck ?? this.options.onAdoptionAck)
        || entry.mode !== 'observed' || body.processInstanceId !== entry.identity.processInstanceId
        || body.piSessionId !== entry.identity.piSessionId || body.extensionInstanceId !== entry.identity.extensionInstanceId
        || body.observedSessionId !== entry.observedId)) refuse('invalid_identity')
    if ((frame.type === 'binding_receipt' || frame.type === 'recovery_proof')
        && (entry.mode !== 'committed' || !(frame.type === 'binding_receipt' ? this.management?.onBindingReceipt : this.management?.onRecoveryProof))) refuse('invalid_identity')
    if (frame.type === 'input_observed' && entry.mode === 'committed') {
      const currentMember = this.options.store.listBindings().some(binding => {
        if (binding.state === 'retired' || binding.state === 'purged') return false
        const saved = this.options.store.getBindingIdentity(binding.runId)
        return saved?.incarnationKey === entry.key && this.options.store.listMemberships(saved.goalId).some(member => member.runId === binding.runId)
      })
      if (!currentMember) refuse('invalid_identity')
    }
    // Reserve ordering BEFORE callbacks: a fake paired stream or a real
    // implementation may synchronously receive a response to a committed
    // delivery while the original ACK is still on this stack.
    entry.sequence = seq
    this.water.set(entry.key, { attempt: entry.attempt, sequence: seq })
    entry.dedup.set(frame.messageId, serialized)
    if (entry.dedup.size > 256) entry.dedup.delete(entry.dedup.keys().next().value!)
    entry.deadline = this.now() + BRIDGE_LEASE_MS
    if (frame.type === 'quiescence_report') {
      const pending = this.quiescence.get(body.requestId as string)
      const attempt = pending && this.options.store.getAttempt(pending.attemptId)
      if (!pending || pending.entry !== entry || !attempt || this.exactAttempt(pending.attemptId) !== entry
          || body.attemptId !== pending.attemptId || body.runId !== attempt.runBinding.runId || body.controlEpoch !== pending.controlEpoch) return
      const contextMatches = body.executionContextDigest === projectExecutionContextDigest(attempt.context.canonicalPath)
      pending.settle({ runId: body.runId as string, attemptId: pending.attemptId, controlEpoch: pending.controlEpoch,
        connectionId: entry.connectionId, connectionChallenge: entry.challenge,
        source: 'surviving_bridge_and_operator_reconciliation', status: !contextMatches || body.pendingInput ? 'unknown'
          : body.activity === 'idle' ? 'confirmed' : body.activity === 'busy' || body.activity === 'waiting_for_user' ? 'active' : 'unknown',
        sequence: seq, runnerReceivedAt: this.now() })
      return
    }
    if (frame.type === 'focus_result') {
      const n = entry.navigation
      // Ignore obsolete/late results, never attribute them to a newer click.
      if (n && n.state === 'checking' && n.requestId === body.requestId && this.now() < n.deadline) n.state = body.status as NavigationState
    } else if (frame.type === 'adoption_ack') {
      const handler = this.management?.onAdoptionAck ?? this.options.onAdoptionAck
      if (!handler || entry.mode !== 'observed'
          || body.processInstanceId !== entry.identity.processInstanceId
          || body.piSessionId !== entry.identity.piSessionId
          || body.extensionInstanceId !== entry.identity.extensionInstanceId
          || body.observedSessionId !== entry.observedId) refuse('invalid_identity')
      handler({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId,
        connectionId: entry.connectionId, connectionChallenge: entry.challenge, peer, frame })
    } else if (frame.type === 'binding_receipt' || frame.type === 'recovery_proof') {
      if (entry.mode !== 'committed' || body.runId === undefined) refuse('invalid_identity')
      const handler = frame.type === 'binding_receipt' ? this.management?.onBindingReceipt : this.management?.onRecoveryProof
      if (!handler) refuse('invalid_identity')
      handler({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId,
        connectionId: entry.connectionId, connectionChallenge: entry.challenge, peer, frame })
    } else if (frame.type === 'assignment_ack' || frame.type === 'assignment_receipt') {
      // Delivery callbacks are trusted only on a committed connection whose
      // retained membership still matches the ACK's exact Run.
      if (entry.mode !== 'committed') refuse('invalid_identity')
      const handler = frame.type === 'assignment_ack' ? this.assignment.onAck : this.assignment.onReceipt
      if (!handler) refuse('invalid_identity')
      const runId = body.runId as string
      const binding = this.options.store.getBinding(runId), identity = binding ? this.options.store.getBindingIdentity(runId) : null
      if (!binding || binding.state === 'retired' || binding.state === 'purged' || !identity || identity.incarnationKey !== entry.key) refuse('invalid_identity')
      handler({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId,
        connectionId: entry.connectionId, connectionChallenge: entry.challenge, peer, frame })
    } else if (frame.type === 'candidate_submission') {
      // Candidate association is trusted only on a committed connection whose
      // retained membership still matches the submitted exact Run.
      if (entry.mode !== 'committed' || !entry.candidateSubmissionSupported) refuse('invalid_identity')
      const handler = this.candidate.onSubmission
      if (!handler) refuse('invalid_identity')
      const runId = body.runId as string
      const binding = this.options.store.getBinding(runId), identity = binding ? this.options.store.getBindingIdentity(runId) : null
      if (!binding || binding.state === 'retired' || binding.state === 'purged' || !identity || identity.incarnationKey !== entry.key) refuse('invalid_identity')
      handler({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId,
        connectionId: entry.connectionId, connectionChallenge: entry.challenge, peer, frame })
    } else if (frame.type === 'input_observed') {
      // No ordinary input is takeover. Retained committed membership, not a
      // client-supplied flag, decides whether the source-only event is useful.
      if (entry.mode === 'committed') {
        const currentMember = this.options.store.listBindings().some(binding => {
          if (binding.state === 'retired' || binding.state === 'purged') return false
          const saved = this.options.store.getBindingIdentity(binding.runId)
          return saved?.incarnationKey === entry.key && this.options.store.listMemberships(saved.goalId).some(member => member.runId === binding.runId)
        })
        if (!currentMember) refuse('invalid_identity')
        const onInput = this.management?.onInput ?? this.options.onInput
        onInput?.({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId, connectionId: entry.connectionId, connectionChallenge: entry.challenge, sourceSequence: seq, eventId: body.eventId as string })
        // Never acknowledge a local socket write in place of a durable
        // takeover effect. An owner without a persistence callback stays silent.
        if (onInput) peer.send(encodeBridgeFrame('input_received', frame.messageId, { connectionId: entry.connectionId, connectionChallenge: entry.challenge, eventId: body.eventId }))
      }
    } else if (frame.type === 'heartbeat') {
      entry.lifecycle = body.lifecycle as string; entry.activity = body.activity as string; entry.health = body.health as string
      if (entry.executionContextSupported) {
        const digest = body.executionContextDigest
        entry.executionContextDigest = typeof digest === 'string' ? digest : null
        entry.executionContextAt = typeof digest === 'string' ? this.now() : null
      }
    }
    if (frame.type === 'close') { this.disconnect(peer); return }
  }
  private register(peer: BridgePeer, frame: BridgeFrame): void {
    if (this.peers.has(peer)) refuse('connection_not_current')
    const body = frame.body
    const identity: PiIncarnation = { executionNodeId: this.options.nodeId, processInstanceId: body.processInstanceId as string, piSessionId: body.piSessionId as string, extensionInstanceId: body.extensionInstanceId as string }
    const key = incarnationKey(identity)
    if (this.options.fences.isIncarnationFenced(key)) refuse('fence_conflict')
    const previous = this.water.get(key)
    const attempt = body.registrationAttempt as number, sequence = body.sourceSequence as number
    if (previous && attempt <= previous.attempt) refuse('stale_registration')
    if (previous && sequence <= previous.sequence) refuse('invalid_sequence')
    const existing = this.records.get(key)
    if (!existing && this.records.size >= 64) refuse('session_limit')
    // A committed identity never becomes an ordinary observation, even after
    // a fresh observed ID is allocated. Resolve retained membership first.
    const bindings = this.options.store.listBindings().filter(binding => {
      const saved = this.options.store.getBindingIdentity(binding.runId)
      return saved?.incarnationKey === key
    })
    if (bindings.length > 1) refuse('invalid_identity')
    const binding = bindings[0]
    if (binding && (binding.state === 'retired' || binding.state === 'purged')) refuse('fence_conflict')
    if (binding) {
      const saved = this.options.store.getBindingIdentity(binding.runId)
      if (!saved || !this.options.store.listMemberships(saved.goalId).some(member => member.runId === binding.runId)) refuse('invalid_identity')
    }
    const mode = binding ? 'committed' : 'observed'
    // No mutation before admission and identity/fence checks have completed.
    const former = existing?.peer
    if (former) this.peers.delete(former)
    const capabilities = body.capabilities as string[]
    const codeSupported = capabilities.includes(SESSION_CODE_CAPABILITY)
    const contextSupported = capabilities.includes(PROJECT_CONTEXT_CAPABILITY)
    // Register establishes only the transport identity. Context is accepted
    // only on a later heartbeat carrying this connection's challenge.
    const sessionCode = codeSupported ? this.codes.forIdentity(key) : null
    const navigation: Entry['navigation'] = (body.capabilities as string[]).includes(PANE_NAVIGATION_CAPABILITY)
      ? { ticket: this.issue('navigate'), sequence: 0, requestId: null, deadline: 0, state: 'idle' } : null
    const entry: Entry = { key, sessionCode, navigation, identity, peer, connectionId: this.issue('connection'), challenge: this.issue('challenge'), observedId: existing?.observedId ?? this.issue('observed'), attempt, sequence, deadline: this.now() + BRIDGE_LEASE_MS, lifecycle: body.lifecycle as string, activity: body.activity as string, health: body.health as string, mode,
      executionContextSupported: contextSupported, executionContextDigest: null, executionContextAt: null, assignmentDeliverySupported: capabilities.includes(ASSIGNMENT_DELIVERY_CAPABILITY), candidateSubmissionSupported: capabilities.includes(CANDIDATE_SUBMISSION_CAPABILITY), quiescenceSupported: capabilities.includes(QUIESCENCE_CAPABILITY), dedup: new Map() }
    const response = encodeBridgeFrame('registered', frame.messageId, { observedSessionId: entry.observedId, executionNodeId: this.options.nodeId, connectionId: entry.connectionId, connectionChallenge: entry.challenge, acceptedRegistrationAttempt: attempt, acceptedSourceSequence: sequence, leaseDurationMs: BRIDGE_LEASE_MS, heartbeatIntervalMs: BRIDGE_HEARTBEAT_MS, mode, ...(codeSupported ? { sessionCode } : {}) })
    this.records.set(key, entry); this.peers.set(peer, entry)
    this.water.set(key, { attempt, sequence })
    try { peer.send(response) } catch (error) {
      this.peers.delete(peer)
      if (existing) { this.records.set(key, existing); if (former) this.peers.set(former, existing) } else this.records.delete(key)
      if (previous) this.water.set(key, previous); else this.water.delete(key)
      throw error
    }
    if (former) { this.management?.onDisconnected?.({ incarnation: { ...identity }, connectionId: existing!.connectionId }); former.close() }
    if (mode === 'committed') this.management?.onRegistered?.({ incarnation: { ...entry.identity }, observedSessionId: entry.observedId,
      connectionId: entry.connectionId, connectionChallenge: entry.challenge, peer, frame })
    // Pi session replacement invalidates its previous observation even if the
    // old socket's close was lost. Do not alias it to the new identity.
    for (const older of this.records.values()) {
      if (older === entry || older.identity.processInstanceId !== identity.processInstanceId || older.identity.extensionInstanceId !== identity.extensionInstanceId) continue
      if (older.peer) { const obsolete = older.peer; this.disconnect(obsolete); obsolete.close() }
    }
  }
  disconnect(peer: BridgePeer): void {
    const entry = this.peers.get(peer)
    this.peers.delete(peer)
    if (entry?.peer === peer) {
      entry.peer = null
      for (const query of [...this.quiescence.values()]) if (query.entry === entry) query.settle(null)
      this.management?.onDisconnected?.({ incarnation: { ...entry.identity }, connectionId: entry.connectionId })
    }
  }
  expire(): void {
    for (const [key, entry] of this.records) {
      if (this.now() < entry.deadline) continue
      if (entry.peer) { const peer = entry.peer; this.disconnect(peer); peer.close() }
      this.records.delete(key)
    }
    // Bounded high-water history; never evict a current incarnation.
    if (this.water.size > 256) for (const key of this.water.keys()) {
      if (this.water.size <= 256) break
      if (!this.records.has(key)) this.water.delete(key)
    }
  }
  close(): void {
    for (const peer of [...this.peers.keys()]) { this.disconnect(peer); peer.close() }
    this.records.clear(); this.water.clear()
  }
}
