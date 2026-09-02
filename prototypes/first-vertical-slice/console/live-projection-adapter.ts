/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Foreground projection adapter for the Agent Console. Connection ownership,
 * validation, cursor handling, resnapshot, and plain-data publication stay
 * outside QML. The connector and sink are injectable so automation uses only
 * in-memory fakes.
 */

import {
  isBoundedId,
  validateEventPageBody,
  validateHelloAckBody,
  validateProjectionHello,
  validateProtocolErrorBody,
  type DecodedFrame,
  type ProjectionHelloBody,
} from '../src/protocol.ts'
import {
  COMPANION_INTENT_RESULTS,
  validateIntentEnvelope,
  type CompanionIntentResult,
} from '../companion/contracts.ts'
import {
  connectUnixSocket,
  FrameChannel,
  type FrameHandler,
} from '../src/transport.ts'
import {
  AgentConsoleProjection,
  type AgentConsoleHandoff,
} from './projection-core.ts'

export interface ProjectionChannel {
  send(type: string, messageId: string, body: Record<string, unknown>): void
  close(): void
}

export interface ProjectionConnector {
  connect(handler: FrameHandler): Promise<ProjectionChannel>
}

export type ProjectionSink = (handoff: AgentConsoleHandoff) => void

type ConnectionMode = 'initial' | 'resume' | 'recover'

interface ConnectionState {
  generation: number
  mode: ConnectionMode
  channel: ProjectionChannel
  resumeAfter: number | null
  helloAccepted: boolean
  pageAccepted: boolean
  snapshotAccepted: boolean
}

export interface ProjectionIntentAcknowledgement {
  intentId: string
  result: CompanionIntentResult
  detail: string | null
}

export interface LiveProjectionAdapterOptions {
  teamGoalId: string
  clientId: string
  connector: ProjectionConnector
  sink: ProjectionSink
  /** Reuse one projection core instance across session generations. */
  projection?: AgentConsoleProjection
  /** Invoked when a connection fails before any authoritative snapshot. */
  onPreBaselineFailure?: (error: Error) => void
  /** Invoked for every validated runner intent acknowledgement. */
  onIntentAck?: (ack: ProjectionIntentAcknowledgement) => void
}

export interface UnixLiveProjectionAdapterOptions {
  teamGoalId: string
  clientId: string
  socketPath: string
  sink: ProjectionSink
}

export class UnixProjectionConnector implements ProjectionConnector {
  private readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  async connect(handler: FrameHandler): Promise<ProjectionChannel> {
    const socket = await connectUnixSocket(this.socketPath)
    return new FrameChannel(socket, handler)
  }
}

export class LiveProjectionAdapter {
  readonly projection: AgentConsoleProjection

  private readonly teamGoalId: string
  private readonly clientId: string
  private readonly connector: ProjectionConnector
  private readonly sink: ProjectionSink
  private readonly onPreBaselineFailure: ((error: Error) => void) | null
  private readonly onIntentAck: ((ack: ProjectionIntentAcknowledgement) => void) | null
  private connection: ConnectionState | null = null
  private generation = 0
  private messageCounter = 0
  private started = false
  private stopped = false
  private errorDetail: string | null = null

  constructor(options: LiveProjectionAdapterOptions) {
    this.teamGoalId = options.teamGoalId
    this.clientId = options.clientId
    this.connector = options.connector
    this.sink = options.sink
    this.projection = options.projection ?? new AgentConsoleProjection()
    this.onPreBaselineFailure = options.onPreBaselineFailure ?? null
    this.onIntentAck = options.onIntentAck ?? null
  }

  get handoff(): AgentConsoleHandoff | null {
    return this.projection.handoff
  }

  get lastError(): string | null {
    return this.errorDetail
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('projection adapter already started')
    if (this.stopped) throw new Error('a stopped projection adapter cannot restart')
    this.started = true
    try {
      await this.replaceConnection('initial', null)
    } catch (error) {
      this.started = false
      this.errorDetail = errorMessage(error)
      throw error
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    const active = this.connection
    this.connection = null
    active?.channel.close()
  }

  /**
   * Sends one already-validated present-agent intent envelope on the current
   * authoritative connection. The adapter owns no intent policy; the caller
   * deduplicates and the runner acknowledges.
   */
  sendProjectionIntent(envelope: Record<string, unknown>): void {
    if (this.stopped) throw new Error('a stopped projection adapter cannot send intents')
    const active = this.connection
    if (active === null || !active.helloAccepted || !active.snapshotAccepted) {
      throw new Error('projection intents require an established authoritative connection')
    }
    const validated = validateIntentEnvelope(envelope)
    active.channel.send(
      'projection.intent',
      `console-${this.clientId}-${++this.messageCounter}`,
      validated as unknown as Record<string, unknown>,
    )
  }

  async retryFresh(): Promise<void> {
    if (this.stopped) throw new Error('projection adapter is stopped')
    if (this.projection.handoff?.status !== 'gap') {
      throw new Error('fresh retry is permitted only from explicit gap state')
    }
    await this.replaceConnection('recover', null)
  }

  private async replaceConnection(mode: ConnectionMode, resumeAfter: number | null): Promise<void> {
    if (this.stopped) return
    const generation = ++this.generation
    const previous = this.connection
    this.connection = null
    previous?.channel.close()

    let state: ConnectionState
    const channel = await this.connector.connect({
      onFrame: (frame) => {
        if (state !== undefined) this.receive(state, frame)
      },
      onClose: (error) => {
        if (state !== undefined) this.closed(state, error)
      },
    })
    if (this.stopped || generation !== this.generation) {
      channel.close()
      return
    }

    state = {
      generation,
      mode,
      channel,
      resumeAfter,
      helloAccepted: false,
      pageAccepted: false,
      snapshotAccepted: false,
    }
    this.connection = state
    const hello: ProjectionHelloBody = validateProjectionHello({
      teamGoalId: this.teamGoalId,
      clientId: this.clientId,
      resumeAfter,
    })
    channel.send(
      'projection.hello',
      `console-${this.clientId}-${++this.messageCounter}`,
      hello as unknown as Record<string, unknown>,
    )
  }

  private receive(state: ConnectionState, frame: DecodedFrame): void {
    if (!this.isCurrent(state)) return
    try {
      this.acceptFrame(state, frame)
    } catch (error) {
      const shouldRecover = this.projection.handoff !== null && state.mode !== 'recover'
      this.rejectConnection(state, error, shouldRecover)
    }
  }

  private acceptFrame(state: ConnectionState, frame: DecodedFrame): void {
    if (!state.helloAccepted) {
      if (frame.type !== 'hello_ack') {
        throw new Error(`projection connection expected hello_ack, received ${frame.type}`)
      }
      const hello = validateHelloAckBody(frame.body)
      if (
        hello.connectionKind !== 'projection' ||
        hello.teamGoalId !== this.teamGoalId ||
        hello.role !== null
      ) {
        throw new Error('projection hello acknowledgement identity mismatch')
      }
      state.helloAccepted = true
      return
    }

    if (frame.type === 'protocol_error') {
      const body = validateProtocolErrorBody(frame.body)
      throw new Error(`runner projection error: ${String(body.code)}: ${String(body.detail)}`)
    }

    if (frame.type === 'intent_ack' || frame.type === 'projection.intent_ack') {
      this.acceptIntentAck(frame.body)
      return
    }

    if (!state.snapshotAccepted && state.mode === 'resume' && frame.type === 'event_page') {
      const page = validateEventPageBody(frame.body)
      const expectedFrom = this.projection.handoff?.cursor
      if (expectedFrom === undefined || page.fromCursor !== expectedFrom) {
        throw new Error(
          `event page cursor ${page.fromCursor} does not continue ${String(expectedFrom)}`,
        )
      }
      for (const record of page.events) this.projection.acceptEvent(record)
      if (this.projection.handoff?.cursor !== page.toCursor) {
        throw new Error('event page toCursor does not equal the accepted projection cursor')
      }
      state.pageAccepted = true
      return
    }

    if (!state.snapshotAccepted && frame.type === 'snapshot') {
      if (state.mode === 'initial') {
        this.projection.initialize(frame.body)
      } else if (state.mode === 'resume') {
        if (!state.pageAccepted) {
          throw new Error('resume connection requires an ordered event page before snapshot')
        }
        this.projection.resnapshot(frame.body)
      } else {
        this.projection.recover(frame.body)
      }
      state.snapshotAccepted = true
      this.errorDetail = null
      this.publish()
      return
    }

    if (state.snapshotAccepted && frame.type === 'event') {
      this.projection.acceptEvent(frame.body)
      this.publish()
      const cursor = this.projection.handoff?.cursor
      if (cursor === undefined) throw new Error('accepted event did not establish a cursor')
      this.replaceDetached('resume', cursor)
      return
    }

    throw new Error(`unexpected projection frame ${frame.type}`)
  }

  private acceptIntentAck(body: Record<string, unknown>): void {
    if (!isBoundedId(body.intentId)) {
      throw new Error('projection intent acknowledgement has an invalid intentId')
    }
    if (typeof body.result !== 'string' || !(COMPANION_INTENT_RESULTS as readonly string[]).includes(body.result)) {
      throw new Error('projection intent acknowledgement has an invalid result')
    }
    const detail = body.detail === undefined || body.detail === null ? null : String(body.detail)
    this.onIntentAck?.({
      intentId: body.intentId,
      result: body.result as CompanionIntentResult,
      detail,
    })
  }

  private closed(state: ConnectionState, error: Error | null): void {
    if (!this.isCurrent(state) || this.stopped) return
    this.connection = null
    const detail = error?.message ?? 'projection connection closed'
    if (this.projection.handoff === null) {
      this.errorDetail = detail
      this.onPreBaselineFailure?.(new Error(detail))
      return
    }
    const shouldRecover = state.mode !== 'recover'
    this.enterGap(detail)
    if (shouldRecover) this.replaceDetached('recover', null)
  }

  private rejectConnection(state: ConnectionState, error: unknown, shouldRecover: boolean): void {
    if (!this.isCurrent(state)) return
    this.errorDetail = errorMessage(error)
    if (this.projection.handoff !== null) this.enterGap(this.errorDetail)
    else this.onPreBaselineFailure?.(error instanceof Error ? error : new Error(this.errorDetail))
    const generation = ++this.generation
    void generation
    this.connection = null
    state.channel.close()
    if (shouldRecover) this.replaceDetached('recover', null)
  }

  private enterGap(detail: string): void {
    if (this.projection.handoff === null) return
    this.projection.markGap(detail)
    this.publish()
  }

  private replaceDetached(mode: ConnectionMode, resumeAfter: number | null): void {
    void this.replaceConnection(mode, resumeAfter).catch((error) => {
      this.errorDetail = errorMessage(error)
      if (this.projection.handoff !== null) {
        this.enterGap(this.errorDetail)
      }
    })
  }

  private publish(): void {
    const handoff = this.projection.handoff
    if (handoff !== null) this.sink(handoff)
  }

  private isCurrent(state: ConnectionState): boolean {
    return !this.stopped &&
      state.generation === this.generation &&
      this.connection === state
  }
}

export function createUnixLiveProjectionAdapter(
  options: UnixLiveProjectionAdapterOptions,
): LiveProjectionAdapter {
  return new LiveProjectionAdapter({
    teamGoalId: options.teamGoalId,
    clientId: options.clientId,
    connector: new UnixProjectionConnector(options.socketPath),
    sink: options.sink,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
