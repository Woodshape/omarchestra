/** Native operator reconciliation. Request receipts commit before Pi effects;
 * reports never grant authority without a separately confirmed operator action. */
import { canonicalJson, sha256 } from './canonical-hash.ts'
import { bridgeId, encodeBridgeFrame } from './bridge-protocol.ts'
import { validateHandoffContent, type ControlTarget, type HandoffContent } from './intervention-protocol.ts'
import { captureStableProjectBaseline } from './content-manifest.ts'
import { verifyCandidateArtifacts } from './candidate-submission.ts'
import { verifyCheckResources } from './check-definition.ts'
import { assignmentGateRunning, assignmentRemainingMs } from './assignment-budget.ts'
import { handoffDigest, type HandoffRecord, type AttemptRecord } from './store.ts'
import { workbenchError } from './errors.ts'
import type { WorkbenchAuthority, StartAdmission } from './authority.ts'
import type { BridgeCandidateEvent, BridgeRegistry } from './bridge-registry.ts'
import type { GitRunner } from './git-context.ts'

type Operation = {
  requestId: string; assignmentId: string; attemptId: string; intentId: string; ownerEpoch: number
  kind: 'return_to_team' | 'resume' | 'retry' | 'reconcile_writer'; target: ControlTarget
  phase: 'requested' | 'awaiting_handoff' | 'handoff' | 'probing' | 'resuming' | 'completed' | 'attention'
  started: number; reason: string | null; handoff: HandoffRecord | null
  notes: string | null; acknowledgeRisk: boolean
}
type Ports = { git?: GitRunner; frame: (assignment: import('./store.ts').AssignmentRecord, attempt: AttemptRecord, deadline: number) => Record<string, unknown>; admitted?: (admission: StartAdmission) => void }
const services = new WeakMap<BridgeRegistry, AssignmentIntervention>()
const pointer = (id: string) => `intervention_latest_${id}`
const key = (id: string) => `intervention_${id}`
const refuse = (message: string): never => {
  throw Object.assign(workbenchError('fence_conflict', message, 'review the exact Pi, prior effects and current Assignment; nothing is automatically resumed'),
    { interventionReason: message })
}
export function bindAssignmentIntervention(owner: WorkbenchAuthority, ports: Ports): AssignmentIntervention | null {
  if (!owner.registry) return null
  const prior = services.get(owner.registry)
  if (prior) { prior.rebind(owner, ports); return prior }
  const service = new AssignmentIntervention(owner, owner.registry, ports)
  services.set(owner.registry, service)
  return service
}
export class AssignmentIntervention {
  private owner: WorkbenchAuthority
  private readonly registry: BridgeRegistry
  private ports: Ports
  constructor(owner: WorkbenchAuthority, registry: BridgeRegistry, ports: Ports) {
    this.owner = owner; this.registry = registry; this.ports = ports
    registry.setHandoffHandler(event => this.receive(event))
  }
  rebind(owner: WorkbenchAuthority, ports: Ports): void { this.owner = owner; this.ports = ports }
  private get store() { return this.owner.runner.store }
  latest(assignmentId: string): Operation | null {
    const id = this.store.getMeta(pointer(assignmentId))
    if (!id) return null
    try { return JSON.parse(this.store.getMeta(key(id)) ?? 'null') } catch { return null }
  }
  sweep(): void {
    for (const assignment of this.store.listAssignments()) {
      const op = this.latest(assignment.assignmentId)
      if (!op || !['requested', 'awaiting_handoff', 'probing', 'resuming'].includes(op.phase)) continue
      if (op.ownerEpoch !== this.owner.runner.epoch) this.update(op, 'attention', 'intervention_owner_restarted')
      else if (this.owner.monotonic() - op.started >= 30_000) this.update(op, 'attention', 'intervention_timeout')
    }
  }
  actions(assignmentId: string): import('../console/schema.ts').WorkbenchSnapshot['actions'] {
    const assignment = this.store.getAssignment(assignmentId)
    if (!assignment || !['attention', 'reconciling', 'stopped', 'failed'].includes(assignment.state)) return []
    const writer = this.store.getWriter(assignment.projectId)
    if (!writer || writer.assignmentId !== assignmentId || writer.state === 'none') return []
    const op = this.latest(assignmentId), target = this.registry.controlTarget(assignment.agentRunId)
    const pending = !!op && this.current(op) && ['requested', 'awaiting_handoff', 'probing', 'resuming'].includes(op.phase)
      && this.owner.monotonic() - op.started < 30_000
    const handoff = op?.handoff && this.current(op) && op.handoff.controlEpoch === target?.controlEpoch ? op.handoff : null
    const ready = !!target && !pending && !assignmentGateRunning(this.store, assignmentId)
    const stopped = this.store.getStop(assignmentId) !== null
    const action = (kind: string, label: string, enabled: boolean, reason: string) => ({ kind, target: assignmentId, label, enabled,
      reasonCode: enabled ? null : 'reconciliation_required', reason })
    const actions = [action('return_to_team', 'Return to team · request handoff', ready,
      pending ? 'Waiting for this Pi; no work will resume automatically.' : !target
        ? 'The same surviving Pi must reconnect. Retirement or purge cannot clear its uncertain effects.'
        : 'Ask this same Pi for a structured handoff only. No work resumes and no files are rolled back.')]
    if (stopped) actions.push(action('reconcile_writer', 'Reconcile and release stopped writer', ready && handoff?.outstandingEffects === 'none_reported',
      'Requires your recorded review, risk acknowledgement and fresh same-Pi quiescence. Releases only this writer; never restarts the stopped Assignment.'))
    else if (handoff) actions.push(action('resume', 'Reconcile and resume', ready && handoff.outstandingEffects === 'none_reported',
      'After your recorded review, revalidate the checkout and original gate, advance control, then send one bounded correction. No fresh stopping budget.'))
    else if (this.store.getBinding(assignment.agentRunId)?.state === 'ready') actions.push(action('retry', 'Reconcile and retry', ready,
      'Review prior effects and acknowledge unmanaged interference. A fresh challenged idle report, unchanged gate and remaining original budget are required.'))
    return actions
  }
  private save(op: Operation): void { this.store.setMeta(key(op.requestId), canonicalJson(op)); this.store.setMeta(pointer(op.assignmentId), op.requestId) }
  private current(op: Operation): boolean {
    return op.ownerEpoch === this.owner.runner.epoch && this.latest(op.assignmentId)?.requestId === op.requestId
      && this.registry.controlTargetCurrent(op.target)
      && this.store.listAttempts(op.assignmentId).at(-1)?.attemptId === op.attemptId
  }
  private update(op: Operation, phase: Operation['phase'], reason: string | null): void {
    const current = this.latest(op.assignmentId)
    if (current?.requestId !== op.requestId) return
    this.owner.commit('intervention_updated', { runId: op.target.runId }, () => this.save({ ...current, phase, reason }))
  }
  /** Called inside the authority command/receipt transaction. */
  request(kind: Operation['kind'], assignmentId: string, intentId: string, notes: unknown, acknowledgeRisk: unknown): void {
    const assignment = this.store.getAssignment(assignmentId), attempt = this.store.listAttempts(assignmentId).at(-1)
    if (!assignment || !attempt || assignment.state === 'accepted') refuse('This Assignment cannot be reconciled.')
    const writer = this.store.getWriter(assignment.projectId)
    if (!writer || writer.state === 'none' || writer.assignmentId !== assignmentId || writer.attemptId !== attempt.attemptId
        || writer.epoch !== attempt.writerEpoch) refuse('This Assignment does not own the retained writer.')
    const binding = this.store.getBinding(assignment.agentRunId)
    if (!binding || !this.registry.controlTarget(binding.runId)) refuse('The exact surviving Pi must reconnect before reconciliation. Retired or purged evidence cannot clear a writer.')
    const previous = this.latest(assignmentId)
    if (previous && this.current(previous) && ['requested', 'probing', 'resuming', 'awaiting_handoff'].includes(previous.phase)
        && this.owner.monotonic() - previous.started < 30_000) refuse('The current intervention request is still pending.')
    if (assignmentGateRunning(this.store, assignmentId)) refuse('The Runner validator is still running. Stop first and wait for its exit evidence.')
    if (kind === 'return_to_team') {
      if (!['attention', 'reconciling', 'stopped', 'failed'].includes(assignment.state)) refuse('Take control before requesting a handoff.')
      if (binding.state !== 'manual_takeover') this.owner.adoption.takeControl(binding.runId)
    } else {
      if (acknowledgeRisk !== true || typeof notes !== 'string' || !notes.trim()) refuse('Record your review of prior effects and acknowledge unmanaged interference before reconciliation.')
      if (kind === 'reconcile_writer' ? !this.store.getStop(assignmentId) : this.store.getStop(assignmentId) !== null) refuse('A stopped Assignment can only release its reconciled writer; it can never resume.')
      if (kind !== 'reconcile_writer' && !['attention', 'reconciling'].includes(assignment.state)) refuse('Only paused work can resume.')
      if (kind !== 'retry' || binding.state !== 'ready') {
        if (!previous?.handoff || !this.current(previous) || previous.handoff.controlEpoch !== binding.controlEpoch) refuse('Request a fresh structured handoff from this same Pi first.')
      }
      if (previous?.handoff && previous.handoff.outstandingEffects !== 'none_reported') refuse('The Pi reports possible or unknown outstanding effects. Resolve these in its terminal, then request a new handoff.')
    }
    const target = this.registry.controlTarget(binding.runId)!
    const op: Operation = { requestId: this.owner.newId('control-'), assignmentId, attemptId: attempt.attemptId, intentId,
      ownerEpoch: this.owner.runner.epoch, kind, target, phase: kind === 'return_to_team' ? 'requested' : 'probing',
      started: this.owner.monotonic(), reason: null, handoff: kind === 'return_to_team' ? null : previous?.handoff ?? null,
      notes: typeof notes === 'string' ? notes : null, acknowledgeRisk: acknowledgeRisk === true }
    this.owner.commit('intervention_requested', { runId: binding.runId }, () => {
      this.save(op)
      if (kind !== 'return_to_team') this.store.markWriterUncertain(assignment.projectId, this.owner.clock())
    }, () => { void this.run(op).catch(error => {
      // Only our static refusal text is public; never forward filesystem or
      // validator errors (which can contain paths or restricted diagnostics).
      const reason = error instanceof Error && 'interventionReason' in error ? String(error.interventionReason)
        : 'Reconciliation failed. Writer retained; review the check, checkout and Pi activity.'
      try { this.update(op, 'attention', reason) } catch { /* closed store: retain the last committed uncertainty */ }
    }) })
  }
  private async run(op: Operation): Promise<void> {
    if (op.kind === 'return_to_team') {
      const reply = await this.registry.queryControl(op.target, 'handoff', op.requestId)
      // A synchronous fake or a very fast tool may already have committed it.
      if (this.latest(op.assignmentId)?.handoff) return
      this.update(op, reply?.outcome === 'accepted' ? 'awaiting_handoff' : 'attention',
        reply?.outcome === 'accepted' ? null : reply?.outcome === 'busy' ? 'pi_busy' : 'handoff_delivery_unknown')
      return
    }
    const assignment = this.store.getAssignment(op.assignmentId)!, prior = this.store.getAttempt(op.attemptId)!
    const project = this.store.getProject(assignment.projectId)!
    if (!this.current(op) || this.store.hasUncertainEffects(project.projectId)) refuse('Prior retired or missing writer evidence remains unresolved.')
    const writer = this.store.getWriter(project.projectId)
    if (!writer || writer.assignmentId !== assignment.assignmentId || writer.attemptId !== prior.attemptId
        || writer.epoch !== prior.writerEpoch || writer.state === 'none') refuse('The exact retained writer no longer matches.')
    if (assignmentGateRunning(this.store, assignment.assignmentId)) refuse('Validator still running.')
    const result = this.store.getGateResult(prior.attemptId)
    const lifetime = this.store.getMeta(`gate_lifetime_${prior.attemptId}`)
    if (lifetime === 'started' || lifetime === 'unknown'
        || result && lifetime !== 'not_spawned' && JSON.parse(result.evidenceJson).scratchCleaned !== true) refuse('Validator cleanup is unproven; retain the writer.')
    if (op.kind !== 'reconcile_writer') {
      const remaining = assignmentRemainingMs(this.store, assignment, this.owner.monotonic())
      if (remaining === null || remaining <= 0 || assignment.attemptCount > assignment.limits.maxCorrections) refuse('The original stopping budget is exhausted or unproven. Stop; do not grant a fresh budget.')
    }
    const baseline = captureStableProjectBaseline(project, { git: this.ports.git })
    if (op.handoff && verifyCandidateArtifacts(project.canonicalPath, op.handoff.artifactRefs)) refuse('Handoff artifacts changed; request a new handoff.')
    const check = this.store.latestCheck(project.projectId, prior.gate.checkId)
    if (op.kind !== 'reconcile_writer') {
      if (!check || check.version !== prior.gate.version || check.digest !== prior.gate.digest) refuse('The frozen acceptance check changed.')
      verifyCheckResources(check, project)
    }
    const proof = await this.registry.queryControl(op.target, 'probe', bridgeId('probe'))
    if (!proof || !this.registry.controlProofCurrent(proof) || !this.current(op)) refuse('Fresh same-Pi quiescence is unavailable.')
    const next = { ...op, phase: 'resuming' as const, target: { ...op.target, controlEpoch: op.target.controlEpoch + 1 } }
    // Advance control durably before asking the same Pi to leave manual mode.
    // Unknown ACK retains the uncertain writer and creates no new Attempt.
    this.owner.commit('reconciliation_control_requested', { runId: op.target.runId }, () => {
      if (!this.registry.controlProofCurrent(proof) || !this.current(op)) refuse('Quiescence changed before commit.')
      this.store.setBindingControlEpoch(op.target.runId, next.target.controlEpoch, this.owner.clock())
      this.store.setBindingState(op.target.runId, 'committed', this.owner.clock())
      this.save(next)
    })
    const ready = await this.registry.queryControl(next.target, 'resume', next.requestId)
    if (!ready || !this.registry.controlProofCurrent(ready) || !this.current(next)) { this.update(next, 'attention', 'resume_outcome_unknown'); return }
    // Re-scan after the async control exchange; do not carry an old checkout
    // baseline into a new write grant. Proof freshness is checked after scanning.
    const final = captureStableProjectBaseline(project, { git: this.ports.git })
    if (final.baselineDigest !== baseline.baselineDigest) refuse('Checkout changed during reconciliation.')
    if (op.kind !== 'reconcile_writer') verifyCheckResources(check!, project)
    let admission: StartAdmission | null = null
    this.owner.commit('assignment_reconciliation_committed', { runId: op.target.runId }, () => {
      if (!this.current(next) || !this.registry.controlProofCurrent(ready) || assignmentGateRunning(this.store, op.assignmentId)) refuse('Reconciliation evidence is no longer current.')
      if (sha256(this.store.getProject(project.projectId)) !== sha256(project) || this.store.hasUncertainEffects(project.projectId)
          || this.store.listBindings().some(binding => binding.projectId === project.projectId && binding.runId !== op.target.runId && binding.writerState !== 'none')) refuse('Project identity or other unresolved writer evidence changed.')
      if (op.kind !== 'reconcile_writer' && this.store.getGoal(assignment.goalId)?.state !== 'active') refuse('The Goal is no longer active.')
      if (op.kind === 'reconcile_writer' ? !this.store.getStop(op.assignmentId) : !!this.store.getStop(op.assignmentId)) refuse('Stop won the reconciliation race.')
      const now = this.owner.clock(), binding = this.store.getBinding(op.target.runId)!
      this.store.reconcileWriter({ ...writer, updatedAt: now })
      this.store.releaseWriter(project.projectId, now)
      this.store.putBinding({ ...binding, state: 'ready', writerState: 'none', updatedAt: now })
      if (op.kind !== 'reconcile_writer') {
        const remaining = assignmentRemainingMs(this.store, assignment, this.owner.monotonic())
        if (remaining === null || remaining <= 0 || this.store.getAssignment(op.assignmentId)!.attemptCount > assignment.limits.maxCorrections) refuse('Original stopping budget is exhausted.')
        const current = this.store.getAssignment(op.assignmentId)!
        if (!['attention', 'reconciling'].includes(current.state) || this.store.getAttempt(prior.attemptId)?.state !== 'attention') refuse('Prior work changed.')
        const latest = this.store.latestCheck(project.projectId, prior.gate.checkId)
        if (!latest || latest.version !== prior.gate.version || latest.digest !== prior.gate.digest) refuse('Frozen check changed.')
        const attemptId = this.owner.newId('attempt-'), deliveryId = this.owner.newId('delivery-'), deadline = now + 30_000
        const attempt: AttemptRecord = { ...prior, attemptId, deliveryId, ordinal: prior.ordinal + 1, state: 'admitted',
          controlEpoch: next.target.controlEpoch, writerEpoch: writer.epoch + 1, createdAt: now, updatedAt: now,
          runBinding: { ...prior.runBinding, connectionId: next.target.connectionId, connectionChallenge: next.target.connectionChallenge },
          context: { ...prior.context, repositoryIdentity: final.repositoryIdentity, headOid: final.headOid,
            dirty: final.dirty, baselineDigest: final.baselineDigest, manifestDigest: final.manifestDigest } }
        const frame = this.ports.frame(assignment, attempt, deadline)
        frame.correction = { priorAttemptId: prior.attemptId, candidateId: this.store.getCandidateByAttempt(prior.attemptId)?.candidateId ?? null,
          reasonCode: result?.reasonCode ?? 'operator_reconciliation', artifactRefs: op.handoff?.artifactRefs ?? [] }
        const frameJson = canonicalJson(frame)
        this.store.putAttempt(attempt)
        this.store.acquireWriter({ projectId: project.projectId, assignmentId: assignment.assignmentId, attemptId, epoch: attempt.writerEpoch, updatedAt: now })
        this.store.putAssignmentDelivery({ deliveryId, assignmentId: assignment.assignmentId, attemptId, runId: assignment.agentRunId,
          frameJson, payloadDigest: sha256(frameJson), state: 'queued', reasonCode: null, deadline, createdAt: now })
        this.store.transitionAttempt(prior.attemptId, 'attention', 'rejected', now)
        this.store.transitionAttempt(attemptId, 'admitted', 'dispatching', now)
        this.store.transitionAssignment(op.assignmentId, current.state, 'dispatching', this.owner.revisionOf() + 1, now)
        admission = { status: 'acknowledged', assignmentId: op.assignmentId, attemptId, deliveryId, writerEpoch: attempt.writerEpoch,
          committedRevision: this.owner.revisionOf() + 1, replayed: false }
      }
      this.store.setMeta(`reconciliation_evidence_${op.requestId}`, canonicalJson({ operatorIntentId: op.intentId,
        notes: op.notes, acknowledgeRisk: op.acknowledgeRisk, handoffId: op.handoff?.handoffId ?? null,
        priorWriter: writer, baselineDigest: final.baselineDigest, proof, ready }))
      this.save({ ...next, phase: 'completed', reason: null })
    }, () => { if (admission) { try { this.ports.admitted?.(admission) } catch { /* committed outbox remains retained; never resend here */ } } })
  }
  private receive(event: BridgeCandidateEvent): void {
    const b = event.frame.body
    const stored = this.store.getMeta(key(String(b.requestId)))
    let outcome: 'accepted' | 'duplicate' | 'invalid' = 'invalid'
    try {
      const op: Operation | null = stored ? JSON.parse(stored) : null
      if (!op || op.kind !== 'return_to_team' || !this.current(op)
          || this.owner.monotonic() < op.started || this.owner.monotonic() - op.started > 30_000
          || b.controlEpoch !== op.target.controlEpoch || b.bindingDigest !== op.target.bindingDigest
          || b.runId !== op.target.runId || event.connectionId !== op.target.connectionId || event.connectionChallenge !== op.target.connectionChallenge
          || sha256(String(b.payloadJson)) !== b.payloadDigest) throw new Error('stale_handoff')
      const content: HandoffContent = validateHandoffContent(JSON.parse(String(b.payloadJson)))
      const fields = { ...content, assignmentId: op.assignmentId, attemptId: op.attemptId, agentRunId: op.target.runId, controlEpoch: op.target.controlEpoch }
      const digest = handoffDigest(fields)
      if (op.handoff) { if (op.handoff.digest === digest) outcome = 'duplicate' }
      else {
        const assignment = this.store.getAssignment(op.assignmentId)!, project = this.store.getProject(assignment.projectId)!
        if (verifyCandidateArtifacts(project.canonicalPath, content.artifactRefs)) throw new Error('invalid_artifact')
        const handoff: HandoffRecord = { ...fields, handoffId: this.owner.newId('handoff-'), digest, createdAt: this.owner.clock() }
        this.owner.commit('assignment_handoff', { runId: op.target.runId }, () => {
          if (!this.current(op)) refuse('Handoff became stale.')
          // The original per-Attempt record is immutable; subsequent explicitly
          // requested handoffs retain their own full record in the request log.
          if (!this.store.getHandoff(op.attemptId)) this.store.putHandoff(handoff)
          if (assignment.state === 'attention') this.store.transitionAssignment(op.assignmentId, 'attention', 'reconciling', this.owner.revisionOf() + 1, this.owner.clock())
          this.save({ ...op, handoff, phase: 'handoff', reason: null })
        })
        outcome = 'accepted'
      }
    } catch { /* malformed/stale reports grant nothing and expose no file data */ }
    try { event.peer.send(encodeBridgeFrame('handoff_receipt', bridgeId('handoff-receipt'), {
      connectionId: event.connectionId, connectionChallenge: event.connectionChallenge,
      requestId: b.requestId, runId: b.runId, payloadDigest: b.payloadDigest, outcome,
    })) } catch { /* retained handoff survives lost receipt */ }
  }
}
