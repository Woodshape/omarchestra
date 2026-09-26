/**
 * AL-02 transient Start Review preparation and confirmation revalidation.
 *
 * This module resolves exact Runner-owned Project/Goal/Run/check facts and a
 * bounded C9 baseline. It never writes state, dispatches work, or runs a gate.
 * A caller must persist the returned records only after revalidateStartProposal
 * succeeds inside its current authority transaction.
 */
import { captureStableProjectBaseline, type ProjectBaseline } from './content-manifest.ts'
import { projectExecutionContextDigest, sha256 } from './canonical-hash.ts'
import { verifyCheckResources, type ResolvedCheckDefinition } from './check-definition.ts'
import { workbenchError } from './errors.ts'
import { incarnationKey, type BindingIdentity, type PiIncarnation } from './binding-identity.ts'
import { defaultNewId } from './identity.ts'
import type { BridgeRegistry, ObservedPi } from './bridge-registry.ts'
import type { FenceLedger } from './fences.ts'
import type { GitRunner } from './git-context.ts'
import type {
  AssignmentContext,
  AssignmentLimits,
  AssignmentRecord,
  AssignmentRunBinding,
  AttemptRecord,
  BindingRecord,
  CheckRecord,
  GoalRecord,
  ProjectRecord,
  WorkbenchStore,
} from './store.ts'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const DIGEST = /^[a-f0-9]{64}$/
const CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/
const MAX_TEXT_BYTES = 8192

export interface StartProposalRequest {
  projectId: string
  goalId: string
  agentRunId: string
  checkId: string
  checkVersion: number
  taskText: string
  limits: AssignmentLimits
  expectedRevision: number
}

type StartProposalStore = Pick<WorkbenchStore,
  | 'nodeId' | 'getMeta' | 'getProject' | 'getGoal' | 'getBinding' | 'getBindingIdentity'
  | 'listMemberships' | 'getCheck' | 'getWriter' | 'activeAssignment' | 'listAssignments'
  | 'hasUncertainEffects'
>
type StartProposalRegistry = Pick<BridgeRegistry, 'listCurrent' | 'currentBinding' | 'projectContextMatches' | 'assignmentLoopAvailable'>
type StartProposalFences = Pick<FenceLedger, 'isFenced' | 'isIncarnationFenced'>

/** Read-only ports owned by the current Runner/Owner composition. */
export interface StartProposalAuthority {
  store: StartProposalStore
  fences: StartProposalFences
  registry: StartProposalRegistry | null
  currentRevision: () => number
}

export interface StartProposalOptions {
  /** Fixed local Git runner; never a shell command or caller-supplied path. */
  git?: GitRunner
  /** Test seam for deterministic disposable-store failure injection. */
  captureBaseline?: typeof captureStableProjectBaseline
  /** Test seam for resource-drift injection; production uses the real verifier. */
  verifyResources?: typeof verifyCheckResources
  newId?: (prefix: string) => string
  clock?: () => number
}

export interface StartProposal {
  confirmationId: string
  proposalDigest: string
  /** Current projection revision captured by the proposal. */
  revision: number
  projectRevision: number
  createdAt: number
  request: StartProposalRequest
  project: ProjectRecord
  goal: GoalRecord
  /** All selected-Goal members whose fresh challenged context was checked. */
  contextRuns: StartContextRun[]
  observedSessionId: string
  runBinding: AssignmentRunBinding
  baseline: ProjectBaseline
  context: AssignmentContext
  resolvedGate: ResolvedCheckDefinition
  assignment: AssignmentRecord
  attempt: AttemptRecord
}

export interface StartContextRun {
  runId: string
  role: string
  bindingDigest: string
  controlEpoch: number
  incarnation: PiIncarnation
  observedSessionId: string
  connectionId: string
  connectionChallenge: string
  executionContextDigest: string
}

interface RunFacts {
  binding: BindingRecord
  identity: BindingIdentity
  observation: ObservedPi
  connectionId: string
  connectionChallenge: string
}

interface CoreFacts {
  revision: number
  project: ProjectRecord
  goal: GoalRecord
  contextRuns: StartContextRun[]
  target: RunFacts
  check: CheckRecord
  resolvedGate: ResolvedCheckDefinition
  writerEpoch: number
}

function unavailable(message: string): never {
  throw workbenchError('invalid_input', `Start Review unavailable: ${message}`,
    'refresh the Project, Goal, exact ready Run, configured check and current checkout before reviewing Start again')
}

function stale(message = 'one or more captured Project, Goal, Run, connection, check or checkout facts changed'): never {
  throw workbenchError('identity_drift', `Start Review is stale: ${message}`,
    'discard this review and prepare a fresh Start Review from the current authoritative snapshot')
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value)
}

function validText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.trim().length === 0
      || Buffer.byteLength(value) > MAX_TEXT_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return unavailable(`${label} must be non-empty, bounded UTF-8 text without unsupported control characters`)
  }
  return value
}

function validateRequest(value: StartProposalRequest): StartProposalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'agentRunId,checkId,checkVersion,expectedRevision,goalId,limits,projectId,taskText') {
    return unavailable('request fields are not the declared Start Review shape')
  }
  if (![value.projectId, value.goalId, value.agentRunId, value.checkId].every(isId)) unavailable('Project, Goal, Run and check identities are invalid')
  if (!Number.isSafeInteger(value.checkVersion) || value.checkVersion < 1) unavailable('check version is invalid')
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) unavailable('projection revision is invalid')
  if (!value.limits || typeof value.limits !== 'object' || Array.isArray(value.limits)
      || Object.keys(value.limits).sort().join(',') !== 'elapsedMs,maxCorrections'
      || !Number.isSafeInteger(value.limits.maxCorrections) || value.limits.maxCorrections < 0 || value.limits.maxCorrections > 3
      || !Number.isSafeInteger(value.limits.elapsedMs) || value.limits.elapsedMs < 1000 || value.limits.elapsedMs > 3_600_000) {
    unavailable('correction or elapsed-time limits are outside C10 bounds')
  }
  return {
    projectId: value.projectId,
    goalId: value.goalId,
    agentRunId: value.agentRunId,
    checkId: value.checkId,
    checkVersion: value.checkVersion,
    taskText: validText(value.taskText, 'task text'),
    limits: { maxCorrections: value.limits.maxCorrections, elapsedMs: value.limits.elapsedMs },
    expectedRevision: value.expectedRevision,
  }
}

function validateRunBinding(binding: BindingRecord, identity: BindingIdentity, nodeId: string, projectId: string, goalId: string, role: string): void {
  const incarnation = identity.incarnation
  if (binding.runId !== identity.runId || binding.projectId !== projectId || binding.state !== 'ready'
      || binding.writerState !== 'none' || binding.role !== role || !binding.bindingDigest || !DIGEST.test(binding.bindingDigest)
      || identity.goalId !== goalId || identity.incarnationKey !== incarnationKey(incarnation)
      || incarnation.executionNodeId !== nodeId || !Number.isSafeInteger(binding.controlEpoch) || binding.controlEpoch < 0) {
    unavailable('the selected Run is not the exact ready, managed Run for this Goal and Project')
  }
}

function currentRunFacts(authority: StartProposalAuthority, runId: string, role: string, projectId: string, projectPath: string, goalId: string): RunFacts {
  const { store, fences, registry } = authority
  if (!registry) return unavailable('the challenged Pi bridge is unavailable')
  const binding = store.getBinding(runId)
  const identity = store.getBindingIdentity(runId)
  if (!binding || !identity) return unavailable('the selected Run has no retained managed identity')
  validateRunBinding(binding, identity, store.nodeId, projectId, goalId, role)
  if (fences.isFenced(runId) || fences.isIncarnationFenced(identity.incarnationKey)) {
    return unavailable('the selected Run or Pi incarnation is retired or fenced')
  }

  const observations = registry.listCurrent().filter(entry => incarnationKey(entry.incarnation) === identity.incarnationKey)
  if (observations.length !== 1) return unavailable('the exact Pi incarnation is not uniquely visible on the current bridge')
  const observation = observations[0]
  if (!observation.available || observation.mode !== 'committed') return unavailable('the exact Pi connection is unavailable or not committed')
  const current = registry.currentBinding(observation.observedSessionId)
  if (!current || current.observation.observedSessionId !== observation.observedSessionId
      || incarnationKey(current.observation.incarnation) !== identity.incarnationKey
      || current.observation.mode !== 'committed' || !current.observation.available
      || !CAPABILITY.test(current.connectionId) || !CAPABILITY.test(current.challenge)) {
    return unavailable('the exact challenged Pi connection is no longer current')
  }
  if (!registry.projectContextMatches(runId, projectPath)) {
    return unavailable('the Pi Run does not report the exact Project root on a fresh challenged connection')
  }
  return {
    binding,
    identity,
    observation: current.observation,
    connectionId: current.connectionId,
    connectionChallenge: current.challenge,
  }
}

function readCoreFacts(
  authority: StartProposalAuthority,
  request: StartProposalRequest,
  options: StartProposalOptions,
): CoreFacts {
  const { store, registry } = authority
  if (!registry) return unavailable('the challenged Pi bridge is unavailable')
  const revision = authority.currentRevision()
  if (!Number.isSafeInteger(revision) || revision < 0 || revision !== request.expectedRevision) {
    return unavailable('the workbench revision changed before Start Review')
  }
  if (store.getMeta('selected_project_id') !== request.projectId || store.getMeta('selected_goal_id') !== request.goalId) {
    return unavailable('the selected Project or Goal changed')
  }

  const project = store.getProject(request.projectId)
  const goal = store.getGoal(request.goalId)
  if (!project || !goal || project.executionNodeId !== store.nodeId || goal.projectId !== project.projectId
      || goal.state !== 'active' || !project.contextDigest || !/^repo-v1:[a-f0-9]{64}$/.test(project.contextDigest)
      || !project.gitCommonDir || !Number.isSafeInteger(project.revision) || project.revision < 1) {
    return unavailable('the selected active Goal or registered local Project is unavailable')
  }

  const memberships = store.listMemberships(goal.goalId)
  if (memberships.length === 0 || !memberships.some(member => member.runId === request.agentRunId)) {
    return unavailable('the exact target Run is not a member of the selected Goal')
  }
  const contextRuns: StartContextRun[] = []
  let target: RunFacts | null = null
  for (const member of [...memberships].sort((a, b) => a.runId.localeCompare(b.runId))) {
    const facts = currentRunFacts(authority, member.runId, member.role, project.projectId, project.canonicalPath, goal.goalId)
    if (!registry.projectContextMatches(member.runId, project.canonicalPath)) {
      return unavailable('every current Run in the selected Goal must report the registered Project root')
    }
    const binding = facts.binding
    const contextDigest = facts.observation.executionContextDigest
    if (contextDigest !== projectExecutionContextDigest(project.canonicalPath)) {
      return unavailable('a selected-Goal Run has no fresh Project-context attestation')
    }
    contextRuns.push({
      runId: binding.runId,
      role: member.role,
      bindingDigest: binding.bindingDigest!,
      controlEpoch: binding.controlEpoch,
      incarnation: { ...facts.identity.incarnation },
      observedSessionId: facts.observation.observedSessionId,
      connectionId: facts.connectionId,
      connectionChallenge: facts.connectionChallenge,
      executionContextDigest: contextDigest,
    })
    if (member.runId === request.agentRunId) target = facts
  }
  if (!target) return unavailable('the exact target Run is no longer a current Goal member')
  if (!registry.assignmentLoopAvailable(request.agentRunId)) return unavailable('the Pi extension lacks native Candidate submission or fresh quiescence support')
  if (target.binding.state !== 'ready' || target.binding.writerState !== 'none'
      || target.observation.lifecycle !== 'running' || target.observation.activity !== 'idle'
      || target.observation.health !== 'healthy') {
    return unavailable('the selected Pi Run must be ready, running, healthy and idle')
  }

  const writer = store.getWriter(project.projectId)
  if (writer && (writer.state !== 'none' || writer.projectId !== project.projectId)) {
    return unavailable('the Project already has a held or uncertain Assignment writer')
  }
  if (store.activeAssignment(project.projectId) !== null || store.hasUncertainEffects(project.projectId)) {
    return unavailable('the Project has active Assignment work or unresolved effects')
  }
  if (store.listAssignments(project.projectId).some(assignment => assignment.goalId === goal.goalId)) {
    return unavailable('this Goal already has an Assignment; continue or reconcile that Assignment instead')
  }
  const writerEpoch = (writer?.epoch ?? 0) + 1
  if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 1) return unavailable('the per-Project writer epoch is exhausted')

  const check = store.getCheck(project.projectId, request.checkId, request.checkVersion)
  if (!check) return unavailable('the selected Project check version is unavailable')
  const verifyResources = options.verifyResources ?? verifyCheckResources
  const resolvedGate = verifyResources(check, project)
  if (resolvedGate.projectId !== project.projectId || resolvedGate.checkId !== check.checkId
      || resolvedGate.version !== check.version) {
    return unavailable('the selected check does not resolve to its exact Project/check identity')
  }

  return {
    revision,
    project: { ...project },
    goal: { ...goal },
    contextRuns,
    target,
    check: { ...check },
    resolvedGate,
    writerEpoch,
  }
}

function externalCoreDigest(core: CoreFacts): string {
  return sha256({
    revision: core.revision,
    project: core.project,
    goal: core.goal,
    contextRuns: core.contextRuns,
    targetBinding: core.target.binding,
    targetIncarnation: core.target.identity,
    targetObservation: {
      observedSessionId: core.target.observation.observedSessionId,
      lifecycle: core.target.observation.lifecycle,
      activity: core.target.observation.activity,
      health: core.target.observation.health,
      mode: core.target.observation.mode,
      available: core.target.observation.available,
      executionContextDigest: core.target.observation.executionContextDigest,
    },
    targetConnection: { connectionId: core.target.connectionId, connectionChallenge: core.target.connectionChallenge },
    check: core.check,
    resolvedGate: core.resolvedGate,
    writerEpoch: core.writerEpoch,
  })
}

function proposalPayload(proposal: StartProposal): Omit<StartProposal, 'proposalDigest'> {
  const { proposalDigest: _digest, ...payload } = proposal
  return payload
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

function makeProposal(
  request: StartProposalRequest,
  core: CoreFacts,
  baseline: ProjectBaseline,
  ids: { confirmationId: string; assignmentId: string; attemptId: string; deliveryId: string },
  createdAt: number,
): StartProposal {
  const context: AssignmentContext = {
    projectId: core.project.projectId,
    executionNodeId: core.project.executionNodeId,
    canonicalPath: core.project.canonicalPath,
    gitCommonDir: core.project.gitCommonDir,
    repositoryIdentity: baseline.repositoryIdentity,
    headOid: baseline.headOid,
    dirty: baseline.dirty,
    baselineDigest: baseline.baselineDigest,
    manifestDigest: baseline.manifestDigest,
  }
  const runBinding: AssignmentRunBinding = {
    executionNodeId: core.target.identity.incarnation.executionNodeId,
    processInstanceId: core.target.identity.incarnation.processInstanceId,
    piSessionId: core.target.identity.incarnation.piSessionId,
    extensionInstanceId: core.target.identity.incarnation.extensionInstanceId,
    runId: core.target.binding.runId,
    goalId: core.goal.goalId,
    bindingDigest: core.target.binding.bindingDigest!,
    connectionId: core.target.connectionId,
    connectionChallenge: core.target.connectionChallenge,
  }
  const assignmentRevision = core.revision + 1
  if (!Number.isSafeInteger(assignmentRevision)) return unavailable('the projection revision is exhausted')
  const assignment: AssignmentRecord = {
    assignmentId: ids.assignmentId,
    projectId: core.project.projectId,
    goalId: core.goal.goalId,
    agentRunId: core.target.binding.runId,
    bindingDigest: runBinding.bindingDigest,
    goalText: core.goal.goalText,
    taskText: request.taskText,
    writeAuthority: true,
    state: 'admitted',
    limits: { ...request.limits },
    attemptCount: 0,
    revision: assignmentRevision,
    createdAt,
    updatedAt: createdAt,
  }
  const attempt: AttemptRecord = {
    attemptId: ids.attemptId,
    assignmentId: ids.assignmentId,
    ordinal: 1,
    state: 'admitted',
    runBinding,
    gate: {
      checkId: core.check.checkId,
      version: core.check.version,
      digest: core.check.digest,
      canonicalJson: core.check.canonicalJson,
    },
    context,
    limits: { ...request.limits },
    writerEpoch: core.writerEpoch,
    controlEpoch: core.target.binding.controlEpoch,
    deliveryId: ids.deliveryId,
    createdAt,
    updatedAt: createdAt,
  }
  const proposal: StartProposal = {
    confirmationId: ids.confirmationId,
    proposalDigest: '',
    revision: core.revision,
    projectRevision: core.project.revision,
    createdAt,
    request,
    project: core.project,
    goal: core.goal,
    contextRuns: core.contextRuns,
    observedSessionId: core.target.observation.observedSessionId,
    runBinding,
    baseline,
    context,
    resolvedGate: core.resolvedGate,
    assignment,
    attempt,
  }
  proposal.proposalDigest = sha256(proposalPayload(proposal))
  return freezeDeep(proposal)
}

function captureSnapshot(authority: StartProposalAuthority, request: StartProposalRequest, options: StartProposalOptions): { core: CoreFacts; baseline: ProjectBaseline } {
  const before = readCoreFacts(authority, request, options)
  const capture = options.captureBaseline ?? captureStableProjectBaseline
  const baseline = capture(before.project, options.git ? { git: options.git } : {})
  const after = readCoreFacts(authority, request, options)
  if (before.revision !== after.revision || externalCoreDigest(before) !== externalCoreDigest(after)) {
    return stale('Runner, Project, Goal, Run, connection, control, check or writer facts changed while capturing the baseline')
  }
  if (baseline.projectId !== after.project.projectId || baseline.executionNodeId !== after.project.executionNodeId
      || baseline.canonicalPath !== after.project.canonicalPath || baseline.gitCommonDir !== after.project.gitCommonDir
      || baseline.repositoryIdentity !== after.project.contextDigest || !DIGEST.test(baseline.baselineDigest)
      || !DIGEST.test(baseline.manifestDigest) || !DIGEST.test(baseline.headDigest) || !DIGEST.test(baseline.indexDigest)
      || !DIGEST.test(baseline.configDigest) || !DIGEST.test(baseline.configFileDigest)) {
    return unavailable('the C9 baseline does not match the registered Project/Git identity')
  }
  return { core: after, baseline }
}

function nextId(newId: (prefix: string) => string, prefix: string): string {
  const value = newId(prefix)
  if (!isId(value)) return unavailable(`Runner-generated ${prefix} identity is invalid`)
  return value
}

/** Prepare an exact transient review; this function performs no persistence or dispatch. */
export function prepareStartProposal(
  authority: StartProposalAuthority,
  input: StartProposalRequest,
  options: StartProposalOptions = {},
): StartProposal {
  const request = validateRequest(input)
  const { core, baseline } = captureSnapshot(authority, request, options)
  const newId = options.newId ?? defaultNewId
  const ids = {
    confirmationId: nextId(newId, 'confirmation-'),
    assignmentId: nextId(newId, 'assignment-'),
    attemptId: nextId(newId, 'attempt-'),
    deliveryId: nextId(newId, 'delivery-'),
  }
  if (new Set(Object.values(ids)).size !== Object.keys(ids).length) return unavailable('Runner-generated Start Review identities collided')
  const createdAt = (options.clock ?? (() => Date.now()))()
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return unavailable('Runner clock returned an invalid timestamp')
  return makeProposal(request, core, baseline, ids, createdAt)
}

/** Re-resolve all current authority facts and repeat the bounded C9/check scans. */
export function revalidateStartProposal(
  authority: StartProposalAuthority,
  proposal: StartProposal,
  options: StartProposalOptions = {},
): StartProposal {
  if (!proposal || typeof proposal !== 'object' || proposalDigest(proposal) !== proposal.proposalDigest) {
    return stale('the captured Start Review proposal was modified or malformed')
  }
  try {
    const request = validateRequest(proposal.request)
    const { core, baseline } = captureSnapshot(authority, request, options)
    const rebuilt = makeProposal(request, core, baseline, {
      confirmationId: proposal.confirmationId,
      assignmentId: proposal.assignment.assignmentId,
      attemptId: proposal.attempt.attemptId,
      deliveryId: proposal.attempt.deliveryId!,
    }, proposal.createdAt)
    if (rebuilt.proposalDigest !== proposal.proposalDigest) return stale()
    return proposal
  } catch (error) {
    if (error instanceof Error && error.name === 'WorkbenchError' && (error as { code?: string }).code === 'identity_drift') throw error
    return stale('current confirmation facts are unavailable or no longer match the captured proposal')
  }
}

function proposalDigest(proposal: StartProposal): string {
  try { return sha256(proposalPayload(proposal)) } catch { return '' }
}
