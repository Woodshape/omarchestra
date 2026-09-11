/**
 * Local Workbench v1 — Phase 1 presentation schema.
 *
 * Strict bounded projection/intent/event/feedback types and validators for
 * the injected presentation shell. This module is presentation-only: it
 * validates plain values and never opens storage, runs a validator, or
 * dispatches work. The runner remains the sole authority for durable state,
 * admission, gates, and projections.
 *
 * Concrete schema recorded against contract C4. Common limits:
 *   - protocol `omarchestra.workbench/v1`
 *   - opaque IDs 1-128 ASCII letters/digits/underscore/hyphen
 *   - revisions/cursors nonnegative safe integers
 *   - max encoded envelope 256 KiB, depth 8, at most 64 keys/object
 *   - display strings 512 UTF-8 bytes
 *   - at most 100 records per collection
 */

import { validateDetail, validateCheckDraft, type WorkbenchDetail } from './detail-schema.ts'

export const WORKBENCH_PROTOCOL = 'omarchestra.workbench/v1'

export const CONNECTION_STATUSES = [
  'loading',
  'connected',
  'stale',
  'reconnecting',
  'gap',
  'error',
] as const
export type WorkbenchConnection = (typeof CONNECTION_STATUSES)[number]

export const CONTROL_MODES = ['managed', 'manual_takeover', 'reconciling'] as const
export type ControlMode = (typeof CONTROL_MODES)[number]

export const CONNECTION_STATES = ['connected', 'disconnected', 'stale'] as const
export type ConnectionState = (typeof CONNECTION_STATES)[number]

export const GATE_RESULTS = ['pending', 'pass', 'fail', 'error', 'timeout'] as const
export type GateResult = (typeof GATE_RESULTS)[number]

export const FEEDBACK_STATUSES = [
  'submitted',
  'acknowledged',
  'rejected',
  'unknown',
  'stale',
  'expired',
] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const MAX_ID_BYTES = 128
export const MAX_DISPLAY_BYTES = 512
export const MAX_COLLECTION = 100
export const MAX_KEYS = 64
export const MAX_DEPTH = 8
export const MAX_ENVELOPE_BYTES = 256 * 1024

export const CHECK_MODES = ['validator', 'artifact_presence'] as const
export type CheckMode = (typeof CHECK_MODES)[number]

export const CHECK_AVAILABILITY = ['available', 'invalid', 'unavailable'] as const
export type CheckAvailability = (typeof CHECK_AVAILABILITY)[number]

export interface WorkbenchAction {
  kind: string
  target: string | null
  /** Committed display label. QML never derives a label from the kind. */
  label: string | null
  enabled: boolean
  reasonCode: string | null
  reason: string | null
}

/**
 * Project-scoped configured acceptance check, presentation summary only
 * (contract C14). The full definition body stays behind an explicit detail
 * expansion; a selection is a reference, never execution authority.
 */
export interface CheckSummary {
  checkId: string
  version: number
  digest: string
  name: string
  summary: string
  mode: CheckMode
  commandSummary: string
  availability: CheckAvailability
  reason: string | null
}

export interface ProjectSummary {
  projectId: string
  executionNodeId: string
  canonicalPath: string
  gitCommonDir: string
  revision: string
  dirty: boolean
  contextMatch: boolean
}

export interface GoalSummary {
  goalId: string
  projectId: string
  goalText: string
  state: 'active' | 'recent'
  outcome: string | null
  createdAt: string
  /** Runner-computed secondary actions for this Goal. QML renders, never derives. */
  actions: WorkbenchAction[]
}

export interface ManagedAgentCard {
  agentRunId: string
  role: string
  piStatus: string
  controlMode: ControlMode
  connectionStatus: ConnectionState
  assignment: string | null
  lastEvent: string | null
  predecessorAgentRunId: string | null
  actions: WorkbenchAction[]
}

export interface ObservedChoice {
  choiceId: string
  label: string
  enabled: boolean
}

export interface ObservedSessionCard {
  observedSessionId: string
  piStatus: string
  lifecycle: string
  availability: string
  health: string
  choices: ObservedChoice[]
}

export interface RetiredRunCard {
  agentRunId: string
  role: string
  piStatus: string
  retiredAt: number
  predecessorAgentRunId: string | null
  replacementAgentRunId: string | null
  canPurge: boolean
  purgeBlockedReason: string | null
}

export interface AssignmentCard {
  assignmentId: string
  projectId: string
  goalId: string
  agentRunId: string
  goalText: string
  state: string
  attemptId: string | null
  gateId: string | null
  gateVersion: number | null
  gateResult: GateResult | null
  candidateRef: string | null
  correctionCount: number
  correctionLimit: number
  diagnostics: string | null
  artifactRefs: string[]
}

export interface ActivityEntry {
  eventId: string
  cursor: number
  kind: string
  reasonCode: string | null
  label: string
  createdAt: string
}

export interface FixtureMarker {
  active: boolean
  label: string
}

export interface WorkbenchSnapshot {
  protocol: typeof WORKBENCH_PROTOCOL
  sessionId: string
  pluginGeneration: number
  runnerEpoch: number
  revision: number
  cursor: number
  connection: WorkbenchConnection
  projects: ProjectSummary[]
  goals: GoalSummary[]
  selectedProjectId: string | null
  selectedGoalId: string | null
  managedAgents: ManagedAgentCard[]
  observedSessions: ObservedSessionCard[]
  retiredRuns: RetiredRunCard[]
  assignments: AssignmentCard[]
  activity: ActivityEntry[]
  capabilities: string[]
  actions: WorkbenchAction[]
  /** Roles offered for a new Adoption binding. Empty means none offered. */
  roles: string[]
  /** Project-scoped configured acceptance checks (contract C14). */
  checks: CheckSummary[]
  fixture: FixtureMarker
  details?: WorkbenchDetail[]
}

export interface WorkbenchEvent {
  protocol: typeof WORKBENCH_PROTOCOL
  sessionId: string
  runnerEpoch: number
  eventId: string
  cursor: number
  baseRevision: number
  revision: number
  kind: string
  payload: Record<string, unknown>
}

export interface WorkbenchIntent {
  protocol: typeof WORKBENCH_PROTOCOL
  sessionId: string
  pluginGeneration: number
  runnerEpoch: number
  intentId: string
  expectedRevision: number
  kind: string
  target: string | null
  payload: Record<string, unknown>
}

export interface WorkbenchFeedback {
  intentId: string
  sessionId: string
  target: string | null
  originRevision: number
  status: FeedbackStatus
  reasonCode: string | null
  committedRevision: number | null
}

export interface WorkbenchHandoff {
  connection: WorkbenchConnection
  revision: number
  cursor: number
  snapshot: WorkbenchSnapshot
  fault: string | null
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaError'
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new SchemaError(`${where} must be a string`)
  return value
}

function requireId(value: unknown, where: string): string {
  const text = requireString(value, where)
  if (text.length < 1 || text.length > MAX_ID_BYTES) {
    throw new SchemaError(`${where} must be 1-${MAX_ID_BYTES} characters`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new SchemaError(`${where} must be ASCII letters/digits/underscore/hyphen`)
  }
  return text
}

function requireDisplay(value: unknown, where: string): string {
  const text = requireString(value, where)
  if (Buffer.byteLength(text, 'utf8') > MAX_DISPLAY_BYTES) {
    throw new SchemaError(`${where} exceeds ${MAX_DISPLAY_BYTES} UTF-8 bytes`)
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new SchemaError(`${where} contains control characters`)
  return text
}

function requireManagedText(value: unknown, where: string): string {
  const text = requireString(value, where)
  if (Buffer.byteLength(text, 'utf8') > 8192 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw new SchemaError(`${where} exceeds managed-content policy`)
  return text
}

function requireNonNegativeInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaError(`${where} must be a nonnegative safe integer`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const text = requireString(value, where)
  if (!(allowed as readonly string[]).includes(text)) {
    throw new SchemaError(`${where} must be one of ${allowed.join(', ')}`)
  }
  return text as T
}

function requireNullableString(value: unknown, where: string): string | null {
  if (value === null) return null
  return requireDisplay(value, where)
}

function requireNullableId(value: unknown, where: string): string | null {
  if (value === null) return null
  return requireId(value, where)
}

function requireCollection<T>(value: unknown, where: string, item: (v: unknown, w: string) => T): T[] {
  if (!Array.isArray(value)) throw new SchemaError(`${where} must be an array`)
  if (value.length > MAX_COLLECTION) throw new SchemaError(`${where} exceeds ${MAX_COLLECTION} records`)
  return value.map((entry, index) => item(entry, `${where}[${index}]`))
}

function checkTree(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) throw new SchemaError('payload exceeds depth bound')
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 8192) throw new SchemaError('payload string exceeds 8192 bytes')
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new SchemaError('payload contains control characters')
  } else if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new SchemaError('payload number must be a safe integer')
  else if (value && typeof value === 'object') {
    const entries = Object.values(value)
    if (entries.length > (Array.isArray(value) ? MAX_COLLECTION : MAX_KEYS)) throw new SchemaError('payload collection/key bound exceeded')
    for (const entry of entries) checkTree(entry, depth + 1)
  }
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  checkTree(value)
  if (!isPlainObject(value)) throw new SchemaError(`${where} must be an object`)
  const keys = Object.keys(value)
  if (keys.length > MAX_KEYS) throw new SchemaError(`${where} exceeds ${MAX_KEYS} keys`)
  const name = where.replace(/\[\d+\]/g, '').split('.').at(-1)!
  const fields: Record<string, string> = {
    snapshot: 'protocol sessionId pluginGeneration runnerEpoch revision cursor connection projects goals selectedProjectId selectedGoalId managedAgents observedSessions retiredRuns assignments activity capabilities actions roles checks fixture details',
    event: 'protocol sessionId runnerEpoch eventId cursor baseRevision revision kind payload',
    intent: 'protocol sessionId pluginGeneration runnerEpoch intentId expectedRevision kind target payload',
    feedback: 'intentId sessionId target originRevision status reasonCode committedRevision',
    projects: 'projectId executionNodeId canonicalPath gitCommonDir revision dirty contextMatch',
    goals: 'goalId projectId goalText state outcome createdAt actions',
    managedAgents: 'agentRunId role piStatus controlMode connectionStatus assignment lastEvent predecessorAgentRunId actions',
    observedSessions: 'observedSessionId piStatus lifecycle availability health choices',
    retiredRuns: 'agentRunId role piStatus retiredAt predecessorAgentRunId replacementAgentRunId canPurge purgeBlockedReason',
    assignments: 'assignmentId projectId goalId agentRunId goalText state attemptId gateId gateVersion gateResult candidateRef correctionCount correctionLimit diagnostics artifactRefs',
    activity: 'eventId cursor kind reasonCode label createdAt',
    actions: 'kind target label enabled reasonCode reason',
    action: 'kind target label enabled reasonCode reason',
    choices: 'choiceId label enabled', fixture: 'active label',
    checks: 'checkId version digest name summary mode commandSummary availability reason',
    check: 'checkId version digest name summary mode commandSummary availability reason',
  }
  const aliases: Record<string, string> = { project: 'projects', goal: 'goals', managedAgent: 'managedAgents', observedSession: 'observedSessions', retiredRun: 'retiredRuns', assignment: 'assignments', choice: 'choices' }
  const allowed = fields[aliases[name] ?? name]?.split(' ')
  for (const key of ['enabled', 'dirty', 'contextMatch', 'canPurge', 'active']) {
    if (key in value && typeof value[key] !== 'boolean') throw new SchemaError(`${where}.${key} must be boolean`)
  }
  if (allowed) for (const key of keys) {
    if (!allowed.includes(key)) throw new SchemaError(`${where}: unknown field ${key}`)
  }
  assertEnvelopeBytes(JSON.stringify(value), where)
  return value
}

function requireProtocol(value: unknown, where: string): void {
  if (value !== WORKBENCH_PROTOCOL) {
    throw new SchemaError(`${where} protocol must be ${WORKBENCH_PROTOCOL}`)
  }
}

// ---------------------------------------------------------------------------
// Sub-type validators
// ---------------------------------------------------------------------------

export function validateAction(value: unknown, where = 'action'): WorkbenchAction {
  const obj = requireObject(value, where)
  return {
    kind: requireDisplay(obj.kind, `${where}.kind`),
    target: requireNullableId(obj.target, `${where}.target`),
    label: obj.label === undefined || obj.label === null ? null : requireDisplay(obj.label, `${where}.label`),
    enabled: obj.enabled === true,
    reasonCode: requireNullableString(obj.reasonCode, `${where}.reasonCode`),
    reason: requireNullableString(obj.reason, `${where}.reason`),
  }
}

function requireDigest(value: unknown, where: string): string {
  const text = requireString(value, where)
  if (!/^[a-f0-9]{64}$/.test(text)) throw new SchemaError(`${where} must be a lowercase SHA-256 digest`)
  return text
}

export function validateCheckSummary(value: unknown, where = 'check'): CheckSummary {
  const obj = requireObject(value, where)
  return {
    checkId: requireId(obj.checkId, `${where}.checkId`),
    version: requireNonNegativeInt(obj.version, `${where}.version`),
    digest: requireDigest(obj.digest, `${where}.digest`),
    name: requireDisplay(obj.name, `${where}.name`),
    summary: requireDisplay(obj.summary, `${where}.summary`),
    mode: requireEnum(obj.mode, CHECK_MODES, `${where}.mode`),
    commandSummary: requireDisplay(obj.commandSummary, `${where}.commandSummary`),
    availability: requireEnum(obj.availability, CHECK_AVAILABILITY, `${where}.availability`),
    reason: requireNullableString(obj.reason, `${where}.reason`),
  }
}

export function validateProjectSummary(value: unknown, where = 'project'): ProjectSummary {
  const obj = requireObject(value, where)
  return {
    projectId: requireId(obj.projectId, `${where}.projectId`),
    executionNodeId: requireId(obj.executionNodeId, `${where}.executionNodeId`),
    canonicalPath: requireDisplay(obj.canonicalPath, `${where}.canonicalPath`),
    gitCommonDir: requireDisplay(obj.gitCommonDir, `${where}.gitCommonDir`),
    revision: requireDisplay(obj.revision, `${where}.revision`),
    dirty: obj.dirty === true,
    contextMatch: obj.contextMatch === true,
  }
}

export function validateGoalSummary(value: unknown, where = 'goal'): GoalSummary {
  const obj = requireObject(value, where)
  return {
    goalId: requireId(obj.goalId, `${where}.goalId`),
    projectId: requireId(obj.projectId, `${where}.projectId`),
    goalText: requireManagedText(obj.goalText, `${where}.goalText`),
    state: requireEnum(obj.state, ['active', 'recent'], `${where}.state`),
    outcome: requireNullableString(obj.outcome, `${where}.outcome`),
    createdAt: requireDisplay(obj.createdAt, `${where}.createdAt`),
    actions: requireCollection(obj.actions, `${where}.actions`, validateAction),
  }
}

export function validateManagedAgentCard(value: unknown, where = 'managedAgent'): ManagedAgentCard {
  const obj = requireObject(value, where)
  return {
    agentRunId: requireId(obj.agentRunId, `${where}.agentRunId`),
    role: requireDisplay(obj.role, `${where}.role`),
    piStatus: requireDisplay(obj.piStatus, `${where}.piStatus`),
    controlMode: requireEnum(obj.controlMode, CONTROL_MODES, `${where}.controlMode`),
    connectionStatus: requireEnum(obj.connectionStatus, CONNECTION_STATES, `${where}.connectionStatus`),
    assignment: requireNullableString(obj.assignment, `${where}.assignment`),
    lastEvent: requireNullableString(obj.lastEvent, `${where}.lastEvent`),
    predecessorAgentRunId: requireNullableId(obj.predecessorAgentRunId, `${where}.predecessorAgentRunId`),
    actions: requireCollection(obj.actions, `${where}.actions`, validateAction),
  }
}

export function validateObservedChoice(value: unknown, where = 'choice'): ObservedChoice {
  const obj = requireObject(value, where)
  return {
    choiceId: requireId(obj.choiceId, `${where}.choiceId`),
    label: requireDisplay(obj.label, `${where}.label`),
    enabled: obj.enabled === true,
  }
}

export function validateObservedSessionCard(value: unknown, where = 'observedSession'): ObservedSessionCard {
  const obj = requireObject(value, where)
  return {
    observedSessionId: requireId(obj.observedSessionId, `${where}.observedSessionId`),
    piStatus: requireDisplay(obj.piStatus, `${where}.piStatus`),
    lifecycle: requireDisplay(obj.lifecycle, `${where}.lifecycle`),
    availability: requireDisplay(obj.availability, `${where}.availability`),
    health: requireDisplay(obj.health, `${where}.health`),
    choices: requireCollection(obj.choices, `${where}.choices`, validateObservedChoice),
  }
}

export function validateRetiredRunCard(value: unknown, where = 'retiredRun'): RetiredRunCard {
  const obj = requireObject(value, where)
  return {
    agentRunId: requireId(obj.agentRunId, `${where}.agentRunId`),
    role: requireDisplay(obj.role, `${where}.role`),
    piStatus: requireDisplay(obj.piStatus, `${where}.piStatus`),
    retiredAt: requireNonNegativeInt(obj.retiredAt, `${where}.retiredAt`),
    predecessorAgentRunId: requireNullableId(obj.predecessorAgentRunId, `${where}.predecessorAgentRunId`),
    replacementAgentRunId: requireNullableId(obj.replacementAgentRunId, `${where}.replacementAgentRunId`),
    canPurge: obj.canPurge === true,
    purgeBlockedReason: requireNullableString(obj.purgeBlockedReason, `${where}.purgeBlockedReason`),
  }
}

export function validateAssignmentCard(value: unknown, where = 'assignment'): AssignmentCard {
  const obj = requireObject(value, where)
  const gateResult = obj.gateResult === null ? null : requireEnum(obj.gateResult, GATE_RESULTS, `${where}.gateResult`)
  if (requireNonNegativeInt(obj.correctionLimit, `${where}.correctionLimit`) > 3) throw new SchemaError('correction limit exceeds 3')
  if (requireNonNegativeInt(obj.correctionCount, `${where}.correctionCount`) > Number(obj.correctionLimit)) throw new SchemaError('correction count exceeds limit')
  return {
    assignmentId: requireId(obj.assignmentId, `${where}.assignmentId`),
    projectId: requireId(obj.projectId, `${where}.projectId`),
    goalId: requireId(obj.goalId, `${where}.goalId`),
    agentRunId: requireId(obj.agentRunId, `${where}.agentRunId`),
    goalText: requireManagedText(obj.goalText, `${where}.goalText`),
    state: requireDisplay(obj.state, `${where}.state`),
    attemptId: requireNullableId(obj.attemptId, `${where}.attemptId`),
    gateId: requireNullableId(obj.gateId, `${where}.gateId`),
    gateVersion: obj.gateVersion === null ? null : requireNonNegativeInt(obj.gateVersion, `${where}.gateVersion`),
    gateResult,
    candidateRef: requireNullableString(obj.candidateRef, `${where}.candidateRef`),
    correctionCount: requireNonNegativeInt(obj.correctionCount, `${where}.correctionCount`),
    correctionLimit: requireNonNegativeInt(obj.correctionLimit, `${where}.correctionLimit`),
    // General projections never carry validator output into QML.
    diagnostics: (requireNullableString(obj.diagnostics, `${where}.diagnostics`), null),
    artifactRefs: requireCollection(obj.artifactRefs, `${where}.artifactRefs`, (v, w) => requireDisplay(v, w)),
  }
}

export function validateActivityEntry(value: unknown, where = 'activity'): ActivityEntry {
  const obj = requireObject(value, where)
  return {
    eventId: requireId(obj.eventId, `${where}.eventId`),
    cursor: requireNonNegativeInt(obj.cursor, `${where}.cursor`),
    kind: requireDisplay(obj.kind, `${where}.kind`),
    reasonCode: requireNullableString(obj.reasonCode, `${where}.reasonCode`),
    label: requireDisplay(obj.label, `${where}.label`),
    createdAt: requireDisplay(obj.createdAt, `${where}.createdAt`),
  }
}

export function validateFixtureMarker(value: unknown, where = 'fixture'): FixtureMarker {
  const obj = requireObject(value, where)
  return {
    active: obj.active === true,
    label: requireDisplay(obj.label, `${where}.label`),
  }
}

// ---------------------------------------------------------------------------
// Snapshot / event / intent / feedback validators
// ---------------------------------------------------------------------------

export function validateSnapshot(value: unknown): WorkbenchSnapshot {
  const obj = requireObject(value, 'snapshot')
  requireProtocol(obj.protocol, 'snapshot')
  const sessionId = requireId(obj.sessionId, 'snapshot.sessionId')
  const pluginGeneration = requireNonNegativeInt(obj.pluginGeneration, 'snapshot.pluginGeneration')
  const runnerEpoch = requireNonNegativeInt(obj.runnerEpoch, 'snapshot.runnerEpoch')
  const revision = requireNonNegativeInt(obj.revision, 'snapshot.revision')
  const cursor = requireNonNegativeInt(obj.cursor, 'snapshot.cursor')
  const connection = requireEnum(obj.connection, CONNECTION_STATUSES, 'snapshot.connection')
  const selectedProjectId = requireNullableId(obj.selectedProjectId, 'snapshot.selectedProjectId')
  const selectedGoalId = requireNullableId(obj.selectedGoalId, 'snapshot.selectedGoalId')
  return {
    protocol: WORKBENCH_PROTOCOL,
    sessionId,
    pluginGeneration,
    runnerEpoch,
    revision,
    cursor,
    connection,
    projects: requireCollection(obj.projects, 'snapshot.projects', validateProjectSummary),
    goals: requireCollection(obj.goals, 'snapshot.goals', validateGoalSummary),
    selectedProjectId,
    selectedGoalId,
    managedAgents: requireCollection(obj.managedAgents, 'snapshot.managedAgents', validateManagedAgentCard),
    observedSessions: requireCollection(obj.observedSessions, 'snapshot.observedSessions', validateObservedSessionCard),
    retiredRuns: requireCollection(obj.retiredRuns, 'snapshot.retiredRuns', validateRetiredRunCard),
    assignments: requireCollection(obj.assignments, 'snapshot.assignments', validateAssignmentCard),
    activity: requireCollection(obj.activity, 'snapshot.activity', validateActivityEntry),
    capabilities: requireCollection(obj.capabilities, 'snapshot.capabilities', (v, w) => requireDisplay(v, w)),
    actions: requireCollection(obj.actions, 'snapshot.actions', validateAction),
    roles: requireCollection(obj.roles, 'snapshot.roles', (v, w) => requireDisplay(v, w)),
    checks: requireCollection(obj.checks, 'snapshot.checks', validateCheckSummary),
    fixture: validateFixtureMarker(obj.fixture, 'snapshot.fixture'),
    ...(obj.details === undefined ? {} : { details: requireCollection(obj.details, 'snapshot.details', validateDetail) }),
  }
}

export function validateEvent(value: unknown): WorkbenchEvent {
  const obj = requireObject(value, 'event')
  requireProtocol(obj.protocol, 'event')
  if (!['projection_update', 'agent_connected'].includes(String(obj.kind))) throw new SchemaError('unsupported event kind')
  if (Object.keys(requireObject(obj.payload, 'event.payload')).length !== 0) throw new SchemaError('event payload requires authoritative snapshot replacement')
  return {
    protocol: WORKBENCH_PROTOCOL,
    sessionId: requireId(obj.sessionId, 'event.sessionId'),
    runnerEpoch: requireNonNegativeInt(obj.runnerEpoch, 'event.runnerEpoch'),
    eventId: requireId(obj.eventId, 'event.eventId'),
    cursor: requireNonNegativeInt(obj.cursor, 'event.cursor'),
    baseRevision: requireNonNegativeInt(obj.baseRevision, 'event.baseRevision'),
    revision: requireNonNegativeInt(obj.revision, 'event.revision'),
    kind: requireDisplay(obj.kind, 'event.kind'),
    payload: requireObject(obj.payload, 'event.payload'),
  }
}

export function validateIntent(value: unknown): WorkbenchIntent {
  const obj = requireObject(value, 'intent')
  requireProtocol(obj.protocol, 'intent')
  const payloadFields: Record<string, string[]> = {
    select_project: ['projectId'], select_goal: ['goalId'], create_goal: ['projectId', 'goalText'],
    request_adoption: ['choiceId'], authorize_adoption: ['proposalId'],
    start_assignment: ['goalText', 'checkId', 'checkVersion'],
    configure_checks: ['projectId', 'checkId', 'checkVersion', 'name', 'summary', 'mode', 'commandSummary', 'definitionDraft'],
    take_control: ['assignmentId'], return_to_team: ['assignmentId'], accept: ['assignmentId'],
    resume: ['assignmentId'], retry: ['assignmentId'], retire: ['agentRunId'], purge: ['agentRunId'],
    stop: ['assignmentId'], recover: [], present: [],
  }
  const allowed = payloadFields[String(obj.kind)]
  if (!allowed) throw new SchemaError('unsupported intent kind')
  const payload = requireObject(obj.payload, 'intent.payload')
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) throw new SchemaError(`unknown intent payload field ${key}`)
  // Exact required fields: an omitted required field must reject, not default.
  for (const key of allowed) {
    if (!(key in payload)) throw new SchemaError(`missing intent payload field ${key}`)
  }
  for (const [key, item] of Object.entries(payload)) {
    if (key === 'definitionDraft') validateCheckDraft(item)
    else if (key === 'checkVersion') { requireNonNegativeInt(item, `intent.payload.${key}`); if (item === 0) throw new SchemaError('check version must be positive') }
    else if (key === 'mode') requireEnum(item, CHECK_MODES, `intent.payload.${key}`)
    else if (key === 'goalText') requireManagedText(item, `intent.payload.${key}`)
    else if (key.endsWith('Id')) requireId(item, `intent.payload.${key}`)
    else requireDisplay(item, `intent.payload.${key}`)
  }
  return {
    protocol: WORKBENCH_PROTOCOL,
    sessionId: requireId(obj.sessionId, 'intent.sessionId'),
    pluginGeneration: requireNonNegativeInt(obj.pluginGeneration, 'intent.pluginGeneration'),
    runnerEpoch: requireNonNegativeInt(obj.runnerEpoch, 'intent.runnerEpoch'),
    intentId: requireId(obj.intentId, 'intent.intentId'),
    expectedRevision: requireNonNegativeInt(obj.expectedRevision, 'intent.expectedRevision'),
    kind: requireDisplay(obj.kind, 'intent.kind'),
    target: requireNullableId(obj.target, 'intent.target'),
    payload: requireObject(obj.payload, 'intent.payload'),
  }
}

export function validateFeedback(value: unknown): WorkbenchFeedback {
  const obj = requireObject(value, 'feedback')
  return {
    intentId: requireId(obj.intentId, 'feedback.intentId'),
    sessionId: requireId(obj.sessionId, 'feedback.sessionId'),
    target: requireNullableId(obj.target, 'feedback.target'),
    originRevision: requireNonNegativeInt(obj.originRevision, 'feedback.originRevision'),
    status: requireEnum(obj.status, FEEDBACK_STATUSES, 'feedback.status'),
    reasonCode: requireNullableString(obj.reasonCode, 'feedback.reasonCode'),
    committedRevision: obj.committedRevision === null
      ? null
      : requireNonNegativeInt(obj.committedRevision, 'feedback.committedRevision'),
  }
}

/** Envelope byte bound guard for any serialized payload. */
export function assertEnvelopeBytes(encoded: string, where: string): void {
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new SchemaError(`${where} exceeds ${MAX_ENVELOPE_BYTES} encoded bytes`)
  }
}
