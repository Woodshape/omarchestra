/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Owner-only Unix-socket transport for the observation-only Pi bridge. This
 * module uses only filesystem Unix sockets, the bounded observer NDJSON frame
 * channel, and exact device/inode cleanup. It never opens a TCP listener,
 * starts a process, reads Pi content, or mutates a Companion installation.
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import type {
  ObserverConnection,
  ObserverFrameHandler,
} from '../observer/extension-adapter.ts'
import type { ObserverFrame } from '../observer/contracts.ts'
import {
  LiveFrameChannel,
  type DuplexStream,
} from '../observer/live-frame-channel.ts'

const SOCKET_MODE = 0o600
const SOCKET_PATH_MAX_CHARACTERS = 100

type CloseHandler = (error?: unknown) => void

export interface ObserverSocketIdentity {
  readonly device: bigint
  readonly inode: bigint
}

export type ObserverSocketConnectionHandler = (socket: net.Socket) => void

/**
 * Owner-only observer connection returned to createObserverExtension. The
 * channel owns framing; this wrapper owns adapter callback registration.
 */
export class ObserverSocketConnection implements ObserverConnection {
  private readonly channel: LiveFrameChannel
  private frameHandler: ObserverFrameHandler | null = null
  private readonly closeHandlers = new Set<CloseHandler>()
  private closedValue = false

  constructor(socket: net.Socket, initialHandler?: ObserverFrameHandler) {
    this.frameHandler = initialHandler ?? null
    this.channel = new LiveFrameChannel(socket as unknown as DuplexStream, {
      onFrame: (frame) => {
        this.frameHandler?.(frame)
      },
      onClose: (error) => {
        this.notifyClose(error)
      },
    })
  }

  get closed(): boolean {
    return this.closedValue || this.channel.isClosed
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    if (this.closed) throw new Error('observer socket connection is closed')
    this.channel.send(type, messageId, body)
  }

  sendFrame(frame: ObserverFrame): void {
    this.send(frame.type, frame.messageId, frame.body)
  }

  bind(handler: ObserverFrameHandler): () => void {
    return this.onFrame(handler)
  }

  onFrame(handler: ObserverFrameHandler): () => void {
    if (typeof handler !== 'function') throw new TypeError('observer frame handler must be a function')
    this.frameHandler = handler
    return () => {
      if (this.frameHandler === handler) this.frameHandler = null
    }
  }

  onClose(handler: CloseHandler): () => void {
    if (typeof handler !== 'function') throw new TypeError('observer close handler must be a function')
    if (this.closedValue) {
      handler()
      return () => {}
    }
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onDisconnect(handler: CloseHandler): () => void {
    return this.onClose(handler)
  }

  close(): void {
    if (this.closedValue) return
    this.closedValue = true
    this.channel.close()
    this.notifyClose(null)
  }

  private notifyClose(error: Error | null): void {
    if (this.closedValue && this.closeHandlers.size === 0) return
    this.closedValue = true
    const handlers = [...this.closeHandlers]
    this.closeHandlers.clear()
    for (const handler of handlers) {
      try {
        handler(error)
      } catch {
        // A close observer cannot prevent the socket from being retired.
      }
    }
  }
}

/**
 * A Unix-domain observer listener. It refuses all pre-existing endpoint paths
 * and removes the endpoint only when its captured device/inode still matches.
 */
export class ObserverUnixSocketServer {
  private readonly socketPath: string
  private onConnection: ObserverSocketConnectionHandler
  private server: net.Server | null = null
  private socketIdentity: ObserverSocketIdentity | null = null
  private readonly sockets = new Set<net.Socket>()
  private closePromise: Promise<void> | null = null

  constructor(socketPath: string, onConnection: ObserverSocketConnectionHandler) {
    this.socketPath = normalizeSocketPath(socketPath)
    if (typeof onConnection !== 'function') throw new TypeError('observer socket connection handler is required')
    this.onConnection = onConnection
  }

  get path(): string {
    return this.socketPath
  }

  get identity(): ObserverSocketIdentity | null {
    return this.socketIdentity
  }

  /** Replace the transport callback before start. */
  setConnectionHandler(onConnection: ObserverSocketConnectionHandler): void {
    if (this.server !== null) throw new Error('observer socket handler cannot change after start')
    if (typeof onConnection !== 'function') throw new TypeError('observer socket connection handler is required')
    this.onConnection = onConnection
  }

  async start(): Promise<void> {
    if (this.server !== null) throw new Error('observer socket server is already started')
    assertNoSymlinkAncestors(this.socketPath)
    refuseExistingPath(this.socketPath)

    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
      try {
        this.onConnection(socket)
      } catch {
        socket.destroy()
      }
    })
    this.server = server
    try {
      await listenUnix(server, this.socketPath)
      const identity = captureSocketIdentity(this.socketPath)
      this.socketIdentity = identity
      assertOwnerOnlySocket(this.socketPath, identity)
    } catch (error) {
      if (this.socketIdentity !== null) {
        try {
          await this.close()
        } catch {
          // Preserve the original start failure. Cleanup remains fail-closed.
        }
      } else {
        // Without a captured identity, server.close() could unlink a path
        // changed by another owner between listen and verification.
        for (const socket of this.sockets) socket.destroy()
        this.sockets.clear()
        server.unref()
        this.server = null
      }
      throw error
    }
  }

  /**
   * Close active connections and the listener, then remove only the exact
   * endpoint created by this instance. A substituted path is never unlinked.
   */
  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise
    this.closePromise = this.closeOnce()
    try {
      await this.closePromise
    } finally {
      this.closePromise = null
    }
  }

  private async closeOnce(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    let unsafeSubstitution: Error | null = null
    let endpointGone = false
    if (this.socketIdentity !== null) {
      try {
        endpointGone = !assertSocketStillOwned(this.socketPath, this.socketIdentity)
      } catch (error) {
        unsafeSubstitution = asError(error)
      }
    }

    if (server !== null) {
      if (unsafeSubstitution !== null || endpointGone) {
        // Node may unlink the current pathname when server.close() runs. Keep
        // the listener unreferenced instead of authorizing a substituted or
        // newly-created endpoint. The foreground process can exit safely.
        server.unref()
      } else {
        await closeServer(server)
      }
    }

    if (unsafeSubstitution !== null) throw unsafeSubstitution
    if (this.socketIdentity !== null) {
      if (!endpointGone) removeSocketExact(this.socketPath, this.socketIdentity)
      this.socketIdentity = null
    }
  }
}

/** Connect a Pi observer to an owner-only Unix socket. */
export function connectObserverSocket(
  socketPath: string,
  handler: ObserverFrameHandler,
): Promise<ObserverConnection> {
  const exactPath = normalizeSocketPath(socketPath)
  if (typeof handler !== 'function') return Promise.reject(new TypeError('observer frame handler is required'))

  let expectedIdentity: ObserverSocketIdentity
  try {
    expectedIdentity = inspectOwnerOnlySocket(exactPath)
  } catch (error) {
    return Promise.reject(error)
  }

  return new Promise<ObserverConnection>((resolve, reject) => {
    const socket = net.createConnection({ path: exactPath })
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(asError(error))
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      try {
        const currentIdentity = inspectOwnerOnlySocket(exactPath)
        if (!sameSocketIdentity(expectedIdentity, currentIdentity)) {
          throw new Error('observer socket device/inode changed during connection')
        }
        const connection = new ObserverSocketConnection(socket, handler)
        settled = true
        resolve(connection)
      } catch (error) {
        fail(error)
      }
    })
  })
}

/** Explicit aliases for callers that name the endpoint as an observer socket. */
export const UnixObserverSocketServer = ObserverUnixSocketServer
export const connectUnixObserverSocket = connectObserverSocket

function normalizeSocketPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > SOCKET_PATH_MAX_CHARACTERS) {
    throw new Error(`observer socket path must contain 1–${SOCKET_PATH_MAX_CHARACTERS} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(input) || !path.isAbsolute(input)) {
    throw new Error('observer socket path must be absolute and contain no control characters')
  }
  const normalized = path.normalize(input)
  if (normalized !== input || normalized === path.parse(normalized).root) {
    throw new Error('observer socket path must be canonical and not a filesystem root')
  }
  return normalized
}

function refuseExistingPath(socketPath: string): void {
  try {
    fs.lstatSync(socketPath)
    throw new Error(`refusing to replace an existing observer socket path: ${socketPath}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

function assertNoSymlinkAncestors(socketPath: string): void {
  const root = path.parse(socketPath).root
  const parent = path.dirname(socketPath)
  const relative = path.relative(root, parent)
  let current = root
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      throw new Error(`observer socket ancestor is unavailable: ${current}: ${asError(error).message}`)
    }
    if (stat.isSymbolicLink()) throw new Error(`observer socket ancestor is a symbolic link: ${current}`)
    if (!stat.isDirectory()) throw new Error(`observer socket ancestor is not a directory: ${current}`)
  }
}

function listenUnix(server: net.Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      // Keep later local errors from becoming uncaught events while the
      // endpoint identity and owner/mode checks finish.
      server.on('error', () => {})
      try {
        fs.chmodSync(socketPath, SOCKET_MODE)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(socketPath)
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    }
    server.once('error', finish)
    try {
      server.close(() => finish())
    } catch (error) {
      finish(asError(error))
    }
  })
}

function captureSocketIdentity(socketPath: string): ObserverSocketIdentity {
  const stat = fs.lstatSync(socketPath, { bigint: true })
  if (!stat.isSocket()) throw new Error(`observer endpoint is not a Unix socket: ${socketPath}`)
  return { device: stat.dev, inode: stat.ino }
}

function inspectOwnerOnlySocket(socketPath: string): ObserverSocketIdentity {
  assertNoSymlinkAncestors(socketPath)
  const identity = captureSocketIdentity(socketPath)
  assertOwnerOnlySocket(socketPath, identity)
  return identity
}

function assertOwnerOnlySocket(socketPath: string, identity: ObserverSocketIdentity): void {
  const stat = fs.lstatSync(socketPath, { bigint: true })
  if (!stat.isSocket() || stat.dev !== identity.device || stat.ino !== identity.inode) {
    throw new Error(`observer endpoint is not the captured Unix socket: ${socketPath}`)
  }
  const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null
  if (uid === null || stat.uid !== uid) {
    throw new Error(`observer socket is not owned by the current user: ${socketPath}`)
  }
  if ((stat.mode & 0o7777n) !== BigInt(SOCKET_MODE)) {
    throw new Error(`observer socket is not owner-only: ${socketPath}`)
  }
}

function assertSocketStillOwned(socketPath: string, expected: ObserverSocketIdentity): boolean {
  assertNoSymlinkAncestors(socketPath)
  let current: ObserverSocketIdentity
  try {
    current = captureSocketIdentity(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!sameSocketIdentity(expected, current)) {
    throw new Error(`observer socket device/inode changed: ${socketPath}`)
  }
  assertOwnerOnlySocket(socketPath, expected)
  return true
}

function removeSocketExact(socketPath: string, expected: ObserverSocketIdentity): void {
  assertSocketStillOwned(socketPath, expected)
  try {
    const stat = fs.lstatSync(socketPath, { bigint: true })
    if (!stat.isSocket() || stat.dev !== expected.device || stat.ino !== expected.inode) {
      throw new Error(`refusing to remove a substituted observer socket: ${socketPath}`)
    }
    fs.unlinkSync(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

function sameSocketIdentity(left: ObserverSocketIdentity, right: ObserverSocketIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
