/**
 * Local Workbench v1 — Phase 1 injected authoritative projection fixtures.
 *
 * These are plain injected values for the presentation shell. They are not
 * durable state and do not imply runner enforcement. Each fixture carries a
 * persistent fixture marker so injected data is never presented as live work.
 */

import type { WorkbenchSnapshot } from '../console/schema.ts'

const SESSION_ID = 'session-workbench-1'
const PLUGIN_GENERATION = 7
const RUNNER_EPOCH = 1

function base(overrides: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  return {
    protocol: 'omarchestra.workbench/v1',
    sessionId: SESSION_ID,
    pluginGeneration: PLUGIN_GENERATION,
    runnerEpoch: RUNNER_EPOCH,
    revision: 1,
    cursor: 0,
    connection: 'connected',
    projects: [],
    goals: [],
    selectedProjectId: null,
    selectedGoalId: null,
    managedAgents: [],
    observedSessions: [],
    retiredRuns: [],
    assignments: [],
    activity: [],
    capabilities: [],
    actions: [],
    roles: [],
    checks: [],
    fixture: { active: true, label: 'injected projection' },
    ...overrides,
  }
}

export const loadingFixture: WorkbenchSnapshot = base({
  connection: 'loading',
  fixture: { active: true, label: 'loading' },
})

export const emptyFixture: WorkbenchSnapshot = base({
  connection: 'connected',
  fixture: { active: true, label: 'empty' },
})

export const errorFixture: WorkbenchSnapshot = base({
  connection: 'error',
  fixture: { active: true, label: 'error' },
})

export const staleFixture: WorkbenchSnapshot = base({
  connection: 'stale',
  fixture: { active: true, label: 'stale' },
})

export const gapFixture: WorkbenchSnapshot = base({
  connection: 'gap',
  fixture: { active: true, label: 'gap' },
})

export const projectFixture: WorkbenchSnapshot = base({
  projects: [{
    projectId: 'project-local-1',
    executionNodeId: 'node-local-1',
    canonicalPath: '/home/user/work/example',
    gitCommonDir: '/home/user/work/example/.git',
    revision: 'abc123',
    dirty: true,
    contextMatch: true,
  }],
  selectedProjectId: 'project-local-1',
  fixture: { active: true, label: 'project' },
})

export const managedFixture: WorkbenchSnapshot = base({
  managedAgents: [{
    agentRunId: 'agent-run-builder-1',
    role: 'builder',
    piStatus: 'Builder · managed',
    controlMode: 'managed',
    connectionStatus: 'connected',
    assignment: 'assignment-1',
    lastEvent: 'connected',
    predecessorAgentRunId: null,
    actions: [{
      kind: 'take_control',
      target: 'agent-run-builder-1',
      label: 'Take control',
      enabled: true,
      reasonCode: null,
      reason: null,
    }],
  }],
  fixture: { active: true, label: 'managed' },
})

export const manualTakeoverFixture: WorkbenchSnapshot = base({
  managedAgents: [{
    agentRunId: 'agent-run-builder-1',
    role: 'builder',
    piStatus: 'Builder · manual takeover',
    controlMode: 'manual_takeover',
    connectionStatus: 'connected',
    assignment: 'assignment-1',
    lastEvent: 'manual_takeover',
    predecessorAgentRunId: null,
    actions: [{
      kind: 'return_to_team',
      target: 'agent-run-builder-1',
      label: 'Return to team',
      enabled: true,
      reasonCode: null,
      reason: null,
    }],
  }],
  fixture: { active: true, label: 'manual takeover' },
})

export const reconcilingFixture: WorkbenchSnapshot = base({
  managedAgents: [{
    agentRunId: 'agent-run-builder-1',
    role: 'builder',
    piStatus: 'Builder · reconciling',
    controlMode: 'reconciling',
    connectionStatus: 'connected',
    assignment: 'assignment-1',
    lastEvent: 'handoff_received',
    predecessorAgentRunId: null,
    actions: [
      { kind: 'accept', target: 'agent-run-builder-1', label: 'Accept result', enabled: true, reasonCode: null, reason: null },
      { kind: 'resume', target: 'agent-run-builder-1', label: 'Resume', enabled: true, reasonCode: null, reason: null },
      { kind: 'retry', target: 'agent-run-builder-1', label: 'Retry', enabled: true, reasonCode: null, reason: null },
    ],
  }],
  fixture: { active: true, label: 'reconciling' },
})

export const uncertainFixture: WorkbenchSnapshot = base({
  assignments: [{
    assignmentId: 'assignment-1',
    projectId: 'project-local-1',
    goalId: 'goal-1',
    agentRunId: 'agent-run-builder-1',
    goalText: 'Implement the feature',
    state: 'needs_reconciliation',
    attemptId: 'attempt-1',
    gateId: 'gate-1',
    gateVersion: 1,
    gateResult: null,
    candidateRef: null,
    correctionCount: 0,
    correctionLimit: 1,
    diagnostics: null,
    artifactRefs: [],
  }],
  fixture: { active: true, label: 'uncertain' },
})

export const gatePassFixture: WorkbenchSnapshot = base({
  assignments: [{
    assignmentId: 'assignment-1',
    projectId: 'project-local-1',
    goalId: 'goal-1',
    agentRunId: 'agent-run-builder-1',
    goalText: 'Implement the feature',
    state: 'accepted',
    attemptId: 'attempt-1',
    gateId: 'gate-1',
    gateVersion: 1,
    gateResult: 'pass',
    candidateRef: 'candidate-1',
    correctionCount: 0,
    correctionLimit: 1,
    diagnostics: null,
    artifactRefs: ['src/feature.ts'],
  }],
  fixture: { active: true, label: 'gate pass' },
})

export const gateFailFixture: WorkbenchSnapshot = base({
  assignments: [{
    assignmentId: 'assignment-1',
    projectId: 'project-local-1',
    goalId: 'goal-1',
    agentRunId: 'agent-run-builder-1',
    goalText: 'Implement the feature',
    state: 'failed',
    attemptId: 'attempt-1',
    gateId: 'gate-1',
    gateVersion: 1,
    gateResult: 'fail',
    candidateRef: 'candidate-1',
    correctionCount: 1,
    correctionLimit: 1,
    diagnostics: 'gate failed: expected output missing',
    artifactRefs: [],
  }],
  fixture: { active: true, label: 'gate fail' },
})

export const gateTimeoutFixture: WorkbenchSnapshot = base({
  assignments: [{
    assignmentId: 'assignment-1',
    projectId: 'project-local-1',
    goalId: 'goal-1',
    agentRunId: 'agent-run-builder-1',
    goalText: 'Implement the feature',
    state: 'attention',
    attemptId: 'attempt-1',
    gateId: 'gate-1',
    gateVersion: 1,
    gateResult: 'timeout',
    candidateRef: 'candidate-1',
    correctionCount: 0,
    correctionLimit: 1,
    diagnostics: 'gate timed out; validator effects uncertain',
    artifactRefs: [],
  }],
  fixture: { active: true, label: 'gate timeout' },
})

export const observedFixture: WorkbenchSnapshot = base({
  observedSessions: [{
    observedSessionId: 'observed-session-1',
    piStatus: 'Unassigned · observed',
    lifecycle: 'running',
    availability: 'available',
    health: 'healthy',
    choices: [{
      choiceId: 'adoption-choice-1',
      role: 'builder',
      label: 'Adopt into goal-1 · builder',
      enabled: true,
    }],
  }],
  fixture: { active: true, label: 'observed' },
})

export const retiredFixture: WorkbenchSnapshot = base({
  retiredRuns: [{
    agentRunId: 'agent-run-builder-1',
    role: 'builder',
    piStatus: 'Builder · retired',
    retiredAt: 1000,
    predecessorAgentRunId: null,
    replacementAgentRunId: 'agent-run-builder-2',
    canPurge: false,
    purgeBlockedReason: 'Delete the replacement successor first to preserve predecessor linkage.',
  }],
  fixture: { active: true, label: 'retired successor-blocked' },
})

export const retiredLeafFixture: WorkbenchSnapshot = base({
  retiredRuns: [{
    agentRunId: 'agent-run-builder-2',
    role: 'builder',
    piStatus: 'Builder · retired',
    retiredAt: 2000,
    predecessorAgentRunId: 'agent-run-builder-1',
    replacementAgentRunId: null,
    canPurge: true,
    purgeBlockedReason: null,
  }],
  fixture: { active: true, label: 'retired leaf' },
})

export const boardDisabledFixture: WorkbenchSnapshot = base({
  fixture: { active: true, label: 'board disabled' },
})

export const narrowFixture: WorkbenchSnapshot = base({
  fixture: { active: true, label: 'narrow layout' },
})

export const wideFixture: WorkbenchSnapshot = base({
  fixture: { active: true, label: 'wide layout' },
})

export const ALL_FIXTURES: Record<string, WorkbenchSnapshot> = {
  loading: loadingFixture,
  empty: emptyFixture,
  error: errorFixture,
  stale: staleFixture,
  gap: gapFixture,
  project: projectFixture,
  managed: managedFixture,
  manualTakeover: manualTakeoverFixture,
  reconciling: reconcilingFixture,
  uncertain: uncertainFixture,
  gatePass: gatePassFixture,
  gateFail: gateFailFixture,
  gateTimeout: gateTimeoutFixture,
  observed: observedFixture,
  retired: retiredFixture,
  retiredLeaf: retiredLeafFixture,
  boardDisabled: boardDisabledFixture,
  narrow: narrowFixture,
  wide: wideFixture,
}
