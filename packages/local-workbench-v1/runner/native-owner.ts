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
function request(value: unknown): { protocol: string; requestId: string; type: 'open' | 'hide' | 'status' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'protocol,requestId,type') throw new Error('invalid_owner_request')
  const data = value as Record<string, unknown>
  if (data.protocol !== OWNER_PROTOCOL || !ident(data.requestId) || !['open', 'hide', 'status'].includes(String(data.type))) throw new Error('invalid_owner_request')
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
}): Promise<NativeOwner> {
  if (!options.roots.runtimeDir) throw new Error('start requires an explicit owner-only runtime directory')
  const runner = openWorkbenchRunner(options)
  let bridge: Awaited<ReturnType<typeof openOwnerPiBridge>> | null = null
  let server: Server | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let host: WorkbenchHost | null = null
  let authority: WorkbenchAuthority | null = null
  let closed = false
  const clients = new Set<Socket>()
  const path = ownerSocket(runner.roots.runtimeDir!)
  const desktop = options.desktop ?? null
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
              if (host) { host.stop(); host = null }
              // The bridge manager outlives views; hide/reopen changes neither
              // runner epoch nor membership, Pi connection nor owner lock.
              authority = new WorkbenchAuthority({ runner, registry: bridge!.registry, framedAdoption: manager,
                sessionId: `session-${randomUUID()}`, pluginGeneration: generation, clock: options.clock })
              const view = createDesktopView(desktop, generation)
              const next = createWorkbenchHost({ authority, view, clock: options.monotonic, onHide: () => {
                if (host !== next) return // stale shell generation cannot hide its successor
                host = null
                next.stop()
              } })
              try { await next.start() } catch (error) { next.stop(); throw error }
              host = next
              result = { status: 'opened', sessionId: authority.sessionId, runnerEpoch: runner.epoch }
            } else if (incoming.type === 'hide') {
              if (host) { const old = host; host = null; old.stop() }
              result = { status: 'hidden', runnerEpoch: runner.epoch }
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
    timer = setInterval(() => {
      try { if (host) host.tick(); else bridge?.registry.expire() }
      catch (error) {
        // An acknowledged open is not a durable presentation if the next
        // poll fails. Leave an actionable owner-side diagnostic instead of
        // silently hiding the workbench after one second.
        console.error('workbench presentation tick unavailable:', error instanceof Error ? error.message : 'unknown error')
        if (host) { try { host.stop() } catch { /* stale shell */ } host = null }
      }
    }, 1000)
    return {
      runner, registry: bridge.registry, socketPath: path,
      currentAuthority: () => authority!,
      tick() {
        try { host?.tick() }
        catch { const failed = host; host = null; try { failed?.stop() } catch { /* stale desktop cannot be cleared */ } }
      },
      async close() {
        if (closed) return
        closed = true
        if (timer) clearInterval(timer)
        if (host) { const prior = host; host = null; try { prior.stop() } catch { /* loaded plugin may have disappeared */ } }
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
    if (timer) clearInterval(timer)
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    try { await bridge?.close() } finally { runner.close() }
    throw error
  }
}
