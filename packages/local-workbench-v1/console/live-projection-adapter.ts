/**
 * Local Workbench v1 — Phase 1 injected presentation adapter.
 *
 * Owns session/revision/cursor handling, intent emission, feedback lifecycle,
 * draft preservation, and confirmation invalidation. The source and sinks are
 * injected so automation uses only in-memory fakes. QML renders plain values
 * and emits intents; this adapter never manufactures durable revisions,
 * cursors, readiness, or writer admission.
 *
 * Feedback lifecycle (contract C4 / T7):
 *   submitted -> acknowledged | rejected | unknown | stale | expired
 * `acknowledged` means the runner committed that intent, not that Pi delivery
 * or cancellation succeeded. ACK deadline 5 seconds gives `unknown`, not
 * retry success. Authority confirmations expire after 30 seconds and are
 * invalidated by session/generation/epoch/target identity or relevant
 * revision changes. Form drafts survive ordinary projection updates and are
 * keyed by target; they are never an active confirmation.
 */

import {
  assertEnvelopeBytes,
  validateFeedback,
  validateIntent,
  validateSnapshot,
  type WorkbenchFeedback,
  type WorkbenchHandoff,
  type WorkbenchIntent,
  type WorkbenchSnapshot,
} from './schema.ts'
import { WorkbenchProjection } from './projection-core.ts'

export const INTENT_KINDS = [
  'select_project',
  'select_goal',
  'create_goal',
  'inspect_project',
  'confirm_register_project',
  'create_check',
  'request_adoption',
  'authorize_adoption',
  'start_assignment',
  'configure_checks',
  'take_control',
  'return_to_team',
  'accept',
  'resume',
  'retry',
  'retire',
  'purge',
  'stop',
  'recover',
  'present',
] as const
export type IntentKind = (typeof INTENT_KINDS)[number]

export const DEFAULT_STALE_AFTER_MS = 2000
export const DEFAULT_ACK_DEADLINE_MS = 5000
export const DEFAULT_CONFIRMATION_TTL_MS = 30000
export const MAX_PENDING_INTENTS = 16

export interface WorkbenchSourceHandler {
  onSnapshot(snapshot: unknown): void
  onEvent(event: unknown): void
  onClose(error: Error | null): void
  /** A known result is staged until a subsequent snapshot is displayed. */
  onOutcome?(feedback: unknown): void
}

export interface WorkbenchChannel {
  send(type: string, body: Record<string, unknown>): void
  close(): void
}

export interface WorkbenchSource {
  connect(handler: WorkbenchSourceHandler): Promise<WorkbenchChannel>
}

export type WorkbenchSink = (handoff: WorkbenchHandoff) => void
export type WorkbenchIntentSink = (intent: WorkbenchIntent) => void

export interface PendingIntent {
  intent: WorkbenchIntent
  status: 'submitted' | 'acknowledged' | 'rejected' | 'unknown' | 'stale' | 'expired'
  reasonCode: string | null
  committedRevision: number | null
  submittedAt: number
}

export interface WorkbenchAdapterOptions {
  source: WorkbenchSource
  sink: WorkbenchSink
  intentSink: WorkbenchIntentSink
  projection?: WorkbenchProjection
  onFeedback?: (feedback: WorkbenchFeedback) => void
  clock?: () => number
  staleAfterMs?: number
  ackDeadlineMs?: number
  confirmationTtlMs?: number
}

export class WorkbenchAdapter {
  readonly projection: WorkbenchProjection

  private readonly source: WorkbenchSource
  private readonly sink: WorkbenchSink
  private readonly intentSink: WorkbenchIntentSink
  private readonly onFeedback: ((feedback: WorkbenchFeedback) => void) | null
  private readonly clock: () => number
  private readonly staleAfterMs: number
  private readonly ackDeadlineMs: number
  private readonly confirmationTtlMs: number
  private channel: WorkbenchChannel | null = null
  private started = false
  private stopped = false
  private intentCounter = 0
  private readonly intentNamespace = crypto.randomUUID()
  private lastAuthoritativeAt: number
  private pending = new Map<string, PendingIntent>()
  private drafts = new Map<string, string>()
  private lastSessionId: string | null = null
  private lastRunnerEpoch: number | null = null
  private lastRevision: number | null = null
  private lastIdentity: string | null = null
  private stagedOutcomes = new Map<string, WorkbenchFeedback>()
  private publishedSnapshot: WorkbenchSnapshot | null = null
  private connectionAttempt = 0

  constructor(options: WorkbenchAdapterOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('WorkbenchAdapter options are required')
    }
    this.source = requirePort(options.source, 'source')
    this.sink = requirePort(options.sink, 'sink')
    this.intentSink = requirePort(options.intentSink, 'intentSink')
    this.projection = options.projection ?? new WorkbenchProjection()
    this.onFeedback = options.onFeedback ?? null
    this.clock = options.clock ?? (() => performance.now())
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    this.ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS
    this.lastAuthoritativeAt = this.clock()
  }

  get handoff(): WorkbenchHandoff | null {
    return this.projection.handoff
  }

  get pendingIntents(): PendingIntent[] {
    return [...this.pending.values()]
  }

  get isStale(): boolean {
    return this.clock() - this.lastAuthoritativeAt > this.staleAfterMs
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('workbench adapter already started')
    if (this.stopped) throw new Error('a stopped workbench adapter cannot restart')
    this.started = true
    const attempt = ++this.connectionAttempt
    const current = () => !this.stopped && this.connectionAttempt === attempt
    try {
      const channel = await this.source.connect({
        onSnapshot: snapshot => { if (current()) this.applySnapshot(snapshot) },
        onEvent: event => { if (current()) this.applyEvent(event) },
        onOutcome: feedback => { if (current()) this.prepareFeedback(feedback) },
        onClose: error => { if (current()) this.closed(error) },
      })
      if (!current()) channel.close()
      else {
        this.channel = channel
        this.queryOutcomes()
      }
    } catch (error) {
      if (this.connectionAttempt === attempt) {
        const channel = this.channel
        this.channel = null
        this.started = false
        this.connectionAttempt++
        this.publishedSnapshot = null
        try { channel?.close() } catch { /* preserve the connection/publication failure */ }
        if (this.projection.handoff) {
          this.projection.markGap('presentation connection failed')
          try { this.publish() } catch { /* original failure remains authoritative */ }
        }
      }
      throw error
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.connectionAttempt++
    this.channel?.close()
    this.channel = null
  }

  /** Apply a validated authoritative snapshot (initialize, replace, or recover). */
  applySnapshot(input: unknown): WorkbenchHandoff {
    let value: WorkbenchSnapshot
    try { value = validateSnapshot(input) } catch (error) {
      if (this.projection.handoff) { this.projection.markGap('invalid authoritative snapshot'); this.publish() }
      throw error
    }
    const hadBaseline = this.projection.handoff !== null
    const inGap = hadBaseline && this.projection.handoff!.connection === 'gap'
    const handoff = !hadBaseline
      ? this.projection.initialize(input)
      : inGap
        ? this.projection.recover(input)
        : this.projection.replace(input)
    this.lastAuthoritativeAt = this.clock()
    this.onIdentityChange(value)
    this.publish()
    for (const feedback of [...this.stagedOutcomes.values()]) {
      if (feedback.committedRevision === null || feedback.committedRevision <= value.revision) this.applyFeedback(feedback)
    }
    return handoff
  }

  /** Apply one ordered event. */
  applyEvent(input: unknown): WorkbenchHandoff {
    try {
      const handoff = this.projection.acceptEvent(input)
      this.lastAuthoritativeAt = this.clock()
      this.onIdentityChange(handoff.snapshot)
      this.publish()
      return handoff
    } catch (error) {
      this.publish()
      throw error
    }
  }

  /**
   * Emit a confirmed user intent. Captures the exact current target/session/
   * revision and assigns an opaque intentId. Bounded pending queue.
   */
  emitIntent(kind: IntentKind, target: string | null, payload: Record<string, unknown>): WorkbenchIntent {
    if (this.stopped) throw new Error('a stopped workbench adapter cannot emit intents')
    const handoff = this.projection.handoff
    if (handoff === null) throw new Error('an authoritative snapshot is required before emitting intents')
    if (handoff.connection !== 'connected' || this.isStale) {
      throw new Error('intents require a non-gap authoritative connection')
    }
    if (!(INTENT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`unsupported intent kind ${kind}`)
    }
    for (const [id, entry] of this.pending) {
      if (this.pending.size >= MAX_PENDING_INTENTS && !['submitted', 'unknown'].includes(entry.status)) this.pending.delete(id)
    }
    if (this.pending.size >= MAX_PENDING_INTENTS) {
      for (const [id, pending] of this.pending) {
        if (['acknowledged', 'rejected', 'expired'].includes(pending.status)) {
          this.pending.delete(id)
          this.stagedOutcomes.delete(id)
          break
        }
      }
      if (this.pending.size >= MAX_PENDING_INTENTS) throw new Error(`pending intent queue is full (${MAX_PENDING_INTENTS})`)
    }
    const snapshot = handoff.snapshot
    // Phase 2 enables authorize_adoption on the real path; the authoritative
    // projection still gates it, so only an adoptable Proposal can be
    // authorized. Work execution stays Phase 3.
    if (kind === 'start_assignment') throw new Error('runtime action unavailable in Phase 2: Assignment delivery is Phase 3')
    if (!['select_project', 'select_goal'].includes(kind)) {
      const actions = [
        ...snapshot.actions,
        ...snapshot.goals.flatMap(goal => goal.actions),
        ...snapshot.managedAgents.flatMap(card => card.actions),
      ]
      const observedChoice = kind === 'request_adoption' && snapshot.observedSessions.some(card => card.choices.some(choice => choice.choiceId === target && choice.enabled))
      const purgeLeaf = kind === 'purge' && snapshot.retiredRuns.some(card => card.agentRunId === target && card.canPurge)
      if (!observedChoice && !purgeLeaf && !actions.some(action => action.kind === kind && action.target === target && action.enabled)) throw new Error('action unavailable in authoritative projection')
    }
    const intentId = `wb-${this.intentNamespace}-${++this.intentCounter}`
    const intent: WorkbenchIntent = {
      protocol: 'omarchestra.workbench/v1',
      sessionId: snapshot.sessionId,
      pluginGeneration: snapshot.pluginGeneration,
      runnerEpoch: snapshot.runnerEpoch,
      intentId,
      expectedRevision: handoff.revision,
      kind,
      target,
      payload: payload ?? {},
    }
    const validated = validateIntent(intent)
    if (kind === 'create_goal' || kind === 'create_check' || kind === 'configure_checks') {
      const projectId = validated.payload.projectId
      if (projectId !== snapshot.selectedProjectId || !snapshot.projects.some(project => project.projectId === projectId)) throw new Error('action requires the selected Project')
      if (kind === 'create_goal' && (target !== null || !(validated.payload.goalText as string).trim())) throw new Error('invalid Goal creation context')
      if (kind === 'configure_checks' && (target !== validated.payload.checkId || !snapshot.checks.some(check => check.checkId === target && check.version === validated.payload.checkVersion))) throw new Error('check version is no longer current')
      if (kind === 'create_check' || kind === 'configure_checks') {
        const project = snapshot.projects.find(candidate => candidate.projectId === projectId)
        const cwd = (validated.payload.definitionDraft as { cwd: string }).cwd
        if (!project || cwd !== project.canonicalPath) throw new Error('check working directory must equal the confirmed Project root')
      }
    }
    if (kind === 'confirm_register_project') {
      const registration = snapshot.details?.find(detail => detail.kind === 'registration' && (detail as { registrationId?: string }).registrationId === target)
      if (!registration || !(registration as { supported?: boolean }).supported) throw new Error('no supported inspection matches this confirmation')
    }
    assertEnvelopeBytes(JSON.stringify(validated), 'intent')
    this.pending.set(intentId, {
      intent: validated,
      status: 'submitted',
      reasonCode: null,
      committedRevision: null,
      submittedAt: this.clock(),
    })
    // The view learns that the intent is in flight before the sink runs: a
    // synchronous in-process runner may answer within `intentSink`, and the
    // committed outcome must be the last feedback the view sees.
    this.onFeedback?.({
      intentId,
      sessionId: validated.sessionId,
      target,
      originRevision: handoff.revision,
      status: 'submitted',
      reasonCode: null,
      committedRevision: null,
    })
    this.intentSink(validated)
    return validated
  }

  /** Stage a receipt without showing success or executing anything. */
  prepareFeedback(input: unknown): void {
    const feedback = validateFeedback(input)
    if (!['acknowledged', 'rejected', 'stale', 'unknown'].includes(feedback.status)) throw new Error('invalid runner outcome status')
    const pending = this.pending.get(feedback.intentId)
    if (!pending || feedback.sessionId !== pending.intent.sessionId || feedback.target !== pending.intent.target
        || feedback.originRevision !== pending.intent.expectedRevision) throw new Error('outcome does not match the original intent')
    const current = this.projection.handoff?.snapshot
    if (!current || current.sessionId !== pending.intent.sessionId || current.pluginGeneration !== pending.intent.pluginGeneration
        || current.runnerEpoch !== pending.intent.runnerEpoch || pending.status === 'expired') throw new Error('outcome identity is obsolete')
    this.stagedOutcomes.set(feedback.intentId, feedback)
  }

  /** Apply a runner feedback for a previously emitted intent. */
  applyFeedback(input: unknown): WorkbenchFeedback {
    const feedback = validateFeedback(input)
    const pending = this.pending.get(feedback.intentId)
    if (pending === undefined) {
      throw new Error(`feedback for unknown intent ${feedback.intentId}`)
    }
    if (feedback.sessionId !== pending.intent.sessionId) {
      throw new Error('feedback session does not match the intent session')
    }
    if (feedback.target !== pending.intent.target) {
      throw new Error('feedback target does not match the intent target')
    }
    if (feedback.originRevision !== pending.intent.expectedRevision) {
      throw new Error('feedback origin revision does not match the intent revision')
    }
    const current = this.projection.handoff?.snapshot
    const staged = this.stagedOutcomes.get(feedback.intentId)
    const resolving = staged !== undefined && staged.status === feedback.status && staged.reasonCode === feedback.reasonCode && staged.committedRevision === feedback.committedRevision
    if (!current || (pending.status === 'stale' && !resolving) || pending.status === 'expired'
        || current.sessionId !== pending.intent.sessionId
        || current.pluginGeneration !== pending.intent.pluginGeneration
        || current.runnerEpoch !== pending.intent.runnerEpoch) throw new Error('feedback identity is obsolete')
    if (feedback.status === 'acknowledged' && (this.isStale || this.projection.handoff?.connection !== 'connected'
        || !this.publishedSnapshot || this.publishedSnapshot.sessionId !== current.sessionId
        || this.publishedSnapshot.pluginGeneration !== current.pluginGeneration || this.publishedSnapshot.runnerEpoch !== current.runnerEpoch
        || (feedback.committedRevision !== null && this.publishedSnapshot.revision < feedback.committedRevision))) throw new Error('committed snapshot has not been displayed')
    if (!['submitted', 'unknown'].includes(pending.status) && !(resolving && pending.status === 'stale')) {
      if (pending.status !== feedback.status || pending.reasonCode !== feedback.reasonCode || pending.committedRevision !== feedback.committedRevision) throw new Error('terminal feedback cannot change outcome')
      this.stagedOutcomes.delete(feedback.intentId)
      return feedback
    }
    this.onFeedback?.(feedback)
    pending.status = feedback.status
    pending.reasonCode = feedback.reasonCode
    pending.committedRevision = feedback.committedRevision
    this.stagedOutcomes.delete(feedback.intentId)
    return feedback
  }

  /** Preserve a form draft keyed by target across ordinary projection updates. */
  setDraft(target: string, text: string): void {
    if (typeof target !== 'string' || target.length > 512 || typeof text !== 'string' || text.length > 24000) throw new Error('draft bound exceeded')
    if (!this.drafts.has(target) && this.drafts.size >= 64) throw new Error('draft capacity exceeded')
    this.drafts.set(target, text)
  }

  getDraftState(): Record<string, string> {
    return Object.fromEntries(this.drafts)
  }

  getDraft(target: string): string {
    return this.drafts.get(target) ?? ''
  }

  clearDraft(target: string): void {
    this.drafts.delete(target)
  }

  /**
   * Expire confirmations and obsolete feedback by local monotonic time.
   * Returns the number of intents newly marked expired.
   */
  expireConfirmations(): number {
    const now = this.clock()
    let changed = 0
    for (const [id, pending] of this.pending) {
      if (pending.status === 'submitted' && now - pending.submittedAt > this.confirmationTtlMs) {
        pending.status = 'expired'
        pending.reasonCode = 'confirmation_expired'
        changed += 1
        this.onFeedback?.({
          intentId: id,
          sessionId: pending.intent.sessionId,
          target: pending.intent.target,
          originRevision: pending.intent.expectedRevision,
          status: 'expired',
          reasonCode: 'confirmation_expired',
          committedRevision: null,
        })
      }
    }
    return changed
  }

  /**
   * Mark submitted intents past the ACK deadline as `unknown` (not retry
   * success). Returns the number newly marked unknown.
   */
  markAckDeadlines(): number {
    const now = this.clock()
    let changed = 0
    for (const [id, pending] of this.pending) {
      if (pending.status === 'submitted' && now - pending.submittedAt > this.ackDeadlineMs) {
        pending.status = 'unknown'
        pending.reasonCode = 'ack_deadline'
        changed += 1
        this.onFeedback?.({
          intentId: id,
          sessionId: pending.intent.sessionId,
          target: pending.intent.target,
          originRevision: pending.intent.expectedRevision,
          status: 'unknown',
          reasonCode: 'ack_deadline',
          committedRevision: null,
        })
        this.channel?.send('query_intent', { intent: pending.intent })
      }
    }
    return changed
  }

  /** Read-only recovery of unresolved results; never re-submit an intent. */
  queryOutcomes(): void {
    const snapshot = this.projection.handoff?.snapshot
    if (!snapshot || !this.channel || this.stopped) return
    for (const pending of this.pending.values()) {
      if (['submitted', 'unknown', 'stale'].includes(pending.status)
          && pending.intent.sessionId === snapshot.sessionId && pending.intent.pluginGeneration === snapshot.pluginGeneration
          && pending.intent.runnerEpoch === snapshot.runnerEpoch) this.channel.send('query_intent', { intent: pending.intent })
    }
  }

  /** Explicit staleness check driven by the local monotonic clock. */
  checkStaleness(): boolean {
    if (this.isStale && this.projection.handoff !== null
        && this.projection.handoff.connection !== 'stale') {
      this.projection.markGap('no authoritative update within the staleness bound')
      this.publish()
      return true
    }
    return false
  }

  private onIdentityChange(snapshot: WorkbenchSnapshot): void {
    const identity = JSON.stringify([snapshot.sessionId, snapshot.pluginGeneration, snapshot.runnerEpoch,
      snapshot.selectedProjectId, snapshot.selectedGoalId, snapshot.managedAgents.map(card => card.agentRunId), snapshot.observedSessions.map(card => card.observedSessionId)])
    const identityChanged = this.lastIdentity !== null && this.lastIdentity !== identity
    this.lastIdentity = identity
    const revisionChanged = this.lastRevision !== null
      && snapshot.revision !== this.lastRevision
    this.lastSessionId = snapshot.sessionId
    this.lastRunnerEpoch = snapshot.runnerEpoch
    this.lastRevision = snapshot.revision
    if (identityChanged || revisionChanged) {
      // Invalidate pending confirmations and obsolete feedback on identity or
      // relevant revision change. Text drafts are preserved separately.
      for (const [id, pending] of this.pending) {
        const sameAuthority = snapshot.sessionId === pending.intent.sessionId && snapshot.pluginGeneration === pending.intent.pluginGeneration && snapshot.runnerEpoch === pending.intent.runnerEpoch
        if (!sameAuthority) this.stagedOutcomes.delete(id)
        if (pending.status === 'submitted' || (pending.status === 'unknown' && !sameAuthority)) {
          const staged = this.stagedOutcomes.get(id)
          if (staged && snapshot.sessionId === pending.intent.sessionId && snapshot.pluginGeneration === pending.intent.pluginGeneration
              && snapshot.runnerEpoch === pending.intent.runnerEpoch) continue
          this.stagedOutcomes.delete(id)
          pending.status = 'stale'
          pending.reasonCode = 'identity_changed'
          this.onFeedback?.({
            intentId: id,
            sessionId: pending.intent.sessionId,
            target: pending.intent.target,
            originRevision: pending.intent.expectedRevision,
            status: 'stale',
            reasonCode: 'identity_changed',
            committedRevision: null,
          })
        }
      }
    }
  }

  private closed(error: Error | null): void {
    if (this.stopped) return
    this.started = false
    this.channel = null
    this.connectionAttempt++
    this.publishedSnapshot = null
    if (this.projection.handoff !== null) {
      this.projection.markGap(error?.message ?? 'projection connection closed')
      this.publish()
    }
  }

  private publish(): void {
    const handoff = this.projection.handoff
    if (handoff !== null) {
      try {
        this.sink(handoff)
        this.publishedSnapshot = handoff.connection === 'connected' ? handoff.snapshot : null
      } catch (error) {
        this.publishedSnapshot = null
        this.projection.markGap('projection publication failed')
        throw error
      }
      // Synchronous resnapshot replies must come after the gap presentation,
      // otherwise an old gap frame can overwrite a just-recovered snapshot.
      if (handoff.connection === 'gap') this.channel?.send('request_snapshot', { sessionId: handoff.snapshot.sessionId })
    }
  }
}

function requirePort<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new TypeError(`${name} is required`)
  return value
}
