/**
 * Local Workbench v1 Phase 2 — authoritative projection builder.
 *
 * Every field here is runner-computed from durable state. The presentation
 * layer validates and renders this shape; it never derives labels, enabled
 * flags or reasons. A transient Start Review is included only in its Owner
 * session; Assignment and Candidate facts always reopen from SQLite.
 */

import { WORKBENCH_PROTOCOL, WORKBENCH_PAGE_SIZE, type PageCollection, type WorkbenchSnapshot } from '../console/schema.ts'
import type { WorkbenchAuthority } from './authority.ts'
import { incarnationKey } from './binding-identity.ts'
import { projectExecutionContextDigest } from './canonical-hash.ts'
import { OFFERED_ROLES, START_UNAVAILABLE_REASON } from './authority.ts'
import type { AdoptionManager } from './adoption.ts'
import type { AssignmentRecord, AttemptRecord, CheckRecord, GoalRecord, ProjectRecord } from './store.ts'

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
    // Exact resources are revalidated again at Start review and before execution.
    availability: 'available',
    reason: null,
  }
}

function canPrepareStartReview(authority: WorkbenchAuthority, projectId: string | null, goalId: string | null, runId: string, checks: WorkbenchSnapshot['checks']): boolean {
  const store = authority.runner.store, registry = authority.registry
  if (!projectId || !goalId || !registry
      || authority.selectedProjectId !== projectId || authority.selectedGoalId !== goalId
      || checks.length === 0 || !authority.projectContext(projectId).available) return false
  const project = store.getProject(projectId), goal = store.getGoal(goalId)
  if (!project || !goal || goal.projectId !== projectId || goal.state !== 'active'
      || !authority.gateExecutionAvailableFor(project.canonicalPath)
      || store.listAssignments(projectId).some(assignment => assignment.goalId === goalId)
      || store.activeAssignment(projectId) !== null || store.hasUncertainEffects(projectId)) return false
  const writer = store.getWriter(projectId)
  if (writer && writer.state !== 'none') return false
  const members = store.listMemberships(goalId)
  if (members.length === 0) return false
  let targetReady = false
  for (const member of members) {
    const binding = store.getBinding(member.runId), identity = store.getBindingIdentity(member.runId)
    if (!binding || !identity || binding.state !== 'ready' || binding.writerState !== 'none'
        || authority.runner.fences.isFenced(member.runId) || authority.runner.fences.isIncarnationFenced(identity.incarnationKey)
        || !registry.projectContextMatches(member.runId, project.canonicalPath)) return false
    const matches = registry.listCurrent().filter(agent => incarnationKey(agent.incarnation) === identity.incarnationKey)
    if (matches.length !== 1) return false
    const observation = matches[0]!
    const current = registry.currentBinding(observation.observedSessionId)
    if (!observation.available || observation.mode !== 'committed' || !current
        || incarnationKey(current.observation.incarnation) !== identity.incarnationKey
        || current.connectionId.length === 0 || current.challenge.length === 0
        || observation.executionContextDigest !== projectExecutionContextDigest(project.canonicalPath)) return false
    if (member.runId === runId && observation.lifecycle === 'running'
        && observation.activity === 'idle' && observation.health === 'healthy') targetReady = true
  }
  return targetReady
}

function canAcceptCandidate(authority: WorkbenchAuthority, assignment: AssignmentRecord | null, attempt: AttemptRecord | null): boolean {
  if (!assignment || !attempt || !authority.registry || !authority.gateExecutionAvailable
      || assignment.state !== 'candidate' || attempt.state !== 'candidate'
      || authority.runner.store.getStop(assignment.assignmentId) !== null) return false
  const candidate = authority.runner.store.getCandidateByAttempt(attempt.attemptId)
  const delivery = authority.runner.store.getAssignmentDelivery(attempt.attemptId)
  const writer = authority.runner.store.getWriter(assignment.projectId)
  const binding = authority.runner.store.getBinding(assignment.agentRunId)
  const identity = authority.runner.store.getBindingIdentity(assignment.agentRunId)
  if (!candidate || candidate.state !== 'pending' || !delivery || delivery.state !== 'written'
      || !writer || writer.state !== 'held' || writer.assignmentId !== assignment.assignmentId
      || writer.attemptId !== attempt.attemptId || writer.epoch !== attempt.writerEpoch
      || !binding || binding.state !== 'ready' || binding.controlEpoch !== attempt.controlEpoch || !identity
      || identity.incarnationKey !== incarnationKey({ executionNodeId: attempt.runBinding.executionNodeId,
        processInstanceId: attempt.runBinding.processInstanceId, piSessionId: attempt.runBinding.piSessionId,
        extensionInstanceId: attempt.runBinding.extensionInstanceId }) || authority.runner.fences.isFenced(assignment.agentRunId)) return false
  const matches = authority.registry.listCurrent().filter(agent => incarnationKey(agent.incarnation) === identity.incarnationKey)
  if (matches.length !== 1) return false
  const observation = matches[0]!, current = authority.registry.currentBinding(observation.observedSessionId)
  return observation.available && observation.mode === 'committed' && observation.lifecycle === 'running'
    && observation.activity === 'idle' && observation.health === 'healthy' && current !== null
    && incarnationKey(current.observation.incarnation) === identity.incarnationKey
    && authority.registry.projectContextMatches(assignment.agentRunId, authority.runner.store.getProject(assignment.projectId)?.canonicalPath ?? '')
}

function projectAssignment(authority: WorkbenchAuthority, assignment: AssignmentRecord): WorkbenchSnapshot['assignments'][number] {
  const attempts = authority.runner.store.listAttempts(assignment.assignmentId).sort((a, b) => a.ordinal - b.ordinal)
  const attempt = attempts.at(-1) ?? null
  const candidate = attempt ? authority.runner.store.getCandidateByAttempt(attempt.attemptId) : null
  const result = attempt ? authority.runner.store.getGateResult(attempt.attemptId) : null
  const delivery = attempt ? authority.runner.store.getAssignmentDelivery(attempt.attemptId) : null
  const gateResult = result === null ? (candidate ? 'pending' : null) : result.outcome === 'pass' ? 'pass'
    : result.outcome === 'nonzero' ? 'fail' : result.outcome === 'timeout' ? 'timeout' : 'error'
  return {
    assignmentId: assignment.assignmentId, projectId: assignment.projectId, goalId: assignment.goalId,
    agentRunId: assignment.agentRunId, goalText: assignment.goalText, taskText: assignment.taskText,
    state: assignment.state, attemptId: attempt?.attemptId ?? null, gateId: attempt?.gate.checkId ?? null,
    gateVersion: attempt?.gate.version ?? null, gateResult, candidateRef: candidate?.candidateId ?? null,
    correctionCount: Math.max(0, attempts.length - 1), correctionLimit: assignment.limits.maxCorrections,
    diagnostics: result?.reasonCode ?? (delivery?.reasonCode ?? null),
    artifactRefs: candidate?.artifactRefs.map(ref => ref.path) ?? [],
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
  const checkSummaries = checks.map(check => context?.available ? checkSummary(check)
    : { ...checkSummary(check), availability: 'unavailable' as const, reason: contextReason })
  const assignments = store.listAssignments().map(assignment => projectAssignment(authority, assignment))
  const startReview = authority.startReviewForProjection()
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
      const assigned = assignments.filter(assignment => assignment.agentRunId === binding.runId
        && !['accepted', 'stopped', 'failed'].includes(assignment.state)).at(-1)
      const assignedRecord = assigned ? store.getAssignment(assigned.assignmentId) : null
      const assignedAttempt = assignedRecord ? store.listAttempts(assignedRecord.assignmentId).sort((a, b) => b.ordinal - a.ordinal)[0] ?? null : null
      const canAcceptAssigned = canAcceptCandidate(authority, assignedRecord, assignedAttempt)
      const canPrepareStart = canPrepareStartReview(authority, selectedProjectId, selectedGoalId, binding.runId, checkSummaries)
      return {
        agentRunId: binding.runId,
        sessionCode: currentAgent?.sessionCode ?? null,
        terminalNavigation: terminalNavigation(currentAgent ?? registryAgents.find(agent => currentIdentity
          && incarnationKey(agent.incarnation) === currentIdentity.incarnationKey)),
        role: binding.role ?? 'unknown',
        piStatus: takenOver ? 'manual_takeover' : binding.state,
        controlMode: takenOver ? 'manual_takeover' : connected ? 'managed' : 'reconciling',
        connectionStatus: connected ? 'connected' : 'disconnected',
        assignment: assigned?.assignmentId ?? null,
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
          {
            kind: 'prepare_start_review', target: binding.runId, label: 'Review Start', enabled: canPrepareStart,
            reasonCode: canPrepareStart ? null : 'start_review_unavailable',
            reason: canPrepareStart ? null : START_UNAVAILABLE_REASON,
          },
          ...(assigned && canAcceptAssigned ? [{ kind: 'accept', target: assigned.assignmentId,
            label: 'Run acceptance check', enabled: true, reasonCode: null, reason: null }] : []),
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
      kind: 'start_assignment', target: startReview?.assignment.agentRunId ?? null, label: 'Confirm Start', enabled: startReview !== null,
      reasonCode: startReview === null ? 'start_review_unavailable' : null,
      reason: startReview === null ? START_UNAVAILABLE_REASON : null,
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
  const assignmentDetails: Detail[] = store.listAssignments().flatMap(assignment => {
    const details: Detail[] = []
    const stop = store.getStop(assignment.assignmentId)
    if (stop) details.push({ kind: 'stop', stopId: stop.stopId, assignmentId: stop.assignmentId,
      dispatchRevoked: stop.dispatchRevoked, trigger: stop.trigger, cancellationStatus: stop.cancellationStatus })
    const handoff = store.listHandoffs(assignment.assignmentId).at(-1)
    if (handoff) details.push({ kind: 'handoff', handoffId: handoff.handoffId, assignmentId: handoff.assignmentId,
      attemptId: handoff.attemptId, agentRunId: handoff.agentRunId, controlEpoch: handoff.controlEpoch,
      claimedState: handoff.claimedState, outstandingEffects: handoff.outstandingEffects, summary: handoff.summary,
      artifactRefs: handoff.artifactRefs.map(ref => ref.path) })
    return details
  })
  const reviewDetail: Detail | null = startReview === null ? null : {
    kind: 'start', confirmationId: startReview.confirmationId, projectId: startReview.project.projectId,
    goalId: startReview.goal.goalId, agentRunId: startReview.assignment.agentRunId,
    goalText: startReview.assignment.goalText, taskText: startReview.assignment.taskText,
    executionNodeId: startReview.project.executionNodeId, gitCommonDir: startReview.context.gitCommonDir,
    headOid: startReview.context.headOid, baselineDigest: startReview.context.baselineDigest,
    dirty: startReview.context.dirty, maxCorrections: startReview.assignment.limits.maxCorrections,
    elapsedMs: startReview.assignment.limits.elapsedMs,
    gate: { gateId: startReview.resolvedGate.checkId, version: startReview.resolvedGate.version,
      digest: startReview.attempt.gate.digest, executable: startReview.resolvedGate.executable,
      executableDigest: startReview.resolvedGate.executableDigest, argv: startReview.resolvedGate.argv,
      cwd: startReview.resolvedGate.cwd, environment: startReview.resolvedGate.environment,
      resources: startReview.resolvedGate.resources.map(resource => ({ path: resource.path, digest: resource.digest })),
      timeoutMs: startReview.resolvedGate.timeoutMs, outputBytes: startReview.resolvedGate.outputBytes,
      semanticClaim: startReview.resolvedGate.semanticClaim },
  }
  const details: Detail[] = [
    ...(registrationDetail === null ? [] : [registrationDetail]), ...adoptionDetails, ...assignmentDetails,
    ...(reviewDetail === null ? [] : [reviewDetail]),
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
    assignments,
    activity: page('activity', activity),
    capabilities: ['inspect_project', 'confirm_register_project', 'create_goal', 'select_goal', 'select_project', 'create_check', 'configure_checks', 'request_adoption', 'authorize_adoption', 'prepare_start_review', 'start_assignment', 'accept', 'retire', 'purge', 'navigate_page'],
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
