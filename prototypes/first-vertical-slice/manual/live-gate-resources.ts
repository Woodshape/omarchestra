/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-gate-resources.ts — the exact-identity cleanup registry for the live
 * Agent Console gate (failure-cleanup seam, S4). It records the exact
 * resource identities a gate run created — PIDs, window classes/addresses,
 * Unix socket files, and scratch directories — and removes exactly those
 * identities during cleanup. Unrelated resources are never touched; names,
 * prefixes, wildcards, focus, or global operations never authorize
 * destruction, and every process identity is re-verified at cleanup time so
 * a recycled PID can never be destroyed by a stale record.
 *
 * Process and window controls are always injected. This module has no
 * default kill authority and never spawns, signals, or observes a real
 * process, and never contacts a desktop. A future human-authorized live gate
 * (blocked today; see docs/live-agent-console-launch-blocker.md) would
 * supply real controls explicitly.
 *
 * No process is ever spawned, signalled, or observed by this module itself;
 * the only real filesystem work is the bounded removal of exactly registered
 * socket files and directories.
 */

import fs from 'node:fs'
import path from 'node:path'

export type GateSignal = 'SIGTERM' | 'SIGKILL'
export type GateResourceKind = 'pid' | 'window' | 'socket' | 'directory'

/** Injected exact process control. Automation supplies a recording fake. */
export interface GateProcessControl {
  /**
   * Opaque exact identity of the PID, or null when it has exited. A live
   * implementation must include a PID birth marker (for example Linux start
   * time) plus the run identity, rather than returning a searchable fragment.
   */
  identity(pid: number): string | null
  terminate(pid: number, signal: GateSignal): void
}

/** Injected exact release port for one registered window. */
export interface GateWindowControl {
  release(windowClass: string, address: string): void
}

export interface GateRefusal {
  kind: GateResourceKind
  identity: string
  reason: string
}

export interface GateCleanupReport {
  terminatedPids: number[]
  releasedWindows: Array<{ windowClass: string; address: string }>
  removedSockets: string[]
  removedDirectories: string[]
  refused: GateRefusal[]
}

export interface GateResourceRegistryOptions {
  processControl?: GateProcessControl
  windowControl?: GateWindowControl
}

interface RegisteredProcess {
  pid: number
  expectedIdentity: string
}

interface RegisteredPath {
  dev: bigint
  ino: bigint
}

/**
 * Exact-identity resource registry for the live gate. Resources are removed
 * only through the injected controls and only at their exact registered
 * identities. Cleanup is best-effort (one failure never blocks the others),
 * idempotent, and safe to call from failure, interruption, and assertion
 * paths. A refused resource remains registered and retryable, so `clean`
 * cannot report success after an incomplete cleanup attempt.
 */
export class GateResourceRegistry {
  private readonly processControl: GateProcessControl | null
  private readonly windowControl: GateWindowControl | null
  private readonly processes = new Map<number, RegisteredProcess>()
  private readonly windows = new Map<string, { windowClass: string; address: string }>()
  private readonly sockets = new Map<string, RegisteredPath>()
  private readonly directories = new Map<string, RegisteredPath>()
  private cleanupAttempted = false

  constructor(options: GateResourceRegistryOptions = {}) {
    this.processControl = options.processControl ?? null
    this.windowControl = options.windowControl ?? null
  }

  /** True only when no registered resource remains pending cleanup. */
  get clean(): boolean {
    return this.processes.size === 0 &&
      this.windows.size === 0 &&
      this.sockets.size === 0 &&
      this.directories.size === 0
  }

  /**
   * Register one exact PID with the opaque process identity that must still
   * match byte-for-byte at cleanup time. A real control should include a
   * start-time or run nonce in this identity so PID reuse cannot match.
   * Registration without an injected process control fails closed.
   */
  registerProcess(pid: number, expectedIdentity: string): void {
    this.assertOpen()
    if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) {
      throw new Error(`gate process registration requires a positive integer PID, got ${String(pid)}`)
    }
    if (this.processControl === null) {
      throw new Error('gate process registration requires an injected exact process control (fail closed)')
    }
    const boundedIdentity = requireBoundedLabel('exact process identity', expectedIdentity)
    const currentIdentity = this.processControl.identity(pid)
    if (currentIdentity === null) {
      throw new Error(`gate process registration cannot identify exited PID ${pid}`)
    }
    if (currentIdentity !== boundedIdentity) {
      throw new Error(`gate process registration identity does not exactly match PID ${pid}`)
    }
    this.processes.set(pid, { pid, expectedIdentity: boundedIdentity })
  }

  /**
   * Register one exact window by class and address. Registration without an
   * injected window control fails closed: an unreleasable window must never
   * be registered.
   */
  registerWindow(windowClass: string, address: string): void {
    this.assertOpen()
    if (this.windowControl === null) {
      throw new Error('gate window registration requires an injected exact window control (fail closed)')
    }
    const boundedClass = requireBoundedLabel('window class', windowClass)
    const boundedAddress = requireBoundedLabel('window address', address)
    this.windows.set(windowKey(boundedClass, boundedAddress), { windowClass: boundedClass, address: boundedAddress })
  }

  /** Register one exact Unix socket file path for removal. */
  registerSocket(socketPath: string): void {
    this.assertOpen()
    const exactPath = requireAbsoluteResourcePath('socket', socketPath)
    rejectSymlinkComponents(exactPath)
    const stat = fs.lstatSync(exactPath, { bigint: true })
    if (!stat.isSocket()) {
      throw new Error('gate socket registration requires an existing Unix socket')
    }
    this.sockets.set(exactPath, pathIdentity(stat))
  }

  /** Register one exact scratch directory for recursive removal. */
  registerDirectory(directoryPath: string): void {
    this.assertOpen()
    const exactPath = requireAbsoluteResourcePath('directory', directoryPath)
    rejectSymlinkComponents(exactPath)
    const stat = fs.lstatSync(exactPath, { bigint: true })
    if (!stat.isDirectory()) {
      throw new Error('gate directory registration requires an existing directory')
    }
    this.directories.set(exactPath, pathIdentity(stat))
  }

  /**
   * Remove exactly the registered resources. Safe to call more than once:
   * successful removals are idempotent, while refused resources remain
   * registered for an exact retry. Never throws: individual failures are
   * recorded so one failure does not block the other resources.
   */
  cleanup(): GateCleanupReport {
    const report: GateCleanupReport = {
      terminatedPids: [],
      releasedWindows: [],
      removedSockets: [],
      removedDirectories: [],
      refused: [],
    }
    this.cleanupAttempted = true

    if (this.processControl !== null) {
      for (const registration of this.processes.values()) {
        const pid = registration.pid
        try {
          const currentIdentity = this.processControl.identity(pid)
          if (currentIdentity === null) {
            report.refused.push({ kind: 'pid', identity: String(pid), reason: 'process already exited' })
            continue
          }
          if (currentIdentity !== registration.expectedIdentity) {
            report.refused.push({
              kind: 'pid',
              identity: String(pid),
              reason: 'identity drift: current process identity does not exactly match the registered identity',
            })
            continue
          }
          this.processControl.terminate(pid, 'SIGTERM')
          report.terminatedPids.push(pid)
          this.processes.delete(pid)
        } catch (error) {
          report.refused.push({ kind: 'pid', identity: String(pid), reason: describe(error) })
        }
      }
    }

    for (const [key, registration] of this.windows) {
      try {
        this.windowControl?.release(registration.windowClass, registration.address)
        report.releasedWindows.push({ windowClass: registration.windowClass, address: registration.address })
        this.windows.delete(key)
      } catch (error) {
        report.refused.push({ kind: 'window', identity: registration.address, reason: describe(error) })
      }
    }

    for (const [socketPath, registeredIdentity] of this.sockets) {
      try {
        rejectSymlinkComponents(socketPath)
        const stat = fs.lstatSync(socketPath, { bigint: true })
        if (!stat.isSocket()) {
          report.refused.push({
            kind: 'socket',
            identity: socketPath,
            reason: 'registered path is not a socket file; refusing to unlink it',
          })
          continue
        }
        if (!samePathIdentity(stat, registeredIdentity)) {
          report.refused.push({ kind: 'socket', identity: socketPath, reason: 'socket identity drift: device/inode changed' })
          continue
        }
        fs.unlinkSync(socketPath)
        report.removedSockets.push(socketPath)
        this.sockets.delete(socketPath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        report.refused.push({
          kind: 'socket',
          identity: socketPath,
          reason: code === 'ENOENT' ? 'socket already absent' : describe(error),
        })
      }
    }

    for (const [directory, registeredIdentity] of this.directories) {
      try {
        rejectSymlinkComponents(directory)
        const stat = fs.lstatSync(directory, { bigint: true })
        if (stat.isSymbolicLink()) {
          report.refused.push({ kind: 'directory', identity: directory, reason: 'refusing to follow a symbolic link' })
          continue
        }
        if (!stat.isDirectory()) {
          report.refused.push({ kind: 'directory', identity: directory, reason: 'registered path is not a directory' })
          continue
        }
        if (!samePathIdentity(stat, registeredIdentity)) {
          report.refused.push({ kind: 'directory', identity: directory, reason: 'directory identity drift: device/inode changed' })
          continue
        }
        fs.rmSync(directory, { recursive: true, force: false })
        report.removedDirectories.push(directory)
        this.directories.delete(directory)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        report.refused.push({
          kind: 'directory',
          identity: directory,
          reason: code === 'ENOENT' ? 'directory already absent' : describe(error),
        })
      }
    }

    return report
  }

  private assertOpen(): void {
    if (this.cleanupAttempted) throw new Error('gate resource registry cleanup has already started')
  }
}

function requireBoundedLabel(field: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`gate registration requires a bounded non-empty ${field}`)
  }
  return value
}

function requireAbsoluteResourcePath(kind: string, value: string): string {
  const bounded = requireBoundedLabel(`absolute ${kind} path`, value)
  if (!path.isAbsolute(bounded)) {
    throw new Error(`gate ${kind} registration requires an absolute path`)
  }
  if (path.dirname(bounded) === bounded) {
    throw new Error(`refusing to register the filesystem root as a ${kind}`)
  }
  return bounded
}

function pathIdentity(stat: { dev: bigint; ino: bigint }): RegisteredPath {
  return { dev: stat.dev, ino: stat.ino }
}

function samePathIdentity(stat: { dev: bigint; ino: bigint }, expected: RegisteredPath): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino
}

function rejectSymlinkComponents(resourcePath: string): void {
  const root = path.parse(resourcePath).root
  const components = path.relative(root, resourcePath).split(path.sep).filter(Boolean)
  let current = root
  for (const component of components) {
    current = path.join(current, component)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`refusing resource path with symbolic link component: ${current}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function windowKey(windowClass: string, address: string): string {
  return `${windowClass}\u0000${address}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
