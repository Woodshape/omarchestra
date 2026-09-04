/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Shared, I/O-free contracts for the persistent Omarchestra Companion Plugin,
 * ephemeral Projection Sessions, and explicit Companion installation. All
 * filesystem, configuration, shell, authorization, clock, and digest effects
 * are represented by injected ports below.
 */

import {
  ROLES,
  isBoundedId,
  validateEventBody,
  validateSnapshotBody,
  type EventRecord,
  type Role,
  type SnapshotBody,
} from '../src/protocol.ts'
import type { AgentConsoleHandoff, ProjectionStatus } from '../console/projection-core.ts'

export type { EventRecord, Role, SnapshotBody } from '../src/protocol.ts'
export type { AgentConsoleHandoff, ProjectionStatus } from '../console/projection-core.ts'

export const COMPANION_PLUGIN_ID = 'omarchestra.agent-console'
export const COMPANION_PLUGIN_VERSION = '0.2.0'
export const COMPANION_PROTOCOL_ID = 'omarchestra.companion/v1'

export const SUPPORTED_COMPATIBILITY = Object.freeze({
  omarchy: '4.0.2-1',
  quickshell: '0.3.1-1',
} as const)

export interface CompanionCompatibility {
  omarchy: string
  quickshell: string
}

export const COMPANION_CAPABILITIES = Object.freeze([
  'session.open',
  'session.update',
  'session.intent',
  'session.hide',
  'session.clear',
  'session.resnapshot',
] as const)
/** Capability type for the unchanged managed Companion surface. */
export type CompanionBaselineCapability = (typeof COMPANION_CAPABILITIES)[number]

/** Additive observer capability; never part of the six managed capabilities. */
export const COMPANION_OBSERVER_CAPABILITY = 'session.observer'

/** All valid capabilities, including the additive observer capability. */
export const COMPANION_ALL_CAPABILITIES = Object.freeze([
  ...COMPANION_CAPABILITIES,
  COMPANION_OBSERVER_CAPABILITY,
] as const)
export type CompanionCapability = (typeof COMPANION_ALL_CAPABILITIES)[number]

export const COMPANION_LIMITS = Object.freeze({
  envelopeBytes: 16 * 1024,
  identifierCharacters: 128,
  detailCharacters: 1024,
  labelCharacters: 512,
  capabilityCount: COMPANION_ALL_CAPABILITIES.length,
  intentPayloadBytes: 4096,
  intentHistoryCount: 256,
  releaseAssetCount: 32,
  releaseAssetBytes: 128 * 1024,
  releaseTotalBytes: 512 * 1024,
  relativePathCharacters: 192,
})

export const COMPANION_ERROR_CODES = Object.freeze([
  'invalid_envelope',
  'envelope_too_large',
  'unsupported_protocol',
  'unsupported_capability',
  'plugin_not_installed',
  'stale_plugin_generation',
  'stale_projection_session',
  'invalid_projection_state',
  'invalid_intent',
  'duplicate_intent',
  'unsupported_compatibility',
  'invalid_release',
  'invalid_plan',
  'authorization_required',
  'authorization_mismatch',
  'stale_precondition',
  'unsafe_path',
  'foreign_installation',
  'invalid_receipt',
  'configuration_conflict',
  'postcondition_failed',
  'operation_failed',
  'incomplete_recovery',
] as const)
export type CompanionErrorCode = (typeof COMPANION_ERROR_CODES)[number]

export class CompanionError extends Error {
  readonly code: CompanionErrorCode
  readonly detail: string

  constructor(code: CompanionErrorCode, detail: string) {
    super(`companion error [${code}]: ${detail}`)
    this.name = 'CompanionError'
    this.code = code
    this.detail = detail
  }
}

export class CompanionProtocolError extends CompanionError {
  constructor(code: Extract<CompanionErrorCode, 'invalid_envelope' | 'envelope_too_large' | 'unsupported_protocol'>, detail: string) {
    super(code, detail)
    this.name = 'CompanionProtocolError'
  }
}

export class CompanionCapabilityError extends CompanionError {
  constructor(detail: string) {
    super('unsupported_capability', detail)
    this.name = 'CompanionCapabilityError'
  }
}

export class CompanionPluginUnavailableError extends CompanionError {
  constructor(detail = `plugin ${COMPANION_PLUGIN_ID} is not installed`) {
    super('plugin_not_installed', detail)
    this.name = 'CompanionPluginUnavailableError'
  }
}

export class StalePluginGenerationError extends CompanionError {
  constructor(detail: string) {
    super('stale_plugin_generation', detail)
    this.name = 'StalePluginGenerationError'
  }
}

export class StaleProjectionSessionError extends CompanionError {
  constructor(detail: string) {
    super('stale_projection_session', detail)
    this.name = 'StaleProjectionSessionError'
  }
}

export class CompanionIntentError extends CompanionError {
  constructor(code: Extract<CompanionErrorCode, 'invalid_intent' | 'duplicate_intent' | 'invalid_projection_state'>, detail: string) {
    super(code, detail)
    this.name = 'CompanionIntentError'
  }
}

export class CompanionInstallationError extends CompanionError {
  constructor(code: Exclude<CompanionErrorCode,
    | 'invalid_envelope'
    | 'envelope_too_large'
    | 'unsupported_protocol'
    | 'unsupported_capability'
    | 'plugin_not_installed'
    | 'stale_plugin_generation'
    | 'stale_projection_session'
    | 'invalid_projection_state'
    | 'invalid_intent'
    | 'duplicate_intent'
    | 'incomplete_recovery'>, detail: string) {
    super(code, detail)
    this.name = 'CompanionInstallationError'
  }
}

export class CompanionCompatibilityError extends CompanionInstallationError {
  constructor(detail: string) {
    super('unsupported_compatibility', detail)
    this.name = 'CompanionCompatibilityError'
  }
}

export class IncompleteRecoveryError extends CompanionError {
  readonly recovery: IncompleteRecovery

  constructor(detail: string, recovery: IncompleteRecovery) {
    super('incomplete_recovery', detail)
    this.name = 'IncompleteRecoveryError'
    this.recovery = recovery
  }
}

// ---------------------------------------------------------------------------
// Persistent plugin and ephemeral Projection Session protocol
// ---------------------------------------------------------------------------

export interface CompanionCapabilitiesEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  pluginId: string
  version: string
  pluginGeneration: number
  capabilities: CompanionCapability[]
}

/** Identity is scoped to one open and is never installation authority. */
export interface ProjectionSessionIdentity {
  sessionId: string
  teamGoalId: string
  clientId: string
  sessionGeneration: number
  pluginGeneration: number
}

export interface CompanionOpenEnvelope extends ProjectionSessionIdentity {
  protocol: typeof COMPANION_PROTOCOL_ID
  projection: AgentConsoleHandoff
}

export interface CompanionAuthoritativeSnapshotEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'authoritative_snapshot'
  session: ProjectionSessionIdentity
  snapshot: SnapshotBody
}

export interface CompanionOrderedUpdateEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'ordered_update'
  session: ProjectionSessionIdentity
  update: EventRecord
}

export interface CompanionResnapshotEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'resnapshot'
  session: ProjectionSessionIdentity
  snapshot: SnapshotBody
}

export interface CompanionProjectionApplyEnvelope extends ProjectionSessionIdentity, AgentConsoleHandoff {
  protocol: typeof COMPANION_PROTOCOL_ID
}

export type CompanionIntentKind = 'present_agent'

export interface CompanionIntentEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'intent'
  session: ProjectionSessionIdentity
  intentId: string
  kind: CompanionIntentKind
  role: Role
  payload: Record<string, unknown>
}

export const COMPANION_INTENT_RESULTS = Object.freeze([
  'accepted',
  'invalid',
  'duplicate',
  'unavailable',
] as const)
export type CompanionIntentResult = (typeof COMPANION_INTENT_RESULTS)[number]

export interface CompanionIntentAcknowledgementEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'intent_ack'
  session: ProjectionSessionIdentity
  intentId: string
  result: CompanionIntentResult
  detail: string | null
}

export interface CompanionHideEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'hide'
  session: ProjectionSessionIdentity
}

export interface CompanionClearEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'clear'
  session: ProjectionSessionIdentity
}

export interface CompanionReconnectEnvelope {
  protocol: typeof COMPANION_PROTOCOL_ID
  type: 'reconnect'
  session: ProjectionSessionIdentity
  resumeAfter: number | null
  reason: string
}

export type CompanionSessionEnvelope =
  | CompanionAuthoritativeSnapshotEnvelope
  | CompanionOrderedUpdateEnvelope
  | CompanionResnapshotEnvelope
  | CompanionIntentEnvelope
  | CompanionIntentAcknowledgementEnvelope
  | CompanionHideEnvelope
  | CompanionClearEnvelope
  | CompanionReconnectEnvelope

export interface CompanionShellPort {
  capabilities(pluginId: string): MaybePromise<CompanionCapabilitiesEnvelope>
  summon(pluginId: string, payloadJson: string): MaybePromise<void>
  call(
    pluginId: string,
    method: 'applyHandoff' | 'clear' | 'intentResult' | 'takeIntent' | 'applyObservedAgents',
    payloadJson: string,
  ): MaybePromise<void | string>
  hide(pluginId: string, payloadJson: string): MaybePromise<void>
}

export function assertSupportedCompatibility(value: CompanionCompatibility): void {
  if (
    value.omarchy !== SUPPORTED_COMPATIBILITY.omarchy ||
    value.quickshell !== SUPPORTED_COMPATIBILITY.quickshell
  ) {
    throw new CompanionCompatibilityError(
      `unsupported host compatibility Omarchy ${String(value.omarchy)}, Quickshell ${String(value.quickshell)}; ` +
      `this prototype supports exactly Omarchy ${SUPPORTED_COMPATIBILITY.omarchy} and Quickshell ${SUPPORTED_COMPATIBILITY.quickshell}`,
    )
  }
}

export function validateCapabilitiesEnvelope(input: unknown): CompanionCapabilitiesEnvelope {
  const value = exactObject(input, ['protocol', 'pluginId', 'version', 'pluginGeneration', 'capabilities'], 'capabilities')
  requireProtocol(value.protocol, 'capabilities protocol')
  const capabilities = requireCapabilityArray(value.capabilities)
  const result: CompanionCapabilitiesEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    pluginId: requireId(value.pluginId, 'capabilities pluginId'),
    version: requireVersion(value.version, 'capabilities version'),
    pluginGeneration: requirePositiveInteger(value.pluginGeneration, 'capabilities pluginGeneration'),
    capabilities,
  }
  assertBoundedEnvelope(result, 'capabilities')
  return result
}

export function assertRequiredCapabilities(input: readonly CompanionCapability[]): void {
  const missing = COMPANION_CAPABILITIES.filter((capability) => !input.includes(capability))
  if (missing.length > 0) {
    throw new CompanionCapabilityError(`missing required Companion capabilities: ${missing.join(', ')}`)
  }
}

export function validateProjectionSessionIdentity(input: unknown): ProjectionSessionIdentity {
  const value = exactObject(
    input,
    ['sessionId', 'teamGoalId', 'clientId', 'sessionGeneration', 'pluginGeneration'],
    'Projection Session identity',
  )
  return {
    sessionId: requireId(value.sessionId, 'sessionId'),
    teamGoalId: requireId(value.teamGoalId, 'teamGoalId'),
    clientId: requireId(value.clientId, 'clientId'),
    sessionGeneration: requirePositiveInteger(value.sessionGeneration, 'sessionGeneration'),
    pluginGeneration: requirePositiveInteger(value.pluginGeneration, 'pluginGeneration'),
  }
}

export function validateOpenEnvelope(input: unknown): CompanionOpenEnvelope {
  const value = exactObject(input, [
    'protocol', 'sessionId', 'teamGoalId', 'clientId', 'sessionGeneration', 'pluginGeneration', 'projection',
  ], 'open')
  requireProtocol(value.protocol, 'open protocol')
  const session = validateProjectionSessionIdentity({
    sessionId: value.sessionId,
    teamGoalId: value.teamGoalId,
    clientId: value.clientId,
    sessionGeneration: value.sessionGeneration,
    pluginGeneration: value.pluginGeneration,
  })
  const projection = validateHandoff(value.projection, 'open projection')
  const result = { protocol: COMPANION_PROTOCOL_ID, ...session, projection } satisfies CompanionOpenEnvelope
  assertBoundedEnvelope(result, 'open')
  return result
}

export function validateAuthoritativeSnapshotEnvelope(input: unknown): CompanionAuthoritativeSnapshotEnvelope {
  const value = validateSessionEnvelope(input, 'authoritative_snapshot', ['snapshot'])
  const snapshot = validateSnapshotBody(value.snapshot)
  if (snapshot.teamGoal.id !== value.session.teamGoalId) {
    throw new CompanionProtocolError('invalid_envelope', 'authoritative snapshot Team Goal does not match its session')
  }
  const result: CompanionAuthoritativeSnapshotEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'authoritative_snapshot',
    session: value.session,
    snapshot,
  }
  assertBoundedEnvelope(result, 'authoritative snapshot')
  return result
}

export function validateOrderedUpdateEnvelope(input: unknown): CompanionOrderedUpdateEnvelope {
  const value = validateSessionEnvelope(input, 'ordered_update', ['update'])
  const result: CompanionOrderedUpdateEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'ordered_update',
    session: value.session,
    update: validateEventBody(value.update),
  }
  assertBoundedEnvelope(result, 'ordered update')
  return result
}

export function validateResnapshotEnvelope(input: unknown): CompanionResnapshotEnvelope {
  const value = validateSessionEnvelope(input, 'resnapshot', ['snapshot'])
  const snapshot = validateSnapshotBody(value.snapshot)
  if (snapshot.teamGoal.id !== value.session.teamGoalId) {
    throw new CompanionProtocolError('invalid_envelope', 'resnapshot Team Goal does not match its session')
  }
  const result: CompanionResnapshotEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'resnapshot',
    session: value.session,
    snapshot,
  }
  assertBoundedEnvelope(result, 'resnapshot')
  return result
}

export function validateProjectionApplyEnvelope(input: unknown): CompanionProjectionApplyEnvelope {
  const value = exactObject(input, [
    'protocol', 'sessionId', 'teamGoalId', 'clientId', 'sessionGeneration', 'pluginGeneration',
    'status', 'cursor', 'cards',
  ], 'projection apply')
  requireProtocol(value.protocol, 'projection apply protocol')
  const session = validateProjectionSessionIdentity({
    sessionId: value.sessionId,
    teamGoalId: value.teamGoalId,
    clientId: value.clientId,
    sessionGeneration: value.sessionGeneration,
    pluginGeneration: value.pluginGeneration,
  })
  const handoff = validateHandoff({ status: value.status, cursor: value.cursor, cards: value.cards }, 'projection apply')
  const result = { protocol: COMPANION_PROTOCOL_ID, ...session, ...handoff } satisfies CompanionProjectionApplyEnvelope
  assertBoundedEnvelope(result, 'projection apply')
  return result
}

export function validateIntentEnvelope(input: unknown): CompanionIntentEnvelope {
  const value = exactObject(input, ['protocol', 'type', 'session', 'intentId', 'kind', 'role', 'payload'], 'intent')
  requireProtocol(value.protocol, 'intent protocol')
  if (value.type !== 'intent' || value.kind !== 'present_agent') {
    throw new CompanionIntentError('invalid_intent', 'intent type and kind must be intent/present_agent')
  }
  const payload = requireJsonObject(value.payload, 'intent payload', COMPANION_LIMITS.intentPayloadBytes)
  const result: CompanionIntentEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'intent',
    session: validateProjectionSessionIdentity(value.session),
    intentId: requireId(value.intentId, 'intentId'),
    kind: 'present_agent',
    role: requireRole(value.role, 'intent role'),
    payload,
  }
  assertBoundedEnvelope(result, 'intent')
  return result
}

export function validateIntentAcknowledgementEnvelope(input: unknown): CompanionIntentAcknowledgementEnvelope {
  const value = exactObject(input, ['protocol', 'type', 'session', 'intentId', 'result', 'detail'], 'intent acknowledgement')
  requireProtocol(value.protocol, 'intent acknowledgement protocol')
  if (value.type !== 'intent_ack') {
    throw new CompanionProtocolError('invalid_envelope', 'intent acknowledgement type must be intent_ack')
  }
  const result = requireOneOf(value.result, COMPANION_INTENT_RESULTS, 'intent acknowledgement result')
  const detail = value.detail === null ? null : requireString(value.detail, 'intent acknowledgement detail', COMPANION_LIMITS.detailCharacters)
  const validated: CompanionIntentAcknowledgementEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'intent_ack',
    session: validateProjectionSessionIdentity(value.session),
    intentId: requireId(value.intentId, 'intent acknowledgement intentId'),
    result,
    detail,
  }
  assertBoundedEnvelope(validated, 'intent acknowledgement')
  return validated
}

export function validateHideEnvelope(input: unknown): CompanionHideEnvelope {
  return validateControlEnvelope(input, 'hide')
}

export function validateClearEnvelope(input: unknown): CompanionClearEnvelope {
  return validateControlEnvelope(input, 'clear')
}

export function validateReconnectEnvelope(input: unknown): CompanionReconnectEnvelope {
  const value = validateSessionEnvelope(input, 'reconnect', ['resumeAfter', 'reason'])
  const resumeAfter = value.resumeAfter === null
    ? null
    : requireNonNegativeInteger(value.resumeAfter, 'reconnect resumeAfter')
  const result: CompanionReconnectEnvelope = {
    protocol: COMPANION_PROTOCOL_ID,
    type: 'reconnect',
    session: value.session,
    resumeAfter,
    reason: requireString(value.reason, 'reconnect reason', COMPANION_LIMITS.detailCharacters),
  }
  assertBoundedEnvelope(result, 'reconnect')
  return result
}

export function assertPluginGeneration(expected: number, received: number): void {
  requirePositiveInteger(expected, 'expected plugin generation')
  requirePositiveInteger(received, 'received plugin generation')
  if (received !== expected) {
    throw new StalePluginGenerationError(
      `plugin generation ${received} does not match current generation ${expected}`,
    )
  }
}

export function assertCurrentSession(
  expected: ProjectionSessionIdentity,
  received: ProjectionSessionIdentity,
): void {
  assertPluginGeneration(expected.pluginGeneration, received.pluginGeneration)
  if (
    received.sessionId !== expected.sessionId ||
    received.sessionGeneration !== expected.sessionGeneration ||
    received.teamGoalId !== expected.teamGoalId ||
    received.clientId !== expected.clientId
  ) {
    throw new StaleProjectionSessionError('Projection Session identity does not match the active session')
  }
}

// ---------------------------------------------------------------------------
// Explicit installation contract
// ---------------------------------------------------------------------------

export type InstallationOperation = 'install' | 'update' | 'rollback' | 'uninstall'

export interface CompanionRelease {
  pluginId: string
  version: string
  protocol: typeof COMPANION_PROTOCOL_ID
  compatibility: CompanionCompatibility
  assets: Readonly<Record<string, string>>
}

export interface InstallationPrecondition {
  hostCompatibilityDigest: string
  pluginTreeDigest: string
  receiptDigest: string
  shellJsonDigest: string
}

export interface CompanionInstallationPlan {
  schemaVersion: 1
  operation: InstallationOperation
  pluginId: string
  release: CompanionRelease | null
  compatibility: CompanionCompatibility
  precondition: InstallationPrecondition
  planDigest: string
  inspectedAt: string
}

export interface CompanionInstallationAuthorization {
  operation: InstallationOperation
  planDigest: string
  authorizationId: string
  token: string
}

export interface CompanionAssetReceipt {
  relativePath: string
  path: string
  sha256: string
  owner: string
  mode: number
  device: number
  inode: number
}

export interface CompanionShellJsonReceipt {
  preimageHash: string
  postimageHash: string
  preimageBytes: string
  postimageBytes: string
}

export interface CompanionInstallationReceipt {
  schemaVersion: 1
  pluginId: string
  release: CompanionRelease
  previousRelease: CompanionRelease | null
  compatibility: CompanionCompatibility
  planDigest: string
  installedAt: string
  assets: CompanionAssetReceipt[]
  shellJson: CompanionShellJsonReceipt
}

export interface CompanionInstallationResult {
  operation: InstallationOperation
  pluginId: string
  version: string | null
  planDigest: string
  completedAt: string
}

export type FilesystemNodeKind = 'file' | 'directory' | 'symlink' | 'missing'

export interface FilesystemIdentity {
  path: string
  kind: FilesystemNodeKind
  owner: string | null
  mode: number | null
  device: number | null
  inode: number | null
  size: number | null
}

export interface CompanionFilesystemPort {
  inspectNoFollow(path: string): MaybePromise<FilesystemIdentity>
  listDirectoryNoFollow(path: string): MaybePromise<string[]>
  readBytesNoFollow(path: string): MaybePromise<string>
  ensureDirectory(path: string, owner: string, mode: number): MaybePromise<void>
  writeBytesAtomic(path: string, bytes: string, owner: string, mode: number): MaybePromise<void>
  renameExact(from: FilesystemIdentity, toPath: string): MaybePromise<void>
  removeFileExact(identity: FilesystemIdentity): MaybePromise<void>
  removeDirectoryExact(identity: FilesystemIdentity): MaybePromise<void>
}

export interface PluginConfigurationEntry {
  pluginId: string
  source: string | null
  enabled: boolean
}

export interface CompanionConfigurationSnapshot {
  shellJsonBytes: string
  shellJsonSha256: string
  entries: PluginConfigurationEntry[]
}

/** Read/inspect only. Supported shell enable/disable owns configuration writes. */
export interface CompanionConfigurationPort {
  inspect(): MaybePromise<CompanionConfigurationSnapshot>
}

export interface CompanionInstallationShellPort {
  rescan(pluginId: string): MaybePromise<void>
  enable(pluginId: string): MaybePromise<void>
  disable(pluginId: string): MaybePromise<void>
}

export interface CompanionReceiptPort {
  inspectNoFollow(pluginId: string): MaybePromise<{
    identity: FilesystemIdentity
    bytes: string
  } | null>
  writeAtomic(pluginId: string, bytes: string, owner: string, mode: number): MaybePromise<void>
  removeExact(pluginId: string, identity: FilesystemIdentity): MaybePromise<void>
}

export interface CompanionAuthorizationPort {
  verify(authorization: CompanionInstallationAuthorization, plan: CompanionInstallationPlan): MaybePromise<boolean>
}

export interface CompanionHostPort {
  compatibility(): MaybePromise<CompanionCompatibility>
  currentOwner(): MaybePromise<string>
}

export interface CompanionDigestPort {
  sha256(bytes: string): string
  stableDigest(value: unknown): string
}

export interface CompanionClockPort {
  now(): string
}

export interface CompanionInstallationPorts {
  filesystem: CompanionFilesystemPort
  configuration: CompanionConfigurationPort
  shell: CompanionInstallationShellPort
  receipts: CompanionReceiptPort
  authorization: CompanionAuthorizationPort
  host: CompanionHostPort
  digest: CompanionDigestPort
  clock: CompanionClockPort
  paths: {
    pluginsRoot: string
    pluginRoot: string
    receiptPath: string
    asset(relativePath: string): string
  }
  mutations?: CompanionMutationSink
  recovery?: CompanionRecoverySink
}

export type CompanionMutationOperation =
  | 'mkdir'
  | 'write_asset'
  | 'remove_asset'
  | 'rename'
  | 'write_receipt'
  | 'remove_receipt'
  | 'rescan'
  | 'enable'
  | 'disable'

export interface CompanionMutationRecord {
  sequence: number
  operation: CompanionMutationOperation
  path: string | null
  pluginId: string
  planDigest: string
  detail: Readonly<Record<string, unknown>>
}

export interface CompanionMutationSink {
  record(mutation: CompanionMutationRecord): void
}

export interface CompleteRecovery {
  complete: true
  incomplete: false
  operation: InstallationOperation
  planDigest: string
  restoredStateDigest: string
}

export interface IncompleteRecovery {
  complete: false
  incomplete: true
  operation: InstallationOperation
  planDigest: string
  reason: string
  expectedStateDigest: string
  observedStateDigest: string
  preservedDriftPaths: string[]
}

export type CompanionRecovery = CompleteRecovery | IncompleteRecovery

export interface CompanionRecoverySink {
  record(recovery: CompanionRecovery): void
}

export function validateCompanionRelease(input: unknown): CompanionRelease {
  const value = exactObject(input, ['pluginId', 'version', 'protocol', 'compatibility', 'assets'], 'Companion release')
  requireProtocol(value.protocol, 'release protocol')
  const compatibilityValue = exactObject(value.compatibility, ['omarchy', 'quickshell'], 'release compatibility')
  const compatibility = {
    omarchy: requireVersion(compatibilityValue.omarchy, 'release Omarchy compatibility'),
    quickshell: requireVersion(compatibilityValue.quickshell, 'release Quickshell compatibility'),
  }
  assertSupportedCompatibility(compatibility)
  const assetsValue = requirePlainObject(value.assets, 'release assets')
  const entries = Object.entries(assetsValue)
  if (entries.length === 0 || entries.length > COMPANION_LIMITS.releaseAssetCount) {
    throw new CompanionInstallationError('invalid_release', 'release assets must be a non-empty bounded map')
  }
  const assets: Record<string, string> = {}
  let totalBytes = 0
  for (const [relativePath, bytes] of entries) {
    requireRelativeAssetPath(relativePath)
    if (typeof bytes !== 'string') {
      throw new CompanionInstallationError('invalid_release', `release asset ${relativePath} must contain string bytes`)
    }
    const size = utf8Bytes(bytes)
    if (size > COMPANION_LIMITS.releaseAssetBytes) {
      throw new CompanionInstallationError('invalid_release', `release asset ${relativePath} exceeds its byte bound`)
    }
    totalBytes += size
    assets[relativePath] = bytes
  }
  if (totalBytes > COMPANION_LIMITS.releaseTotalBytes) {
    throw new CompanionInstallationError('invalid_release', 'release assets exceed the total byte bound')
  }
  if (!Object.hasOwn(assets, 'manifest.json') || !Object.hasOwn(assets, 'AgentConsole.qml')) {
    throw new CompanionInstallationError('invalid_release', 'release requires manifest.json and AgentConsole.qml')
  }
  return {
    pluginId: requireExactPluginId(value.pluginId),
    version: requireVersion(value.version, 'release version'),
    protocol: COMPANION_PROTOCOL_ID,
    compatibility,
    assets,
  }
}

export function freezeCompanionRelease(input: unknown): CompanionRelease {
  const release = validateCompanionRelease(input)
  Object.freeze(release.compatibility)
  Object.freeze(release.assets)
  return Object.freeze(release)
}

export function assertSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new CompanionInstallationError('invalid_receipt', `${field} must be a lowercase SHA-256 digest`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Validation internals. These perform no I/O and reject unknown fields.
// ---------------------------------------------------------------------------

export type MaybePromise<T> = T | Promise<T>

type SessionEnvelopeParts = Record<string, unknown> & {
  session: ProjectionSessionIdentity
}

function validateSessionEnvelope(
  input: unknown,
  type: CompanionSessionEnvelope['type'],
  bodyFields: readonly string[],
): SessionEnvelopeParts {
  const value = exactObject(input, ['protocol', 'type', 'session', ...bodyFields], type)
  requireProtocol(value.protocol, `${type} protocol`)
  if (value.type !== type) {
    throw new CompanionProtocolError('invalid_envelope', `${type} envelope has a mismatched type`)
  }
  return { ...value, session: validateProjectionSessionIdentity(value.session) }
}

function validateControlEnvelope<T extends 'hide' | 'clear'>(input: unknown, type: T):
  T extends 'hide' ? CompanionHideEnvelope : CompanionClearEnvelope {
  const value = validateSessionEnvelope(input, type, [])
  const result = { protocol: COMPANION_PROTOCOL_ID, type, session: value.session }
  assertBoundedEnvelope(result, type)
  return result as T extends 'hide' ? CompanionHideEnvelope : CompanionClearEnvelope
}

function validateHandoff(input: unknown, where: string): AgentConsoleHandoff {
  const value = exactObject(input, ['status', 'cursor', 'cards'], where)
  const status = requireOneOf(value.status, ['ready', 'reconnecting', 'gap'] as const, `${where} status`) as ProjectionStatus
  const cursor = requireNonNegativeInteger(value.cursor, `${where} cursor`)
  if (!Array.isArray(value.cards) || value.cards.length !== ROLES.length) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must contain exactly three cards`)
  }
  const cards = value.cards.map((inputCard, index) => {
    const card = exactObject(inputCard, ['role', 'agentRunId', 'piStatus'], `${where} card ${index}`)
    return {
      role: requireRole(card.role, `${where} card ${index} role`),
      agentRunId: requireId(card.agentRunId, `${where} card ${index} agentRunId`),
      piStatus: requireString(card.piStatus, `${where} card ${index} piStatus`, COMPANION_LIMITS.labelCharacters),
    }
  })
  if (new Set(cards.map((card) => card.role)).size !== ROLES.length) {
    throw new CompanionProtocolError('invalid_envelope', `${where} card roles must be unique`)
  }
  return { status, cursor, cards }
}

function exactObject(input: unknown, fields: readonly string[], where: string): Record<string, unknown> {
  const value = requirePlainObject(input, where)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new CompanionProtocolError('invalid_envelope', `${where} fields must be exactly ${expected.join(', ')}`)
  }
  return value
}

function requirePlainObject(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function requireJsonObject(input: unknown, where: string, maxBytes: number): Record<string, unknown> {
  const value = requirePlainObject(input, where)
  assertJsonValue(value, where, 0)
  if (utf8Bytes(safeJson(value, where)) > maxBytes) {
    throw new CompanionProtocolError('envelope_too_large', `${where} exceeds ${maxBytes} bytes`)
  }
  return value
}

function assertJsonValue(input: unknown, where: string, depth: number): void {
  if (depth > 8) throw new CompanionProtocolError('invalid_envelope', `${where} exceeds the nesting bound`)
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return
  if (typeof input === 'number' && Number.isFinite(input)) return
  if (Array.isArray(input)) {
    if (input.length > 256) throw new CompanionProtocolError('invalid_envelope', `${where} array exceeds 256 items`)
    input.forEach((item, index) => assertJsonValue(item, `${where}[${index}]`, depth + 1))
    return
  }
  const object = requirePlainObject(input, where)
  const entries = Object.entries(object)
  if (entries.length > 64) throw new CompanionProtocolError('invalid_envelope', `${where} object exceeds 64 fields`)
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 128) {
      throw new CompanionProtocolError('invalid_envelope', `${where} has an invalid field name`)
    }
    assertJsonValue(item, `${where}.${key}`, depth + 1)
  }
}

function requireProtocol(input: unknown, where: string): asserts input is typeof COMPANION_PROTOCOL_ID {
  if (input !== COMPANION_PROTOCOL_ID) {
    throw new CompanionProtocolError('unsupported_protocol', `${where} must be ${COMPANION_PROTOCOL_ID}`)
  }
}

function requireCapabilityArray(input: unknown): CompanionCapability[] {
  if (!Array.isArray(input) || input.length > COMPANION_LIMITS.capabilityCount) {
    throw new CompanionCapabilityError('capabilities must be a bounded array')
  }
  const capabilities = input.map((value) => requireOneOf(value, COMPANION_ALL_CAPABILITIES, 'capability'))
  if (new Set(capabilities).size !== capabilities.length) {
    throw new CompanionCapabilityError('capabilities must not contain duplicates')
  }
  return capabilities
}

function requireExactPluginId(input: unknown): string {
  const pluginId = requireId(input, 'pluginId')
  if (pluginId !== COMPANION_PLUGIN_ID) {
    throw new CompanionInstallationError('invalid_release', `pluginId must be ${COMPANION_PLUGIN_ID}`)
  }
  return pluginId
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a bounded ASCII identifier`)
  }
  return input
}

function requireVersion(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(input)) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a bounded version identifier`)
  }
  return input
}

function requirePositiveInteger(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a positive safe integer`)
  }
  return input
}

function requireNonNegativeInteger(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a non-negative safe integer`)
  }
  return input
}

function requireString(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > maxCharacters) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be a non-empty string of at most ${maxCharacters} characters`)
  }
  return input
}

function requireRole(input: unknown, where: string): Role {
  return requireOneOf(input, ROLES, where)
}

function requireOneOf<T extends string>(input: unknown, choices: readonly T[], where: string): T {
  if (typeof input !== 'string' || !(choices as readonly string[]).includes(input)) {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be one of ${choices.join(', ')}`)
  }
  return input as T
}

function requireRelativeAssetPath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.length > COMPANION_LIMITS.relativePathCharacters ||
    relativePath.startsWith('/') ||
    relativePath.endsWith('/') ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    !/^[A-Za-z0-9._/-]+$/.test(relativePath)
  ) {
    throw new CompanionInstallationError('invalid_release', `unsafe release asset path ${relativePath}`)
  }
}

function assertBoundedEnvelope(input: unknown, where: string): void {
  const bytes = utf8Bytes(safeJson(input, where))
  if (bytes > COMPANION_LIMITS.envelopeBytes) {
    throw new CompanionProtocolError('envelope_too_large', `${where} exceeds ${COMPANION_LIMITS.envelopeBytes} bytes`)
  }
}

function safeJson(input: unknown, where: string): string {
  try {
    const encoded = JSON.stringify(input)
    if (encoded === undefined) throw new Error('not JSON')
    return encoded
  } catch {
    throw new CompanionProtocolError('invalid_envelope', `${where} must be finite, acyclic JSON data`)
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
