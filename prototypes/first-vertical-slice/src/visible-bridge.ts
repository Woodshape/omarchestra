/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * visible-bridge.ts — the visible-host bridge port and its automation fake.
 * The fake represents the visible interactive Pi host with our bridge
 * extension loaded: it connects over the real owner-only Unix socket with a
 * full identity tuple, receives managed assignments, performs exactly one
 * fake same-host visible turn per accepted assignment ID (no model work, no
 * process creation, no PTY input, no terminal scraping), and emits
 * interactive-input takeover events.
 *
 * This is presentation/automation only. It is not an agent implementation.
 */

import { connectUnixSocket, FrameChannel } from './transport.ts'
import {
  validateBridgeHello,
  validateSnapshotBody,
  type AssignmentAckBody,
  type BridgeEventBody,
  type BridgeHelloBody,
  type DecodedFrame,
  type PresentationUpdateBody,
  type Role,
  type SnapshotBody,
} from './protocol.ts'

export interface VisibleHostIdentity {
  teamGoalId: string
  role: Role
  agentRunId: string
  terminalSessionRef: string
  piSessionId: string
  extensionInstanceId: string
  hostPid: number
  shellRunId: string
}

export interface FakeVisibleTurn {
  assignmentId: string
  prompt: string
  role: Role
  recordedAt: string
}

export class FakeVisibleBridge {
  private identity: VisibleHostIdentity
  private socketPath: string
  private channel: FrameChannel | null = null
  private socket: import('node:net').Socket | null = null
  private receivedFrames: DecodedFrame[] = []
  private pendingFrames: DecodedFrame[] = []
  private frameWaiters: Array<{ type: string; resolve: (frame: DecodedFrame) => void; timer: NodeJS.Timeout }> = []
  private acks: AssignmentAckBody[] = []
  private ackWaiters: Array<{ status: string; resolve: () => void; timer: NodeJS.Timeout }> = []
  private turns: FakeVisibleTurn[] = []
  private acceptedIds = new Set<string>()
  private lastSnapshot: SnapshotBody | null = null
  private lastPresentationUpdate: PresentationUpdateBody | null = null
  private messageCounter = 0
  private sourceSequenceCounter = 0
  private disconnected = false

  constructor(identity: VisibleHostIdentity, socketPath: string) {
    this.identity = identity
    this.socketPath = socketPath
  }

  get role(): Role {
    return this.identity.role
  }

  get deliveredTurns(): number {
    return this.turns.length
  }

  get visibleTurns(): FakeVisibleTurn[] {
    return [...this.turns]
  }

  get sentAcks(): AssignmentAckBody[] {
    return [...this.acks]
  }

  get snapshot(): SnapshotBody | null {
    return this.lastSnapshot
  }

  get presentationUpdate(): PresentationUpdateBody | null {
    return this.lastPresentationUpdate
  }

  get acceptedAssignmentIds(): string[] {
    return [...this.acceptedIds]
  }

  /** Connect to the runner socket and complete the bridge handshake. */
  async connect(): Promise<void> {
    if (this.channel !== null) throw new Error('fake bridge is already connected')
    const socket = await connectUnixSocket(this.socketPath)
    this.socket = socket
    this.disconnected = false
    this.pendingFrames = []
    this.channel = new FrameChannel(socket, {
      onFrame: (frame) => this.handleFrame(frame),
      onClose: (error) => this.onDisconnect(error),
    })
    const hello: BridgeHelloBody = validateBridgeHello({
      teamGoalId: this.identity.teamGoalId,
      role: this.identity.role,
      agentRunId: this.identity.agentRunId,
      terminalSessionRef: this.identity.terminalSessionRef,
      piSessionId: this.identity.piSessionId,
      extensionInstanceId: this.identity.extensionInstanceId,
      hostPid: this.identity.hostPid,
      hostMode: 'tui',
      shellRunId: this.identity.shellRunId,
    })
    this.sendFrame('bridge.hello', hello)
    await this.waitForFrame('hello_ack', 5000)
    const snapshotFrame = await this.waitForFrame('snapshot', 5000)
    this.lastSnapshot = validateSnapshotBody(snapshotFrame.body)
    const updateFrame = await this.waitForFrame('presentation_update', 5000)
    this.lastPresentationUpdate = updateFrame.body as unknown as PresentationUpdateBody
  }

  /** Close the socket without discarding accepted-assignment memory. */
  disconnect(): void {
    this.disconnected = true
    if (this.channel !== null) {
      this.channel.close()
      this.channel = null
    }
    if (this.socket !== null) {
      this.socket.destroy()
      this.socket = null
    }
  }

  /** Send one explicit assignment acknowledgement through the bridge protocol. */
  sendAssignmentAcknowledgement(assignmentId: string, ack: AssignmentAckBody['ack']): void {
    this.sendFrame('bridge.assignment_ack', { assignmentId, ack })
  }

  /** Wait for a runner protocol error, used by authorization acceptance checks. */
  async waitForProtocolError(timeoutMs: number = 5000): Promise<DecodedFrame> {
    return this.waitForFrame('protocol_error', timeoutMs)
  }

  /** Simulate a submitted interactive human input in the visible host. */
  submitInteractiveInput(text: string): void {
    const event: BridgeEventBody = {
      eventId: `input-${this.identity.extensionInstanceId}-${++this.sourceSequenceCounter}`,
      sequence: this.sourceSequenceCounter,
      eventType: 'human_input_submitted',
      payload: { inputSource: 'interactive', charCount: text.length },
    }
    this.sendFrame('bridge.event', event)
  }

  /** Wait until the runner delivers an assignment frame to this bridge. */
  async waitForAssignment(timeoutMs: number = 5000): Promise<DecodedFrame> {
    return this.waitForFrame('assignment', timeoutMs)
  }

  /** Resolve when an ack with the expected status has been sent; reject on timeout. */
  async waitForAck(status: AssignmentAckBody['ack'], timeoutMs: number = 5000): Promise<AssignmentAckBody> {
    const existing = this.acks.find((ack) => ack.ack === status)
    if (existing !== undefined) return existing
    return new Promise<AssignmentAckBody>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.ackWaiters.findIndex((waiter) => waiter.timer === timer)
        if (index !== -1) this.ackWaiters.splice(index, 1)
        reject(new Error(`timed out waiting for a ${status} acknowledgement on ${this.identity.role}`))
      }, timeoutMs)
      this.ackWaiters.push({
        status,
        resolve: () => {
          const ack = this.acks.find((entry) => entry.ack === status)
          if (ack !== undefined) resolve(ack)
        },
        timer,
      })
    })
  }

  /** Wait until a presentation update whose title carries the state arrives. */
  async waitForPresentationState(state: string, timeoutMs: number = 5000): Promise<PresentationUpdateBody> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const update = this.lastPresentationUpdate
      if (update !== null && update.nativeTerminalTitle.endsWith(` — ${state}`)) return update
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for presentation state ${state} on ${this.identity.role}`)
      }
      await this.waitForFrame('presentation_update', Math.max(1, Math.min(200, deadline - Date.now())))
    }
  }

  async waitForQuiet(ms: number): Promise<void> {
    const before = this.receivedFrames.length
    await new Promise((resolve) => setTimeout(resolve, ms))
    const after = this.receivedFrames.length
    if (after !== before) throw new Error(`expected no further frames on ${this.identity.role}, but received more`)
  }

  private handleFrame(frame: DecodedFrame): void {
    this.receivedFrames.push(frame)
    this.pendingFrames.push(frame)
    if (frame.type === 'snapshot') {
      this.lastSnapshot = validateSnapshotBody(frame.body)
    } else if (frame.type === 'presentation_update') {
      this.lastPresentationUpdate = frame.body as unknown as PresentationUpdateBody
    } else if (frame.type === 'assignment') {
      this.handleAssignment(frame)
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

  private takePending(type: string): DecodedFrame | null {
    const index = this.pendingFrames.findIndex((frame) => frame.type === type)
    if (index === -1) return null
    return this.pendingFrames.splice(index, 1)[0]
  }

  /**
   * Fake visible-host assignment handling: an unseen assignment ID triggers
   * exactly one fake same-host visible turn plus an `accepted` acknowledgement;
   * a replayed ID triggers no turn and a `duplicate` acknowledgement.
   */
  private handleAssignment(frame: DecodedFrame): void {
    const body = frame.body as { assignmentId?: unknown; prompt?: unknown }
    if (typeof body.assignmentId !== 'string' || typeof body.prompt !== 'string') {
      this.recordAck({ assignmentId: '', ack: 'invalid' })
      return
    }
    const assignmentId = body.assignmentId
    if (this.acceptedIds.has(assignmentId)) {
      // Replay: no second visible turn.
      this.recordAck({ assignmentId, ack: 'duplicate' })
      return
    }
    this.acceptedIds.add(assignmentId)
    this.turns.push({
      assignmentId,
      prompt: body.prompt,
      role: this.identity.role,
      recordedAt: new Date().toISOString(),
    })
    this.recordAck({ assignmentId, ack: 'accepted' })
  }

  private recordAck(ack: AssignmentAckBody): void {
    this.acks.push(ack)
    // The acknowledgement frame is sent to the runner; the local record drives
    // waitForAck and the acceptance assertions.
    this.sendFrame('bridge.assignment_ack', { assignmentId: ack.assignmentId, ack: ack.ack })
    for (let i = this.ackWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.ackWaiters[i]
      if (this.acks.some((entry) => entry.ack === waiter.status)) {
        clearTimeout(waiter.timer)
        this.ackWaiters.splice(i, 1)
        waiter.resolve()
      }
    }
  }

  private waitForFrame(type: string, timeoutMs: number): Promise<DecodedFrame> {
    const pending = this.takePending(type)
    if (pending !== null) return Promise.resolve(pending)
    return new Promise<DecodedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.frameWaiters.findIndex((waiter) => waiter.timer === timer)
        if (index !== -1) this.frameWaiters.splice(index, 1)
        reject(new Error(`timed out waiting for a ${type} frame on ${this.identity.role}`))
      }, timeoutMs)
      this.frameWaiters.push({ type, resolve, timer })
    })
  }

  private sendFrame(type: string, body: Record<string, unknown>): void {
    if (this.socket === null || this.disconnected) {
      throw new Error(`fake bridge for ${this.identity.role} is not connected`)
    }
    const messageId = `fake-${this.identity.role}-${++this.messageCounter}`
    const line = JSON.stringify({
      protocol: 'omarchestra.first-vertical-slice/v1',
      type,
      messageId,
      body,
    })
    this.socket.write(`${line}\n`)
  }

  private onDisconnect(error: Error | null): void {
    this.channel = null
    this.socket = null
    if (error !== null && !this.disconnected) {
      // Unexpected socket failure: recorded, not retried by the fake.
      this.receivedFrames.push({
        type: 'protocol_error',
        messageId: `local-disconnect-${++this.messageCounter}`,
        body: { code: 'disconnected', detail: error.message },
      })
    }
  }
}