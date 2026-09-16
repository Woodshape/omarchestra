/**
 * Local Workbench v1 Phase 2 — authoritative management layer.
 *
 * Owns the durable Project registry, Team Goals, Project-scoped checks,
 * selection, projection revision/cursor, intent deduplication and the
 * authoritative snapshot. One instance wraps one open runner.
 *
 * Durable Project/Goal/check/selection commands commit effects, events and
 * intent receipts in one store transaction. Cross-ledger and bridge commands
 * still require their separate S2 integration; this is not full Phase 2 acceptance.
 * Projection revisions advance only after the owning transaction commits. An intent whose payload hash
 * differs from a previously recorded intent with the same id is rejected
 * instead of being reapplied.
 *
 * Phase 2 never executes work: no Assignment is delivered and no acceptance
 * check is run. `start_assignment` is rejected here, at the runner boundary,
 * and the projection advertises it disabled with a committed reason.
 */

import { createHash } from 'node:crypto'
import { defaultNewId } from './identity.ts'
import { workbenchError } from './errors.ts'
import type { GitRunner, GitInspection } from './git-context.ts'
import { contextDigestOf, inspectProjectPath } from './git-context.ts'
import type { WorkbenchRunner } from './runner.ts'
import type { CheckRecord, EventRecord, GoalRecord, ProjectRecord } from './store.ts'
import { AdoptionManager } from './adoption.ts'
import type { ObserverPort, TransportEvent } from './transport.ts'

export const OFFERED_ROLES = ['implementer', 'reviewer'] as const
export const DEFAULT_REGISTRATION_TTL_MS = 5 * 60 * 1000
/** Phase 2 refuses work execution; the reason is committed, not local to QML. */
export const EXECUTION_UNAVAILABLE_REASON = 'Assignment delivery and acceptance-check execution are Phase 3; Phase 2 manages Projects, Goals, checks and Adoption only.'
export const START_UNAVAILABLE_REASON = 'Starting an Assignment is Phase 3. This workbench admits, adopts and retires agents only.'

export type IntentStatus = 'acknowledged' | 'rejected' | 'stale'

export interface IntentOutcome {
  status: IntentStatus
  reasonCode: string | null
  reason: string | null
  committedRevision: number | null
  detail?: string
}

export interface RegistrationRecord {
  inspectionId: string
  requestedPath: string
  canonicalPath: string
  gitCommonDir: string | null
  headOid: string | null
  dirty: boolean
  executionReady: boolean
  supported: boolean
  reasons: string[]
  readinessReasons: string[]
  executionNodeId: string
  createdAt: number
}

export interface AuthorityOptions {
  runner: WorkbenchRunner
  sessionId: string
  pluginGeneration: number
  clock?: () => number
  newId?: (prefix: string) => string
  git?: GitRunner
  registrationTtlMs?: number
  /** How long one adopt exchange stays open for its acknowledgement. */
  ackDeadlineMs?: number
  offeredRoles?: readonly string[]
  /** Injected observer transport. Phase 2 uses a fake in tests and NDJSON in the real composition. */
  transport?: () => ObserverPort | null
}

export interface Observation {
  choiceId: string
  observedSessionId: string
  role: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

export class WorkbenchAuthority {
  readonly runner: WorkbenchRunner
  readonly sessionId: string
  readonly pluginGeneration: number
  readonly executionNodeId: string
  readonly clock: () => number
  readonly newId: (prefix: string) => string
  readonly adoption: AdoptionManager

  private readonly git: GitRunner | undefined
  private readonly registrationTtlMs: number
  private readonly offeredRoles: readonly string[]
  private readonly transport: () => ObserverPort | null
  private observations = new Map<string, Observation>()
  private registrations = new Map<string, RegistrationRecord>()
  private revision: number
  private cursor: number
  private commandContext: { revision: number; cursor: number } | null = null

  constructor(options: AuthorityOptions) {
    this.runner = options.runner
    this.sessionId = options.sessionId
    this.pluginGeneration = options.pluginGeneration
    this.executionNodeId = options.runner.nodeId
    this.clock = options.clock ?? (() => Date.now())
    this.newId = options.newId ?? defaultNewId
    this.git = options.git
    this.registrationTtlMs = options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS
    this.offeredRoles = options.offeredRoles ?? OFFERED_ROLES
    this.transport = options.transport ?? (() => null)
    this.revision = Number(options.runner.store.getMeta('projection_revision') ?? '0')
    this.cursor = Math.max(0, options.runner.store.maxCursor())
    this.adoption = new AdoptionManager(this, () => this.transport(), options.ackDeadlineMs)
    const port = this.transport()
    if (port !== null) {
      port.subscribe(event => this.onTransportEvent(event))
      this.adoption.bind()
    }
  }

  revisionOf(): number {
    return this.revision
  }

  /** Observer-reported Pi sessions become adoptable choices. */
  private onTransportEvent(event: TransportEvent): void {
    if (event.type !== 'session_observed') return
    const observedSessionId = event.observedSessionId
    const role = event.role
    if (typeof observedSessionId !== 'string' || observedSessionId.length === 0) return
    const choiceId = `choice-${this.newId('obs-')}`
    this.observations.set(choiceId, { choiceId, observedSessionId, role: role ?? 'implementer' })
  }

  get observedChoices(): Observation[] {
    return [...this.observations.values()]
  }

  get currentRevision(): number {
    return this.revision
  }

  get currentCursor(): number {
    return this.cursor
  }

  // -------------------------------------------------------------------------
  // Durable management
  // -------------------------------------------------------------------------

  /** Resolve Git facts for a candidate path. Transient: no durable write. */
  inspect(requestedPath: unknown): RegistrationRecord {
    const inspection: GitInspection = inspectProjectPath(requestedPath, this.git)
    if (this.isInsideStateRoot(inspection.canonicalPath)) {
      throw workbenchError('unsafe_path', `${inspection.canonicalPath} is inside the workbench state root`, 'choose a Project outside the workbench state directory')
    }
    const record: RegistrationRecord = {
      inspectionId: this.newId('insp-'),
      requestedPath: inspection.requestedPath,
      canonicalPath: inspection.canonicalPath,
      gitCommonDir: inspection.gitCommonDir,
      headOid: inspection.headOid,
      dirty: inspection.dirty,
      executionReady: inspection.executionReady,
      supported: inspection.supported,
      reasons: [...inspection.reasons],
      readinessReasons: [...inspection.readinessReasons],
      executionNodeId: this.executionNodeId,
      createdAt: this.clock(),
    }
    this.pruneRegistrations()
    this.registrations.set(record.inspectionId, record)
    return record
  }

  /**
   * Confirm a previously resolved inspection. Facts are re-derived from the
   * canonical path and must still match; a changed context requires a new
   * inspection rather than silently registering newer facts.
   */
  confirmRegistration(inspectionId: unknown): ProjectRecord {
    if (typeof inspectionId !== 'string') {
      throw workbenchError('invalid_input', 'registrationId must be a string', 'inspect the Project again and confirm the returned registrationId')
    }
    const record = this.registrations.get(inspectionId)
    if (record === undefined) {
      throw workbenchError('invalid_input', `no current inspection ${inspectionId}`, 'inspect the Project path again; inspections are transient and expire')
    }
    if (this.clock() - record.createdAt > this.registrationTtlMs) {
      this.registrations.delete(inspectionId)
      throw workbenchError('invalid_input', `inspection ${inspectionId} expired`, 'inspect the Project path again and confirm the fresh registrationId')
    }
    const current = inspectProjectPath(record.requestedPath, this.git)
    if (!current.supported) {
      throw workbenchError('invalid_input', `Project is no longer registrable: ${current.reasons.join(', ')}`, 'resolve the Git context and inspect the path again')
    }
    if (this.isInsideStateRoot(current.canonicalPath)) {
      throw workbenchError('unsafe_path', 'Project overlaps the workbench state root', 'choose a state root outside every registered Project')
    }
    if (current.canonicalPath !== record.canonicalPath || (current.gitCommonDir ?? null) !== (record.gitCommonDir ?? null)) {
      throw workbenchError('invalid_input', 'Project Git context changed since inspection', 'inspect the Project path again and confirm the fresh registrationId')
    }
    const existing = this.runner.store.listProjects().find(project => project.canonicalPath === current.canonicalPath)
    if (existing) {
      throw workbenchError('invalid_input', `${current.canonicalPath} is already registered as ${existing.projectId}`, 'select the existing Project instead of registering it twice')
    }
    // Overlapping storage is refused in both directions: an ancestor of a
    // registered Project, or a descendant of one, would give two Projects claim
    // to the same files and the same Git history.
    const overlapping = this.runner.store.listProjects().find(project =>
      project.canonicalPath === current.canonicalPath
      || project.canonicalPath.startsWith(`${current.canonicalPath}/`)
      || current.canonicalPath.startsWith(`${project.canonicalPath}/`))
    if (overlapping) {
      throw workbenchError('invalid_input', `${current.canonicalPath} overlaps registered Project ${overlapping.projectId} at ${overlapping.canonicalPath}`, 'register one Project per storage tree; overlapping paths cannot both own the same files')
    }
    const projectId = this.newId('proj-')
    const project: ProjectRecord = {
      projectId,
      executionNodeId: this.executionNodeId,
      canonicalPath: current.canonicalPath,
      gitCommonDir: current.gitCommonDir ?? '',
      headOid: current.headOid,
      dirty: current.dirty,
      contextDigest: contextDigestOf(current),
      revision: 1,
      createdAt: this.clock(),
    }
    this.commit('project_registered', { projectId, canonicalPath: project.canonicalPath }, () => {
      this.runner.store.putProject(project)
      const selection = this.runner.store.getMeta('selected_project_id')
      if (selection === null) this.runner.store.setMeta('selected_project_id', projectId)
    })
    this.registrations.delete(inspectionId)
    return project
  }

  createGoal(projectId: unknown, goalText: unknown): GoalRecord {
    const project = this.requireProject(projectId)
    if (typeof goalText !== 'string' || goalText.trim().length === 0) {
      throw workbenchError('invalid_input', 'goal text must not be empty', 'enter a Team Goal for the selected Project')
    }
    const goal: GoalRecord = {
      goalId: this.newId('goal-'),
      projectId: project.projectId,
      goalText,
      state: 'active',
      outcome: null,
      createdAt: this.clock(),
    }
    this.commit('goal_created', { goalId: goal.goalId, projectId: project.projectId }, () => {
      this.runner.store.insertGoal(goal)
      this.runner.store.setMeta('selected_project_id', project.projectId)
      this.runner.store.setMeta('selected_goal_id', goal.goalId)
    })
    return goal
  }

  createCheck(projectId: unknown, input: {
    name: unknown
    summary: unknown
    mode: unknown
    commandSummary: unknown
    definitionDraft: unknown
  }): CheckRecord {
    const project = this.requireProject(projectId)
    const fields = this.normalizeCheckFields(input)
    const checkId = this.newId('check-')
    const body = { projectId: project.projectId, checkId, version: 1, ...fields }
    const digest = sha256(body)
    const check: CheckRecord = {
      projectId: project.projectId,
      checkId,
      version: 1,
      digest,
      canonicalJson: canonicalJson(body),
      name: fields.name,
      mode: fields.mode,
      createdAt: this.clock(),
    }
    this.commit('check_created', { checkId, projectId: project.projectId, version: 1 }, () => {
      this.runner.store.putCheck(check)
    })
    return check
  }

  configureCheck(projectId: unknown, checkId: unknown, checkVersion: unknown, input: {
    name: unknown
    summary: unknown
    mode: unknown
    commandSummary: unknown
    definitionDraft: unknown
  }): CheckRecord {
    const project = this.requireProject(projectId)
    const latest = this.runner.store.latestCheck(project.projectId, String(checkId))
    if (latest === null) {
      throw workbenchError('missing_resource', `no check ${String(checkId)} in ${project.projectId}`, 'select a configured check from the committed catalogue')
    }
    if (latest.version !== Number(checkVersion)) {
      throw workbenchError('invalid_input', `check ${latest.checkId} is at version ${latest.version}, not ${String(checkVersion)}`, 'reload the committed check version before saving; the runner rejects stale edits')
    }
    const fields = this.normalizeCheckFields(input)
    const version = latest.version + 1
    const body = { projectId: project.projectId, checkId: latest.checkId, version, ...fields }
    const digest = sha256(body)
    const check: CheckRecord = {
      projectId: project.projectId,
      checkId: latest.checkId,
      version,
      digest,
      canonicalJson: canonicalJson(body),
      name: fields.name,
      mode: fields.mode,
      createdAt: this.clock(),
    }
    this.commit('check_configured', { checkId: check.checkId, projectId: project.projectId, version }, () => {
      this.runner.store.putCheck(check)
    })
    return check
  }

  selectProject(projectId: unknown): void {
    const project = this.requireProject(projectId)
    if (this.runner.store.getMeta('selected_project_id') === project.projectId) return
    this.commit('project_selected', { projectId: project.projectId }, () => {
      this.runner.store.setMeta('selected_project_id', project.projectId)
      this.runner.store.setMeta('selected_goal_id', '')
    })
  }

  selectGoal(goalId: unknown): void {
    const goalIdText = String(goalId)
    const goal = this.runner.store.getGoal(goalIdText)
    if (goal === null) {
      throw workbenchError('missing_resource', `no Goal ${goalIdText}`, 'select a Goal from the committed Team Goals list')
    }
    const selectedProject = this.runner.store.getMeta('selected_project_id')
    if (selectedProject !== goal.projectId) {
      throw workbenchError('invalid_input', `Goal ${goalIdText} belongs to another Project`, 'select its Project first')
    }
    if (this.runner.store.getMeta('selected_goal_id') === goalIdText) return
    this.commit('goal_selected', { goalId: goalIdText }, () => {
      this.runner.store.setMeta('selected_goal_id', goalIdText)
    })
  }

  // -------------------------------------------------------------------------
  // Intent routing and durable deduplication
  // -------------------------------------------------------------------------

  handleIntent(intent: {
    intentId: string
    sessionId: string
    pluginGeneration: number
    runnerEpoch: number
    expectedRevision: number
    kind: string
    target: string | null
    payload: Record<string, unknown>
  }): IntentOutcome {
    if (this.commandContext !== null) throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome')
    const payloadHash = sha256({ kind: intent.kind, target: intent.target, payload: intent.payload })
    const recorded = this.runner.store.getIntentResult(intent.intentId)
    if (recorded !== null) {
      if (recorded.payloadHash !== payloadHash) {
        return { status: 'rejected', reasonCode: 'intent_identity_conflict', reason: 'This intent id was already recorded with a different payload.', committedRevision: null }
      }
      return {
        status: recorded.status as IntentStatus,
        reasonCode: recorded.reasonCode,
        reason: recorded.reason ?? null,
        committedRevision: recorded.committedRevision,
        ...(recorded.detail == null ? {} : { detail: recorded.detail }),
      }
    }
    if (intent.pluginGeneration !== this.pluginGeneration) {
      return this.record(intent.intentId, payloadHash, { status: 'stale', reasonCode: 'plugin_generation_changed', reason: 'The Companion generation changed; reload its projection before acting.', committedRevision: null })
    }
    if (intent.sessionId !== this.sessionId || intent.runnerEpoch !== this.runner.epoch) {
      return this.record(intent.intentId, payloadHash, { status: 'stale', reasonCode: 'runner_epoch_changed', reason: 'The workbench runner restarted; reload the projection before acting.', committedRevision: null })
    }
    if (intent.expectedRevision !== this.revision) {
      return this.record(intent.intentId, payloadHash, { status: 'stale', reasonCode: 'revision_changed', reason: 'The projection changed; re-read the current state before acting.', committedRevision: null })
    }
    try {
      if (['confirm_register_project', 'select_project', 'select_goal', 'create_goal', 'create_check', 'configure_checks'].includes(intent.kind)) {
        const context = { revision: this.revision, cursor: this.cursor }
        const registrations = new Map(this.registrations)
        this.commandContext = context
        try {
          const outcome = this.runner.store.transaction(() => {
            const routed = this.route(intent)
            const normalized = routed.committedRevision === null ? routed : { ...routed, committedRevision: context.revision }
            return this.record(intent.intentId, payloadHash, normalized)
          })
          this.revision = context.revision
          this.cursor = context.cursor
          return outcome
        } catch (error) {
          this.registrations = registrations
          throw error
        } finally { this.commandContext = null }
      }
      const outcome = this.route(intent)
      return this.record(intent.intentId, payloadHash, outcome)
    } catch (error) {
      if (error instanceof Error && (error as { name?: string }).name === 'WorkbenchError') {
        const code = (error as { code?: string }).code ?? 'invalid_input'
        return this.record(intent.intentId, payloadHash, { status: 'rejected', reasonCode: code, reason: error.message, committedRevision: null })
      }
      throw error
    }
  }

  private route(intent: { kind: string; target: string | null; payload: Record<string, unknown> }): IntentOutcome {
    switch (intent.kind) {
      case 'inspect_project': {
        const record = this.inspect(intent.payload.path)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: null, detail: 'registration' }
      }
      case 'confirm_register_project': {
        this.confirmRegistration(intent.payload.registrationId)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'select_project': {
        this.selectProject(intent.payload.projectId)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'select_goal': {
        this.selectGoal(intent.payload.goalId)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'create_goal': {
        this.createGoal(intent.payload.projectId, intent.payload.goalText)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'create_check': {
        this.createCheck(intent.payload.projectId, {
          name: intent.payload.name,
          summary: intent.payload.summary,
          mode: intent.payload.mode,
          commandSummary: intent.payload.commandSummary,
          definitionDraft: intent.payload.definitionDraft,
        })
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'configure_checks': {
        this.configureCheck(intent.payload.projectId, intent.payload.checkId, intent.payload.checkVersion, {
          name: intent.payload.name,
          summary: intent.payload.summary,
          mode: intent.payload.mode,
          commandSummary: intent.payload.commandSummary,
          definitionDraft: intent.payload.definitionDraft,
        })
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'request_adoption': {
        const choiceId = String(intent.payload.choiceId)
        const observation = this.observations.get(choiceId)
        if (observation === undefined) {
          throw workbenchError('missing_resource', `no observed Pi for choice ${choiceId}`, 'connect the observer transport and let the Pi extension report its sessions')
        }
        const projectId = this.selectedProjectId
        if (projectId === null) {
          throw workbenchError('invalid_input', 'no Project is selected', 'select the Project this Adoption belongs to')
        }
        const predecessor = this.runner.store.listBindings()
          .filter(binding => binding.projectId === projectId && binding.role === observation.role && (binding.state === 'retired' || binding.state === 'purged'))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))
          .at(-1)
        this.adoption.propose({
          projectId,
          goalId: this.selectedGoalId,
          role: observation.role,
          observedSessionId: observation.observedSessionId,
          predecessorRunId: predecessor?.runId ?? null,
        })
        this.observations.delete(choiceId)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'authorize_adoption': {
        this.adoption.authorize(String(intent.payload.proposalId))
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'take_control': {
        this.adoption.takeControl(String(intent.payload.agentRunId))
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'retire': {
        this.adoption.retire(String(intent.payload.agentRunId))
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'purge': {
        this.adoption.purge(String(intent.payload.agentRunId))
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'present':
      case 'recover':
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      default:
        return {
          status: 'rejected',
          reasonCode: 'handler_unavailable',
          reason: intent.kind === 'start_assignment' ? START_UNAVAILABLE_REASON : `No management handler owns the intent ${intent.kind}.`,
          committedRevision: null,
        }
    }
  }

  private record(intentId: string, payloadHash: string, outcome: IntentOutcome): IntentOutcome {
    this.runner.store.transaction(() => this.runner.store.putIntentResult({
      intentId,
      sessionId: this.sessionId,
      payloadHash,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      detail: outcome.detail ?? null,
      committedRevision: outcome.committedRevision,
      createdAt: this.clock(),
    }))
    return outcome
  }

  /** Append an event and advance revision/cursor inside the same transaction. */
  commit(kind: string, payload: Record<string, unknown>, mutate: () => void): number {
    const context = this.commandContext
    const baseRevision = context?.revision ?? this.revision
    const committedRevision = baseRevision + 1
    const cursor = (context?.cursor ?? this.cursor) + 1
    if (!Number.isSafeInteger(committedRevision) || !Number.isSafeInteger(cursor)) throw workbenchError('invalid_input', 'projection counter exhausted', 'never round or reset authority counters')
    this.runner.store.transaction(() => {
      mutate()
      const event: EventRecord = {
        eventId: this.newId('evt-'),
        runId: typeof payload.runId === 'string' ? payload.runId : null,
        cursor,
        baseRevision,
        revision: committedRevision,
        kind,
        createdAt: this.clock(),
      }
      this.runner.store.appendEvent(event)
      this.runner.store.setMeta('projection_revision', String(committedRevision))
    })
    if (context) {
      context.revision = committedRevision
      context.cursor = cursor
    } else {
      this.revision = committedRevision
      this.cursor = cursor
    }
    return committedRevision
  }

  // -------------------------------------------------------------------------
  // Authoritative projection
  // -------------------------------------------------------------------------

  get selectedProjectId(): string | null {
    const value = this.runner.store.getMeta('selected_project_id')
    return value === null || value.length === 0 ? null : value
  }

  get selectedGoalId(): string | null {
    const value = this.runner.store.getMeta('selected_goal_id')
    return value === null || value.length === 0 ? null : value
  }

  private requireProject(projectId: unknown): ProjectRecord {
    const project = this.runner.store.getProject(String(projectId))
    if (project === null) {
      throw workbenchError('missing_resource', `no Project ${String(projectId)}`, 'register or select a committed Project first')
    }
    return project
  }

  private normalizeCheckFields(input: { name: unknown; summary: unknown; mode: unknown; commandSummary: unknown; definitionDraft: unknown }) {
    const name = String(input.name ?? '')
    const summary = String(input.summary ?? '')
    const mode = String(input.mode ?? '')
    const commandSummary = String(input.commandSummary ?? '')
    if (name.trim().length === 0) throw workbenchError('invalid_input', 'check name must not be empty', 'give the check a name')
    if (!['validator', 'artifact_presence'].includes(mode)) {
      throw workbenchError('invalid_input', `unsupported check mode ${mode}`, 'choose validator or artifact_presence')
    }
    return { name, summary, mode, commandSummary, definitionDraft: input.definitionDraft ?? null }
  }

  private isInsideStateRoot(canonicalPath: string): boolean {
    const root = this.runner.roots.stateDir
    return canonicalPath === root || canonicalPath.startsWith(`${root}/`) || root.startsWith(`${canonicalPath}/`)
  }

  private pruneRegistrations(): void {
    const now = this.clock()
    for (const [id, record] of this.registrations) {
      if (now - record.createdAt > this.registrationTtlMs) this.registrations.delete(id)
    }
  }

  currentRegistration(inspectionId: string): RegistrationRecord | null {
    return this.registrations.get(inspectionId) ?? null
  }

  /** Most recent unresolved inspection, newest first. Transient by design. */
  pendingRegistration(): RegistrationRecord | null {
    let newest: RegistrationRecord | null = null
    for (const record of this.registrations.values()) {
      if (newest === null || record.createdAt >= newest.createdAt) newest = record
    }
    return newest
  }
}
