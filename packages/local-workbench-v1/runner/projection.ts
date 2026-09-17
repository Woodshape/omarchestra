/**
 * Local Workbench v1 Phase 2 — authoritative projection builder.
 *
 * Every field here is runner-computed from durable state. The presentation
 * layer validates and renders this shape; it never derives labels, enabled
 * flags or reasons. Assignments stay empty and `start_assignment` stays
 * disabled with a committed reason because Phase 2 does not execute work.
 */

import { WORKBENCH_PROTOCOL, type WorkbenchSnapshot } from '../console/schema.ts'
import type { WorkbenchAuthority } from './authority.ts'
import { EXECUTION_UNAVAILABLE_REASON, OFFERED_ROLES, START_UNAVAILABLE_REASON } from './authority.ts'
import type { AdoptionManager } from './adoption.ts'
import type { CheckRecord, GoalRecord, ProjectRecord } from './store.ts'

export interface ProjectionOptions {
  authority: WorkbenchAuthority
  adoption: AdoptionManager
  connection: WorkbenchSnapshot['connection']
  clock?: () => number
}

function goalActions(selected: boolean): WorkbenchSnapshot['goals'][number]['actions'] {
  return [
    {
      kind: 'select_goal',
      target: null,
      label: selected ? 'Selected' : 'Select',
      enabled: !selected,
      reasonCode: selected ? 'already_selected' : null,
      reason: selected ? 'This Goal is already the selected Goal.' : null,
    },
  ]
}

function checkSummary(check: CheckRecord): WorkbenchSnapshot['checks'][number] {
  let summary = ''
  let commandSummary = ''
  try {
    const body = JSON.parse(check.canonicalJson) as { summary?: unknown; commandSummary?: unknown }
    summary = typeof body.summary === 'string' ? body.summary : ''
    commandSummary = typeof body.commandSummary === 'string' ? body.commandSummary : ''
  } catch {
    summary = ''
  }
  return {
    checkId: check.checkId,
    version: check.version,
    digest: check.digest,
    name: check.name,
    summary,
    mode: check.mode as WorkbenchSnapshot['checks'][number]['mode'],
    commandSummary,
    // The definition is present and selectable; running it stays Phase 3, so
    // every check carries the same committed execution reason.
    availability: 'available',
    reason: EXECUTION_UNAVAILABLE_REASON,
  }
}

function projectSummary(project: ProjectRecord, dirty: boolean | null): WorkbenchSnapshot['projects'][number] {
  return {
    projectId: project.projectId,
    executionNodeId: project.executionNodeId,
    canonicalPath: project.canonicalPath,
    gitCommonDir: project.gitCommonDir,
    revision: String(project.revision),
    dirty, // Last inspection fact; null when current context is unavailable.
    // No Run has verified this Project's execution context in Phase 2, so the
    // field stays the honest `false`. It is never repurposed as "is selected".
    contextMatch: false,
  }
}

type Detail = NonNullable<WorkbenchSnapshot['details']>[number]

export function buildSnapshot(options: ProjectionOptions): WorkbenchSnapshot {
  const { authority, adoption } = options
  const store = authority.runner.store
  const pending = authority.pendingRegistration()
  const registrationDetail: Detail | null = pending === null
    ? null
    : {
        kind: 'registration',
        registrationId: pending.inspectionId,
        requestedPath: pending.requestedPath,
        canonicalPath: pending.canonicalPath,
        gitCommonDir: pending.gitCommonDir,
        executionNodeId: pending.executionNodeId,
        headOid: pending.headOid,
        dirty: pending.dirty,
        reconfirmation: pending.reconfirmProjectId !== null,
        supported: pending.supported,
        reasons: [...pending.reasons],
        executionReady: pending.executionReady,
        readinessReasons: [...pending.readinessReasons],
      }
  const selectedProjectId = authority.selectedProjectId
  const selectedGoalId = authority.selectedGoalId
  const projects = store.listProjects()
  const goals = selectedProjectId === null ? [] : store.listGoals(selectedProjectId)
  const checks = selectedProjectId === null ? [] : latestChecks(store.listChecks(selectedProjectId))
  const context = selectedProjectId === null ? null : authority.projectContext(selectedProjectId)
  const contextReason = context?.available ? null : `Project context unavailable: ${context?.reason ?? 'no_project_selected'}.`

  const managedAgents: WorkbenchSnapshot['managedAgents'] = store.listBindings()
    .filter(binding => ['ready', 'committed', 'manual_takeover', 'manual_takeover_disconnected', 'disconnected'].includes(binding.state))
    .slice(0, 100)
    .map(binding => {
      const connected = binding.state !== 'disconnected' && binding.state !== 'manual_takeover_disconnected'
      const takenOver = binding.state === 'manual_takeover' || binding.state === 'manual_takeover_disconnected'
      const canTakeControl = binding.state === 'ready' || binding.state === 'committed'
      const canRetire = !connected
      return {
        agentRunId: binding.runId,
        role: binding.role ?? 'unknown',
        piStatus: takenOver ? 'manual_takeover' : binding.state,
        controlMode: takenOver ? 'manual_takeover' : connected ? 'managed' : 'reconciling',
        connectionStatus: connected ? 'connected' : 'disconnected',
        assignment: null,
        lastEvent: null,
        predecessorAgentRunId: binding.predecessorRunId,
        actions: [
          {
            kind: 'take_control', target: binding.runId, label: 'Take control', enabled: canTakeControl,
            reasonCode: canTakeControl ? null : 'control_already_held',
            reason: canTakeControl ? null : `Take control is unavailable while the Run is ${binding.state}.`,
          },
          {
            kind: 'retire', target: binding.runId, label: 'Retire', enabled: canRetire,
            reasonCode: canRetire ? null : 'run_active',
            reason: canRetire ? null : `Retire is unavailable while the Run is ${binding.state}. Take control and let it disconnect first.`,
          },
        ],
      }
    })

  // Transport-observed Pi sessions are rendered as their own adoptable cards.
  // A proposal is rendered as an authorization choice, never as an observed
  // session, so the emitted intent always matches the durable stage.
  const observedChoices = authority.observedChoices
  const proposals = adoption.retainedProposals()
  const observedSessions: WorkbenchSnapshot['observedSessions'] = [
    ...observedChoices.slice(0, 100).map(observation => ({
      observedSessionId: observation.observedSessionId,
      piStatus: 'observed',
      lifecycle: 'observed',
      availability: 'available',
      health: 'healthy',
      choices: [{
        choiceId: observation.choiceId,
        label: `Adopt ${observation.observedSessionId} as ${observation.role}`,
        enabled: true,
        actionKind: 'request_adoption' as const,
      }],
    })),
    ...proposals
      .filter(proposal => proposal.stage === 'proposed')
      .slice(0, 100)
      .map(proposal => ({
        observedSessionId: proposal.observedSessionId,
        piStatus: 'proposal_pending',
        lifecycle: 'proposed',
        availability: 'available',
        health: 'healthy',
        choices: [{
          choiceId: proposal.proposalId,
          label: `Authorize adoption as ${proposal.role}`,
          enabled: true,
          actionKind: 'authorize_adoption' as const,
        }],
      })),
  ]

  const retiredRuns: WorkbenchSnapshot['retiredRuns'] = store.listBindings()
    .filter(binding => binding.state === 'retired')
    .slice(0, 100)
    .map(binding => {
      const successor = store.listBindings().find(other => other.predecessorRunId === binding.runId && other.state !== 'purged')
      const canPurge = successor === undefined
      return {
        agentRunId: binding.runId,
        role: binding.role ?? 'unknown',
        piStatus: binding.state,
        retiredAt: binding.updatedAt,
        predecessorAgentRunId: binding.predecessorRunId,
        replacementAgentRunId: successor?.runId ?? null,
        canPurge,
        purgeBlockedReason: canPurge ? null : 'A retained successor references this Run. Purge the newest retained Run first.',
      }
    })

  const actions: WorkbenchSnapshot['actions'] = [
    {
      kind: 'inspect_project', target: null, label: 'Register a Project', enabled: true, reasonCode: null, reason: null,
    },
    {
      kind: 'create_goal', target: null, label: 'Add a Team Goal', enabled: selectedProjectId !== null,
      reasonCode: selectedProjectId === null ? 'no_project_selected' : null,
      reason: selectedProjectId === null ? 'Register and select a Project before adding a Team Goal.' : null,
    },
    {
      kind: 'create_check', target: null, label: 'Add a check', enabled: context?.available === true,
      reasonCode: selectedProjectId === null ? 'no_project_selected' : context?.available ? null : 'project_context_unavailable',
      reason: selectedProjectId === null ? 'Register and select a Project before configuring checks.' : contextReason,
    },
    {
      kind: 'start_assignment', target: null, label: 'Start Assignment', enabled: false,
      reasonCode: 'phase_3_unavailable', reason: START_UNAVAILABLE_REASON,
    },
    ...(registrationDetail === null || !registrationDetail.supported
      ? []
      : [{
          kind: 'confirm_register_project',
          target: registrationDetail.registrationId,
          label: registrationDetail.reconfirmation ? 'Reconfirm changed repository context' : 'Confirm and register this Project',
          enabled: true,
          reasonCode: null,
          reason: null,
        }]),
    ...proposals
      .filter(proposal => proposal.stage === 'proposed')
      .map(proposal => ({
        kind: 'authorize_adoption',
        target: proposal.proposalId,
        label: `Authorize adoption as ${proposal.role}`,
        enabled: true,
        reasonCode: null,
        reason: null,
      })),
    ...checks.map(check => ({
      kind: 'configure_checks',
      target: check.checkId,
      label: `Edit ${check.name}`,
      enabled: context?.available === true,
      reasonCode: context?.available ? null : 'project_context_unavailable',
      reason: contextReason,
    })),
  ]

  const activity: WorkbenchSnapshot['activity'] = store.listEvents().slice(-100).map(event => ({
    eventId: event.eventId,
    cursor: event.cursor,
    kind: event.kind,
    reasonCode: null,
    label: eventLabel(event.kind),
    createdAt: new Date(event.createdAt).toISOString(),
  }))

  const checkSummaries = checks.map(check => context?.available ? checkSummary(check)
    : { ...checkSummary(check), availability: 'unavailable' as const, reason: contextReason })

  const adoptionDetails: Detail[] = proposals
    .filter(proposal => proposal.stage === 'proposed' || proposal.stage === 'authorized' || proposal.stage === 'awaiting_ack')
    .map(proposal => ({
      kind: 'adoption' as const,
      proposalId: proposal.proposalId,
      observedSessionId: proposal.observedSessionId,
      projectId: proposal.projectId,
      goalId: proposal.goalId,
      executionNodeId: proposal.executionNodeId,
      role: proposal.role,
      predecessorAgentRunId: proposal.predecessorRunId,
      vacancyGeneration: proposal.vacancyGeneration,
      stage: proposal.stage as 'proposed' | 'authorized' | 'awaiting_ack',
    }))
  const details: Detail[] = [
    ...(registrationDetail === null ? [] : [registrationDetail]),
    ...adoptionDetails,
  ]

  return {
    protocol: WORKBENCH_PROTOCOL,
    sessionId: authority.sessionId,
    pluginGeneration: authority.pluginGeneration,
    runnerEpoch: authority.runner.epoch,
    revision: authority.currentRevision,
    cursor: authority.currentCursor,
    connection: options.connection,
    projects: projects.slice(0, 100).map(project => projectSummary(project, authority.projectContext(project.projectId).dirty)),
    goals: goals.slice(0, 100).map(goal => goalSummary(goal, goal.goalId === selectedGoalId)),
    selectedProjectId,
    selectedGoalId,
    managedAgents,
    observedSessions,
    retiredRuns,
    assignments: [],
    activity,
    capabilities: ['inspect_project', 'confirm_register_project', 'create_goal', 'select_goal', 'select_project', 'create_check', 'configure_checks', 'request_adoption', 'authorize_adoption', 'retire', 'purge'],
    actions,
    roles: [...(OFFERED_ROLES)],
    checks: checkSummaries,
    fixture: { active: false, label: '' },
    ...(details.length === 0 ? {} : { details }),
  }
}

function goalSummary(goal: GoalRecord, selected: boolean): WorkbenchSnapshot['goals'][number] {
  return {
    goalId: goal.goalId,
    projectId: goal.projectId,
    goalText: goal.goalText,
    state: goal.state,
    outcome: goal.outcome,
    createdAt: new Date(goal.createdAt).toISOString(),
    actions: goalActions(selected),
  }
}

function latestChecks(checks: CheckRecord[]): CheckRecord[] {
  const latest = new Map<string, CheckRecord>()
  for (const check of checks) {
    const current = latest.get(check.checkId)
    if (current === undefined || check.version > current.version) latest.set(check.checkId, check)
  }
  return [...latest.values()].sort((a, b) => (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0))
}

function eventLabel(kind: string): string {
  return kind.replace(/_/g, ' ')
}
