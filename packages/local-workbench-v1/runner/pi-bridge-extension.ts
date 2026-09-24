/** Pi-facing lifecycle adapter: only public, allow-listed source facts cross the wire. */
import { connect as netConnect, type Socket } from 'node:net'
import { join } from 'node:path'
import { attachBridgeStream } from './bridge-channel.ts'
import { BRIDGE_CAPABILITIES, bridgeId, type BridgeFrame } from './bridge-protocol.ts'

type Context = { mode: string; sessionManager: { getSessionId(): string | undefined }; isIdle(): boolean; hasPendingMessages?(): boolean; ui: { setStatus(key: string, text: string | undefined): void } }
type PiAPI = { on(name: string, handler: (event: unknown, ctx: Context) => void): void }
type Client = { sendFrame(type: 'register' | 'heartbeat' | 'input_observed' | 'close', id: string, body: Record<string, unknown>): void; close(): void }
export function connectLocalPiBridge(path: string, onFrame: (frame: BridgeFrame) => void, onClose: () => void): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect(path)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('bridge_timeout')) }, 1000)
    timer.unref()
    const fail = () => { clearTimeout(timer); socket.destroy(); reject(new Error('bridge_unavailable')) }
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer); socket.off('error', fail)
      resolve(attachBridgeStream(socket, { onFrame: (_peer, frame) => onFrame(frame), onClose }))
    })
  })
}
/** Injectable fake Pi host and paired-channel connector; no work in the factory. */
export function createPiBridgeExtension(options: { socketPath?: string; connect?: (onFrame: (frame: BridgeFrame) => void, onClose: () => void) => Promise<Client>; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void; newId?: (prefix: string) => string } = {}) {
  const issue = options.newId ?? bridgeId
  const processInstanceId = issue('process')
  const extensionInstanceId = issue('extension')
  const connect = options.connect ?? ((onFrame, onClose) => connectLocalPiBridge(options.socketPath ?? join(process.env.XDG_RUNTIME_DIR ?? '/nonexistent', 'omarchestra-bridge.sock'), onFrame, onClose))
  const schedule = options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer })
  const cancel = options.cancel ?? clearTimeout
  return (pi: PiAPI) => {
    let ctx: Context | null = null, client: Client | null = null
    let sessionId: string | null = null, connectionId: string | null = null, challenge: string | null = null
    let attempt = 0, sequence = 0, connecting = false, stopped = true, retryMs = 500, mode: 'observed' | 'committed' = 'observed'
    let timer: ReturnType<typeof setTimeout> | null = null, generation = 0, pendingInput: string | null = null, handshakeTicks = 0
    const status = () => { try { ctx?.ui.setStatus('omarchestra-observer-status', client && connectionId && mode === 'observed' ? 'Unassigned · observed' : undefined) } catch { /* never disrupt Pi */ } }
    const activity = () => { try { return ctx && ctx.isIdle() && !ctx.hasPendingMessages?.() ? 'idle' : 'busy' } catch { return 'unknown' } }
    const clearTimer = () => { if (timer) cancel(timer); timer = null }
    const send = (type: 'heartbeat' | 'input_observed' | 'close', extra: Record<string, unknown> = {}) => {
      if (!client || !connectionId || !challenge) return false
      sequence += 1
      try { client.sendFrame(type, issue('message'), { connectionId, connectionChallenge: challenge, sourceSequence: sequence, ...extra }); return true }
      catch { client.close(); return false }
    }
    const heartbeat = () => {
      timer = null
      if (stopped) return
      if (client && connectionId) send('heartbeat', { lifecycle: 'running', activity: activity(), health: 'healthy' })
      else if (client && ++handshakeTicks > 2) client.close()
      else if (!client) void open()
      timer = schedule(heartbeat, client && connectionId ? 5000 : retryMs)
    }
    const open = async () => {
      if (connecting || stopped || !ctx || !sessionId) return
      connecting = true
      const current = generation
      try {
        const channel = await connect(frame => {
          if (current !== generation || !client) return
          if (frame.type === 'input_received' && connectionId && challenge
              && frame.body.connectionId === connectionId && frame.body.connectionChallenge === challenge
              && frame.body.eventId === pendingInput) { pendingInput = null; return }
          if (frame.type !== 'registered' || connectionId) return
          const b = frame.body
          if (b.acceptedRegistrationAttempt !== attempt || b.acceptedSourceSequence !== sequence) { client.close(); return }
          connectionId = b.connectionId as string; challenge = b.connectionChallenge as string
          handshakeTicks = 0; retryMs = 500; mode = b.mode as 'observed' | 'committed'; status()
          if (pendingInput && mode === 'committed') send('input_observed', { eventId: pendingInput })
        }, () => {
          if (current !== generation) return
          client = null; connectionId = null; challenge = null; retryMs = Math.min(5000, retryMs * 2); status()
        })
        if (current !== generation || stopped) { channel.close(); return }
        client = channel; handshakeTicks = 0; attempt += 1; sequence += 1
        channel.sendFrame('register', issue('message'), { processInstanceId, piSessionId: sessionId, extensionInstanceId, hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES], registrationAttempt: attempt, sourceSequence: sequence, lifecycle: 'running', activity: activity(), health: 'healthy' })
      } catch { retryMs = Math.min(5000, retryMs * 2) /* fail open; scheduled retry */ }
      finally { connecting = false }
    }
    const stop = (reason: string) => {
      generation += 1; stopped = true; clearTimer()
      if (client) { send('close', { reason }); client.close() }
      client = null; connectionId = null; challenge = null; status(); ctx = null; sessionId = null
    }
    pi.on('session_start', (_event, context) => {
      stop('new')
      if (context.mode !== 'tui') return
      const id = context.sessionManager.getSessionId()
      if (!id) return
      ctx = context; sessionId = id; stopped = false; retryMs = 500; mode = 'observed'; pendingInput = null
      void open(); timer = schedule(heartbeat, 500)
    })
    pi.on('session_switch', (_event, context) => { stop('resume'); if (context.mode === 'tui') { const id = context.sessionManager.getSessionId(); if (id) { ctx = context; sessionId = id; stopped = false; void open(); timer = schedule(heartbeat, 500) } } })
    pi.on('input', (event) => {
      // Never inspect text, length, metadata, or editor. Interactive submission only.
      if (event && typeof event === 'object' && (event as { source?: unknown }).source === 'interactive' && mode === 'committed') {
        pendingInput ??= issue('input')
        send('input_observed', { eventId: pendingInput })
      }
    })
    pi.on('session_shutdown', () => stop('quit'))
  }
}
