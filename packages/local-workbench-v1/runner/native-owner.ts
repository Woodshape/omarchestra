/** One foreground owner: lifetime SQLite lock, Pi bridge, ephemeral desktop view. */
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { chmodSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openWorkbenchRunner, type WorkbenchRunner, type WorkbenchRunnerOptions } from './runner.ts'
import { openOwnerPiBridge } from './bridge-owner.ts'
import { WorkbenchAuthority } from './authority.ts'
import { FramedAdoptionManager } from './framed-adoption.ts'
import { createWorkbenchHost, type WorkbenchHost } from './host.ts'
import { createDesktopView, negotiateCompanion, type DesktopCommandPort } from './desktop-command.ts'

export const OWNER_PROTOCOL = 'omarchestra.owner/v1'
const MAX_REQUEST = 4096, MAX_RESPONSE = 32 * 1024
export const ownerSocket = (runtimeDir: string) => join(runtimeDir, 'omarchestra-workbench.sock')
const ident = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
type OwnerRequest = { protocol: string; requestId: string; type: 'open' | 'hide' | 'status' | 'wake'; sessionId?: string; pluginGeneration?: number }
function request(value: unknown): OwnerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_owner_request')
  const data = value as Record<string, unknown>
  const keys = data.type === 'wake' ? 'pluginGeneration,protocol,requestId,sessionId,type' : 'protocol,requestId,type'
  if (Object.keys(data).sort().join(',') !== keys
      || data.protocol !== OWNER_PROTOCOL || !ident(data.requestId) || !['open', 'hide', 'status', 'wake'].includes(String(data.type))) throw new Error('invalid_owner_request')
  if (data.type === 'wake' && (!ident(data.sessionId) || !Number.isSafeInteger(data.pluginGeneration)
      || Number(data.pluginGeneration) <= 0)) throw new Error('invalid_owner_request')
  return data as ReturnType<typeof request>
}
function privateRoot(path: string): void {
  const info = lstatSync(dirname(path))
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('owner_runtime_not_private')
}
export async function requestOwner(runtimeDir: string, type: 'open' | 'hide' | 'status', timeoutMs = 5000): Promise<Record<string, unknown>> {
  const path = ownerSocket(runtimeDir)
  try {
    privateRoot(path)
    const file = lstatSync(path)
    if (!file.isSocket() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) throw new Error('owner_socket_not_private')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Workbench owner is not running; start it first with owned --state-dir and --runtime-dir roots.')
    throw error
  }
  const requestId = `request-${randomUUID()}`
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let done = false, buffer = Buffer.alloc(0)
    const finish = (err: Error | null, result?: Record<string, unknown>) => {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (err) reject(err); else resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error('owner_request_timed_out')), timeoutMs)
    socket.on('connect', () => socket.write(`${JSON.stringify({ protocol: OWNER_PROTOCOL, requestId, type })}\n`))
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_RESPONSE) { finish(new Error('owner_response_too_large')); return }
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      try {
        if (newline !== buffer.length - 1) throw new Error('owner_response_trailing_data')
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline))) as Record<string, unknown>
        if (!value || Object.keys(value).sort().join(',') !== 'kind,requestId,result' || value.requestId !== requestId
            || value.kind !== 'result' || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) throw new Error('invalid_owner_response')
        finish(null, value.result as Record<string, unknown>)
      } catch (error) { finish(error as Error) }
    })
    socket.on('error', error => finish(error))
    socket.on('close', () => { if (!done) finish(new Error('owner_disconnected')) })
  })
}

export interface NativeOwner {
  runner: WorkbenchRunner
  registry: Awaited<ReturnType<typeof openOwnerPiBridge>>['registry']
  socketPath: string
  currentAuthority(): WorkbenchAuthority
  tick(): void
  close(): Promise<void>
}
export async function startNativeOwner(options: WorkbenchRunnerOptions & {
  desktop?: DesktopCommandPort | null; clock?: () => number; monotonic?: () => number
  /** Injectable scheduler for disposable wake-path tests; not a CLI option. */
  schedule?: (tick: () => void, intervalMs: number) => () => void
}): Promise<NativeOwner> {
  if (!options.roots.runtimeDir) throw new Error('start requires an explicit owner-only runtime directory')
  const runner = openWorkbenchRunner(options)
  let bridge: Awaited<ReturnType<typeof openOwnerPiBridge>> | null = null
  let server: Server | null = null
  let cancelTimer: (() => void) | null = null
  let host: WorkbenchHost | null = null
  let authority: WorkbenchAuthority | null = null
  let closed = false
  const clients = new Set<Socket>()
  const path = ownerSocket(runner.roots.runtimeDir!)
  const desktop = options.desktop ?? null
  let refreshUnavailable = false
  function tickPresentation(current: WorkbenchHost, tickOptions?: { heartbeat?: boolean }) {
    const outcome = current.tick(tickOptions)
    if (outcome === 'refresh_deferred') {
      if (!refreshUnavailable) console.error('workbench Companion refresh temporarily unavailable; retaining the dock and deferring queued intents until the next tick')
      refreshUnavailable = true
    } else if (refreshUnavailable) {
      console.info('workbench Companion refresh recovered')
      refreshUnavailable = false
    }
  }
  try {
    bridge = await openOwnerPiBridge(runner, join(runner.roots.runtimeDir!, 'omarchestra-bridge.sock'), { now: options.monotonic })
    authority = new WorkbenchAuthority({ runner, registry: bridge.registry, sessionId: `owner-${randomUUID()}`, pluginGeneration: 1, clock: options.clock })
    const manager = authority.adoption as FramedAdoptionManager
    privateRoot(path)
    server = createServer(socket => {
      clients.add(socket); socket.once('close', () => clients.delete(socket))
      let bytes = Buffer.alloc(0), received = false
      socket.on('data', chunk => {
        if (received) { socket.destroy(); return }
        bytes = Buffer.concat([bytes, chunk])
        if (bytes.length > MAX_REQUEST) { socket.destroy(); return }
        const newline = bytes.indexOf(10)
        if (newline < 0) return
        received = true
        if (newline !== bytes.length - 1) { socket.destroy(); return }
        let incoming: ReturnType<typeof request>
        try { incoming = request(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, newline)))) }
        catch { socket.destroy(); return }
        void (async () => {
          let result: Record<string, unknown>
          try {
            if (incoming.type === 'open') {
              if (!desktop) throw new Error('Installed Companion command port unavailable. Enable a compatible Companion and use an owner with desktop access.')
              const generation = negotiateCompanion(desktop)
              if (host) { const old = host; host = null; old.stop() }
              refreshUnavailable = false
              // The bridge manager outlives views; hide/reopen changes neither
              // runner epoch nor membership, Pi connection nor owner lock.
              authority = new WorkbenchAuthority({ runner, registry: bridge!.registry, framedAdoption: manager,
                sessionId: `session-${randomUUID()}`, pluginGeneration: generation, clock: options.clock })
              const view = createDesktopView(desktop, generation, path)
              const next = createWorkbenchHost({ authority, view, clock: options.monotonic, onHide: () => {
                if (host !== next) return // stale shell generation cannot hide its successor
                host = null
                refreshUnavailable = false
                next.stop()
              } })
              try { await next.start() } catch (error) { next.stop(); throw error }
              host = next
              result = { status: 'opened', sessionId: authority.sessionId, runnerEpoch: runner.epoch }
            } else if (incoming.type === 'hide') {
              if (host) { const old = host; host = null; old.stop() }
              refreshUnavailable = false
              result = { status: 'hidden', runnerEpoch: runner.epoch }
            } else if (incoming.type === 'wake') {
              // Notification only: no action payload, launch or domain identity.
              // Drain the exact loaded view through its guarded IPC boundary.
              if (!host || incoming.sessionId !== authority!.sessionId
                  || incoming.pluginGeneration !== authority!.pluginGeneration) throw new Error('stale_presentation_wake')
              const current = host
              try { tickPresentation(current) } catch (error) {
                // Same failure policy as the liveness tick: revoke only this
                // view, never leave a failed fast path claiming to be open.
                if (host === current) { host = null; refreshUnavailable = false; try { current.stop() } catch { /* stale view */ } }
                throw error
              }
              result = { status: 'woken' }
            } else {
              // Status does not poll the presentation or apply its pending
              // intents. It still must not claim a reloaded shell is open.
              if (host && (!desktop || negotiateCompanion(desktop) !== authority!.pluginGeneration)) {
                throw new Error('Loaded Companion generation changed; reopen the workbench after confirming the compatible release.')
              }
              result = { status: 'running', runnerEpoch: runner.epoch, sessionId: host ? authority!.sessionId : null,
                presentation: host ? 'open' : 'hidden', projects: runner.store.listProjects().length,
                goals: runner.store.listGoals().length, revision: authority!.currentRevision }
            }
          } catch (error) { result = { status: 'unavailable', reason: error instanceof Error ? error.message : 'owner command failed' } }
          if (socket.destroyed) return
          socket.end(`${JSON.stringify({ kind: 'result', requestId: incoming.requestId, result })}\n`)
        })()
      })
      socket.on('error', () => socket.destroy())
    })
    server.maxConnections = 32
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(path, () => { server!.off('error', reject); resolve() }) })
    chmodSync(path, 0o600)
    const { dev, ino } = lstatSync(path)
    const schedule = options.schedule ?? ((tick, ms) => { const timer = setInterval(tick, ms); return () => clearInterval(timer) })
    cancelTimer = schedule(() => {
      try { if (host) tickPresentation(host, { heartbeat: true }); else bridge?.registry.expire() }
      catch (error) {
        // An acknowledged open is not a durable presentation if the next
        // poll fails. Leave an actionable owner-side diagnostic instead of
        // silently hiding the workbench after one second.
        console.error('workbench presentation tick unavailable:', error instanceof Error ? error.message : 'unknown error')
        if (host) { try { host.stop() } catch { /* stale shell */ } host = null }
        refreshUnavailable = false
      }
    }, 1000)
    return {
      runner, registry: bridge.registry, socketPath: path,
      currentAuthority: () => authority!,
      tick() {
        try { if (host) tickPresentation(host, { heartbeat: true }) }
        catch { const failed = host; host = null; refreshUnavailable = false; try { failed?.stop() } catch { /* stale desktop cannot be cleared */ } }
      },
      async close() {
        if (closed) return
        closed = true
        cancelTimer?.()
        if (host) { const prior = host; host = null; try { prior.stop() } catch { /* loaded plugin may have disappeared */ } }
        refreshUnavailable = false
        for (const client of clients) client.destroy()
        try {
          const current = lstatSync(path)
          if (current.dev !== dev || current.ino !== ino) { server!.unref(); throw new Error('owner_socket_identity_changed') }
          await new Promise<void>(resolve => server!.close(() => resolve()))
        } finally {
          try { await bridge!.close() } finally { runner.close() }
        }
      },
    }
  } catch (error) {
    cancelTimer?.()
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    try { await bridge?.close() } finally { runner.close() }
    throw error
  }
}
