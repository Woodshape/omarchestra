/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * runner.ts — the sole composition point joining the store, domain
 * transitions, transport, visible bridges and projection clients. The runner
 * is control-plane infrastructure: it never starts agents, never spawns
 * processes, and never injects terminal input.
 *
 * All socket-driven operations run on the single Node event loop with
 * synchronous transactional store calls, which gives the serialized runner
 * operation boundary required by the cursor/reconnect semantics.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Domain } from './domain.ts'
import { buildPresentationUpdate } from './presentation.ts'
import type { EventRecord, Role, SnapshotBody } from './protocol.ts'
import { MAX_EVENTS_PER_PAGE, validateAssignmentAck, validateBridgeEvent, validateBridgeHello, validateProjectionHello } from './protocol.ts'
import { FrameChannel, UnixSocketServer } from './transport.ts'

interface Session {
  kind: 'pending' | 'bridge' | 'projection'
  channel: FrameChannel
  role: Role | null
  lastSentSequence: number
}

export interface RunnerOptions {
  stateDir: string
  journal: 'default' | 'wal'
  socketName?: string
  /** True when this process created the Team Goal (no restart marker then). */
  freshBootstrap?: boolean
  onEvent?: (record: { kind: string; detail: string }) => void
}

export class Runner {
  private options: RunnerOptions
  private domain: Domain
  private server: UnixSocketServer
  private sessions: Set<Session> = new Set()
  private bridgeSessions = new Map<Role, Session>()
  private projectionSessions = new Set<Session>()
  private socketPath: string
  private started = false

  constructor(domain: Domain, options: RunnerOptions) {
    this.options = options
    this.domain = domain
    const socketName = options.socketName ?? 'runner.sock'
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(socketName) || socketName === '.' || socketName === '..') {
      throw new Error('runner socket name must be one bounded filename, not a path')
    }
    this.socketPath = path.join(options.stateDir, socketName)
    this.server = new UnixSocketServer(this.socketPath, (socket) => {
      const session: Session = {
        kind: 'pending',
        channel: new FrameChannel(socket, {
          onFrame: (frame) => this.handleFrame(session, frame),
          onClose: (error) => this.handleClose(session, error),
        }),
        role: null,
        lastSentSequence: 0,
      }
      this.sessions.add(session)
    })
  }

  get journalReport() {
    return this.domain.store.journal
  }

  get mountInfo() {
    return this.domain.store.mountInfo
  }

  get schemaVersion(): number {
    return this.domain.store.schemaVersion
  }

  get socketFile(): string {
    return this.socketPath
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('runner already started')
    const goal = this.domain.store.getGoal()
    if (goal !== null && this.options.freshBootstrap !== true) {
      // A runner restart over an existing durable state records the boundary.
      this.domain.markRunnerRestarted(goal.id, process.pid)
    }
    await this.server.start()
    this.started = true
  }

  async stop(): Promise<void> {
    for (const session of [...this.sessions]) {
      this.handleClose(session, null)
    }
    await this.server.close()
    this.started = false
  }

  private handleClose(session: Session, error: Error | null): void {
    this.sessions.delete(session)
    if (session.kind === 'bridge' && session.role !== null && this.bridgeSessions.get(session.role) === session) {
      this.bridgeSessions.delete(session.role)
    }
    if (session.kind === 'projection') {
      this.projectionSessions.delete(session)
    }
    try {
      session.channel.close()
    } catch {
      // closing twice is a no-op
    }
    void error
  }

  private send(session: Session, type: string, body: Record<string, unknown>): void {
    session.channel.send(type, `runner-${type}-${++Runner.messageCounter}`, body)
  }

  private static messageCounter = 0

  private handleFrame(session: Session, frame: { type: string; messageId: string; body: Record<string, unknown> }): void {
    if (session.kind === 'pending') {
      this.handleFirstFrame(session, frame)
      return
    }
    if (session.kind === 'bridge') {
      this.handleBridgeFrame(session, frame)
      return
    }
    // Projection connections accept no further client frames.
    this.send(session, 'protocol_error', {
      code: 'unexpected_frame',
      detail: 'projection connections may send only the initial handshake',
    })
    session.channel.close()
    this.handleClose(session, null)
  }

  private handleFirstFrame(session: Session, frame: { type: string; body: Record<string, unknown> }): void {
    if (frame.type === 'bridge.hello') {
      this.handleBridgeHello(session, validateBridgeHello(frame.body))
      return
    }
    if (frame.type === 'projection.hello') {
      this.handleProjectionHello(session, validateProjectionHello(frame.body))
      return
    }
    this.send(session, 'protocol_error', {
      code: 'invalid_handshake_order',
      detail: 'the first frame on every connection must be a bridge.hello or projection.hello',
    })
    session.channel.close()
    this.handleClose(session, null)
  }

  private handleBridgeHello(session: Session, hello: ReturnType<typeof validateBridgeHello>): void {
    const goal = this.domain.store.getGoal()
    if (goal === null || goal.id !== hello.teamGoalId) {
      this.send(session, 'protocol_error', { code: 'unknown_team_goal', detail: 'unknown Team Goal for handshake' })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    const existing = this.bridgeSessions.get(hello.role)
    if (existing !== undefined && existing !== session) {
      this.send(session, 'protocol_error', {
        code: 'role_busy',
        detail: 'only one connection may own a role at a time',
      })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    let handshake
    try {
      handshake = this.domain.bridgeHandshake(hello)
    } catch (error) {
      this.send(session, 'protocol_error', {
        code: 'identity_mismatch',
        detail: error instanceof Error ? error.message : String(error),
      })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    session.kind = 'bridge'
    session.role = hello.role
    session.lastSentSequence = handshake.eventCursor
    this.bridgeSessions.set(hello.role, session)

    this.send(session, 'hello_ack', { connectionKind: 'bridge', teamGoalId: hello.teamGoalId, role: hello.role })
    this.send(session, 'snapshot', handshake.snapshot as unknown as Record<string, unknown>)
    const binding = this.domain.store.getBinding(hello.teamGoalId, hello.role)
    this.send(session, 'presentation_update', buildPresentationUpdate(
      hello.role,
      binding.agent_run_id,
      handshake.eventCursor,
      handshake.labels,
    ))
    // Assignment replay only under managed control with a pending/active
    // assignment; a manual_takeover reconnect receives state and labels only.
    if (binding.control_mode === 'managed') {
      const assignment = this.domain.store.getActiveAssignmentForRole(hello.teamGoalId, hello.role)
      if (assignment !== null && (assignment.state === 'pending' || assignment.state === 'active')) {
        this.send(session, 'assignment', {
          assignmentId: assignment.id,
          role: assignment.role,
          agentRunId: assignment.agent_run_id,
          prompt: assignment.prompt,
        })
      }
    }
    this.pushEventsToProjections([handshake.eventCursor])
    this.options.onEvent?.({
      kind: 'bridge_handshake',
      detail: `role=${hello.role} reconnected=${String(handshake.reconnected)}`,
    })
  }

  private handleProjectionHello(session: Session, hello: ReturnType<typeof validateProjectionHello>): void {
    const goal = this.domain.store.getGoal()
    if (goal === null || goal.id !== hello.teamGoalId) {
      this.send(session, 'protocol_error', { code: 'unknown_team_goal', detail: 'unknown Team Goal for handshake' })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    // Serialized operation boundary: capture cursor, register, page, snapshot.
    const currentCursor = goal.event_cursor
    if (hello.resumeAfter !== null && hello.resumeAfter > currentCursor) {
      this.send(session, 'protocol_error', {
        code: 'invalid_cursor',
        detail: `resumeAfter ${hello.resumeAfter} is greater than the durable cursor ${currentCursor}`,
      })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    session.kind = 'projection'
    session.lastSentSequence = currentCursor
    this.projectionSessions.add(session)
    this.send(session, 'hello_ack', { connectionKind: 'projection', teamGoalId: hello.teamGoalId, role: null })
    if (hello.resumeAfter !== null) {
      // Complete replay through the captured cursor. Small pages guarantee the
      // encoded event_page remains below the protocol frame bound even when
      // individual event payloads approach their limit.
      let pageCursor = hello.resumeAfter
      let sentPage = false
      while (pageCursor < currentCursor) {
        const events = this.domain.eventsAfter(pageCursor, Math.min(MAX_EVENTS_PER_PAGE, 2))
          .filter((event) => event.sequence <= currentCursor)
        if (events.length === 0) throw new Error(`durable event history is missing after cursor ${pageCursor}`)
        const toCursor = events[events.length - 1].sequence
        this.send(session, 'event_page', { fromCursor: pageCursor, toCursor, events })
        pageCursor = toCursor
        sentPage = true
      }
      if (!sentPage) {
        this.send(session, 'event_page', { fromCursor: hello.resumeAfter, toCursor: hello.resumeAfter, events: [] })
      }
    }
    const snapshot = this.domain.snapshot(connectedRoles(this.bridgeSessions))
    this.send(session, 'snapshot', snapshot as unknown as Record<string, unknown>)
    this.options.onEvent?.({ kind: 'projection_handshake', detail: `clientId=${hello.clientId}` })
  }

  private handleBridgeFrame(session: Session, frame: { type: string; body: Record<string, unknown> }): void {
    const role = session.role
    if (role === null) return
    const goal = this.domain.store.getGoal()
    if (goal === null) return
    if (frame.type === 'bridge.assignment_ack') {
      this.handleAssignmentAck(session, role, goal.id, validateAssignmentAck(frame.body))
      return
    }
    if (frame.type === 'bridge.event') {
      this.handleBridgeEvent(session, role, goal.id, validateBridgeEvent(frame.body))
      return
    }
    this.send(session, 'protocol_error', {
      code: 'unexpected_frame',
      detail: `bridge connections may not send ${frame.type}`,
    })
    session.channel.close()
    this.handleClose(session, null)
  }

  private handleAssignmentAck(
    session: Session,
    role: Role,
    teamGoalId: string,
    ack: ReturnType<typeof validateAssignmentAck>,
  ): void {
    const goal = this.domain.store.getGoal()
    if (goal === null) return
    const extensionInstanceId = this.domain.store.getBinding(goal.id, role).extension_instance_id
    let transition: { changed: boolean; eventSequences: number[]; eventCursor: number } | null = null
    try {
      this.domain.authorizeAssignmentAcknowledgement(ack.assignmentId, role, extensionInstanceId)
      if (ack.ack === 'accepted') {
        transition = this.domain.acceptAssignment(ack.assignmentId, role, extensionInstanceId)
      } else if (ack.ack === 'duplicate') {
        transition = this.domain.recordDuplicateAck(ack.assignmentId, role, extensionInstanceId)
      } else {
      // busy/invalid are valid statuses; record them durably without a
      // domain transition.
        const sequence = this.domain.recordRunnerObservation(goal.id, role, 'assignment_acknowledged', {
          assignmentId: ack.assignmentId,
          ack: ack.ack,
          role,
        })
        this.pushEventsToProjections([sequence])
      }
    } catch (error) {
      this.send(session, 'protocol_error', {
        code: 'unauthorized_assignment_ack',
        detail: error instanceof Error ? error.message : String(error),
      })
      session.channel.close()
      this.handleClose(session, null)
      return
    }
    if (transition !== null && transition.changed) {
      this.afterCommit(role, transition.eventCursor, transition.eventSequences)
    } else if (transition !== null) {
      this.pushEventsToProjections(transition.eventSequences)
    }
    void session
    void teamGoalId
  }

  private handleBridgeEvent(
    session: Session,
    role: Role,
    teamGoalId: string,
    event: ReturnType<typeof validateBridgeEvent>,
  ): void {
    const binding = this.domain.store.getBinding(teamGoalId, role)
    const isInteractiveInput = event.eventType === 'human_input_submitted' && event.payload.inputSource === 'interactive'
    if (isInteractiveInput) {
      const transition = this.domain.applyInteractiveInput(teamGoalId, role, binding.extension_instance_id, {
        eventId: event.eventId,
        sequence: event.sequence,
        payload: event.payload,
      })
      if (transition.changed) {
        this.afterCommit(role, transition.eventCursor, transition.eventSequences)
      } else {
        // Duplicate or stale source event: no second domain transition.
        this.options.onEvent?.({
          kind: 'bridge_event_ignored',
          detail: `role=${role} duplicate=${String(transition.duplicate === true)} stale=${String(transition.stale === true)}`,
        })
      }
      return
    }
    const transition = this.domain.recordBridgeEvent(teamGoalId, role, binding.extension_instance_id, event)
    this.pushEventsToProjections(transition.eventSequences)
  }

  /**
   * After a committing transaction: send the presentation update for the
   * affected role, then stream the committed events to projection clients.
   */
  private afterCommit(role: Role, eventCursor: number, eventSequences: number[]): void {
    const binding = this.domain.store.getBinding(this.domain.store.getGoal()?.id ?? '', role)
    const bridge = this.bridgeSessions.get(role)
    if (bridge !== undefined) {
      this.send(bridge, 'presentation_update', buildPresentationUpdate(role, binding.agent_run_id, eventCursor, {
        nativeTerminalTitle: binding.native_terminal_title,
        piStatus: binding.pi_status,
      }))
    }
    this.pushEventsToProjections(eventSequences)
    void eventCursor
  }

  private pushEventsToProjections(eventSequences: number[]): void {
    if (eventSequences.length === 0) return
    const records: EventRecord[] = []
    for (const sequence of eventSequences) {
      const events = this.domain.eventsAfter(sequence - 1, 1)
      if (events.length > 0) records.push(events[0])
    }
    for (const projection of this.projectionSessions) {
      for (const record of records) {
        if (record.sequence > projection.lastSentSequence) {
          this.send(projection, 'event', record as unknown as Record<string, unknown>)
          projection.lastSentSequence = record.sequence
        }
      }
    }
  }
}

function connectedRoles(bridgeSessions: Map<Role, Session>): Set<Role> {
  const roles = new Set<Role>()
  for (const role of bridgeSessions.keys()) roles.add(role)
  return roles
}

export function runnerSocketPath(stateDir: string, socketName?: string): string {
  return path.join(stateDir, socketName ?? 'runner.sock')
}

export function socketExists(socketPath: string): boolean {
  try {
    return fs.lstatSync(socketPath).isSocket()
  } catch {
    return false
  }
}