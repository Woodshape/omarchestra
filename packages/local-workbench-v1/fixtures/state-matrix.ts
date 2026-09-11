import { managedFixture, manualTakeoverFixture, reconcilingFixture, observedFixture, uncertainFixture, projectFixture } from './projections.ts'
import type { WorkbenchSnapshot } from '../console/schema.ts'

/** Design fixtures only. These do not execute the transitions they illustrate. */
export const STATE_MATRIX: Record<string, WorkbenchSnapshot> = {}
for (const phase of ['proposed', 'authorized', 'awaiting_ack', 'failed', 'expired']) {
  const snapshot = structuredClone(observedFixture)
  snapshot.fixture.label = `Adoption ${phase} (design fixture)`
  snapshot.observedSessions = snapshot.observedSessions.map(card => ({ ...card,
    lifecycle: phase, choices: card.choices.map(choice => ({ ...choice, enabled: false })),
  }))
  STATE_MATRIX[`adoption_${phase}`] = snapshot
}
for (const [name, base] of Object.entries({ managed: managedFixture, manual_takeover: manualTakeoverFixture, reconciling: reconcilingFixture, uncertain: uncertainFixture })) {
  const replacement = structuredClone(base)
  replacement.fixture.label = `Replacement ${name} (design fixture)`
  replacement.managedAgents = replacement.managedAgents.map(card => ({ ...card,
    agentRunId: 'replacement-run', predecessorAgentRunId: card.agentRunId,
    actions: card.actions.map(action => ({ ...action, target: 'replacement-run' })),
  }))
  replacement.assignments = replacement.assignments.map(card => ({ ...card, agentRunId: 'replacement-run' }))
  STATE_MATRIX[`replacement_${name}`] = replacement
}
for (const reason of ['dirty_baseline_confirmation_required', 'baseline_changed', 'context_mismatch', 'fingerprint_scope_exceeded', 'unsupported_worktree', 'missing_head', 'writer_uncertain']) {
  const snapshot = structuredClone(projectFixture)
  snapshot.fixture.label = `${reason} (design fixture)`
  snapshot.actions = [{ kind: 'start_assignment', target: snapshot.selectedProjectId,
    enabled: false, reasonCode: reason, reason: reason.replaceAll('_', ' ') }]
  STATE_MATRIX[reason] = snapshot
}
