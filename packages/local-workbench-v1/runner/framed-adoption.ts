/** S5 framed management authority. Pending proposals do not create Runs. */
import { AdoptionManager, type Proposal, type ProposalInput } from './adoption.ts'
import { incarnationKey } from './binding-identity.ts'
import { bridgeId, encodeBridgeFrame } from './bridge-protocol.ts'
import { type BridgeAdoptionAck, type BridgeSourceInput, type BridgeRegistry } from './bridge-registry.ts'
import { proposalDigest, type PendingProposal } from './pending-proposal.ts'
import { workbenchError } from './errors.ts'
import type { WorkbenchAuthority } from './authority.ts'
import type { BindingRecord } from './store.ts'

const TTL = 30_000, ACK_MS = 5_000, MAX_PROPOSALS = 16
function reject(message: string): never { throw workbenchError('invalid_input', message, 'refresh the current Goal and exact Pi observation, then request a new Adoption') }
export class FramedAdoptionManager extends AdoptionManager {
  private owner: WorkbenchAuthority
  private readonly registry: BridgeRegistry
  private readonly proofs = new Set<string>()
  constructor(owner: WorkbenchAuthority, registry: BridgeRegistry) {
    super(owner, () => null)
    this.owner = owner
    this.registry = registry
    registry.setManagementHandlers({ onAdoptionAck: event => this.onAck(event), onBindingReceipt: event => this.onReceipt(event),
      onRecoveryProof: event => this.onRecovery(event), onRegistered: event => this.onRegistered(event),
      onDisconnected: event => this.onDisconnected(event), onInput: event => this.onInput(event) })
  }
  /** A new presentation session may replace the authority without replacing
   * the lifetime bridge manager or discarding surviving Pi connections. */
  rebind(owner: WorkbenchAuthority): void {
    if (owner.runner !== this.owner.runner || owner.registry !== this.registry) throw new Error('framed_owner_mismatch')
    this.owner = owner
  }
  override bind(): void { /* Framed registry is bound for the lifetime of its owner. */ }
  override unbind(): void { /* The owner closes the registry separately. */ }
  override checkpointCommandState(): () => void { return () => {} /* All proposal state is SQLite-transactional. */ }
  private get store() { return this.owner.runner.store }
  private now() { return this.owner.clock() }
  private view(p: PendingProposal): Proposal {
    return { proposalId: p.proposalId, runId: p.runId, projectId: p.projectId, goalId: p.goalId, role: p.role,
      observedSessionId: p.observedSessionId, executionNodeId: this.owner.executionNodeId, predecessorRunId: p.predecessorRunId,
      vacancyGeneration: p.generation, transportId: p.connectionId, nonce: p.nonce, proposalDigest: p.digest,
      expiresAt: p.expiresAt, stage: p.state === 'authorized' ? 'awaiting_ack' : 'proposed' }
  }
  override retainedProposals(): Proposal[] { this.expire(); return this.store.listProposals().map(p => this.view(p)) }
  override proposalOf(id: string): Proposal | null { this.expire(); const p = this.store.getProposal(id); return p ? this.view(p) : null }
  override generation(projectId: string, role: string, goalId?: string): number { return this.owner.runner.fences.highWater(projectId, role, goalId) + 1 }
  private expire(): void {
    const stale = this.store.listProposals().filter(p => this.now() >= p.expiresAt || (p.ackDeadline !== null && this.now() >= p.ackDeadline))
    if (stale.length) this.owner.commit('adoption_expired', { proposalIds: stale.map(p => p.proposalId) },
      () => { for (const p of stale) this.store.deleteProposal(p.proposalId) },
      () => { for (const p of stale) this.cancel(p) })
  }
  private cancel(p: PendingProposal): void {
    const peer = this.registry.currentPeer(p.observedSessionId, p.connectionId, p.challenge)
    if (!peer) return
    try { peer.send(encodeBridgeFrame('adoption_cancelled', bridgeId('frame'), {
      proposalDigest: p.digest, connectionId: p.connectionId, connectionChallenge: p.challenge })) }
    catch { /* cancellation has no authority effect; reconnect clears pending state */ }
  }
  override propose(input: ProposalInput): Proposal {
    const { projectId, goalId, observedSessionId, role } = input
    if (!goalId) reject('select a local Team Goal before Adoption')
    const project = this.store.getProject(projectId), goal = this.store.getGoal(goalId)
    if (!project || !goal || goal.projectId !== projectId || project.executionNodeId !== this.owner.executionNodeId || goal.state !== 'active') reject('Goal and Project must belong to this local Node')
    this.owner.requireProjectContext(projectId)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(role)) reject('invalid Role')
    if (this.store.listMemberships(goalId).some(m => m.role === role) || this.store.listProposals().some(p => p.goalId === goalId && p.role === role)) reject('Goal Role is occupied or reserved')
    if (this.store.listProposals().length >= MAX_PROPOSALS) reject('pending Adoption capacity reached')
    const current = this.registry.currentBinding(observedSessionId)
    if (!current || current.observation.mode !== 'observed' || current.observation.lifecycle !== 'running'
        || current.observation.activity !== 'idle' || current.observation.health !== 'healthy') reject('Pi is not a current idle healthy ordinary session')
    const incarnation = current.observation.incarnation
    if (incarnation.executionNodeId !== this.owner.executionNodeId || this.owner.runner.fences.isIncarnationFenced(incarnationKey(incarnation))) reject('Pi incarnation is not eligible')
    if (this.store.listProposals().some(p => p.observedSessionId === observedSessionId)
        || this.store.listBindings().some(b => this.store.getBindingIdentity(b.runId)?.incarnationKey === incarnationKey(incarnation))) reject('Pi already has pending or committed management')
    const generation = this.generation(projectId, role, goalId)
    this.owner.runner.fences.assertVacancyGeneration(projectId, role, generation, goalId)
    const predecessorRunId = input.predecessorRunId ?? null
    if (predecessorRunId) {
      const fence = this.owner.runner.fences.getFence(predecessorRunId)
      if (!fence || fence.projectId !== projectId || fence.goalId !== goalId || fence.role !== role || fence.generation !== generation - 1) reject('replacement does not name the current Goal-scoped vacancy')
    } else if (generation !== 1 && this.owner.runner.fences.listFences().some(f => f.projectId === projectId
      && f.goalId === goalId && f.role === role && f.generation === generation - 1)) {
      reject('replacement must name the retained current predecessor')
    }
    const draft = { proposalId: this.owner.newId('proposal-'), runId: this.owner.newId('run-'), projectId, goalId, role,
      observedSessionId, incarnation, connectionId: current.connectionId, challenge: current.challenge,
      nonce: bridgeId('nonce'), generation, predecessorRunId, expiresAt: this.now() + TTL }
    const p: PendingProposal = { ...draft, digest: proposalDigest(draft), state: 'proposed', ackDeadline: null, deliveryJson: null, deliveryState: 'none' }
    this.owner.commit('adoption_proposed', { proposalId: p.proposalId, projectId, goalId }, () => this.store.putProposal(p))
    return this.view(p)
  }
  override authorize(proposalId: string): Proposal {
    const p = this.store.getProposal(proposalId)
    if (!p || p.state !== 'proposed' || this.now() >= p.expiresAt) reject('proposal is no longer current')
    this.owner.requireProjectContext(p.projectId)
    const current = this.requireCurrent(p)
    const ackDeadline = Math.min(p.expiresAt, this.now() + ACK_MS)
    const frameId = this.owner.newId('frame-')
    const body = { proposalId: p.proposalId, proposalDigest: p.digest, acknowledgementNonce: p.nonce,
      observedSessionId: p.observedSessionId, processInstanceId: p.incarnation.processInstanceId,
      piSessionId: p.incarnation.piSessionId, extensionInstanceId: p.incarnation.extensionInstanceId,
      connectionId: p.connectionId, connectionChallenge: p.challenge, targetGoalId: p.goalId,
      targetRole: p.role, vacancyGeneration: p.generation, remainingMs: ackDeadline - this.now() }
    if (body.remainingMs <= 0 || body.remainingMs > ACK_MS) reject('ACK window expired')
    const wire = encodeBridgeFrame('adoption_request', frameId, body)
    const authorized: PendingProposal = { ...p, state: 'authorized', ackDeadline, deliveryJson: wire.subarray(0, -1).toString('utf8'), deliveryState: 'queued' }
    this.owner.commit('adoption_authorized', { proposalId, runId: p.runId }, () => this.store.updateProposal(authorized), () => {
      const live = this.store.getProposal(proposalId)
      if (!live || live.deliveryState !== 'queued') return
      const peer = this.registry.currentPeer(p.observedSessionId, p.connectionId, p.challenge)
      if (!peer || this.now() >= ackDeadline) { this.store.transaction(() => this.store.updateProposal({ ...live, deliveryState: 'not_sent' })); return }
      this.store.transaction(() => this.store.updateProposal({ ...live, deliveryState: 'attempting' }))
      try { peer.send(wire) }
      catch { const latest = this.store.getProposal(proposalId); if (latest) this.store.transaction(() => this.store.updateProposal({ ...latest, deliveryState: 'unknown' })); return }
      const latest = this.store.getProposal(proposalId)
      if (latest?.deliveryState === 'attempting') this.store.transaction(() => this.store.updateProposal({ ...latest, deliveryState: 'written' }))
    })
    return this.view(authorized)
  }
  private requireCurrent(p: PendingProposal) {
    const current = this.registry.currentBinding(p.observedSessionId)
    if (!current || current.connectionId !== p.connectionId || current.challenge !== p.challenge
        || incarnationKey(current.observation.incarnation) !== incarnationKey(p.incarnation)
        || current.observation.mode !== 'observed' || current.observation.activity !== 'idle'
        || current.observation.lifecycle !== 'running' || current.observation.health !== 'healthy') reject('Pi connection or activity changed')
    return current
  }
  private onAck(event: BridgeAdoptionAck): void {
    const body = event.frame.body, p = this.store.getProposal(body.proposalId as string)
    if (!p) reject('ACK names no current proposal')
    if (p.state !== 'authorized' || this.now() >= p.expiresAt || p.ackDeadline === null || this.now() >= p.ackDeadline) reject('ACK or proposal deadline expired')
    if (p.observedSessionId !== event.observedSessionId || p.connectionId !== event.connectionId || p.challenge !== event.connectionChallenge
        || p.digest !== body.proposalDigest || p.nonce !== body.acknowledgementNonce
        || incarnationKey(p.incarnation) !== incarnationKey(event.incarnation)) reject('ACK identity or proposal changed')
    if (body.decision !== 'acknowledged' || body.activity !== 'idle') {
      this.owner.commit('adoption_refused', { proposalId: p.proposalId }, () => this.store.deleteProposal(p.proposalId), () => this.cancel(p))
      return
    }
    this.requireCurrent(p)
    const goal = this.store.getGoal(p.goalId), project = this.store.getProject(p.projectId)
    if (!goal || goal.projectId !== p.projectId || goal.state !== 'active' || !project || project.executionNodeId !== this.owner.executionNodeId
        || this.store.listMemberships(p.goalId).some(m => m.role === p.role)
        || this.owner.runner.fences.isIncarnationFenced(incarnationKey(p.incarnation))) reject('Goal, Role or incarnation no longer eligible')
    this.owner.requireProjectContext(p.projectId)
    this.owner.runner.fences.assertVacancyGeneration(p.projectId, p.role, p.generation, p.goalId)
    const frameId = this.owner.newId('frame-')
    const wire = encodeBridgeFrame('adoption_committed', frameId, { runId: p.runId, bindingDigest: p.digest,
      processInstanceId: p.incarnation.processInstanceId, piSessionId: p.incarnation.piSessionId,
      extensionInstanceId: p.incarnation.extensionInstanceId, connectionId: p.connectionId, connectionChallenge: p.challenge,
      goalId: p.goalId, role: p.role })
    const binding: BindingRecord = { runId: p.runId, projectId: p.projectId, role: p.role, state: 'committed', bindingDigest: p.digest,
      controlEpoch: 1, writerState: 'none', predecessorRunId: p.predecessorRunId, generation: p.generation, updatedAt: this.now() }
    this.owner.commit('adoption_committed', { runId: p.runId, goalId: p.goalId }, () => {
      // This SQL transaction is the ONLY observed -> managed authority edge.
      this.store.putBinding(binding)
      this.owner.runner.bindIdentity(p.runId, p.goalId, p.incarnation)
      this.owner.runner.commitMembership(p.runId)
      this.store.deleteProposal(p.proposalId)
      this.store.putDelivery({ frameId, runId: p.runId, kind: 'committed', frameJson: wire.subarray(0, -1).toString('utf8'),
        connectionId: p.connectionId, deadline: this.now() + ACK_MS, state: 'queued', reasonCode: null, createdAt: this.now() })
    }, () => {
      const peer = this.registry.currentPeer(p.observedSessionId, p.connectionId, p.challenge)
      const change = (from: 'queued' | 'attempting', to: 'not_sent' | 'attempting' | 'unknown' | 'written', reason: 'connection_lost' | 'transport_error' | 'expired' | null) =>
        this.store.transaction(() => this.store.transitionDelivery(frameId, from, to, reason))
      const delivery = this.store.listDeliveries(p.runId).find(record => record.frameId === frameId)
      if (delivery && this.now() >= delivery.deadline) { change('queued', 'not_sent', 'expired'); return }
      if (!peer) { change('queued', 'not_sent', 'connection_lost'); return }
      this.registry.markCommitted(p.observedSessionId, p.connectionId, p.challenge)
      if (!change('queued', 'attempting', null)) return
      try { peer.send(wire) }
      catch { change('attempting', 'unknown', 'transport_error'); return }
      change('attempting', 'written', null)
    })
  }
  private member(event: BridgeAdoptionAck) {
    const runId = String(event.frame.body.runId), binding = this.store.getBinding(runId), identity = this.store.getBindingIdentity(runId)
    if (!binding || !identity || incarnationKey(identity.incarnation) !== incarnationKey(event.incarnation)
        || !this.store.listMemberships(identity.goalId).some(m => m.runId === runId)
        || this.owner.runner.fences.isFenced(runId) || binding.bindingDigest !== event.frame.body.bindingDigest) reject('recovery is not the exact committed unfenced Run')
    if (this.registry.currentPeer(event.observedSessionId, event.connectionId, event.connectionChallenge) !== event.peer) reject('connection changed before managed receipt')
    return { binding, identity }
  }
  private sendStatus(runId: string): void {
    const binding = this.store.getBinding(runId), identity = this.store.getBindingIdentity(runId)
    if (!binding || !binding.bindingDigest || !identity || !['ready', 'manual_takeover'].includes(binding.state)) return
    const agent = this.registry.list().find(a => a.mode === 'committed' && a.available
      && incarnationKey(a.incarnation) === identity.incarnationKey)
    const current = agent && this.registry.currentBinding(agent.observedSessionId)
    if (!current || current.observation.mode !== 'committed') return
    try { current.peer.send(encodeBridgeFrame('managed_status', bridgeId('frame'), {
      runId, bindingDigest: binding.bindingDigest, connectionId: current.connectionId, connectionChallenge: current.challenge,
      state: binding.state })) } catch { /* visual status never grants authority; receipt remains durable */ }
  }
  private onReceipt(event: BridgeAdoptionAck): void {
    const { binding } = this.member(event)
    const delivered = this.store.listDeliveries(binding.runId).some(d => d.kind === 'committed' && d.connectionId === event.connectionId
      && ['attempting', 'written'].includes(d.state))
    if (!delivered && !this.proofs.has(event.connectionId)) reject('binding receipt has no committed delivery or surviving proof')
    if (event.frame.body.pendingInput) {
      if (!['manual_takeover', 'manual_takeover_disconnected'].includes(binding.state)) this.takeControl(binding.runId)
      this.sendStatus(binding.runId)
      return
    }
    if (binding.state === 'manual_takeover') { this.sendStatus(binding.runId); return }
    if (event.frame.body.activity !== 'idle' || this.registry.current(event.observedSessionId)?.activity !== 'idle') return
    if (binding.state !== 'committed' && binding.state !== 'disconnected') return
    this.owner.commit('adoption_ready', { runId: binding.runId }, () => this.store.setBindingState(binding.runId, 'ready', this.now()),
      () => this.sendStatus(binding.runId))
  }
  private onDisconnected(event: { incarnation: import('./binding-identity.ts').PiIncarnation; connectionId: string }): void {
    this.proofs.delete(event.connectionId)
    const key = incarnationKey(event.incarnation)
    const binding = this.store.listBindings().find(b => this.store.getBindingIdentity(b.runId)?.incarnationKey === key)
    const successor = this.registry.listCurrent().find(agent => agent.available && incarnationKey(agent.incarnation) === key)
    const successorConnection = successor && this.registry.currentBinding(successor.observedSessionId)?.connectionId
    const alreadyProvedSuccessor = successorConnection && successorConnection !== event.connectionId && this.proofs.has(successorConnection)
    if (binding && !alreadyProvedSuccessor && ['ready', 'committed', 'manual_takeover'].includes(binding.state)) {
      const state = binding.state === 'manual_takeover' ? 'manual_takeover_disconnected' : 'disconnected'
      this.owner.commit('adoption_disconnected', { runId: binding.runId }, () => {
        this.store.setBindingState(binding.runId, state, this.now())
        // Lost activity coverage cannot be cleared by an idle reconnect.
        for (const assignment of this.store.listAssignments()) {
          if (assignment.agentRunId !== binding.runId || ['accepted', 'stopped', 'failed'].includes(assignment.state)) continue
          const writer = this.store.getWriter(assignment.projectId)
          if (writer?.state === 'held') this.store.markWriterUncertain(assignment.projectId, this.now())
        }
      })
    }
    const abandoned = this.store.listProposals().filter(p => p.connectionId === event.connectionId && incarnationKey(p.incarnation) === key)
    if (abandoned.length) this.owner.commit('adoption_abandoned', { proposalIds: abandoned.map(p => p.proposalId) },
      () => { for (const p of abandoned) this.store.deleteProposal(p.proposalId) })
  }
  private onRegistered(event: BridgeAdoptionAck): void {
    if (this.proofs.has(event.connectionId)) return
    const identityKey = incarnationKey(event.incarnation)
    const binding = this.store.listBindings().find(b => this.store.getBindingIdentity(b.runId)?.incarnationKey === identityKey)
    if (!binding || !binding.bindingDigest || !this.store.getBindingIdentity(binding.runId)) return
    // Fresh current challenge. A registration is NOT readiness or a receipt.
    event.peer.send(encodeBridgeFrame('recovery_request', bridgeId('frame'), { runId: binding.runId, bindingDigest: binding.bindingDigest,
      processInstanceId: event.incarnation.processInstanceId, piSessionId: event.incarnation.piSessionId,
      extensionInstanceId: event.incarnation.extensionInstanceId, connectionId: event.connectionId, connectionChallenge: event.connectionChallenge }))
  }
  private onRecovery(event: BridgeAdoptionAck): void {
    const { binding, identity } = this.member(event)
    this.proofs.add(event.connectionId)
    if (event.frame.body.pendingInput && !['manual_takeover', 'manual_takeover_disconnected'].includes(binding.state)) this.takeControl(binding.runId)
    if (this.store.getBinding(binding.runId)?.state === 'manual_takeover_disconnected') {
      this.owner.commit('manual_takeover_reconnected', { runId: binding.runId }, () => this.store.setBindingState(binding.runId, 'manual_takeover', this.now()))
    }
    // Lost postcommit delivery is reconciled only after surviving-extension
    // proof, never from registration, PID, saved Pi conversation or a new ID.
    const frame = encodeBridgeFrame('adoption_committed', bridgeId('frame'), { runId: binding.runId, bindingDigest: binding.bindingDigest!,
      processInstanceId: identity.incarnation.processInstanceId, piSessionId: identity.incarnation.piSessionId,
      extensionInstanceId: identity.incarnation.extensionInstanceId, connectionId: event.connectionId,
      connectionChallenge: event.connectionChallenge, goalId: identity.goalId, role: binding.role! })
    event.peer.send(frame)
  }
  private onInput(event: BridgeSourceInput): void {
    const key = incarnationKey(event.incarnation)
    const binding = this.store.listBindings().find(b => this.store.getBindingIdentity(b.runId)?.incarnationKey === key)
    if (!binding || !this.store.getBindingIdentity(binding.runId) || this.owner.runner.fences.isIncarnationFenced(key)) reject('input is not from an unfenced member')
    if (binding.state === 'manual_takeover' || binding.state === 'manual_takeover_disconnected') return
    this.takeControl(binding.runId)
  }
  override takeControl(runId: string): BindingRecord {
    const binding = this.store.getBinding(runId), identity = this.store.getBindingIdentity(runId)
    if (!binding || !identity || this.owner.runner.fences.isFenced(runId)
        || !this.store.listMemberships(identity.goalId).some(m => m.runId === runId)
        || !['ready', 'committed', 'disconnected'].includes(binding.state)) reject('Run is not in managed control')
    this.owner.commit('control_taken', { runId }, () => {
      this.store.setBindingControlEpoch(runId, binding.controlEpoch + 1, this.now())
      this.store.setBindingState(runId, binding.state === 'disconnected' ? 'manual_takeover_disconnected' : 'manual_takeover', this.now())
      this.owner.pauseRunAssignments(runId)
    }, () => this.sendStatus(runId))
    return this.store.getBinding(runId)!
  }
  override forgetRetired(_runId: string): void { /* The independent fence rejects every late frame. */ }
}
