/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * presentation.ts — pure label derivation for the persistent visible role
 * labels. This module has no I/O, no storage access, and no state. It maps a
 * role's control/agent/assignment state onto the two required label surfaces
 * and onto the presentation_update frame body.
 *
 * The QML/thin-client layer consumes the rendered strings only; it never
 * derives or mutates them.
 */

import type { AgentState, AssignmentState, ControlMode, PresentationUpdateBody, Role } from './protocol.ts'

export const DISPLAY_NAMES: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  reviewer: 'Reviewer',
}

export const PRESENTATION_STATES = ['managed', 'waiting', 'manual_takeover'] as const
export type PresentationState = (typeof PRESENTATION_STATES)[number]

/**
 * Derive the presentation state for one role:
 *   1. manual control wins,
 *   2. otherwise no active assignment means waiting,
 *   3. otherwise an active assignment under managed control means managed.
 */
export function derivePresentationState(
  controlMode: ControlMode,
  agentState: AgentState,
  assignmentState: AssignmentState | null,
): PresentationState {
  if (controlMode === 'manual_takeover') return 'manual_takeover'
  if (agentState === 'working' && assignmentState === 'active') return 'managed'
  return 'waiting'
}

export function renderNativeTerminalTitle(role: Role, state: PresentationState): string {
  return `Omarchestra — ${DISPLAY_NAMES[role]} — ${state}`
}

export function renderPiStatus(role: Role, state: PresentationState): string {
  return `${DISPLAY_NAMES[role]} · ${state}`
}

export interface RoleLabels {
  nativeTerminalTitle: string
  piStatus: string
}

/** Render both durable label surfaces for one role binding. */
export function presentationLabels(
  role: Role,
  controlMode: ControlMode,
  agentState: AgentState,
  assignmentState: AssignmentState | null,
): RoleLabels {
  const state = derivePresentationState(controlMode, agentState, assignmentState)
  return {
    nativeTerminalTitle: renderNativeTerminalTitle(role, state),
    piStatus: renderPiStatus(role, state),
  }
}

/**
 * Build the presentation_update frame body. The runner sends this only after
 * the transaction containing the corresponding state and labels committed.
 */
export function buildPresentationUpdate(
  role: Role,
  agentRunId: string,
  eventCursor: number,
  labels: RoleLabels,
): PresentationUpdateBody {
  return {
    role,
    agentRunId,
    eventCursor,
    nativeTerminalTitle: labels.nativeTerminalTitle,
    piStatus: labels.piStatus,
  }
}