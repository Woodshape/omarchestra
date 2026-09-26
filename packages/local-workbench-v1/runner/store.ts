/**
 * Local Workbench v1 Phase 2 — durable SQLite store (contract C3).
 *
 * One runner owns this database. Settings are explicit and verified: foreign
 * keys ON, rollback journal DELETE, synchronous FULL, busy timeout 1000 ms,
 * `BEGIN IMMEDIATE` for every authority transaction. Schema version and the
 * declared table shape are validated before any frame is accepted. Clean
 * shutdown closes connections without deleting history.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { workbenchError } from './errors.ts'
import { assertNodeId } from './identity.ts'
import { validateStoredDelivery, type BridgeDelivery, type DeliveryState } from './bridge-delivery.ts'
import { readResolvedCheck } from './check-definition.ts'
import { canonicalJson, sha256 } from './canonical-hash.ts'
import { pendingRow, validatePendingProposal, type PendingProposal } from './pending-proposal.ts'
import { incarnationKey, validateIncarnation, type BindingIdentity, type PiIncarnation } from './binding-identity.ts'
import { OWNED_FILE_MODE } from './paths.ts'
import { REQUIRED_JOURNAL_MODE, REQUIRED_PRAGMAS, STORE_DDL, STORE_SCHEMA_VERSION, STORE_TABLES } from './schema.ts'

export const BINDING_STATES = [
  'proposed',
  'authorized',
  'acknowledged',
  'committed',
  'ready',
  'manual_takeover',
  'manual_takeover_disconnected',
  'disconnected',
  'retired',
  'purged',
] as const
export type BindingState = (typeof BINDING_STATES)[number]

/** States whose effects are unknown after an unclean stop. */
export const UNCERTAIN_BINDING_STATES: BindingState[] = ['proposed', 'authorized', 'acknowledged']

export const WRITER_STATES = ['none', 'held', 'uncertain'] as const
export type WriterState = (typeof WRITER_STATES)[number]

/**
 * AL-02 one-Assignment lifecycle. These are durable record shapes only: no
 * method here dispatches a message, executes a gate or proves a live Pi.
 * `start_assignment` remains disabled until authority wiring lands separately.
 */
export const ASSIGNMENT_STATES = ['admitted', 'dispatching', 'running', 'candidate', 'validating', 'attention', 'reconciling', 'accepted', 'stopped', 'failed'] as const
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number]
export const TERMINAL_ASSIGNMENT_STATES: AssignmentState[] = ['accepted', 'stopped', 'failed']
export const ASSIGNMENT_TRANSITIONS: Record<AssignmentState, AssignmentState[]> = {
  admitted: ['dispatching', 'attention', 'stopped', 'failed'],
  dispatching: ['running', 'attention', 'stopped', 'failed'],
  running: ['candidate', 'attention', 'stopped', 'failed'],
  candidate: ['validating', 'attention', 'stopped', 'failed'],
  validating: ['accepted', 'attention', 'dispatching', 'stopped', 'failed'],
  attention: ['dispatching', 'reconciling', 'validating', 'stopped', 'failed'],
  reconciling: ['dispatching', 'validating', 'attention', 'stopped', 'failed'],
  accepted: [],
  stopped: [],
  failed: [],
}

export const ATTEMPT_STATES = ['admitted', 'dispatching', 'running', 'candidate', 'validating', 'accepted', 'rejected', 'attention', 'stopped'] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]
export const ATTEMPT_TRANSITIONS: Record<AttemptState, AttemptState[]> = {
  admitted: ['dispatching', 'attention', 'stopped', 'rejected'],
  dispatching: ['running', 'attention', 'stopped', 'rejected'],
  running: ['candidate', 'attention', 'stopped', 'rejected'],
  candidate: ['validating', 'attention', 'stopped', 'rejected'],
  validating: ['accepted', 'rejected', 'attention', 'stopped'],
  attention: ['rejected', 'stopped'],
  accepted: [],
  rejected: [],
  stopped: [],
}

export const OUTBOX_STATES = ['queued', 'attempting', 'written', 'not_sent', 'unknown'] as const
export type AssignmentOutboxState = (typeof OUTBOX_STATES)[number]
export const CANDIDATE_STATES = ['pending', 'validated', 'rejected'] as const
export type CandidateState = (typeof CANDIDATE_STATES)[number]
export const GATE_OUTCOMES = ['pass', 'nonzero', 'spawn_error', 'timeout', 'output_limit', 'candidate_changed', 'gate_changed', 'unknown'] as const
export type GateOutcome = (typeof GATE_OUTCOMES)[number]
export const GATE_RESULT_STATES = ['provisional', 'accepted', 'nonaccepting'] as const
export type GateResultState = (typeof GATE_RESULT_STATES)[number]
export const STOP_TRIGGERS = ['operator', 'elapsed_limit', 'attempt_limit', 'protocol_uncertainty', 'gate_failure_attention'] as const
export type StopTrigger = (typeof STOP_TRIGGERS)[number]
export const CANCELLATION_STATUSES = ['not_requested', 'requested', 'acknowledged', 'unsupported', 'timeout', 'unknown'] as const
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number]
export const HANDOFF_CLAIMED_STATES = ['candidate', 'partial', 'blocked'] as const
export type HandoffClaimedState = (typeof HANDOFF_CLAIMED_STATES)[number]
export const OUTSTANDING_EFFECTS = ['none_reported', 'may_be_active', 'unknown'] as const
export type OutstandingEffects = (typeof OUTSTANDING_EFFECTS)[number]

export interface AssignmentLimits { maxCorrections: number; elapsedMs: number }
/** Frozen Node/process/session/extension identity and exact challenged connection. */
export interface AssignmentRunBinding {
  executionNodeId: string
  processInstanceId: string
  piSessionId: string
  extensionInstanceId: string
  runId: string
  goalId: string
  bindingDigest: string
  connectionId: string
  connectionChallenge: string
}
/** Frozen C9 execution context: Project/Git identity plus stable baseline digests. */
export interface AssignmentContext {
  projectId: string
  executionNodeId: string
  canonicalPath: string
  gitCommonDir: string
  repositoryIdentity: string
  headOid: string
  dirty: boolean
  baselineDigest: string
  manifestDigest: string
}
export interface ArtifactRef { path: string; digest: string; length: number }

export interface AssignmentRecord {
  assignmentId: string
  projectId: string
  goalId: string
  agentRunId: string
  bindingDigest: string
  goalText: string
  taskText: string
  writeAuthority: boolean
  state: AssignmentState
  limits: AssignmentLimits
  attemptCount: number
  revision: number
  createdAt: number
  updatedAt: number
}
export interface AttemptRecord {
  attemptId: string
  assignmentId: string
  ordinal: number
  state: AttemptState
  runBinding: AssignmentRunBinding
  gate: { checkId: string; version: number; digest: string; canonicalJson: string }
  context: AssignmentContext
  limits: AssignmentLimits
  writerEpoch: number
  controlEpoch: number
  deliveryId: string | null
  createdAt: number
  updatedAt: number
}
export interface AssignmentWriterRecord {
  projectId: string
  assignmentId: string | null
  attemptId: string | null
  epoch: number
  state: WriterState
  updatedAt: number
}
export interface AssignmentDelivery {
  deliveryId: string
  assignmentId: string
  attemptId: string
  runId: string
  frameJson: string
  payloadDigest: string
  state: AssignmentOutboxState
  reasonCode: string | null
  deadline: number
  createdAt: number
}
export interface CandidateRecord {
  candidateId: string
  assignmentId: string
  attemptId: string
  agentRunId: string
  controlEpoch: number
  summary: string
  artifactRefs: ArtifactRef[]
  digest: string
  preManifestDigest: string
  state: CandidateState
  createdAt: number
}
/** The exact bounded C6 fields a Run may submit for one Attempt. */
export interface CandidateSubmissionFacts {
  assignmentId: string
  attemptId: string
  agentRunId: string
  controlEpoch: number
  summary: string
  artifactRefs: ArtifactRef[]
}
/** Result of associating one submission; `idempotent` is an exact duplicate. */
export interface CandidateAssociation {
  candidate: CandidateRecord
  idempotent: boolean
}
export interface GateResultRecord {
  resultId: string
  assignmentId: string
  attemptId: string
  candidateId: string
  gateDigest: string
  executableDigest: string
  outcome: GateOutcome
  preManifestDigest: string
  postManifestDigest: string | null
  exitCode: number | null
  reasonCode: string | null
  evidenceJson: string
  state: GateResultState
  revision: number
  createdAt: number
}
/**
 * Exact claim AL-05 hands the store so the final acceptance decision is made
 * atomically against current durable state. `acceptanceManifestDigest` is the
 * checkout fingerprint captured immediately before this transaction; the store
 * never trusts the caller's word for any of the rechecked identities.
 */
export interface GateAcceptanceInput {
  resultId: string
  assignmentId: string
  attemptId: string
  candidateId: string
  candidateDigest: string
  gateDigest: string
  executableDigest: string
  outcome: GateOutcome
  postManifestDigest: string | null
  acceptanceManifestDigest: string | null
  acceptanceScanError: string | null
  quiescenceConfirmed: boolean
  quiescenceReason: string | null
  revision: number
  updatedAt: number
}

export interface GateAcceptance {
  accepted: boolean
  reasonCode: string | null
}

export interface AssignmentStopRecord {
  stopId: string
  assignmentId: string
  trigger: StopTrigger
  revision: number
  dispatchRevoked: boolean
  cancellationStatus: CancellationStatus
  reasonCode: string | null
  createdAt: number
  updatedAt: number
}
export interface HandoffRecord {
  handoffId: string
  assignmentId: string
  attemptId: string
  agentRunId: string
  controlEpoch: number
  claimedState: HandoffClaimedState
  summary: string
  artifactRefs: ArtifactRef[]
  outstandingEffects: OutstandingEffects
  digest: string
  createdAt: number
}

export interface BindingRecord {
  runId: string
  projectId: string | null
  role: string | null
  state: BindingState
  bindingDigest: string | null
  controlEpoch: number
  writerState: WriterState
  predecessorRunId: string | null
  generation: number | null
  updatedAt: number
}

export interface ProjectRecord {
  projectId: string
  executionNodeId: string
  canonicalPath: string
  gitCommonDir: string
  headOid: string | null
  dirty: boolean
  /** Schema 7 repo-v1 directory identity, NOT the C9 content/Run context fingerprint. */
  contextDigest: string | null
  revision: number
  createdAt: number
}

export interface GoalRecord {
  goalId: string
  projectId: string
  goalText: string
  state: 'active' | 'recent'
  outcome: string | null
  createdAt: number
}

export interface CheckRecord {
  projectId: string
  checkId: string
  version: number
  digest: string
  canonicalJson: string
  name: string
  mode: string
  createdAt: number
}

export interface EventRecord {
  runId?: string | null
  eventId: string
  cursor: number
  baseRevision: number
  revision: number
  kind: string
  createdAt: number
}

export interface IntentResultRecord {
  reason?: string | null
  detail?: string | null
  intentId: string
  sessionId: string
  /** Schema 6 authority receipts hash the complete validated original envelope. */
  payloadHash: string
  status: string
  reasonCode: string | null
  committedRevision: number | null
  createdAt: number
}

export interface ManagementOperation {
  intentId: string
  sessionId: string
  /** Same complete-envelope fingerprint as the eventual authority receipt. */
  payloadHash: string
  kind: 'retire' | 'purge'
  runId: string
  targetJson: string
  createdAt: number
}

export interface WorkbenchStore {
  readonly path: string
  readonly nodeId: string
  readonly epoch: number
  getMeta(key: string): string | null
  setMeta(key: string, value: string): void
  transaction<T>(fn: () => T): T
  putBinding(binding: BindingRecord): void
  getBinding(runId: string): BindingRecord | null
  listBindings(): BindingRecord[]
  putBindingIdentity(runId: string, goalId: string, incarnation: PiIncarnation): void
  getBindingIdentity(runId: string): BindingIdentity | null
  commitMembership(runId: string): void
  putProposal(record: PendingProposal): void
  getProposal(proposalId: string): PendingProposal | null
  listProposals(): PendingProposal[]
  updateProposal(record: PendingProposal): void
  deleteProposal(proposalId: string): void
  discardProposalsOnRestart(): void
  releaseMembership(runId: string): void
  listMemberships(goalId: string): Array<{ goalId: string; role: string; runId: string }>
  purgeRetiredHistory(runId: string, now: number): void
  hasUncertainEffects(projectId: string): boolean
  setBindingState(runId: string, state: BindingState, updatedAt: number): void
  setBindingControlEpoch(runId: string, controlEpoch: number, updatedAt: number): void
  markUncertainInFlight(updatedAt: number): string[]
  putProject(project: ProjectRecord): void
  getProject(projectId: string): ProjectRecord | null
  listProjects(): ProjectRecord[]
  insertGoal(goal: GoalRecord): void
  getGoal(goalId: string): GoalRecord | null
  listGoals(projectId?: string): GoalRecord[]
  setGoalState(goalId: string, state: GoalRecord['state'], outcome: string | null): void
  putCheck(check: CheckRecord): void
  getCheck(projectId: string, checkId: string, version: number): CheckRecord | null
  latestCheck(projectId: string, checkId: string): CheckRecord | null
  listChecks(projectId: string): CheckRecord[]
  appendEvent(event: EventRecord): void
  listEvents(): EventRecord[]
  maxCursor(): number
  putDelivery(delivery: BridgeDelivery): void
  listDeliveries(runId?: string): BridgeDelivery[]
  transitionDelivery(frameId: string, from: DeliveryState, to: DeliveryState, reasonCode: string | null): boolean
  putAssignment(record: AssignmentRecord): void
  getAssignment(assignmentId: string): AssignmentRecord | null
  listAssignments(projectId?: string): AssignmentRecord[]
  activeAssignment(projectId: string): AssignmentRecord | null
  transitionAssignment(assignmentId: string, from: AssignmentState, to: AssignmentState, revision: number, updatedAt: number): boolean
  putAttempt(record: AttemptRecord): void
  getAttempt(attemptId: string): AttemptRecord | null
  listAttempts(assignmentId?: string): AttemptRecord[]
  transitionAttempt(attemptId: string, from: AttemptState, to: AttemptState, updatedAt: number): boolean
  acquireWriter(record: { projectId: string; assignmentId: string | null; attemptId: string | null; epoch: number; updatedAt: number }): AssignmentWriterRecord
  releaseWriter(projectId: string, updatedAt: number): void
  markWriterUncertain(projectId: string, updatedAt: number): boolean
  getWriter(projectId: string): AssignmentWriterRecord | null
  listWriters(): AssignmentWriterRecord[]
  putAssignmentDelivery(delivery: AssignmentDelivery): void
  getAssignmentDelivery(attemptId: string): AssignmentDelivery | null
  listAssignmentDeliveries(assignmentId?: string): AssignmentDelivery[]
  transitionAssignmentDelivery(attemptId: string, from: AssignmentOutboxState, to: AssignmentOutboxState, reasonCode: string | null): boolean
  putCandidate(record: CandidateRecord): void
  submitCandidate(input: { submission: CandidateSubmissionFacts; candidateId: string; createdAt: number }): CandidateAssociation
  getCandidate(candidateId: string): CandidateRecord | null
  getCandidateByAttempt(attemptId: string): CandidateRecord | null
  listCandidates(assignmentId?: string): CandidateRecord[]
  setCandidateState(candidateId: string, state: CandidateState): boolean
  putGateResult(record: GateResultRecord): void
  getGateResult(attemptId: string): GateResultRecord | null
  listGateResults(assignmentId?: string): GateResultRecord[]
  transitionGateResult(resultId: string, from: GateResultState, to: GateResultState, revision: number): boolean
  /**
   * Resolve the one provisional gate result for this Attempt in a single
   * transaction that rechecks the Candidate, frozen gate, Project context,
   * writer/control epochs, stop intent and quiescence before accepting. A pass
   * is accepted only when every recheck holds; every other path settles the
   * result nonaccepting and never releases the writer on uncertainty.
   */
  resolveGateAcceptance(input: GateAcceptanceInput): GateAcceptance
  putStop(record: AssignmentStopRecord): void
  getStop(assignmentId: string): AssignmentStopRecord | null
  listStops(): AssignmentStopRecord[]
  setStopCancellation(stopId: string, status: CancellationStatus, updatedAt: number): boolean
  putHandoff(record: HandoffRecord): void
  getHandoff(attemptId: string): HandoffRecord | null
  listHandoffs(assignmentId?: string): HandoffRecord[]
  putManagementOperation(operation: ManagementOperation): void
  listManagementOperations(): ManagementOperation[]
  deleteManagementOperation(intentId: string): void
  putIntentResult(record: IntentResultRecord): void
  getIntentResult(intentId: string): IntentResultRecord | null
  integrityCheck(): string
  backupTo(target: string): void
  close(): void
}

interface StoreOptions {
  path: string
  nodeId: string
  create: boolean
  clock?: () => number
}

function sqliteFailure(path: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  throw workbenchError('store_unavailable', `cannot open store ${path}: ${message}`, 'close other workbench processes, then re-run; do not delete the database')
}

function openDatabase(path: string, options: StoreOptions): DatabaseSync {
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path)
  } catch (error) {
    sqliteFailure(path, error)
  }
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 1000')
    // Detect a foreign journal mode before switching it: a durable root must
    // already be in the required rollback-journal mode, and the runner never
    // silently rewrites a property another writer chose.
    const observed = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    const observedMode = String(observed.journal_mode ?? '').toLowerCase()
    if (observedMode !== REQUIRED_JOURNAL_MODE) {
      throw workbenchError('schema_drift', `journal_mode is ${observedMode}`, 'stop other processes using this database and re-run; do not edit the database')
    }
    db.exec('PRAGMA synchronous = FULL')
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    sqliteFailure(path, error)
  }
  try {
    if (options.create) {
      db.exec(STORE_DDL)
      db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)
    }
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    sqliteFailure(path, error)
  }
  return db
}

function readPragma(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined
  return row ? row[name] : undefined
}

export function assertSchemaShape(db: DatabaseSync, path: string): void {
  const version = Number(readPragma(db, 'user_version'))
  if (version !== STORE_SCHEMA_VERSION) {
    throw workbenchError(
      'unsupported_schema',
      `store schema version ${version} is not supported (expected ${STORE_SCHEMA_VERSION})`,
      'open this root with the workbench version that created it; migration requires an exclusive owner and a verified backup',
    )
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
  const present = new Map(tables.map(entry => [entry.name, entry]))
  for (const spec of STORE_TABLES) {
    if (!present.has(spec.name)) {
      throw workbenchError('schema_drift', `store is missing table ${spec.name}`, 'restore the latest verified backup; do not add or drop tables by hand')
    }
    const columns = new Set((db.prepare(`PRAGMA table_info(${spec.name})`).all() as Array<{ name: string }>).map(entry => entry.name))
    for (const column of spec.columns) {
      if (!columns.has(column)) {
        throw workbenchError('schema_drift', `table ${spec.name} is missing column ${column}`, 'restore the latest verified backup; do not edit schema by hand')
      }
    }
  }
  for (const spec of STORE_TABLES) present.delete(spec.name)
  if (present.size > 0) {
    const extra = [...present.keys()].join(', ')
    throw workbenchError('schema_drift', `store has unexpected tables: ${extra}`, 'restore the latest verified backup; unknown tables are never dropped automatically')
  }
  // Compare SQLite's own canonical schema representation, including constraints,
  // indexes and triggers. Matching column names alone accepts weakened tables.
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec(STORE_DDL)
    const shape = (connection: DatabaseSync) => connection.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()
    if (JSON.stringify(shape(db)) !== JSON.stringify(shape(reference))) {
      throw workbenchError('schema_drift', `constraint/index/trigger drift in ${path}`, 'use the exact supported schema; never repair unknown history automatically')
    }
  } finally { reference.close() }
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || String(Object.values(integrity[0])[0]).toLowerCase() !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw workbenchError('integrity_failure', `integrity/foreign key check failed for ${path}`, 'preserve the damaged database; do not keep writing')
  }
  for (const row of db.prepare('SELECT * FROM bridge_deliveries').all()) {
    const delivery = rowToDelivery(row)
    const frame = validateStoredDelivery(delivery)
    if ('protocol' in frame && frame.protocol === 'omarchestra.bridge/v1' && delivery.kind === 'committed') {
      const binding = db.prepare('SELECT b.binding_digest, b.role, i.goal_id FROM bindings b JOIN binding_identities i USING (run_id) WHERE b.run_id = ?')
        .get(delivery.runId) as { binding_digest: string; role: string; goal_id: string } | undefined
      if (!binding || frame.body.bindingDigest !== binding.binding_digest || frame.body.goalId !== binding.goal_id || frame.body.role !== binding.role) {
        throw workbenchError('schema_drift', 'framed delivery no longer matches its committed binding', 'preserve the store and investigate identity drift')
      }
    }
  }
  const identityNode = db.prepare("SELECT value FROM meta WHERE key = 'node_id'").get()?.value
  for (const row of db.prepare('SELECT * FROM adoption_proposals').all()) {
    try {
      const proposal = pendingRow(row)
      const association = db.prepare('SELECT p.execution_node_id, g.project_id AS goal_project FROM projects p JOIN goals g ON g.project_id = p.project_id WHERE p.project_id = ? AND g.goal_id = ?')
        .get(proposal.projectId, proposal.goalId) as { execution_node_id: string; goal_project: string } | undefined
      if (!association || association.execution_node_id !== identityNode || proposal.incarnation.executionNodeId !== identityNode
          || association.goal_project !== proposal.projectId || db.prepare('SELECT 1 FROM bindings WHERE run_id = ?').get(proposal.runId)
          || db.prepare('SELECT 1 FROM role_memberships WHERE goal_id = ? AND role = ?').get(proposal.goalId, proposal.role)) throw Error('pending association drift')
    } catch { throw workbenchError('schema_drift', 'persisted pending Adoption proposal is invalid', 'preserve the store; never promote malformed proposal state') }
  }
  for (const row of db.prepare('SELECT * FROM check_definitions').all()) {
    try { readResolvedCheck(rowToCheck(row)) }
    catch { throw workbenchError('schema_drift', 'persisted check definition is invalid', 'preserve history and inspect the stored definition; do not repair it automatically') }
  }
  for (const row of db.prepare('SELECT i.*, b.project_id, g.project_id AS goal_project_id, p.execution_node_id FROM binding_identities i LEFT JOIN bindings b USING (run_id) LEFT JOIN goals g ON g.goal_id = i.goal_id LEFT JOIN projects p ON p.project_id = b.project_id').all()) {
    try {
      const identity = validateIncarnation(JSON.parse(String(row.incarnation_json)))
      if (incarnationKey(identity) !== row.incarnation_key || row.project_id !== row.goal_project_id || identity.executionNodeId !== row.execution_node_id || identity.executionNodeId !== identityNode) throw Error('identity association drift')
    } catch {
      throw workbenchError('schema_drift', 'persisted binding identity is invalid', 'preserve exact identity; do not reconstruct it from paths or Run IDs')
    }
  }
  if (db.prepare("SELECT 1 FROM role_memberships m JOIN binding_identities i USING (run_id) JOIN bindings b USING (run_id) WHERE m.goal_id != i.goal_id OR m.role IS NOT b.role OR b.state IN ('proposed', 'authorized', 'acknowledged') LIMIT 1").get()) {
    throw workbenchError('schema_drift', 'persisted Role membership association is invalid', 'a proposal never occupies a Goal Role')
  }
  for (const row of db.prepare('SELECT * FROM assignments').all()) {
    try { assignmentRow(row) } catch { throw workbenchError('schema_drift', 'persisted Assignment is invalid', 'preserve the store and inspect the exact Assignment record; never repair lifecycle state automatically') }
  }
  for (const row of db.prepare('SELECT a.*, s.project_id, s.goal_id, s.agent_run_id, s.attempt_count FROM attempts a JOIN assignments s USING (assignment_id)').all()) {
    try { attemptRow(row, { projectId: String(row.project_id), goalId: String(row.goal_id), agentRunId: String(row.agent_run_id), attemptCount: Number(row.attempt_count) }) }
    catch { throw workbenchError('schema_drift', 'persisted Attempt is invalid', 'preserve the store and inspect the exact Attempt record; never reconstruct frozen gate, context, or binding bytes') }
  }
  if (db.prepare('SELECT a.assignment_id FROM assignments a LEFT JOIN attempts t USING (assignment_id) GROUP BY a.assignment_id HAVING COUNT(t.attempt_id) != a.attempt_count OR (COUNT(t.attempt_id) > 0 AND (MIN(t.ordinal) != 1 OR MAX(t.ordinal) != COUNT(t.attempt_id) OR SUM(t.ordinal) != COUNT(t.attempt_id) * (COUNT(t.attempt_id) + 1) / 2))').get()) {
    throw workbenchError('schema_drift', 'persisted Attempt ordinals are not the contiguous history recorded on the Assignment', 'preserve both records; never renumber Attempts or silently drop history')
  }
  for (const row of db.prepare('SELECT * FROM assignment_writers').all()) {
    try { writerRow(row) } catch { throw workbenchError('schema_drift', 'persisted Assignment writer lease is invalid', 'preserve the store and inspect the exact per-Project writer lease') }
  }
  for (const row of db.prepare('SELECT * FROM assignment_outbox').all()) {
    try { assignmentDeliveryRow(row) } catch { throw workbenchError('schema_drift', 'persisted Assignment delivery is invalid', 'preserve the store and inspect the exact outbox record; never resend an unknown delivery') }
  }
  for (const row of db.prepare('SELECT * FROM candidates').all()) {
    try { candidateRow(row) } catch { throw workbenchError('schema_drift', 'persisted Candidate is invalid', 'preserve the store and inspect the exact Candidate record') }
  }
  for (const row of db.prepare('SELECT * FROM gate_results').all()) {
    try { gateResultRow(row) } catch { throw workbenchError('schema_drift', 'persisted gate result is invalid', 'preserve the store and inspect the exact gate evidence') }
  }
  for (const row of db.prepare('SELECT * FROM assignment_stops').all()) {
    try { stopRow(row) } catch { throw workbenchError('schema_drift', 'persisted Assignment stop is invalid', 'preserve the store and inspect the exact stop record') }
  }
  for (const row of db.prepare('SELECT * FROM handoffs').all()) {
    try { handoffRow(row) } catch { throw workbenchError('schema_drift', 'persisted handoff is invalid', 'preserve the store and inspect the exact handoff record') }
  }
  for (const table of STORE_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string; type: string }>
    for (const column of columns.filter(c => c.type.toUpperCase() === 'INTEGER')) {
      const invalid = db.prepare(`SELECT 1 FROM ${table.name} WHERE ${column.name} IS NOT NULL AND
        (typeof(${column.name}) != 'integer' OR ${column.name} < 0 OR ${column.name} > 9007199254740991) LIMIT 1`).get()
      if (invalid) throw workbenchError('schema_drift', `invalid integer ${table.name}.${column.name}`, 'preserve and inspect corrupt history; counters cannot be rounded or reset')
    }
  }
  for (const key of ['runner_epoch', 'projection_revision', 'event_cursor']) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    if (row && (!/^(0|[1-9][0-9]*)$/.test(row.value) || !Number.isSafeInteger(Number(row.value)))) {
      throw workbenchError('schema_drift', `invalid persisted counter ${key}`, 'preserve the original counter; do not round or reset it')
    }
  }
}

export function openWorkbenchStore(options: StoreOptions): WorkbenchStore {
  const { path } = options
  const nodeId = assertNodeId(options.nodeId)
  const clock = options.clock ?? (() => Date.now())
  const db = openDatabase(path, options)
  try {
    assertSchemaShape(db, path)
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    throw error
  }
  // SQLite creates files with umask-derived modes; C3 requires owner-only.
  // Refused (for example schema 9) stores are never chmod-ed either.
  try { chmodSync(path, OWNED_FILE_MODE) } catch { /* existing file may already be correct */ }
  db.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`)

  const storedNode = db.prepare('SELECT value FROM meta WHERE key = ?').get('node_id') as { value?: string } | undefined
  if (storedNode?.value !== undefined) {
    if (storedNode.value !== nodeId) {
      try { db.close() } catch { /* already failing */ }
      throw workbenchError('identity_drift', `store Node identity ${storedNode.value} does not match ownership manifest ${nodeId}`, 'restore the ownership manifest and store from the same backup; do not delete either file')
    }
  } else {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('node_id', nodeId)
  }
  const storedSchema = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  if (storedSchema?.value !== undefined && Number(storedSchema.value) !== STORE_SCHEMA_VERSION) {
    try { db.close() } catch { /* already failing */ }
    throw workbenchError('unsupported_schema', `store metadata schema ${storedSchema.value} is not supported`, 'migration requires an exclusive owner and a verified backup')
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(STORE_SCHEMA_VERSION))

  const currentEpoch = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get('runner_epoch') as { value?: string } | undefined)?.value ?? '0')
  if (!Number.isSafeInteger(currentEpoch + 1)) {
    db.close()
    throw workbenchError('schema_drift', 'runner epoch exhausted', 'preserve history; do not reset the epoch')
  }
  let epoch = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    epoch = currentEpoch + 1
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('runner_epoch', String(epoch))
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already failing */ }
    try { db.close() } catch { /* already failing */ }
    sqliteFailure(path, error)
  }

  let transactionDepth = 0
  let savepointSequence = 0
  function transaction<T>(fn: () => T): T {
    const savepoint = transactionDepth === 0 ? null : `command_${++savepointSequence}`
    db.exec(savepoint === null ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    transactionDepth++
    try {
      const result = fn()
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('store transactions must be synchronous')
      db.exec(savepoint === null ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      try {
        if (savepoint === null) db.exec('ROLLBACK')
        else db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`)
      } catch { /* preserve the original failure */ }
      throw error
    } finally { transactionDepth-- }
  }

  const asFenceConflict = (error: unknown, message: string, recovery: string): never => {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) throw workbenchError('fence_conflict', message, recovery)
    throw error
  }
  const assignmentOrFail = (assignmentId: string): AssignmentRecord => {
    const row = db.prepare('SELECT * FROM assignments WHERE assignment_id = ?').get(assignmentId) as Record<string, unknown> | undefined
    if (!row) throw workbenchError('missing_resource', `assignment ${assignmentId} does not exist`, 'select the Assignment from committed authority state; never insert lifecycle rows by hand')
    return assignmentRow(row)
  }
  const attemptOrFail = (attemptId: string): AttemptRecord => {
    const row = db.prepare('SELECT a.*, s.project_id, s.goal_id, s.agent_run_id, s.attempt_count FROM attempts a JOIN assignments s USING (assignment_id) WHERE a.attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
    if (!row) throw workbenchError('missing_resource', `attempt ${attemptId} does not exist`, 'select the Attempt from committed authority state; never insert lifecycle rows by hand')
    return attemptRow(row, { projectId: String(row.project_id), goalId: String(row.goal_id), agentRunId: String(row.agent_run_id), attemptCount: Number(row.attempt_count) })
  }
  /** Low-level durable insert shared by `putCandidate` and the fenced `submitCandidate`. */
  const insertCandidate = (record: CandidateRecord): void => {
    validateCandidate(record)
    if (record.state !== 'pending') lifecycleInvalid('a new Candidate must be pending')
    const attempt = attemptOrFail(record.attemptId)
    if (attempt.assignmentId !== record.assignmentId || record.agentRunId !== attempt.runBinding.runId) {
      throw workbenchError('identity_drift', 'Candidate does not match its frozen Attempt and Run', 'submit a Candidate only from the exact admitted Attempt')
    }
    try {
      db.prepare('INSERT INTO candidates (candidate_id, assignment_id, attempt_id, agent_run_id, control_epoch, summary, artifact_refs_json, digest, pre_manifest_digest, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.candidateId, record.assignmentId, record.attemptId, record.agentRunId, record.controlEpoch, record.summary, canonicalJson(record.artifactRefs), record.digest, record.preManifestDigest, record.state, record.createdAt)
    } catch (error) {
      asFenceConflict(error, 'this Attempt already has a Candidate', 'reuse the stable stored Candidate or submit it under the next Attempt; never fork one attempt')
    }
  }

  return {
    path,
    nodeId,
    epoch,
    getMeta(key) {
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
      return row?.value ?? null
    },
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
    },
    transaction,
    putBinding(binding) {
      const frozen = db.prepare('SELECT b.* FROM bindings b JOIN binding_identities i USING (run_id) WHERE b.run_id = ?').get(binding.runId)
      if (frozen && (frozen.project_id !== binding.projectId || frozen.role !== binding.role || frozen.binding_digest !== binding.bindingDigest || frozen.predecessor_run_id !== binding.predecessorRunId)) {
        throw workbenchError('identity_drift', 'binding commitment fields are immutable', 'create a separately authorized Run; never retarget existing identity')
      }
      db.prepare(
        `INSERT INTO bindings (run_id, project_id, role, state, binding_digest, control_epoch, writer_state, predecessor_run_id, generation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           project_id = excluded.project_id, role = excluded.role, state = excluded.state,
           binding_digest = excluded.binding_digest, control_epoch = excluded.control_epoch,
           writer_state = excluded.writer_state, predecessor_run_id = excluded.predecessor_run_id,
           generation = excluded.generation, updated_at = excluded.updated_at`,
      ).run(
        binding.runId, binding.projectId, binding.role, binding.state, binding.bindingDigest,
        binding.controlEpoch, binding.writerState, binding.predecessorRunId, binding.generation, binding.updatedAt,
      )
    },
    getBinding(runId) {
      const row = db.prepare('SELECT * FROM bindings WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
      return row ? rowToBinding(row) : null
    },
    listBindings() {
      return (db.prepare('SELECT * FROM bindings ORDER BY run_id').all() as Array<Record<string, unknown>>).map(rowToBinding)
    },
    putBindingIdentity(runId, goalId, incarnation) {
      const verified = validateIncarnation(incarnation)
      const binding = db.prepare('SELECT project_id FROM bindings WHERE run_id = ?').get(runId) as { project_id: string } | undefined
      const goal = db.prepare('SELECT g.project_id, p.execution_node_id FROM goals g JOIN projects p USING (project_id) WHERE goal_id = ?').get(goalId) as { project_id: string; execution_node_id: string } | undefined
      if (!binding || !goal || binding.project_id !== goal.project_id || verified.executionNodeId !== nodeId || goal.execution_node_id !== nodeId) {
        throw workbenchError('identity_drift', 'binding Goal/Project/Node identity mismatch', 'confirm the exact Goal and bridge incarnation')
      }
      const key = incarnationKey(verified)
      const existing = db.prepare('SELECT goal_id, incarnation_key FROM binding_identities WHERE run_id = ?').get(runId) as { goal_id: string; incarnation_key: string } | undefined
      if (existing) {
        if (existing.goal_id !== goalId || existing.incarnation_key !== key) throw workbenchError('identity_drift', 'binding identity is immutable', 'create a fresh authorized binding; never retarget a Run')
        return
      }
      db.prepare('INSERT INTO binding_identities VALUES (?, ?, ?, ?)').run(runId, goalId, JSON.stringify(verified), key)
    },
    getBindingIdentity(runId) {
      const row = db.prepare('SELECT * FROM binding_identities WHERE run_id = ?').get(runId) as { goal_id: string; incarnation_json: string; incarnation_key: string } | undefined
      if (!row) return null
      const incarnation = validateIncarnation(JSON.parse(row.incarnation_json))
      if (incarnationKey(incarnation) !== row.incarnation_key) throw workbenchError('identity_drift', 'incarnation digest changed', 'preserve the original binding')
      return { runId, goalId: row.goal_id, incarnation, incarnationKey: row.incarnation_key }
    },
    commitMembership(runId) {
      const row = db.prepare('SELECT i.goal_id, b.role, b.state FROM binding_identities i JOIN bindings b USING (run_id) WHERE run_id = ?').get(runId)
      if (!row || row.state !== 'committed' || typeof row.role !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.role)) throw workbenchError('invalid_input', 'membership requires an exact committed binding and Role', 'proposals and acknowledgements are not members')
      // The caller commits binding state, this insertion and the outcome in
      // one store transaction. SQL uniqueness is the final occupancy arbiter.
      db.prepare('INSERT INTO role_memberships VALUES (?, ?, ?)').run(String(row.goal_id), row.role, runId)
    },
    putProposal(record) {
      validatePendingProposal(record)
      if (record.state !== 'proposed') throw workbenchError('invalid_input', 'new proposal must be uncommitted', 'only an operator authorizes the frozen proposal')
      db.prepare('INSERT INTO adoption_proposals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.proposalId, record.runId, record.projectId, record.goalId, record.role, record.observedSessionId, JSON.stringify(record.incarnation), record.connectionId, record.challenge, record.nonce, record.digest, record.generation, record.predecessorRunId, record.expiresAt, record.ackDeadline, record.state, record.deliveryJson, record.deliveryState)
    },
    getProposal(proposalId) {
      const row = db.prepare('SELECT * FROM adoption_proposals WHERE proposal_id = ?').get(proposalId)
      return row ? pendingRow(row) : null
    },
    listProposals() { return db.prepare('SELECT * FROM adoption_proposals ORDER BY proposal_id').all().map(pendingRow) },
    updateProposal(record) {
      validatePendingProposal(record)
      const previous = db.prepare('SELECT * FROM adoption_proposals WHERE proposal_id = ?').get(record.proposalId)
      if (!previous) throw workbenchError('missing_resource', 'pending proposal not found', 'request a fresh Adoption')
      const frozen = pendingRow(previous)
      if (record.digest !== frozen.digest || record.state !== 'authorized' || (frozen.state !== 'proposed' && frozen.state !== 'authorized')
          || (frozen.state === 'authorized' && (record.ackDeadline !== frozen.ackDeadline || record.deliveryJson !== frozen.deliveryJson))) throw workbenchError('identity_drift', 'pending proposal immutable fields changed', 'retain original authorization')
      db.prepare('UPDATE adoption_proposals SET ack_deadline = ?, state = ?, delivery_json = ?, delivery_state = ? WHERE proposal_id = ?')
        .run(record.ackDeadline, record.state, record.deliveryJson, record.deliveryState, record.proposalId)
    },
    deleteProposal(proposalId) { db.prepare('DELETE FROM adoption_proposals WHERE proposal_id = ?').run(proposalId) },
    discardProposalsOnRestart() { db.prepare('DELETE FROM adoption_proposals').run() },
    releaseMembership(runId) { db.prepare('DELETE FROM role_memberships WHERE run_id = ?').run(runId) },
    listMemberships(goalId) {
      return db.prepare('SELECT * FROM role_memberships WHERE goal_id = ? ORDER BY role').all(goalId).map(row => ({ goalId: String(row.goal_id), role: String(row.role), runId: String(row.run_id) }))
    },
    purgeRetiredHistory(runId, now) {
      transaction(() => {
        const row = db.prepare('SELECT * FROM bindings WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined
        if (!row) return
        if (!['retired', 'purged'].includes(String(row.state))) throw workbenchError('invalid_input', 'purge requires retired history', 'retire the exact Run first')
        if (db.prepare('SELECT 1 FROM bindings WHERE predecessor_run_id = ?').get(runId)) throw workbenchError('invalid_input', 'purge requires a leaf', 'purge successors first')
        if (row.writer_state !== 'none' && row.project_id !== null) {
          db.prepare('INSERT OR IGNORE INTO uncertain_effects VALUES (?, ?, ?)').run(runId, String(row.project_id), now)
        }
        db.prepare("DELETE FROM events WHERE run_id = ? AND (kind LIKE 'adoption_%' OR kind IN ('control_taken', 'retire', 'purge'))").run(runId)
        db.prepare('DELETE FROM bindings WHERE run_id = ?').run(runId)
      })
    },
    hasUncertainEffects(projectId) {
      return !!db.prepare('SELECT 1 FROM uncertain_effects WHERE project_id = ? LIMIT 1').get(projectId)
    },
    setBindingState(runId, state, updatedAt) {
      const info = db.prepare('UPDATE bindings SET state = ?, updated_at = ? WHERE run_id = ?').run(state, updatedAt, runId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `binding ${runId} does not exist`, 'recreate the binding through explicit Adoption; do not insert rows by hand')
      }
    },
    setBindingControlEpoch(runId, controlEpoch, updatedAt) {
      const info = db.prepare('UPDATE bindings SET control_epoch = ?, updated_at = ? WHERE run_id = ?').run(controlEpoch, updatedAt, runId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `binding ${runId} does not exist`, 'recreate the binding through explicit Adoption; do not insert rows by hand')
      }
    },
    markUncertainInFlight(updatedAt) {
      const rows = db.prepare('SELECT run_id FROM bindings WHERE state IN (?, ?, ?)').all(...UNCERTAIN_BINDING_STATES) as Array<{ run_id: string }>
      for (const row of rows) {
        db.prepare("UPDATE bindings SET writer_state = 'uncertain', updated_at = ? WHERE run_id = ?").run(updatedAt, row.run_id)
      }
      return rows.map(row => row.run_id)
    },
    putProject(project) {
      db.prepare(
        `INSERT INTO projects (project_id, execution_node_id, canonical_path, git_common_dir, head_oid, dirty, context_digest, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           execution_node_id = excluded.execution_node_id, canonical_path = excluded.canonical_path,
           git_common_dir = excluded.git_common_dir, head_oid = excluded.head_oid, dirty = excluded.dirty,
           context_digest = excluded.context_digest, revision = excluded.revision, created_at = excluded.created_at`,
      ).run(
        project.projectId, project.executionNodeId, project.canonicalPath, project.gitCommonDir,
        project.headOid, project.dirty ? 1 : 0, project.contextDigest, project.revision, project.createdAt,
      )
    },
    getProject(projectId) {
      const row = db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined
      return row ? rowToProject(row) : null
    },
    listProjects() {
      return (db.prepare('SELECT * FROM projects ORDER BY created_at, project_id').all() as Array<Record<string, unknown>>).map(rowToProject)
    },
    insertGoal(goal) {
      db.prepare('INSERT INTO goals (goal_id, project_id, goal_text, state, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(goal.goalId, goal.projectId, goal.goalText, goal.state, goal.outcome, goal.createdAt)
    },
    setGoalState(goalId, state, outcome) {
      const info = db.prepare('UPDATE goals SET state = ?, outcome = ? WHERE goal_id = ?').run(state, outcome, goalId)
      if (info.changes === 0) {
        throw workbenchError('missing_resource', `goal ${goalId} does not exist`, 'select the Goal from the committed projection; do not insert rows by hand')
      }
    },
    putCheck(check) {
      readResolvedCheck(check)
      db.prepare(
        `INSERT INTO check_definitions (project_id, check_id, version, digest, canonical_json, name, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(check.projectId, check.checkId, check.version, check.digest, check.canonicalJson, check.name, check.mode, check.createdAt)
    },
    getCheck(projectId, checkId, version) {
      const row = db.prepare('SELECT * FROM check_definitions WHERE project_id = ? AND check_id = ? AND version = ?')
        .get(projectId, checkId, version) as Record<string, unknown> | undefined
      return row ? rowToCheck(row) : null
    },
    latestCheck(projectId, checkId) {
      const row = db.prepare('SELECT * FROM check_definitions WHERE project_id = ? AND check_id = ? ORDER BY version DESC LIMIT 1')
        .get(projectId, checkId) as Record<string, unknown> | undefined
      return row ? rowToCheck(row) : null
    },
    listChecks(projectId) {
      return (db.prepare('SELECT * FROM check_definitions WHERE project_id = ? ORDER BY check_id, version').all(projectId) as Array<Record<string, unknown>>).map(rowToCheck)
    },
    appendEvent(event) {
      db.prepare('INSERT INTO events (event_id, cursor, base_revision, revision, kind, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(event.eventId, event.cursor, event.baseRevision, event.revision, event.kind, event.createdAt, event.runId ?? null)
    },
    listEvents() {
      return (db.prepare('SELECT * FROM events ORDER BY cursor').all() as Array<Record<string, unknown>>).map(rowToEvent)
    },
    maxCursor() {
      const row = db.prepare('SELECT MAX(cursor) AS cursor FROM events').get() as { cursor?: number | null } | undefined
      const retained = db.prepare("SELECT value FROM meta WHERE key = 'event_cursor'").get() as { value: string } | undefined
      return Math.max(row?.cursor === null || row?.cursor === undefined ? -1 : Number(row.cursor), retained ? Number(retained.value) : -1)
    },
    getGoal(goalId) {
      const row = db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined
      return row ? rowToGoal(row) : null
    },
    listGoals(projectId) {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM goals ORDER BY created_at, goal_id').all()
        : db.prepare('SELECT * FROM goals WHERE project_id = ? ORDER BY created_at, goal_id').all(projectId)
      return (rows as Array<Record<string, unknown>>).map(rowToGoal)
    },
    putDelivery(delivery) {
      validateStoredDelivery(delivery)
      if (delivery.state !== 'queued' || delivery.reasonCode !== null) throw workbenchError('invalid_input', 'new delivery must be queued', 'never invent a completed send')
      db.prepare('INSERT INTO bridge_deliveries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(delivery.frameId, delivery.runId, delivery.kind, delivery.frameJson, delivery.connectionId, delivery.deadline, delivery.state, delivery.reasonCode, delivery.createdAt)
    },
    listDeliveries(runId) {
      const rows = runId === undefined ? db.prepare('SELECT * FROM bridge_deliveries ORDER BY created_at, frame_id').all()
        : db.prepare('SELECT * FROM bridge_deliveries WHERE run_id = ? ORDER BY created_at, frame_id').all(runId)
      return rows.map(rowToDelivery)
    },
    transitionDelivery(frameId, from, to, reasonCode) {
      if (!(from === 'queued' && ['attempting', 'not_sent'].includes(to)) && !(from === 'attempting' && ['written', 'unknown'].includes(to))) throw workbenchError('invalid_input', 'delivery transitions never reset an attempt', 'unknown delivery requires explicit reconciliation, not retry')
      if (![null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted'].includes(reasonCode)) throw workbenchError('invalid_input', 'invalid delivery reason', 'use a bounded delivery disposition')
      const current = db.prepare('SELECT * FROM bridge_deliveries WHERE frame_id = ?').get(frameId)
      if (!current || current.state !== from) return false
      validateStoredDelivery({ ...rowToDelivery(current), state: to, reasonCode })
      return Number(db.prepare('UPDATE bridge_deliveries SET state = ?, reason_code = ? WHERE frame_id = ? AND state = ?').run(to, reasonCode, frameId, from).changes) === 1
    },
    putAssignment(record) {
      validateAssignment(record)
      const goal = db.prepare('SELECT project_id FROM goals WHERE goal_id = ?').get(record.goalId) as { project_id: string } | undefined
      const project = db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(record.projectId)
      if (!goal || !project || goal.project_id !== record.projectId) {
        throw workbenchError('identity_drift', 'Assignment requires an existing Project and its committed Goal', 'confirm the exact Goal before admission; never retarget Project identity')
      }
      try {
        db.prepare(
          `INSERT INTO assignments (assignment_id, project_id, goal_id, agent_run_id, binding_digest, goal_text, task_text, write_authority, state, limits_json, attempt_count, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(record.assignmentId, record.projectId, record.goalId, record.agentRunId, record.bindingDigest, record.goalText, record.taskText,
          record.writeAuthority ? 1 : 0, record.state, canonicalJson(record.limits), record.attemptCount, record.revision, record.createdAt, record.updatedAt)
      } catch (error) {
        asFenceConflict(error, 'an active Assignment already occupies this Project', 'finish, stop or reconcile the current Assignment before confirming another')
      }
    },
    getAssignment(assignmentId) {
      const row = db.prepare('SELECT * FROM assignments WHERE assignment_id = ?').get(assignmentId) as Record<string, unknown> | undefined
      return row ? assignmentRow(row) : null
    },
    listAssignments(projectId) {
      const rows = projectId === undefined
        ? db.prepare('SELECT * FROM assignments ORDER BY created_at, assignment_id').all()
        : db.prepare('SELECT * FROM assignments WHERE project_id = ? ORDER BY created_at, assignment_id').all(projectId)
      return (rows as Array<Record<string, unknown>>).map(assignmentRow)
    },
    activeAssignment(projectId) {
      const row = db.prepare("SELECT * FROM assignments WHERE project_id = ? AND state NOT IN ('accepted', 'stopped', 'failed') ORDER BY created_at DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined
      return row ? assignmentRow(row) : null
    },
    transitionAssignment(assignmentId, from, to, revision, updatedAt) {
      assertTransition(ASSIGNMENT_STATES, ASSIGNMENT_TRANSITIONS, from, to, 'Assignment')
      if (!isSafeCount(revision) || !isSafeCount(updatedAt)) lifecycleInvalid('Assignment transition counters are invalid')
      const info = db.prepare('UPDATE assignments SET state = ?, revision = ?, updated_at = ? WHERE assignment_id = ? AND state = ?').run(to, revision, updatedAt, assignmentId, from)
      return Number(info.changes) === 1
    },
    putAttempt(record) {
      const assignment = assignmentOrFail(record.assignmentId)
      if (record.state !== 'admitted') lifecycleInvalid('a new Attempt must start admitted')
      if (record.ordinal !== assignment.attemptCount + 1) lifecycleInvalid('Attempt ordinal must be the next sequential ordinal')
      validateAttempt(record, { projectId: assignment.projectId, goalId: assignment.goalId, agentRunId: assignment.agentRunId, attemptCount: assignment.attemptCount })
      try {
        db.prepare(
          `INSERT INTO attempts (attempt_id, assignment_id, ordinal, state, run_binding_json, run_binding_digest, gate_id, gate_version, gate_digest, gate_json, context_json, limits_json, writer_epoch, control_epoch, delivery_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(record.attemptId, record.assignmentId, record.ordinal, record.state, canonicalJson(record.runBinding), sha256(canonicalJson(record.runBinding)),
          record.gate.checkId, record.gate.version, record.gate.digest, record.gate.canonicalJson, canonicalJson(record.context), canonicalJson(record.limits),
          record.writerEpoch, record.controlEpoch, record.deliveryId, record.createdAt, record.updatedAt)
      } catch (error) {
        asFenceConflict(error, 'attempt ordinal already exists for this Assignment', 'use the next ordinal; never reuse an attempt identity')
      }
      db.prepare('UPDATE assignments SET attempt_count = ?, updated_at = ? WHERE assignment_id = ?').run(record.ordinal, record.updatedAt, record.assignmentId)
    },
    getAttempt(attemptId) {
      const row = db.prepare('SELECT a.*, s.project_id, s.goal_id, s.agent_run_id, s.attempt_count FROM attempts a JOIN assignments s USING (assignment_id) WHERE a.attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      return row ? attemptRow(row, { projectId: String(row.project_id), goalId: String(row.goal_id), agentRunId: String(row.agent_run_id), attemptCount: Number(row.attempt_count) }) : null
    },
    listAttempts(assignmentId) {
      const rows = assignmentId === undefined
        ? db.prepare('SELECT a.*, s.project_id, s.goal_id, s.agent_run_id, s.attempt_count FROM attempts a JOIN assignments s USING (assignment_id) ORDER BY a.created_at, a.attempt_id').all()
        : db.prepare('SELECT a.*, s.project_id, s.goal_id, s.agent_run_id, s.attempt_count FROM attempts a JOIN assignments s USING (assignment_id) WHERE a.assignment_id = ? ORDER BY a.ordinal').all(assignmentId)
      return (rows as Array<Record<string, unknown>>).map(row => attemptRow(row, { projectId: String(row.project_id), goalId: String(row.goal_id), agentRunId: String(row.agent_run_id), attemptCount: Number(row.attempt_count) }))
    },
    transitionAttempt(attemptId, from, to, updatedAt) {
      assertTransition(ATTEMPT_STATES, ATTEMPT_TRANSITIONS, from, to, 'Attempt')
      if (!isSafeCount(updatedAt)) lifecycleInvalid('Attempt transition timestamp is invalid')
      const info = db.prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ? AND state = ?').run(to, updatedAt, attemptId, from)
      return Number(info.changes) === 1
    },
    acquireWriter(record) {
      if (!isLifecycleId(record.projectId) || !Number.isSafeInteger(record.epoch) || record.epoch < 1 || !isSafeCount(record.updatedAt)) lifecycleInvalid('writer lease input is invalid')
      if (record.assignmentId !== null) assignmentOrFail(record.assignmentId)
      if (record.attemptId !== null) attemptOrFail(record.attemptId)
      const existing = db.prepare('SELECT * FROM assignment_writers WHERE project_id = ?').get(record.projectId) as Record<string, unknown> | undefined
      const current = existing ? writerRow(existing) : null
      if (current && current.state !== 'none') {
        throw workbenchError('fence_conflict', `Project ${record.projectId} already has a ${current.state} writer lease`, 'release the exact writer or reconcile its uncertainty before admitting another Assignment')
      }
      if (current && record.epoch <= current.epoch) {
        throw workbenchError('fence_conflict', `writer epoch ${record.epoch} does not advance ${current.epoch}`, 'always increase the per-Project writer epoch; never reuse an epoch')
      }
      if (current) {
        db.prepare("UPDATE assignment_writers SET assignment_id = ?, attempt_id = ?, epoch = ?, state = 'held', updated_at = ? WHERE project_id = ?")
          .run(record.assignmentId, record.attemptId, record.epoch, record.updatedAt, record.projectId)
      } else {
        db.prepare("INSERT INTO assignment_writers (project_id, assignment_id, attempt_id, epoch, state, updated_at) VALUES (?, ?, ?, ?, 'held', ?)")
          .run(record.projectId, record.assignmentId, record.attemptId, record.epoch, record.updatedAt)
      }
      return writerRow(db.prepare('SELECT * FROM assignment_writers WHERE project_id = ?').get(record.projectId) as Record<string, unknown>)
    },
    releaseWriter(projectId, updatedAt) {
      if (!isLifecycleId(projectId) || !isSafeCount(updatedAt)) lifecycleInvalid('writer release input is invalid')
      const existing = db.prepare('SELECT * FROM assignment_writers WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined
      if (!existing) return
      const current = writerRow(existing)
      if (current.state === 'none') return
      if (current.state === 'uncertain') {
        throw workbenchError('fence_conflict', 'an uncertain writer lease cannot be released', 'reconcile unknown effects and record explicit clearance before releasing the writer')
      }
      db.prepare("UPDATE assignment_writers SET state = 'none', updated_at = ? WHERE project_id = ? AND state = 'held'").run(updatedAt, projectId)
    },
    markWriterUncertain(projectId, updatedAt) {
      if (!isLifecycleId(projectId) || !isSafeCount(updatedAt)) lifecycleInvalid('writer uncertainty input is invalid')
      const info = db.prepare("UPDATE assignment_writers SET state = 'uncertain', updated_at = ? WHERE project_id = ? AND state = 'held'").run(updatedAt, projectId)
      return Number(info.changes) === 1
    },
    getWriter(projectId) {
      const row = db.prepare('SELECT * FROM assignment_writers WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined
      return row ? writerRow(row) : null
    },
    listWriters() {
      return (db.prepare('SELECT * FROM assignment_writers ORDER BY project_id').all() as Array<Record<string, unknown>>).map(writerRow)
    },
    putAssignmentDelivery(delivery) {
      validateAssignmentDelivery(delivery)
      if (delivery.state !== 'queued' || delivery.reasonCode !== null) lifecycleInvalid('a new Assignment delivery must be queued with no reason')
      const attempt = attemptOrFail(delivery.attemptId)
      if (attempt.assignmentId !== delivery.assignmentId || attempt.deliveryId !== null && attempt.deliveryId !== delivery.deliveryId) {
        throw workbenchError('identity_drift', 'Assignment delivery does not match its frozen Attempt', 'create one delivery per Attempt from the confirmed admission record')
      }
      try {
        db.prepare('INSERT INTO assignment_outbox (delivery_id, assignment_id, attempt_id, run_id, frame_json, payload_digest, state, reason_code, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(delivery.deliveryId, delivery.assignmentId, delivery.attemptId, delivery.runId, delivery.frameJson, delivery.payloadDigest, delivery.state, delivery.reasonCode, delivery.deadline, delivery.createdAt)
      } catch (error) {
        asFenceConflict(error, 'this Attempt already has a delivery identity', 'reuse the exact stored delivery; never create a second delivery ID while uncertain')
      }
      db.prepare('UPDATE attempts SET delivery_id = ?, updated_at = ? WHERE attempt_id = ?').run(delivery.deliveryId, delivery.createdAt, delivery.attemptId)
    },
    getAssignmentDelivery(attemptId) {
      const row = db.prepare('SELECT * FROM assignment_outbox WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      return row ? assignmentDeliveryRow(row) : null
    },
    listAssignmentDeliveries(assignmentId) {
      const rows = assignmentId === undefined
        ? db.prepare('SELECT * FROM assignment_outbox ORDER BY created_at, delivery_id').all()
        : db.prepare('SELECT * FROM assignment_outbox WHERE assignment_id = ? ORDER BY created_at, delivery_id').all(assignmentId)
      return (rows as Array<Record<string, unknown>>).map(assignmentDeliveryRow)
    },
    transitionAssignmentDelivery(attemptId, from, to, reasonCode) {
      // Forward-only: an Attempt never resets to queued, and a terminal send
      // refusal is never silently retried. `unknown` may resolve only through an
      // explicit receipt reconciliation to written or not_sent.
      const allowed = (from === 'queued' && (to === 'attempting' || to === 'not_sent'))
        || (from === 'attempting' && (to === 'written' || to === 'unknown' || to === 'not_sent'))
        || (from === 'unknown' && (to === 'written' || to === 'not_sent'))
      if (!allowed) lifecycleInvalid('delivery transitions never reset or blindly resend an attempt')
      if (!DELIVERY_REASONS.includes(reasonCode)) lifecycleInvalid('invalid Assignment delivery reason')
      const current = db.prepare('SELECT * FROM assignment_outbox WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      if (!current || current.state !== from) return false
      validateAssignmentDelivery({ ...assignmentDeliveryRow(current), state: to, reasonCode })
      return Number(db.prepare('UPDATE assignment_outbox SET state = ?, reason_code = ? WHERE attempt_id = ? AND state = ?').run(to, reasonCode, attemptId, from).changes) === 1
    },
    putCandidate(record) {
      insertCandidate(record)
    },
    submitCandidate(input) {
      return transaction(() => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'candidateId,createdAt,submission') {
          lifecycleInvalid('Candidate submission facts are not the declared shape')
        }
        const submission = input.submission
        if (!submission || typeof submission !== 'object' || Array.isArray(submission)) lifecycleInvalid('Candidate submission is invalid')
        if (!isLifecycleId(input.candidateId)) lifecycleInvalid('Candidate identifier is invalid')
        if (!isSafeCount(input.createdAt)) lifecycleInvalid('Candidate timestamp is invalid')
        if (!isLifecycleId(submission.assignmentId) || !isLifecycleId(submission.attemptId) || !isLifecycleId(submission.agentRunId) || !isSafeCount(submission.controlEpoch)) {
          lifecycleInvalid('Candidate submission identity is invalid')
        }
        const attempt = attemptOrFail(submission.attemptId)
        // Exact current Run/Attempt/control-epoch fencing. Every mismatch is
        // refused before any row is written, so a retired or stale identity
        // can never mutate the Candidate table.
        if (attempt.assignmentId !== submission.assignmentId) {
          throw workbenchError('identity_drift', 'Candidate names a different Assignment than its Attempt', 'submit only from the exact admitted Attempt')
        }
        if (attempt.runBinding.runId !== submission.agentRunId) {
          throw workbenchError('identity_drift', 'Candidate names a different Run than its Attempt', 'submit only from the exact admitted Run')
        }
        if (attempt.controlEpoch !== submission.controlEpoch) {
          throw workbenchError('identity_drift', `Candidate control epoch ${submission.controlEpoch} is stale for this Attempt`, 'resubmit under the current control epoch; a retired epoch never writes')
        }
        const binding = db.prepare('SELECT state, control_epoch FROM bindings WHERE run_id = ?').get(submission.agentRunId) as { state?: string; control_epoch?: number } | undefined
        if (!binding || binding.state === 'retired' || binding.state === 'purged') {
          throw workbenchError('identity_drift', 'Candidate Run is retired or unknown', 'submit only from a live committed Run')
        }
        // Takeover and reconciliation advance the Run control epoch without
        // rewriting the frozen Attempt. A late Candidate from the superseded
        // epoch is stale evidence and must never write.
        if (binding.control_epoch !== attempt.controlEpoch) {
          throw workbenchError('identity_drift', `Candidate control epoch ${attempt.controlEpoch} is no longer current for this Run`, 'takeover or reconciliation advanced the control epoch; a stale Candidate never writes')
        }
        const savedIdentity = db.prepare('SELECT incarnation_key FROM binding_identities WHERE run_id = ?').get(submission.agentRunId) as { incarnation_key?: string } | undefined
        const attemptIncarnation = {
          executionNodeId: attempt.runBinding.executionNodeId, processInstanceId: attempt.runBinding.processInstanceId,
          piSessionId: attempt.runBinding.piSessionId, extensionInstanceId: attempt.runBinding.extensionInstanceId,
        }
        if (!savedIdentity || savedIdentity.incarnation_key !== incarnationKey(attemptIncarnation)) {
          throw workbenchError('identity_drift', 'Candidate Run incarnation does not match its Attempt', 'submit only from the exact incarnation that received the Attempt')
        }
        const assignment = assignmentOrFail(submission.assignmentId)
        if (assignment.state === 'accepted' || assignment.state === 'stopped' || assignment.state === 'failed') {
          throw workbenchError('identity_drift', 'Candidate Assignment is already terminal', 'submit before the Assignment reaches a terminal state')
        }
        const digest = candidateDigest(submission)
        const existingRow = db.prepare('SELECT * FROM candidates WHERE attempt_id = ?').get(submission.attemptId) as Record<string, unknown> | undefined
        if (existingRow) {
          const existing = candidateRow(existingRow)
          if (existing.digest === digest) return { candidate: existing, idempotent: true }
          throw workbenchError('identity_drift', 'this Attempt already has a different Candidate', 'reuse the exact stored Candidate or start the next Attempt; never rewrite a candidate')
        }
        const record: CandidateRecord = {
          candidateId: input.candidateId, assignmentId: submission.assignmentId, attemptId: submission.attemptId,
          agentRunId: submission.agentRunId, controlEpoch: submission.controlEpoch, summary: submission.summary,
          artifactRefs: submission.artifactRefs.map(ref => ({ path: ref.path, digest: ref.digest, length: ref.length })),
          digest, preManifestDigest: attempt.context.manifestDigest, state: 'pending', createdAt: input.createdAt,
        }
        insertCandidate(record)
        return { candidate: record, idempotent: false }
      })
    },
    getCandidate(candidateId) {
      const row = db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(candidateId) as Record<string, unknown> | undefined
      return row ? candidateRow(row) : null
    },
    getCandidateByAttempt(attemptId) {
      const row = db.prepare('SELECT * FROM candidates WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      return row ? candidateRow(row) : null
    },
    listCandidates(assignmentId) {
      const rows = assignmentId === undefined
        ? db.prepare('SELECT * FROM candidates ORDER BY created_at, candidate_id').all()
        : db.prepare('SELECT * FROM candidates WHERE assignment_id = ? ORDER BY created_at, candidate_id').all(assignmentId)
      return (rows as Array<Record<string, unknown>>).map(candidateRow)
    },
    setCandidateState(candidateId, state) {
      if (!CANDIDATE_STATES.includes(state)) lifecycleInvalid('unknown Candidate state')
      return Number(db.prepare('UPDATE candidates SET state = ? WHERE candidate_id = ?').run(state, candidateId).changes) === 1
    },
    putGateResult(record) {
      validateGateResult(record)
      const attempt = attemptOrFail(record.attemptId)
      const candidate = db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(record.candidateId) as Record<string, unknown> | undefined
      if (attempt.assignmentId !== record.assignmentId || attempt.gate.digest !== record.gateDigest
          || !candidate || String(candidate.attempt_id) !== record.attemptId || String(candidate.assignment_id) !== record.assignmentId) {
        throw workbenchError('identity_drift', 'Gate result does not match its Attempt, Candidate, or frozen gate digest', 'record evidence only for the exact candidate and frozen gate it ran')
      }
      try {
        db.prepare('INSERT INTO gate_results (result_id, assignment_id, attempt_id, candidate_id, gate_digest, executable_digest, outcome, pre_manifest_digest, post_manifest_digest, exit_code, reason_code, evidence_json, state, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.resultId, record.assignmentId, record.attemptId, record.candidateId, record.gateDigest, record.executableDigest, record.outcome, record.preManifestDigest, record.postManifestDigest, record.exitCode, record.reasonCode, record.evidenceJson, record.state, record.revision, record.createdAt)
      } catch (error) {
        asFenceConflict(error, 'this Attempt already has a gate result', 'reuse the stored result; correction runs under the next Attempt only')
      }
    },
    getGateResult(attemptId) {
      const row = db.prepare('SELECT * FROM gate_results WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      return row ? gateResultRow(row) : null
    },
    listGateResults(assignmentId) {
      const rows = assignmentId === undefined
        ? db.prepare('SELECT * FROM gate_results ORDER BY created_at, result_id').all()
        : db.prepare('SELECT * FROM gate_results WHERE assignment_id = ? ORDER BY created_at, result_id').all(assignmentId)
      return (rows as Array<Record<string, unknown>>).map(gateResultRow)
    },
    transitionGateResult(resultId, from, to, revision) {
      if (!(from === 'provisional' && (to === 'accepted' || to === 'nonaccepting'))) lifecycleInvalid('gate result transitions only resolve a provisional result')
      if (!isSafeCount(revision)) lifecycleInvalid('gate result revision is invalid')
      return Number(db.prepare('UPDATE gate_results SET state = ?, revision = ? WHERE result_id = ? AND state = ?').run(to, revision, resultId, from).changes) === 1
    },
    resolveGateAcceptance(input) {
      if (!isSafeCount(input?.revision) || !isSafeCount(input?.updatedAt)
        || !isLifecycleDigest(input.candidateDigest) || !isLifecycleDigest(input.gateDigest) || !isLifecycleDigest(input.executableDigest)
        || !(GATE_OUTCOMES as readonly string[]).includes(input.outcome)
        || (input.postManifestDigest !== null && !isLifecycleDigest(input.postManifestDigest))
        || (input.acceptanceManifestDigest !== null && !isLifecycleDigest(input.acceptanceManifestDigest))
        || (input.acceptanceScanError !== null && (typeof input.acceptanceScanError !== 'string' || !LIFECYCLE_REASON.test(input.acceptanceScanError)))
        || (input.quiescenceReason !== null && (typeof input.quiescenceReason !== 'string' || !LIFECYCLE_REASON.test(input.quiescenceReason)))) {
        lifecycleInvalid('Gate acceptance input is invalid')
      }
      const assignment = assignmentOrFail(input.assignmentId)
      const attempt = attemptOrFail(input.attemptId)
      const candidateRowValue = db.prepare('SELECT * FROM candidates WHERE candidate_id = ?').get(input.candidateId) as Record<string, unknown> | undefined
      const resultRowValue = db.prepare('SELECT * FROM gate_results WHERE result_id = ?').get(input.resultId) as Record<string, unknown> | undefined
      if (attempt.assignmentId !== input.assignmentId || attempt.gate.digest !== input.gateDigest
        || !candidateRowValue || String(candidateRowValue.attempt_id) !== input.attemptId || String(candidateRowValue.assignment_id) !== input.assignmentId
        || !resultRowValue || String(resultRowValue.attempt_id) !== input.attemptId || String(resultRowValue.gate_digest) !== input.gateDigest) {
        throw workbenchError('identity_drift', 'Gate acceptance does not match its Attempt, Candidate, or frozen gate digest',
          'resolve only the exact provisional result recorded for this Candidate and frozen gate')
      }
      const candidateRecord = candidateRow(candidateRowValue)
      const resultRecord = gateResultRow(resultRowValue)
      const resolveResult = (state: GateResultState, reasonCode: string | null): void => {
        db.prepare('UPDATE gate_results SET state = ?, reason_code = ?, revision = ? WHERE result_id = ? AND state = ?')
          .run(state, reasonCode, input.revision, input.resultId, 'provisional')
      }
      const resolveCandidate = (state: CandidateState): void => {
        db.prepare('UPDATE candidates SET state = ? WHERE candidate_id = ? AND state = ?').run(state, input.candidateId, 'pending')
      }
      const updateAttempt = (from: AttemptState, to: AttemptState): boolean => {
        assertTransition(ATTEMPT_STATES, ATTEMPT_TRANSITIONS, from, to, 'Attempt')
        return Number(db.prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ? AND state = ?').run(to, input.updatedAt, input.attemptId, from).changes) === 1
      }
      const updateAssignment = (from: AssignmentState, to: AssignmentState): boolean => {
        assertTransition(ASSIGNMENT_STATES, ASSIGNMENT_TRANSITIONS, from, to, 'Assignment')
        return Number(db.prepare('UPDATE assignments SET state = ?, revision = ?, updated_at = ? WHERE assignment_id = ? AND state = ?').run(to, input.revision, input.updatedAt, input.assignmentId, from).changes) === 1
      }
      const settleWriter = (uncertain: boolean): void => {
        const sql = uncertain
          ? "UPDATE assignment_writers SET state = 'uncertain', updated_at = ? WHERE project_id = ? AND state = 'held'"
          : "UPDATE assignment_writers SET state = 'none', updated_at = ? WHERE project_id = ? AND state = 'held'"
        db.prepare(sql).run(input.updatedAt, assignment.projectId)
      }
      const refuse = (reasonCode: string): GateAcceptance => {
        if (!LIFECYCLE_REASON.test(reasonCode)) lifecycleInvalid('Gate refusal reason is invalid')
        resolveResult('nonaccepting', reasonCode)
        resolveCandidate('rejected')
        updateAttempt('validating', 'attention')
        updateAssignment('validating', 'attention')
        if (input.outcome === 'unknown' || reasonCode.startsWith('quiescence_')) settleWriter(true)
        return { accepted: false, reasonCode }
      }
      if (attempt.state !== 'validating' || assignment.state !== 'validating') return refuse('lifecycle_changed')
      if (candidateRecord.state !== 'pending') return refuse('candidate_state_changed')
      if (candidateRecord.digest !== input.candidateDigest) return refuse('candidate_changed')
      if (resultRecord.state !== 'provisional') return refuse('gate_result_resolved')
      if (resultRecord.executableDigest !== input.executableDigest) return refuse('gate_changed')
      const writerRowValue = db.prepare('SELECT * FROM assignment_writers WHERE project_id = ?').get(assignment.projectId) as Record<string, unknown> | undefined
      const writerRecord = writerRowValue ? writerRow(writerRowValue) : null
      if (!writerRecord || writerRecord.state !== 'held' || writerRecord.assignmentId !== input.assignmentId
        || writerRecord.attemptId !== input.attemptId || writerRecord.epoch !== attempt.writerEpoch) return refuse('writer_changed')
      const bindingRowValue = db.prepare('SELECT * FROM bindings WHERE run_id = ?').get(assignment.agentRunId) as Record<string, unknown> | undefined
      const binding = bindingRowValue ? rowToBinding(bindingRowValue) : null
      if (!binding || binding.controlEpoch !== attempt.controlEpoch) return refuse('control_epoch_changed')
      if (['retired', 'purged', 'manual_takeover', 'manual_takeover_disconnected', 'disconnected'].includes(binding.state)) return refuse('binding_changed')
      if (db.prepare('SELECT stop_id FROM assignment_stops WHERE assignment_id = ?').get(input.assignmentId)) return refuse('stop_recorded')
      if (input.acceptanceScanError !== null) return refuse(input.acceptanceScanError)
      if (input.outcome !== 'pass') return refuse(resultRecord.reasonCode ?? `gate_${input.outcome}`)
      if (input.postManifestDigest === null || input.acceptanceManifestDigest === null
        || input.postManifestDigest !== input.acceptanceManifestDigest) return refuse('checkout_changed_at_acceptance')
      if (!input.quiescenceConfirmed) return refuse(input.quiescenceReason ?? 'quiescence_unknown')
      resolveResult('accepted', null)
      resolveCandidate('validated')
      if (!updateAttempt('validating', 'accepted')) throw workbenchError('fence_conflict', 'the Attempt could not be accepted', 're-read the Assignment and reconcile before retrying acceptance')
      if (!updateAssignment('validating', 'accepted')) throw workbenchError('fence_conflict', 'the Assignment could not be accepted', 're-read the Assignment and reconcile before retrying acceptance')
      const goalInfo = db.prepare('UPDATE goals SET state = ?, outcome = ? WHERE goal_id = ?').run('recent', 'accepted', assignment.goalId)
      if (Number(goalInfo.changes) !== 1) throw workbenchError('missing_resource', `goal ${assignment.goalId} does not exist`, 'restore the Goal from committed authority state; never complete an unknown Goal')
      settleWriter(false)
      return { accepted: true, reasonCode: null }
    },
    putStop(record) {
      validateStop(record)
      assignmentOrFail(record.assignmentId)
      try {
        db.prepare('INSERT INTO assignment_stops (stop_id, assignment_id, trigger, revision, dispatch_revoked, cancellation_status, reason_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.stopId, record.assignmentId, record.trigger, record.revision, record.dispatchRevoked ? 1 : 0, record.cancellationStatus, record.reasonCode, record.createdAt, record.updatedAt)
      } catch (error) {
        asFenceConflict(error, 'this Assignment already has a durable stop', 'return the original committed stop; never rewrite stop intent')
      }
    },
    getStop(assignmentId) {
      const row = db.prepare('SELECT * FROM assignment_stops WHERE assignment_id = ?').get(assignmentId) as Record<string, unknown> | undefined
      return row ? stopRow(row) : null
    },
    listStops() {
      return (db.prepare('SELECT * FROM assignment_stops ORDER BY created_at, stop_id').all() as Array<Record<string, unknown>>).map(stopRow)
    },
    setStopCancellation(stopId, status, updatedAt) {
      if (!CANCELLATION_STATUSES.includes(status) || !isSafeCount(updatedAt)) lifecycleInvalid('stop cancellation input is invalid')
      return Number(db.prepare('UPDATE assignment_stops SET cancellation_status = ?, updated_at = ? WHERE stop_id = ?').run(status, updatedAt, stopId).changes) === 1
    },
    putHandoff(record) {
      validateHandoff(record)
      const attempt = attemptOrFail(record.attemptId)
      if (attempt.assignmentId !== record.assignmentId || attempt.runBinding.runId !== record.agentRunId) {
        throw workbenchError('identity_drift', 'Handoff does not match its frozen Attempt and Run', 'record a handoff only from the exact challenged Run and Attempt')
      }
      try {
        db.prepare('INSERT INTO handoffs (handoff_id, assignment_id, attempt_id, agent_run_id, control_epoch, claimed_state, summary, artifact_refs_json, outstanding_effects, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.handoffId, record.assignmentId, record.attemptId, record.agentRunId, record.controlEpoch, record.claimedState, record.summary, canonicalJson(record.artifactRefs), record.outstandingEffects, record.digest, record.createdAt)
      } catch (error) {
        asFenceConflict(error, 'this Attempt already has a structured handoff', 'return the original committed handoff; never rewrite claimed state')
      }
    },
    getHandoff(attemptId) {
      const row = db.prepare('SELECT * FROM handoffs WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined
      return row ? handoffRow(row) : null
    },
    listHandoffs(assignmentId) {
      const rows = assignmentId === undefined
        ? db.prepare('SELECT * FROM handoffs ORDER BY created_at, handoff_id').all()
        : db.prepare('SELECT * FROM handoffs WHERE assignment_id = ? ORDER BY created_at, handoff_id').all(assignmentId)
      return (rows as Array<Record<string, unknown>>).map(handoffRow)
    },
    putManagementOperation(operation) {
      db.prepare('INSERT INTO management_operations VALUES (?, ?, ?, ?, ?, ?, ?)').run(operation.intentId, operation.sessionId, operation.payloadHash, operation.kind, operation.runId, operation.targetJson, operation.createdAt)
    },
    listManagementOperations() {
      return db.prepare('SELECT * FROM management_operations ORDER BY created_at, intent_id').all().map(row => ({
        intentId: String(row.intent_id), sessionId: String(row.session_id), payloadHash: String(row.payload_hash), kind: String(row.kind) as ManagementOperation['kind'],
        runId: String(row.run_id), targetJson: String(row.target_json), createdAt: Number(row.created_at),
      }))
    },
    deleteManagementOperation(intentId) { db.prepare('DELETE FROM management_operations WHERE intent_id = ?').run(intentId) },
    putIntentResult(record) {
      db.prepare(
        `INSERT INTO intent_dedup (intent_id, session_id, payload_hash, status, reason_code, committed_revision, created_at, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(intent_id) DO NOTHING`,
      ).run(record.intentId, record.sessionId, record.payloadHash, record.status, record.reasonCode, record.committedRevision, record.createdAt, record.reason ?? null, record.detail ?? null)
    },
    getIntentResult(intentId) {
      const row = db.prepare('SELECT * FROM intent_dedup WHERE intent_id = ?').get(intentId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        intentId: String(row.intent_id), sessionId: String(row.session_id), payloadHash: String(row.payload_hash),
        status: String(row.status), reasonCode: row.reason_code === null ? null : String(row.reason_code),
        reason: row.reason === null ? null : String(row.reason), detail: row.detail === null ? null : String(row.detail),
        committedRevision: row.committed_revision === null ? null : Number(row.committed_revision), createdAt: Number(row.created_at),
      }
    },
    integrityCheck() {
      return String(readPragma(db, 'integrity_check') ?? 'ok')
    },
    backupTo(target) {
      const escaped = target.replace(/'/g, "''")
      db.exec(`VACUUM INTO '${escaped}'`)
    },
    close() {
      try { db.close() } catch { /* closing is best-effort on shutdown */ }
    },
  }
}

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    projectId: String(row.project_id),
    executionNodeId: String(row.execution_node_id),
    canonicalPath: String(row.canonical_path),
    gitCommonDir: String(row.git_common_dir),
    headOid: row.head_oid === null ? null : String(row.head_oid),
    dirty: Number(row.dirty) !== 0,
    contextDigest: row.context_digest === null ? null : String(row.context_digest),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
  }
}

function rowToDelivery(row: Record<string, unknown>): BridgeDelivery {
  return { frameId: String(row.frame_id), runId: String(row.run_id), kind: String(row.kind) as BridgeDelivery['kind'], frameJson: String(row.frame_json), connectionId: String(row.connection_id), deadline: Number(row.deadline), state: String(row.state) as DeliveryState, reasonCode: row.reason_code === null ? null : String(row.reason_code), createdAt: Number(row.created_at) }
}

function rowToBinding(row: Record<string, unknown>): BindingRecord {
  return {
    runId: String(row.run_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    role: row.role === null ? null : String(row.role),
    state: String(row.state) as BindingState,
    bindingDigest: row.binding_digest === null ? null : String(row.binding_digest),
    controlEpoch: Number(row.control_epoch),
    writerState: String(row.writer_state) as WriterState,
    predecessorRunId: row.predecessor_run_id === null ? null : String(row.predecessor_run_id),
    generation: row.generation === null ? null : Number(row.generation),
    updatedAt: Number(row.updated_at),
  }
}

function rowToCheck(row: Record<string, unknown>): CheckRecord {
  return {
    projectId: String(row.project_id),
    checkId: String(row.check_id),
    version: Number(row.version),
    digest: String(row.digest),
    canonicalJson: String(row.canonical_json),
    name: String(row.name),
    mode: String(row.mode),
    createdAt: Number(row.created_at),
  }
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    eventId: String(row.event_id),
    cursor: Number(row.cursor),
    baseRevision: Number(row.base_revision),
    revision: Number(row.revision),
    kind: String(row.kind),
    createdAt: Number(row.created_at),
  }
}

function rowToGoal(row: Record<string, unknown>): GoalRecord {
  return {
    goalId: String(row.goal_id), projectId: String(row.project_id), goalText: String(row.goal_text),
    state: String(row.state) as GoalRecord['state'], outcome: row.outcome === null ? null : String(row.outcome), createdAt: Number(row.created_at),
  }
}

const LIFECYCLE_ID = /^[A-Za-z0-9_-]{1,128}$/
const LIFECYCLE_DIGEST = /^[a-f0-9]{64}$/
/** Project identity is domain-separated (`repo-v1:`); attempt baseline digests are raw hex. */
const LIFECYCLE_IDENTITY = /^(?:[a-f0-9]{64}|repo-v1:[a-f0-9]{64})$/
const LIFECYCLE_CAPABILITY = /^[A-Za-z0-9_-]{32,128}$/
const LIFECYCLE_REASON = /^[a-z][a-z0-9_]{0,63}$/
const MAX_ASSIGNMENT_TEXT_BYTES = 8192
const MAX_SUMMARY_BYTES = 8192
const MAX_ARTIFACT_REFS = 16
const MAX_ARTIFACT_PATH_BYTES = 4096
const MAX_EVIDENCE_BYTES = 8192
const MAX_FRAME_BYTES = 65536
const MAX_GATE_JSON_BYTES = 1024 * 1024
const DELIVERY_REASONS: Array<string | null> = [null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted']

function lifecycleInvalid(message: string): never {
  throw workbenchError('invalid_input', `Assignment lifecycle: ${message}`, 'supply the exact frozen lifecycle record; never synthesize or repair authority state')
}
function isLifecycleId(value: unknown): value is string { return typeof value === 'string' && LIFECYCLE_ID.test(value) }
function isLifecycleDigest(value: unknown): value is string { return typeof value === 'string' && LIFECYCLE_DIGEST.test(value) }
function isLifecycleIdentity(value: unknown): value is string { return typeof value === 'string' && LIFECYCLE_IDENTITY.test(value) }
function isSafeCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value) <= max && !value.includes('\u0000')
}
function assertTransition<T extends string>(states: readonly T[], table: Record<T, T[]>, from: T, to: T, subject: string): void {
  if (!states.includes(from) || !states.includes(to)) lifecycleInvalid(`unknown ${subject} state`)
  if (from === to || !table[from].includes(to)) lifecycleInvalid(`illegal ${subject} transition ${from} -> ${to}`)
}
function parseJsonValue(json: unknown, what: string, maxBytes: number): unknown {
  if (typeof json !== 'string' || json.length === 0 || Buffer.byteLength(json) > maxBytes) lifecycleInvalid(`${what} is not a bounded JSON string`)
  try { return JSON.parse(json) } catch { return lifecycleInvalid(`${what} is not valid JSON`) }
}
function parseJsonObject(json: unknown, what: string, maxBytes: number): Record<string, unknown> {
  const value = parseJsonValue(json, what, maxBytes)
  if (!value || typeof value !== 'object' || Array.isArray(value)) lifecycleInvalid(`${what} is not a JSON object`)
  return value as Record<string, unknown>
}
function parseLimits(json: unknown): AssignmentLimits { return validateLimits(parseJsonValue(json, 'Assignment limits', MAX_EVIDENCE_BYTES)) }

function validateLimits(value: unknown): AssignmentLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) lifecycleInvalid('limits are invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'elapsedMs,maxCorrections') lifecycleInvalid('limits fields are not the declared shape')
  if (!isSafeCount(record.maxCorrections) || !isSafeCount(record.elapsedMs) || record.elapsedMs === 0) lifecycleInvalid('limits must be non-negative with a positive elapsedMs')
  return { maxCorrections: record.maxCorrections, elapsedMs: record.elapsedMs }
}

function validateAssignment(record: AssignmentRecord): AssignmentRecord {
  if (Object.keys(record).sort().join(',') !== 'agentRunId,assignmentId,attemptCount,bindingDigest,createdAt,goalId,goalText,limits,projectId,revision,state,taskText,updatedAt,writeAuthority') lifecycleInvalid('Assignment fields are not the declared shape')
  if (!isLifecycleId(record.assignmentId) || !isLifecycleId(record.projectId) || !isLifecycleId(record.goalId) || !isLifecycleId(record.agentRunId)) lifecycleInvalid('Assignment identifiers are invalid')
  if (!isLifecycleDigest(record.bindingDigest)) lifecycleInvalid('Assignment binding digest is invalid')
  if (!isBoundedText(record.goalText, MAX_ASSIGNMENT_TEXT_BYTES) || !isBoundedText(record.taskText, MAX_ASSIGNMENT_TEXT_BYTES)) lifecycleInvalid('Assignment text is empty or exceeds 8192 bytes')
  if (typeof record.writeAuthority !== 'boolean') lifecycleInvalid('Assignment writeAuthority must be boolean')
  if (!(ASSIGNMENT_STATES as readonly string[]).includes(record.state)) lifecycleInvalid('Assignment state is unknown')
  validateLimits(record.limits)
  if (!isSafeCount(record.attemptCount) || !isSafeCount(record.revision) || !isSafeCount(record.createdAt) || !isSafeCount(record.updatedAt)) lifecycleInvalid('Assignment counters are invalid')
  return record
}

function validateRunBinding(value: unknown): AssignmentRunBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) lifecycleInvalid('Attempt run binding is invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'bindingDigest,connectionChallenge,connectionId,executionNodeId,extensionInstanceId,goalId,piSessionId,processInstanceId,runId') lifecycleInvalid('Attempt run binding fields are not the declared shape')
  if (!(['executionNodeId', 'processInstanceId', 'piSessionId', 'extensionInstanceId'] as const).every(key => isLifecycleId(record[key]))) lifecycleInvalid('Attempt run binding incarnation is invalid')
  if (!isLifecycleId(record.runId) || !isLifecycleId(record.goalId) || !isLifecycleDigest(record.bindingDigest)) lifecycleInvalid('Attempt run binding identity is invalid')
  if (!isLifecycleId(record.connectionId) || typeof record.connectionChallenge !== 'string' || !LIFECYCLE_CAPABILITY.test(record.connectionChallenge)) lifecycleInvalid('Attempt challenged connection is invalid')
  return {
    executionNodeId: record.executionNodeId as string, processInstanceId: record.processInstanceId as string, piSessionId: record.piSessionId as string,
    extensionInstanceId: record.extensionInstanceId as string, runId: record.runId as string, goalId: record.goalId as string,
    bindingDigest: record.bindingDigest as string, connectionId: record.connectionId as string, connectionChallenge: record.connectionChallenge,
  }
}

function validateContext(value: unknown): AssignmentContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) lifecycleInvalid('Attempt context is invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'baselineDigest,canonicalPath,dirty,executionNodeId,gitCommonDir,headOid,manifestDigest,projectId,repositoryIdentity') lifecycleInvalid('Attempt context fields are not the declared shape')
  if (!isLifecycleId(record.projectId) || !isLifecycleId(record.executionNodeId)) lifecycleInvalid('Attempt context identity is invalid')
  for (const key of ['canonicalPath', 'gitCommonDir'] as const) {
    const path = record[key]
    if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || !path.isWellFormed() || path.includes('\u0000')) lifecycleInvalid(`Attempt context ${key} is not a canonical absolute path`)
  }
  if (!isLifecycleIdentity(record.repositoryIdentity) || !isLifecycleDigest(record.baselineDigest) || !isLifecycleDigest(record.manifestDigest)) lifecycleInvalid('Attempt context digests are invalid')
  if (typeof record.headOid !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.headOid)) lifecycleInvalid('Attempt context HEAD is invalid')
  if (typeof record.dirty !== 'boolean') lifecycleInvalid('Attempt context dirty flag is invalid')
  return {
    projectId: record.projectId as string, executionNodeId: record.executionNodeId as string, canonicalPath: record.canonicalPath as string,
    gitCommonDir: record.gitCommonDir as string, repositoryIdentity: record.repositoryIdentity as string, headOid: record.headOid as string,
    dirty: record.dirty as boolean, baselineDigest: record.baselineDigest as string, manifestDigest: record.manifestDigest as string,
  }
}

function validateGate(value: unknown, projectId: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) lifecycleInvalid('Attempt gate reference is invalid')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'canonicalJson,checkId,digest,version') lifecycleInvalid('Attempt gate fields are not the declared shape')
  if (!isLifecycleId(record.checkId) || !Number.isSafeInteger(record.version) || (record.version as number) < 1 || !isLifecycleDigest(record.digest) || typeof record.canonicalJson !== 'string') lifecycleInvalid('Attempt gate reference is invalid')
  const parsed = parseJsonObject(record.canonicalJson, 'Attempt gate definition', MAX_GATE_JSON_BYTES)
  readResolvedCheck({ projectId, checkId: record.checkId as string, version: record.version as number, digest: record.digest as string, canonicalJson: record.canonicalJson as string, name: String(parsed.name), mode: String(parsed.mode), createdAt: 0 })
}

interface AttemptAssignmentFacts { projectId: string; goalId: string; agentRunId: string; attemptCount: number }
function validateAttempt(record: AttemptRecord, facts: AttemptAssignmentFacts): void {
  if (Object.keys(record).sort().join(',') !== 'assignmentId,attemptId,context,controlEpoch,createdAt,deliveryId,gate,limits,ordinal,runBinding,state,updatedAt,writerEpoch') lifecycleInvalid('Attempt fields are not the declared shape')
  if (!isLifecycleId(record.attemptId) || !isLifecycleId(record.assignmentId)) lifecycleInvalid('Attempt identifiers are invalid')
  if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 1) lifecycleInvalid('Attempt ordinal must be a positive integer')
  const runBinding = validateRunBinding(record.runBinding)
  if (runBinding.runId !== facts.agentRunId || runBinding.goalId !== facts.goalId) lifecycleInvalid('Attempt run binding does not match its Assignment Run/Goal')
  const context = validateContext(record.context)
  if (context.projectId !== facts.projectId) lifecycleInvalid('Attempt context does not match its Assignment Project')
  validateGate(record.gate, facts.projectId)
  validateLimits(record.limits)
  if (!isSafeCount(record.writerEpoch) || !isSafeCount(record.controlEpoch)) lifecycleInvalid('Attempt epochs are invalid')
  if (record.deliveryId !== null && !isLifecycleId(record.deliveryId)) lifecycleInvalid('Attempt delivery identity is invalid')
  if (!(ATTEMPT_STATES as readonly string[]).includes(record.state)) lifecycleInvalid('Attempt state is unknown')
  if (!isSafeCount(record.createdAt) || !isSafeCount(record.updatedAt)) lifecycleInvalid('Attempt timestamps are invalid')
}

function validateArtifactRefs(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_ARTIFACT_REFS) lifecycleInvalid(`artifact refs must be an array of at most ${MAX_ARTIFACT_REFS}`)
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) lifecycleInvalid('artifact ref is not an object')
    const ref = item as Record<string, unknown>
    if (Object.keys(ref).sort().join(',') !== 'digest,length,path') lifecycleInvalid('artifact ref fields are not the declared shape')
    if (typeof ref.path !== 'string' || ref.path.length === 0 || ref.path.includes('\u0000') || Buffer.byteLength(ref.path) > MAX_ARTIFACT_PATH_BYTES || ref.path.startsWith('/') || ref.path.split('/').includes('..')) lifecycleInvalid('artifact ref path is invalid')
    if (!isLifecycleDigest(ref.digest) || !isSafeCount(ref.length)) lifecycleInvalid('artifact ref digest/length is invalid')
    if (seen.has(ref.path)) lifecycleInvalid('artifact ref paths must be unique')
    seen.add(ref.path)
  }
}

/** Canonical, domain-separated Candidate digest; callers never supply their own hash. */
export function candidateDigest(record: Pick<CandidateRecord, 'assignmentId' | 'attemptId' | 'agentRunId' | 'controlEpoch' | 'summary' | 'artifactRefs'>): string {
  return sha256({ domain: 'omarchestra.candidate/v1', assignmentId: record.assignmentId, attemptId: record.attemptId, agentRunId: record.agentRunId, controlEpoch: record.controlEpoch, summary: record.summary, artifactRefs: record.artifactRefs })
}
/** Canonical, domain-separated handoff digest; callers never supply their own hash. */
export function handoffDigest(record: Pick<HandoffRecord, 'assignmentId' | 'attemptId' | 'agentRunId' | 'controlEpoch' | 'claimedState' | 'summary' | 'artifactRefs' | 'outstandingEffects'>): string {
  return sha256({ domain: 'omarchestra.handoff/v1', assignmentId: record.assignmentId, attemptId: record.attemptId, agentRunId: record.agentRunId, controlEpoch: record.controlEpoch, claimedState: record.claimedState, summary: record.summary, artifactRefs: record.artifactRefs, outstandingEffects: record.outstandingEffects })
}

function validateCandidate(record: CandidateRecord): void {
  if (Object.keys(record).sort().join(',') !== 'agentRunId,artifactRefs,assignmentId,attemptId,candidateId,controlEpoch,createdAt,digest,preManifestDigest,state,summary') lifecycleInvalid('Candidate fields are not the declared shape')
  if (!isLifecycleId(record.candidateId) || !isLifecycleId(record.assignmentId) || !isLifecycleId(record.attemptId) || !isLifecycleId(record.agentRunId)) lifecycleInvalid('Candidate identifiers are invalid')
  if (!isSafeCount(record.controlEpoch)) lifecycleInvalid('Candidate control epoch is invalid')
  if (!isBoundedText(record.summary, MAX_SUMMARY_BYTES)) lifecycleInvalid('Candidate summary is empty or exceeds 8192 bytes')
  validateArtifactRefs(record.artifactRefs)
  if (!isLifecycleDigest(record.preManifestDigest)) lifecycleInvalid('Candidate pre-gate manifest digest is invalid')
  if (!isLifecycleDigest(record.digest) || record.digest !== candidateDigest(record)) lifecycleInvalid('Candidate digest does not match its canonical content')
  if (!(CANDIDATE_STATES as readonly string[]).includes(record.state)) lifecycleInvalid('Candidate state is unknown')
  if (!isSafeCount(record.createdAt)) lifecycleInvalid('Candidate timestamp is invalid')
}

function validateGateResult(record: GateResultRecord): void {
  if (Object.keys(record).sort().join(',') !== 'assignmentId,attemptId,candidateId,createdAt,evidenceJson,executableDigest,exitCode,gateDigest,outcome,postManifestDigest,preManifestDigest,reasonCode,resultId,revision,state') lifecycleInvalid('Gate result fields are not the declared shape')
  if (!isLifecycleId(record.resultId) || !isLifecycleId(record.assignmentId) || !isLifecycleId(record.attemptId) || !isLifecycleId(record.candidateId)) lifecycleInvalid('Gate result identifiers are invalid')
  if (!isLifecycleDigest(record.gateDigest) || !isLifecycleDigest(record.executableDigest) || !isLifecycleDigest(record.preManifestDigest)) lifecycleInvalid('Gate result digests are invalid')
  if (record.postManifestDigest !== null && !isLifecycleDigest(record.postManifestDigest)) lifecycleInvalid('Gate result post-manifest digest is invalid')
  if (!(GATE_OUTCOMES as readonly string[]).includes(record.outcome)) lifecycleInvalid('Gate outcome is unknown')
  if (record.exitCode !== null && !isSafeCount(record.exitCode)) lifecycleInvalid('Gate exit code is invalid')
  if (record.reasonCode !== null && (typeof record.reasonCode !== 'string' || !LIFECYCLE_REASON.test(record.reasonCode))) lifecycleInvalid('Gate reason code is invalid')
  if (typeof record.evidenceJson !== 'string' || Buffer.byteLength(record.evidenceJson) > MAX_EVIDENCE_BYTES) lifecycleInvalid('Gate evidence is empty or exceeds 8192 bytes')
  try { JSON.parse(record.evidenceJson) } catch { lifecycleInvalid('Gate evidence is not valid JSON') }
  if (!(GATE_RESULT_STATES as readonly string[]).includes(record.state)) lifecycleInvalid('Gate result state is unknown')
  if (!isSafeCount(record.revision) || !isSafeCount(record.createdAt)) lifecycleInvalid('Gate result counters are invalid')
  if (record.state === 'accepted' && record.outcome !== 'pass') lifecycleInvalid('only a passing gate result can be accepted')
}

function validateStop(record: AssignmentStopRecord): void {
  if (Object.keys(record).sort().join(',') !== 'assignmentId,cancellationStatus,createdAt,dispatchRevoked,reasonCode,revision,stopId,trigger,updatedAt') lifecycleInvalid('Assignment stop fields are not the declared shape')
  if (!isLifecycleId(record.stopId) || !isLifecycleId(record.assignmentId)) lifecycleInvalid('Assignment stop identifiers are invalid')
  if (!(STOP_TRIGGERS as readonly string[]).includes(record.trigger)) lifecycleInvalid('Assignment stop trigger is unknown')
  if (!isSafeCount(record.revision) || !isSafeCount(record.createdAt) || !isSafeCount(record.updatedAt)) lifecycleInvalid('Assignment stop counters are invalid')
  if (typeof record.dispatchRevoked !== 'boolean') lifecycleInvalid('Assignment stop dispatchRevoked must be boolean')
  if (!(CANCELLATION_STATUSES as readonly string[]).includes(record.cancellationStatus)) lifecycleInvalid('Assignment stop cancellation status is unknown')
  if (record.reasonCode !== null && (typeof record.reasonCode !== 'string' || !LIFECYCLE_REASON.test(record.reasonCode))) lifecycleInvalid('Assignment stop reason code is invalid')
}

function validateHandoff(record: HandoffRecord): void {
  if (Object.keys(record).sort().join(',') !== 'agentRunId,artifactRefs,assignmentId,attemptId,claimedState,controlEpoch,createdAt,digest,handoffId,outstandingEffects,summary') lifecycleInvalid('Handoff fields are not the declared shape')
  if (!isLifecycleId(record.handoffId) || !isLifecycleId(record.assignmentId) || !isLifecycleId(record.attemptId) || !isLifecycleId(record.agentRunId)) lifecycleInvalid('Handoff identifiers are invalid')
  if (!isSafeCount(record.controlEpoch) || !isSafeCount(record.createdAt)) lifecycleInvalid('Handoff counters are invalid')
  if (!(HANDOFF_CLAIMED_STATES as readonly string[]).includes(record.claimedState)) lifecycleInvalid('Handoff claimed state is unknown')
  if (!isBoundedText(record.summary, MAX_SUMMARY_BYTES)) lifecycleInvalid('Handoff summary is empty or exceeds 8192 bytes')
  validateArtifactRefs(record.artifactRefs)
  if (!(OUTSTANDING_EFFECTS as readonly string[]).includes(record.outstandingEffects)) lifecycleInvalid('Handoff outstanding effects are unknown')
  if (!isLifecycleDigest(record.digest) || record.digest !== handoffDigest(record)) lifecycleInvalid('Handoff digest does not match its canonical content')
}

function validateAssignmentDelivery(record: AssignmentDelivery): void {
  if (Object.keys(record).sort().join(',') !== 'assignmentId,attemptId,createdAt,deadline,deliveryId,frameJson,payloadDigest,reasonCode,runId,state') lifecycleInvalid('Assignment delivery fields are not the declared shape')
  if (!isLifecycleId(record.deliveryId) || !isLifecycleId(record.assignmentId) || !isLifecycleId(record.attemptId) || !isLifecycleId(record.runId)) lifecycleInvalid('Assignment delivery identifiers are invalid')
  if (typeof record.frameJson !== 'string' || record.frameJson.length === 0 || !record.frameJson.isWellFormed() || Buffer.byteLength(record.frameJson) > MAX_FRAME_BYTES) lifecycleInvalid('delivery frame is empty or exceeds 64 KiB')
  if (!isLifecycleDigest(record.payloadDigest) || sha256(record.frameJson) !== record.payloadDigest) lifecycleInvalid('delivery payload digest does not match its exact frame bytes')
  if (!(OUTBOX_STATES as readonly string[]).includes(record.state)) lifecycleInvalid('delivery state is unknown')
  if (!DELIVERY_REASONS.includes(record.reasonCode)) lifecycleInvalid('delivery reason is invalid')
  if (['queued', 'attempting', 'written'].includes(record.state) && record.reasonCode !== null) lifecycleInvalid('an unresolved delivery cannot carry a reason')
  if (record.state === 'not_sent' && !['connection_lost', 'expired', 'revoked', 'owner_restarted'].includes(record.reasonCode ?? '')) lifecycleInvalid('not_sent requires a terminal non-send reason')
  if (record.state === 'unknown' && !['transport_error', 'owner_restarted'].includes(record.reasonCode ?? '')) lifecycleInvalid('unknown delivery requires an uncertainty reason')
  if (!isSafeCount(record.deadline) || !isSafeCount(record.createdAt)) lifecycleInvalid('delivery timestamps are invalid')
}

function assignmentRow(row: Record<string, unknown>): AssignmentRecord {
  return validateAssignment({
    assignmentId: String(row.assignment_id),
    projectId: String(row.project_id),
    goalId: String(row.goal_id),
    agentRunId: String(row.agent_run_id),
    bindingDigest: String(row.binding_digest),
    goalText: String(row.goal_text),
    taskText: String(row.task_text),
    writeAuthority: Number(row.write_authority) !== 0,
    state: String(row.state) as AssignmentState,
    limits: parseLimits(row.limits_json),
    attemptCount: Number(row.attempt_count),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  })
}

function attemptRow(row: Record<string, unknown>, facts: AttemptAssignmentFacts): AttemptRecord {
  const runBinding = validateRunBinding(parseJsonObject(row.run_binding_json, 'Attempt run binding', MAX_GATE_JSON_BYTES))
  if (sha256(canonicalJson(runBinding)) !== String(row.run_binding_digest)) lifecycleInvalid('Attempt run binding digest does not match its frozen bytes')
  const record: AttemptRecord = {
    attemptId: String(row.attempt_id),
    assignmentId: String(row.assignment_id),
    ordinal: Number(row.ordinal),
    state: String(row.state) as AttemptState,
    runBinding,
    gate: { checkId: String(row.gate_id), version: Number(row.gate_version), digest: String(row.gate_digest), canonicalJson: String(row.gate_json) },
    context: validateContext(parseJsonObject(row.context_json, 'Attempt context', MAX_GATE_JSON_BYTES)),
    limits: parseLimits(row.limits_json),
    writerEpoch: Number(row.writer_epoch),
    controlEpoch: Number(row.control_epoch),
    deliveryId: row.delivery_id === null || row.delivery_id === undefined ? null : String(row.delivery_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  validateAttempt(record, facts)
  return record
}

function writerRow(row: Record<string, unknown>): AssignmentWriterRecord {
  const state = String(row.state) as WriterState
  if (!isLifecycleId(row.project_id) || !Number.isSafeInteger(row.epoch) || Number(row.epoch) < 0 || !isSafeCount(row.updated_at) || !(WRITER_STATES as readonly string[]).includes(state)) lifecycleInvalid('per-Project writer lease is invalid')
  if (row.assignment_id !== null && row.assignment_id !== undefined && !isLifecycleId(row.assignment_id)) lifecycleInvalid('writer lease Assignment identity is invalid')
  if (row.attempt_id !== null && row.attempt_id !== undefined && !isLifecycleId(row.attempt_id)) lifecycleInvalid('writer lease Attempt identity is invalid')
  return {
    projectId: String(row.project_id),
    assignmentId: row.assignment_id === null || row.assignment_id === undefined ? null : String(row.assignment_id),
    attemptId: row.attempt_id === null || row.attempt_id === undefined ? null : String(row.attempt_id),
    epoch: Number(row.epoch),
    state,
    updatedAt: Number(row.updated_at),
  }
}

function assignmentDeliveryRow(row: Record<string, unknown>): AssignmentDelivery {
  const record: AssignmentDelivery = {
    deliveryId: String(row.delivery_id),
    assignmentId: String(row.assignment_id),
    attemptId: String(row.attempt_id),
    runId: String(row.run_id),
    frameJson: String(row.frame_json),
    payloadDigest: String(row.payload_digest),
    state: String(row.state) as AssignmentOutboxState,
    reasonCode: row.reason_code === null || row.reason_code === undefined ? null : String(row.reason_code),
    deadline: Number(row.deadline),
    createdAt: Number(row.created_at),
  }
  validateAssignmentDelivery(record)
  return record
}

function candidateRow(row: Record<string, unknown>): CandidateRecord {
  const refs = parseJsonValue(row.artifact_refs_json, 'Candidate artifact refs', MAX_EVIDENCE_BYTES * 8)
  validateArtifactRefs(refs)
  const record: CandidateRecord = {
    candidateId: String(row.candidate_id),
    assignmentId: String(row.assignment_id),
    attemptId: String(row.attempt_id),
    agentRunId: String(row.agent_run_id),
    controlEpoch: Number(row.control_epoch),
    summary: String(row.summary),
    artifactRefs: refs as ArtifactRef[],
    digest: String(row.digest),
    preManifestDigest: String(row.pre_manifest_digest),
    state: String(row.state) as CandidateState,
    createdAt: Number(row.created_at),
  }
  validateCandidate(record)
  return record
}

function gateResultRow(row: Record<string, unknown>): GateResultRecord {
  const record: GateResultRecord = {
    resultId: String(row.result_id),
    assignmentId: String(row.assignment_id),
    attemptId: String(row.attempt_id),
    candidateId: String(row.candidate_id),
    gateDigest: String(row.gate_digest),
    executableDigest: String(row.executable_digest),
    outcome: String(row.outcome) as GateOutcome,
    preManifestDigest: String(row.pre_manifest_digest),
    postManifestDigest: row.post_manifest_digest === null || row.post_manifest_digest === undefined ? null : String(row.post_manifest_digest),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    reasonCode: row.reason_code === null || row.reason_code === undefined ? null : String(row.reason_code),
    evidenceJson: String(row.evidence_json),
    state: String(row.state) as GateResultState,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
  }
  validateGateResult(record)
  return record
}

function stopRow(row: Record<string, unknown>): AssignmentStopRecord {
  const record: AssignmentStopRecord = {
    stopId: String(row.stop_id),
    assignmentId: String(row.assignment_id),
    trigger: String(row.trigger) as StopTrigger,
    revision: Number(row.revision),
    dispatchRevoked: Number(row.dispatch_revoked) !== 0,
    cancellationStatus: String(row.cancellation_status) as CancellationStatus,
    reasonCode: row.reason_code === null || row.reason_code === undefined ? null : String(row.reason_code),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  validateStop(record)
  return record
}

function handoffRow(row: Record<string, unknown>): HandoffRecord {
  const refs = parseJsonValue(row.artifact_refs_json, 'Handoff artifact refs', MAX_EVIDENCE_BYTES * 8)
  validateArtifactRefs(refs)
  const record: HandoffRecord = {
    handoffId: String(row.handoff_id),
    assignmentId: String(row.assignment_id),
    attemptId: String(row.attempt_id),
    agentRunId: String(row.agent_run_id),
    controlEpoch: Number(row.control_epoch),
    claimedState: String(row.claimed_state) as HandoffClaimedState,
    summary: String(row.summary),
    artifactRefs: refs as ArtifactRef[],
    outstandingEffects: String(row.outstanding_effects) as OutstandingEffects,
    digest: String(row.digest),
    createdAt: Number(row.created_at),
  }
  validateHandoff(record)
  return record
}

/** Verified durability settings for tests and documentation. */
export function describeStoreSettings(store: WorkbenchStore): Record<string, unknown> {
  return {
    path: store.path,
    nodeId: store.nodeId,
    epoch: store.epoch,
    integrity: store.integrityCheck(),
    journalMode: REQUIRED_JOURNAL_MODE,
    synchronous: REQUIRED_PRAGMAS.synchronous,
    foreignKeys: REQUIRED_PRAGMAS.foreign_keys,
    busyTimeoutMs: REQUIRED_PRAGMAS.busy_timeout,
    schemaVersion: STORE_SCHEMA_VERSION,
    fileMode: OWNED_FILE_MODE.toString(8),
  }
}
