/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * domain.ts — validated state transitions for the first vertical slice,
 * expressed against the store's transactional interface. Every domain write
 * runs inside exactly one explicit immediate transaction; presentation
 * updates and event streaming happen only after the caller receives the
 * committed result.
 *
 * Scope limits (prototype, not MVP decisions): `reconciling` control mode and
 * return-to-team reconciliation are out of scope for this slice.
 */

import type { AssignmentState, ControlMode, EventRecord, Role, RoleProjectionValue, SnapshotBody } from './protocol.ts'
import { ROLES } from './protocol.ts'
import { presentationLabels } from './presentation.ts'
import type { BootstrapConfig, InsertEventInput, Store } from './store.ts'

export interface HandshakeResult {
  reconnected: boolean
  snapshot: SnapshotBody
  labels: { nativeTerminalTitle: string; piStatus: string }
  eventCursor: number
}

export interface TransitionResult {
  changed: boolean
  duplicate?: boolean
  stale?: boolean
  eventSequences: number[]
  labels: { nativeTerminalTitle: string; piStatus: string }
  eventCursor: number
}

export class Domain {
  private store: Store

  constructor(store: Store) {
    this.store = store
  }

  get store(): Store {
    return this.store
  }

  /**
   * Bootstrap the durable configuration. If the goal already exists (runner
   * restart), verify the exact identities and assignment instead of mutating.
   * Fails closed on any mismatch.
   */
  bootstrapIfNeeded(config: BootstrapConfig): { created: boolean } {
    const existing = this.store.getGoal()
    if (existing === null) {
      const labels = new Map<Role, { nativeTerminalTitle: string; piStatus: string }>()
      for (const identity of config.roles) {
        labels.set(identity.role, presentationLabels(identity.role, 'managed', 'waiting', null))
      }
      this.store.withImmediateTransaction(() => {
        this.store.bootstrapTx(config, labels)
        this.store.insertEventTx({
          teamGoalId: config.teamGoalId,
          role: null,
          eventType: 'goal_bootstrapped',
          sourceExtensionInstanceId: null,
          sourceEventId: null,
          sourceSequence: null,
          payload: { teamGoalId: config.teamGoalId, roles: config.roles.map((r) => r.role) },
        })
      })
      return { created: true }
    }
    this.verifyBootstrap(config, existing.id)
    return { created: false }
  }

  private verifyBootstrap(config: BootstrapConfig, goalId: string): void {
    if (existingGoalMismatch(this.store, config, goalId)) {
      throw new Error('restart configuration does not match the durable Team Goal and identity bindings; failing closed')
    }
  }

  /**
   * Validate a bridge handshake against the exact stored identity tuple, then
   * record the connection event and advance the cursor atomically.
   * Identity fields never change.
   */
  bridgeHandshake(hello: {
    teamGoalId: string
    role: Role
    agentRunId: string
    terminalSessionRef: string
    piSessionId: string
    extensionInstanceId: string
    hostPid: number
    hostMode: 'tui'
    shellRunId: string
  }): HandshakeResult {
    const binding = this.store.getBinding(hello.teamGoalId, hello.role)
    const tupleMatches =
      binding.agent_run_id === hello.agentRunId &&
      binding.terminal_session_ref === hello.terminalSessionRef &&
      binding.shell_run_id === hello.shellRunId &&
      binding.pi_session_id === hello.piSessionId &&
      binding.extension_instance_id === hello.extensionInstanceId &&
      binding.host_pid === hello.hostPid &&
      binding.host_mode === hello.hostMode
    if (!tupleMatches) {
      throw new Error(
        `bridge identity mismatch for role ${hello.role}: the stored tuple must match exactly for reconnect`,
      )
    }
    const assignment = this.store.getActiveAssignmentForRole(hello.teamGoalId, hello.role)
    let reconnected = false
    let eventCursor = 0
    let labels = { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status }
    this.store.withImmediateTransaction(() => {
      const priorConnections = this.store.countBridgeConnectedEvents(hello.teamGoalId, hello.role)
      reconnected = priorConnections > 0
      const sequence = this.store.insertEventTx({
        teamGoalId: hello.teamGoalId,
        role: hello.role,
        eventType: 'bridge_connected',
        sourceExtensionInstanceId: hello.extensionInstanceId,
        sourceEventId: null,
        sourceSequence: null,
        payload: {
          role: hello.role,
          agentRunId: hello.agentRunId,
          shellRunId: hello.shellRunId,
          reconnected,
        },
      })
      eventCursor = sequence
      const goal = this.store.getGoal()
      eventCursor = goal === null ? sequence : goal.event_cursor
    })
    const snapshot = this.snapshot()
    return { reconnected, snapshot, labels, eventCursor }
  }

  /**
   * Assignment acceptance: pending → active, Builder state and labels update,
   * event inserted, cursor advanced — all in one transaction.
   */
  acceptAssignment(assignmentId: string, role: Role, extensionInstanceId: string): TransitionResult {
    const assignment = this.authorizedAssignment(assignmentId, role, extensionInstanceId, false)
    if (assignment.state !== 'pending') {
      throw new Error(`assignment ${assignmentId} is ${assignment.state}; only a pending assignment can be accepted`)
    }
    return this.store.withImmediateTransaction(() => {
      const updated = this.store.updateAssignmentTx(assignmentId, {
        state: 'active',
        acceptedExtensionInstanceId: extensionInstanceId,
        lastAckStatus: 'accepted',
      })
      const role = updated.role
      const bindingBefore = this.store.getBinding(updated.team_goal_id, role)
      const labels = presentationLabels(role, bindingBefore.control_mode, 'working', 'active')
      this.store.updateBindingTx(updated.team_goal_id, role, {
        agentState: 'working',
        nativeTerminalTitle: labels.nativeTerminalTitle,
        piStatus: labels.piStatus,
      })
      const sequence = this.store.insertEventTx({
        teamGoalId: updated.team_goal_id,
        role,
        eventType: 'assignment_accepted',
        sourceExtensionInstanceId: extensionInstanceId,
        sourceEventId: null,
        sourceSequence: null,
        payload: { assignmentId, role, ack: 'accepted' },
      })
      const goal = this.store.getGoal()
      return {
        changed: true,
        eventSequences: [sequence],
        labels,
        eventCursor: goal === null ? sequence : goal.event_cursor,
      }
    })
  }

  /**
   * Duplicate acknowledgement: assignment state and accepted identity are
   * preserved; one deduplicated acknowledgement event is recorded.
   */
  recordDuplicateAck(assignmentId: string, role: Role, extensionInstanceId: string): TransitionResult {
    const assignment = this.authorizedAssignment(assignmentId, role, extensionInstanceId, true)
    return this.store.withImmediateTransaction(() => {
      this.store.updateAssignmentTx(assignmentId, { lastAckStatus: 'duplicate' })
      const sequence = this.store.insertEventTx({
        teamGoalId: assignment.team_goal_id,
        role: assignment.role,
        eventType: 'assignment_duplicate_acknowledged',
        sourceExtensionInstanceId: extensionInstanceId,
        sourceEventId: null,
        sourceSequence: null,
        payload: { assignmentId, role: assignment.role, ack: 'duplicate' },
      })
      const goal = this.store.getGoal()
      const binding = this.store.getBinding(assignment.team_goal_id, assignment.role)
      return {
        changed: false,
        duplicate: true,
        eventSequences: [sequence],
        labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
        eventCursor: goal === null ? sequence : goal.event_cursor,
      }
    })
  }

  authorizeAssignmentAcknowledgement(
    assignmentId: string,
    role: Role,
    extensionInstanceId: string,
  ): void {
    this.authorizedAssignment(assignmentId, role, extensionInstanceId, false)
  }

  private authorizedAssignment(
    assignmentId: string,
    role: Role,
    extensionInstanceId: string,
    requireAccepted: boolean,
  ) {
    const assignment = this.store.getAssignmentById(assignmentId)
    if (assignment === null) throw new Error(`unknown assignment ${assignmentId}`)
    const binding = this.store.getBinding(assignment.team_goal_id, role)
    if (
      assignment.role !== role ||
      assignment.agent_run_id !== binding.agent_run_id ||
      binding.extension_instance_id !== extensionInstanceId
    ) {
      throw new Error(`assignment ${assignmentId} is not authorized for connected role ${role}`)
    }
    if (
      requireAccepted &&
      (assignment.state !== 'active' || assignment.accepted_extension_instance_id !== extensionInstanceId)
    ) {
      throw new Error(`assignment ${assignmentId} has not been accepted by this visible bridge`)
    }
    return assignment
  }

  /** Record a non-takeover bridge event durably (bounded metadata only). */
  recordBridgeEvent(
    teamGoalId: string,
    role: Role,
    extensionInstanceId: string,
    event: { eventId: string; sequence: number; eventType: string; payload: Record<string, unknown> },
  ): TransitionResult {
    const binding = this.store.getBinding(teamGoalId, role)
    return this.store.withImmediateTransaction(() => {
      if (this.store.sourceEventExistsTx(extensionInstanceId, event.eventId)) {
        return {
          changed: false,
          duplicate: true,
          eventSequences: [],
          labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
          eventCursor: this.store.getGoal()?.event_cursor ?? 0,
        }
      }
      if (event.sequence <= binding.last_source_sequence) {
        return {
          changed: false,
          stale: true,
          eventSequences: [],
          labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
          eventCursor: this.store.getGoal()?.event_cursor ?? 0,
        }
      }
      const sequence = this.store.insertEventTx({
        teamGoalId,
        role,
        eventType: event.eventType,
        sourceExtensionInstanceId: extensionInstanceId,
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        payload: { role, ...event.payload },
      })
      this.store.updateBindingTx(teamGoalId, role, { lastSourceSequence: event.sequence })
      const goal = this.store.getGoal()
      return {
        changed: true,
        eventSequences: [sequence],
        labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
        eventCursor: goal === null ? sequence : goal.event_cursor,
      }
    })
  }

  /**
   * Manual takeover via an interactive submitted human input. Transition
   * applies to whichever role the event arrived for (Builder-only delivery is
   * exercised by the prototype; the transition itself is role-generic).
   * Only the affected role's control mode, assignment and labels change.
   */
  applyInteractiveInput(
    teamGoalId: string,
    role: Role,
    extensionInstanceId: string,
    event: { eventId: string; sequence: number; payload: Record<string, unknown> },
  ): TransitionResult {
    const binding = this.store.getBinding(teamGoalId, role)
    return this.store.withImmediateTransaction(() => {
      if (this.store.sourceEventExistsTx(extensionInstanceId, event.eventId)) {
        return {
          changed: false,
          duplicate: true,
          eventSequences: [],
          labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
          eventCursor: this.store.getGoal()?.event_cursor ?? 0,
        }
      }
      if (event.sequence <= binding.last_source_sequence) {
        return {
          changed: false,
          stale: true,
          eventSequences: [],
          labels: { nativeTerminalTitle: binding.native_terminal_title, piStatus: binding.pi_status },
          eventCursor: this.store.getGoal()?.event_cursor ?? 0,
        }
      }
      const eventSequences: number[] = []
      eventSequences.push(
        this.store.insertEventTx({
          teamGoalId,
          role,
          eventType: 'human_input_submitted',
          sourceExtensionInstanceId: extensionInstanceId,
          sourceEventId: event.eventId,
          sourceSequence: event.sequence,
          payload: {
            role,
            inputSource: event.payload.inputSource ?? 'interactive',
            charCount: typeof event.payload.charCount === 'number' ? event.payload.charCount : null,
          },
        }),
      )
      const assignment = this.store.getActiveAssignmentForRole(teamGoalId, role)
      const assignmentState: AssignmentState | null = assignment === null ? null : assignment.state
      let updatedAssignmentState: AssignmentState | null = assignmentState
      if (assignment !== null && assignment.state === 'active') {
        const updated = this.store.updateAssignmentTx(assignment.id, { state: 'needs_reconciliation' })
        updatedAssignmentState = updated.state
      }
      const labels = presentationLabels(role, 'manual_takeover', binding.agent_state, updatedAssignmentState)
      this.store.updateBindingTx(teamGoalId, role, {
        controlMode: 'manual_takeover',
        lastSourceSequence: event.sequence,
        nativeTerminalTitle: labels.nativeTerminalTitle,
        piStatus: labels.piStatus,
      })
      eventSequences.push(
        this.store.insertEventTx({
          teamGoalId,
          role,
          eventType: 'manual_takeover',
          sourceExtensionInstanceId: extensionInstanceId,
          sourceEventId: null,
          sourceSequence: null,
          payload: {
            role,
            from: binding.control_mode,
            to: 'manual_takeover',
            assignmentId: assignment === null ? null : assignment.id,
            assignmentState: updatedAssignmentState,
          },
        }),
      )
      const goal = this.store.getGoal()
      return {
        changed: true,
        eventSequences,
        labels,
        eventCursor: goal === null ? eventSequences[eventSequences.length - 1] : goal.event_cursor,
      }
    })
  }

  /** One consistent read of goal, bindings, assignment and cursor. */
  snapshot(connectedRoles: Set<Role> = new Set()): SnapshotBody {
    return this.store.withImmediateTransaction(() => this.snapshotTx(connectedRoles))
  }

  private snapshotTx(connectedRoles: Set<Role>): SnapshotBody {
    const goal = this.store.getGoal()
    if (goal === null) throw new Error('durable Team Goal is missing; the runner cannot serve a snapshot')
    const bindings = this.store.getBindings()
    const roles: RoleProjectionValue[] = bindings.map((binding) => {
      const assignment = this.store.getActiveAssignmentForRole(goal.id, binding.role)
      return {
        role: binding.role,
        agentRunId: binding.agent_run_id,
        terminalSessionRef: binding.terminal_session_ref,
        shellRunId: binding.shell_run_id,
        piSessionId: binding.pi_session_id,
        extensionInstanceId: binding.extension_instance_id,
        hostPid: binding.host_pid,
        hostMode: binding.host_mode,
        controlMode: binding.control_mode,
        agentState: binding.agent_state,
        assignmentState: assignment === null ? null : assignment.state,
        nativeTerminalTitle: binding.native_terminal_title,
        piStatus: binding.pi_status,
      }
    })
    const assignments = this.store.getAssignments()
    const assignmentRow = assignments.length > 0 ? assignments[assignments.length - 1] : null
    return {
      cursor: goal.event_cursor,
      teamGoal: {
        id: goal.id,
        goalText: goal.goal_text,
        createdAt: goal.created_at,
        eventCursor: goal.event_cursor,
      },
      roles,
      assignment:
        assignmentRow === null
          ? null
          : {
              id: assignmentRow.id,
              role: assignmentRow.role,
              agentRunId: assignmentRow.agent_run_id,
              state: assignmentRow.state,
              lastAckStatus: assignmentRow.last_ack_status,
              prompt: assignmentRow.prompt,
              createdAt: assignmentRow.created_at,
              updatedAt: assignmentRow.updated_at,
            },
      journal: { ...this.store.journal },
    }
  }

  markRunnerRestarted(teamGoalId: string, runnerPid: number): number {
    return this.store.withImmediateTransaction(() =>
      this.store.insertEventTx({
        teamGoalId,
        role: null,
        eventType: 'runner_restarted',
        sourceExtensionInstanceId: null,
        sourceEventId: null,
        sourceSequence: null,
        payload: { runnerPid },
      }),
    )
  }

  /** Durable runner-side event without a bridge source (e.g. busy/invalid acks). */
  recordRunnerObservation(teamGoalId: string, role: Role, eventType: string, payload: Record<string, unknown>): number {
    return this.store.withImmediateTransaction(() =>
      this.store.insertEventTx({
        teamGoalId,
        role,
        eventType,
        sourceExtensionInstanceId: null,
        sourceEventId: null,
        sourceSequence: null,
        payload,
      }),
    )
  }

  allRoles(): readonly Role[] {
    return ROLES
  }

  eventsAfter(cursor: number, limit?: number): EventRecord[] {
    return this.store.getEventsAfter(cursor, limit)
  }

  buildInsertEventInput(input: InsertEventInput): InsertEventInput {
    return input
  }
}

function existingGoalMismatch(store: Store, config: BootstrapConfig, goalId: string): boolean {
  const goal = store.getGoal()
  if (goal === null || goal.id !== config.teamGoalId || goal.goal_text !== config.goalText) return true
  const bindings = store.getBindings()
  if (bindings.length !== config.roles.length) return true
  for (const identity of config.roles) {
    const binding = bindings.find((row) => row.role === identity.role)
    if (
      binding === undefined ||
      binding.agent_run_id !== identity.agentRunId ||
      binding.terminal_session_ref !== identity.terminalSessionRef ||
      binding.shell_run_id !== identity.shellRunId ||
      binding.pi_session_id !== identity.piSessionId ||
      binding.extension_instance_id !== identity.extensionInstanceId ||
      binding.host_pid !== identity.hostPid ||
      binding.host_mode !== 'tui'
    ) {
      return true
    }
  }
  const assignments = store.getAssignments()
  if (assignments.length !== 1) return true
  const assignment = assignments[0]
  return (
    assignment.id !== config.assignment.id ||
    assignment.role !== config.assignment.role ||
    assignment.agent_run_id !== config.assignment.agentRunId ||
    assignment.prompt !== config.assignment.prompt
  )
}