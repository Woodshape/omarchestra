/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * thin-client.ts — the QML-facing thin projection client. It demonstrates the
 * exact authority boundary the Agent Console will have: it receives
 * snapshots, event pages and streamed events through the protocol, holds
 * projection state only in memory, and structurally cannot mutate storage
 * (its only writable frame type is its own handshake; assignment, takeover
 * and reconciliation frames are rejected by the runner and never sent here).
 *
 * This module imports only protocol and transport types. It has no storage,
 * filesystem, or runner-domain dependency.
 */

import { connectUnixSocket, FrameChannel } from './transport.ts'
import {
  validateSnapshotBody,
  validateProjectionHello,
  type DecodedFrame,
  type EventPageBody,
  type EventRecord,
  type PresentationUpdateBody,
  type ProjectionHelloBody,
  type SnapshotBody,
} from './protocol.ts'

export class ThinProjectionClient {
  private clientId: string
  private teamGoalId: string
  private socketPath: string
  private channel: FrameChannel | null = null
  private socket: import('node:net').Socket | null = null
  private receivedFrames: DecodedFrame[] = []
  private pendingFrames: DecodedFrame[] = []
  private frameWaiters: Array<{ type: string; resolve: (frame: DecodedFrame) => void; timer: NodeJS.Timeout }> = []
  private eventLog: EventRecord[] = []
  private lastSnapshot: SnapshotBody | null = null
  private lastPresentationUpdates: PresentationUpdateBody[] = []
  private messageCounter = 0
  private savedCursor: number | null = null

  constructor(teamGoalId: string, clientId: string, socketPath: string) {
    this.teamGoalId = teamGoalId
    this.clientId = clientId
    this.socketPath = socketPath
  }

  get cursor(): number | null {
    return this.savedCursor
  }

  get snapshot(): SnapshotBody | null {
    return this.lastSnapshot
  }

  get events(): EventRecord[] {
    return [...this.eventLog]
  }

  get frames(): DecodedFrame[] {
    return [...this.receivedFrames]
  }

  /**
   * Connect with a resume cursor. A null cursor requests a fresh baseline;
   * a numeric cursor requests the durable activity resume page first.
   */
  async connect(resumeAfter: number | null): Promise<void> {
    if (this.channel !== null) throw new Error('projection client is already connected')
    const socket = await connectUnixSocket(this.socketPath)
    this.socket = socket
    this.pendingFrames = []
    this.channel = new FrameChannel(socket, {
      onFrame: (frame) => this.handleFrame(frame),
      onClose: () => {
        this.channel = null
        this.socket = null
      },
    })
    const hello: ProjectionHelloBody = validateProjectionHello({
      teamGoalId: this.teamGoalId,
      clientId: this.clientId,
      resumeAfter,
    })
    this.savedCursor = resumeAfter
    this.send('projection.hello', hello)
    if (resumeAfter !== null) {
      await this.waitForFrame('event_page', 5000)
    }
    const snapshotFrame = await this.waitForFrame('snapshot', 5000)
    this.lastSnapshot = validateSnapshotBody(snapshotFrame.body)
    this.savedCursor = this.lastSnapshot.cursor
  }

  disconnect(): void {
    if (this.channel !== null) {
      this.channel.close()
      this.channel = null
    }
    if (this.socket !== null) {
      this.socket.destroy()
      this.socket = null
    }
  }

  /** Wait until the streamed event log contains the given sequence. */
  async waitForEventSequence(sequence: number, timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.eventLog.some((event) => event.sequence >= sequence)) return
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for event sequence ${sequence}`)
      }
      await this.waitForFrame('event', Math.max(1, Math.min(200, deadline - Date.now())))
    }
  }

  async waitForEventCount(count: number, timeoutMs: number = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.eventLog.length >= count) return
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${count} events; received ${this.eventLog.length}`)
      }
      await this.waitForFrame('event', Math.max(1, Math.min(200, deadline - Date.now())))
    }
  }

  async waitForQuiet(ms: number): Promise<void> {
    const before = this.receivedFrames.length
    await new Promise((resolve) => setTimeout(resolve, ms))
    if (this.receivedFrames.length !== before) {
      throw new Error('expected no further frames on the projection connection, but received more')
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    this.receivedFrames.push(frame)
    this.pendingFrames.push(frame)
    if (frame.type === 'snapshot') {
      this.lastSnapshot = validateSnapshotBody(frame.body)
      if (this.savedCursor !== null && this.savedCursor !== this.lastSnapshot.cursor) {
        throw new Error(`snapshot cursor ${this.lastSnapshot.cursor} does not follow delivered cursor ${this.savedCursor}`)
      }
      this.savedCursor = this.lastSnapshot.cursor
    } else if (frame.type === 'event') {
      this.appendEvent(frame.body as unknown as EventRecord)
    } else if (frame.type === 'event_page') {
      const page = frame.body as unknown as EventPageBody
      if (this.savedCursor === null || page.fromCursor !== this.savedCursor) {
        throw new Error(`event page starts at ${page.fromCursor}, expected ${String(this.savedCursor)}`)
      }
      for (const event of page.events) this.appendEvent(event)
      if (this.savedCursor !== page.toCursor) throw new Error('event page cursor does not match delivered events')
    } else if (frame.type === 'presentation_update') {
      this.lastPresentationUpdates.push(frame.body as unknown as PresentationUpdateBody)
    }
    for (let i = this.frameWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.frameWaiters[i]
      if (waiter.type === frame.type) {
        clearTimeout(waiter.timer)
        this.frameWaiters.splice(i, 1)
        waiter.resolve(frame)
      }
    }
  }

  private appendEvent(event: EventRecord): void {
    if (this.savedCursor === null || event.sequence !== this.savedCursor + 1) {
      throw new Error(`event sequence ${event.sequence} does not strictly follow cursor ${String(this.savedCursor)}`)
    }
    if (this.eventLog.some((existing) => existing.sequence === event.sequence || existing.eventId === event.eventId)) {
      throw new Error(`duplicate projection event ${event.sequence}/${event.eventId}`)
    }
    this.eventLog.push(event)
    this.savedCursor = event.sequence
  }

  private waitForFrame(type: string, timeoutMs: number): Promise<DecodedFrame> {
    const index = this.pendingFrames.findIndex((frame) => frame.type === type)
    if (index !== -1) return Promise.resolve(this.pendingFrames.splice(index, 1)[0])
    return new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.frameWaiters.findIndex((waiter) => waiter.timer === timer)
        if (waiterIndex !== -1) this.frameWaiters.splice(waiterIndex, 1)
        reject(new Error(`timed out waiting for a ${type} frame on the projection connection`))
      }, timeoutMs)
      this.frameWaiters.push({ type, resolve, timer })
    })
  }

  private send(type: string, body: Record<string, unknown>): void {
    if (this.socket === null) throw new Error('projection client is not connected')
    const messageId = `projection-${this.clientId}-${++this.messageCounter}`
    this.socket.write(
      `${JSON.stringify({ protocol: 'omarchestra.first-vertical-slice/v1', type, messageId, body })}\n`,
    )
  }
}