/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Sole policy owner for explicit Companion Plugin installation. The module is
 * deliberately port-only: it performs no direct filesystem, shell, or process
 * operations. The separately authorized live procedure supplies the
 * ports; automated tests use fake-omarchy.ts.
 */

import path from 'node:path'

import {
  assertSha256,
  assertSupportedCompatibility,
  COMPANION_LIMITS,
  COMPANION_PLUGIN_ID,
  CompanionError,
  CompanionInstallationError,
  CompanionCompatibilityError,
  IncompleteRecoveryError,
  freezeCompanionRelease,
  type CompanionAssetReceipt,
  type CompanionCompatibility,
  type CompanionConfigurationSnapshot,
  type CompanionInstallationAuthorization,
  type CompanionInstallationPlan,
  type CompanionInstallationPorts,
  type CompanionInstallationReceipt,
  type CompanionInstallationResult,
  type CompanionMutationOperation,
  type CompanionRecovery,
  type CompanionRelease,
  type FilesystemIdentity,
  type InstallationOperation,
  type PluginConfigurationEntry,
} from './contracts.ts'

const POSIX = path.posix

export const PLUGIN_DIRECTORY_MODE = 0o755
export const PLUGIN_ASSET_MODE = 0o644
export const RECEIPT_FILE_MODE = 0o600

const INSTALLATION_OPERATIONS: readonly InstallationOperation[] = [
  'install',
  'update',
  'rollback',
  'uninstall',
]

interface TreeEntry {
  identity: FilesystemIdentity
  bytes: string | null
}

interface TreeSnapshot {
  entries: TreeEntry[]
}

interface ReceiptObservation {
  identity: FilesystemIdentity
  bytes: string
}

interface StateSnapshot {
  compatibility: CompanionCompatibility
  tree: TreeSnapshot
  receipt: ReceiptObservation | null
  configuration: CompanionConfigurationSnapshot
}

interface StagedEntry {
  source: TreeEntry
  destinationPath: string
}

interface ActiveStage {
  rootPath: string
  entries: StagedEntry[]
  snapshot: TreeSnapshot | null
}

interface FaultPort {
  checkpoint(point: string): void
  beforeRecovery(): void
}

type InstallationPorts = CompanionInstallationPorts & { faults?: FaultPort }

interface ValidatedReceipt {
  value: CompanionInstallationReceipt
  observation: ReceiptObservation
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function sameCompatibility(left: CompanionCompatibility, right: CompanionCompatibility): boolean {
  return left.omarchy === right.omarchy && left.quickshell === right.quickshell
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.owner === right.owner
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    )
  }
  return value
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(stableValue(value))
  if (encoded === undefined) throw new CompanionInstallationError('invalid_plan', 'value is not JSON serializable')
  return encoded
}

function requireObject(
  value: unknown,
  detail: string,
  code: 'invalid_plan' | 'invalid_receipt' | 'invalid_release' = 'invalid_plan',
): Record<string, unknown> {
  if (!isPlainObject(value)) throw new CompanionInstallationError(code, detail)
  return value
}

function requireExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  detail: string,
  code: 'invalid_plan' | 'invalid_receipt' = 'invalid_receipt',
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new CompanionInstallationError(code, `${detail} fields must be exactly ${wanted.join(', ')}`)
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CompanionInstallationError('invalid_receipt', `${field} must be a non-empty string`)
  }
  return value
}

function requirePlanString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CompanionInstallationError('invalid_plan', `${field} must be a non-empty string`)
  }
  return value
}

function requireMode(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o7777) {
    throw new CompanionInstallationError('invalid_receipt', `${field} must be a file mode`)
  }
  return value
}

function requireIdentityNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CompanionInstallationError('invalid_receipt', `${field} must be a safe integer`)
  }
  return value
}

function relativeTo(root: string, input: string): string {
  return POSIX.relative(root, input)
}

function isSafeAssetPath(relativePath: string): boolean {
  return relativePath.length > 0
    && relativePath.length <= COMPANION_LIMITS.relativePathCharacters
    && !relativePath.startsWith('/')
    && !relativePath.endsWith('/')
    && !relativePath.includes('\\')
    && /^[A-Za-z0-9._/-]+$/.test(relativePath)
    && relativePath.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function expectedDirectories(release: CompanionRelease): Set<string> {
  const result = new Set<string>([''])
  for (const relativePath of Object.keys(release.assets)) {
    let current = POSIX.dirname(relativePath)
    while (current !== '.' && current !== '') {
      result.add(current)
      current = POSIX.dirname(current)
    }
  }
  return result
}

function expectedAssetPaths(release: CompanionRelease): Set<string> {
  return new Set(Object.keys(release.assets))
}

function entryAt(tree: TreeSnapshot, input: string): TreeEntry | undefined {
  return tree.entries.find((entry) => entry.identity.path === input)
}

function pathIsWithin(root: string, input: string): boolean {
  return input === root || input.startsWith(`${root}/`)
}

function sameTree(left: TreeSnapshot, right: TreeSnapshot): boolean {
  if (left.entries.length !== right.entries.length) return false
  const rightByPath = new Map(right.entries.map((entry) => [entry.identity.path, entry]))
  return left.entries.every((entry) => {
    const counterpart = rightByPath.get(entry.identity.path)
    return counterpart !== undefined
      && sameIdentity(entry.identity, counterpart.identity)
      && entry.bytes === counterpart.bytes
  })
}

function treeDriftPaths(expected: TreeSnapshot, observed: TreeSnapshot): string[] {
  const result = new Set<string>()
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.identity.path, entry]))
  const observedByPath = new Map(observed.entries.map((entry) => [entry.identity.path, entry]))
  for (const pathValue of new Set([...expectedByPath.keys(), ...observedByPath.keys()])) {
    const left = expectedByPath.get(pathValue)
    const right = observedByPath.get(pathValue)
    if (left === undefined || right === undefined || !sameIdentity(left.identity, right.identity) || left.bytes !== right.bytes) {
      result.add(pathValue)
    }
  }
  return [...result].sort()
}

function subtree(tree: TreeSnapshot, rootPath: string): TreeSnapshot {
  return {
    entries: tree.entries.filter((entry) => pathIsWithin(rootPath, entry.identity.path)),
  }
}

function remapTree(tree: TreeSnapshot, fromRoot: string, toRoot: string): TreeSnapshot {
  return {
    entries: tree.entries.map((entry) => {
      const suffix = entry.identity.path.slice(fromRoot.length)
      return {
        bytes: entry.bytes,
        identity: { ...entry.identity, path: `${toRoot}${suffix}` },
      }
    }),
  }
}

function fileEntries(tree: TreeSnapshot, root: string): TreeEntry[] {
  return tree.entries.filter((entry) => entry.identity.kind === 'file' && entry.identity.path !== root)
}

function treeShapeDigest(tree: TreeSnapshot): unknown[] {
  return tree.entries
    .slice()
    .sort((left, right) => left.identity.path.localeCompare(right.identity.path))
    .map((entry) => ({ identity: entry.identity, bytes: entry.bytes }))
}

function receiptShapeDigest(receipt: ReceiptObservation | null): unknown {
  return receipt === null ? null : { identity: receipt.identity, bytes: receipt.bytes }
}

function sameReceiptObservation(left: ReceiptObservation | null, right: ReceiptObservation | null): boolean {
  if (left === null || right === null) return left === right
  return sameIdentity(left.identity, right.identity) && left.bytes === right.bytes
}

function configEntriesFor(snapshot: CompanionConfigurationSnapshot, pluginId: string): PluginConfigurationEntry[] {
  return snapshot.entries.filter((entry) => entry.pluginId === pluginId)
}

function shellHasPlugin(snapshot: CompanionConfigurationSnapshot, pluginId: string): boolean {
  return configEntriesFor(snapshot, pluginId).some((entry) => entry.enabled)
}

function shellEntryIsExact(snapshot: CompanionConfigurationSnapshot, pluginId: string, pluginRoot: string): boolean {
  const entries = configEntriesFor(snapshot, pluginId)
  return entries.length === 1 && entries[0].enabled && entries[0].source === pluginRoot
}

function releaseDigest(ports: InstallationPorts, release: CompanionRelease | null): string {
  return ports.digest.stableDigest(release)
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deep installation manager. All methods are safe to call with fake ports;
 * no method performs an un-injected filesystem or configuration operation.
 */
export class CompanionInstallation {
  private readonly ports: InstallationPorts
  private mutationSequence = 0
  private activeStage: ActiveStage | null = null

  constructor(ports: InstallationPorts) {
    this.ports = ports
  }

  /** Read current state and create a frozen, plan-digest-bound operation plan. */
  async inspect(request: { operation: InstallationOperation; release?: unknown }): Promise<CompanionInstallationPlan> {
    if (!isPlainObject(request) || !INSTALLATION_OPERATIONS.includes(request.operation)) {
      throw new CompanionInstallationError('invalid_plan', 'installation operation is invalid')
    }
    const operation = request.operation as InstallationOperation
    const compatibility = await this.ports.host.compatibility()
    this.assertHostCompatibility(compatibility)

    let release: CompanionRelease | null = null
    if (operation !== 'uninstall') {
      release = freezeCompanionRelease(request.release)
      if (!sameCompatibility(release.compatibility, compatibility)) {
        throw new CompanionCompatibilityError(
          `release compatibility does not match host compatibility`,
        )
      }
    }

    const state = await this.captureState()
    const precondition = this.precondition(state)
    const base = {
      schemaVersion: 1 as const,
      operation,
      pluginId: COMPANION_PLUGIN_ID,
      release,
      compatibility: clone(compatibility),
      precondition,
      inspectedAt: this.ports.clock.now(),
    }
    const planDigest = this.ports.digest.stableDigest(base)
    return deepFreeze({ ...base, planDigest })
  }

  /** Execute one exact authorized plan, recovering or reporting incomplete recovery on failure. */
  async execute(
    inputPlan: CompanionInstallationPlan,
    authorization: CompanionInstallationAuthorization | undefined,
  ): Promise<CompanionInstallationResult> {
    const plan = this.validatePlan(inputPlan)
    await this.verifyAuthorization(plan, authorization)
    if (this.activeStage !== null) {
      throw new CompanionInstallationError('operation_failed', 'an incomplete staged installation requires operator recovery')
    }

    const prior = await this.captureState()
    const currentCompatibility = prior.compatibility
    this.assertHostCompatibility(currentCompatibility)
    if (!sameCompatibility(currentCompatibility, plan.compatibility)) {
      throw new CompanionInstallationError('stale_precondition', 'host compatibility changed after inspection')
    }
    this.assertPrecondition(plan, prior)
    const previousReceipt = await this.validateOperationState(plan, prior)

    try {
      switch (plan.operation) {
        case 'install':
          await this.install(plan, prior)
          break
        case 'update':
          await this.replace(plan, prior, previousReceipt, 'update')
          break
        case 'rollback':
          await this.replace(plan, prior, previousReceipt, 'rollback')
          break
        case 'uninstall':
          await this.uninstall(plan, prior)
          break
      }
      await this.assertPostcondition(plan)
      await this.finalizeStage(plan)
      return {
        operation: plan.operation,
        pluginId: plan.pluginId,
        version: plan.release?.version ?? null,
        planDigest: plan.planDigest,
        completedAt: this.ports.clock.now(),
      }
    } catch (error) {
      await this.recoverOrThrow(plan, prior, error)
      throw error
    }
  }

  private validatePlan(input: CompanionInstallationPlan): CompanionInstallationPlan {
    const value = requireObject(input, 'installation plan must be an object')
    requireExactPlanFields(value)
    if (value.schemaVersion !== 1 || !INSTALLATION_OPERATIONS.includes(value.operation as InstallationOperation)) {
      throw new CompanionInstallationError('invalid_plan', 'installation plan schema or operation is invalid')
    }
    if (value.pluginId !== COMPANION_PLUGIN_ID) {
      throw new CompanionInstallationError('invalid_plan', 'installation plan plugin ID is invalid')
    }
    const compatibilityValue = requireObject(value.compatibility, 'installation plan compatibility is invalid')
    const preconditionValue = requireObject(value.precondition, 'installation plan precondition is invalid')
    requireExactFields(compatibilityValue, ['omarchy', 'quickshell'], 'installation plan compatibility', 'invalid_plan')
    requireExactFields(preconditionValue, [
      'hostCompatibilityDigest', 'pluginTreeDigest', 'receiptDigest', 'shellJsonDigest',
    ], 'installation plan precondition', 'invalid_plan')
    const compatibility = {
      omarchy: requirePlanString(compatibilityValue.omarchy, 'installation plan Omarchy compatibility'),
      quickshell: requirePlanString(compatibilityValue.quickshell, 'installation plan Quickshell compatibility'),
    }
    const precondition = {
      hostCompatibilityDigest: requirePlanString(preconditionValue.hostCompatibilityDigest, 'installation plan host compatibility digest'),
      pluginTreeDigest: requirePlanString(preconditionValue.pluginTreeDigest, 'installation plan plugin tree digest'),
      receiptDigest: requirePlanString(preconditionValue.receiptDigest, 'installation plan receipt digest'),
      shellJsonDigest: requirePlanString(preconditionValue.shellJsonDigest, 'installation plan shell JSON digest'),
    }
    const planDigest = requirePlanString(value.planDigest, 'installation plan digest')
    if (!/^[a-f0-9]{64}$/.test(planDigest)) {
      throw new CompanionInstallationError('invalid_plan', 'installation plan digest must be a lowercase SHA-256 digest')
    }
    const inspectedAt = requirePlanString(value.inspectedAt, 'installation plan inspectedAt')
    const operation = value.operation as InstallationOperation
    if (value.release === undefined) {
      throw new CompanionInstallationError('invalid_plan', 'installation plan release must be null or a release object')
    }
    const release = value.release === null ? null : freezeCompanionRelease(value.release)
    if (operation !== 'uninstall' && release === null) {
      throw new CompanionInstallationError('invalid_plan', 'this operation requires a release')
    }
    if (operation === 'uninstall' && release !== null) {
      throw new CompanionInstallationError('invalid_plan', 'uninstall cannot carry a release')
    }
    const base = {
      schemaVersion: 1 as const,
      operation,
      pluginId: COMPANION_PLUGIN_ID,
      release,
      compatibility,
      precondition,
      inspectedAt,
    }
    const digest = this.ports.digest.stableDigest(base)
    if (digest !== planDigest) {
      throw new CompanionInstallationError('invalid_plan', 'installation plan digest does not match its contents')
    }
    const plan = { ...base, planDigest } as CompanionInstallationPlan
    return deepFreeze(plan)
  }

  private async verifyAuthorization(
    plan: CompanionInstallationPlan,
    authorization: CompanionInstallationAuthorization | undefined,
  ): Promise<void> {
    if (authorization === undefined || authorization === null) {
      throw new CompanionInstallationError('authorization_required', 'explicit authorization is required')
    }
    if (
      authorization.operation !== plan.operation
      || authorization.planDigest !== plan.planDigest
      || typeof authorization.authorizationId !== 'string'
      || authorization.authorizationId.length === 0
      || typeof authorization.token !== 'string'
      || authorization.token.length === 0
    ) {
      throw new CompanionInstallationError('authorization_mismatch', 'authorization is not bound to this plan')
    }
    let verified = false
    try {
      verified = await this.ports.authorization.verify(authorization, plan)
    } catch {
      verified = false
    }
    if (!verified) throw new CompanionInstallationError('authorization_mismatch', 'authorization issuer rejected the plan')
  }

  private assertHostCompatibility(compatibility: CompanionCompatibility): void {
    try {
      assertSupportedCompatibility(compatibility)
    } catch (error) {
      if (error instanceof CompanionError && error.code === 'unsupported_compatibility') throw error
      throw new CompanionCompatibilityError(errorDetail(error))
    }
  }

  private async captureState(): Promise<StateSnapshot> {
    const compatibility = await this.ports.host.compatibility()
    const tree = await this.captureTree()
    const receiptResult = await this.ports.receipts.inspectNoFollow(COMPANION_PLUGIN_ID)
    const receipt = receiptResult === null ? null : {
      identity: clone(receiptResult.identity),
      bytes: receiptResult.bytes,
    }
    const configuration = await this.ports.configuration.inspect()
    if (configuration.shellJsonSha256 !== this.ports.digest.sha256(configuration.shellJsonBytes)) {
      throw new CompanionInstallationError('configuration_conflict', 'configuration adapter returned an invalid shell.json digest')
    }
    return { compatibility: clone(compatibility), tree, receipt, configuration: clone(configuration) }
  }

  private async captureTree(): Promise<TreeSnapshot> {
    return this.captureTreeAt(this.ports.paths.pluginRoot)
  }

  private async captureTreeAt(root: string): Promise<TreeSnapshot> {
    await this.assertNoSymlinkComponents(root)
    const entries: TreeEntry[] = []
    const visit = async (input: string): Promise<void> => {
      const identity = await this.ports.filesystem.inspectNoFollow(input)
      if (identity.kind === 'missing') {
        entries.push({ identity, bytes: null })
        return
      }
      if (identity.kind === 'file') {
        entries.push({ identity, bytes: await this.ports.filesystem.readBytesNoFollow(input) })
        return
      }
      entries.push({ identity, bytes: null })
      if (identity.kind !== 'directory') return
      const names = await this.ports.filesystem.listDirectoryNoFollow(input)
      for (const name of names.sort()) await visit(POSIX.join(input, name))
    }
    await visit(root)
    return { entries }
  }

  private precondition(state: StateSnapshot): CompanionInstallationPlan['precondition'] {
    return {
      hostCompatibilityDigest: this.ports.digest.stableDigest(state.compatibility),
      pluginTreeDigest: this.ports.digest.stableDigest(treeShapeDigest(state.tree)),
      receiptDigest: this.ports.digest.sha256(state.receipt?.bytes ?? ''),
      shellJsonDigest: this.ports.digest.sha256(state.configuration.shellJsonBytes),
    }
  }

  private assertPrecondition(plan: CompanionInstallationPlan, state: StateSnapshot): void {
    const actual = this.precondition(state)
    if (
      actual.hostCompatibilityDigest !== plan.precondition.hostCompatibilityDigest
      || actual.pluginTreeDigest !== plan.precondition.pluginTreeDigest
      || actual.receiptDigest !== plan.precondition.receiptDigest
      || actual.shellJsonDigest !== plan.precondition.shellJsonDigest
    ) {
      throw new CompanionInstallationError('stale_precondition', 'installation state changed after inspection')
    }
  }

  private async validateOperationState(
    plan: CompanionInstallationPlan,
    state: StateSnapshot,
  ): Promise<ValidatedReceipt | null> {
    await this.assertNoSymlinkComponents(this.ports.paths.pluginsRoot)
    await this.assertNoSymlinkComponents(this.ports.paths.pluginRoot)
    await this.assertNoSymlinkComponents(this.ports.paths.receiptPath)
    await this.assertSafeAncestors(this.ports.paths.pluginsRoot, true)
    await this.assertSafeAncestors(POSIX.dirname(this.ports.paths.receiptPath), true)
    const pluginEntries = configEntriesFor(state.configuration, plan.pluginId)
    if (new Set(state.configuration.entries.map((entry) => entry.pluginId)).size !== state.configuration.entries.length) {
      throw new CompanionInstallationError('configuration_conflict', 'shell.json contains duplicate plugin entries')
    }

    if (plan.operation === 'install') {
      const root = entryAt(state.tree, this.ports.paths.pluginRoot)?.identity
      if (root?.kind === 'symlink' || state.tree.entries.some((entry) => entry.identity.kind === 'symlink')) {
        throw new CompanionInstallationError('unsafe_path', 'install target contains a symlink component')
      }
      if (root?.kind !== 'missing' || state.receipt !== null) {
        throw new CompanionInstallationError('foreign_installation', 'existing target lacks clean install ownership')
      }
      if (pluginEntries.length !== 0) {
        throw new CompanionInstallationError('configuration_conflict', 'plugin ID already exists in shell.json')
      }
      await this.assertSafeAncestors(this.ports.paths.pluginRoot, false)
      return null
    }

    const receipt = await this.validateReceipt(state.receipt, state)
    if (!shellEntryIsExact(state.configuration, plan.pluginId, this.ports.paths.pluginRoot)) {
      throw new CompanionInstallationError('configuration_conflict', 'owned plugin enablement is absent or conflicts')
    }
    if (plan.operation !== 'uninstall' && plan.release === null) {
      throw new CompanionInstallationError('invalid_plan', 'destructive operation requires a release or current receipt')
    }
    if (plan.operation === 'rollback') {
      if (receipt.value.previousRelease === null) {
        throw new CompanionInstallationError('invalid_receipt', 'receipt does not contain a rollback release')
      }
      if (releaseDigest(this.ports, receipt.value.previousRelease) !== releaseDigest(this.ports, plan.release)) {
        throw new CompanionInstallationError('invalid_plan', 'rollback release is not the receipt-backed prior release')
      }
    }
    return receipt
  }

  private async validateReceipt(
    observation: ReceiptObservation | null,
    state: StateSnapshot,
  ): Promise<ValidatedReceipt> {
    if (observation === null) throw new CompanionInstallationError('foreign_installation', 'installation receipt is missing')
    await this.assertNoSymlinkComponents(this.ports.paths.receiptPath)
    await this.assertSafeAncestors(POSIX.dirname(this.ports.paths.receiptPath), true)
    await this.assertSafeAncestors(this.ports.paths.pluginsRoot, true)
    if (observation.identity.path !== this.ports.paths.receiptPath || observation.identity.kind !== 'file') {
      throw new CompanionInstallationError('invalid_receipt', 'receipt is not a regular file at the owned path')
    }
    const owner = await this.ports.host.currentOwner()
    if (observation.identity.owner !== owner || observation.identity.mode !== RECEIPT_FILE_MODE) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt ownership or mode is unsafe')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(observation.bytes)
    } catch {
      throw new CompanionInstallationError('invalid_receipt', 'receipt JSON is malformed')
    }
    const value = requireObject(parsed, 'receipt must be an object', 'invalid_receipt')
    requireExactFields(value, [
      'schemaVersion', 'pluginId', 'release', 'previousRelease', 'compatibility',
      'planDigest', 'installedAt', 'assets', 'shellJson',
    ], 'receipt')
    if (value.schemaVersion !== 1 || value.pluginId !== COMPANION_PLUGIN_ID) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt schema or plugin ID is invalid')
    }
    const release = freezeCompanionRelease(value.release)
    const previousRelease = value.previousRelease === null ? null : freezeCompanionRelease(value.previousRelease)
    const compatibilityValue = requireObject(value.compatibility, 'receipt compatibility must be an object', 'invalid_receipt')
    requireExactFields(compatibilityValue, ['omarchy', 'quickshell'], 'receipt compatibility')
    const compatibility: CompanionCompatibility = {
      omarchy: requireString(compatibilityValue.omarchy, 'receipt Omarchy compatibility'),
      quickshell: requireString(compatibilityValue.quickshell, 'receipt Quickshell compatibility'),
    }
    this.assertHostCompatibility(compatibility)
    if (!sameCompatibility(compatibility, release.compatibility)) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt compatibility differs from its release')
    }
    if (!sameCompatibility(compatibility, state.compatibility)) {
      throw new CompanionInstallationError('stale_precondition', 'receipt compatibility differs from current host')
    }
    const planDigest = assertSha256(requireString(value.planDigest, 'receipt plan digest'), 'receipt plan digest')
    const installedAt = requireString(value.installedAt, 'receipt installedAt')
    const shellJsonValue = requireObject(value.shellJson, 'receipt shellJson must be an object', 'invalid_receipt')
    requireExactFields(shellJsonValue, ['preimageHash', 'postimageHash', 'preimageBytes', 'postimageBytes'], 'receipt shellJson')
    const shellJson = {
      preimageHash: assertSha256(shellJsonValue.preimageHash, 'receipt shellJson preimageHash'),
      postimageHash: assertSha256(shellJsonValue.postimageHash, 'receipt shellJson postimageHash'),
      preimageBytes: requireString(shellJsonValue.preimageBytes, 'receipt shellJson preimageBytes'),
      postimageBytes: requireString(shellJsonValue.postimageBytes, 'receipt shellJson postimageBytes'),
    }
    if (this.ports.digest.sha256(shellJson.preimageBytes) !== shellJson.preimageHash
      || this.ports.digest.sha256(shellJson.postimageBytes) !== shellJson.postimageHash) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt shell preimage hashes do not match bytes')
    }
    if (state.configuration.shellJsonSha256 !== this.ports.digest.sha256(state.configuration.shellJsonBytes)) {
      throw new CompanionInstallationError('configuration_conflict', 'configuration adapter returned an invalid shell.json digest')
    }
    if (state.configuration.shellJsonBytes !== shellJson.postimageBytes) {
      throw new CompanionInstallationError('stale_precondition', 'shell.json no longer matches the receipt postimage')
    }

    if (!Array.isArray(value.assets) || value.assets.length !== Object.keys(release.assets).length) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt asset inventory is incomplete')
    }
    const assets: CompanionAssetReceipt[] = []
    const seen = new Set<string>()
    for (const inputAsset of value.assets) {
      const asset = requireObject(inputAsset, 'receipt asset must be an object', 'invalid_receipt')
      requireExactFields(asset, ['relativePath', 'path', 'sha256', 'owner', 'mode', 'device', 'inode'], 'receipt asset')
      const relativePath = requireString(asset.relativePath, 'receipt asset relativePath')
      if (!isSafeAssetPath(relativePath) || !Object.hasOwn(release.assets, relativePath)) {
        throw new CompanionInstallationError('invalid_receipt', `receipt has an unexpected asset ${relativePath}`)
      }
      const expectedPath = this.ports.paths.asset(relativePath)
      const canonicalPath = POSIX.join(this.ports.paths.pluginRoot, relativePath)
      if (expectedPath !== canonicalPath) {
        throw new CompanionInstallationError('invalid_receipt', `receipt path adapter escaped the plugin root for ${relativePath}`)
      }
      if (seen.has(relativePath)) {
        throw new CompanionInstallationError('invalid_receipt', `receipt has an unexpected asset ${relativePath}`)
      }
      seen.add(relativePath)
      if (asset.path !== expectedPath) throw new CompanionInstallationError('invalid_receipt', `receipt path mismatch for ${relativePath}`)
      const ownerValue = requireString(asset.owner, `receipt asset ${relativePath} owner`)
      if (ownerValue !== owner) {
        throw new CompanionInstallationError('invalid_receipt', `receipt asset ${relativePath} has foreign ownership`)
      }
      const mode = requireMode(asset.mode, `receipt asset ${relativePath} mode`)
      if (mode !== PLUGIN_ASSET_MODE) {
        throw new CompanionInstallationError('invalid_receipt', `receipt asset ${relativePath} has an unsafe mode`)
      }
      const device = requireIdentityNumber(asset.device, `receipt asset ${relativePath} device`)
      const inode = requireIdentityNumber(asset.inode, `receipt asset ${relativePath} inode`)
      assets.push({
        relativePath,
        path: expectedPath,
        sha256: assertSha256(asset.sha256, `receipt asset ${relativePath} sha256`),
        owner: ownerValue,
        mode,
        device,
        inode,
      })
    }
    if (seen.size !== Object.keys(release.assets).length) {
      throw new CompanionInstallationError('invalid_receipt', 'receipt asset inventory has missing entries')
    }

    const normalized: CompanionInstallationReceipt = {
      schemaVersion: 1,
      pluginId: COMPANION_PLUGIN_ID,
      release,
      previousRelease,
      compatibility,
      planDigest,
      installedAt,
      assets,
      shellJson,
    }
    await this.validateInstalledTree(state.tree, normalized)
    return { value: normalized, observation }
  }

  private async validateInstalledTree(tree: TreeSnapshot, receipt: CompanionInstallationReceipt): Promise<void> {
    const owner = await this.ports.host.currentOwner()
    const root = entryAt(tree, this.ports.paths.pluginRoot)
    if (root?.identity.kind !== 'directory') {
      throw new CompanionInstallationError('foreign_installation', 'owned plugin root is missing or not a directory')
    }
    this.assertSafeDirectoryIdentity(root.identity, owner, this.ports.paths.pluginRoot)
    const expectedAssets = expectedAssetPaths(receipt.release)
    const expectedDirs = expectedDirectories(receipt.release)
    const seenFiles = new Set<string>()
    const seenDirs = new Set<string>([''])
    for (const entry of tree.entries) {
      const relativePath = relativeTo(this.ports.paths.pluginRoot, entry.identity.path)
      if (entry.identity.path === this.ports.paths.pluginRoot) continue
      if (entry.identity.kind === 'symlink') {
        throw new CompanionInstallationError('unsafe_path', `symlink component in installed plugin at ${entry.identity.path}`)
      }
      if (entry.identity.kind === 'directory') {
        if (!expectedDirs.has(relativePath)) {
          throw new CompanionInstallationError('foreign_installation', `extra plugin directory ${relativePath}`)
        }
        this.assertSafeDirectoryIdentity(entry.identity, owner, entry.identity.path)
        seenDirs.add(relativePath)
        continue
      }
      if (entry.identity.kind !== 'file') {
        throw new CompanionInstallationError('foreign_installation', `invalid plugin node ${entry.identity.path}`)
      }
      if (!expectedAssets.has(relativePath) || entry.bytes === null) {
        throw new CompanionInstallationError('foreign_installation', `extra plugin asset ${relativePath}`)
      }
      const receiptAsset = receipt.assets.find((asset) => asset.relativePath === relativePath)
      if (receiptAsset === undefined) throw new CompanionInstallationError('invalid_receipt', `receipt lacks ${relativePath}`)
      if (entry.identity.owner !== receiptAsset.owner
        || entry.identity.mode !== receiptAsset.mode
        || entry.identity.device !== receiptAsset.device
        || entry.identity.inode !== receiptAsset.inode
        || this.ports.digest.sha256(entry.bytes) !== receiptAsset.sha256) {
        throw new CompanionInstallationError('foreign_installation', `owned asset identity or bytes changed at ${relativePath}`)
      }
      seenFiles.add(relativePath)
    }
    if (seenFiles.size !== expectedAssets.size || seenDirs.size !== expectedDirs.size) {
      throw new CompanionInstallationError('foreign_installation', 'installed plugin asset inventory is missing entries')
    }
    await this.validateManifest(receipt.release)
  }

  private async validateManifest(release: CompanionRelease): Promise<void> {
    const manifestBytes = release.assets['manifest.json']
    if (manifestBytes === undefined) throw new CompanionInstallationError('invalid_release', 'release manifest is missing')
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestBytes)
    } catch {
      throw new CompanionInstallationError('invalid_release', 'release manifest is malformed JSON')
    }
    const manifest = requireObject(parsed, 'release manifest must be an object', 'invalid_release')
    if (
      manifest.schemaVersion !== 1
      || manifest.id !== release.pluginId
      || manifest.version !== release.version
      || !Array.isArray(manifest.kinds)
      || manifest.kinds.length !== 1
      || manifest.kinds[0] !== 'panel'
      || !isPlainObject(manifest.entryPoints)
      || manifest.entryPoints.panel !== 'AgentConsole.qml'
    ) {
      throw new CompanionInstallationError('invalid_release', 'release manifest does not describe the exact panel release')
    }
  }

  private assertSafeDirectoryIdentity(identity: FilesystemIdentity, owner: string, input: string): void {
    if (identity.kind !== 'directory' || identity.owner !== owner || identity.mode === null || (identity.mode & 0o022) !== 0) {
      throw new CompanionInstallationError('unsafe_path', `directory ownership or mode is unsafe at ${input}`)
    }
  }

  private assertSafeDirectoryMode(identity: FilesystemIdentity, input: string): void {
    if (identity.kind !== 'directory' || identity.mode === null || (identity.mode & 0o022) !== 0) {
      throw new CompanionInstallationError('unsafe_path', `directory type or mode is unsafe at ${input}`)
    }
  }

  private async assertSafeAncestors(input: string, includeFinal: boolean): Promise<void> {
    const owner = await this.ports.host.currentOwner()
    const prefixes = this.pathPrefixes(input)
    for (const prefix of prefixes) {
      const identity = await this.ports.filesystem.inspectNoFollow(prefix)
      if (identity.kind === 'missing') break
      if (identity.kind === 'symlink') throw new CompanionInstallationError('unsafe_path', `symlink component at ${prefix}`)
      if (identity.kind !== 'directory') throw new CompanionInstallationError('unsafe_path', `non-directory path component at ${prefix}`)
      if (includeFinal || prefix !== input) {
        if (prefix === input || identity.owner === owner) {
          this.assertSafeDirectoryIdentity(identity, owner, prefix)
        } else if (identity.owner === 'root' || identity.owner === '0') {
          this.assertSafeDirectoryMode(identity, prefix)
        } else {
          throw new CompanionInstallationError('unsafe_path', `directory ownership is unsafe at ${prefix}`)
        }
      }
    }
  }

  private async assertNoSymlinkComponents(input: string): Promise<void> {
    for (const prefix of this.pathPrefixes(input)) {
      const identity = await this.ports.filesystem.inspectNoFollow(prefix)
      if (identity.kind === 'symlink') throw new CompanionInstallationError('unsafe_path', `symlink component at ${prefix}`)
      if (identity.kind === 'missing') break
    }
  }

  private pathPrefixes(input: string): string[] {
    const normalized = POSIX.normalize(input)
    const components = normalized === '/' ? [] : normalized.slice(1).split('/')
    const result = ['/']
    let current = ''
    for (const component of components) {
      current += `/${component}`
      result.push(current)
    }
    return result
  }

  private async install(plan: CompanionInstallationPlan, prior: StateSnapshot): Promise<void> {
    const release = plan.release
    if (release === null) throw new CompanionInstallationError('invalid_plan', 'install release is missing')
    await this.assertSafeAncestors(this.ports.paths.pluginsRoot, true)
    const root = entryAt(prior.tree, this.ports.paths.pluginRoot)
    if (root?.identity.kind !== 'missing') throw new CompanionInstallationError('foreign_installation', 'install target is not absent')
    await this.ensureReleaseDirectories(release, plan)
    for (const relativePath of Object.keys(release.assets).sort()) {
      const target = this.ports.paths.asset(relativePath)
      await this.assertNoSymlinkComponents(target)
      const identity = await this.ports.filesystem.inspectNoFollow(target)
      if (identity.kind !== 'missing') throw new CompanionInstallationError('foreign_installation', `install target appeared at ${target}`)
      await this.ports.filesystem.writeBytesAtomic(target, release.assets[relativePath], await this.ports.host.currentOwner(), PLUGIN_ASSET_MODE)
      this.record('write_asset', target, plan, { relativePath })
    }
    this.checkpoint('after-plugin-assets')
    await this.supportedRescan(plan)
    await this.supportedEnable(plan)
    this.checkpoint('after-shell-enable')
    const afterEnable = await this.ports.configuration.inspect()
    this.assertEnabledConfiguration(afterEnable)
    const receipt = await this.buildReceipt(plan, null, prior.configuration.shellJsonBytes, afterEnable.shellJsonBytes)
    await this.writeReceipt(plan, receipt, null)
  }

  private async replace(
    plan: CompanionInstallationPlan,
    prior: StateSnapshot,
    previousReceipt: ValidatedReceipt | null,
    operation: 'update' | 'rollback',
  ): Promise<void> {
    const release = plan.release
    if (release === null || previousReceipt === null) throw new CompanionInstallationError('invalid_plan', `${operation} release or receipt is missing`)
    const currentFiles = fileEntries(prior.tree, this.ports.paths.pluginRoot)
    const expected = expectedAssetPaths(release)
    const expectedDirectoriesForRelease = expectedDirectories(release)
    const obsoleteFiles = currentFiles
      .filter((entry) => !expected.has(relativeTo(this.ports.paths.pluginRoot, entry.identity.path)))
      .sort((left, right) => right.identity.path.length - left.identity.path.length)
    const obsoleteDirectories = prior.tree.entries
      .filter((candidate) => candidate.identity.kind === 'directory' && candidate.identity.path !== this.ports.paths.pluginRoot)
      .filter((candidate) => !expectedDirectoriesForRelease.has(relativeTo(this.ports.paths.pluginRoot, candidate.identity.path)))
      .sort((left, right) => right.identity.path.length - left.identity.path.length)
    await this.stageObsoleteEntries(plan, obsoleteFiles, obsoleteDirectories)
    await this.ensureReleaseDirectories(release, plan)
    const owner = await this.ports.host.currentOwner()
    for (const relativePath of Object.keys(release.assets).sort()) {
      const target = this.ports.paths.asset(relativePath)
      await this.assertNoSymlinkComponents(target)
      const beforeEntry = entryAt(prior.tree, target)
      const current = await this.ports.filesystem.inspectNoFollow(target)
      if (beforeEntry === undefined || beforeEntry.identity.kind === 'missing') {
        if (current.kind !== 'missing') throw new CompanionInstallationError('stale_precondition', `target appeared at ${target}`)
      } else if (beforeEntry.identity.kind === 'directory') {
        if (current.kind !== 'missing') throw new CompanionInstallationError('stale_precondition', `directory replacement path is occupied at ${target}`)
      } else {
        if (current.kind !== 'file' || !sameIdentity(current, beforeEntry.identity)) {
          throw new CompanionInstallationError('stale_precondition', `asset identity changed at ${target}`)
        }
      }
      await this.ports.filesystem.writeBytesAtomic(target, release.assets[relativePath], owner, PLUGIN_ASSET_MODE)
      this.record('write_asset', target, plan, { relativePath, operation })
    }
    this.checkpoint('after-plugin-assets')
    await this.supportedRescan(plan)
    await this.supportedEnable(plan)
    this.checkpoint('after-shell-enable')
    const afterEnable = await this.ports.configuration.inspect()
    this.assertEnabledConfiguration(afterEnable)
    const receipt = await this.buildReceipt(
      plan,
      previousReceipt.value.release,
      previousReceipt.value.shellJson.preimageBytes,
      afterEnable.shellJsonBytes,
    )
    await this.writeReceipt(plan, receipt, previousReceipt.observation)
  }

  private stagePath(plan: CompanionInstallationPlan): string {
    const safeDigest = this.ports.digest.sha256(plan.planDigest)
    return POSIX.join(this.ports.paths.pluginsRoot, `.omarchestra-agent-console-stage-${safeDigest}`)
  }

  private async stageObsoleteEntries(
    plan: CompanionInstallationPlan,
    obsoleteFiles: TreeEntry[],
    obsoleteDirectories: TreeEntry[],
  ): Promise<void> {
    const directoryRoots = obsoleteDirectories.filter((entry) => !obsoleteDirectories.some((candidate) =>
      candidate !== entry && pathIsWithin(candidate.identity.path, entry.identity.path)))
    const stagedDirectoryPaths = directoryRoots.map((entry) => entry.identity.path)
    const fileEntriesToStage = obsoleteFiles.filter((entry) => !stagedDirectoryPaths.some((root) =>
      pathIsWithin(root, entry.identity.path)))
    const entriesToStage = [...directoryRoots, ...fileEntriesToStage]
      .sort((left, right) => left.identity.path.localeCompare(right.identity.path))
    const rootPath = this.stagePath(plan)
    await this.assertSafeAncestors(this.ports.paths.pluginsRoot, true)
    await this.assertNoSymlinkComponents(rootPath)
    const existing = await this.ports.filesystem.inspectNoFollow(rootPath)
    if (existing.kind !== 'missing') {
      throw new CompanionInstallationError('foreign_installation', 'installation staging path is already occupied')
    }
    if (entriesToStage.length === 0) return
    const owner = await this.ports.host.currentOwner()
    const stage: ActiveStage = { rootPath, entries: [], snapshot: null }
    this.activeStage = stage
    await this.ports.filesystem.ensureDirectory(rootPath, owner, 0o700)
    this.record('mkdir', rootPath, plan, { staging: true })

    for (const entry of entriesToStage) {
      const relativePath = relativeTo(this.ports.paths.pluginRoot, entry.identity.path)
      const destinationPath = POSIX.join(rootPath, relativePath)
      const destinationParent = POSIX.dirname(destinationPath)
      await this.assertNoSymlinkComponents(destinationParent)
      const parentIdentity = await this.ports.filesystem.inspectNoFollow(destinationParent)
      if (parentIdentity.kind === 'missing') {
        await this.ports.filesystem.ensureDirectory(destinationParent, owner, PLUGIN_DIRECTORY_MODE)
        this.record('mkdir', destinationParent, plan, { staging: true })
      } else {
        this.assertSafeDirectoryIdentity(parentIdentity, owner, destinationParent)
      }
      const current = await this.ports.filesystem.inspectNoFollow(entry.identity.path)
      if (!sameIdentity(current, entry.identity)) {
        throw new CompanionInstallationError('stale_precondition', `asset identity changed before staging at ${entry.identity.path}`)
      }
      const destination = await this.ports.filesystem.inspectNoFollow(destinationPath)
      if (destination.kind !== 'missing') {
        throw new CompanionInstallationError('foreign_installation', `staging destination is occupied at ${destinationPath}`)
      }
      await this.ports.filesystem.renameExact(current, destinationPath)
      stage.entries.push({ source: entry, destinationPath })
      this.record('rename', entry.identity.path, plan, {
        from: entry.identity.path,
        to: destinationPath,
        relativePath,
        staging: true,
      })
    }
    stage.snapshot = await this.captureTreeAt(rootPath)
  }

  private async removeTree(tree: TreeSnapshot, rootPath: string, plan: CompanionInstallationPlan, detail: Record<string, unknown>): Promise<void> {
    const root = entryAt(tree, rootPath)
    if (root === undefined || (root.identity.kind !== 'directory' && root.identity.kind !== 'file')) {
      throw new CompanionInstallationError('stale_precondition', `staging root disappeared at ${rootPath}`)
    }
    if (root.identity.kind === 'file') {
      const current = await this.ports.filesystem.inspectNoFollow(rootPath)
      if (!sameIdentity(current, root.identity)) {
        throw new CompanionInstallationError('stale_precondition', `staging file identity changed at ${rootPath}`)
      }
      await this.ports.filesystem.removeFileExact(current)
      this.record('remove_asset', rootPath, plan, { ...detail, staging: true })
      return
    }
    for (const entry of tree.entries
      .filter((candidate) => candidate.identity.kind === 'file')
      .sort((left, right) => right.identity.path.length - left.identity.path.length)) {
      const current = await this.ports.filesystem.inspectNoFollow(entry.identity.path)
      if (!sameIdentity(current, entry.identity)) {
        throw new CompanionInstallationError('stale_precondition', `staging file identity changed at ${entry.identity.path}`)
      }
      await this.ports.filesystem.removeFileExact(current)
      this.record('remove_asset', entry.identity.path, plan, { ...detail, staging: true })
    }
    for (const entry of tree.entries
      .filter((candidate) => candidate.identity.kind === 'directory' && candidate.identity.path !== rootPath)
      .sort((left, right) => right.identity.path.length - left.identity.path.length)) {
      const current = await this.ports.filesystem.inspectNoFollow(entry.identity.path)
      if (!sameIdentity(current, entry.identity)) {
        throw new CompanionInstallationError('stale_precondition', `staging directory identity changed at ${entry.identity.path}`)
      }
      await this.ports.filesystem.removeDirectoryExact(current)
      this.record('remove_asset', entry.identity.path, plan, { ...detail, kind: 'directory', staging: true })
    }
    if (root.identity.kind !== 'directory') {
      throw new CompanionInstallationError('stale_precondition', `staging root disappeared at ${rootPath}`)
    }
    const currentRoot = await this.ports.filesystem.inspectNoFollow(rootPath)
    if (!sameIdentity(currentRoot, root.identity)) {
      throw new CompanionInstallationError('stale_precondition', `staging root identity changed at ${rootPath}`)
    }
    await this.ports.filesystem.removeDirectoryExact(currentRoot)
    this.record('remove_asset', rootPath, plan, { ...detail, kind: 'directory' })
  }

  private async finalizeStage(plan: CompanionInstallationPlan): Promise<void> {
    const stage = this.activeStage
    if (stage === null) return
    if (stage.snapshot === null) {
      throw new CompanionInstallationError('operation_failed', 'installation staging did not complete')
    }
    const current = await this.captureTreeAt(stage.rootPath)
    if (!sameTree(current, stage.snapshot)) {
      throw new CompanionInstallationError('stale_precondition', 'installation staging changed before cleanup')
    }
    await this.removeTree(current, stage.rootPath, plan, { finalize: true })
    this.activeStage = null
  }

  private async uninstall(plan: CompanionInstallationPlan, prior: StateSnapshot): Promise<void> {
    const receipt = await this.validateReceipt(prior.receipt, prior)
    const currentTree = prior.tree
    const owner = await this.ports.host.currentOwner()
    const currentReceipt = await this.ports.receipts.inspectNoFollow(plan.pluginId)
    if (currentReceipt === null || !sameIdentity(currentReceipt.identity, prior.receipt!.identity)) {
      throw new CompanionInstallationError('stale_precondition', 'receipt identity changed during uninstall')
    }

    // Disable through the supported shell operation while the source still
    // exists. The fake shell restores the recorded shell preimage exactly.
    await this.supportedDisable(plan)
    await this.supportedRescan(plan)

    for (const asset of receipt.value.assets.slice().sort((left, right) => right.path.localeCompare(left.path))) {
      const entry = entryAt(currentTree, asset.path)
      if (entry === undefined || entry.identity.kind !== 'file' || !sameIdentity(entry.identity, {
        path: asset.path,
        kind: 'file',
        owner: asset.owner,
        mode: asset.mode,
        device: asset.device,
        inode: asset.inode,
        size: entry.identity.size,
      })) {
        throw new CompanionInstallationError('foreign_installation', `asset identity changed at ${asset.path}`)
      }
      await this.removeFile(entry, plan, asset.relativePath)
    }
    const directories = currentTree.entries
      .filter((entry) => entry.identity.kind === 'directory' && entry.identity.path !== this.ports.paths.pluginsRoot)
      .sort((left, right) => right.identity.path.length - left.identity.path.length)
    for (const entry of directories) {
      const relativePath = relativeTo(this.ports.paths.pluginRoot, entry.identity.path)
      if (relativePath === '' || relativePath.startsWith('..')) continue
      const current = await this.ports.filesystem.inspectNoFollow(entry.identity.path)
      if (!sameIdentity(current, entry.identity)) throw new CompanionInstallationError('stale_precondition', `directory identity changed at ${entry.identity.path}`)
      await this.ports.filesystem.removeDirectoryExact(entry.identity)
      this.record('remove_asset', entry.identity.path, plan, { relativePath, kind: 'directory' })
    }
    const root = entryAt(currentTree, this.ports.paths.pluginRoot)
    if (root?.identity.kind !== 'directory') throw new CompanionInstallationError('foreign_installation', 'plugin root disappeared during uninstall')
    const currentRoot = await this.ports.filesystem.inspectNoFollow(this.ports.paths.pluginRoot)
    if (!sameIdentity(currentRoot, root.identity)) throw new CompanionInstallationError('stale_precondition', 'plugin root identity changed')
    await this.ports.filesystem.removeDirectoryExact(root.identity)
    this.record('remove_asset', this.ports.paths.pluginRoot, plan, { relativePath: '', kind: 'directory' })

    const finalReceipt = await this.ports.receipts.inspectNoFollow(plan.pluginId)
    if (finalReceipt === null || !sameIdentity(finalReceipt.identity, currentReceipt.identity)) {
      throw new CompanionInstallationError('stale_precondition', 'receipt identity changed during uninstall')
    }
    await this.ports.receipts.removeExact(plan.pluginId, finalReceipt.identity)
    this.record('remove_receipt', this.ports.paths.receiptPath, plan, { owner })
  }

  private async ensureReleaseDirectories(release: CompanionRelease, plan: CompanionInstallationPlan): Promise<void> {
    const owner = await this.ports.host.currentOwner()
    await this.assertSafeAncestors(this.ports.paths.pluginsRoot, true)
    const directories = [...expectedDirectories(release)].filter((relativePath) => relativePath !== '').sort((left, right) => left.length - right.length)
    const targets = [this.ports.paths.pluginRoot, ...directories.map((relativePath) => this.ports.paths.asset(relativePath))]
    for (const target of targets) {
      await this.assertNoSymlinkComponents(target)
      const identity = await this.ports.filesystem.inspectNoFollow(target)
      if (identity.kind === 'missing') {
        await this.ports.filesystem.ensureDirectory(target, owner, PLUGIN_DIRECTORY_MODE)
        this.record('mkdir', target, plan, {})
      } else {
        this.assertSafeDirectoryIdentity(identity, owner, target)
      }
    }
  }

  private async removeFile(entry: TreeEntry, plan: CompanionInstallationPlan, relativePath: string): Promise<void> {
    const current = await this.ports.filesystem.inspectNoFollow(entry.identity.path)
    if (!sameIdentity(current, entry.identity)) throw new CompanionInstallationError('stale_precondition', `asset identity changed at ${entry.identity.path}`)
    if (current.kind !== 'file') throw new CompanionInstallationError('unsafe_path', `asset is not a regular file at ${entry.identity.path}`)
    await this.ports.filesystem.removeFileExact(entry.identity)
    this.record('remove_asset', entry.identity.path, plan, { relativePath })
  }

  private async supportedRescan(plan: CompanionInstallationPlan): Promise<void> {
    await this.ports.shell.rescan(plan.pluginId)
    this.record('rescan', null, plan, {})
  }

  private async supportedEnable(plan: CompanionInstallationPlan): Promise<void> {
    const before = await this.ports.configuration.inspect()
    this.assertConfigurationForMutation(before, plan, false)
    await this.ports.shell.enable(plan.pluginId)
    this.record('enable', null, plan, {})
  }

  private async supportedDisable(plan: CompanionInstallationPlan): Promise<void> {
    const before = await this.ports.configuration.inspect()
    if (!shellEntryIsExact(before, plan.pluginId, this.ports.paths.pluginRoot)) {
      throw new CompanionInstallationError('configuration_conflict', 'refusing to disable a changed plugin entry')
    }
    await this.ports.shell.disable(plan.pluginId)
    this.record('disable', null, plan, {})
  }

  private assertConfigurationForMutation(
    snapshot: CompanionConfigurationSnapshot,
    plan: CompanionInstallationPlan,
    allowExisting: boolean,
  ): void {
    const entries = configEntriesFor(snapshot, plan.pluginId)
    if (new Set(snapshot.entries.map((entry) => entry.pluginId)).size !== snapshot.entries.length) {
      throw new CompanionInstallationError('configuration_conflict', 'shell.json contains duplicate entries')
    }
    if (entries.length > 0 && !allowExisting && !shellEntryIsExact(snapshot, plan.pluginId, this.ports.paths.pluginRoot)) {
      throw new CompanionInstallationError('configuration_conflict', 'shell.json contains a conflicting plugin entry')
    }
  }

  private assertEnabledConfiguration(snapshot: CompanionConfigurationSnapshot): void {
    if (!shellEntryIsExact(snapshot, COMPANION_PLUGIN_ID, this.ports.paths.pluginRoot)) {
      throw new CompanionInstallationError('postcondition_failed', 'supported shell enablement did not produce the owned entry')
    }
  }

  private async buildReceipt(
    plan: CompanionInstallationPlan,
    previousRelease: CompanionRelease | null,
    preimageBytes: string,
    postimageBytes: string,
  ): Promise<CompanionInstallationReceipt> {
    const release = plan.release
    if (release === null) throw new CompanionInstallationError('invalid_plan', 'receipt release is missing')
    const tree = await this.captureTree()
    const owner = await this.ports.host.currentOwner()
    const assets: CompanionAssetReceipt[] = []
    for (const relativePath of Object.keys(release.assets).sort()) {
      const inputPath = this.ports.paths.asset(relativePath)
      const entry = entryAt(tree, inputPath)
      if (entry === undefined || entry.identity.kind !== 'file' || entry.bytes === null) {
        throw new CompanionInstallationError('postcondition_failed', `cannot receipt missing asset ${relativePath}`)
      }
      if (entry.identity.owner !== owner) throw new CompanionInstallationError('foreign_installation', `asset owner changed at ${inputPath}`)
      if (entry.identity.mode === null || entry.identity.device === null || entry.identity.inode === null) {
        throw new CompanionInstallationError('postcondition_failed', `asset identity is incomplete at ${inputPath}`)
      }
      if (entry.identity.mode !== PLUGIN_ASSET_MODE) {
        throw new CompanionInstallationError('postcondition_failed', `asset mode is not the release mode at ${inputPath}`)
      }
      assets.push({
        relativePath,
        path: inputPath,
        sha256: this.ports.digest.sha256(entry.bytes),
        owner,
        mode: entry.identity.mode,
        device: entry.identity.device,
        inode: entry.identity.inode,
      })
    }
    const receipt: CompanionInstallationReceipt = {
      schemaVersion: 1,
      pluginId: plan.pluginId,
      release,
      previousRelease,
      compatibility: clone(plan.compatibility),
      planDigest: plan.planDigest,
      installedAt: this.ports.clock.now(),
      assets,
      shellJson: {
        preimageHash: this.ports.digest.sha256(preimageBytes),
        postimageHash: this.ports.digest.sha256(postimageBytes),
        preimageBytes,
        postimageBytes,
      },
    }
    return deepFreeze(receipt)
  }

  private async writeReceipt(
    plan: CompanionInstallationPlan,
    receipt: CompanionInstallationReceipt,
    priorObservation: ReceiptObservation | null,
  ): Promise<void> {
    await this.assertNoSymlinkComponents(this.ports.paths.receiptPath)
    await this.assertSafeAncestors(POSIX.dirname(this.ports.paths.receiptPath), true)
    const current = await this.ports.receipts.inspectNoFollow(plan.pluginId)
    if (priorObservation === null) {
      if (current !== null) throw new CompanionInstallationError('stale_precondition', 'receipt appeared before install')
    } else if (current === null || !sameIdentity(current.identity, priorObservation.identity)) {
      throw new CompanionInstallationError('stale_precondition', 'receipt identity changed before update')
    }
    const bytes = stableJson(receipt)
    await this.ports.receipts.writeAtomic(plan.pluginId, bytes, await this.ports.host.currentOwner(), RECEIPT_FILE_MODE)
    this.record('write_receipt', this.ports.paths.receiptPath, plan, { bytes: bytes.length })
  }

  private async assertPostcondition(plan: CompanionInstallationPlan): Promise<void> {
    const state = await this.captureState()
    if (plan.operation === 'uninstall') {
      const root = entryAt(state.tree, this.ports.paths.pluginRoot)
      if (root?.identity.kind !== 'missing' || state.receipt !== null || configEntriesFor(state.configuration, plan.pluginId).length !== 0) {
        throw new CompanionInstallationError('postcondition_failed', 'uninstall left owned installation state behind')
      }
      return
    }
    const receipt = await this.validateReceipt(state.receipt, state)
    if (receipt.value.planDigest !== plan.planDigest) {
      throw new CompanionInstallationError('postcondition_failed', 'installation receipt does not bind to the executed plan')
    }
    if (plan.release === null || releaseDigest(this.ports, receipt.value.release) !== releaseDigest(this.ports, plan.release)) {
      throw new CompanionInstallationError('postcondition_failed', 'installed release does not match plan')
    }
  }

  private async recoverOrThrow(
    plan: CompanionInstallationPlan,
    prior: StateSnapshot,
    original: unknown,
  ): Promise<void> {
    try {
      await this.recover(plan, prior)
    } catch (error) {
      if (error instanceof IncompleteRecoveryError) throw error
      const expected = await this.safeCaptureStateDigest(prior)
      const recovery: CompanionRecovery = {
        complete: false,
        incomplete: true,
        operation: plan.operation,
        planDigest: plan.planDigest,
        reason: errorDetail(error),
        expectedStateDigest: this.stateDigest(prior),
        observedStateDigest: expected.digest,
        preservedDriftPaths: expected.paths,
      }
      this.recordRecovery(recovery)
      throw new IncompleteRecoveryError('installation recovery is incomplete', recovery)
    }
    // A failed operation is intentionally rethrown by execute. This reference
    // keeps the recovery helper's control flow explicit for reviewers.
    void original
  }

  private async recover(plan: CompanionInstallationPlan, prior: StateSnapshot): Promise<void> {
    const expectedState = await this.captureState()
    const expectedStage = this.activeStage === null
      ? null
      : await this.captureTreeAt(this.activeStage.rootPath)
    if (this.activeStage !== null
      && this.activeStage.snapshot !== null
      && (expectedStage === null || !sameTree(expectedStage, this.activeStage.snapshot))) {
      const recovery: CompanionRecovery = {
        complete: false,
        incomplete: true,
        operation: plan.operation,
        planDigest: plan.planDigest,
        reason: 'installation staging is incomplete or changed before recovery',
        expectedStateDigest: this.stateDigest(prior),
        observedStateDigest: this.stateDigest(expectedState),
        preservedDriftPaths: expectedStage === null ? [this.activeStage.rootPath] : expectedStage.entries.map((entry) => entry.identity.path),
      }
      this.recordRecovery(recovery)
      throw new IncompleteRecoveryError('staging state prevents safe recovery', recovery)
    }
    this.ports.faults?.beforeRecovery()
    const observedState = await this.captureState()
    const observedStage = this.activeStage === null
      ? null
      : await this.captureTreeAt(this.activeStage.rootPath)
    const expectedDigest = this.stateDigest(expectedState)
    const observedDigest = this.stateDigest(observedState)
    const stageDrifted = expectedStage !== null && observedStage !== null && !sameTree(expectedStage, observedStage)
    if (expectedDigest !== observedDigest || stageDrifted || (expectedStage !== null && observedStage === null)) {
      const recovery: CompanionRecovery = {
        complete: false,
        incomplete: true,
        operation: plan.operation,
        planDigest: plan.planDigest,
        reason: 'state drift appeared during recovery precondition verification',
        expectedStateDigest: expectedDigest,
        observedStateDigest: observedDigest,
        preservedDriftPaths: [
          ...this.driftPaths(expectedState, observedState),
          ...(expectedStage === null || observedStage === null
            ? this.activeStage === null ? [] : [this.activeStage.rootPath]
            : treeDriftPaths(expectedStage, observedStage)),
        ].sort(),
      }
      this.recordRecovery(recovery)
      throw new IncompleteRecoveryError('state drift prevents safe recovery', recovery)
    }

    const restoredStagePaths = this.activeStage === null
      ? new Set<string>()
      : await this.restoreStagedEntries(plan, prior, expectedState)
    await this.restoreState(plan, prior, expectedState, restoredStagePaths)
    const restored = await this.captureState()
    const restoredDigest = this.stateDigest(restored)
    const priorDigest = this.stateDigest(prior)
    if (restoredDigest !== priorDigest) {
      const recovery: CompanionRecovery = {
        complete: false,
        incomplete: true,
        operation: plan.operation,
        planDigest: plan.planDigest,
        reason: 'recovery postcondition differs from the original state',
        expectedStateDigest: priorDigest,
        observedStateDigest: restoredDigest,
        preservedDriftPaths: this.driftPaths(prior, restored),
      }
      this.recordRecovery(recovery)
      throw new IncompleteRecoveryError('recovery did not restore the exact prior state', recovery)
    }
    const recovery: CompanionRecovery = {
      complete: true,
      incomplete: false,
      operation: plan.operation,
      planDigest: plan.planDigest,
      restoredStateDigest: restoredDigest,
    }
    this.recordRecovery(recovery)
  }

  private async restoreStagedEntries(
    plan: CompanionInstallationPlan,
    prior: StateSnapshot,
    expected: StateSnapshot,
  ): Promise<Set<string>> {
    const stage = this.activeStage
    if (stage === null) return new Set()
    const restoredPaths = new Set<string>()
    const currentStage = await this.captureTreeAt(stage.rootPath)
    const allowedStagePaths = new Set<string>([stage.rootPath])
    for (const moved of stage.entries) {
      const sourcePrior = subtree(prior.tree, moved.source.identity.path)
      const expectedDestination = remapTree(sourcePrior, moved.source.identity.path, moved.destinationPath)
      for (const entry of expectedDestination.entries) {
        allowedStagePaths.add(entry.identity.path)
        let parent = POSIX.dirname(entry.identity.path)
        while (pathIsWithin(stage.rootPath, parent) && parent !== stage.rootPath) {
          allowedStagePaths.add(parent)
          parent = POSIX.dirname(parent)
        }
      }
    }
    if (currentStage.entries.some((entry) => !allowedStagePaths.has(entry.identity.path))) {
      throw new CompanionError('incomplete_recovery', 'unexpected content exists in installation staging')
    }
    for (const moved of stage.entries) {
      const sourcePath = moved.source.identity.path
      const sourcePrior = subtree(prior.tree, sourcePath)
      const expectedSource = subtree(expected.tree, sourcePath)
      const sourceCurrentIdentity = await this.ports.filesystem.inspectNoFollow(sourcePath)
      const destinationTree = await this.captureTreeAt(moved.destinationPath)
      const expectedDestination = remapTree(sourcePrior, sourcePath, moved.destinationPath)
      if (!sameTree(destinationTree, expectedDestination)) {
        const sourceIsPrior = expectedSource.entries.length > 0
          && sameTree(subtree(await this.captureTreeAt(sourcePath), sourcePath), sourcePrior)
        if (!sourceIsPrior || destinationTree.entries[0]?.identity.kind !== 'missing') {
          throw new CompanionError('incomplete_recovery', `staged asset drifted at ${moved.destinationPath}`)
        }
        continue
      }
      if (sourceCurrentIdentity.kind !== 'missing') {
        if (expectedSource.entries.length === 0) {
          throw new CompanionError('incomplete_recovery', `staged source path drifted at ${sourcePath}`)
        }
        const currentSource = await this.captureTreeAt(sourcePath)
        if (!sameTree(currentSource, expectedSource)) {
          throw new CompanionError('incomplete_recovery', `replacement path drifted at ${sourcePath}`)
        }
        await this.removeTree(currentSource, sourcePath, plan, { recovery: true, staged: true })
      }
      const destinationRoot = await this.ports.filesystem.inspectNoFollow(moved.destinationPath)
      if (destinationRoot.kind === 'missing') {
        throw new CompanionError('incomplete_recovery', `staged asset disappeared at ${moved.destinationPath}`)
      }
      await this.ports.filesystem.renameExact(destinationRoot, sourcePath)
      restoredPaths.add(sourcePath)
      this.record('rename', moved.destinationPath, plan, {
        from: moved.destinationPath,
        to: sourcePath,
        recovery: true,
        staged: true,
      })
    }
    const remainingStage = await this.captureTreeAt(stage.rootPath)
    await this.removeTree(remainingStage, stage.rootPath, plan, { recovery: true })
    this.activeStage = null
    return restoredPaths
  }

  private async restoreState(
    plan: CompanionInstallationPlan,
    prior: StateSnapshot,
    expected: StateSnapshot,
    restoredStagePaths: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (expected.configuration.shellJsonBytes !== prior.configuration.shellJsonBytes) {
      const priorEnabled = shellHasPlugin(prior.configuration, plan.pluginId)
      if (priorEnabled) await this.supportedEnable(plan)
      else await this.supportedDisable(plan)
      const configuration = await this.ports.configuration.inspect()
      if (configuration.shellJsonBytes !== prior.configuration.shellJsonBytes) {
        throw new CompanionError('incomplete_recovery', 'supported shell operation did not restore shell.json bytes')
      }
    }

    const currentTree = await this.captureTree()
    const priorByPath = new Map(prior.tree.entries.map((entry) => [entry.identity.path, entry]))
    const currentByPath = new Map(currentTree.entries.map((entry) => [entry.identity.path, entry]))
    const expectedByPath = new Map(expected.tree.entries.map((entry) => [entry.identity.path, entry]))

    for (const current of currentTree.entries
      .filter((entry) => entry.identity.kind === 'file')
      .sort((left, right) => right.identity.path.length - left.identity.path.length)) {
      if (!priorByPath.has(current.identity.path)) {
        const expectedCurrent = expectedByPath.get(current.identity.path)
        if (expectedCurrent === undefined || !sameIdentity(current.identity, expectedCurrent.identity)) {
          throw new CompanionError('incomplete_recovery', `current asset drifted at ${current.identity.path}`)
        }
        await this.ports.filesystem.removeFileExact(current.identity)
        this.record('remove_asset', current.identity.path, plan, { recovery: true })
      }
    }

    const priorDirectoryPaths = new Set(
      prior.tree.entries
        .filter((entry) => entry.identity.kind === 'directory')
        .map((entry) => entry.identity.path),
    )
    for (const current of currentTree.entries
      .filter((entry) => entry.identity.kind === 'directory')
      .sort((left, right) => right.identity.path.length - left.identity.path.length)) {
      if (priorDirectoryPaths.has(current.identity.path)) continue
      const expectedCurrent = expectedByPath.get(current.identity.path)
      if (expectedCurrent === undefined || !sameIdentity(current.identity, expectedCurrent.identity)) {
        throw new CompanionError('incomplete_recovery', `current directory drifted at ${current.identity.path}`)
      }
      const observed = await this.ports.filesystem.inspectNoFollow(current.identity.path)
      if (!sameIdentity(observed, current.identity)) {
        throw new CompanionError('incomplete_recovery', `current directory identity changed at ${current.identity.path}`)
      }
      await this.ports.filesystem.removeDirectoryExact(current.identity)
      this.record('remove_asset', current.identity.path, plan, { recovery: true, kind: 'directory' })
    }

    for (const priorEntry of prior.tree.entries) {
      if (priorEntry.identity.kind !== 'directory' || priorEntry.identity.path === '/') continue
      const current = currentByPath.get(priorEntry.identity.path)
      if (current === undefined || current.identity.kind === 'missing') {
        const owner = priorEntry.identity.owner ?? await this.ports.host.currentOwner()
        await this.ports.filesystem.ensureDirectory(priorEntry.identity.path, owner, priorEntry.identity.mode ?? PLUGIN_DIRECTORY_MODE)
        this.record('mkdir', priorEntry.identity.path, plan, { recovery: true })
      }
    }

    for (const priorEntry of prior.tree.entries) {
      if (priorEntry.identity.kind !== 'file' || priorEntry.bytes === null) continue
      const current = await this.ports.filesystem.inspectNoFollow(priorEntry.identity.path)
      const expectedCurrent = expectedByPath.get(priorEntry.identity.path)
      const restoredByStage = [...restoredStagePaths].some((root) => pathIsWithin(root, priorEntry.identity.path))
      if (!restoredByStage && expectedCurrent !== undefined && expectedCurrent.identity.kind !== 'missing') {
        const observed = await this.ports.filesystem.inspectNoFollow(priorEntry.identity.path)
        if (!sameIdentity(observed, expectedCurrent.identity) && observed.kind !== 'missing') {
          throw new CompanionError('incomplete_recovery', `asset identity drifted at ${priorEntry.identity.path}`)
        }
      }
      if (current.kind === 'missing') {
        await this.ports.filesystem.writeBytesAtomic(
          priorEntry.identity.path,
          priorEntry.bytes,
          priorEntry.identity.owner ?? await this.ports.host.currentOwner(),
          priorEntry.identity.mode ?? PLUGIN_ASSET_MODE,
        )
        this.record('write_asset', priorEntry.identity.path, plan, { recovery: true })
      } else if (current.kind === 'file') {
        const currentBytes = await this.ports.filesystem.readBytesNoFollow(priorEntry.identity.path)
        if (currentBytes !== priorEntry.bytes || current.owner !== priorEntry.identity.owner || current.mode !== priorEntry.identity.mode) {
          await this.ports.filesystem.writeBytesAtomic(
            priorEntry.identity.path,
            priorEntry.bytes,
            priorEntry.identity.owner ?? await this.ports.host.currentOwner(),
            priorEntry.identity.mode ?? PLUGIN_ASSET_MODE,
          )
          this.record('write_asset', priorEntry.identity.path, plan, { recovery: true })
        }
      } else {
        throw new CompanionError('incomplete_recovery', `cannot restore non-file path ${priorEntry.identity.path}`)
      }
    }

    const currentReceipt = await this.ports.receipts.inspectNoFollow(plan.pluginId)
    if (prior.receipt === null) {
      if (currentReceipt !== null) {
        const expectedReceipt = expected.receipt
        if (expectedReceipt === null || !sameIdentity(currentReceipt.identity, expectedReceipt.identity)) {
          throw new CompanionError('incomplete_recovery', 'receipt identity drifted during recovery')
        }
        await this.ports.receipts.removeExact(plan.pluginId, currentReceipt.identity)
        this.record('remove_receipt', this.ports.paths.receiptPath, plan, { recovery: true })
      }
    } else if (currentReceipt === null) {
      await this.ports.receipts.writeAtomic(
        plan.pluginId,
        prior.receipt.bytes,
        prior.receipt.identity.owner ?? await this.ports.host.currentOwner(),
        prior.receipt.identity.mode ?? RECEIPT_FILE_MODE,
      )
      this.record('write_receipt', this.ports.paths.receiptPath, plan, { recovery: true })
    } else {
      const expectedReceipt = expected.receipt
      if (expectedReceipt !== null && !sameIdentity(currentReceipt.identity, expectedReceipt.identity)) {
        throw new CompanionError('incomplete_recovery', 'receipt identity drifted during recovery')
      }
      if (currentReceipt.bytes !== prior.receipt.bytes) {
        await this.ports.receipts.writeAtomic(
          plan.pluginId,
          prior.receipt.bytes,
          prior.receipt.identity.owner ?? await this.ports.host.currentOwner(),
          prior.receipt.identity.mode ?? RECEIPT_FILE_MODE,
        )
        this.record('write_receipt', this.ports.paths.receiptPath, plan, { recovery: true })
      }
    }
  }

  private stateDigest(state: StateSnapshot): string {
    return this.ports.digest.stableDigest({
      compatibility: state.compatibility,
      tree: treeShapeDigest(state.tree),
      receipt: receiptShapeDigest(state.receipt),
      shellJsonBytes: state.configuration.shellJsonBytes,
    })
  }

  private async safeCaptureStateDigest(reference?: StateSnapshot): Promise<{ digest: string; paths: string[] }> {
    try {
      const state = await this.captureState()
      return {
        digest: this.stateDigest(state),
        paths: reference === undefined ? [] : this.driftPaths(reference, state),
      }
    } catch (error) {
      return { digest: `unavailable:${errorDetail(error)}`, paths: [] }
    }
  }

  private driftPaths(expected: StateSnapshot, observed: StateSnapshot): string[] {
    const result = new Set<string>()
    const expectedTree = new Map(expected.tree.entries.map((entry) => [entry.identity.path, entry]))
    const observedTree = new Map(observed.tree.entries.map((entry) => [entry.identity.path, entry]))
    for (const pathValue of new Set([...expectedTree.keys(), ...observedTree.keys()])) {
      const left = expectedTree.get(pathValue)
      const right = observedTree.get(pathValue)
      if (left === undefined || right === undefined || !sameIdentity(left.identity, right.identity) || left.bytes !== right.bytes) result.add(pathValue)
    }
    if (expected.configuration.shellJsonBytes !== observed.configuration.shellJsonBytes) result.add('shell.json')
    if (!sameReceiptObservation(expected.receipt, observed.receipt)) result.add(this.ports.paths.receiptPath)
    return [...result].sort()
  }

  private checkpoint(point: string): void {
    this.ports.faults?.checkpoint(point)
  }

  private record(
    operation: CompanionMutationOperation,
    inputPath: string | null,
    plan: CompanionInstallationPlan | undefined,
    detail: Record<string, unknown>,
  ): void {
    if (this.ports.mutations === undefined || plan === undefined) return
    this.ports.mutations.record({
      sequence: ++this.mutationSequence,
      operation,
      path: inputPath,
      pluginId: plan.pluginId,
      planDigest: plan.planDigest,
      detail,
    })
  }

  private recordRecovery(recovery: CompanionRecovery): void {
    this.ports.recovery?.record(recovery)
  }
}

function requireExactPlanFields(value: Record<string, unknown>): void {
  const expected = ['schemaVersion', 'operation', 'pluginId', 'release', 'compatibility', 'precondition', 'planDigest', 'inspectedAt']
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((field, index) => field !== sorted[index])) {
    throw new CompanionInstallationError('invalid_plan', `installation plan fields must be exactly ${sorted.join(', ')}`)
  }
}

export const InstallationManager = CompanionInstallation

export function createCompanionInstallation(ports: CompanionInstallationPorts): CompanionInstallation {
  return new CompanionInstallation(ports)
}
