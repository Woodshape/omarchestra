/**
 * Local Workbench v1 — Phase 1 validated intent fixtures.
 *
 * Plain intent values used by tests and the injected composition. They are
 * validated by the adapter before emission; they carry no durable authority.
 */

import type { WorkbenchIntent } from '../console/schema.ts'

const SESSION_ID = 'session-workbench-1'
const PLUGIN_GENERATION = 7
const RUNNER_EPOCH = 1

export function intentFixture(
  overrides: Partial<WorkbenchIntent> = {},
): WorkbenchIntent {
  return {
    protocol: 'omarchestra.workbench/v1',
    sessionId: SESSION_ID,
    pluginGeneration: PLUGIN_GENERATION,
    runnerEpoch: RUNNER_EPOCH,
    intentId: 'wb-session-workbench-1-1',
    expectedRevision: 1,
    kind: 'select_project',
    target: 'project-local-1',
    payload: { projectId: 'project-local-1' },
    ...overrides,
  }
}

export const selectProjectIntent = intentFixture({ kind: 'select_project' })
export const createGoalIntent = intentFixture({ kind: 'create_goal', target: null, payload: { goalText: 'Build the feature' } })
export const requestAdoptionIntent = intentFixture({ kind: 'request_adoption', target: 'adoption-choice-1' })
export const authorizeAdoptionIntent = intentFixture({ kind: 'authorize_adoption', target: null })
export const startAssignmentIntent = intentFixture({ kind: 'start_assignment', target: null })
export const takeControlIntent = intentFixture({ kind: 'take_control', target: 'agent-run-builder-1' })
export const returnToTeamIntent = intentFixture({ kind: 'return_to_team', target: 'agent-run-builder-1' })
export const acceptIntent = intentFixture({ kind: 'accept', target: 'agent-run-builder-1' })
export const resumeIntent = intentFixture({ kind: 'resume', target: 'agent-run-builder-1' })
export const retryIntent = intentFixture({ kind: 'retry', target: 'agent-run-builder-1' })
export const retireIntent = intentFixture({ kind: 'retire', target: 'agent-run-builder-1' })
export const purgeIntent = intentFixture({ kind: 'purge', target: 'agent-run-builder-2' })
export const stopIntent = intentFixture({ kind: 'stop', target: 'assignment-1' })
export const recoverIntent = intentFixture({ kind: 'recover', target: null })
export const presentIntent = intentFixture({ kind: 'present', target: 'agent-run-builder-1' })
