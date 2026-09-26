/**
 * Local Workbench v1 — developer scenario fixtures.
 *
 * These are not the default journey. They exist so an operator or developer can
 * stage one exceptional case at a time (stale connection, takeover, failed or
 * timed-out gate, retired history, disabled Board, missing/invalid check).
 * They are plain injected snapshots, persistently labelled, and never rendered
 * together as an all-states gallery.
 *
 * Every card action that names an Assignment also carries that Assignment on
 * its card. A card that cannot supply the identity the intent contract requires
 * narrows to unavailable in QML, so a scenario that omitted it would present a
 * permanently dead control instead of the state it claims to show.
 */

import type { WorkbenchAction, WorkbenchSnapshot } from '../console/schema.ts'
import { journeyFixture, JOURNEY_ARTIFACT_CHECK_ID, JOURNEY_CHECK_ID } from './journey.ts'

function clone(): WorkbenchSnapshot {
  return structuredClone(journeyFixture)
}

export const staleScenario: WorkbenchSnapshot = { ...clone(), connection: 'stale', fixture: { active: true, label: 'scenario stale — no real work' } }
export const gapScenario: WorkbenchSnapshot = { ...clone(), connection: 'gap', fixture: { active: true, label: 'scenario gap — no real work' } }
export const errorScenario: WorkbenchSnapshot = { ...clone(), connection: 'error', fixture: { active: true, label: 'scenario error — no real work' } }

function assignment(gateResult: 'pass' | 'fail' | 'timeout', state: string, correctionCount: number) {
  const base = clone()
  return {
    assignmentId: 'assignment-1',
    projectId: base.selectedProjectId!,
    goalId: base.selectedGoalId!,
    agentRunId: base.managedAgents[0].agentRunId,
    goalText: 'Ship the parser fix',
    taskText: 'Implement the parser change and test it.',
    state,
    attemptId: 'attempt-1',
    gateId: JOURNEY_CHECK_ID,
    gateVersion: 3,
    gateResult,
    candidateRef: 'candidate-1',
    correctionCount,
    correctionLimit: 1,
    diagnostics: null,
    artifactRefs: gateResult === 'pass' ? ['plan.md'] : [],
  }
}

/**
 * Stages one committed Assignment and binds it to its managed card, so the
 * Work and result destination and its interventions render real committed
 * facts rather than a disabled placeholder.
 */
function withAssignment(options: {
  gateResult: 'pass' | 'fail' | 'timeout'
  state: string
  correctionCount: number
  controlMode?: string
  piStatus?: string
  actions: WorkbenchAction[]
  details?: WorkbenchSnapshot['details']
  label: string
}): WorkbenchSnapshot {
  const base = clone()
  const row = assignment(options.gateResult, options.state, options.correctionCount)
  return {
    ...base,
    assignments: [row],
    managedAgents: base.managedAgents.map(card => ({
      ...card,
      controlMode: options.controlMode ?? card.controlMode,
      piStatus: options.piStatus ?? card.piStatus,
      assignment: row.assignmentId,
      actions: options.actions.map(action => ({ ...action, target: action.target ?? row.agentRunId })),
    })),
    details: options.details ?? base.details,
    fixture: { active: true, label: options.label },
  }
}

export const takeoverScenario: WorkbenchSnapshot = withAssignment({
  gateResult: 'pass',
  state: 'attention',
  correctionCount: 0,
  controlMode: 'manual_takeover',
  piStatus: 'Builder · manual takeover',
  actions: [{ kind: 'return_to_team', target: null, label: 'Return to team', enabled: true, reasonCode: null, reason: null }],
  details: [...clone().details, {
    kind: 'handoff',
    handoffId: 'handoff-1',
    assignmentId: 'assignment-1',
    attemptId: 'attempt-1',
    agentRunId: 'agent-run-builder-1',
    controlEpoch: 3,
    claimedState: 'partial',
    outstandingEffects: 'unknown',
    summary: 'Operator took control of the running attempt.',
    artifactRefs: ['plan.md'],
  }],
  label: 'scenario manual takeover — no real work',
})

export const reconcilingScenario: WorkbenchSnapshot = withAssignment({
  gateResult: 'timeout',
  state: 'attention',
  correctionCount: 1,
  controlMode: 'reconciling',
  piStatus: 'Builder · reconciling',
  actions: [
    { kind: 'accept', target: null, label: 'Accept result', enabled: true, reasonCode: null, reason: null },
    { kind: 'resume', target: null, label: 'Resume', enabled: true, reasonCode: null, reason: null },
    { kind: 'retry', target: null, label: 'Retry', enabled: true, reasonCode: null, reason: null },
  ],
  label: 'scenario reconciling — no real work',
})

export const gatePassScenario: WorkbenchSnapshot = withAssignment({
  gateResult: 'pass',
  state: 'accepted',
  correctionCount: 0,
  actions: [
    { kind: 'accept', target: null, label: 'Accept result', enabled: true, reasonCode: null, reason: null },
    { kind: 'retire', target: null, label: 'Retire agent', enabled: false, reasonCode: 'active_goal', reason: 'Finish or reassign the active Goal before retiring this agent.' },
  ],
  label: 'scenario gate pass — no real work',
})

export const gateFailScenario: WorkbenchSnapshot = withAssignment({
  gateResult: 'fail',
  state: 'failed',
  correctionCount: 1,
  actions: [
    { kind: 'retry', target: null, label: 'Retry with a new attempt', enabled: true, reasonCode: null, reason: null },
    { kind: 'stop', target: null, label: 'Stop assignment', enabled: true, reasonCode: null, reason: null },
  ],
  details: [...clone().details, {
    kind: 'stop',
    stopId: 'stop-1',
    assignmentId: 'assignment-1',
    dispatchRevoked: true,
    trigger: 'operator',
    cancellationStatus: 'acknowledged',
  }],
  label: 'scenario gate fail — no real work',
})

export const gateTimeoutScenario: WorkbenchSnapshot = withAssignment({
  gateResult: 'timeout',
  state: 'attention',
  correctionCount: 0,
  actions: [
    { kind: 'retry', target: null, label: 'Retry with a new attempt', enabled: true, reasonCode: null, reason: null },
    { kind: 'stop', target: null, label: 'Stop assignment', enabled: true, reasonCode: null, reason: null },
  ],
  label: 'scenario gate timeout — no real work',
})

export const retiredLeafScenario: WorkbenchSnapshot = {
  ...clone(),
  retiredRuns: [{
    agentRunId: 'agent-run-builder-0',
    role: 'Builder',
    piStatus: 'Builder · retired',
    retiredAt: 2000,
    predecessorAgentRunId: null,
    replacementAgentRunId: null,
    canPurge: true,
    purgeBlockedReason: null,
  }],
  fixture: { active: true, label: 'scenario retired leaf — no real work' },
}

export const boardDisabledScenario: WorkbenchSnapshot = {
  ...clone(),
  fixture: { active: true, label: 'scenario board disabled — no real work' },
}

export const noCheckScenario: WorkbenchSnapshot = {
  ...clone(),
  checks: [],
  fixture: { active: true, label: 'scenario no check configured — no real work' },
}

export const invalidCheckScenario: WorkbenchSnapshot = {
  ...clone(),
  checks: clone().checks.map(check => check.checkId === JOURNEY_CHECK_ID
    ? { ...check, availability: 'invalid' as const, reason: 'The configured definition changed and must be reviewed again.' }
    : check),
  fixture: { active: true, label: 'scenario check invalidated — no real work' },
}

export const artifactOnlyScenario: WorkbenchSnapshot = {
  ...clone(),
  checks: clone().checks.filter(check => check.checkId === JOURNEY_ARTIFACT_CHECK_ID),
  fixture: { active: true, label: 'scenario artifact-presence check — no real work' },
}

/** Developer scenario selector. The default journey is not in this map. */
export const DEVELOPER_SCENARIOS: Readonly<Record<string, WorkbenchSnapshot>> = Object.freeze({
  stale: staleScenario,
  gap: gapScenario,
  error: errorScenario,
  takeover: takeoverScenario,
  reconciling: reconcilingScenario,
  gate_pass: gatePassScenario,
  gate_fail: gateFailScenario,
  gate_timeout: gateTimeoutScenario,
  retired_leaf: retiredLeafScenario,
  board_disabled: boardDisabledScenario,
  no_check: noCheckScenario,
  invalid_check: invalidCheckScenario,
  artifact_only: artifactOnlyScenario,
})

export const DEVELOPER_SCENARIO_NAMES: readonly string[] = Object.freeze(Object.keys(DEVELOPER_SCENARIOS))
