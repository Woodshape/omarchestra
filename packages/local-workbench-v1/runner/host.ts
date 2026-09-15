/**
 * Local Workbench v1 Phase 2 — composition of the runner authority with the
 * actual presentation shell and the actual QML view port.
 *
 * This is the real runtime path: the projection the QML host renders and the
 * intents it emits are produced and consumed by the durable runner, not by a
 * fixture transport. The fixture path stays available and labelled separately.
 */

import { createPresentationShell, type PresentationPort } from '../console/presentation-shell.ts'
import type { WorkbenchSource, WorkbenchIntent, WorkbenchIntentSink } from '../console/live-projection-adapter.ts'
import type { WorkbenchSnapshot } from '../console/schema.ts'
import type { WorkbenchAuthority } from './authority.ts'
import { buildSnapshot } from './projection.ts'

export interface RunnerSource {
  source: WorkbenchSource
  publish(): void
  close(error: Error | null): void
}

/** Authoritative snapshot broadcaster. One connection at a time, by design. */
export function createRunnerSource(authority: WorkbenchAuthority, connection: WorkbenchSnapshot['connection'] = 'connected'): RunnerSource {
  let handler: { onSnapshot(snapshot: unknown): void; onEvent(event: unknown): void; onClose(error: Error | null): void } | null = null
  let published: string | null = null
  const snapshotOf = () => buildSnapshot({ authority, adoption: authority.adoption, connection })
  return {
    source: {
      connect(next) {
        if (handler !== null) throw new Error('the workbench runner holds one authoritative connection')
        handler = next
        published = JSON.stringify(snapshotOf())
        next.onSnapshot(snapshotOf())
        return Promise.resolve({ send() { /* authoritative snapshots replace the projection */ }, close() { /* the runner owns closure */ } })
      },
    },
    /** Publish only a changed projection; an idle tick writes nothing. */
    publish() {
      const encoded = JSON.stringify(snapshotOf())
      if (published === encoded) return
      published = encoded
      handler?.onSnapshot(snapshotOf())
    },
    close(error) {
      const current = handler
      handler = null
      current?.onClose(error)
    },
  }
}

export interface WorkbenchHostOptions {
  authority: WorkbenchAuthority
  view: PresentationPort
  connection?: WorkbenchSnapshot['connection']
  clock?: () => number
}

export interface WorkbenchHost {
  readonly shell: ReturnType<typeof createPresentationShell>
  readonly source: RunnerSource
  start(): Promise<void>
  tick(): void
  stop(): void
}

/**
 * Connect the runner to the real QML presentation port. The host drains QML
 * intents on `tick`, routes them through the durable runner, and feeds the
 * committed outcome back to the shell before republishing the projection.
 */
export function createWorkbenchHost(options: WorkbenchHostOptions): WorkbenchHost {
  const source = createRunnerSource(options.authority, options.connection ?? 'connected')
  let shell: ReturnType<typeof createPresentationShell> | null = null
  const intentSink: WorkbenchIntentSink = (intent: WorkbenchIntent) => {
    const outcome = options.authority.handleIntent(intent)
    shell?.adapter.applyFeedback({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
      target: intent.target,
      originRevision: intent.expectedRevision,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      committedRevision: outcome.committedRevision,
    })
    source.publish()
  }
  shell = createPresentationShell({
    source: source.source,
    intentSink,
    view: options.view,
    clock: options.clock,
  })
  return {
    shell,
    source,
    async start() {
      await shell!.start()
    },
    tick() {
      shell!.tick()
      source.publish()
    },
    stop() {
      shell!.close()
      source.close(null)
    },
  }
}

export function snapshotOf(authority: WorkbenchAuthority, connection: WorkbenchSnapshot['connection'] = 'connected'): WorkbenchSnapshot {
  return buildSnapshot({ authority, adoption: authority.adoption, connection })
}
