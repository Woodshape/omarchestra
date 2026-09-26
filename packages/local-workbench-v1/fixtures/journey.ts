/**
 * Local Workbench v1 — the one realistic default fixture journey.
 *
 * A single injected authoritative snapshot for the normal task-first journey:
 * one Project, one active Goal, one eligible observed session, one ready
 * managed agent and two configured acceptance checks. It is plain injected
 * data, not durable state, and is persistently labelled as a preview.
 *
 * Special failure/history cases live in `scenarios.ts`, not here. Simulation
 * belongs to an injected fake authority; QML never fabricates a committed
 * operation from this fixture.
 */

import type { CheckSummary, WorkbenchSnapshot } from '../console/schema.ts'
import type { WorkbenchDetail } from '../console/detail-schema.ts'

export const JOURNEY_SESSION_ID = 'session-workbench-journey'
export const JOURNEY_PROJECT_ID = 'project-workbench-1'
export const JOURNEY_GOAL_ID = 'goal-parser-fix'
export const JOURNEY_AGENT_RUN_ID = 'agent-run-builder-1'
export const JOURNEY_OBSERVED_SESSION_ID = 'observed-session-a1b2'
export const JOURNEY_CHECK_ID = 'check-unit-tests'
export const JOURNEY_ARTIFACT_CHECK_ID = 'check-plan-artifact'

const hash = (seed: string): string => seed.repeat(64).slice(0, 64)

export const journeyChecks: CheckSummary[] = [
  {
    checkId: JOURNEY_CHECK_ID,
    version: 3,
    digest: hash('a1'),
    name: 'Unit tests',
    summary: 'Run the package test suite and report pass/fail only.',
    mode: 'validator',
    commandSummary: 'node --test',
    availability: 'available',
    reason: null,
  },
  {
    checkId: JOURNEY_ARTIFACT_CHECK_ID,
    version: 1,
    digest: hash('b2'),
    name: 'Plan artifact present',
    summary: 'Confirm the declared plan artifact exists. Presence only.',
    mode: 'artifact_presence',
    commandSummary: 'test -s plan.md',
    availability: 'available',
    reason: null,
  },
]

export const journeyDefinitionDraft = {
  executable: '/usr/bin/node', argv: ['--test'], cwd: '/home/user/work/omarchestra',
  environment: [{ name: 'LANG', value: 'C.UTF-8' }], resourcePaths: ['/usr/bin/node'],
  timeoutMs: 60000, outputBytes: 65536, maxCorrections: 1, elapsedMs: 900000,
}

export const journeyDetails: WorkbenchDetail[] = [
  {
    kind: 'adoption',
    proposalId: 'proposal-a1b2',
    observedSessionId: JOURNEY_OBSERVED_SESSION_ID,
    projectId: JOURNEY_PROJECT_ID,
    goalId: JOURNEY_GOAL_ID,
    executionNodeId: 'node-workbench-1',
    role: 'Builder',
    predecessorAgentRunId: null,
    vacancyGeneration: 0,
    stage: 'proposed',
  },
  {
    kind: 'start',
    confirmationId: 'confirmation-journey-1',
    projectId: JOURNEY_PROJECT_ID,
    goalId: JOURNEY_GOAL_ID,
    agentRunId: JOURNEY_AGENT_RUN_ID,
    goalText: 'Ship the parser fix',
    taskText: 'Implement the parser change and add a focused test.',
    executionNodeId: 'node-workbench-1',
    gitCommonDir: '/home/user/work/omarchestra/.git',
    headOid: 'abcdef0',
    baselineDigest: hash('c3'),
    dirty: true,
    maxCorrections: 1,
    elapsedMs: 900000,
    gate: {
      gateId: JOURNEY_CHECK_ID,
      version: 3,
      digest: hash('a1'),
      executable: '/usr/bin/node',
      executableDigest: hash('d4'),
      argv: ['--test'],
      cwd: '/home/user/work/omarchestra',
      environment: [{ name: 'LANG', value: 'C.UTF-8' }],
      resources: [{ path: '/usr/bin/node', digest: hash('d4') }],
      timeoutMs: 60000,
      outputBytes: 65536,
      semanticClaim: 'A pass proves the encoded test command exited zero; it does not establish semantic correctness.',
    },
  },
  { kind: 'check_configuration', projectId: JOURNEY_PROJECT_ID, checkId: JOURNEY_CHECK_ID,
    checkVersion: 3, definitionDraft: journeyDefinitionDraft },
]

export const journeyFixture: WorkbenchSnapshot = {
  protocol: 'omarchestra.workbench/v1',
  sessionId: JOURNEY_SESSION_ID,
  pluginGeneration: 7,
  runnerEpoch: 1,
  revision: 1,
  cursor: 0,
  connection: 'connected',
  projects: [{
    projectId: JOURNEY_PROJECT_ID,
    executionNodeId: 'node-workbench-1',
    canonicalPath: '/home/user/work/omarchestra',
    gitCommonDir: '/home/user/work/omarchestra/.git',
    revision: 'abcdef0',
    dirty: true,
    contextMatch: true,
  }],
  goals: [{
    goalId: JOURNEY_GOAL_ID,
    projectId: JOURNEY_PROJECT_ID,
    goalText: 'Ship the parser fix',
    state: 'active',
    outcome: null,
    createdAt: '2026-09-11T10:00:00.000Z',
    actions: [{
      kind: 'stop', target: null, label: 'Stop assignment', enabled: false,
      reasonCode: 'no_active_assignment', reason: 'No assignment is running for this Goal.',
    }],
  }],
  selectedProjectId: JOURNEY_PROJECT_ID,
  selectedGoalId: JOURNEY_GOAL_ID,
  managedAgents: [{
    agentRunId: JOURNEY_AGENT_RUN_ID,
    role: 'Builder',
    piStatus: 'Builder · managed',
    controlMode: 'managed',
    connectionStatus: 'connected',
    assignment: null,
    lastEvent: 'ready',
    predecessorAgentRunId: null,
    actions: [{
      kind: 'take_control', target: JOURNEY_AGENT_RUN_ID, label: 'Take control', enabled: false,
      reasonCode: 'no_active_assignment', reason: 'No assignment is running for this agent.',
    },
      { kind: 'retire', target: JOURNEY_AGENT_RUN_ID, label: 'Retire agent', enabled: false, reasonCode: 'active_goal', reason: 'Finish or reassign the active Goal before retiring this agent.' },
      { kind: 'prepare_start_review', target: JOURNEY_AGENT_RUN_ID, label: 'Review Start', enabled: true, reasonCode: null, reason: null },
    ],
  }],
  observedSessions: [{
    observedSessionId: JOURNEY_OBSERVED_SESSION_ID,
    piStatus: 'pi-a1b2',
    lifecycle: 'running',
    availability: 'available',
    activity: 'idle',
    health: 'healthy',
    adoptionReasonCode: null, adoptionReason: null,
    choices: [{
      choiceId: 'adoption-choice-a1b2',
      role: 'Builder',
      label: 'Adopt pi-a1b2 into Ship the parser fix as Builder',
      enabled: true,
    }],
  }],
  retiredRuns: [],
  assignments: [],
  activity: [
    { eventId: 'event-1', cursor: 1, kind: 'goal_created', reasonCode: null, label: 'Goal created', createdAt: '2026-09-11T10:00:00.000Z' },
    { eventId: 'event-2', cursor: 2, kind: 'session_observed', reasonCode: null, label: 'Unassigned session observed', createdAt: '2026-09-11T10:01:00.000Z' },
  ],
  capabilities: ['session.open', 'session.update', 'session.intent'],
  actions: [
    { kind: 'create_goal', target: null, label: 'Create', enabled: true, reasonCode: null, reason: null },
    { kind: 'configure_checks', target: JOURNEY_CHECK_ID, label: 'Save check', enabled: true, reasonCode: null, reason: null },
    { kind: 'start_assignment', target: JOURNEY_AGENT_RUN_ID, label: 'Confirm Start', enabled: true, reasonCode: null, reason: null },
  ],
  roles: ['Builder', 'Reviewer'],
  checks: journeyChecks,
  fixture: { active: true, label: 'staged fixture — no real work' },
  details: journeyDetails,
}
