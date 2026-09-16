/**
 * Local Workbench v1 Phase 2 — adoption lifecycle.
 *
 * One Run registry, one logical Run per observed Pi. A Run moves through
 * proposed → authorized → acknowledged → committed → ready, and can be
 * disconnected, taken over, retired, replaced or purged. The committed
 * binding digest is frozen at proposal time; authorization, acknowledgement,
 * delivery and readiness all have to name that exact digest, so a late or
 * replayed frame can never advance a different Run.
 *
 * Frames carry identifiers, enums and digests only. Worker, Goal and check
 * text never travels over the transport.
 */

import { workbenchError } from './errors.ts'
import { canonicalJson, sha256 } from './authority.ts'
import type { BindingRecord } from './store.ts'
import type { BindingFence, FenceLedger } from './fences.ts'
import type { WorkbenchFrame, ObserverPort, TransportEvent } from './transport.ts'

export const DEFAULT_PROPOSAL_TTL_MS = 30_000
/** A committed delivery is only accepted while the exact adopt exchange is live. */
export const DEFAULT_ACK_DEADLINE_MS = 5_000
export const MAX_PENDING_INTENTS = 16

export interface AdoptionHost {
  readonly executionNodeId: string
  readonly sessionId: string
  revisionOf(): number
  clock(): number
  newId(prefix: string): string
  commit(kind: string, payload: Record<string, unknown>, mutate: () => void): number
  readonly runner: {
    store: {
      putBinding(binding: BindingRecord): void
      getBinding(runId: string): BindingRecord | null
      listBindings(): BindingRecord[]
      setBindingState(runId: string, state: BindingRecord['state'], updatedAt: number): void
      setBindingControlEpoch(runId: string, controlEpoch: number, updatedAt: number): void
      setMeta(key: string, value: string): void
    }
    fences: Pick<FenceLedger, 'highWater' | 'isFenced' | 'getFence' | 'assertVacancyGeneration'>
    retireBinding(input: { runId: string; projectId: string; role: string | null; bindingDigest: string | null }): BindingFence
    purgeBinding(runId: string): BindingFence | null
  }
}

export interface ProposalInput {
  projectId: string
  goalId: string | null
  role: string
  observedSessionId: string
  predecessorRunId?: string | null
}

export interface Proposal {
  proposalId: string
  runId: string
  observedSessionId: string
  projectId: string
  goalId: string | null
  executionNodeId: string
  role: string
  predecessorRunId: string | null
  vacancyGeneration: number
  transportId: string
  nonce: string
  proposalDigest: string
  expiresAt: number
  stage: 'proposed' | 'authorized' | 'awaiting_ack' | 'committed' | 'ready' | 'failed' | 'expired'
}

interface PendingAck {
  runId: string
  bindingDigest: string
  nonce: string
  deadline: number
}

export class AdoptionManager {
  private readonly host: AdoptionHost
  private readonly transport: () => ObserverPort | null
  private readonly ackDeadlineMs: number
  private proposals = new Map<string, Proposal>()
  private pending = new Map<string, PendingAck>()
  private expired: string[] = []
  private transportId: string | null = null
  private unsubscribe: (() => void) | null = null
  /** Object identity is local subscription ownership, not Pi attestation. */
  private connection: { port: ObserverPort } | null = null
  private exchanges = new Map<string, { port: ObserverPort }>()

  constructor(host: AdoptionHost, transport: () => ObserverPort | null, ackDeadlineMs = DEFAULT_ACK_DEADLINE_MS) {
    this.host = host
    this.transport = transport
    this.ackDeadlineMs = ackDeadlineMs
  }

  bind(): void {
    const port = this.transport()
    if (port !== null && this.connection?.port === port && this.unsubscribe !== null) return
    this.unbind()
    if (port === null) return
    const connection = { port }
    this.connection = connection
    this.transportId = port.transportId
    try {
      const unsubscribe = port.subscribe(event => {
        if (this.connection !== connection || this.transport() !== port) return
        this.onTransportEvent(event)
      })
      if (this.connection === connection) this.unsubscribe = unsubscribe
      else unsubscribe() // A synchronous disconnect during subscribe is final.
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null
        this.transportId = null
      }
      throw error
    }
  }

  unbind(): void {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    this.connection = null
    this.transportId = null
    unsubscribe?.()
  }

  /** Roll back transient state of commands that perform no external send.
   * This does not authorize rolling back a delivered frame or a connection.
   */
  checkpointCommandState(): () => void {
    const proposals = new Map([...this.proposals].map(([id, value]) => [id, { ...value }]))
    const pending = new Map([...this.pending].map(([id, value]) => [id, { ...value }]))
    const expired = [...this.expired]
    const exchanges = new Map(this.exchanges)
    return () => {
      this.proposals = proposals
      this.pending = pending
      this.expired = expired
      this.exchanges = exchanges
    }
  }

  /** Recover retained membership: an acknowledged proposal keeps its digest. */
  retainedProposals(): Proposal[] {
    return [...this.proposals.values()].filter(proposal => proposal.stage !== 'failed' && proposal.stage !== 'expired').map(proposal => ({ ...proposal }))
  }

  propose(input: ProposalInput): Proposal {
    const port = this.transport()
    if (port === null || this.connection?.port !== port) {
      throw workbenchError('handler_unavailable', 'no observer transport is connected', 'connect the workbench to the local Pi extension before proposing an adoption')
    }
    const role = String(input.role)
    const generation = this.generation(input.projectId, role)
    // The vacancy generation must strictly exceed the retained high-water mark.
    // The ledger is the authority; a stale in-memory read never proposes a
    // superseded generation.
    this.host.runner.fences.assertVacancyGeneration(input.projectId, role, generation)
    const runId = this.host.newId('run-')
    const proposalId = this.host.newId('adopt-')
    const nonce = this.host.newId('nonce-')
    const identity = {
      proposalId,
      runId,
      observedSessionId: String(input.observedSessionId),
      projectId: String(input.projectId),
      goalId: input.goalId === null || input.goalId === undefined ? null : String(input.goalId),
      executionNodeId: this.host.executionNodeId,
      role,
      predecessorRunId: input.predecessorRunId ?? null,
      vacancyGeneration: generation,
    }
    const expiresAt = this.host.clock() + DEFAULT_PROPOSAL_TTL_MS
    const proposalDigest = sha256({ ...identity, transportId: port.transportId, nonce, expiresAt })
    const proposal: Proposal = { ...identity, transportId: port.transportId, nonce, proposalDigest, expiresAt, stage: 'proposed' }
    const binding: BindingRecord = {
      runId,
      projectId: identity.projectId,
      role,
      state: 'proposed',
      bindingDigest: proposalDigest,
      controlEpoch: 0,
      writerState: 'none',
      predecessorRunId: identity.predecessorRunId,
      generation,
      updatedAt: this.host.clock(),
    }
    this.host.commit('adoption_proposed', { runId, proposalId, projectId: identity.projectId, generation }, () => {
      this.host.runner.store.putBinding(binding)
    })
    this.proposals.set(proposalId, proposal)
    this.exchanges.set(runId, this.connection!)
    return { ...proposal }
  }

  /** Authorization freezes the proposal and asks the exact transport to adopt. */
  authorize(proposalId: string): Proposal {
    const proposal = this.proposals.get(proposalId)
    if (proposal === undefined) {
      throw workbenchError('missing_resource', `no adoption proposal ${proposalId}`, 'observe the Pi again and propose a fresh adoption')
    }
    if (this.host.clock() >= proposal.expiresAt) {
      proposal.stage = 'expired'
      this.proposals.delete(proposalId)
      throw workbenchError('invalid_input', `proposal ${proposalId} expired`, 'observe the Pi again and propose a fresh adoption')
    }
    if (proposal.stage !== 'proposed') {
      throw workbenchError('invalid_input', `proposal ${proposalId} is already ${proposal.stage}`, 'reload the projection before re-authorizing')
    }
    const port = this.transport()
    if (port === null || this.connection?.port !== port || this.exchanges.get(proposal.runId) !== this.connection || port.transportId !== proposal.transportId) {
      throw workbenchError('handler_unavailable', 'the transport that observed this Pi is no longer connected', 'reconnect the observer transport and observe the Pi again')
    }
    const binding = this.assertLive(proposal.runId)
    if (binding.state !== 'proposed') {
      throw workbenchError('invalid_input', `Run ${proposal.runId} is already ${binding.state}`, 'reload the projection before re-authorizing')
    }
    if (binding.bindingDigest !== proposal.proposalDigest) {
      throw workbenchError('fence_conflict', `binding digest for ${proposal.runId} changed`, 'stop and inspect the retained ledger; a frozen proposal digest is never re-derived')
    }
    this.host.commit('adoption_authorized', { runId: proposal.runId, proposalId }, () => {
      this.host.runner.store.setBindingState(proposal.runId, 'authorized', this.host.clock())
    })
    proposal.stage = 'authorized'
    this.pending.set(proposal.runId, { runId: proposal.runId, bindingDigest: proposal.proposalDigest, nonce: proposal.nonce, deadline: Math.min(proposal.expiresAt, this.host.clock() + this.ackDeadlineMs) })
    this.send({
      frameId: this.host.newId('frame-'),
      kind: 'adopt',
      runId: proposal.runId,
      bindingDigest: proposal.proposalDigest,
      nonce: proposal.nonce,
      payload: { executionNodeId: proposal.executionNodeId, vacancyGeneration: proposal.vacancyGeneration, predecessorRunId: proposal.predecessorRunId },
    })
    return { ...proposal }
  }

  /** Drop expired adopt exchanges. Called before any inbound frame is applied. */
  sweepExpired(): number {
    const now = this.host.clock()
    let dropped = 0
    for (const [runId, pending] of this.pending) {
      if (now >= pending.deadline) {
        this.pending.delete(runId)
        const proposal = this.proposalForRun(runId)
        if (proposal) proposal.stage = 'expired'
        this.expired.push(runId)
        if (this.expired.length > MAX_PENDING_INTENTS) this.expired.shift()
        dropped += 1
      }
    }
    return dropped
  }

  onTransportEvent(event: TransportEvent): void {
    const connection = this.connection
    if (!connection || this.transport() !== connection.port || event.transportId !== this.transportId) {
      throw workbenchError('fence_conflict', 'event is not from the current observer connection', 'use the exact current connection; a matching label is not recovery proof')
    }
    if (event.type === 'adopt_ack' || event.type === 'readiness' || event.type === 'input_observed') {
      if (this.exchanges.get(event.runId) !== connection) throw workbenchError('fence_conflict', 'event has no current connection-bound exchange', 'fresh challenged recovery is required; never transfer an old exchange to a replacement connection')
    }
    this.sweepExpired()
    switch (event.type) {
      case 'adopt_ack': {
        const proposal = this.proposalForRun(event.runId)
        if (!proposal || proposal.proposalDigest !== event.bindingDigest || proposal.nonce !== event.nonce) {
          throw workbenchError('fence_conflict', 'acknowledgement nonce or digest differs from the frozen proposal', 'acknowledge the exact current exchange')
        }
        if (proposal.stage === 'expired' || proposal.stage === 'failed') throw workbenchError('invalid_input', 'adopt exchange expired or failed', 'request a fresh explicit Adoption')
        const pending = this.pending.get(event.runId)
        if (pending === undefined) {
          // An acknowledgement naming an exchange that timed out is refused: a
          // late delivery never binds silently.
          const expiredIndex = this.expired.indexOf(event.runId)
          if (expiredIndex >= 0) {
            this.expired.splice(expiredIndex, 1)
            throw workbenchError('invalid_input', `the adopt exchange for ${event.runId} expired`, 'observe the Pi again and propose a fresh adoption')
          }
          // A repeated acknowledgement from the same incarnation is stable: the
          // Run already advanced, so no mutation and no second commitment.
          this.stableDuplicateAck(event.runId, event.bindingDigest)
          return
        }
        if (pending.bindingDigest !== event.bindingDigest || pending.nonce !== event.nonce || pending.runId !== event.runId) {
          throw workbenchError('fence_conflict', `adopt acknowledgement for ${event.runId} does not match the frozen digest`, 'stop and inspect the retained ledger; never rebind a mismatched acknowledgement')
        }
        const binding = this.assertLive(event.runId)
        if (binding.state !== 'authorized') {
          // Already acknowledged or beyond: keep the earlier outcome, never
          // commit twice for one exchange.
          this.pending.delete(event.runId)
          return
        }
        this.host.commit('adoption_acknowledged', { runId: event.runId }, () => {
          this.host.runner.store.setBindingState(event.runId, 'acknowledged', this.host.clock())
        })
        proposal.stage = 'awaiting_ack'
        this.commitRun(event.runId)
        return
      }
      case 'readiness': {
        const binding = this.host.runner.store.getBinding(event.runId)
        if (binding === null) return
        this.assertLive(event.runId)
        if (binding.state !== 'committed' && binding.state !== 'ready') return
        if (binding.bindingDigest !== event.bindingDigest) {
          throw workbenchError('fence_conflict', `readiness for ${event.runId} names a different digest`, 'stop and inspect the retained ledger')
        }
        if (binding.state === 'ready') return
        this.host.commit('adoption_ready', { runId: event.runId }, () => {
          this.host.runner.store.setBindingState(event.runId, 'ready', this.host.clock())
        })
        const proposal = this.proposalForRun(event.runId)
        if (proposal) proposal.stage = 'ready'
        this.pending.delete(event.runId)
        return
      }
      case 'input_observed': {
        if (event.source === 'extension') return
        // Interactive operator input revokes readiness and takes control. A
        // retired or purged Run is never revived by a late frame.
        const binding = this.assertLive(event.runId)
        if (binding.state === 'proposed' || binding.state === 'authorized' || binding.state === 'acknowledged') {
          const proposal = this.proposalForRun(event.runId)
          if (proposal) proposal.stage = 'failed'
          this.pending.delete(event.runId)
          return // Ordinary input cannot create managed control authority.
        }
        this.host.commit('control_taken', { runId: event.runId, source: event.source }, () => {
          this.host.runner.store.setBindingControlEpoch(event.runId, binding.controlEpoch + 1, this.host.clock())
          this.host.runner.store.setBindingState(event.runId,
            binding.state === 'disconnected' || binding.state === 'manual_takeover_disconnected' ? 'manual_takeover_disconnected' : 'manual_takeover', this.host.clock())
        })
        this.pending.delete(event.runId)
        return
      }
      case 'disconnected': {
        // A transport disconnect drops the connection, never the membership or
        // its occupancy. The Run stays occupied until an explicit retirement.
        for (const binding of this.host.runner.store.listBindings()) {
          if (this.exchanges.get(binding.runId) !== connection) continue
          if (binding.state === 'manual_takeover') {
            this.host.commit('adoption_disconnected', { runId: binding.runId }, () => {
              this.host.runner.store.setBindingState(binding.runId, 'manual_takeover_disconnected', this.host.clock())
            })
          }
          if (binding.state === 'ready' || binding.state === 'committed' || binding.state === 'acknowledged') {
            this.host.commit('adoption_disconnected', { runId: binding.runId }, () => {
              this.host.runner.store.setBindingState(binding.runId, 'disconnected', this.host.clock())
            })
          }
        }
        this.pending.clear()
        this.expired = []
        this.unbind()
        return
      }
      case 'protocol_error':
        return
      default:
        return
    }
  }

  private stableDuplicateAck(runId: string, bindingDigest: string): void {
    this.assertLive(runId)
    const binding = this.host.runner.store.getBinding(runId)
    if (binding === null || binding.bindingDigest !== bindingDigest) return
    if (binding.state === 'acknowledged' || binding.state === 'committed' || binding.state === 'ready'
        || binding.state === 'manual_takeover' || binding.state === 'disconnected') return
    // Otherwise the acknowledgement names an exchange this manager no longer
    // holds; accepting it would advance a different Run, so it is ignored.
  }

  private commitRun(runId: string): void {
    const proposal = this.proposalForRun(runId)
    const pending = this.pending.get(runId)
    if (!proposal || !pending || this.host.clock() >= pending.deadline || this.host.clock() >= proposal.expiresAt) {
      throw workbenchError('invalid_input', 'adopt exchange expired before commit', 'request a fresh explicit Adoption')
    }
    if (!this.connection || this.exchanges.get(runId) !== this.connection || this.transport() !== this.connection.port) {
      throw workbenchError('fence_conflict', 'observer connection changed before commit', 'request a fresh connection-bound exchange')
    }
    const binding = this.assertLive(runId)
    if (binding.state !== 'acknowledged' || binding.bindingDigest !== proposal.proposalDigest
        || binding.projectId !== proposal.projectId || binding.role !== proposal.role
        || binding.generation !== proposal.vacancyGeneration || binding.predecessorRunId !== proposal.predecessorRunId) {
      throw workbenchError('fence_conflict', 'binding changed from the frozen proposal before commit', 'refuse the exchange; never rederive an authorized binding')
    }
    if (binding.projectId === null || binding.generation === null) {
      throw workbenchError('fence_conflict', `Run ${runId} has no retained vacancy identity`, 're-observe the Pi and propose a fresh adoption')
    }
    // Recheck the retained vacancy generation at the exact commit boundary.
    this.host.runner.fences.assertVacancyGeneration(binding.projectId, binding.role, binding.generation)
    // Occupancy survives disconnection and takeover: a role member blocks a new
    // occupant until it is explicitly retired.
    const occupant = this.host.runner.store.listBindings().find(other =>
      other.runId !== runId && other.projectId === binding.projectId && other.role === binding.role
      && other.state !== 'retired' && other.state !== 'purged')
    if (occupant) {
      this.host.commit('adoption_failed', { runId, reason: 'vacancy_occupied' }, () => {
        this.host.runner.store.setBindingState(runId, 'disconnected', this.host.clock())
      })
      throw workbenchError('invalid_input', `role ${String(binding.role)} is already occupied by ${occupant.runId} in this Project`, 'retire or take control of the current Run before adopting another')
    }
    this.host.commit('adoption_committed', { runId, controlEpoch: binding.controlEpoch + 1 }, () => {
      this.host.runner.store.setBindingControlEpoch(runId, binding.controlEpoch + 1, this.host.clock())
      this.host.runner.store.setBindingState(runId, 'committed', this.host.clock())
    })
    proposal.stage = 'committed'
    this.pending.delete(runId)
    this.send({
      frameId: this.host.newId('frame-'),
      kind: 'committed',
      runId,
      bindingDigest: binding.bindingDigest,
      nonce: proposal?.nonce ?? null,
      payload: { projectId: binding.projectId, role: binding.role, generation: binding.generation },
    })
  }

  /**
   * Explicit operator takeover. Revokes readiness and records the control
   * epoch bump; the Run is never silently demoted by an extension frame.
   */
  takeControl(runId: string): BindingRecord {
    const binding = this.assertLive(runId)
    if (['proposed', 'authorized', 'acknowledged'].includes(binding.state)) {
      throw workbenchError('invalid_input', 'ordinary Pi cannot acquire managed control before Adoption commits', 'finish exact Adoption first; observation and proposals grant no control authority')
    }
    this.host.commit('control_taken', { runId, source: 'operator' }, () => {
      this.host.runner.store.setBindingControlEpoch(runId, binding.controlEpoch + 1, this.host.clock())
      this.host.runner.store.setBindingState(runId,
        binding.state === 'disconnected' || binding.state === 'manual_takeover_disconnected' ? 'manual_takeover_disconnected' : 'manual_takeover', this.host.clock())
    })
    this.pending.delete(runId)
    return this.requireBinding(runId)
  }

  retire(runId: string): BindingFence {
    const binding = this.requireBinding(runId)
    if (this.host.runner.fences.isFenced(runId)) {
      // Idempotent: the fence already wins, so never re-record it.
      return this.host.runner.fences.getFence(runId)!
    }
    if (binding.state !== 'disconnected' && binding.state !== 'manual_takeover_disconnected') {
      throw workbenchError('invalid_input', `Run ${runId} is ${binding.state} and cannot be retired`, 'wait for the exact Run to disconnect before confirming retirement; Take control does not disconnect Pi')
    }
    const fence = this.host.runner.retireBinding({ runId, projectId: binding.projectId ?? '', role: binding.role, bindingDigest: binding.bindingDigest })
    const proposal = this.proposalForRun(runId)
    if (proposal) this.proposals.delete(proposal.proposalId)
    this.pending.delete(runId)
    this.send({ frameId: this.host.newId('frame-'), kind: 'release', runId, bindingDigest: fence.bindingDigest, nonce: null, payload: { generation: fence.generation } })
    return fence
  }

  purge(runId: string): BindingFence | null {
    const fence = this.host.runner.purgeBinding(runId)
    if (fence === null) return null
    this.send({ frameId: this.host.newId('frame-'), kind: 'purge_notice', runId, bindingDigest: fence.bindingDigest, nonce: null, payload: { generation: fence.generation } })
    return fence
  }

  /** Post-commit local cleanup only. No send can invalidate a durable receipt. */
  forgetRetired(runId: string): void {
    if (!this.host.runner.fences.isFenced(runId)) throw workbenchError('fence_missing', 'cannot forget an unfenced Run', 'complete retirement first')
    const proposal = this.proposalForRun(runId)
    if (proposal) this.proposals.delete(proposal.proposalId)
    this.pending.delete(runId)
    this.exchanges.delete(runId)
  }

  generation(projectId: string, role: string): number {
    return this.host.runner.fences.highWater(projectId, role) + 1
  }

  private send(frame: WorkbenchFrame): void {
    const connection = this.connection
    if (!connection || this.transport() !== connection.port || (frame.runId !== null && this.exchanges.get(frame.runId) !== connection)) {
      if (frame.kind === 'adopt' || frame.kind === 'committed') throw workbenchError('handler_unavailable', 'the exact exchange connection is unavailable for delivery', 'retain the durable state; do not deliver to another connection')
      return
    }
    connection.port.send(frame)
  }

  private requireBinding(runId: string): BindingRecord {
    const binding = this.host.runner.store.getBinding(runId)
    if (binding === null) {
      throw workbenchError('missing_resource', `no Run ${runId}`, 'reload the committed projection; bindings come from the durable store')
    }
    return binding
  }

  /**
   * Read the Run and refuse any management of a fenced or terminal binding.
   * The independently retained fence wins over every inbound frame: a late
   * acknowledgement, readiness or input event can never revive a retired or
   * purged Run.
   */
  private assertLive(runId: string): BindingRecord {
    if (this.host.runner.fences.isFenced(runId)) {
      throw workbenchError('fence_conflict', `Run ${runId} has a retained retirement fence`, 'observe the Pi again and propose a fresh adoption; a retired or purged Run is never revived')
    }
    const binding = this.requireBinding(runId)
    if (binding.state === 'retired' || binding.state === 'purged') {
      throw workbenchError('fence_conflict', `Run ${runId} is ${binding.state}`, 'observe the Pi again and propose a fresh adoption; a retired or purged Run is never revived')
    }
    return binding
  }

  private proposalForRun(runId: string): Proposal | undefined {
    return [...this.proposals.values()].find(proposal => proposal.runId === runId)
  }

  describe(): { transportId: string | null; proposals: number; pending: number } {
    return { transportId: this.transportId, proposals: this.proposals.size, pending: this.pending.size }
  }

  proposalOf(proposalId: string): Proposal | null {
    const proposal = this.proposals.get(proposalId)
    return proposal ? { ...proposal } : null
  }
}

export function proposalSummary(proposal: Proposal): Record<string, string | number | null> {
  return {
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    role: proposal.role,
    generation: proposal.vacancyGeneration,
    stage: proposal.stage,
    digest: proposal.proposalDigest,
  }
}

export function proposalDigestOf(proposal: Proposal): string {
  return sha256(canonicalJson({
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    observedSessionId: proposal.observedSessionId,
  }))
}
