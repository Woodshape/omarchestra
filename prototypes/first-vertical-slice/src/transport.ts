/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * transport.ts — bounded NDJSON framing over an owner-only Unix-domain socket
 * plus an injected stream boundary for a future authenticated SSH-stdio
 * transport. This module performs no process creation, opens no TCP listener,
 * and never touches storage. Only filesystem Unix socket paths are used.
 */

import fs from 'node:fs'
import net from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { NdjsonDecoder, ProtocolError, encodeFrame, type DecodedFrame } from './protocol.ts'

export interface FrameHandler {
  onFrame(frame: DecodedFrame): void
  onClose(error: Error | null): void
}

/**
 * One framed connection over a duplex socket. Sends are envelope-validated
 * and size-bounded; receives are decoded with a bounded buffer.
 */
export class FrameChannel {
  private socket: net.Socket
  private handler: FrameHandler
  private decoder = new NdjsonDecoder()
  private closed = false

  constructor(socket: net.Socket, handler: FrameHandler) {
    this.socket = socket
    this.handler = handler
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      let frames: DecodedFrame[]
      try {
        frames = this.decoder.push(chunk)
      } catch (error) {
        this.fail(error)
        return
      }
      for (const frame of frames) {
        try {
          this.handler.onFrame(frame)
        } catch (error) {
          this.fail(error)
          return
        }
      }
    })
    socket.on('error', (error: Error) => {
      if (!this.closed) this.handler.onClose(error)
      this.closed = true
    })
    socket.on('close', (hadError: boolean) => {
      if (!this.closed) this.handler.onClose(hadError ? new Error('connection closed after error') : null)
      this.closed = true
    })
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    if (this.closed || this.socket.destroyed) {
      throw new ProtocolError('connection_closed', 'cannot send on a closed connection')
    }
    this.socket.write(encodeFrame(type, messageId, body))
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.socket.destroy()
    }
  }

  get remoteInfo(): string {
    return `unix:${this.socket.remotePath ?? 'unknown'}`
  }

  private fail(error: unknown): void {
    if (!this.closed) {
      this.closed = true
      this.handler.onClose(error instanceof Error ? error : new Error(String(error)))
    }
    this.socket.destroy()
  }
}

/**
 * Owner-only Unix-socket listener. Refuses an existing socket path instead of
 * unlinking it; chmods the socket to 0600 after listen and reads the mode
 * back to verify.
 */
export class UnixSocketServer {
  private socketPath: string
  private onConnection: (raw: net.Socket) => void
  private server: net.Server | null = null

  constructor(socketPath: string, onConnection: (raw: net.Socket) => void) {
    this.socketPath = socketPath
    this.onConnection = onConnection
  }

  async start(): Promise<void> {
    let existing: fs.Stats | null = null
    try {
      existing = fs.lstatSync(this.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== null) {
      throw new Error(`refusing to replace an existing socket path: ${this.socketPath}`)
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      this.server = server
      server.on('connection', (socket) => {
        this.onConnection(socket)
      })
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.removeListener('error', reject)
        server.on('error', () => {})
        resolve()
      })
    })
    fs.chmodSync(this.socketPath, 0o600)
    const verified = fs.lstatSync(this.socketPath)
    if (!verified.isSocket()) throw new Error(`socket path ${this.socketPath} is not a socket after listen`)
    if (process.getuid !== undefined && verified.uid !== process.getuid()) {
      throw new Error(`socket ${this.socketPath} is not owned by the current user`)
    }
    if ((verified.mode & 0o777) !== 0o600) {
      throw new Error(`socket ${this.socketPath} is not owner-only after chmod (mode ${(verified.mode & 0o777).toString(8)})`)
    }
  }

  /** Replace the per-connection handler after construction (runner wiring). */
  setConnectionHandler(onConnection: (raw: net.Socket) => void): void {
    this.onConnection = onConnection
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === null) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    this.server = null
    let st: fs.Stats | null = null
    try {
      st = fs.lstatSync(this.socketPath)
    } catch {
      st = null
    }
    if (st !== null && st.isSocket()) {
      fs.unlinkSync(this.socketPath)
    }
  }
}

/** Connect a client to a filesystem Unix socket path (Unix only, no TCP). */
export function connectUnixSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', (error) => reject(error))
  })
}

// ---------------------------------------------------------------------------
// SSH-stdio seam: an interface over injected streams. Nothing here spawns,
// imports, or invokes SSH; automation supplies fake duplex streams only.
// ---------------------------------------------------------------------------

export interface SshStdioTransport {
  readonly stdin: Readable
  readonly stdout: Writable
}

/**
 * Attach the same bounded frame codec to an injected SSH-stdio-shaped
 * transport. The transport is fully provided by the caller; this function
 * creates no processes and owns no lifetime beyond the returned channel.
 */
export function attachFrameChannelToStreams(transport: SshStdioTransport, handler: FrameHandler): StreamFrameChannel {
  return new StreamFrameChannel(transport, handler)
}

export class StreamFrameChannel {
  private decoder = new NdjsonDecoder()
  private handler: FrameHandler
  private closed = false
  private transport: SshStdioTransport

  constructor(transport: SshStdioTransport, handler: FrameHandler) {
    this.transport = transport
    this.handler = handler
    transport.stdin.setEncoding('utf8')
    transport.stdin.on('data', (chunk: string) => {
      let frames: DecodedFrame[]
      try {
        frames = this.decoder.push(chunk)
      } catch (error) {
        this.fail(error)
        return
      }
      for (const frame of frames) {
        try {
          this.handler.onFrame(frame)
        } catch (error) {
          this.fail(error)
          return
        }
      }
    })
    transport.stdin.on('error', (error: Error) => this.fail(error))
    transport.stdin.on('end', () => this.fail(null))
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    if (this.closed) throw new ProtocolError('connection_closed', 'cannot send on a closed stream transport')
    this.transport.stdout.write(encodeFrame(type, messageId, body))
  }

  close(): void {
    this.closed = true
  }

  private fail(error: Error | null): void {
    if (!this.closed) {
      this.closed = true
      this.handler.onClose(error)
    }
  }
}

// The SSH-stdio seam intentionally shares the FrameChannel handler shape.
// attachFrameChannelToStreams returns a StreamFrameChannel which satisfies
// the same send/close contract the socket channel exposes to clients.
export type AnyFrameChannel = FrameChannel | StreamFrameChannel