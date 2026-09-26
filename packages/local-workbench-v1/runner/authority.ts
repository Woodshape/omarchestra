/**
 * Local Workbench v1 Phase 2 — authoritative management layer.
 *
 * Owns the durable Project registry, Team Goals, Project-scoped checks,
 * selection, projection revision/cursor, intent deduplication and the
 * authoritative snapshot. One instance wraps one open runner.
 *
 * Database-only commands (including request-Adoption and Take control) commit
 * effects, events and receipts together. Retirement/purge use a recoverable
 * authorization journal across the independent ledger. Adoption delivery uses
 * durable post-commit intent; real bridge integration remains separate.
 * Projection revisions advance only after the owning transaction commits. An intent whose complete envelope hash
 * differs from a previously recorded intent with the same id is rejected
 * instead of being reapplied.
 *
 * The presentation route composes reviewed Start, same-Pi delivery, structured
 * Candidate association and bounded acceptance. Each stage remains fenced by
 * durable authority and the exact current challenged connection.
 */

import { canonicalJson, sha256 } from './canonical-hash.ts'
export { canonicalJson, sha256 } from './canonical-hash.ts'
import { defaultNewId } from './identity.ts'
import { incarnationKey } from './binding-identity.ts'
import { workbenchError } from './errors.ts'
import type { GitRunner, GitInspection } from './git-context.ts'
import { contextDigestOf, inspectProjectPath } from './git-context.ts'
import { pathsOverlap } from './project-identity.ts'
import { ensureOwnedDirectory } from './paths.ts'
import { armAssignmentBudget, assignmentRemainingMs, registerAssignmentGate, abortAssignmentGate } from './assignment-budget.ts'
import { readResolvedCheck, resolveCheckDefinition, verifyCheckResources, type ResolvedCheckDefinition } from './check-definition.ts'
import { captureStableProjectBaseline } from './content-manifest.ts'
import { executeGate, type GateExecution } from './gate-executor.ts'
import { verifyCandidateArtifacts } from './candidate-submission.ts'
import type { WorkbenchRunner } from './runner.ts'
import { handoffDigest, STOP_TRIGGERS } from './store.ts'
import type {
  ArtifactRef, AssignmentDelivery, AssignmentRecord, AssignmentState, AssignmentStopRecord, AttemptRecord,
  CancellationStatus, CandidateRecord, CheckRecord, EventRecord, GateAcceptance, GateOutcome, GateResultRecord,
  GoalRecord, HandoffClaimedState, HandoffRecord, OutstandingEffects, ProjectRecord, StopTrigger, WriterState,
} from './store.ts'
import { prepareStartProposal, revalidateStartProposal, type StartProposal, type StartProposalAuthority, type StartProposalOptions, type StartProposalRequest } from './start-proposal.ts'
import { AdoptionManager } from './adoption.ts'
import { FramedAdoptionManager } from './framed-adoption.ts'
import { bindAssignmentIntervention, type AssignmentIntervention } from './assignment-intervention.ts'
import { buildSnapshot } from './projection.ts'
import { PAGE_COLLECTIONS, WORKBENCH_PAGE_SIZE, type PageCollection } from '../console/schema.ts'
import type { BridgeRegistry, ObservedPi, AttemptQuiescence } from './bridge-registry.ts'
import { validateAuthorityIntent } from './intent-envelope.ts'
import type { WorkbenchIntent } from '../console/schema.ts'
import type { ObserverPort, TransportEvent } from './transport.ts'

export const OFFERED_ROLES = ['implementer', 'reviewer'] as const
export const DEFAULT_REGISTRATION_TTL_MS = 5 * 60 * 1000
/** Phase 2 refuses work execution; the reason is committed, not local to QML. */
export const EXECUTION_UNAVAILABLE_REASON = 'Check resources are revalidated during Start review and immediately before Candidate validation.'
export const START_UNAVAILABLE_REASON = 'A current Runner-validated Start Review is required before Assignment admission.'
/** One queued outbox item must be sendable on one current challenged bridge. */
export const ASSIGNMENT_DELIVERY_TTL_MS = 30_000
/** A transient review must be confirmed promptly against its exact captured revision. */
export const START_REVIEW_TTL_MS = 30_000

/** Test-only crash boundaries inside the disposable admission transaction. */
export type AdmissionPhase = 'assignment_written' | 'attempt_written' | 'writer_held' | 'delivery_queued' | 'receipt_recorded'

export interface StartAdmissionInput {
  /** Complete bounded `start_assignment` envelope that names this exact review. */
  intent: unknown
  proposal: StartProposal
  options?: StartProposalOptions
}

export interface StartAdmission {
  status: 'acknowledged'
  assignmentId: string
  attemptId: string
  deliveryId: string
  writerEpoch: number
  committedRevision: number
  /** True when an exact envelope replay read the retained receipt. */
  replayed: boolean
}

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
  dirty: boolean | null
  repositoryIdentity: string | null
  reconfirmProjectId: string | null
  priorContextDigest: string | null
  priorProjectRevision: number | null
  executionReady: boolean
  supported: boolean
  reasons: string[]
  readinessReasons: string[]
  executionNodeId: string
  createdAt: number
}

export interface ProjectContextStatus {
  available: boolean
  dirty: boolean | null
  reason: string | null
}

function copyRegistration(record: RegistrationRecord): RegistrationRecord {
  return { ...record, reasons: [...record.reasons], readinessReasons: [...record.readinessReasons] }
}

interface AdmissionReference { assignmentId: string; attemptId: string; deliveryId: string; writerEpoch: number }

/** The receipt detail retains the exact identities a replay must report. */
function encodeAdmissionDetail(reference: AdmissionReference): string {
  return canonicalJson(reference)
}

function decodeAdmissionDetail(detail: string | null): AdmissionReference | null {
  if (detail === null || detail.length === 0) return null
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
        || typeof parsed.assignmentId !== 'string' || typeof parsed.attemptId !== 'string'
        || typeof parsed.deliveryId !== 'string' || !Number.isSafeInteger(parsed.writerEpoch)) return null
    return { assignmentId: parsed.assignmentId, attemptId: parsed.attemptId, deliveryId: parsed.deliveryId, writerEpoch: parsed.writerEpoch as number }
  } catch { return null }
}

function staleStart(message: string): never {
  throw workbenchError('identity_drift', `Start confirmation is stale: ${message}`,
    'discard this review and prepare a fresh Start Review from the current authoritative snapshot')
}

/** Bounded, deterministic frame for one committed Attempt delivery. */
function attemptFrame(assignment: AssignmentRecord, attempt: AttemptRecord, deadline: number): Record<string, unknown> {
  return {
    protocol: 'omarchestra.assignment/v1',
    kind: 'assignment_delivery',
    deliveryId: attempt.deliveryId,
    controlEpoch: attempt.controlEpoch,
    assignmentId: assignment.assignmentId,
    attemptId: attempt.attemptId,
    runId: attempt.runBinding.runId,
    projectId: assignment.projectId,
    goalId: assignment.goalId,
    goalText: assignment.goalText,
    taskText: assignment.taskText,
    writeAuthority: assignment.writeAuthority,
    limits: { ...assignment.limits },
    gate: {
      checkId: attempt.gate.checkId,
      version: attempt.gate.version,
      digest: attempt.gate.digest,
      canonicalJson: attempt.gate.canonicalJson,
    },
    runBinding: { ...attempt.runBinding },
    context: { ...attempt.context },
    deadline,
  }
}

/** Bounded, deterministic frame an AL-03 delivery sends once for this delivery id. */
function admissionFrame(proposal: StartProposal, deadline: number): Record<string, unknown> {
  return attemptFrame(proposal.assignment, proposal.attempt, deadline)
}

/** Test-only observation points around the AL-05 gate acceptance. */
export type AssignmentGatePhase = 'validating_committed' | 'gate_returned' | 'result_recorded' | 'before_acceptance' | 'resolved'

export interface AssignmentGateInput {
  assignmentId: string
  attemptId: string
  candidateId: string
}

/**
 * Evidence that the one challenged Pi for this Run reported no known model or
 * tool work after the validator child exited. `validator_exit` proves only that
 * the child exited, never that Pi tools stopped; only `confirmed` accepts.
 */
export type GateQuiescence = AttemptQuiescence

export interface AssignmentGateResult {
  accepted: boolean
  outcome: GateOutcome
  reasonCode: string | null
  resultId: string
  committedRevision: number
}

export interface AssignmentGateOptions {
  /**
   * Existing Runner-owned scratch root the bounded executor creates exactly one
   * session directory inside. It must never be the owned state directory.
   */
  scratchRoot: string
  /** Cooperative-termination grace forwarded to the bounded executor. */
  graceMs?: number
  /** Disposable-test evidence seam; production always queries the challenged bridge. */
  quiescence?: (context: { assignment: AssignmentRecord; attempt: AttemptRecord; candidate: CandidateRecord; outcome: GateOutcome; clean: boolean }) => GateQuiescence
}

/** AL-06 explicit reconciliation decision. Never routed from `handleIntent`. */
export type ReconciliationDecision = 'accept' | 'resume' | 'retry'

export interface AssignmentStopInput {
  assignmentId: string
  trigger?: StopTrigger
  reasonCode?: string | null
}

export interface AssignmentStopOutcome {
  status: 'stopped'
  stopId: string
  assignmentId: string
  dispatchRevoked: true
  cancellationStatus: CancellationStatus
  writerState: WriterState
  /** True when an exact committed stop already existed and was returned. */
  replayed: boolean
  committedRevision: number
}

export interface AssignmentTakeoverInput {
  assignmentId: string
  reasonCode?: string | null
}

export interface AssignmentTakeoverOutcome {
  assignmentId: string
  controlEpoch: number
  state: AssignmentState
  writerState: WriterState
  committedRevision: number
}

export interface AssignmentHandoffInput {
  attemptId: string
  claimedState: HandoffClaimedState
  summary: string
  artifactRefs: ArtifactRef[]
  outstandingEffects: OutstandingEffects
}

export interface AssignmentHandoffOutcome {
  handoffId: string
  digest: string
  state: AssignmentState
  committedRevision: number
}

export interface AssignmentReconciliationInput {
  assignmentId: string
  decision: ReconciliationDecision
  /** Must equal the current projection revision; reconciliation is never implicit. */
  expectedRevision: number
  /** Exact retained handoff identity for `accept`/`resume`. */
  handoffId?: string
}

export interface AssignmentReconciliationOutcome {
  status: 'admitted' | 'rejected' | 'stopped'
  reasonCode: string | null
  attemptId: string | null
  deliveryId: string | null
  writerEpoch: number | null
  stopId: string | null
  committedRevision: number
}

const MAX_GATE_EVIDENCE_BYTES = 8192

/** C13: bounded, owner-only diagnostics; no raw child stdout/stderr and no full paths. */
function gateEvidence(outcome: GateOutcome, reasonCode: string | null, execution: GateExecution | null, preManifestDigest: string | null, postManifestDigest: string | null): string {
  const resourceDrift = execution === null ? [] : execution.resourceChecks
    .filter(check => check.pre !== 'verified' || check.post !== 'verified')
    .map(check => ({ kind: check.kind, pre: check.pre, post: check.post }))
  const json = canonicalJson({
    outcome,
    reasonCode,
    exitCode: execution?.exitCode ?? null,
    signal: execution?.signal ?? null,
    timedOut: execution?.timedOut ?? false,
    stdoutBytes: execution?.stdoutBytes ?? 0,
    stderrBytes: execution?.stderrBytes ?? 0,
    scratchCleaned: execution?.scratchCleaned ?? false,
    resourceCount: execution?.resourceChecks.length ?? 0,
    resourceDrift,
    preManifestDigest,
    postManifestDigest,
  })
  if (Buffer.byteLength(json) <= MAX_GATE_EVIDENCE_BYTES) return json
  return canonicalJson({ outcome, reasonCode, truncated: true })
}

export interface AuthorityOptions {
  runner: WorkbenchRunner
  sessionId: string
  pluginGeneration: number
  clock?: () => number
  /** Owner-lifetime elapsed/freshness clock, not persisted wall time. */
  monotonic?: () => number
  newId?: (prefix: string) => string
  git?: GitRunner
  registrationTtlMs?: number
  /** How long one adopt exchange stays open for its acknowledgement. */
  ackDeadlineMs?: number
  offeredRoles?: readonly string[]
  /** Injected observer transport. Phase 2 uses a fake in tests and NDJSON in the real composition. */
  transport?: () => ObserverPort | null
  /** Owner-only S4 registry; legacy injected object port is tests-only. */
  registry?: BridgeRegistry
  framedAdoption?: FramedAdoptionManager
  /** Test-only crash boundary observer for disposable admission transactions. */
  onAdmissionPhase?: (phase: AdmissionPhase) => void
  /** Test-only observation point around the AL-05 gate acceptance transaction. */
  onAssignmentGatePhase?: (phase: AssignmentGatePhase) => void
  /** Existing Runner-owned directory reserved for one bounded gate child. */
  gateScratchRoot?: string
  /** Starts the one outbox attempt after the durable admission transaction commits. */
  onAssignmentAdmitted?: (admission: StartAdmission) => void
}

export interface Observation {
  choiceId: string
  observedSessionId: string
  role: string
}

export class WorkbenchAuthority {
  readonly runner: WorkbenchRunner
  readonly sessionId: string
  readonly pluginGeneration: number
  readonly executionNodeId: string
  readonly clock: () => number
  readonly monotonic: () => number
  readonly newId: (prefix: string) => string
  readonly adoption: AdoptionManager
  readonly intervention: AssignmentIntervention | null

  private readonly git: GitRunner | undefined
  private readonly registrationTtlMs: number
  private readonly offeredRoles: readonly string[]
  private readonly transport: () => ObserverPort | null
  readonly registry: BridgeRegistry | null
  private observations = new Map<string, Observation>()
  private pages = new Map<PageCollection, number>()
  pageOffset(collection: PageCollection): number | null { return this.pages.get(collection) ?? null }
  private registrations = new Map<string, RegistrationRecord>()
  private projectContexts = new Map<string, ProjectContextStatus>()
  private readonly admissionPhase: ((phase: AdmissionPhase) => void) | undefined
  private readonly assignmentGatePhase: ((phase: AssignmentGatePhase) => void) | undefined
  private readonly gateScratchRoot: string | undefined
  private readonly onAssignmentAdmitted: ((admission: StartAdmission) => void) | undefined
  private pendingStartProposal: StartProposal | null = null
  private presentationStartIntentId: string | null = null
  private revision: number
  private cursor: number
  private commandContext: { revision: number; cursor: number; afterCommit: Array<() => void> } | null = null

  constructor(options: AuthorityOptions) {
    this.runner = options.runner
    this.sessionId = options.sessionId
    this.pluginGeneration = options.pluginGeneration
    this.executionNodeId = options.runner.nodeId
    this.clock = options.clock ?? (() => Date.now())
    this.monotonic = options.monotonic ?? options.clock ?? (() => performance.now())
    this.newId = options.newId ?? defaultNewId
    this.git = options.git
    this.registrationTtlMs = options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS
    this.offeredRoles = options.offeredRoles ?? OFFERED_ROLES
    this.transport = options.transport ?? (() => null)
    this.registry = options.registry ?? null
    this.admissionPhase = options.onAdmissionPhase
    this.assignmentGatePhase = options.onAssignmentGatePhase
    this.gateScratchRoot = options.gateScratchRoot
    this.onAssignmentAdmitted = options.onAssignmentAdmitted
    this.revision = Number(options.runner.store.getMeta('projection_revision') ?? '0')
    this.cursor = Math.max(0, options.runner.store.maxCursor())
    // Startup revalidation changes availability, never the saved repository binding.
    for (const project of this.runner.store.listProjects()) this.refreshProjectContext(project)
    if (options.framedAdoption && !this.registry) throw new Error('framed_manager_requires_registry')
    this.adoption = options.framedAdoption ?? (this.registry ? new FramedAdoptionManager(this, this.registry) : new AdoptionManager(this, () => this.transport(), options.ackDeadlineMs))
    options.framedAdoption?.rebind(this)
    this.intervention = bindAssignmentIntervention(this, { git: this.git, frame: attemptFrame, admitted: this.onAssignmentAdmitted })
    const port = this.transport()
    if (port !== null) {
      port.subscribe(event => this.onTransportEvent(event))
      this.adoption.bind()
    }
  }

  revisionOf(): number {
    return this.revision
  }

  get gateExecutionAvailable(): boolean { return this.gateScratchRoot !== undefined }
  gateExecutionAvailableFor(projectPath: string): boolean { return this.gateScratchRoot !== undefined && !pathsOverlap(projectPath, this.gateScratchRoot) }

  /** Current transient review for display only; expiry or any revision change hides it. */
  startReviewForProjection(): StartProposal | null {
    const proposal = this.pendingStartProposal
    const now = this.clock()
    if (proposal === null || proposal.revision !== this.revision || now < proposal.createdAt || now - proposal.createdAt >= START_REVIEW_TTL_MS) return null
    return proposal
  }

  /** Persist a framed Candidate and its projection event in the same SQLite transaction. */
  associateCandidate(input: { submission: import('./store.ts').CandidateSubmissionFacts; candidateId: string; createdAt: number }): import('./store.ts').CandidateAssociation {
    if (this.commandContext !== null) throw workbenchError('invalid_input', 'Candidate arrived during an authority transaction', 'retry only through the exact current extension receipt')
    const existing = this.runner.store.getCandidateByAttempt(input.submission.attemptId)
    if (existing !== null) return this.runner.store.submitCandidate(input)
    const box: { association: import('./store.ts').CandidateAssociation | null } = { association: null }
    this.commit('candidate_submitted', {
      assignmentId: input.submission.assignmentId, attemptId: input.submission.attemptId,
      runId: input.submission.agentRunId, candidateId: input.candidateId,
    }, () => {
      const assignment = this.runner.store.getAssignment(input.submission.assignmentId)
      const attempt = this.runner.store.getAttempt(input.submission.attemptId)
      const delivery = this.runner.store.getAssignmentDelivery(input.submission.attemptId)
      const writer = assignment ? this.runner.store.getWriter(assignment.projectId) : null
      if (!assignment || !attempt || !delivery || delivery.state !== 'written' || !writer || writer.state !== 'held'
          || writer.assignmentId !== assignment.assignmentId || writer.attemptId !== attempt.attemptId || writer.epoch !== attempt.writerEpoch) {
        throw workbenchError('fence_conflict', 'the exact delivered Attempt and held Project writer are required for Candidate association', 'submit only for the current acknowledged Attempt')
      }
      let assignmentState = assignment.state
      let attemptState = attempt.state
      const transitions = [
        ['admitted', 'dispatching'], ['dispatching', 'running'], ['running', 'candidate'],
      ] as const
      for (const [from, to] of transitions) {
        if (assignmentState !== from) continue
        if (assignmentState === from) {
          if (attemptState !== from
              || !this.runner.store.transitionAssignment(assignment.assignmentId, from, to, this.revision + 1, input.createdAt)
              || !this.runner.store.transitionAttempt(attempt.attemptId, from, to, input.createdAt)) {
            throw workbenchError('fence_conflict', 'Assignment lifecycle changed before Candidate association', 're-read the exact current Attempt')
          }
          assignmentState = to
          attemptState = to
        }
      }
      if (assignmentState !== 'candidate' || attemptState !== 'candidate') {
        throw workbenchError('fence_conflict', 'Assignment or Attempt is not awaiting this Candidate', 'submit only for the current delivered Attempt')
      }
      box.association = this.runner.store.submitCandidate(input)
    })
    if (box.association === null) throw workbenchError('integrity_failure', 'Candidate association produced no durable result', 're-read the exact Attempt and extension receipt')
    return box.association
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

  /** Presentation eligibility only. Propose/authorize/ACK still revalidate authority. */
  observedAdoptionProblem(agent: ObservedPi, proposalId?: string): { code: string; reason: string } | null {
    const blocked = (code: string, reason: string) => ({ code, reason })
    if (!agent.available) return blocked('session_unavailable', 'Adoption unavailable: the Pi connection is unavailable.')
    if (agent.mode !== 'observed') return blocked('already_managed', 'Adoption unavailable: this Pi is already managed.')
    if (agent.lifecycle !== 'running') return blocked('session_not_running', 'Adoption unavailable: this Pi is not running.')
    if (agent.activity === 'busy') return blocked('session_busy', 'Adoption unavailable: Pi reports busy; wait until it is idle.')
    if (agent.activity === 'waiting_for_user') return blocked('waiting_for_user', 'Adoption unavailable: Pi is waiting for user input in its terminal.')
    if (agent.activity !== 'idle') return blocked('activity_unknown', 'Adoption unavailable: Pi activity is unknown.')
    if (agent.health !== 'healthy') return blocked('session_unhealthy', 'Adoption unavailable: Pi reports degraded health.')
    const key = incarnationKey(agent.incarnation)
    if (agent.incarnation.executionNodeId !== this.executionNodeId || this.runner.fences.isIncarnationFenced(key)) {
      return blocked('identity_ineligible', 'Adoption unavailable: this Pi identity is not eligible on this Node.')
    }
    const goalId = this.selectedGoalId, goal = goalId ? this.runner.store.getGoal(goalId) : null
    if (!goal || goal.projectId !== this.selectedProjectId) return blocked('goal_required', 'Select a local Team Goal before Adoption.')
    if (goal.state !== 'active') return blocked('goal_inactive', 'Adoption unavailable: the selected Team Goal is not active.')
    if (!this.projectContext(goal.projectId).available) return blocked('project_context_unavailable', 'Adoption unavailable: the selected Project context is unavailable.')
    if (this.runner.store.listBindings().some(b => this.runner.store.getBindingIdentity(b.runId)?.incarnationKey === key)) {
      return blocked('already_managed', 'Adoption unavailable: this Pi already has a retained management binding.')
    }
    const proposals = this.runner.store.listProposals()
    const pending = proposals.find(p => p.observedSessionId === agent.observedSessionId)
    if (pending) {
      if (pending.proposalId !== proposalId || pending.goalId !== goalId || pending.state !== 'proposed') {
        return blocked('adoption_pending', 'Adoption is already pending for this Pi; wait for its outcome or expiry.')
      }
      const current = this.registry?.currentBinding(agent.observedSessionId)
      if (!current || current.connectionId !== pending.connectionId || current.challenge !== pending.challenge
          || incarnationKey(pending.incarnation) !== key) {
        return blocked('proposal_stale', 'Adoption unavailable: the proposal names an obsolete Pi connection; wait for expiry.')
      }
      if (this.runner.store.listMemberships(goalId!).some(m => m.role === pending.role)) {
        return blocked('roles_unavailable', 'Adoption unavailable: the proposed Role is occupied.')
      }
      return null
    }
    if (proposalId) return blocked('proposal_stale', 'Adoption unavailable: the proposal is no longer current.')
    if (proposals.length >= 16) return blocked('adoption_capacity', 'Adoption unavailable: pending Adoption capacity is reached.')
    if (this.availableObservedRoles(goalId!).length === 0) {
      return blocked('roles_unavailable', 'Adoption unavailable: all offered Roles in this Goal are occupied or reserved.')
    }
    return null
  }

  private availableObservedRoles(goalId: string): readonly string[] {
    const members = this.runner.store.listMemberships(goalId), proposals = this.runner.store.listProposals()
    return this.offeredRoles.filter(role => !members.some(m => m.role === role)
      && !proposals.some(p => p.goalId === goalId && p.role === role))
  }

  get observedChoices(): Observation[] {
    if (this.registry) {
      const goalId = this.selectedGoalId
      const goal = goalId ? this.runner.store.getGoal(goalId) : null
      if (!goal || goal.projectId !== this.selectedProjectId) { this.observations.clear(); return [] }
      const choices: Observation[] = []
      const retained = new Set<string>()
      for (const agent of this.registry.listCurrent()) {
        if (this.observedAdoptionProblem(agent)) continue
        for (const role of this.availableObservedRoles(goalId!)) {
          const existing = [...this.observations.values()].find(c => c.observedSessionId === agent.observedSessionId && c.role === role)
          const choice = existing ?? { choiceId: this.newId('choice-'), observedSessionId: agent.observedSessionId, role }
          this.observations.set(choice.choiceId, choice)
          retained.add(choice.choiceId)
          choices.push({ ...choice })
        }
      }
      for (const choiceId of this.observations.keys()) if (!retained.has(choiceId)) this.observations.delete(choiceId)
      return choices
    }
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
    if (this.isInsideStateRoot(inspection.canonicalPath) || (inspection.gitCommonDir !== null && this.isInsideStateRoot(inspection.gitCommonDir))) {
      throw workbenchError('unsafe_path', `${inspection.canonicalPath} is inside the workbench state root`, 'choose a Project outside the workbench state directory')
    }
    const existing = this.runner.store.listProjects().find(project => project.canonicalPath === inspection.canonicalPath)
    const reconfirm = existing && existing.contextDigest !== inspection.repositoryIdentity ? existing : null
    if (existing) {
      const available = inspection.supported && !reconfirm && existing.executionNodeId === this.executionNodeId
        && existing.gitCommonDir === inspection.gitCommonDir
      this.projectContexts.set(existing.projectId, { available, dirty: available ? inspection.dirty : null,
        reason: available ? null : reconfirm ? 'repository_identity_changed'
          : inspection.reasons.join(', ') || 'repository_identity_unavailable' })
    }
    const record: RegistrationRecord = {
      inspectionId: this.newId('insp-'),
      requestedPath: inspection.requestedPath,
      canonicalPath: inspection.canonicalPath,
      gitCommonDir: inspection.gitCommonDir,
      headOid: inspection.headOid,
      dirty: inspection.dirty,
      repositoryIdentity: inspection.repositoryIdentity,
      reconfirmProjectId: reconfirm?.projectId ?? null,
      priorContextDigest: reconfirm?.contextDigest ?? null,
      priorProjectRevision: reconfirm?.revision ?? null,
      executionReady: inspection.executionReady,
      supported: inspection.supported,
      reasons: [...inspection.reasons],
      readinessReasons: [...inspection.readinessReasons],
      executionNodeId: this.executionNodeId,
      createdAt: this.clock(),
    }
    this.pruneRegistrations()
    this.registrations.set(record.inspectionId, record)
    return copyRegistration(record)
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
    if (!record.supported || record.repositoryIdentity === null || record.dirty === null) {
      throw workbenchError('invalid_input', 'a fresh inspection is required', 'failed inspection facts cannot authorize registration')
    }
    const current = inspectProjectPath(record.requestedPath, this.git)
    if (!current.supported) {
      throw workbenchError('invalid_input', `Project is no longer registrable: ${current.reasons.join(', ')}`, 'resolve the Git context and inspect the path again')
    }
    if (this.isInsideStateRoot(current.canonicalPath) || (current.gitCommonDir !== null && this.isInsideStateRoot(current.gitCommonDir))) {
      throw workbenchError('unsafe_path', 'Project overlaps the workbench state root', 'choose a state root outside every registered Project')
    }
    if (current.canonicalPath !== record.canonicalPath || current.gitCommonDir !== record.gitCommonDir
        || current.repositoryIdentity !== record.repositoryIdentity || current.headOid !== record.headOid || current.dirty !== record.dirty) {
      throw workbenchError('invalid_input', 'Project Git context changed since inspection', 'inspect the Project path again and confirm the fresh registrationId')
    }
    const existing = this.runner.store.listProjects().find(project => project.canonicalPath === current.canonicalPath)
    if (record.reconfirmProjectId !== null) {
      if (!existing || existing.projectId !== record.reconfirmProjectId || existing.executionNodeId !== this.executionNodeId
          || existing.revision !== record.priorProjectRevision || existing.contextDigest !== record.priorContextDigest) {
        throw workbenchError('invalid_input', 'registered Project context changed since inspection', 'obtain a fresh inspection before reconfirming')
      }
    } else if (existing) {
      throw workbenchError('invalid_input', `${current.canonicalPath} is already registered as ${existing.projectId}`, 'select the existing Project instead of registering it twice')
    }
    // Overlapping storage is refused in both directions: an ancestor of a
    // registered Project, or a descendant of one, would give two Projects claim
    // to the same files and the same Git history.
    const candidatePaths = [current.canonicalPath, current.gitCommonDir!]
    const overlapping = this.runner.store.listProjects().find(project => project.projectId !== existing?.projectId &&
      candidatePaths.some(candidate => [project.canonicalPath, project.gitCommonDir].some(existing => pathsOverlap(candidate, existing))))
    if (overlapping) {
      throw workbenchError('invalid_input', `${current.canonicalPath} overlaps registered Project ${overlapping.projectId} at ${overlapping.canonicalPath}`, 'register one Project per storage tree; overlapping paths cannot both own the same files')
    }
    const projectId = existing?.projectId ?? this.newId('proj-')
    const revision = existing ? existing.revision + 1 : 1
    if (!Number.isSafeInteger(revision)) throw workbenchError('invalid_input', 'Project revision exhausted', 'never reset or round a Project revision')
    const project: ProjectRecord = {
      projectId,
      executionNodeId: this.executionNodeId,
      canonicalPath: current.canonicalPath,
      gitCommonDir: current.gitCommonDir ?? '',
      headOid: current.headOid,
      dirty: current.dirty!, // supported inspection requires a successful status query
      contextDigest: contextDigestOf(current),
      revision,
      createdAt: existing?.createdAt ?? this.clock(),
    }
    this.commit(existing ? 'project_context_confirmed' : 'project_registered', { projectId, canonicalPath: project.canonicalPath }, () => {
      this.runner.store.putProject(project)
      const selection = this.runner.store.getMeta('selected_project_id')
      if (selection === null) this.runner.store.setMeta('selected_project_id', projectId)
    })
    this.registrations.delete(inspectionId)
    this.projectContexts.set(projectId, { available: true, dirty: current.dirty, reason: null })
    return project
  }

  /** Cached display facts only. Context-dependent operations must revalidate. */
  projectContext(projectId: string): ProjectContextStatus {
    return { ...(this.projectContexts.get(projectId) ?? { available: false, dirty: null, reason: 'repository_identity_unavailable' }) }
  }

  /** A presentation fact only: every current Run in the selected Goal must
   * report the exact canonical Project context on its fresh challenged bridge. */
  projectContextMatches(projectId: string): boolean {
    if (!this.registry || this.selectedProjectId !== projectId || !this.projectContext(projectId).available) return false
    const project = this.runner.store.getProject(projectId)
    const goal = this.selectedGoalId ? this.runner.store.getGoal(this.selectedGoalId) : null
    if (!project || !goal || goal.projectId !== projectId) return false
    const members = this.runner.store.listMemberships(goal.goalId)
    if (members.length === 0) return false
    return members.every(member => {
      const binding = this.runner.store.getBinding(member.runId)
      return !!binding && binding.projectId === projectId && binding.state === 'ready'
        && this.registry!.projectContextMatches(member.runId, project.canonicalPath)
    })
  }

  private refreshProjectContext(project: ProjectRecord): ProjectContextStatus {
    let status: ProjectContextStatus = { available: false, dirty: null, reason: 'repository_identity_unavailable' }
    if (project.executionNodeId === this.executionNodeId && /^repo-v1:[a-f0-9]{64}$/.test(project.contextDigest ?? '')) {
      try {
        const current = inspectProjectPath(project.canonicalPath, this.git)
        if (!current.supported) status.reason = current.reasons.join(', ')
        else if (this.isInsideStateRoot(current.canonicalPath) || this.isInsideStateRoot(current.gitCommonDir!)) status.reason = 'state_root_overlap'
        else if (current.gitCommonDir !== project.gitCommonDir || current.repositoryIdentity !== project.contextDigest) status.reason = 'repository_identity_changed'
        else status = { available: true, dirty: current.dirty, reason: null }
      } catch { status.reason = 'repository_inspection_unavailable' }
    }
    this.projectContexts.set(project.projectId, status)
    return { ...status }
  }

  requireProjectContext(projectId: string): ProjectContextStatus {
    const status = this.refreshProjectContext(this.requireProject(projectId))
    if (!status.available) {
      throw workbenchError('invalid_input', `Project context is unavailable: ${status.reason}`, 'restore the registered repository or obtain fresh context confirmation; history and uncertainty are retained')
    }
    return status
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
    const index = this.runner.store.listGoals(project.projectId).findIndex(item => item.goalId === goal.goalId)
    this.pages.set('goals', Math.floor(index / WORKBENCH_PAGE_SIZE) * WORKBENCH_PAGE_SIZE)
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
    this.requireProjectContext(project.projectId)
    const checkId = this.newId('check-')
    const body = resolveCheckDefinition(project, { checkId, version: 1 }, input)
    const digest = sha256(canonicalJson(body))
    const check: CheckRecord = {
      projectId: project.projectId,
      checkId,
      version: 1,
      digest,
      canonicalJson: canonicalJson(body),
      name: body.name,
      mode: body.mode,
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
    this.requireProjectContext(project.projectId)
    if (!Number.isSafeInteger(latest.version + 1)) throw workbenchError('invalid_input', 'check version exhausted', 'retain the existing check history')
    const version = latest.version + 1
    const body = resolveCheckDefinition(project, { checkId: latest.checkId, version }, input)
    const digest = sha256(canonicalJson(body))
    const check: CheckRecord = {
      projectId: project.projectId,
      checkId: latest.checkId,
      version,
      digest,
      canonicalJson: canonicalJson(body),
      name: body.name,
      mode: body.mode,
      createdAt: this.clock(),
    }
    this.commit('check_configured', { checkId: check.checkId, projectId: project.projectId, version }, () => {
      this.runner.store.putCheck(check)
    })
    return check
  }

  selectProject(projectId: unknown): void {
    const project = this.requireProject(projectId)
    this.refreshProjectContext(project) // History remains navigable when unavailable.
    if (this.runner.store.getMeta('selected_project_id') === project.projectId) return
    this.commit('project_selected', { projectId: project.projectId }, () => {
      this.runner.store.setMeta('selected_project_id', project.projectId)
      this.runner.store.setMeta('selected_goal_id', '')
    })
    for (const collection of ['goals', 'managedAgents', 'observedSessions', 'retiredRuns', 'checks'] as const) this.pages.delete(collection)
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
    this.refreshProjectContext(this.requireProject(goal.projectId))
    if (this.runner.store.getMeta('selected_goal_id') === goalIdText) return
    this.commit('goal_selected', { goalId: goalIdText }, () => {
      this.runner.store.setMeta('selected_goal_id', goalIdText)
    })
    for (const collection of ['managedAgents', 'observedSessions', 'retiredRuns'] as const) this.pages.delete(collection)
    const index = this.runner.store.listGoals(goal.projectId).findIndex(item => item.goalId === goalIdText)
    this.pages.set('goals', Math.floor(index / WORKBENCH_PAGE_SIZE) * WORKBENCH_PAGE_SIZE)
  }

  // -------------------------------------------------------------------------
  // Intent routing and durable deduplication
  // -------------------------------------------------------------------------

  /** Presentation route for the one bounded asynchronous acceptance action. */
  handlePresentationIntent(input: unknown): IntentOutcome | Promise<IntentOutcome> {
    let intent: WorkbenchIntent
    try { intent = validateAuthorityIntent(input) } catch { return this.handleIntent(input) }
    if (intent.kind === 'start_assignment') {
      this.presentationStartIntentId = intent.intentId
      try { return this.handleIntent(intent) }
      finally { this.presentationStartIntentId = null }
    }
    if (intent.kind !== 'accept') return this.handleIntent(intent)
    return this.handleAssignmentAccept(intent)
  }

  private async handleAssignmentAccept(intent: WorkbenchIntent): Promise<IntentOutcome> {
    if (this.commandContext !== null) throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome')
    const payloadHash = sha256(intent)
    const recorded = this.runner.store.getIntentResult(intent.intentId)
    if (recorded !== null) {
      if (recorded.sessionId !== intent.sessionId || recorded.payloadHash !== payloadHash) {
        return { status: 'rejected', reasonCode: 'intent_identity_conflict', reason: 'This intent id was already recorded with a different envelope.', committedRevision: null }
      }
      return { status: recorded.status as IntentStatus, reasonCode: recorded.reasonCode, reason: recorded.reason ?? null,
        committedRevision: recorded.committedRevision, ...(recorded.detail == null ? {} : { detail: recorded.detail }) }
    }
    if (intent.pluginGeneration !== this.pluginGeneration || intent.sessionId !== this.sessionId || intent.runnerEpoch !== this.runner.epoch) {
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'authority_identity_changed',
        reason: 'The Owner, presentation session or Runner changed; refresh the current projection before accepting.', committedRevision: null })
    }
    if (this.registry) { this.registry.list(); this.adoption.retainedProposals() }
    if (intent.expectedRevision !== this.revision) {
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'revision_changed',
        reason: 'The Assignment changed; refresh the current projection before accepting.', committedRevision: null })
    }
    const assignmentId = String(intent.payload.assignmentId)
    const assignment = this.runner.store.getAssignment(assignmentId)
    const attempt = assignment ? this.runner.store.listAttempts(assignmentId).sort((a, b) => b.ordinal - a.ordinal)[0] : null
    const candidate = attempt ? this.runner.store.getCandidateByAttempt(attempt.attemptId) : null
    const delivery = attempt ? this.runner.store.getAssignmentDelivery(attempt.attemptId) : null
    if (!assignment || !attempt || !candidate || !delivery || delivery.state !== 'written') {
      return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'candidate_unavailable',
        reason: 'The exact delivered Attempt has no current structured Candidate.', committedRevision: null })
    }
    if (!this.gateScratchRoot) {
      return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'gate_unavailable',
        reason: 'The Runner-owned bounded acceptance-check scratch directory is unavailable.', committedRevision: null })
    }
    try {
      const result = await this.executeAssignmentGate({ assignmentId, attemptId: attempt.attemptId, candidateId: candidate.candidateId }, { scratchRoot: this.gateScratchRoot })
      const outcome: IntentOutcome = result.accepted
        ? { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: result.committedRevision, detail: result.resultId }
        : { status: 'rejected', reasonCode: result.reasonCode ?? result.outcome, reason: `Acceptance check did not accept the Candidate (${result.reasonCode ?? result.outcome}).`, committedRevision: result.committedRevision, detail: result.resultId }
      return this.record(intent, payloadHash, outcome)
    } catch (error) {
      if (error instanceof Error && error.name === 'WorkbenchError') {
        const code = (error as { code?: string }).code ?? 'invalid_input'
        return this.record(intent, payloadHash, { status: code === 'identity_drift' || code === 'fence_conflict' ? 'stale' : 'rejected',
          reasonCode: code, reason: error.message, committedRevision: null })
      }
      throw error
    }
  }

  handleIntent(input: unknown): IntentOutcome {
    if (this.commandContext !== null) throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome')
    let intent: WorkbenchIntent
    try { intent = validateAuthorityIntent(input) }
    catch { return { status: 'rejected', reasonCode: 'invalid_envelope', reason: 'Invalid bounded intent envelope or target association.', committedRevision: null } }
    // Schema 6 binds receipts to the complete original envelope, not just the
    // action body. Historical exact replay reads a result; it grants no action.
    const payloadHash = sha256(intent)
    const recorded = this.runner.store.getIntentResult(intent.intentId)
    if (recorded !== null) {
      if (recorded.sessionId !== intent.sessionId || recorded.payloadHash !== payloadHash) {
        return { status: 'rejected', reasonCode: 'intent_identity_conflict', reason: 'This intent id was already recorded with a different envelope.', committedRevision: null }
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
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'plugin_generation_changed', reason: 'The Companion generation changed; reload its projection before acting.', committedRevision: null })
    }
    if (intent.sessionId !== this.sessionId) {
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'session_changed', reason: 'The presentation session changed; reload its projection before acting.', committedRevision: null })
    }
    if (intent.runnerEpoch !== this.runner.epoch) {
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'runner_epoch_changed', reason: 'The workbench runner restarted; reload the projection before acting.', committedRevision: null })
    }
    if (this.registry) { this.registry.list(); this.adoption.retainedProposals() }
    if (intent.expectedRevision !== this.revision) {
      return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'revision_changed', reason: 'The projection changed; re-read the current state before acting.', committedRevision: null })
    }
    if (intent.kind === 'prepare_start_review') {
      try {
        const projectId = this.selectedProjectId
        const goalId = this.selectedGoalId
        if (!projectId || !goalId || !intent.target) throw workbenchError('invalid_input', 'no selected Project, Goal or exact Run', 'select the Project and Goal and choose a ready Builder Run')
        const project = this.runner.store.getProject(projectId)
        if (!project || !this.gateExecutionAvailableFor(project.canonicalPath)) throw workbenchError('invalid_input', 'Runner-owned gate scratch is unavailable or overlaps the selected Project', 'choose a separate private gate scratch directory')
        const proposal = this.prepareStartAssignment({
          projectId, goalId, agentRunId: intent.target,
          checkId: String(intent.payload.checkId), checkVersion: Number(intent.payload.checkVersion),
          taskText: String(intent.payload.taskText),
          limits: { maxCorrections: Number(intent.payload.maxCorrections), elapsedMs: Number(intent.payload.elapsedMs) },
          expectedRevision: intent.expectedRevision,
        })
        const outcome = this.record(intent, payloadHash, { status: 'acknowledged', reasonCode: null, reason: null,
          committedRevision: null, detail: proposal.confirmationId })
        this.pendingStartProposal = proposal
        return outcome
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkbenchError') {
          const code = (error as { code?: string }).code ?? 'invalid_input'
          return this.record(intent, payloadHash, { status: 'rejected', reasonCode: code, reason: error.message, committedRevision: null })
        }
        throw error
      }
    }
    if (intent.kind === 'start_assignment') {
      if (this.presentationStartIntentId !== intent.intentId) {
        return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'presentation_route_required',
          reason: 'Start confirmation is accepted only through the current presentation route.', committedRevision: null })
      }
      if (this.pendingStartProposal === null) {
        return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'handler_unavailable', reason: START_UNAVAILABLE_REASON, committedRevision: null })
      }
      const proposal = this.startReviewForProjection()
      if (!proposal || proposal.confirmationId !== intent.payload.confirmationId) {
        return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'start_review_unavailable', reason: START_UNAVAILABLE_REASON, committedRevision: null })
      }
      try {
        const admission = this.confirmStartAssignment({ intent, proposal })
        try { this.onAssignmentAdmitted?.(admission) } catch { /* The durable queued outbox remains unsent and recoverable. */ }
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: admission.committedRevision, detail: admission.assignmentId }
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkbenchError') {
          const code = (error as { code?: string }).code ?? 'invalid_input'
          return this.record(intent, payloadHash, { status: code === 'identity_drift' || code === 'fence_conflict' ? 'stale' : 'rejected',
            reasonCode: code, reason: error.message, committedRevision: null })
        }
        throw error
      }
    }
    if (intent.kind === 'present') {
      const effect = this.registry?.prepareNavigation(intent.target!, intent.intentId)
      if (!effect) return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'navigation_unavailable',
        reason: 'This terminal navigation target is unavailable or already checking.', committedRevision: null })
      // The immutable receipt accepts the REQUEST, not a successful focus. The
      // connection-bound result is separately projected; never resend on replay.
      const outcome = this.record(intent, payloadHash, { status: 'acknowledged', reasonCode: 'navigation_requested',
        reason: 'Navigation requested. Check the row for the verified outcome.', committedRevision: null })
      effect()
      return outcome
    }
    if (intent.kind === 'retire' || intent.kind === 'purge') {
      if (intent.kind === 'retire' && this.registry) {
        const identity = this.runner.store.getBindingIdentity(String(intent.payload.agentRunId))
        const connected = identity && this.registry.list().some(agent => agent.available
          && incarnationKey(agent.incarnation) === identity.incarnationKey)
        if (this.revision !== intent.expectedRevision) return this.record(intent, payloadHash, { status: 'stale', reasonCode: 'revision_changed',
          reason: 'The Run connection changed; review its current state before retirement.', committedRevision: null })
        if (connected) {
          return this.record(intent, payloadHash, { status: 'rejected', reasonCode: 'run_active',
            reason: 'The exact Pi bridge is still connected; disconnect before retiring this Run.', committedRevision: null })
        }
      }
      let receipt
      try {
        receipt = this.runner.executeManagementCommand({ intentId: intent.intentId, sessionId: this.sessionId,
          payloadHash, kind: intent.kind, runId: String(intent.payload.agentRunId) })
      } catch (error) {
        if (error instanceof Error && error.name === 'WorkbenchError') {
          // A prepared-operation fault fences store admission, so this cannot
          // turn an irreversible/pending operation into a rejected receipt.
          return this.record(intent, payloadHash, { status: 'rejected', reasonCode: (error as { code?: string }).code ?? 'invalid_input', reason: error.message, committedRevision: null })
        }
        throw error
      }
      this.revision = receipt.projectionRevision
      this.cursor = receipt.cursor
      // Post-commit cleanup failures propagate as unavailable; they never get
      // caught by the domain-rejection handler or overwrite the saved outcome.
      this.adoption.forgetRetired(String(intent.payload.agentRunId))
      return { status: receipt.status as IntentStatus, reasonCode: receipt.reasonCode, reason: receipt.reason ?? null, committedRevision: receipt.committedRevision }
    }
    let committed = false
    try {
      if (['inspect_project', 'confirm_register_project', 'select_project', 'select_goal', 'create_goal', 'create_check', 'configure_checks', 'request_adoption', 'authorize_adoption', 'take_control', 'stop', 'return_to_team', 'resume', 'retry', 'reconcile_writer', 'navigate_page'].includes(intent.kind)) {
        const context = { revision: this.revision, cursor: this.cursor, afterCommit: [] as Array<() => void> }
        const registrations = new Map(this.registrations)
        const previousProjectContexts = new Map(this.projectContexts)
        const observations = new Map(this.observations)
        const pages = new Map(this.pages)
        const restoreAdoption = this.adoption.checkpointCommandState()
        this.commandContext = context
        let outcome: IntentOutcome
        try {
          outcome = this.runner.store.transaction(() => {
            const routed = this.route(intent)
            const normalized = routed.committedRevision === null ? routed : { ...routed, committedRevision: context.revision }
            return this.record(intent, payloadHash, normalized)
          })
          this.revision = context.revision
          this.cursor = context.cursor
          committed = true
        } catch (error) {
          this.registrations = registrations
          // Remove tentative registrations, but keep newly observed unavailability
          // for existing Projects; failed commands must not display stale readiness.
          for (const [id, status] of this.projectContexts) {
            const previous = previousProjectContexts.get(id)
            if (!previous) this.projectContexts.delete(id)
            else if (status.available) this.projectContexts.set(id, previous)
          }
          this.observations = observations
          this.pages = pages
          restoreAdoption()
          throw error
        } finally { this.commandContext = null }
        for (const effect of context.afterCommit) effect()
        return outcome
      }
      const outcome = this.route(intent)
      return this.record(intent, payloadHash, outcome)
    } catch (error) {
      if (committed) throw error // Delivery/publication failure cannot reject an already committed command.
      if (error instanceof Error && (error as { name?: string }).name === 'WorkbenchError') {
        const code = (error as { code?: string }).code ?? 'invalid_input'
        return this.record(intent, payloadHash, { status: 'rejected', reasonCode: code, reason: error.message, committedRevision: null })
      }
      throw error
    }
  }

  private route(intent: WorkbenchIntent): IntentOutcome {
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
        const observation = this.observedChoices.find(choice => choice.choiceId === choiceId)
        if (observation === undefined) {
          throw workbenchError('missing_resource', `no observed Pi for choice ${choiceId}`, 'connect the observer transport and let the Pi extension report its sessions')
        }
        const projectId = this.selectedProjectId
        if (projectId === null) {
          throw workbenchError('invalid_input', 'no Project is selected', 'select the Project this Adoption belongs to')
        }
        const predecessor = this.runner.store.listBindings()
          .filter(binding => binding.projectId === projectId && binding.role === observation.role
            && (!this.registry || this.runner.store.getBindingIdentity(binding.runId)?.goalId === this.selectedGoalId)
            && (binding.state === 'retired' || binding.state === 'purged'))
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
      case 'navigate_page': {
        const collection = intent.payload.collection as PageCollection
        const offset = Number(intent.payload.offset)
        if (!PAGE_COLLECTIONS.includes(collection) || !Number.isSafeInteger(offset) || offset < 0 || offset % WORKBENCH_PAGE_SIZE !== 0) {
          throw workbenchError('invalid_input', 'invalid collection page', 'use a current enabled page action')
        }
        const current = buildSnapshot({ authority: this, adoption: this.adoption, connection: 'connected' }).pages?.[collection]
        if (!current || (offset !== current.offset - WORKBENCH_PAGE_SIZE && offset !== current.offset + WORKBENCH_PAGE_SIZE)
            || (offset < current.offset ? !current.hasPrevious : !current.hasNext)) {
          throw workbenchError('invalid_input', 'requested page is not adjacent or no longer available', 'refresh the current projection')
        }
        this.pages.set(collection, offset)
        this.commit('page_selected', { collection, offset }, () => {})
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'take_control': {
        this.adoption.takeControl(String(intent.payload.agentRunId))
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'stop': {
        const assignment = this.runner.store.getAssignment(String(intent.payload.assignmentId))
        if (!assignment) throw workbenchError('missing_resource', 'the exact Assignment does not exist', 'refresh the current Assignment before stopping')
        this.stopAssignmentInternal(assignment, 'operator', null)
        return { status: 'acknowledged', reasonCode: null, reason: null, committedRevision: this.revision }
      }
      case 'return_to_team':
      case 'resume':
      case 'retry':
      case 'reconcile_writer': {
        if (!this.intervention) throw workbenchError('invalid_input', 'Same-Pi intervention is unavailable.', 'connect the current managed bridge')
        this.intervention.request(intent.kind, String(intent.payload.assignmentId), intent.intentId,
          intent.payload.reconciliationNotes, intent.payload.acknowledgeRisk)
        return { status: 'acknowledged', reasonCode: 'intervention_requested',
          reason: 'Request committed. Read the Assignment for the downstream outcome; no automatic retry.', committedRevision: this.revision }
      }
      case 'recover':
        return { status: 'rejected', reasonCode: 'handler_unavailable',
          reason: 'Manual recovery is unavailable. A surviving Pi extension must prove its exact identity on a fresh bridge connection; reconnect alone grants no authority.', committedRevision: null }
      default:
        return {
          status: 'rejected',
          reasonCode: 'handler_unavailable',
          reason: intent.kind === 'start_assignment' ? START_UNAVAILABLE_REASON : `No management handler owns the intent ${intent.kind}.`,
          committedRevision: null,
        }
    }
  }

  private record(intent: WorkbenchIntent, payloadHash: string, outcome: IntentOutcome): IntentOutcome {
    this.runner.store.transaction(() => this.runner.store.putIntentResult({
      intentId: intent.intentId,
      sessionId: intent.sessionId,
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
  commit(kind: string, payload: Record<string, unknown>, mutate: () => void, afterCommit?: () => void): number {
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
    this.pendingStartProposal = null
    if (context) {
      context.revision = committedRevision
      context.cursor = cursor
      if (afterCommit) context.afterCommit.push(afterCommit)
    } else {
      this.revision = committedRevision
      this.cursor = cursor
      afterCommit?.()
    }
    return committedRevision
  }

  // -------------------------------------------------------------------------
  // AL-02 admission (explicit; never routed from a live intent)
  // -------------------------------------------------------------------------

  /** Resolve and freeze an exact transient Start Review. Performs no write or send. */
  prepareStartAssignment(request: StartProposalRequest, options: StartProposalOptions = {}): StartProposal {
    const project = this.runner.store.getProject(request.projectId)
    if (this.gateScratchRoot && project && pathsOverlap(project.canonicalPath, this.gateScratchRoot)) {
      throw workbenchError('invalid_input', 'Runner-owned gate scratch overlaps the selected Project', 'choose a separate private gate scratch directory')
    }
    return prepareStartProposal(this.startProposalPort(), request, this.startProposalOptions(options))
  }

  /**
   * Revalidate the exact review against current authority, then commit the
   * Assignment, Attempt, held writer epoch, event, complete receipt and queued
   * delivery in one transaction. Failure leaves no writer and no sendable item.
   */
  confirmStartAssignment(input: StartAdmissionInput): StartAdmission {
    if (this.commandContext !== null) throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome')
    let intent: WorkbenchIntent
    try { intent = validateAuthorityIntent(input.intent) }
    catch {
      throw workbenchError('invalid_input', 'invalid Start intent envelope',
        'reload the projection and confirm a fresh Start Review with an exact start_assignment envelope')
    }
    if (intent.kind !== 'start_assignment') {
      throw workbenchError('invalid_input', `intent ${intent.kind} does not admit an Assignment`, 'admit only an exact start_assignment envelope')
    }
    const payloadHash = sha256(intent)
    const recorded = this.runner.store.getIntentResult(intent.intentId)
    if (recorded !== null) {
      if (recorded.sessionId !== intent.sessionId || recorded.payloadHash !== payloadHash) {
        throw workbenchError('identity_drift', 'this intent id was already recorded with a different envelope',
          'discard this review and prepare a fresh Start Review; never reuse an intent id')
      }
      const replay = decodeAdmissionDetail(recorded.detail)
      if (recorded.status !== 'acknowledged' || replay === null) {
        throw workbenchError('invalid_input', 'this intent has no acknowledged admission to replay',
          'prepare a fresh Start Review and confirm it once')
      }
      return { status: 'acknowledged', ...replay, committedRevision: recorded.committedRevision ?? 0, replayed: true }
    }
    if (intent.pluginGeneration !== this.pluginGeneration) staleStart('the Companion generation changed')
    if (intent.sessionId !== this.sessionId) staleStart('the presentation session changed')
    if (intent.runnerEpoch !== this.runner.epoch) staleStart('the workbench runner restarted')
    if (intent.expectedRevision !== this.revision) staleStart('the projection revision changed')
    const proposal = input.proposal
    if (intent.expectedRevision !== proposal.revision) staleStart('the review was prepared for a different revision')
    if (intent.target !== proposal.attempt.runBinding.runId || intent.payload.agentRunId !== proposal.attempt.runBinding.runId) staleStart('the intent target is not the reviewed Run')
    if (intent.payload.confirmationId !== proposal.confirmationId) staleStart('the intent names a different Start Review')
    if (intent.payload.checkId !== proposal.attempt.gate.checkId || Number(intent.payload.checkVersion) !== proposal.attempt.gate.version) {
      staleStart('the intent names a different check')
    }
    if (intent.payload.goalText !== proposal.assignment.goalText || intent.payload.taskText !== proposal.assignment.taskText
        || Number(intent.payload.maxCorrections) !== proposal.assignment.limits.maxCorrections
        || Number(intent.payload.elapsedMs) !== proposal.assignment.limits.elapsedMs) staleStart('the intent changed reviewed Goal, task or Assignment limits')
    revalidateStartProposal(this.startProposalPort(), proposal, this.startProposalOptions(input.options ?? {}))
    const now = this.clock()
    const deadline = now + ASSIGNMENT_DELIVERY_TTL_MS
    if (!Number.isSafeInteger(deadline) || deadline < now) {
      throw workbenchError('invalid_input', 'delivery deadline overflow', 'never round admission timestamps')
    }
    const frameJson = canonicalJson(admissionFrame(proposal, deadline))
    const delivery: AssignmentDelivery = {
      deliveryId: proposal.attempt.deliveryId!,
      assignmentId: proposal.assignment.assignmentId,
      attemptId: proposal.attempt.attemptId,
      runId: proposal.attempt.runBinding.runId,
      frameJson,
      payloadDigest: sha256(frameJson),
      state: 'queued',
      reasonCode: null,
      deadline,
      createdAt: now,
    }
    const reference: AdmissionReference = {
      assignmentId: proposal.assignment.assignmentId,
      attemptId: proposal.attempt.attemptId,
      deliveryId: delivery.deliveryId,
      writerEpoch: proposal.attempt.writerEpoch,
    }
    const context = { revision: this.revision, cursor: this.cursor, afterCommit: [] as Array<() => void> }
    this.commandContext = context
    try {
      this.runner.store.transaction(() => {
        this.commit('assignment_admitted', {
          projectId: proposal.assignment.projectId,
          goalId: proposal.assignment.goalId,
          runId: proposal.attempt.runBinding.runId,
          assignmentId: proposal.assignment.assignmentId,
          attemptId: proposal.attempt.attemptId,
        }, () => {
          this.runner.store.putAssignment(proposal.assignment)
          armAssignmentBudget(this.runner.store, proposal.assignment, this.monotonic())
          this.admissionPhase?.('assignment_written')
          this.runner.store.putAttempt(proposal.attempt)
          this.admissionPhase?.('attempt_written')
          this.runner.store.acquireWriter({
            projectId: proposal.assignment.projectId,
            assignmentId: proposal.assignment.assignmentId,
            attemptId: proposal.attempt.attemptId,
            epoch: proposal.attempt.writerEpoch,
            updatedAt: now,
          })
          this.admissionPhase?.('writer_held')
          this.runner.store.putAssignmentDelivery(delivery)
          this.admissionPhase?.('delivery_queued')
        })
        this.record(intent, payloadHash, {
          status: 'acknowledged',
          reasonCode: null,
          reason: null,
          committedRevision: context.revision,
          detail: encodeAdmissionDetail(reference),
        })
        this.admissionPhase?.('receipt_recorded')
      })
      const committedRevision = context.revision
      this.revision = committedRevision
      this.cursor = context.cursor
      for (const effect of context.afterCommit) effect()
      return { status: 'acknowledged', ...reference, committedRevision, replayed: false }
    } finally {
      this.commandContext = null
    }
  }

  // -------------------------------------------------------------------------
  // AL-05 gate orchestration. This is an explicit direct-call surface, never
  // routed from a live intent, and it executes at most one frozen gate per
  // Attempt. Bounded executor work happens outside any store transaction.
  // -------------------------------------------------------------------------

  async executeAssignmentGate(input: AssignmentGateInput, options: AssignmentGateOptions): Promise<AssignmentGateResult> {
    if (this.commandContext !== null) {
      throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome before running a gate')
    }
    if (typeof options?.scratchRoot !== 'string' || options.scratchRoot.length === 0) {
      throw workbenchError('invalid_input', 'a Runner-owned gate scratch root is required', 'configure the bounded gate scratch root before accepting a Candidate')
    }
    if (this.gateScratchRoot !== undefined && options.scratchRoot === this.gateScratchRoot) {
      ensureOwnedDirectory(this.gateScratchRoot)
    }
    const assignment = this.runner.store.getAssignment(input.assignmentId)
    const attempt = this.runner.store.getAttempt(input.attemptId)
    const candidate = this.runner.store.getCandidateByAttempt(input.attemptId)
    const project = assignment === null ? null : this.runner.store.getProject(assignment.projectId)
    if (assignment === null || attempt === null || candidate === null || project === null || candidate.candidateId !== input.candidateId) {
      throw workbenchError('missing_resource', 'the exact Assignment, Attempt, Candidate and Project are required to run a gate', 'associate the Candidate through the dedicated submission port before executing its gate')
    }
    if (assignment.state !== 'candidate' || attempt.state !== 'candidate' || candidate.state !== 'pending') {
      throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is ${assignment.state} with a ${candidate.state} Candidate`, 'execute the gate exactly once for the current pending Candidate and Attempt')
    }
    const writer = this.runner.store.getWriter(assignment.projectId)
    if (writer === null || writer.state !== 'held' || writer.assignmentId !== assignment.assignmentId
      || writer.attemptId !== attempt.attemptId || writer.epoch !== attempt.writerEpoch) {
      throw workbenchError('fence_conflict', 'the exact held writer lease is required to execute a gate', 'reconcile the Project writer before accepting the Candidate')
    }
    const binding = this.runner.store.getBinding(assignment.agentRunId)
    if (binding === null || binding.controlEpoch !== attempt.controlEpoch) {
      throw workbenchError('fence_conflict', 'the Run control epoch changed; this gate is stale', 'return control to team and reconcile before validating again')
    }
    if (this.runner.store.getStop(assignment.assignmentId) !== null) {
      throw workbenchError('fence_conflict', 'a durable stop is recorded for this Assignment', 'never execute a gate after stop intent is durably revoked')
    }
    const check = this.runner.store.getCheck(project.projectId, attempt.gate.checkId, attempt.gate.version)
    if (check === null || check.digest !== attempt.gate.digest) {
      throw workbenchError('identity_drift', 'the frozen gate definition is missing or changed', 're-confirm the check and admit a new Attempt; never rerun a relabelled gate')
    }
    let definition: ResolvedCheckDefinition
    try {
      definition = readResolvedCheck(check)
    } catch {
      throw workbenchError('identity_drift', 'the frozen gate definition cannot be read back', 're-confirm the check and admit a new Attempt; never rerun a relabelled gate')
    }

    this.sweepAssignmentLimits()
    const remaining = assignmentRemainingMs(this.runner.store, assignment, this.monotonic())
    if (remaining === null || remaining <= 0 || this.runner.store.getStop(assignment.assignmentId)) {
      throw workbenchError('fence_conflict', 'Assignment elapsed limit reached or interval unprovable', 'reconcile stopped work; never reset its elapsed budget')
    }
    const now = this.clock()
    this.commit('assignment_validating', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, attemptId: attempt.attemptId,
    }, () => {
      this.runner.store.setMeta(`gate_lifetime_${attempt.attemptId}`, 'started')
      if (!this.runner.store.transitionAssignment(assignment.assignmentId, 'candidate', 'validating', this.revision + 1, now)
        || !this.runner.store.transitionAttempt(attempt.attemptId, 'candidate', 'validating', now)) {
        throw workbenchError('fence_conflict', 'the Assignment or Attempt moved before the gate could start', 're-read the Assignment and start a fresh attempt')
      }
    })
    this.assignmentGatePhase?.('validating_committed')

    const captureOptions = this.git === undefined ? {} : { git: this.git }
    const capture = () => {
      try { return captureStableProjectBaseline(project, captureOptions) } catch { return null }
    }
    const preBaseline = capture()
    const preManifestDigest = preBaseline?.manifestDigest ?? null
    const beforeQuiescence = await this.queryGateQuiescence(assignment, attempt, candidate, options, 'pass', true)
    this.sweepAssignmentLimits()
    let outcome: GateOutcome
    let reasonCode: string | null
    let execution: GateExecution | null = null
    let postManifestDigest: string | null = null
    let postBaselineDigest: string | null = null
    if (!this.gateQuiescenceCurrent(beforeQuiescence, attempt, options) || this.runner.store.getStop(assignment.assignmentId)) {
      outcome = 'unknown'
      reasonCode = this.runner.store.getStop(assignment.assignmentId) ? 'stop_recorded' : `quiescence_${beforeQuiescence?.status ?? 'unknown'}`
    } else if (preManifestDigest === null) {
      outcome = 'unknown'
      reasonCode = 'baseline_unavailable'
    } else {
      const beforeProblem = verifyCandidateArtifacts(project.canonicalPath, candidate.artifactRefs)
      if (beforeProblem !== null) {
        outcome = 'candidate_changed'
        reasonCode = beforeProblem
      } else {
        const controller = new AbortController()
        const unregister = registerAssignmentGate(this.runner.store, assignment.assignmentId, controller)
        const budget = assignmentRemainingMs(this.runner.store, assignment, this.monotonic())
        const timeout = setTimeout(() => {
          this.stopAssignment({ assignmentId: assignment.assignmentId, trigger: 'elapsed_limit', reasonCode: 'elapsed_limit_exhausted' })
        }, Math.max(0, budget ?? 0))
        try {
          if (budget === null || budget <= 0) controller.abort()
          execution = await executeGate(definition, { scratchRoot: options.scratchRoot, graceMs: options.graceMs, signal: controller.signal,
            beforeSpawn: () => {
              this.sweepAssignmentLimits()
              return !this.runner.store.getStop(assignment.assignmentId) && this.gateQuiescenceCurrent(beforeQuiescence, attempt, options)
            } })
        } finally { clearTimeout(timeout); unregister() }
        outcome = execution.outcome
        reasonCode = execution.reasonCode
        const postBaseline = capture()
        postManifestDigest = postBaseline?.manifestDigest ?? null
        postBaselineDigest = postBaseline?.baselineDigest ?? null
        if (outcome === 'pass') {
          const afterProblem = verifyCandidateArtifacts(project.canonicalPath, candidate.artifactRefs)
          if (afterProblem !== null) { outcome = 'candidate_changed'; reasonCode = afterProblem }
          else if (postManifestDigest === null) { outcome = 'unknown'; reasonCode = 'post_baseline_unavailable' }
          else if (postManifestDigest !== preManifestDigest || postBaselineDigest !== preBaseline!.baselineDigest) { outcome = 'candidate_changed'; reasonCode = 'checkout_changed_post' }
        }
      }
    }
    this.assignmentGatePhase?.('gate_returned')

    const evidenceJson = canonicalJson({ ...JSON.parse(gateEvidence(outcome, reasonCode, execution, preManifestDigest, postManifestDigest)),
      preBaselineDigest: preBaseline?.baselineDigest ?? null, postBaselineDigest })
    const resultId = this.newId('gate-result-')
    const record: GateResultRecord = {
      resultId,
      assignmentId: assignment.assignmentId,
      attemptId: attempt.attemptId,
      candidateId: candidate.candidateId,
      gateDigest: attempt.gate.digest,
      executableDigest: definition.executableDigest,
      outcome,
      preManifestDigest: preManifestDigest ?? attempt.context.manifestDigest,
      postManifestDigest,
      exitCode: execution?.exitCode ?? null,
      reasonCode,
      evidenceJson,
      state: 'provisional',
      revision: this.revision + 1,
      createdAt: this.clock(),
    }
    this.commit('gate_result_recorded', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, attemptId: attempt.attemptId, resultId, outcome,
    }, () => {
      this.runner.store.putGateResult(record)
      this.runner.store.setMeta(`gate_lifetime_${attempt.attemptId}`, execution === null ? 'not_spawned' : execution.scratchCleaned ? 'finished' : 'unknown')
    })
    this.assignmentGatePhase?.('result_recorded')

    const clean = outcome === 'pass' && execution !== null && execution.scratchCleaned
    const quiescence = clean ? await this.queryGateQuiescence(assignment, attempt, candidate, options, outcome, clean) : null
    this.assignmentGatePhase?.('before_acceptance')
    const acceptanceBaseline = capture()
    const acceptanceManifestDigest = acceptanceBaseline?.manifestDigest ?? null
    let acceptanceProblem: string | null = acceptanceBaseline === null ? 'acceptance_scan_unavailable'
      : acceptanceBaseline.baselineDigest !== postBaselineDigest ? 'context_changed_at_acceptance' : null
    try {
      const currentProject = this.runner.store.getProject(project.projectId)
      if (!currentProject || currentProject.revision !== project.revision || currentProject.contextDigest !== project.contextDigest) {
        acceptanceProblem = 'context_changed_at_acceptance'
      } else {
        const latest = this.runner.store.latestCheck(project.projectId, attempt.gate.checkId)
        if (!latest || latest.version !== attempt.gate.version || latest.digest !== attempt.gate.digest) acceptanceProblem = 'gate_changed'
        verifyCheckResources(check, currentProject)
      }
    } catch { acceptanceProblem = 'gate_changed' }
    this.sweepAssignmentLimits()

    const box: { resolution: GateAcceptance | null } = { resolution: null }
    this.commit('assignment_gate_resolved', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, attemptId: attempt.attemptId, resultId, outcome,
    }, () => {
      const quiescenceConfirmed = this.gateQuiescenceCurrent(quiescence, attempt, options)
      const remaining = assignmentRemainingMs(this.runner.store, assignment, this.monotonic())
      if (remaining === null || remaining <= 0) acceptanceProblem = 'elapsed_limit_exhausted'
      box.resolution = this.runner.store.resolveGateAcceptance({
        resultId,
        assignmentId: assignment.assignmentId,
        attemptId: attempt.attemptId,
        candidateId: candidate.candidateId,
        candidateDigest: candidate.digest,
        gateDigest: attempt.gate.digest,
        executableDigest: definition.executableDigest,
        outcome,
        postManifestDigest,
        acceptanceManifestDigest,
        acceptanceScanError: outcome === 'pass' ? acceptanceProblem : null,
        quiescenceConfirmed,
        quiescenceReason: quiescenceConfirmed ? null : `quiescence_${quiescence?.status === 'active' ? 'active' : 'unknown'}`,
        revision: this.revision + 1,
        updatedAt: this.clock(),
      })
    })
    this.assignmentGatePhase?.('resolved')
    this.sweepAssignmentLimits()
    const resolution = box.resolution
    if (resolution === null) {
      throw workbenchError('integrity_failure', 'the gate acceptance transaction produced no resolution', 're-read the Assignment and reconcile the provisional gate result')
    }
    return { accepted: resolution.accepted, outcome, reasonCode: resolution.reasonCode, resultId, committedRevision: this.revision }
  }

  /**
   * Bounded quiescence for the one challenged Pi of this Run. A validator exit
   * is never sufficient; a `confirmed` status needs the exact committed, idle,
   * healthy bridge for this incarnation reporting no known work.
   */
  private async queryGateQuiescence(assignment: AssignmentRecord, attempt: AttemptRecord, candidate: CandidateRecord, options: AssignmentGateOptions, outcome: GateOutcome, clean: boolean): Promise<GateQuiescence | null> {
    return options.quiescence ? options.quiescence({ assignment, attempt, candidate, outcome, clean })
      : this.registry?.queryAttemptQuiescence(attempt.attemptId) ?? null
  }

  private gateQuiescenceCurrent(proof: GateQuiescence | null, attempt: AttemptRecord, options: AssignmentGateOptions): boolean {
    if (!proof || proof.source !== 'surviving_bridge_and_operator_reconciliation' || proof.status !== 'confirmed'
        || proof.runId !== attempt.runBinding.runId || proof.attemptId !== attempt.attemptId || proof.controlEpoch !== attempt.controlEpoch
        || proof.connectionId !== attempt.runBinding.connectionId || proof.connectionChallenge !== attempt.runBinding.connectionChallenge) return false
    if (!options.quiescence) return this.registry?.quiescenceCurrent(proof) ?? false
    // Explicit disposable-test evidence still has to match and remain fresh.
    const now = this.monotonic()
    return now >= proof.runnerReceivedAt && now - proof.runnerReceivedAt <= 2000
  }

  /** Runs even while the dock is hidden. Expiry revokes dispatch, not Pi tools. */
  sweepAssignmentLimits(): void {
    this.intervention?.sweep()
    for (const assignment of this.runner.store.listAssignments()) {
      if (this.assignmentTerminal(assignment.state)) continue
      const remaining = assignmentRemainingMs(this.runner.store, assignment, this.monotonic())
      if (remaining !== null && remaining > 0) continue
      this.stopAssignment({ assignmentId: assignment.assignmentId,
        trigger: remaining === null ? 'protocol_uncertainty' : 'elapsed_limit',
        reasonCode: remaining === null ? 'elapsed_interval_unknown' : 'elapsed_limit_exhausted' })
    }
  }

  // -------------------------------------------------------------------------
  // Native Stop uses the common command/receipt transaction. Return/resume and
  // writer clearance use AssignmentIntervention with challenged same-Pi proof.
  // The older direct helpers below are not the production reconciliation route.
  // Stop revokes future dispatch before any cancellation and
  // retains the writer on unknown effects; takeover advances the control epoch
  // and pauses automatic delivery; reconciliation is explicit and bounded.
  // -------------------------------------------------------------------------

  /** Durably revoke new dispatch for one Assignment; never claims Pi/tool termination. */
  stopAssignment(input: AssignmentStopInput): AssignmentStopOutcome {
    if (this.commandContext !== null) {
      throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome before stopping')
    }
    const assignment = this.runner.store.getAssignment(input.assignmentId)
    if (assignment === null) {
      throw workbenchError('missing_resource', `no Assignment ${String(input.assignmentId)}`, 'read the current projection before stopping an Assignment')
    }
    const trigger = input.trigger ?? 'operator'
    if (!STOP_TRIGGERS.includes(trigger)) {
      throw workbenchError('invalid_input', `unknown stop trigger ${String(trigger)}`, 'use a declared stop trigger')
    }
    return this.stopAssignmentInternal(assignment, trigger, input.reasonCode ?? null)
  }

  /**
   * Source-only takeover: advance the Run control epoch, record manual_takeover
   * and pause automatic delivery. Already running tools are never killed and
   * the writer lease is retained.
   */
  takeAssignmentControl(input: AssignmentTakeoverInput): AssignmentTakeoverOutcome {
    if (this.commandContext !== null) {
      throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome before taking control')
    }
    const assignment = this.runner.store.getAssignment(input.assignmentId)
    if (assignment === null) {
      throw workbenchError('missing_resource', `no Assignment ${String(input.assignmentId)}`, 'read the current projection before taking control')
    }
    if (this.assignmentTerminal(assignment.state)) {
      throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is already ${assignment.state}`, 'a terminal Assignment cannot be taken over')
    }
    const binding = this.runner.store.getBinding(assignment.agentRunId)
    if (binding === null) {
      throw workbenchError('missing_resource', `no Run binding ${assignment.agentRunId}`, 'the Assignment Run must still exist')
    }
    const now = this.clock()
    const controlEpoch = binding.controlEpoch + 1
    this.commit('assignment_takeover', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, controlEpoch,
    }, () => {
      this.runner.store.setBindingControlEpoch(assignment.agentRunId, controlEpoch, now)
      this.runner.store.setBindingState(assignment.agentRunId, 'manual_takeover', now)
      this.pauseRunAssignments(assignment.agentRunId)
    })
    return {
      assignmentId: assignment.assignmentId,
      controlEpoch,
      state: this.runner.store.getAssignment(assignment.assignmentId)!.state,
      writerState: this.runner.store.getWriter(assignment.projectId)?.state ?? 'none',
      committedRevision: this.revision,
    }
  }

  /** Called INSIDE the binding takeover transaction by both native input and
   * dock Take control. Epoch, lifecycle and queued revocation commit together. */
  pauseRunAssignments(runId: string): void {
    const store = this.runner.store, now = this.clock()
    for (const assignment of store.listAssignments()) {
      if (assignment.agentRunId !== runId || this.assignmentTerminal(assignment.state)) continue
      for (const delivery of store.listAssignmentDeliveries(assignment.assignmentId)) {
        if (delivery.state === 'queued') store.transitionAssignmentDelivery(delivery.attemptId, 'queued', 'not_sent', 'revoked')
      }
      for (const attempt of store.listAttempts(assignment.assignmentId)) {
        if (['admitted', 'dispatching', 'running', 'candidate', 'validating'].includes(attempt.state)) {
          store.transitionAttempt(attempt.attemptId, attempt.state, 'attention', now)
        }
      }
      if (assignment.state !== 'attention') store.transitionAssignment(assignment.assignmentId, assignment.state, 'attention', this.revision + 1, now)
    }
  }

  /** Persist one exact structured handoff and enter reconciliation. */
  recordAssignmentHandoff(input: AssignmentHandoffInput): AssignmentHandoffOutcome {
    if (this.commandContext !== null) {
      throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome before recording a handoff')
    }
    const attempt = this.runner.store.getAttempt(input.attemptId)
    if (attempt === null) {
      throw workbenchError('missing_resource', `no Attempt ${String(input.attemptId)}`, 'record a handoff only for the exact current Attempt')
    }
    const assignment = this.runner.store.getAssignment(attempt.assignmentId)!
    if (assignment.state !== 'attention' && assignment.state !== 'reconciling') {
      throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is ${assignment.state}, not needs-reconciliation`, 'return to team only after an explicit takeover or attention state')
    }
    const binding = this.runner.store.getBinding(assignment.agentRunId)
    if (binding === null) {
      throw workbenchError('missing_resource', `no Run binding ${assignment.agentRunId}`, 'the Assignment Run must still exist')
    }
    if (binding.state !== 'manual_takeover' && binding.state !== 'manual_takeover_disconnected') {
      throw workbenchError('fence_conflict', 'return-to-team requires an explicit source takeover first', 'take control, then record one structured handoff')
    }
    const artifactRefs = input.artifactRefs.map(ref => ({ path: ref.path, digest: ref.digest, length: ref.length }))
    const handoffId = this.newId('handoff-')
    const digest = handoffDigest({
      assignmentId: assignment.assignmentId, attemptId: attempt.attemptId, agentRunId: assignment.agentRunId,
      controlEpoch: binding.controlEpoch, claimedState: input.claimedState, summary: input.summary,
      artifactRefs, outstandingEffects: input.outstandingEffects,
    })
    const record: HandoffRecord = {
      handoffId, assignmentId: assignment.assignmentId, attemptId: attempt.attemptId, agentRunId: assignment.agentRunId,
      controlEpoch: binding.controlEpoch, claimedState: input.claimedState, summary: input.summary,
      artifactRefs, outstandingEffects: input.outstandingEffects, digest, createdAt: this.clock(),
    }
    this.commit('assignment_handoff', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, attemptId: attempt.attemptId, handoffId,
    }, () => {
      this.runner.store.putHandoff(record)
      if (assignment.state === 'attention') {
        if (!this.runner.store.transitionAssignment(assignment.assignmentId, 'attention', 'reconciling', this.revision + 1, this.clock())) {
          throw workbenchError('fence_conflict', 'the Assignment moved before the handoff could be recorded', 're-read the Assignment and reconcile the winner')
        }
      }
    })
    return {
      handoffId, digest,
      state: this.runner.store.getAssignment(assignment.assignmentId)!.state,
      committedRevision: this.revision,
    }
  }

  /**
   * Explicit current-revision reconciliation. `retry` corrects an ordinary gate
   * failure; `accept`/`resume` require the exact retained handoff. Every path
   * revalidates the held writer, readiness, absence of stop and remaining
   * limits; an exhausted budget stops dispatch instead of granting a fresh one.
   */
  reconcileAssignment(input: AssignmentReconciliationInput): AssignmentReconciliationOutcome {
    if (this.commandContext !== null) {
      throw workbenchError('invalid_input', 'reentrant command during authority transaction', 'wait for the current command outcome before reconciling')
    }
    const assignment = this.runner.store.getAssignment(input.assignmentId)
    if (assignment === null) {
      throw workbenchError('missing_resource', `no Assignment ${String(input.assignmentId)}`, 'read the current projection before reconciling')
    }
    if (this.assignmentTerminal(assignment.state)) {
      throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is already ${assignment.state}`, 'a terminal Assignment cannot be reconciled')
    }
    if (input.expectedRevision !== this.revision) {
      throw workbenchError('fence_conflict', 'the projection changed; this reconciliation intent is stale', 're-read the current projection and reconcile again')
    }
    if (assignment.state !== 'attention' && assignment.state !== 'reconciling') {
      throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is ${assignment.state}, not reconcilable`, 'correction is bounded to attention/reconciling Assignments')
    }
    const attempts = this.runner.store.listAttempts(assignment.assignmentId)
    const prior = attempts.length === 0 ? null : attempts[attempts.length - 1]!
    if (prior === null) {
      throw workbenchError('missing_resource', `Assignment ${assignment.assignmentId} has no Attempt to correct`, 'admit an Attempt before reconciling')
    }
    if (prior.state !== 'attention') {
      throw workbenchError('fence_conflict', `the latest Attempt is ${prior.state}, not attention`, 'only a settled attention Attempt can seed the next bounded Attempt')
    }
    if (this.runner.store.getStop(assignment.assignmentId) !== null) {
      throw workbenchError('fence_conflict', 'a durable stop is recorded for this Assignment', 'a stopped Assignment is never redispatched')
    }
    if (input.decision === 'accept' || input.decision === 'resume') {
      const handoff = this.runner.store.getHandoff(prior.attemptId)
      if (handoff === null || (input.handoffId !== undefined && handoff.handoffId !== input.handoffId)) {
        throw workbenchError('fence_conflict', 'return-to-team requires its exact retained handoff', 'record the structured handoff on this Attempt before reconciling')
      }
    }
    const writer = this.runner.store.getWriter(assignment.projectId)
    if (writer === null || writer.state !== 'held' || writer.assignmentId !== assignment.assignmentId
      || writer.attemptId !== prior.attemptId || writer.epoch !== prior.writerEpoch) {
      throw workbenchError('fence_conflict', 'the exact held writer lease is required to reconcile', 'unknown effects retain the writer until explicit supported reconciliation')
    }
    const binding = this.runner.store.getBinding(assignment.agentRunId)
    if (binding === null) {
      throw workbenchError('missing_resource', `no Run binding ${assignment.agentRunId}`, 'the Assignment Run must still exist')
    }
    if (binding.state !== 'ready') {
      throw workbenchError('fence_conflict', `the Run binding is ${binding.state}; automatic continuation is paused`, 'return control to team and confirm readiness before another Attempt')
    }
    if (binding.controlEpoch < prior.controlEpoch) {
      throw workbenchError('fence_conflict', 'the Run control epoch is older than the Attempt', 'reconcile only under the current control epoch')
    }
    const now = this.clock()
    if (assignment.attemptCount > assignment.limits.maxCorrections) {
      const stopped = this.stopAssignmentInternal(assignment, 'attempt_limit', 'attempt_limit_exhausted')
      return { status: 'stopped', reasonCode: 'attempt_limit_exhausted', attemptId: null, deliveryId: null, writerEpoch: null, stopId: stopped.stopId, committedRevision: stopped.committedRevision }
    }
    const remaining = assignmentRemainingMs(this.runner.store, assignment, this.monotonic())
    if (remaining === null || remaining <= 0) {
      const stopped = this.stopAssignmentInternal(assignment, 'elapsed_limit', 'elapsed_limit_exhausted')
      return { status: 'stopped', reasonCode: 'elapsed_limit_exhausted', attemptId: null, deliveryId: null, writerEpoch: null, stopId: stopped.stopId, committedRevision: stopped.committedRevision }
    }
    const attemptId = this.newId('attempt-')
    const deliveryId = this.newId('delivery-')
    const writerEpoch = prior.writerEpoch + 1
    const nextAttempt: AttemptRecord = {
      attemptId,
      assignmentId: assignment.assignmentId,
      ordinal: prior.ordinal + 1,
      state: 'admitted',
      runBinding: { ...prior.runBinding },
      gate: { ...prior.gate },
      context: { ...prior.context },
      limits: { ...assignment.limits },
      writerEpoch,
      controlEpoch: binding.controlEpoch,
      deliveryId,
      createdAt: now,
      updatedAt: now,
    }
    const deadline = now + ASSIGNMENT_DELIVERY_TTL_MS
    const frameJson = canonicalJson(attemptFrame(assignment, nextAttempt, deadline))
    const delivery: AssignmentDelivery = {
      deliveryId, assignmentId: assignment.assignmentId, attemptId, runId: nextAttempt.runBinding.runId,
      frameJson, payloadDigest: sha256(frameJson), state: 'queued', reasonCode: null, deadline, createdAt: now,
    }
    const from = assignment.state
    this.commit('assignment_reconciled', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, attemptId, decision: input.decision,
    }, () => {
      for (const existing of this.runner.store.listAssignmentDeliveries(assignment.assignmentId)) {
        if (existing.state === 'queued') this.runner.store.transitionAssignmentDelivery(existing.attemptId, 'queued', 'not_sent', 'revoked')
      }
      this.runner.store.releaseWriter(assignment.projectId, now)
      this.runner.store.putAttempt(nextAttempt)
      this.runner.store.acquireWriter({ projectId: assignment.projectId, assignmentId: assignment.assignmentId, attemptId, epoch: writerEpoch, updatedAt: now })
      this.runner.store.putAssignmentDelivery(delivery)
      if (!this.runner.store.transitionAttempt(prior.attemptId, 'attention', 'rejected', now)) {
        throw workbenchError('fence_conflict', 'the prior Attempt moved before correction', 're-read the Assignment and reconcile the winner')
      }
      if (!this.runner.store.transitionAttempt(attemptId, 'admitted', 'dispatching', now)) {
        throw workbenchError('fence_conflict', 'the corrected Attempt could not be dispatched', 're-read the Assignment and reconcile the winner')
      }
      if (!this.runner.store.transitionAssignment(assignment.assignmentId, from, 'dispatching', this.revision + 1, now)) {
        throw workbenchError('fence_conflict', 'the Assignment moved before correction', 're-read the Assignment and reconcile the winner')
      }
    })
    return { status: 'admitted', reasonCode: null, attemptId, deliveryId, writerEpoch, stopId: null, committedRevision: this.revision }
  }

  private assignmentTerminal(state: AssignmentState): boolean {
    return state === 'accepted' || state === 'stopped' || state === 'failed'
  }

  private assignmentEffectsPossible(assignment: AssignmentRecord, deliveries: AssignmentDelivery[]): boolean {
    if (['dispatching', 'running', 'candidate', 'validating', 'attention', 'reconciling'].includes(assignment.state)) return true
    return deliveries.some(delivery => delivery.state === 'attempting' || delivery.state === 'unknown' || delivery.state === 'written')
  }

  /**
   * Revoke new dispatch atomically first, record the durable stop, close the
   * current lifecycle, and either retain the writer on unknown effects or
   * release it when nothing could have been sent. Cancellation stays separate.
   */
  private stopAssignmentInternal(assignment: AssignmentRecord, trigger: StopTrigger, reasonCode: string | null): AssignmentStopOutcome {
    const existing = this.runner.store.getStop(assignment.assignmentId)
    if (existing !== null) {
      const project = this.runner.store.getAssignment(existing.assignmentId)?.projectId ?? ''
      return {
        status: 'stopped', stopId: existing.stopId, assignmentId: existing.assignmentId, dispatchRevoked: true,
        cancellationStatus: existing.cancellationStatus, writerState: this.runner.store.getWriter(project)?.state ?? 'none',
        replayed: true, committedRevision: this.revision,
      }
    }
    const now = this.clock()
    const stopId = this.newId('stop-')
    const effectsPossible = this.runner.store.getWriter(assignment.projectId)?.state === 'uncertain'
      || this.assignmentEffectsPossible(assignment, this.runner.store.listAssignmentDeliveries(assignment.assignmentId))
    const box: { writerState: WriterState } = { writerState: 'none' }
    this.commit('assignment_stopped', {
      projectId: assignment.projectId, goalId: assignment.goalId, runId: assignment.agentRunId,
      assignmentId: assignment.assignmentId, stopId, trigger,
    }, () => {
      for (const delivery of this.runner.store.listAssignmentDeliveries(assignment.assignmentId)) {
        if (delivery.state === 'queued') this.runner.store.transitionAssignmentDelivery(delivery.attemptId, 'queued', 'not_sent', 'revoked')
      }
      this.runner.store.putStop({
        stopId, assignmentId: assignment.assignmentId, trigger, revision: this.revision + 1,
        dispatchRevoked: true, cancellationStatus: 'not_requested', reasonCode, createdAt: now, updatedAt: now,
      })
      if (!this.assignmentTerminal(assignment.state)) {
        if (!this.runner.store.transitionAssignment(assignment.assignmentId, assignment.state, 'stopped', this.revision + 1, now)) {
          throw workbenchError('fence_conflict', 'the Assignment moved before stop could be recorded', 're-read the Assignment; a winner already advanced it')
        }
      } else if (assignment.state !== 'stopped') {
        throw workbenchError('fence_conflict', `Assignment ${assignment.assignmentId} is already ${assignment.state}`, 'a terminal accepted/failed Assignment cannot be stopped')
      }
      const attempts = this.runner.store.listAttempts(assignment.assignmentId)
      const current = attempts.length === 0 ? null : attempts[attempts.length - 1]!
      if (current !== null && ['admitted', 'dispatching', 'running', 'candidate', 'validating', 'attention'].includes(current.state)) {
        this.runner.store.transitionAttempt(current.attemptId, current.state, 'stopped', now)
      }
      if (effectsPossible) this.runner.store.markWriterUncertain(assignment.projectId, now)
      else this.runner.store.releaseWriter(assignment.projectId, now)
      box.writerState = this.runner.store.getWriter(assignment.projectId)?.state ?? 'none'
    }, () => abortAssignmentGate(this.runner.store, assignment.assignmentId))
    return {
      status: 'stopped', stopId, assignmentId: assignment.assignmentId, dispatchRevoked: true,
      cancellationStatus: 'not_requested', writerState: box.writerState, replayed: false, committedRevision: this.revision,
    }
  }

  private startProposalPort(): StartProposalAuthority {
    return {
      store: this.runner.store,
      fences: this.runner.fences,
      registry: this.registry,
      currentRevision: () => this.revision,
    }
  }
  private startProposalOptions(options: StartProposalOptions): StartProposalOptions {
    const git = options.git ?? this.git
    return {
      ...options,
      clock: options.clock ?? this.clock,
      newId: options.newId ?? this.newId,
      ...(git === undefined ? {} : { git }),
    }
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

  private isInsideStateRoot(canonicalPath: string): boolean {
    const root = this.runner.roots.stateDir
    return pathsOverlap(canonicalPath, root)
  }

  private pruneRegistrations(): void {
    const now = this.clock()
    for (const [id, record] of this.registrations) {
      if (now - record.createdAt > this.registrationTtlMs) this.registrations.delete(id)
    }
  }

  currentRegistration(inspectionId: string): RegistrationRecord | null {
    const record = this.registrations.get(inspectionId)
    return record === undefined ? null : copyRegistration(record)
  }

  /** Most recent unresolved inspection, newest first. Transient by design. */
  pendingRegistration(): RegistrationRecord | null {
    let newest: RegistrationRecord | null = null
    for (const record of this.registrations.values()) {
      if (newest === null || record.createdAt >= newest.createdAt) newest = record
    }
    return newest === null ? null : copyRegistration(newest)
  }
}
