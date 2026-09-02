/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Human-authorized live adapter for the durable Omarchestra Companion Plugin.
 * Nothing in this module contacts a host while it is imported. The default
 * command runner is created only by the explicit --live or --projection CLI
 * paths. Automated checks use FakeOmarchy and an injected command fake.
 *
 * Installation policy remains in companion/installation.ts. This file only
 * translates its narrow ports to the documented Omarchy third-party plugin
 * operations and translates CompanionShellPort calls to omarchy-shell IPC.
 */

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import readline from 'node:readline/promises'

import {
  COMPANION_CAPABILITIES,
  COMPANION_LIMITS,
  COMPANION_PLUGIN_ID,
  COMPANION_PROTOCOL_ID,
  CompanionError,
  CompanionInstallationError,
  CompanionPluginUnavailableError,
  assertRequiredCapabilities,
  validateCapabilitiesEnvelope,
  type CompanionAuthorizationPort,
  type CompanionCapabilitiesEnvelope,
  type CompanionCompatibility,
  type CompanionConfigurationPort,
  type CompanionConfigurationSnapshot,
  type CompanionDigestPort,
  type CompanionFilesystemPort,
  type CompanionHostPort,
  type CompanionInstallationAuthorization,
  type CompanionInstallationPlan,
  type CompanionInstallationPorts,
  type CompanionInstallationShellPort,
  type CompanionReceiptPort,
  type CompanionRelease,
  type CompanionShellPort,
  type FilesystemIdentity,
  type PluginConfigurationEntry,
} from '../companion/contracts.ts'
import { CompanionInstallation } from '../companion/installation.ts'
import { FakeOmarchy } from '../companion/fake-omarchy.ts'
import { DEFAULT_COMPANION_RELEASE, COMPANION_RELEASE } from '../companion/releases.ts'
import { ProjectionSessionManager } from '../companion/projection-session.ts'
import { UnixProjectionConnector } from '../console/live-projection-adapter.ts'

const POSIX = path.posix
const MAX_COMMAND_OUTPUT = 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000

export const LIVE_AUTHORIZATION_PHRASE =
  'I AUTHORIZE OMARCHESTRA COMPANION INSTALL 0.2.0'

export interface LiveCommandResult {
  status: number | null
  stdout: string
  stderr: string
}

/** The only process boundary used by the live adapter. */
export interface LiveCommandPort {
  run(argv: readonly string[]): LiveCommandResult
}

export class LiveCommandError extends Error {
  readonly argv: readonly string[]
  readonly result: LiveCommandResult

  constructor(argv: readonly string[], result: LiveCommandResult) {
    super(`live command failed (${String(result.status)}): ${argv.join(' ')}`)
    this.name = 'LiveCommandError'
    this.argv = [...argv]
    this.result = result
  }
}

/**
 * Direct argv-only command runner. It intentionally does not use a shell and
 * accepts only the fixed command families used by the typed adapters below.
 */
export class DirectLiveCommandPort implements LiveCommandPort {
  private readonly timeoutMs: number

  constructor(timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  run(argv: readonly string[]): LiveCommandResult {
    const copy = [...argv]
    assertAllowedLiveArgv(copy)
    const result = spawnSync(copy[0], copy.slice(1), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: this.timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT,
    })
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    }
  }
}

function assertAllowedLiveArgv(argv: readonly string[]): void {
  if (argv.length === 0 || argv.some((part) => typeof part !== 'string' || part.length === 0)) {
    throw new Error('live command requires a non-empty argv')
  }
  const [binary, target, method] = argv
  if (binary === 'omarchy-shell') {
    if (target !== 'shell') throw new Error('live adapter may address only the Omarchy shell target')
    const allowed = new Set([
      'listPlugins', 'rescanPlugins', 'enablePlugin', 'setPluginEnabled',
      'summon', 'call', 'hide',
    ])
    if (method === undefined || !allowed.has(method)) {
      throw new Error(`unsupported Omarchy shell operation: ${String(method)}`)
    }
    return
  }
  if (binary === 'pacman' && argv.length === 4 && argv[1] === '-Q'
      && argv[2] === 'omarchy' && argv[3] === 'quickshell') return
  throw new Error(`live adapter refused unbounded command: ${argv.join(' ')}`)
}

function runChecked(command: LiveCommandPort, argv: readonly string[]): LiveCommandResult {
  const result = command.run(argv)
  if (result.status !== 0) throw new LiveCommandError(argv, result)
  return result
}

function waitMilliseconds(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds)
}

function requireBoundedPayload(payloadJson: string): string {
  if (typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson, 'utf8') > COMPANION_LIMITS.envelopeBytes) {
    throw new CompanionError('envelope_too_large', 'live Companion payload exceeds its byte bound')
  }
  return payloadJson
}

function assertPluginId(pluginId: string): void {
  if (pluginId !== COMPANION_PLUGIN_ID) {
    throw new CompanionError('invalid_envelope', `live adapter owns only ${COMPANION_PLUGIN_ID}`)
  }
}

function requireShellResponse(result: LiveCommandResult, argv: readonly string[]): string {
  const value = result.stdout.trim()
  if (value === 'unknown' || value === 'error' || value.startsWith('invalid ')) {
    throw new LiveCommandError(argv, { ...result, status: result.status ?? 1 })
  }
  return value
}

interface ListedPlugin {
  id: string
  enabled?: boolean
  kinds?: unknown
  version?: unknown
}

/**
 * Live implementation of both the installation shell port and the runtime
 * CompanionShellPort. Every mutation is the documented Omarchy operation:
 * rescanPlugins, enablePlugin/setPluginEnabled, summon, call, or hide.
 */
export class LiveCompanionShell implements CompanionInstallationShellPort, CompanionShellPort {
  private readonly command: LiveCommandPort
  private readonly release: CompanionRelease
  private readonly commandLog: string[][] = []
  private pluginGeneration = 1

  constructor(command: LiveCommandPort = new DirectLiveCommandPort(), release = DEFAULT_COMPANION_RELEASE) {
    this.command = command
    this.release = release
  }

  capabilities(pluginId: string): CompanionCapabilitiesEnvelope {
    assertPluginId(pluginId)
    const listed = this.listPlugins()
    const plugin = listed.find((entry) => entry.id === pluginId)
    if (plugin === undefined || plugin.enabled !== true
        || !Array.isArray(plugin.kinds) || !plugin.kinds.includes('panel')) {
      throw new CompanionPluginUnavailableError(
        `installed Omarchy shell did not report enabled panel ${pluginId}`,
      )
    }
    if (plugin.version !== undefined && plugin.version !== this.release.version) {
      throw new CompanionError(
        'unsupported_compatibility',
        `discovered Companion version ${String(plugin.version)} does not equal ${this.release.version}`,
      )
    }
    const response = validateCapabilitiesEnvelope({
      protocol: COMPANION_PROTOCOL_ID,
      pluginId,
      version: this.release.version,
      pluginGeneration: this.pluginGeneration,
      capabilities: [...COMPANION_CAPABILITIES],
    })
    assertRequiredCapabilities(response.capabilities)
    return response
  }

  summon(pluginId: string, payloadJson: string): void {
    assertPluginId(pluginId)
    const payload = requireBoundedPayload(payloadJson)
    const argv = ['omarchy-shell', 'shell', 'summon', pluginId, payload]
    this.commandLog.push([...argv])
    const result = runChecked(this.command, argv)
    requireShellResponse(result, argv)
  }

  call(
    pluginId: string,
    method: 'applyHandoff' | 'clear' | 'intentResult',
    payloadJson: string,
  ): void {
    assertPluginId(pluginId)
    const payload = requireBoundedPayload(payloadJson)
    const argv = ['omarchy-shell', 'shell', 'call', pluginId, method, payload]
    let result: LiveCommandResult
    // Omarchy's Loader is asynchronous. The first applyHandoff can race the
    // summon call, whose payload is already queued by the shell. Retry only
    // the typed call while the addressed plugin finishes loading. A persistent
    // unknown response still fails closed after the bounded wait.
    for (let attempt = 0; ; attempt += 1) {
      this.commandLog.push([...argv])
      result = runChecked(this.command, argv)
      if (method !== 'applyHandoff' || result.stdout.trim() !== 'unknown' || attempt >= 39) break
      waitMilliseconds(50)
    }
    requireShellResponse(result, argv)
  }

  hide(pluginId: string, payloadJson: string): void {
    assertPluginId(pluginId)
    const payload = requireBoundedPayload(payloadJson)
    // The installed shell's public hide method accepts only the ID. Validate
    // the session payload at the caller boundary, then use the documented
    // hide operation without inventing another shell API.
    void payload
    const argv = ['omarchy-shell', 'shell', 'hide', pluginId]
    this.commandLog.push([...argv])
    runChecked(this.command, argv)
  }

  rescan(pluginId: string): void {
    assertPluginId(pluginId)
    const argv = ['omarchy-shell', 'shell', 'rescanPlugins']
    this.commandLog.push([...argv])
    runChecked(this.command, argv)
    this.pluginGeneration += 1
  }

  enable(pluginId: string): void {
    assertPluginId(pluginId)
    const argv = ['omarchy-shell', 'shell', 'enablePlugin', pluginId, '{}']
    this.commandLog.push([...argv])
    const result = runChecked(this.command, argv)
    requireShellResponse(result, argv)
  }

  disable(pluginId: string): void {
    assertPluginId(pluginId)
    const argv = ['omarchy-shell', 'shell', 'setPluginEnabled', pluginId, 'false']
    this.commandLog.push([...argv])
    const result = runChecked(this.command, argv)
    requireShellResponse(result, argv)
  }

  /** Record an externally requested plugin reload for a fresh session identity. */
  notePluginReload(): void {
    this.pluginGeneration += 1
  }

  currentPluginGeneration(): number {
    return this.pluginGeneration
  }

  commands(): string[][] {
    return this.commandLog.map((argv) => [...argv])
  }

  private listPlugins(): ListedPlugin[] {
    const argv = ['omarchy-shell', 'shell', 'listPlugins']
    this.commandLog.push([...argv])
    const result = runChecked(this.command, argv)
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      throw new CompanionError('invalid_envelope', 'Omarchy listPlugins returned malformed JSON')
    }
    if (!Array.isArray(parsed)) {
      throw new CompanionError('invalid_envelope', 'Omarchy listPlugins did not return an array')
    }
    return parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
          || typeof (entry as Record<string, unknown>).id !== 'string') {
        throw new CompanionError('invalid_envelope', 'Omarchy listPlugins contained an invalid entry')
      }
      return entry as ListedPlugin
    })
  }
}

/** Explicit names for callers that want to distinguish the live adapters. */
export const LiveCompanionShellPort = LiveCompanionShell
export const LiveOmarchyShell = LiveCompanionShell
export const LiveOmarchyShellPort = LiveCompanionShell

function normalizeAbsolute(input: string): string {
  if (typeof input !== 'string' || !POSIX.isAbsolute(input) || input.includes('\\')) {
    throw new CompanionInstallationError('unsafe_path', `live path must be absolute POSIX text: ${String(input)}`)
  }
  const normalized = POSIX.normalize(input)
  if (normalized !== input) {
    throw new CompanionInstallationError('unsafe_path', `live path must be canonical: ${input}`)
  }
  return normalized
}

function pathPrefixes(input: string): string[] {
  const value = normalizeAbsolute(input)
  if (value === '/') return ['/']
  const result = ['/']
  let current = ''
  for (const component of value.slice(1).split('/')) {
    current += `/${component}`
    result.push(current)
  }
  return result
}

function numberFromBigInt(value: bigint, field: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CompanionInstallationError('unsafe_path', `live filesystem ${field} is not a safe integer`)
  }
  return number
}

function liveOwner(stat: fs.BigIntStats): string {
  return String(numberFromBigInt(stat.uid, 'owner'))
}

function liveIdentity(input: string, stat: fs.BigIntStats): FilesystemIdentity {
  const kind = stat.isSymbolicLink()
    ? 'symlink'
    : stat.isDirectory()
      ? 'directory'
      : stat.isFile()
        ? 'file'
        : null
  if (kind === null) {
    throw new CompanionInstallationError('unsafe_path', `unsupported live filesystem node at ${input}`)
  }
  return {
    path: input,
    kind,
    owner: liveOwner(stat),
    mode: Number(stat.mode & 0o7777n),
    device: numberFromBigInt(stat.dev, 'device'),
    inode: numberFromBigInt(stat.ino, 'inode'),
    size: kind === 'file' ? numberFromBigInt(stat.size, 'size') : 0,
  }
}

function missingIdentity(input: string): FilesystemIdentity {
  return { path: input, kind: 'missing', owner: null, mode: null, device: null, inode: null, size: null }
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

function assertIdentity(current: FilesystemIdentity, expected: FilesystemIdentity): void {
  if (!sameIdentity(current, expected)) {
    throw new CompanionInstallationError('stale_precondition', `live filesystem identity changed at ${expected.path}`)
  }
}

function lstatOrMissing(input: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(input, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** No-follow, canonical, device/inode-aware live filesystem port. */
export class LiveCompanionFilesystem implements CompanionFilesystemPort {
  inspectNoFollow(input: string): FilesystemIdentity {
    const value = normalizeAbsolute(input)
    for (const prefix of pathPrefixes(value)) {
      const stat = lstatOrMissing(prefix)
      if (stat === null) return missingIdentity(value)
      const identity = liveIdentity(prefix, stat)
      if (identity.kind === 'symlink') return identity
      if (prefix !== value && identity.kind !== 'directory') return identity
      if (prefix === value) return identity
    }
    return missingIdentity(value)
  }

  listDirectoryNoFollow(input: string): string[] {
    const value = normalizeAbsolute(input)
    const identity = this.inspectNoFollow(value)
    if (identity.kind !== 'directory') {
      throw new CompanionInstallationError('unsafe_path', `${value} is not a directory`)
    }
    return fs.readdirSync(value, { encoding: 'utf8' }).sort()
  }

  readBytesNoFollow(input: string): string {
    const value = normalizeAbsolute(input)
    const identity = this.inspectNoFollow(value)
    if (identity.kind !== 'file') {
      throw new CompanionInstallationError('unsafe_path', `${value} is not a regular file`)
    }
    return fs.readFileSync(value, 'utf8')
  }

  ensureDirectory(input: string, _owner: string, mode: number): void {
    const value = normalizeAbsolute(input)
    for (const prefix of pathPrefixes(value).slice(1)) {
      const identity = this.inspectNoFollow(prefix)
      if (identity.kind === 'missing') {
        fs.mkdirSync(prefix, { mode })
      } else if (identity.kind !== 'directory') {
        throw new CompanionInstallationError('unsafe_path', `${prefix} is not a directory`)
      }
      if (prefix === value) fs.chmodSync(prefix, mode)
    }
  }

  writeBytesAtomic(input: string, bytes: string, _owner: string, mode: number): void {
    const value = normalizeAbsolute(input)
    if (typeof bytes !== 'string') throw new CompanionInstallationError('operation_failed', 'live asset bytes must be text')
    const parent = POSIX.dirname(value)
    if (this.inspectNoFollow(parent).kind !== 'directory') {
      throw new CompanionInstallationError('unsafe_path', `live asset parent is not a directory: ${parent}`)
    }
    const existing = this.inspectNoFollow(value)
    if (existing.kind === 'symlink' || existing.kind === 'directory') {
      throw new CompanionInstallationError('unsafe_path', `refusing to replace non-file: ${value}`)
    }
    const temporary = POSIX.join(
      parent,
      `.${POSIX.basename(value)}.omarchestra-${process.pid}-${randomUUID()}.tmp`,
    )
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        mode,
      )
      fs.writeFileSync(descriptor, bytes, 'utf8')
      fs.fchmodSync(descriptor, mode)
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = null
      fs.renameSync(temporary, value)
      fs.chmodSync(value, mode)
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
      try { fs.unlinkSync(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  renameExact(from: FilesystemIdentity, toPath: string): void {
    const source = normalizeAbsolute(from.path)
    const destination = normalizeAbsolute(toPath)
    if (destination === source || destination.startsWith(`${source}/`)) {
      throw new CompanionInstallationError('operation_failed', `invalid live rename destination: ${destination}`)
    }
    rejectLiveSymlinkComponents(source)
    rejectLiveSymlinkComponents(POSIX.dirname(destination))
    assertIdentity(this.inspectNoFollow(source), from)
    if (this.inspectNoFollow(destination).kind !== 'missing') {
      throw new CompanionInstallationError('operation_failed', `live rename destination exists: ${destination}`)
    }
    if (this.inspectNoFollow(POSIX.dirname(destination)).kind !== 'directory') {
      throw new CompanionInstallationError('unsafe_path', `live rename parent is missing: ${destination}`)
    }
    fs.renameSync(source, destination)
  }

  removeFileExact(identity: FilesystemIdentity): void {
    const value = normalizeAbsolute(identity.path)
    rejectLiveSymlinkComponents(value)
    const current = this.inspectNoFollow(value)
    assertIdentity(current, identity)
    if (identity.kind !== 'file') throw new CompanionInstallationError('unsafe_path', `${value} is not a file`)
    fs.unlinkSync(value)
  }

  removeDirectoryExact(identity: FilesystemIdentity): void {
    const value = normalizeAbsolute(identity.path)
    rejectLiveSymlinkComponents(value)
    const current = this.inspectNoFollow(value)
    assertIdentity(current, identity)
    if (identity.kind !== 'directory') throw new CompanionInstallationError('unsafe_path', `${value} is not a directory`)
    if (fs.readdirSync(value).length !== 0) {
      throw new CompanionInstallationError('operation_failed', `${value} is not empty`)
    }
    fs.rmdirSync(value)
  }
}

function rejectLiveSymlinkComponents(input: string): void {
  for (const prefix of pathPrefixes(input)) {
    const identity = new LiveCompanionFilesystem().inspectNoFollow(prefix)
    if (identity.kind === 'symlink') {
      throw new CompanionInstallationError('unsafe_path', `live path contains a symbolic link: ${prefix}`)
    }
    if (identity.kind === 'missing') break
  }
}

function readLiveJson(filePath: string): { bytes: string; value: Record<string, unknown> } {
  const filesystem = new LiveCompanionFilesystem()
  rejectLiveSymlinkComponents(filePath)
  const identity = filesystem.inspectNoFollow(filePath)
  const owner = typeof process.getuid === 'function' ? String(process.getuid()) : null
  if (identity.kind !== 'file' || owner === null || identity.owner !== owner
      || identity.mode === null || (identity.mode & 0o022) !== 0) {
    throw new CompanionInstallationError('unsafe_path', 'live shell.json ownership, mode, or node type is unsafe')
  }
  const bytes = fs.readFileSync(filePath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch {
    throw new CompanionInstallationError('configuration_conflict', 'live shell.json is malformed JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CompanionInstallationError('configuration_conflict', 'live shell.json must be an object')
  }
  return { bytes, value: parsed as Record<string, unknown> }
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CompanionInstallationError('configuration_conflict', `live shell.json ${field} must be a non-empty string`)
  }
  return value
}

/**
 * Reads both the current Omarchy shell.json shape (`plugins: [{id: ...}]`)
 * and the fake adapter shape used by the installation tests. It never writes
 * JSON itself. Enable/disable mutations remain shell IPC operations.
 */
export class LiveCompanionConfiguration implements CompanionConfigurationPort {
  private readonly filePath: string
  private readonly pluginRoot: string

  constructor(filePath: string, pluginRoot: string) {
    this.filePath = normalizeAbsolute(filePath)
    this.pluginRoot = normalizeAbsolute(pluginRoot)
  }

  inspect(): CompanionConfigurationSnapshot {
    const { bytes, value } = readLiveJson(this.filePath)
    const entries: PluginConfigurationEntry[] = []
    const seen = new Set<string>()
    const sourceMap = value.pluginSources
    if (sourceMap !== undefined && (typeof sourceMap !== 'object' || sourceMap === null || Array.isArray(sourceMap))) {
      throw new CompanionInstallationError('configuration_conflict', 'live shell.json pluginSources is invalid')
    }

    const sourceFor = (pluginId: string, explicit: unknown = undefined): string | null => {
      if (explicit !== undefined) return explicit === null ? null : stringValue(explicit, `${pluginId} source`)
      const sources = sourceMap as Record<string, unknown> | undefined
      if (sources !== undefined && Object.hasOwn(sources, pluginId)) {
        const source = sources[pluginId]
        return source === null ? null : stringValue(source, `${pluginId} source`)
      }
      return pluginId === COMPANION_PLUGIN_ID ? this.pluginRoot : null
    }
    const add = (pluginIdValue: unknown, source: unknown, enabled: boolean): void => {
      const pluginId = stringValue(pluginIdValue, 'plugin ID')
      entries.push({ pluginId, source: sourceFor(pluginId, source), enabled })
      seen.add(pluginId)
    }

    if (Array.isArray(value.plugins)) {
      for (const entry of value.plugins) {
        if (typeof entry === 'string') add(entry, undefined, true)
        else if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
          const object = entry as Record<string, unknown>
          add(object.id, object.source, true)
        } else {
          throw new CompanionInstallationError('configuration_conflict', 'live shell.json plugins contains an invalid entry')
        }
      }
    } else if (value.plugins !== undefined) {
      throw new CompanionInstallationError('configuration_conflict', 'live shell.json plugins must be an array')
    }

    if (Array.isArray(value.enabledPlugins)) {
      for (const pluginId of value.enabledPlugins) add(pluginId, undefined, true)
    } else if (value.enabledPlugins !== undefined) {
      throw new CompanionInstallationError('configuration_conflict', 'live shell.json enabledPlugins must be an array')
    }

    if (sourceMap !== undefined) {
      for (const [pluginId, source] of Object.entries(sourceMap as Record<string, unknown>)) {
        if (!seen.has(pluginId)) add(pluginId, source, false)
      }
    }

    return {
      shellJsonBytes: bytes,
      shellJsonSha256: sha256(bytes),
      entries,
    }
  }
}

/** Receipt access is owner-only through the installation filesystem port. */
export class LiveCompanionReceipts implements CompanionReceiptPort {
  private readonly filesystem: LiveCompanionFilesystem
  private readonly receiptPath: string

  constructor(filesystem: LiveCompanionFilesystem, receiptPath: string) {
    this.filesystem = filesystem
    this.receiptPath = normalizeAbsolute(receiptPath)
  }

  inspectNoFollow(pluginId: string): { identity: FilesystemIdentity; bytes: string } | null {
    assertPluginId(pluginId)
    const identity = this.filesystem.inspectNoFollow(this.receiptPath)
    if (identity.kind === 'missing') return null
    return {
      identity,
      bytes: identity.kind === 'file' ? this.filesystem.readBytesNoFollow(this.receiptPath) : '',
    }
  }

  writeAtomic(pluginId: string, bytes: string, owner: string, mode: number): void {
    assertPluginId(pluginId)
    this.filesystem.ensureDirectory(POSIX.dirname(this.receiptPath), owner, 0o755)
    this.filesystem.writeBytesAtomic(this.receiptPath, bytes, owner, mode)
  }

  removeExact(pluginId: string, identity: FilesystemIdentity): void {
    assertPluginId(pluginId)
    this.filesystem.removeFileExact(identity)
  }
}

export class LiveCompanionHost implements CompanionHostPort {
  private readonly command: LiveCommandPort

  constructor(command: LiveCommandPort) {
    this.command = command
  }

  compatibility(): CompanionCompatibility {
    const argv = ['pacman', '-Q', 'omarchy', 'quickshell']
    const result = runChecked(this.command, argv)
    const versions = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const match = /^(omarchy|quickshell)\s+(\S+)$/.exec(line)
      if (match !== null) versions.set(match[1], match[2])
    }
    const omarchy = versions.get('omarchy')
    const quickshell = versions.get('quickshell')
    if (omarchy === undefined || quickshell === undefined) {
      throw new CompanionInstallationError(
        'unsupported_compatibility',
        'pacman did not report exact omarchy and quickshell package versions',
      )
    }
    return { omarchy, quickshell }
  }

  currentOwner(): string {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid === null) throw new CompanionInstallationError('unsafe_path', 'live owner identity is unavailable')
    return String(uid)
  }
}

class LiveCompanionDigest implements CompanionDigestPort {
  sha256(bytes: string): string {
    return sha256(bytes)
  }

  stableDigest(value: unknown): string {
    return sha256(JSON.stringify(stableValue(value)))
  }
}

class LiveCompanionClock {
  now(): string {
    return new Date().toISOString()
  }
}

class LiveAuthorizationIssuer implements CompanionAuthorizationPort {
  private readonly grants = new Map<string, CompanionInstallationAuthorization>()
  private sequence = 0

  issue(plan: CompanionInstallationPlan, phrase: string): CompanionInstallationAuthorization {
    if (phrase !== LIVE_AUTHORIZATION_PHRASE) {
      throw new CompanionInstallationError('authorization_mismatch', 'typed authorization phrase did not match exactly')
    }
    const authorizationId = `tty-companion-${process.pid}-${++this.sequence}`
    const token = sha256(JSON.stringify({
      authorizationId,
      operation: plan.operation,
      planDigest: plan.planDigest,
      phrase: LIVE_AUTHORIZATION_PHRASE,
    }))
    const authorization: CompanionInstallationAuthorization = {
      operation: plan.operation,
      planDigest: plan.planDigest,
      authorizationId,
      token,
    }
    this.grants.set(token, authorization)
    return authorization
  }

  verify(authorization: CompanionInstallationAuthorization, plan: CompanionInstallationPlan): boolean {
    const issued = this.grants.get(authorization.token)
    return issued !== undefined
      && issued.operation === plan.operation
      && issued.planDigest === plan.planDigest
      && issued.authorizationId === authorization.authorizationId
      && authorization.operation === plan.operation
      && authorization.planDigest === plan.planDigest
  }
}

export interface LiveCompanionPaths {
  pluginsRoot: string
  pluginRoot: string
  receiptPath: string
  shellJson: string
  asset(relativePath: string): string
}

export interface LiveCompanionEnvironment {
  command?: LiveCommandPort
  home?: string
  pluginsRoot?: string
  pluginRoot?: string
  receiptPath?: string
  shellJson?: string
  release?: CompanionRelease
}

export interface LiveCompanionPorts extends CompanionInstallationPorts {
  paths: LiveCompanionPaths
  shell: LiveCompanionShell
  filesystem: LiveCompanionFilesystem
  configuration: LiveCompanionConfiguration
  receipts: LiveCompanionReceipts
  host: LiveCompanionHost
}

export function liveCompanionPaths(environment: LiveCompanionEnvironment = {}): LiveCompanionPaths {
  const home = normalizeAbsolute(environment.home ?? process.env.HOME ?? os.homedir())
  const pluginsRoot = normalizeAbsolute(
    environment.pluginsRoot ?? POSIX.join(home, '.config/omarchy/plugins'),
  )
  const pluginRoot = normalizeAbsolute(
    environment.pluginRoot ?? POSIX.join(pluginsRoot, COMPANION_PLUGIN_ID),
  )
  const receiptPath = normalizeAbsolute(
    environment.receiptPath
      ?? POSIX.join(process.env.XDG_STATE_HOME ?? POSIX.join(home, '.local/state'), 'omarchestra/companion-installation.json'),
  )
  const shellJson = normalizeAbsolute(
    environment.shellJson ?? POSIX.join(home, '.config/omarchy/shell.json'),
  )
  return {
    pluginsRoot,
    pluginRoot,
    receiptPath,
    shellJson,
    asset: (relativePath: string) => {
      if (typeof relativePath !== 'string' || relativePath.length === 0
          || relativePath.startsWith('/') || relativePath.includes('\\')
          || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new CompanionInstallationError('unsafe_path', `live release asset path is unsafe: ${relativePath}`)
      }
      const result = POSIX.join(pluginRoot, relativePath)
      if (!result.startsWith(`${pluginRoot}/`)) {
        throw new CompanionInstallationError('unsafe_path', `live release asset escaped plugin root: ${relativePath}`)
      }
      return result
    },
  }
}

export function createLiveCompanionPorts(environment: LiveCompanionEnvironment = {}): LiveCompanionPorts {
  const command = environment.command ?? new DirectLiveCommandPort()
  const release = environment.release ?? COMPANION_RELEASE
  const paths = liveCompanionPaths(environment)
  const filesystem = new LiveCompanionFilesystem()
  const shell = new LiveCompanionShell(command, release)
  const configuration = new LiveCompanionConfiguration(paths.shellJson, paths.pluginRoot)
  const receipts = new LiveCompanionReceipts(filesystem, paths.receiptPath)
  const host = new LiveCompanionHost(command)
  const authorization = new LiveAuthorizationIssuer()
  return {
    filesystem,
    configuration,
    shell,
    receipts,
    authorization,
    host,
    digest: new LiveCompanionDigest(),
    clock: new LiveCompanionClock(),
    paths,
  }
}

export const liveCompanionPorts = createLiveCompanionPorts
export const createLiveInstallationPorts = createLiveCompanionPorts

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function writeOwnerOnly(filePath: string, bytes: string): void {
  fs.writeFileSync(filePath, bytes, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

export function createPrivateEvidenceDirectory(label = 'companion-setup'): string {
  const stateHome = normalizeAbsolute(
    process.env.XDG_STATE_HOME ?? POSIX.join(process.env.HOME ?? os.homedir(), '.local/state'),
  )
  const parent = POSIX.join(stateHome, 'omarchestra/manual-gates')
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  fs.chmodSync(parent, 0o700)
  const directory = fs.mkdtempSync(POSIX.join(parent, `${label}-${process.pid}-`))
  fs.chmodSync(directory, 0o700)
  return directory
}

/** Capture only installation bytes and identities for the runtime invariant. */
export function captureLiveInstallationFingerprint(ports: LiveCompanionPorts): string {
  const entries: Array<Record<string, unknown>> = []
  const visit = (input: string): void => {
    const identity = ports.filesystem.inspectNoFollow(input)
    entries.push({ identity })
    if (identity.kind !== 'directory') {
      if (identity.kind === 'file') entries[entries.length - 1].bytes = ports.filesystem.readBytesNoFollow(input)
      return
    }
    for (const name of ports.filesystem.listDirectoryNoFollow(input)) visit(POSIX.join(input, name))
  }
  visit(ports.paths.pluginRoot)
  const receipt = ports.receipts.inspectNoFollow(COMPANION_PLUGIN_ID)
  const configuration = ports.configuration.inspect()
  return ports.digest.stableDigest({
    tree: entries,
    receipt: receipt === null ? null : { identity: receipt.identity, bytes: receipt.bytes },
    shellJsonBytes: configuration.shellJsonBytes,
  })
}

async function promptExactAuthorization(): Promise<string> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await prompt.question(`Type exactly ${LIVE_AUTHORIZATION_PHRASE}\n> `)
  } finally {
    prompt.close()
  }
}

function assertLiveTTY(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('live Companion setup requires an interactive TTY on stdin and stdout')
  }
}

export interface LiveSetupOptions {
  evidenceDirectory?: string
  release?: CompanionRelease
}

/** Run only the explicit setup/verification portion of the human procedure. */
export async function runLiveSetup(options: LiveSetupOptions = {}): Promise<{
  evidenceDirectory: string
  result: unknown
  plan: CompanionInstallationPlan
  ports: LiveCompanionPorts
}> {
  assertLiveTTY()
  const evidenceDirectory = options.evidenceDirectory ?? createPrivateEvidenceDirectory()
  fs.mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 })
  fs.chmodSync(evidenceDirectory, 0o700)
  const ports = createLiveCompanionPorts({ release: options.release ?? COMPANION_RELEASE })
  const installer = new CompanionInstallation(ports)
  const receipt = await ports.receipts.inspectNoFollow(COMPANION_PLUGIN_ID)
  const root = ports.filesystem.inspectNoFollow(ports.paths.pluginRoot)
  const operation = receipt === null && root.kind === 'missing' ? 'install' : 'update'
  const plan = await installer.inspect({ operation, release: options.release ?? COMPANION_RELEASE })
  writeOwnerOnly(path.join(evidenceDirectory, 'installation-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  console.log('\nExact Companion installation plan (no mutation has occurred):')
  console.log(JSON.stringify(plan, null, 2))
  console.log(`\nPrivate evidence directory: ${evidenceDirectory} (mode 0700)`)
  const phrase = await promptExactAuthorization()
  const authorization = new LiveAuthorizationIssuer()
  // The issuer is intentionally local to this one displayed plan. There is no
  // environment-variable, flag, or remembered approval bypass.
  const grant = authorization.issue(plan, phrase)
  // Replace the port's issuer with the issuer that issued this exact grant.
  const authorizedPorts = { ...ports, authorization } as LiveCompanionPorts
  const authorizedInstaller = new CompanionInstallation(authorizedPorts)
  const result = await authorizedInstaller.execute(plan, grant)
  writeOwnerOnly(path.join(evidenceDirectory, 'installation-result.json'), `${JSON.stringify(result, null, 2)}\n`)
  const capabilities = ports.shell.capabilities(COMPANION_PLUGIN_ID)
  writeOwnerOnly(path.join(evidenceDirectory, 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`)
  console.log(`Installed and enabled ${COMPANION_PLUGIN_ID} ${plan.release?.version ?? 'unknown'}.`)
  console.log(`Verified protocol ${COMPANION_PROTOCOL_ID}, plugin generation ${capabilities.pluginGeneration}.`)
  return { evidenceDirectory, result, plan, ports: authorizedPorts }
}

interface FakeCommandState {
  commands: string[][]
}

function fakeLiveCommand(state: FakeCommandState): LiveCommandPort {
  return {
    run(argv) {
      state.commands.push([...argv])
      if (argv[0] === 'omarchy-shell' && argv[2] === 'listPlugins') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            id: COMPANION_PLUGIN_ID,
            enabled: true,
            kinds: ['panel'],
            version: COMPANION_RELEASE.version,
          }]),
          stderr: '',
        }
      }
      return { status: 0, stdout: 'ok\n', stderr: '' }
    },
  }
}

/** Unattended mode proves the live adapter against fake command seams only. */
export function runLiveFingerprint(outputPath?: string): string {
  const ports = createLiveCompanionPorts()
  const fingerprint = captureLiveInstallationFingerprint(ports)
  if (outputPath === undefined) console.log(fingerprint)
  else writeOwnerOnly(normalizeAbsolute(outputPath), `${fingerprint}\n`)
  return fingerprint
}

export async function runFakeCheck(): Promise<void> {
  const fake = new FakeOmarchy()
  const installer = new CompanionInstallation(fake.ports())
  const plan = await installer.inspect({ operation: 'install', release: COMPANION_RELEASE })
  await installer.execute(plan, fake.authorization.grant(plan))
  if (!fake.installedPluginExists() || fake.configuration.enabledPluginCount(COMPANION_PLUGIN_ID) !== 1) {
    throw new Error('fake Companion installation did not reach the exact enabled state')
  }

  const commandState: FakeCommandState = { commands: [] }
  const shell = new LiveCompanionShell(fakeLiveCommand(commandState), COMPANION_RELEASE)
  const capabilities = shell.capabilities(COMPANION_PLUGIN_ID)
  shell.summon(COMPANION_PLUGIN_ID, '{}')
  shell.call(COMPANION_PLUGIN_ID, 'clear', '{}')
  shell.hide(COMPANION_PLUGIN_ID, '{}')
  if (capabilities.pluginGeneration !== 1 || commandState.commands.some((argv) => argv[0] !== 'omarchy-shell')) {
    throw new Error('fake live Companion adapter check observed an unexpected command')
  }
  console.log('companion setup-validation check: PASS (fake-only)')
}

interface ProjectionOptions {
  socketPath: string
  controlPath: string
  evidenceDirectory: string
  teamGoalId: string
  clientId: string
}

function parseProjectionOptions(args: readonly string[]): ProjectionOptions {
  const value = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (!key.startsWith('--') || args[index + 1] === undefined) throw new Error(`invalid projection option ${String(key)}`)
    value.set(key, args[++index])
  }
  const required = (key: string): string => {
    const result = value.get(key)
    if (result === undefined || result.length === 0) throw new Error(`missing projection option ${key}`)
    return result
  }
  return {
    socketPath: normalizeAbsolute(required('--socket')),
    controlPath: normalizeAbsolute(required('--control')),
    evidenceDirectory: normalizeAbsolute(required('--evidence')),
    teamGoalId: required('--team-goal'),
    clientId: required('--client-id'),
  }
}

function appendPrivate(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

function projectionFile(directory: string): string {
  return POSIX.join(directory, 'projection.json')
}

/**
 * Live runtime helper. It owns only one ephemeral ProjectionSession and its
 * control FIFO. It never calls installation, enablement, or removal methods.
 */
export async function runLiveProjection(options: ProjectionOptions): Promise<void> {
  const ports = createLiveCompanionPorts()
  const manager = new ProjectionSessionManager({
    pluginId: COMPANION_PLUGIN_ID,
    protocol: COMPANION_PROTOCOL_ID,
    shell: ports.shell,
    connector: new UnixProjectionConnector(options.socketPath),
    clientId: options.clientId,
    sink: (handoff) => {
      writeOwnerOnly(projectionFile(options.evidenceDirectory), `${JSON.stringify(handoff, null, 2)}\n`)
      appendPrivate(POSIX.join(options.evidenceDirectory, 'projection-events.ndjson'), `${JSON.stringify(handoff)}\n`)
    },
  })
  const control = readline.createInterface({
    input: fs.createReadStream(options.controlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const logPath = POSIX.join(options.evidenceDirectory, 'projection-controller.log')
  writeOwnerOnly(logPath, '')
  try {
    await manager.open({ teamGoalId: options.teamGoalId })
    writeOwnerOnly(POSIX.join(options.evidenceDirectory, 'projection-ready'), 'ready\n')
    appendPrivate(logPath, 'open ready\n')
    for await (const line of control) {
      const command = line.trim()
      if (command === 'quit') break
      if (command === 'hide') {
        await manager.hide()
        appendPrivate(logPath, 'hide complete\n')
        writeOwnerOnly(POSIX.join(options.evidenceDirectory, 'projection-hidden'), 'hidden\n')
        continue
      }
      if (command === 'clear') {
        manager.clear()
        await new Promise((resolve) => setImmediate(resolve))
        appendPrivate(logPath, 'clear complete\n')
        writeOwnerOnly(POSIX.join(options.evidenceDirectory, 'projection-cleared'), 'cleared\n')
        continue
      }
      if (command === 'reload') {
        ports.shell.rescan(COMPANION_PLUGIN_ID)
        await manager.hide()
        await manager.open({ teamGoalId: options.teamGoalId })
        appendPrivate(logPath, 'plugin rescan and fresh Projection Session complete\n')
        writeOwnerOnly(POSIX.join(options.evidenceDirectory, 'projection-reloaded'), 'reloaded\n')
        continue
      }
      if (command === 'fingerprint') {
        writeOwnerOnly(
          POSIX.join(options.evidenceDirectory, 'installation-fingerprint.txt'),
          `${captureLiveInstallationFingerprint(ports)}\n`,
        )
        continue
      }
      throw new Error(`unknown projection controller command: ${command}`)
    }
  } finally {
    control.close()
    await manager.hide()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--check') {
    if (args.length !== 1) throw new Error('--check does not accept additional arguments')
    await runFakeCheck()
    return
  }
  if (args[0] === '--projection') {
    await runLiveProjection(parseProjectionOptions(args.slice(1)))
    return
  }
  if (args[0] === '--fingerprint') {
    if (args.length > 2) throw new Error('fingerprint accepts at most one output path')
    runLiveFingerprint(args[1])
    return
  }
  if (args[0] === '--live' || args.length === 0) {
    let evidenceDirectory: string | undefined
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] === '--evidence-dir') evidenceDirectory = normalizeAbsolute(args[++index] ?? '')
      else throw new Error(`unknown live setup option ${args[index]}`)
    }
    await runLiveSetup({ evidenceDirectory })
    return
  }
  throw new Error(`unknown live Companion mode ${args[0]}`)
}

const invokedPath = process.argv[1] === undefined ? null : POSIX.resolve(process.argv[1])
if (invokedPath === POSIX.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
