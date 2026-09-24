import { incarnationKey, type PiIncarnation } from './binding-identity.ts'
import { bridgeId, encodeBridgeFrame, type BridgeFrame } from './bridge-protocol.ts'
import type { WorkbenchStore } from './store.ts'
import type { FenceLedger } from './fences.ts'

export const BRIDGE_LEASE_MS = 15_000
export const BRIDGE_HEARTBEAT_MS = 5_000
export interface BridgePeer { send(bytes: Buffer): void; close(): void }
export interface ObservedPi { observedSessionId: string; incarnation: PiIncarnation; lifecycle: string; activity: string; health: string; available: boolean; mode: 'observed' | 'committed' }
export interface BridgeSourceInput { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; sourceSequence: number; eventId: string }
/** Trusted S5 callback, called only on the exact current transport object. */
export interface BridgeAdoptionAck { incarnation: PiIncarnation; observedSessionId: string; connectionId: string; connectionChallenge: string; peer: BridgePeer; frame: BridgeFrame }
type Entry = { key: string; identity: PiIncarnation; peer: BridgePeer | null; connectionId: string; challenge: string; observedId: string; attempt: number; sequence: number; deadline: number; lifecycle: string; activity: string; health: string; mode: 'observed' | 'committed'; dedup: Map<string, string> }
function refuse(code: string): never { throw new Error(code) }
/** One instance belongs to one runner owner, not to a presentation client. */
export class BridgeRegistry {
  private readonly records = new Map<string, Entry>()
  private readonly water = new Map<string, { attempt: number; sequence: number }>()
  private readonly peers = new Map<BridgePeer, Entry>()
  private management: { onAdoptionAck?: (event: BridgeAdoptionAck) => void; onBindingReceipt?: (event: BridgeAdoptionAck) => void; onRecoveryProof?: (event: BridgeAdoptionAck) => void; onRegistered?: (event: BridgeAdoptionAck) => void; onDisconnected?: (event: { incarnation: PiIncarnation; connectionId: string }) => void; onInput?: (event: BridgeSourceInput) => void } | null = null
  /** onInput must commit the takeover marker before returning; otherwise do not supply it. */
  private readonly options: { nodeId: string; store: WorkbenchStore; fences: FenceLedger; now?: () => number; issue?: (prefix: string) => string; onInput?: (event: BridgeSourceInput) => void; onAdoptionAck?: (event: BridgeAdoptionAck) => void }
  constructor(options: { nodeId: string; store: WorkbenchStore; fences: FenceLedger; now?: () => number; issue?: (prefix: string) => string; onInput?: (event: BridgeSourceInput) => void; onAdoptionAck?: (event: BridgeAdoptionAck) => void }) { this.options = options }
  setManagementHandlers(handlers: NonNullable<BridgeRegistry['management']>): void {
    if (this.management) refuse('management_already_bound')
    this.management = handlers
  }
  private now() { return (this.options.now ?? (() => performance.now()))() }
  private issue(prefix: string) { const value = (this.options.issue ?? bridgeId)(prefix); if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) refuse('invalid_identity'); return value }
  private snapshot(entry: Entry): ObservedPi { return { observedSessionId: entry.observedId, incarnation: { ...entry.identity }, lifecycle: entry.lifecycle, activity: entry.activity, health: entry.health, available: entry.peer !== null && this.now() < entry.deadline, mode: entry.mode } }
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
  receive(peer: BridgePeer, frame: BridgeFrame): void {
    if (frame.type === 'register') { this.register(peer, frame); return }
    const entry = this.peers.get(peer)
    if (!entry || entry.peer !== peer || this.now() >= entry.deadline) refuse('connection_not_current')
    if (this.options.fences.isIncarnationFenced(entry.key)) refuse('fence_conflict')
    const body = frame.body
    if (frame.type === 'registered' || frame.type === 'rejected' || frame.type === 'input_received'
        || frame.type === 'adoption_request' || frame.type === 'adoption_committed' || frame.type === 'recovery_request') refuse('invalid_bridge_envelope')
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
    if (frame.type === 'adoption_ack') {
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
    const entry: Entry = { key, identity, peer, connectionId: this.issue('connection'), challenge: this.issue('challenge'), observedId: existing?.observedId ?? this.issue('observed'), attempt, sequence, deadline: this.now() + BRIDGE_LEASE_MS, lifecycle: body.lifecycle as string, activity: body.activity as string, health: body.health as string, mode, dedup: new Map() }
    const response = encodeBridgeFrame('registered', frame.messageId, { observedSessionId: entry.observedId, executionNodeId: this.options.nodeId, connectionId: entry.connectionId, connectionChallenge: entry.challenge, acceptedRegistrationAttempt: attempt, acceptedSourceSequence: sequence, leaseDurationMs: BRIDGE_LEASE_MS, heartbeatIntervalMs: BRIDGE_HEARTBEAT_MS, mode })
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
