/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * In-memory Omarchy ports for the Companion Installation seam. This file has
 * no real filesystem, shell IPC, configuration, process, or GUI dependency.
 * Fixture helpers are intentionally separate from the port methods so tests
 * can model hostile state without granting the installer extra authority.
 */

import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  COMPANION_PLUGIN_ID,
  COMPANION_PLUGIN_VERSION,
  CompanionInstallationError,
  type CompanionAuthorizationPort,
  type CompanionCompatibility,
  type CompanionConfigurationPort,
  type CompanionConfigurationSnapshot,
  type CompanionDigestPort,
  type CompanionFilesystemPort,
  type CompanionHostPort,
  type CompanionInstallationAuthorization,
  type CompanionInstallationPlan,
  type CompanionInstallationPorts,
  type CompanionInstallationReceipt,
  type CompanionInstallationShellPort,
  type CompanionMutationRecord,
  type CompanionReceiptPort,
  type CompanionRecovery,
  type FilesystemIdentity,
  type FilesystemNodeKind,
  type PluginConfigurationEntry,
} from './contracts.ts'
import { normalizeAbsolutePath } from './path-validation.ts'

const POSIX = path.posix
const DEFAULT_OWNER = 'fake-omarchestra-user'
const FOREIGN_OWNER = 'foreign-user'
const DEFAULT_FILE_MODE = 0o644
const DEFAULT_DIRECTORY_MODE = 0o755
const RECEIPT_MODE = 0o600

const DEFAULT_COMPATIBILITY: CompanionCompatibility = {
  omarchy: '4.0.2-1',
  quickshell: '0.3.1-1',
}

interface FakeNode {
  kind: Exclude<FilesystemNodeKind, 'missing'>
  owner: string
  mode: number
  device: number
  inode: number
  bytes?: string
  target?: string
}

function normalizeAbsolute(input: string): string {
  return normalizeAbsolutePath(input, (reason, value) => new Error(
    `fake path must be ${reason === 'canonical' ? 'canonical' : 'absolute POSIX text'}: ${value}`,
  ))
}

function parentPath(input: string): string {
  const parent = POSIX.dirname(input)
  return parent === '' ? '/' : parent
}

function pathComponents(input: string): string[] {
  const normalized = POSIX.normalize(input)
  if (normalized === '/') return []
  return normalized.slice(1).split('/')
}

function pathPrefixes(input: string): string[] {
  const components = pathComponents(input)
  const result = ['/']
  let current = ''
  for (const component of components) {
    current += `/${component}`
    result.push(current)
  }
  return result
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry))
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

function jsonBytes(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('value is not JSON serializable')
  return encoded
}

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
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

function assertExpectedIdentity(actual: FilesystemIdentity, expected: FilesystemIdentity): void {
  if (!sameIdentity(actual, expected)) {
    throw new CompanionInstallationError(
      'stale_precondition',
      `fake filesystem identity changed at ${expected.path}`,
    )
  }
}

/** A no-follow, device/inode-aware in-memory filesystem. */
export class FakeFilesystem implements CompanionFilesystemPort {
  private readonly nodes = new Map<string, FakeNode>()
  private nextInode = 100
  readonly owner: string
  readonly device: number

  constructor(owner = DEFAULT_OWNER, device = 7) {
    this.owner = owner
    this.device = device
    this.nodes.set('/', {
      kind: 'directory',
      owner,
      mode: DEFAULT_DIRECTORY_MODE,
      device,
      inode: this.nextInode++,
    })
  }

  inspectNoFollow(input: string): FilesystemIdentity {
    const inputPath = normalizeAbsolute(input)
    for (const prefix of pathPrefixes(inputPath)) {
      const node = this.nodes.get(prefix)
      if (node?.kind === 'symlink') return this.identity(prefix, node)
    }
    const direct = this.nodes.get(inputPath)
    if (direct !== undefined) return this.identity(inputPath, direct)
    return {
      path: inputPath,
      kind: 'missing',
      owner: null,
      mode: null,
      device: null,
      inode: null,
      size: null,
    }
  }

  listDirectoryNoFollow(input: string): string[] {
    const inputPath = normalizeAbsolute(input)
    const identity = this.inspectNoFollow(inputPath)
    if (identity.kind !== 'directory') {
      throw new CompanionInstallationError('unsafe_path', `${inputPath} is not a directory`)
    }
    const prefix = inputPath === '/' ? '/' : `${inputPath}/`
    const names = new Set<string>()
    for (const candidate of this.nodes.keys()) {
      if (!candidate.startsWith(prefix) || candidate === inputPath) continue
      const remainder = candidate.slice(prefix.length)
      if (remainder.length === 0 || remainder.includes('/')) continue
      names.add(remainder)
    }
    return [...names].sort()
  }

  readBytesNoFollow(input: string): string {
    const inputPath = normalizeAbsolute(input)
    const identity = this.inspectNoFollow(inputPath)
    const node = this.nodes.get(inputPath)
    if (identity.kind !== 'file' || node?.kind !== 'file') {
      throw new CompanionInstallationError('unsafe_path', `${inputPath} is not a regular file`)
    }
    return node.bytes ?? ''
  }

  ensureDirectory(input: string, owner = this.owner, mode = DEFAULT_DIRECTORY_MODE): void {
    const inputPath = normalizeAbsolute(input)
    const prefixes = pathPrefixes(inputPath)
    let current = '/'
    for (const prefix of prefixes.slice(1)) {
      current = prefix
      const existing = this.nodes.get(current)
      if (existing !== undefined) {
        if (existing.kind !== 'directory') {
          throw new CompanionInstallationError('unsafe_path', `${current} is not a directory`)
        }
        continue
      }
      const parent = this.nodes.get(parentPath(current))
      if (parent?.kind !== 'directory') {
        throw new CompanionInstallationError('unsafe_path', `cannot create ${current} below a non-directory`)
      }
      this.nodes.set(current, {
        kind: 'directory',
        owner,
        mode: current === inputPath ? mode : DEFAULT_DIRECTORY_MODE,
        device: this.device,
        inode: this.nextInode++,
      })
    }
  }

  writeBytesAtomic(input: string, bytes: string, owner = this.owner, mode = DEFAULT_FILE_MODE): void {
    const inputPath = normalizeAbsolute(input)
    if (typeof bytes !== 'string') throw new Error('fake filesystem bytes must be a string')
    const parent = this.inspectNoFollow(parentPath(inputPath))
    if (parent.kind !== 'directory') throw new CompanionInstallationError('unsafe_path', `parent missing for ${inputPath}`)
    const existing = this.nodes.get(inputPath)
    if (existing?.kind === 'symlink' || existing?.kind === 'directory') {
      throw new CompanionInstallationError('unsafe_path', `cannot replace non-file ${inputPath}`)
    }
    // Preserve device/inode on an ordinary replacement. This models an
    // atomic replacement whose identity has already been revalidated by the
    // installer and makes exact fake recovery observable.
    this.nodes.set(inputPath, {
      kind: 'file',
      owner,
      mode,
      device: existing?.device ?? this.device,
      inode: existing?.inode ?? this.nextInode++,
      bytes,
    })
  }

  renameExact(from: FilesystemIdentity, toPath: string): void {
    const source = normalizeAbsolute(from.path)
    const destination = normalizeAbsolute(toPath)
    const current = this.inspectNoFollow(source)
    assertExpectedIdentity(current, from)
    const node = this.nodes.get(source)
    if (node === undefined) throw new CompanionInstallationError('stale_precondition', `source disappeared: ${source}`)
    if (destination === source || destination.startsWith(`${source}/`)) {
      throw new CompanionInstallationError('operation_failed', `invalid rename destination: ${destination}`)
    }
    if ([...this.nodes.keys()].some((candidate) => candidate === destination || candidate.startsWith(`${destination}/`))) {
      throw new CompanionInstallationError('operation_failed', `destination exists: ${destination}`)
    }
    const destinationParent = this.inspectNoFollow(parentPath(destination))
    if (destinationParent.kind !== 'directory') throw new CompanionInstallationError('unsafe_path', `destination parent missing: ${destination}`)
    const sourcePrefix = source === '/' ? '/' : `${source}/`
    const moved = [...this.nodes.entries()]
      .filter(([candidate]) => candidate === source || candidate.startsWith(sourcePrefix))
      .map(([candidate, value]) => [candidate, { ...value }] as const)
      .sort(([left], [right]) => left.length - right.length)
    for (const [candidate] of moved) this.nodes.delete(candidate)
    for (const [candidate, value] of moved) {
      const suffix = candidate === source ? '' : candidate.slice(source.length)
      this.nodes.set(`${destination}${suffix}`, value)
    }
  }

  removeFileExact(identity: FilesystemIdentity): void {
    const current = this.inspectNoFollow(identity.path)
    assertExpectedIdentity(current, identity)
    if (identity.kind !== 'file') throw new CompanionInstallationError('unsafe_path', `${identity.path} is not a file`)
    this.nodes.delete(identity.path)
  }

  removeDirectoryExact(identity: FilesystemIdentity): void {
    const current = this.inspectNoFollow(identity.path)
    assertExpectedIdentity(current, identity)
    if (identity.kind !== 'directory') throw new CompanionInstallationError('unsafe_path', `${identity.path} is not a directory`)
    if (this.listDirectoryNoFollow(identity.path).length !== 0) {
      throw new CompanionInstallationError('operation_failed', `${identity.path} is not empty`)
    }
    if (identity.path === '/') throw new CompanionInstallationError('unsafe_path', 'cannot remove fake root')
    this.nodes.delete(identity.path)
  }

  // -----------------------------------------------------------------------
  // Fixture-only mutation helpers.
  // -----------------------------------------------------------------------

  addFile(input: string, bytes: string, metadata: { owner?: string; mode?: number } = {}): void {
    const inputPath = normalizeAbsolute(input)
    this.ensureDirectory(parentPath(inputPath), metadata.owner ?? this.owner)
    this.writeBytesAtomic(inputPath, bytes, metadata.owner ?? this.owner, metadata.mode ?? DEFAULT_FILE_MODE)
  }

  addForeignFile(parent: string, name: string, bytes: string): void {
    const directory = normalizeAbsolute(parent)
    this.ensureDirectory(directory)
    this.addFile(POSIX.join(directory, name), bytes, { owner: this.owner, mode: DEFAULT_FILE_MODE })
  }

  addSymlink(input: string, target = '/foreign-target'): void {
    const inputPath = normalizeAbsolute(input)
    this.ensureDirectory(parentPath(inputPath))
    this.nodes.set(inputPath, {
      kind: 'symlink',
      owner: this.owner,
      mode: 0o777,
      device: this.device,
      inode: this.nextInode++,
      target,
    })
  }

  writeBytes(input: string, bytes: string): void {
    const inputPath = normalizeAbsolute(input)
    const node = this.nodes.get(inputPath)
    if (node?.kind !== 'file') throw new CompanionInstallationError('unsafe_path', `${inputPath} is not a file`)
    node.bytes = bytes
  }

  readBytes(input: string): string {
    return this.readBytesNoFollow(input)
  }

  remove(input: string): void {
    const inputPath = normalizeAbsolute(input)
    if (inputPath === '/') throw new Error('cannot remove fake root')
    const identity = this.inspectNoFollow(inputPath)
    if (identity.kind === 'missing') return
    for (const candidate of [...this.nodes.keys()]) {
      if (candidate === inputPath || candidate.startsWith(`${inputPath}/`)) this.nodes.delete(candidate)
    }
  }

  setMetadata(input: string, metadata: { owner?: string; mode?: number }): void {
    const inputPath = normalizeAbsolute(input)
    const node = this.nodes.get(inputPath)
    if (node === undefined) throw new Error(`fake node missing: ${inputPath}`)
    if (metadata.owner !== undefined) node.owner = metadata.owner
    if (metadata.mode !== undefined) node.mode = metadata.mode
  }

  has(input: string): boolean {
    return this.inspectNoFollow(input).kind !== 'missing'
  }

  snapshot(prefix?: string): Array<Record<string, unknown>> {
    const normalizedPrefix = prefix === undefined ? undefined : normalizeAbsolute(prefix)
    return [...this.nodes.entries()]
      .filter(([inputPath]) => normalizedPrefix === undefined
        || inputPath === normalizedPrefix
        || inputPath.startsWith(`${normalizedPrefix}/`))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([inputPath, node]) => ({
        path: inputPath,
        kind: node.kind,
        owner: node.owner,
        mode: node.mode,
        device: node.device,
        inode: node.inode,
        bytes: node.kind === 'file' ? node.bytes : null,
        target: node.kind === 'symlink' ? node.target : null,
      }))
  }

  private identity(inputPath: string, node: FakeNode): FilesystemIdentity {
    return {
      path: inputPath,
      kind: node.kind,
      owner: node.owner,
      mode: node.mode,
      device: node.device,
      inode: node.inode,
      size: node.kind === 'file' ? new TextEncoder().encode(node.bytes ?? '').byteLength : 0,
    }
  }
}

class FakeConfiguration implements CompanionConfigurationPort {
  private bytes: string
  private readonly pluginRoot: string
  private readonly enableRestoreBytes = new Map<string, string>()
  private disableRewriteOnce: ((bytes: string) => string) | null = null

  constructor(pluginRoot: string, initialBytes: string) {
    this.pluginRoot = pluginRoot
    this.bytes = initialBytes
  }

  inspect(): CompanionConfigurationSnapshot {
    const document = this.parse()
    const enabled = document.enabledPlugins as unknown[]
    const sources = document.pluginSources as Record<string, unknown>
    const ids = [...new Set([
      ...enabled.map((value) => String(value)),
      ...Object.keys(sources),
    ])]
    const entries: PluginConfigurationEntry[] = []
    for (const pluginId of ids) {
      entries.push({
        pluginId,
        source: typeof sources[pluginId] === 'string' ? sources[pluginId] as string : null,
        enabled: enabled.some((value) => value === pluginId),
      })
      const duplicateCount = enabled.filter((value) => value === pluginId).length - 1
      for (let index = 0; index < duplicateCount; index += 1) {
        entries.push({
          pluginId,
          source: typeof sources[pluginId] === 'string' ? sources[pluginId] as string : null,
          enabled: true,
        })
      }
    }
    return {
      shellJsonBytes: this.bytes,
      shellJsonSha256: sha256(this.bytes),
      entries,
    }
  }

  shellJsonBytes(): string {
    return this.bytes
  }

  setShellJsonBytes(bytes: string): void {
    this.bytes = bytes
  }

  setDocument(document: Record<string, unknown>): void {
    this.bytes = jsonBytes(document)
  }

  addConflictingPluginEntry(pluginId: string, source: string): void {
    const document = this.parse()
    const enabled = document.enabledPlugins as unknown[]
    const sources = document.pluginSources as Record<string, unknown>
    if (!enabled.includes(pluginId)) enabled.push(pluginId)
    sources[pluginId] = source
    this.bytes = jsonBytes(document)
  }

  rewriteNextDisable(transform: (bytes: string) => string): void {
    this.disableRewriteOnce = transform
  }

  addDuplicateEnabledPlugin(pluginId: string): void {
    const document = this.parse()
    const enabled = document.enabledPlugins as unknown[]
    const sources = document.pluginSources as Record<string, unknown>
    enabled.push(pluginId, pluginId)
    sources[pluginId] = this.pluginRoot
    this.bytes = jsonBytes(document)
  }

  enabledPluginCount(pluginId: string): number {
    try {
      const document = this.parse()
      return (document.enabledPlugins as unknown[]).filter((value) => value === pluginId).length
    } catch {
      return 0
    }
  }

  unrelatedDocument(pluginId: string): Record<string, unknown> {
    let document: Record<string, unknown>
    try {
      document = this.parse()
    } catch {
      return { malformed: this.bytes }
    }
    const enabled = (document.enabledPlugins as unknown[]).filter((value) => value !== pluginId)
    const sources = Object.fromEntries(
      Object.entries(document.pluginSources as Record<string, unknown>)
        .filter(([key]) => key !== pluginId),
    )
    return { ...document, enabledPlugins: enabled, pluginSources: sources }
  }

  enable(pluginId: string): void {
    const document = this.parse()
    const enabled = document.enabledPlugins as unknown[]
    const sources = document.pluginSources as Record<string, unknown>
    const count = enabled.filter((value) => value === pluginId).length
    if (count === 0) {
      this.enableRestoreBytes.set(pluginId, this.bytes)
      enabled.push(pluginId)
    }
    sources[pluginId] = this.pluginRoot
    this.bytes = jsonBytes(document)
  }

  disable(pluginId: string): void {
    const restore = this.enableRestoreBytes.get(pluginId)
    if (restore !== undefined) {
      this.bytes = restore
      this.enableRestoreBytes.delete(pluginId)
    } else {
      const document = this.parse()
      document.enabledPlugins = (document.enabledPlugins as unknown[]).filter((value) => value !== pluginId)
      const sources = document.pluginSources as Record<string, unknown>
      delete sources[pluginId]
      this.bytes = jsonBytes(document)
    }
    if (this.disableRewriteOnce !== null) {
      const transform = this.disableRewriteOnce
      this.disableRewriteOnce = null
      this.bytes = transform(this.bytes)
    }
  }

  private parse(): Record<string, unknown> {
    let parsed: unknown
    try {
      parsed = JSON.parse(this.bytes)
    } catch {
      throw new CompanionInstallationError('configuration_conflict', 'fake shell.json is malformed JSON')
    }
    if (!isPlainObject(parsed)
      || !Array.isArray(parsed.enabledPlugins)
      || !isPlainObject(parsed.pluginSources)
      || parsed.enabledPlugins.some((value) => typeof value !== 'string' || value.length === 0)
      || Object.entries(parsed.pluginSources).some(([pluginId, source]) =>
        pluginId.length === 0 || (source !== null && (typeof source !== 'string' || source.length === 0)))) {
      throw new CompanionInstallationError('configuration_conflict', 'fake shell.json has an unsupported shape')
    }
    return clone(parsed)
  }
}

class FakeShell implements CompanionInstallationShellPort {
  private readonly configuration: FakeConfiguration
  private readonly callLog: Array<{ operation: string; pluginId: string }> = []

  constructor(configuration: FakeConfiguration) {
    this.configuration = configuration
  }

  rescan(pluginId: string): void {
    this.callLog.push({ operation: 'rescan', pluginId })
  }

  enable(pluginId: string): void {
    this.callLog.push({ operation: 'enable', pluginId })
    this.configuration.enable(pluginId)
  }

  disable(pluginId: string): void {
    this.callLog.push({ operation: 'disable', pluginId })
    this.configuration.disable(pluginId)
  }

  calls(): Array<{ operation: string; pluginId: string }> {
    return clone(this.callLog)
  }
}

class FakeReceipts implements CompanionReceiptPort {
  private readonly filesystem: FakeFilesystem
  private readonly receiptPath: string

  constructor(filesystem: FakeFilesystem, receiptPath: string) {
    this.filesystem = filesystem
    this.receiptPath = receiptPath
  }

  inspectNoFollow(pluginId: string): { identity: FilesystemIdentity; bytes: string } | null {
    if (pluginId !== COMPANION_PLUGIN_ID) return null
    const identity = this.filesystem.inspectNoFollow(this.receiptPath)
    if (identity.kind === 'missing') return null
    return {
      identity,
      bytes: identity.kind === 'file' ? this.filesystem.readBytesNoFollow(this.receiptPath) : '',
    }
  }

  writeAtomic(pluginId: string, bytes: string, owner: string, mode: number): void {
    if (pluginId !== COMPANION_PLUGIN_ID) throw new CompanionInstallationError('invalid_plan', 'fake receipt plugin ID mismatch')
    this.filesystem.ensureDirectory(parentPath(this.receiptPath), owner)
    this.filesystem.writeBytesAtomic(this.receiptPath, bytes, owner, mode)
  }

  removeExact(pluginId: string, identity: FilesystemIdentity): void {
    if (pluginId !== COMPANION_PLUGIN_ID) throw new CompanionInstallationError('invalid_plan', 'fake receipt plugin ID mismatch')
    this.filesystem.removeFileExact(identity)
  }

  remove(): void {
    this.filesystem.remove(this.receiptPath)
  }

  replace(value: unknown): void {
    this.filesystem.addFile(this.receiptPath, jsonBytes(value), { owner: this.filesystem.owner, mode: RECEIPT_MODE })
  }

  mutate(mutator: (value: any) => void): void {
    const current = this.inspectNoFollow(COMPANION_PLUGIN_ID)
    if (current === null || current.identity.kind !== 'file') throw new Error('fake receipt is absent')
    const value = JSON.parse(current.bytes)
    mutator(value)
    this.filesystem.writeBytes(this.receiptPath, jsonBytes(value))
  }

  setMetadata(metadata: { owner?: string; mode?: number }): void {
    this.filesystem.setMetadata(this.receiptPath, metadata)
  }

  addSymlink(target = '/foreign-receipt-target'): void {
    this.filesystem.addSymlink(this.receiptPath, target)
  }

  exists(): boolean {
    return this.filesystem.inspectNoFollow(this.receiptPath).kind !== 'missing'
  }
}

class FakeHost implements CompanionHostPort {
  private currentCompatibility: CompanionCompatibility
  readonly owner: string

  constructor(compatibility: CompanionCompatibility, owner: string) {
    this.currentCompatibility = clone(compatibility)
    this.owner = owner
  }

  compatibility(): CompanionCompatibility {
    return clone(this.currentCompatibility)
  }

  currentOwner(): string {
    return this.owner
  }

  setCompatibility(value: CompanionCompatibility): void {
    this.currentCompatibility = clone(value)
  }
}

class FakeDigest implements CompanionDigestPort {
  sha256(bytes: string): string {
    return sha256(bytes)
  }

  stableDigest(value: unknown): string {
    return sha256(jsonBytes(canonical(value)))
  }
}

class FakeClock {
  private tick = 0
  now(): string {
    const suffix = String(this.tick++).padStart(3, '0')
    return `2026-09-03T00:00:00.${suffix}Z`
  }
}

class FakeAuthorization implements CompanionAuthorizationPort {
  private readonly digest: CompanionDigestPort
  private readonly grants = new Map<string, { operation: string; planDigest: string; authorizationId: string }>()
  private sequence = 0

  constructor(digest: CompanionDigestPort) {
    this.digest = digest
  }

  grant(plan: CompanionInstallationPlan, overrides: Record<string, unknown> = {}): CompanionInstallationAuthorization {
    const operation = typeof overrides.operation === 'string' ? overrides.operation : plan.operation
    const planDigest = typeof overrides.planDigest === 'string' ? overrides.planDigest : plan.planDigest
    const authorizationId = typeof overrides.authorizationId === 'string'
      ? overrides.authorizationId
      : `fake-authorization-${++this.sequence}`
    const token = typeof overrides.token === 'string'
      ? overrides.token
      : this.digest.stableDigest({ operation, planDigest, authorizationId, issuer: 'fake' })
    this.grants.set(token, { operation, planDigest, authorizationId })
    return { operation: operation as CompanionInstallationAuthorization['operation'], planDigest, authorizationId, token }
  }

  verify(authorization: CompanionInstallationAuthorization, plan: CompanionInstallationPlan): boolean {
    const grant = this.grants.get(authorization.token)
    return grant !== undefined
      && grant.operation === plan.operation
      && grant.planDigest === plan.planDigest
      && grant.authorizationId === authorization.authorizationId
      && authorization.operation === plan.operation
      && authorization.planDigest === plan.planDigest
  }
}

export interface FakeFailureController {
  checkpoint(point: string): void
  beforeRecovery(): void
}

class FailureController implements FakeFailureController {
  private failurePoint: string | null = null
  private recoveryDrift: { path: string; bytes: string } | null = null
  private readonly filesystem: FakeFilesystem

  constructor(filesystem: FakeFilesystem) {
    this.filesystem = filesystem
  }

  failAt(point: string): void {
    this.failurePoint = point
  }

  failRecoveryWithDrift(value: { path: string; bytes: string }): void {
    this.recoveryDrift = clone(value)
  }

  checkpoint(point: string): void {
    if (this.failurePoint !== point) return
    this.failurePoint = null
    throw new Error(`injected fake failure at ${point}`)
  }

  beforeRecovery(): void {
    if (this.recoveryDrift === null) return
    const drift = this.recoveryDrift
    this.recoveryDrift = null
    this.filesystem.writeBytes(drift.path, drift.bytes)
  }
}

/** Complete fake Omarchy environment plus the exact ports used by installation.ts. */
export class FakeOmarchy {
  readonly paths: {
    pluginsRoot: string
    pluginRoot: string
    receiptPath: string
    shellJson: string
    manifestPath: string
    asset: (relativePath: string) => string
  }
  readonly filesystem: FakeFilesystem
  readonly configuration: FakeConfiguration
  readonly shell: FakeShell
  readonly receipts: FakeReceipts
  readonly authorization: FakeAuthorization
  readonly host: FakeHost
  readonly digest: FakeDigest
  readonly clock: FakeClock
  private readonly faults: FailureController
  private readonly mutationRecords: CompanionMutationRecord[] = []
  private mutationSequence = 0
  private recoveryRecord: CompanionRecovery | null = null

  constructor(options: { compatibility?: CompanionCompatibility; owner?: string } = {}) {
    const owner = options.owner ?? DEFAULT_OWNER
    const home = '/fake/home/omarchestra-user'
    const pluginsRoot = `${home}/.config/omarchy/plugins`
    const pluginRoot = `${pluginsRoot}/${COMPANION_PLUGIN_ID}`
    const receiptPath = `${home}/.local/state/omarchestra/companion-installation.json`
    const shellJson = `${home}/.config/omarchy/shell.json`
    this.paths = {
      pluginsRoot,
      pluginRoot,
      receiptPath,
      shellJson,
      manifestPath: `${pluginRoot}/manifest.json`,
      asset: (relativePath: string) => POSIX.join(pluginRoot, relativePath),
    }
    this.filesystem = new FakeFilesystem(owner)
    this.filesystem.ensureDirectory(`${home}/.config/omarchy/plugins`, owner, DEFAULT_DIRECTORY_MODE)
    this.filesystem.ensureDirectory(`${home}/.local/state/omarchestra`, owner, DEFAULT_DIRECTORY_MODE)

    const foreignPluginRoot = `${pluginsRoot}/foreign.plugin`
    this.filesystem.ensureDirectory(foreignPluginRoot, owner, DEFAULT_DIRECTORY_MODE)
    this.filesystem.addFile(`${foreignPluginRoot}/manifest.json`, JSON.stringify({ id: 'foreign.plugin', version: '1.0.0' }))
    const initialShell = {
      enabledPlugins: ['foreign.plugin'],
      pluginSources: { 'foreign.plugin': foreignPluginRoot },
      unrelatedSetting: 'preserve-byte-for-byte',
    }
    this.configuration = new FakeConfiguration(pluginRoot, jsonBytes(initialShell))
    this.shell = new FakeShell(this.configuration)
    this.receipts = new FakeReceipts(this.filesystem, receiptPath)
    this.digest = new FakeDigest()
    this.authorization = new FakeAuthorization(this.digest)
    this.host = new FakeHost(options.compatibility ?? DEFAULT_COMPATIBILITY, owner)
    this.clock = new FakeClock()
    this.faults = new FailureController(this.filesystem)
  }

  ports(): CompanionInstallationPorts & { faults: FakeFailureController } {
    return {
      filesystem: this.filesystem,
      configuration: this.configuration,
      shell: this.shell,
      receipts: this.receipts,
      authorization: this.authorization,
      host: this.host,
      digest: this.digest,
      clock: this.clock,
      paths: {
        pluginsRoot: this.paths.pluginsRoot,
        pluginRoot: this.paths.pluginRoot,
        receiptPath: this.paths.receiptPath,
        asset: this.paths.asset,
      },
      mutations: { record: (mutation) => this.recordMutation(mutation) },
      recovery: { record: (recovery) => { this.recoveryRecord = clone(recovery) } },
      faults: this.faults,
    }
  }

  setCompatibility(value: CompanionCompatibility): void {
    this.host.setCompatibility(value)
  }

  failAt(point: string): void {
    this.faults.failAt(point)
  }

  failRecoveryWithDrift(value: { path: string; bytes: string }): void {
    this.faults.failRecoveryWithDrift(value)
  }

  clearMutationLog(): void {
    this.mutationRecords.length = 0
    this.mutationSequence = 0
  }

  mutationLog(): CompanionMutationRecord[] {
    return clone(this.mutationRecords)
  }

  lastRecovery(): CompanionRecovery {
    if (this.recoveryRecord === null) throw new Error('fake recovery has not been recorded')
    return clone(this.recoveryRecord)
  }

  fingerprint(): Record<string, unknown> {
    return {
      filesystem: this.filesystem.snapshot(),
      shellJsonBytes: this.configuration.shellJsonBytes(),
      compatibility: this.host.compatibility(),
    }
  }

  installationFingerprint(): Record<string, unknown> {
    return {
      pluginTree: this.filesystem.snapshot(this.paths.pluginRoot),
      receipt: this.filesystem.snapshot(this.paths.receiptPath),
      shellJsonBytes: this.configuration.shellJsonBytes(),
    }
  }

  unrelatedFingerprint(): Record<string, unknown> {
    const allNodes = this.filesystem.snapshot()
    const pluginPrefix = `${this.paths.pluginRoot}/`
    const receipt = this.paths.receiptPath
    return {
      filesystem: allNodes.filter((node) => {
        const inputPath = String(node.path)
        return inputPath !== this.paths.pluginRoot
          && !inputPath.startsWith(pluginPrefix)
          && inputPath !== receipt
      }),
      configuration: this.configuration.unrelatedDocument(COMPANION_PLUGIN_ID),
    }
  }

  seedUnrelatedResource(name: string, bytes: string): void {
    this.filesystem.addFile(`/fake/unrelated/${name}`, bytes)
  }

  seedForeignPlugin(value: { pluginId: string; assets: Record<string, string> }): void {
    this.filesystem.ensureDirectory(this.paths.pluginRoot, this.host.owner, DEFAULT_DIRECTORY_MODE)
    for (const [relativePath, bytes] of Object.entries(value.assets)) {
      this.filesystem.addFile(this.paths.asset(relativePath), bytes)
    }
  }

  installedPluginExists(): boolean {
    return this.filesystem.inspectNoFollow(this.paths.pluginRoot).kind !== 'missing'
  }

  receiptExists(): boolean {
    return this.receipts.exists()
  }

  receipt(): CompanionInstallationReceipt {
    const found = this.receipts.inspectNoFollow(COMPANION_PLUGIN_ID)
    if (found === null || found.identity.kind !== 'file') throw new Error('fake receipt is absent')
    return clone(JSON.parse(found.bytes) as CompanionInstallationReceipt)
  }

  installedRelease(): { version: string; pluginId: string } {
    const receipt = this.receipt()
    return { version: receipt.release.version, pluginId: receipt.pluginId }
  }

  installedAssetNames(): string[] {
    const root = this.filesystem.inspectNoFollow(this.paths.pluginRoot)
    if (root.kind !== 'directory') return []
    const names: string[] = []
    const visit = (directory: string): void => {
      for (const name of this.filesystem.listDirectoryNoFollow(directory)) {
        const child = POSIX.join(directory, name)
        const identity = this.filesystem.inspectNoFollow(child)
        if (identity.kind === 'file') names.push(POSIX.relative(this.paths.pluginRoot, child))
        else if (identity.kind === 'directory') visit(child)
      }
    }
    visit(this.paths.pluginRoot)
    return names.sort()
  }

  private recordMutation(mutation: Omit<CompanionMutationRecord, 'sequence'> | CompanionMutationRecord): void {
    this.mutationRecords.push({ ...mutation, sequence: ++this.mutationSequence })
  }
}

export const FAKE_DEFAULT_OWNER = DEFAULT_OWNER
export const FAKE_FOREIGN_OWNER = FOREIGN_OWNER
export const FAKE_RECEIPT_MODE = RECEIPT_MODE
export const FAKE_DEFAULT_COMPATIBILITY = Object.freeze(clone(DEFAULT_COMPATIBILITY))
export const FAKE_PLUGIN_VERSION = COMPANION_PLUGIN_VERSION
