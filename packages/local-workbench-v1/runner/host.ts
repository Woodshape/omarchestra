/** Runner/presentation composition. This injected port alone implies no
 * installed desktop or Pi bridge; native-owner.ts supplies their composition.
 * Assignment delivery remains unavailable in Phase 2.
 */
import { createPresentationShell, PresentationRefreshUnavailable, type PresentationPort } from '../console/presentation-shell.ts'
import type { WorkbenchSource, WorkbenchSourceHandler, WorkbenchIntent, WorkbenchIntentSink } from '../console/live-projection-adapter.ts'
import { validateFeedback, type WorkbenchSnapshot, type WorkbenchFeedback } from '../console/schema.ts'
import { sha256, type WorkbenchAuthority } from './authority.ts'
import { buildSnapshot } from './projection.ts'
import { validateAuthorityIntent } from './intent-envelope.ts'

export interface RunnerSource {
  source: WorkbenchSource
  publish(heartbeat?: boolean): void
  publishOutcome(feedback: WorkbenchFeedback): void
  close(error: Error | null): void
}
const HEARTBEAT_MS = 1000

/** One presentation subscriber; the foreground runner remains the owner. */
export function createRunnerSource(authority: WorkbenchAuthority, connection: WorkbenchSnapshot['connection'] = 'connected', options: { clock?: () => number } = {}): RunnerSource {
  const clock = options.clock ?? (() => performance.now())
  type Subscription = { handler: WorkbenchSourceHandler; published: string | null; at: number; publishing: boolean; refresh: boolean }
  let active: Subscription | null = null
  function publish(force = false) {
    const current = active
    if (!current) return
    if (current.publishing) { current.refresh = true; return }
    const snapshot = buildSnapshot({ authority, adoption: authority.adoption, connection })
    const encoded = JSON.stringify(snapshot)
    if (!force && !current.refresh && encoded === current.published && clock() - current.at < HEARTBEAT_MS) return
    current.publishing = true
    current.refresh = false
    try {
      current.handler.onSnapshot(snapshot)
      current.published = encoded
      current.at = clock()
    } catch (error) {
      current.refresh = true
      throw error
    } finally { current.publishing = false }
  }
  function publishOutcome(input: WorkbenchFeedback) {
    const feedback = validateFeedback(input)
    active?.handler.onOutcome?.(feedback) // Staged receipt, not displayed ACK.
    publish(true) // Successful presentation is the feedback release barrier.
  }
  return {
    source: {
      async connect(handler) {
        if (active) throw new Error('the workbench runner holds one authoritative connection')
        const current: Subscription = { handler, published: null, at: clock(), publishing: false, refresh: true }
        active = current
        try {
          publish(true)
          if (active !== current) throw new Error('source closed during initial publication')
        } catch (error) { if (active === current) active = null; throw error }
        return {
          send(type, body) {
            if (active !== current) throw new Error('presentation channel is closed')
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid source request')
            if (type === 'request_snapshot') {
              if (Object.keys(body).length !== 1 || body.sessionId !== authority.sessionId) throw new Error('snapshot request session mismatch')
              publish(true)
              return
            }
            if (type !== 'query_intent' || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'intent')) throw new Error('unsupported source request')
            // Read-only lookup. The full original intent binds the query to the
            // complete durable envelope; a reused presentation counter cannot
            // turn a different command's old receipt into success.
            let intent: WorkbenchIntent
            try { intent = validateAuthorityIntent(body.intent) }
            catch { throw new Error('invalid outcome query envelope') }
            const receipt = authority.runner.store.getIntentResult(intent.intentId)
            const hash = sha256(intent)
            const matches = receipt && receipt.sessionId === intent.sessionId && receipt.payloadHash === hash
            publishOutcome({ intentId: intent.intentId, sessionId: intent.sessionId, target: intent.target, originRevision: intent.expectedRevision,
              status: matches ? receipt.status as WorkbenchFeedback['status'] : receipt ? 'rejected' : 'unknown',
              reasonCode: matches ? receipt.reasonCode : receipt ? 'intent_identity_conflict' : 'outcome_unavailable',
              committedRevision: matches ? receipt.committedRevision : null })
          },
          close() {
            if (active !== current) return
            active = null
            current.handler.onClose(null)
          },
        }
      },
    },
    publish: (heartbeat = false) => publish(heartbeat),
    publishOutcome,
    close(error) {
      const current = active
      active = null
      current?.handler.onClose(error)
    },
  }
}

export interface WorkbenchHostOptions {
  authority: WorkbenchAuthority
  view: PresentationPort
  connection?: WorkbenchSnapshot['connection']
  clock?: () => number
  onHide?: () => void
}
export interface WorkbenchHost {
  readonly shell: ReturnType<typeof createPresentationShell>
  readonly source: RunnerSource
  start(): Promise<void>
  tick(options?: { heartbeat?: boolean }): 'updated' | 'refresh_deferred'
  stop(): void
}

/** Receipt -> committed snapshot -> displayed feedback, never the reverse. */
export function createWorkbenchHost(options: WorkbenchHostOptions): WorkbenchHost {
  const source = createRunnerSource(options.authority, options.connection ?? 'connected', { clock: options.clock })
  const intentSink: WorkbenchIntentSink = (intent: WorkbenchIntent) => {
    const outcome = options.authority.handleIntent(intent)
    source.publishOutcome({ intentId: intent.intentId, sessionId: intent.sessionId, target: intent.target,
      originRevision: intent.expectedRevision, status: outcome.status, reasonCode: outcome.reasonCode, committedRevision: outcome.committedRevision })
  }
  const shell = createPresentationShell({ source: source.source, intentSink, view: options.view,
    clock: options.clock, beforeIntent: () => source.publish(), onHide: options.onHide })
  return {
    shell, source,
    start: () => shell.start(),
    // Reconcile the authoritative source before draining user clicks. An
    // otherwise healthy owner may have spent >2s in shell IPC or scheduling;
    // polling a queued click first would treat that timing gap as lost source
    // authority, throw, and close the entire dock instead of refreshing it.
    // The periodic Owner timer already sets the liveness cadence. Applying
    // the source's 1000 ms throttle again after synchronous publication can
    // skip every other tick and race QML's 2000 ms watchdog. Periodic ticks
    // must publish; immediate wake/before-intent paths still coalesce normally.
    tick(tickOptions) {
      try { source.publish(tickOptions?.heartbeat === true) }
      catch (error) {
        if (error instanceof PresentationRefreshUnavailable) return 'refresh_deferred'
        throw error
      }
      shell.tick()
      return 'updated'
    },
    stop() { try { shell.close() } finally { source.close(null) } },
  }
}
export function snapshotOf(authority: WorkbenchAuthority, connection: WorkbenchSnapshot['connection'] = 'connected'): WorkbenchSnapshot {
  return buildSnapshot({ authority, adoption: authority.adoption, connection })
}
