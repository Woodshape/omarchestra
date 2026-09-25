/**
 * Local Workbench v1 Phase 2 — authoritative projection builder.
 *
 * Every field here is runner-computed from durable state. The presentation
 * layer validates and renders this shape; it never derives labels, enabled
 * flags or reasons. Assignments stay empty and `start_assignment` stays
 * disabled with a committed reason because Phase 2 does not execute work.
 */

import { WORKBENCH_PROTOCOL, WORKBENCH_PAGE_SIZE, type PageCollection, type WorkbenchSnapshot } from '../console/schema.ts'
import type { WorkbenchAuthority } from './authority.ts'
import { incarnationKey } from './binding-identity.ts'
import { EXECUTION_UNAVAILABLE_REASON, OFFERED_ROLES, START_UNAVAILABLE_REASON } from './authority.ts'
import type { AdoptionManager } from './adoption.ts'
import type { CheckRecord, GoalRecord, ProjectRecord } from './store.ts'

export interface ProjectionOptions {
  authority: WorkbenchAuthority
  adoption: AdoptionManager
  connection: WorkbenchSnapshot['connection']
  clock?: () => number
}

function terminalNavigation(agent: import('./bridge-registry.ts').ObservedPi | undefined): import('../console/schema.ts').TerminalNavigation {
  const n = agent?.navigation, state = n?.state ?? 'unavailable'
  const reasons = {
    idle: 'Show terminal pane · checked navigation, not atomic focus.',
    checking: 'Checking terminal navigation…',
    shown: 'Pane and window matched in the post-check (best effort).',
    unavailable: 'No verified local Herdr pane/window; nothing was focused.',
    unknown: 'Navigation could not be verified; focus may have changed.',
  }
  return { target: n?.ticket ?? null, enabled: !!n?.ticket && state !== 'checking', state,
    reason: n ? reasons[state] : 'Terminal navigation unavailable: no connected presentation-capable Pi.' }
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

function projectSummary(project: ProjectRecord, dirty: boolean | null, contextMatch: boolean): WorkbenchSnapshot['projects'][number] {
  return {
    projectId: project.projectId,
    executionNodeId: project.executionNodeId,
    canonicalPath: project.canonicalPath,
    gitCommonDir: project.gitCommonDir,
    revision: String(project.revision),
    dirty, // Last inspection fact; null when current context is unavailable.
    // This is a momentary bridge-reported match for every ready Run in the
    // selected Goal. It is never repurposed as "is selected" or as authority.
    contextMatch,
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
  const registryAgents = authority.registry?.list() ?? []
  const descriptors = {} as NonNullable<WorkbenchSnapshot['pages']>
  function page<T>(collection: PageCollection, records: T[]): T[] {
    const limit = WORKBENCH_PAGE_SIZE
    const selectedIndex = collection === 'projects' ? projects.findIndex(project => project.projectId === selectedProjectId)
      : collection === 'goals' ? goals.findIndex(goal => goal.goalId === selectedGoalId) : -1
    const requested = authority.pageOffset(collection)
      ?? (selectedIndex < 0 ? 0 : Math.floor(selectedIndex / limit) * limit)
    const offset = records.length === 0 ? 0 : Math.min(requested, Math.floor((records.length - 1) / limit) * limit)
    descriptors[collection] = { offset, total: records.length, limit, hasPrevious: offset > 0, hasNext: offset + limit < records.length }
    return records.slice(offset, offset + limit)
  }

  const managedAgents: WorkbenchSnapshot['managedAgents'] = store.listBindings()
    .filter(binding => ['ready', 'committed', 'manual_takeover', 'manual_takeover_disconnected', 'disconnected'].includes(binding.state)
      && (!authority.registry || (selectedGoalId !== null && store.getBindingIdentity(binding.runId)?.goalId === selectedGoalId)))
    .map(binding => {
      const currentIdentity = store.getBindingIdentity(binding.runId)
      const currentAgent = registryAgents.find(agent => agent.available && currentIdentity
        && incarnationKey(agent.incarnation) === currentIdentity.incarnationKey)
      const bridgeLive = currentAgent !== undefined
      const connected = authority.registry ? bridgeLive : binding.state !== 'disconnected' && binding.state !== 'manual_takeover_disconnected'
      const takenOver = binding.state === 'manual_takeover' || binding.state === 'manual_takeover_disconnected'
      const canTakeControl = (binding.state === 'ready' || binding.state === 'committed') && connected
      const canRetire = !connected && (binding.state === 'disconnected' || binding.state === 'manual_takeover_disconnected')
      return {
        agentRunId: binding.runId,
        sessionCode: currentAgent?.sessionCode ?? null,
        terminalNavigation: terminalNavigation(currentAgent ?? registryAgents.find(agent => currentIdentity
          && incarnationKey(agent.incarnation) === currentIdentity.incarnationKey)),
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
  // Expire retained proposals before computing choices/reasons so a released
  // reservation cannot leave a one-snapshot phantom blocker.
  const proposals = adoption.retainedProposals()
  const observedChoices = authority.observedChoices
  const observedSessions: WorkbenchSnapshot['observedSessions'] = authority.registry ? [
    ...registryAgents.filter(agent => agent.mode === 'observed').map(agent => {
      const proposal = proposals.find(p => p.stage === 'proposed' && p.goalId === selectedGoalId && p.observedSessionId === agent.observedSessionId)
      const problem = authority.observedAdoptionProblem(agent, proposal?.proposalId)
      return {
        observedSessionId: agent.observedSessionId, sessionCode: agent.sessionCode, terminalNavigation: terminalNavigation(agent), piStatus: proposal ? 'proposal_pending' : 'observed', lifecycle: agent.lifecycle,
        availability: agent.available ? 'available' : 'unavailable', activity: agent.activity, health: agent.health,
        adoptionReasonCode: problem?.code ?? null, adoptionReason: problem?.reason ?? null,
        choices: proposal ? [{ choiceId: proposal.proposalId, role: proposal.role, label: `Authorize adoption as ${proposal.role}`,
          enabled: problem === null, actionKind: 'authorize_adoption' as const }]
          : observedChoices.filter(choice => choice.observedSessionId === agent.observedSessionId).map(choice => ({
            choiceId: choice.choiceId, role: choice.role, label: `Adopt as ${choice.role}`, enabled: agent.available, actionKind: 'request_adoption' as const,
          })),
      }
    }),
  ] : [
    ...observedChoices.map(observation => ({
      observedSessionId: observation.observedSessionId,
      piStatus: 'observed',
      lifecycle: 'observed',
      availability: 'available',
      activity: 'unknown',
      health: 'healthy',
      adoptionReasonCode: null, adoptionReason: null,
      choices: [{
        choiceId: observation.choiceId,
        role: observation.role,
        label: `Adopt ${observation.observedSessionId} as ${observation.role}`,
        enabled: true,
        actionKind: 'request_adoption' as const,
      }],
    })),
    ...proposals
      .filter(proposal => proposal.stage === 'proposed')
      .map(proposal => ({
        observedSessionId: proposal.observedSessionId,
        piStatus: 'proposal_pending',
        lifecycle: 'proposed',
        availability: 'available',
        activity: 'unknown',
        health: 'healthy',
        adoptionReasonCode: null, adoptionReason: null,
        choices: [{
          choiceId: proposal.proposalId,
          role: proposal.role,
          label: `Authorize adoption as ${proposal.role}`,
          enabled: true,
          actionKind: 'authorize_adoption' as const,
        }],
      })),
  ]

  const retiredRuns: WorkbenchSnapshot['retiredRuns'] = store.listBindings()
    .filter(binding => binding.state === 'retired'
      && (!authority.registry || (selectedGoalId !== null && store.getBindingIdentity(binding.runId)?.goalId === selectedGoalId)))
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
      .filter(proposal => proposal.stage === 'proposed' && (!authority.registry || proposal.goalId === selectedGoalId))
      .map(proposal => ({
        kind: 'authorize_adoption',
        target: proposal.proposalId,
        label: `Authorize adoption as ${proposal.role}`,
        enabled: true,
        reasonCode: null,
        reason: null,
      })),
    ...page('checks', checks).map(check => ({
      kind: 'configure_checks',
      target: check.checkId,
      label: `Edit ${check.name}`,
      enabled: context?.available === true,
      reasonCode: context?.available ? null : 'project_context_unavailable',
      reason: contextReason,
    })),
  ]

  // View-page bookkeeping is not user activity. Excluding it also keeps
  // history offsets stable while the operator navigates its own pages.
  const activity: WorkbenchSnapshot['activity'] = store.listEvents().filter(event => event.kind !== 'page_selected').reverse().map(event => ({
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
    .filter(proposal => (!authority.registry || proposal.goalId === selectedGoalId)
      && (proposal.stage === 'proposed' || proposal.stage === 'authorized' || proposal.stage === 'awaiting_ack'))
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
    projects: page('projects', projects.map(project => projectSummary(project, authority.projectContext(project.projectId).dirty,
      authority.projectContextMatches(project.projectId)))),
    goals: page('goals', goals.map(goal => goalSummary(goal, goal.goalId === selectedGoalId))),
    selectedProjectId,
    selectedGoalId,
    selectedProject: selectedProjectId === null ? null : (() => {
      const selected = projects.find(project => project.projectId === selectedProjectId)
      return selected ? projectSummary(selected, authority.projectContext(selected.projectId).dirty,
        authority.projectContextMatches(selected.projectId)) : null
    })(),
    selectedGoal: selectedGoalId === null ? null : (() => {
      const selected = goals.find(goal => goal.goalId === selectedGoalId)
      return selected ? goalSummary(selected, true) : null
    })(),
    managedAgents: page('managedAgents', managedAgents),
    observedSessions: page('observedSessions', observedSessions),
    retiredRuns: page('retiredRuns', retiredRuns),
    assignments: [],
    activity: page('activity', activity),
    capabilities: ['inspect_project', 'confirm_register_project', 'create_goal', 'select_goal', 'select_project', 'create_check', 'configure_checks', 'request_adoption', 'authorize_adoption', 'retire', 'purge', 'navigate_page'],
    actions: [...actions, ...Object.entries(descriptors).flatMap(([collection, descriptor]) => [
      { kind: 'navigate_page', target: null, label: `Previous ${collection}`, enabled: descriptor.hasPrevious,
        reasonCode: descriptor.hasPrevious ? null : 'page_start', reason: descriptor.hasPrevious ? null : 'Already on the first page.' },
      { kind: 'navigate_page', target: null, label: `Next ${collection}`, enabled: descriptor.hasNext,
        reasonCode: descriptor.hasNext ? null : 'page_end', reason: descriptor.hasNext ? null : 'No more records.' },
    ])],
    roles: [...(OFFERED_ROLES)],
    checks: page('checks', checkSummaries),
    pages: descriptors,
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
