/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Pure same-process policy for the authorized live role-label gate. It owns no
 * socket, process, PTY, terminal, provider, or filesystem resource. The Pi
 * extension injects those narrow ports during a real human-authorized run.
 */

import {
  validateAssignmentBody,
  validatePresentationUpdateBody,
  validateProtocolErrorBody,
  type DecodedFrame,
  type Role,
} from '../src/protocol.ts'

export const ROLE_STATUS_KEY = 'omarchestra-role-state'
export const TAKEOVER_GATE_PHRASE = 'Manual takeover check'

type NoticeLevel = 'info' | 'warning' | 'error'
type StartResult = 'started' | 'already_started' | 'busy' | 'not_builder' | 'not_ready'
type InputResult = 'handled' | 'continue'

export interface LiveBridgeIdentity {
  teamGoalId: string
  role: Role
  agentRunId: string
  extensionInstanceId: string
}

export interface LiveBridgePorts {
  setTitle(title: string): void
  setStatus(key: string, value: string): void
  notify(message: string, level: NoticeLevel): void
  sendFrame(type: 'bridge.assignment_ack' | 'bridge.event', body: Record<string, unknown>): void
  isIdle(): boolean
  sendUserMessage(prompt: string): void
  onPresentationApplied(update: {
    role: Role
    nativeTerminalTitle: string
    piStatus: string
    eventCursor: number
  }): void
}

interface QueuedAssignment {
  assignmentId: string
  role: Role
  agentRunId: string
  prompt: string
}

export class LiveRoleLabelBridgeCore {
  private readonly identity: LiveBridgeIdentity
  private readonly ports: LiveBridgePorts
  private queuedAssignment: QueuedAssignment | null = null
  private startedAssignmentId: string | null = null
  private sourceSequence = 0

  constructor(identity: LiveBridgeIdentity, ports: LiveBridgePorts) {
    this.identity = identity
    this.ports = ports
  }

  handleFrame(frame: DecodedFrame): void {
    if (frame.type === 'presentation_update') {
      const update = validatePresentationUpdateBody(frame.body)
      if (update.role !== this.identity.role || update.agentRunId !== this.identity.agentRunId) {
        throw new Error('presentation update does not match this visible Pi identity')
      }
      this.ports.setTitle(update.nativeTerminalTitle)
      this.ports.setStatus(ROLE_STATUS_KEY, update.piStatus)
      this.ports.onPresentationApplied(update)
      return
    }

    if (frame.type === 'assignment') {
      const body = validateAssignmentBody(frame.body)
      const assignment: QueuedAssignment = {
        assignmentId: String(body.assignmentId),
        role: body.role as Role,
        agentRunId: String(body.agentRunId),
        prompt: String(body.prompt),
      }
      if (assignment.role !== this.identity.role || assignment.agentRunId !== this.identity.agentRunId) {
        throw new Error('assignment does not match this visible Pi identity')
      }
      if (this.startedAssignmentId === assignment.assignmentId) {
        this.ports.sendFrame('bridge.assignment_ack', {
          assignmentId: assignment.assignmentId,
          ack: 'duplicate',
        })
        return
      }
      if (this.queuedAssignment !== null && this.queuedAssignment.assignmentId !== assignment.assignmentId) {
        this.ports.sendFrame('bridge.assignment_ack', {
          assignmentId: assignment.assignmentId,
          ack: 'busy',
        })
        return
      }
      this.queuedAssignment = assignment
      return
    }

    if (frame.type === 'protocol_error') {
      const body = validateProtocolErrorBody(frame.body)
      this.ports.notify(`Runner rejected the bridge: ${String(body.detail)}`, 'error')
    }
  }

  startQueuedAssignment(): StartResult {
    if (this.identity.role !== 'builder') {
      this.ports.notify('Only the Builder owns the manual-gate assignment.', 'warning')
      return 'not_builder'
    }
    if (this.startedAssignmentId !== null) {
      this.ports.notify('The managed Builder assignment already started.', 'info')
      return 'already_started'
    }
    if (this.queuedAssignment === null) {
      this.ports.notify('The Builder assignment has not arrived yet.', 'warning')
      return 'not_ready'
    }
    if (!this.ports.isIdle()) {
      this.ports.notify('Builder is busy; retry /omarchestra-start after it becomes idle.', 'warning')
      return 'busy'
    }

    const assignment = this.queuedAssignment
    this.ports.sendFrame('bridge.assignment_ack', {
      assignmentId: assignment.assignmentId,
      ack: 'accepted',
    })
    this.startedAssignmentId = assignment.assignmentId
    this.queuedAssignment = null
    this.ports.sendUserMessage(assignment.prompt)
    return 'started'
  }

  observeInput(text: string, source: unknown): InputResult {
    if (source !== 'interactive') return 'continue'
    this.sourceSequence += 1
    this.ports.sendFrame('bridge.event', {
      eventId: `${this.identity.extensionInstanceId}-input-${this.sourceSequence}`,
      sequence: this.sourceSequence,
      eventType: 'human_input_submitted',
      payload: { inputSource: 'interactive', charCount: text.length },
    })
    if (text === TAKEOVER_GATE_PHRASE) {
      this.ports.notify('Manual takeover recorded; the gate phrase was not sent to the model.', 'info')
      return 'handled'
    }
    return 'continue'
  }
}
