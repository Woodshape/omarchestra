/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-frame-channel.ts — bounded NDJSON observer frame channel over an
 * injected duplex stream. It decodes incoming bytes into validated
 * `omarchestra.observer/v1` frames and encodes outgoing frames, reusing the
 * pure observer codec in `contracts.ts`. It performs no socket, process, or
 * filesystem I/O; the stream is fully provided by the caller. Malformed,
 * oversized, or partial-buffer-overflow input fails the channel closed.
 *
 * This is the transport framing half of the observation-only live bridge. The
 * semantic gateway (`live-gateway-core.ts`) consumes the decoded frames; the
 * manual Unix-socket layer injects a real `net.Socket` as the stream.
 */

import {
  encodeFrame,
  NdjsonDecoder,
  type ObserverFrame,
} from './contracts.ts'

export interface FrameChannelHandler {
  onFrame(frame: ObserverFrame): void
  onClose(error: Error | null): void
}

/** The minimal duplex stream surface the channel needs. */
export interface DuplexStream {
  setEncoding(encoding: string): void
  on(event: 'data', listener: (chunk: string) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: () => void): void
  write(data: string): void
  destroy(): void
}

/**
 * One framed observer connection over an injected duplex stream. Sends are
 * envelope-validated and size-bounded; receives are decoded with a bounded
 * buffer. A decode or handler failure closes the channel and reports the
 * error to the handler.
 */
export class LiveFrameChannel {
  private readonly stream: DuplexStream
  private readonly handler: FrameChannelHandler
  private readonly decoder = new NdjsonDecoder()
  private closed = false

  constructor(stream: DuplexStream, handler: FrameChannelHandler) {
    this.stream = stream
    this.handler = handler
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      let frames: ObserverFrame[]
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
    stream.on('error', (error) => this.fail(error))
    stream.on('close', () => this.fail(null))
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    if (this.closed) throw new Error('observer frame channel is closed')
    this.stream.write(encodeFrame(type, messageId, body))
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.stream.destroy()
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  private fail(error: unknown): void {
    if (!this.closed) {
      this.closed = true
      this.handler.onClose(error === null ? null : error instanceof Error ? error : new Error(String(error)))
    }
    this.stream.destroy()
  }
}
