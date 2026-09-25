import { WorkbenchAdapter, type WorkbenchSource, type WorkbenchIntentSink } from './live-projection-adapter.ts'

/** Injected composition of the actual adapter and Companion method boundary. */
export interface PresentationPort {
  pluginGeneration: number
  open(envelope: unknown): boolean
  applyProjection(snapshot: unknown): boolean
  takeIntent(session: unknown): string
  intentResult(feedback: unknown): boolean
  close(): void
  getDraftState?(): Record<string, string>
  setDraftState?(drafts: Record<string, string>): boolean
}

export function createPresentationShell(options: {
  source: WorkbenchSource
  intentSink: WorkbenchIntentSink
  view: PresentationPort
  clock?: () => number
  /** Revalidate the source after a potentially slow installed-shell readback. */
  beforeIntent?: () => void
  /** Owner-only view lifecycle; never forwarded to the Team Runner. */
  onHide?: () => void
}) {
  let session: { sessionId: string; pluginGeneration: number } | null = null
  const adapter = new WorkbenchAdapter({
    source: options.source,
    intentSink: options.intentSink,
    clock: options.clock,
    sink(handoff) {
      syncDrafts()
      const snapshot = { ...handoff.snapshot, connection: handoff.connection }
      const next = { sessionId: snapshot.sessionId, pluginGeneration: snapshot.pluginGeneration }
      if (!session || session.sessionId !== next.sessionId || session.pluginGeneration !== next.pluginGeneration) {
        options.view.pluginGeneration = next.pluginGeneration
        if (!options.view.open({ session: next, projection: snapshot })) throw new Error('presentation open rejected')
        session = next
      } else if (!options.view.applyProjection(snapshot)) throw new Error('presentation update rejected')
    },
    onFeedback(feedback) {
      if (session && session.sessionId === feedback.sessionId) {
        if (!options.view.intentResult({ ...feedback, pluginGeneration: session.pluginGeneration })) throw new Error('presentation feedback rejected')
      }
    },
  })
  function syncDrafts() {
    if (!options.view.getDraftState) return
    for (const [key, value] of Object.entries(options.view.getDraftState())) adapter.setDraft(key, value)
    if (options.view.setDraftState && !options.view.setDraftState(adapter.getDraftState())) throw new Error('draft restoration rejected')
  }
  return {
    adapter,
    start: () => adapter.start(),
    tick() {
      syncDrafts()
      adapter.checkStaleness()
      adapter.markAckDeadlines()
      if (!session) return
      for (let count = 0; count < 16; count++) {
        const encoded = options.view.takeIntent(session)
        if (!encoded) break
        const request = JSON.parse(encoded)
        if (!request || Object.keys(request).some(key => !['kind', 'target', 'payload'].includes(key))) throw new Error('invalid presentation request')
        if (request.kind === 'hide_workbench') {
          if (request.target !== null || !request.payload || typeof request.payload !== 'object'
              || Array.isArray(request.payload) || Object.keys(request.payload).length !== 0 || !options.onHide) {
            options.view.intentResult({ ...session, intentId: 'unsent-presentation-request',
              status: 'rejected', reasonCode: 'invalid_presentation_request' })
            continue
          }
          options.onHide()
          return
        }
        const old = adapter.handoff?.snapshot
        options.beforeIntent?.()
        const current = adapter.handoff?.snapshot
        const contextChanged = !old || !current || old.sessionId !== current.sessionId
          || old.pluginGeneration !== current.pluginGeneration || old.runnerEpoch !== current.runnerEpoch
          || old.revision !== current.revision || old.selectedProjectId !== current.selectedProjectId
          || old.selectedGoalId !== current.selectedGoalId
        if (contextChanged || adapter.isStale || adapter.handoff?.connection !== 'connected') {
          adapter.checkStaleness()
          // This queued click was never forwarded to the runner. Show a local
          // stale response, not a fabricated runner acknowledgement or a dock
          // crash, and let the operator review the refreshed projection.
          options.view.intentResult({ ...session, intentId: 'unsent-presentation-request',
            status: 'stale', reasonCode: 'refresh_required' })
          break
        }
        adapter.emitIntent(request.kind, request.target, request.payload)
      }
    },
    close() { syncDrafts(); adapter.stop(); options.view.close(); session = null },
  }
}
