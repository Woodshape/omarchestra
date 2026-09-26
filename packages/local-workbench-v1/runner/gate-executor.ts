/**
 * AL-05 bounded validator-child executor (contract C8). Isolated module: no
 * store, no authority, no bridge, no acceptance decision.
 *
 * Verifies the frozen executable and every declared resource by content
 * immediately before spawn, constructs the child environment (never
 * inherited), spawns exactly one child with no shell under explicit
 * timeout/output/scratch bounds, and requests cooperative termination of the
 * child only on timeout or output-cap breach. It never signals Pi, its
 * tools, or any other process, and never escalates past SIGTERM: a child
 * that ignores the cooperative request within the grace window yields an
 * explicit `unknown` outcome and leaves its scratch area quarantined (C8).
 * Exit 0 is a provisional pass only; nonzero exit, spawn failure, timeout,
 * output cap, resource drift and scratch-bound overflow are durably
 * distinguished non-passes.
 *
 * The caller (AL-05 orchestration) owns candidate checkout double-scans, the
 * final acceptance transaction and restricted diagnostics retention (C13);
 * this module returns capped evidence and bounded counters only.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { workbenchError } from './errors.ts'
import type { PinnedFile, ResolvedCheckDefinition } from './check-definition.ts'

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024
const CHUNK = 64 * 1024
const DEFAULT_GRACE_MS = 5000
const DEFAULT_SCRATCH_ENTRIES = 200000
const DEFAULT_SCRATCH_BYTES = 256 * 1024 * 1024
/** Constructed environment keys are executor-owned; a frozen definition may never override them. */
const RESERVED_ENV = /^(?:HOME|TMPDIR|TMP|TEMP|PATH|LANG|LC_.*|GIT_.*|PI_.*|SSH_.*|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV)$/i

export type GateOutcome = 'pass' | 'nonzero' | 'spawn_error' | 'timeout' | 'output_limit' | 'gate_changed' | 'unknown'
export type ResourceState = 'verified' | 'changed' | 'missing' | 'unreadable'
export interface GateResourceCheck { path: string; kind: 'executable' | 'resource'; pre: ResourceState; post: ResourceState | null }
export interface GateExecution {
  outcome: GateOutcome
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  reasonCode: string | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  resourceChecks: GateResourceCheck[]
  scratchPath: string | null
  scratchCleaned: boolean
  scratchEntries: number
  scratchBytes: number
  startedAt: number
  endedAt: number
}
export interface GateExecutorOptions {
  /** Existing runner-owned scratch root; one unique session directory is created inside it. */
  scratchRoot: string
  /** Cooperative-termination grace after timeout/output cap; bounded 50–30000 ms. */
  graceMs?: number
  /** Durable stop/Assignment deadline; cooperative validator-child signal only. */
  signal?: AbortSignal
  /** Last Runner-owned fence check after synchronous resource hashing. */
  beforeSpawn?: () => boolean
  /** C9 scratch bounds; exceeding either quarantines the scratch as `unknown`. */
  scratchEntryBound?: number
  scratchByteBound?: number
}

type Observed = { digest: string; length: number; mode: number }

function gateInvalid(message: string): never {
  throw workbenchError('invalid_input', `Gate executor: ${message}`, 'run only a frozen resolved check definition under the configured bounds')
}

/** Re-assert the frozen bounds locally; the executor never trusts an unfrozen definition. */
function assertDefinition(definition: ResolvedCheckDefinition): void {
  if (!isAbsolute(definition.executable) || !definition.executable.isWellFormed() || definition.executable.includes('\0')) {
    gateInvalid('executable must be an absolute canonical path')
  }
  if (!Array.isArray(definition.argv) || definition.argv.length > 64
    || definition.argv.some(arg => typeof arg !== 'string' || !arg.isWellFormed() || arg.includes('\0') || Buffer.byteLength(arg) > 4096)
    || definition.argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 32768) {
    gateInvalid('argv exceeds the 64/4096/32KiB bounds')
  }
  if (!isAbsolute(definition.cwd)) gateInvalid('cwd must be the confirmed absolute Project root')
  if (!Array.isArray(definition.environment) || definition.environment.length > 32) gateInvalid('environment must hold at most 32 entries')
  const names = new Set<string>()
  for (const entry of definition.environment) {
    if (typeof entry.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) || Buffer.byteLength(entry.name) > 128
      || typeof entry.value !== 'string' || !entry.value.isWellFormed() || Buffer.byteLength(entry.value) > 4096
      || RESERVED_ENV.test(entry.name) || /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i.test(entry.name)) {
      gateInvalid('environment entries are invalid, reserved or resemble a secret')
    }
    if (names.has(entry.name)) gateInvalid('duplicate environment key')
    names.add(entry.name)
  }
  if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 100 || definition.timeoutMs > 300000) {
    gateInvalid('timeoutMs must be within 100–300000 ms')
  }
  if (!Number.isSafeInteger(definition.outputBytes) || definition.outputBytes < 1 || definition.outputBytes > 65536) {
    gateInvalid('outputBytes must be within 1–65536 bytes')
  }
  if (!Array.isArray(definition.resources) || definition.resources.length > 63) gateInvalid('at most 63 declared resources')
  for (const resource of definition.resources) {
    if (!isAbsolute(resource.path) || !/^[a-f0-9]{64}$/.test(resource.digest) || !Number.isSafeInteger(resource.length)
      || resource.length < 0 || resource.length > MAX_RESOURCE_BYTES || !Number.isSafeInteger(resource.mode) || resource.mode < 0 || resource.mode > 0o777) {
      gateInvalid('declared resource pin is invalid')
    }
  }
}

/** Bounded NOFOLLOW content probe; never throws and never follows symlinks. */
function hashBounded(path: string): Observed | 'missing' | 'unreadable' {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CLOEXEC) }
  catch (error) { return (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable' }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile()) return 'unreadable'
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK)
    let size = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(CHUNK, MAX_RESOURCE_BYTES + 1 - size), null)
      if (count === 0) break
      size += count
      if (size > MAX_RESOURCE_BYTES) return 'unreadable'
      digest.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd, { bigint: true })
    const pathNow = lstatSync(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size
      || pathNow.dev !== before.dev || pathNow.ino !== before.ino) return 'unreadable'
    return { digest: digest.digest('hex'), length: size, mode: Number(before.mode & 0o777n) }
  } catch { return 'unreadable' }
  finally { closeSync(fd) }
}

function probeState(path: string, matches: (observed: Observed) => boolean): ResourceState {
  const observed = hashBounded(path)
  if (observed === 'missing') return 'missing'
  if (observed === 'unreadable') return 'unreadable'
  return matches(observed) ? 'verified' : 'changed'
}

function probeExecutable(definition: ResolvedCheckDefinition): ResourceState {
  return probeState(definition.executable, observed => observed.digest === definition.executableDigest)
}

function probeResource(resource: PinnedFile): ResourceState {
  return probeState(resource.path, observed => observed.digest === resource.digest && observed.length === resource.length && observed.mode === resource.mode)
}

function collectPreChecks(definition: ResolvedCheckDefinition): GateResourceCheck[] {
  return [
    { path: definition.executable, kind: 'executable', pre: probeExecutable(definition), post: null },
    ...definition.resources.map(resource => ({ path: resource.path, kind: 'resource' as const, pre: probeResource(resource), post: null })),
  ]
}

function collectPostChecks(definition: ResolvedCheckDefinition, checks: GateResourceCheck[]): void {
  for (const check of checks) {
    check.post = check.kind === 'executable'
      ? probeExecutable(definition)
      : probeState(check.path, observed => {
        const resource = definition.resources.find(candidate => candidate.path === check.path)
        return resource !== undefined && observed.digest === resource.digest
          && observed.length === resource.length && observed.mode === resource.mode
      })
  }
}

function driftReason(checks: GateResourceCheck[], phase: 'pre' | 'post'): string | null {
  for (const check of checks) {
    const state = check[phase]
    if (state === 'verified') continue
    if (check.kind === 'executable') return `executable_drift_${phase}`
    return `resource_${state}_${phase}`
  }
  return null
}

/** Bounded scratch walk; never follows symlinks and never deletes. */
function walkScratch(root: string, entryBound: number): { entries: number; bytes: number; overflow: boolean } {
  let entries = 0
  let bytes = 0
  let overflow = false
  const visit = (path: string, depth: number): void => {
    if (overflow || depth > 32) { overflow = true; return }
    let dirents
    try { dirents = readdirSync(path, { withFileTypes: true }) } catch { overflow = true; return }
    for (const dirent of dirents) {
      entries += 1
      if (entries > entryBound) { overflow = true; return }
      const child = join(path, dirent.name)
      if (dirent.isDirectory()) visit(child, depth + 1)
      else if (dirent.isFile()) { try { bytes += lstatSync(child).size } catch { /* unreadable entry is counted only */ } }
    }
  }
  visit(root, 0)
  return { entries, bytes, overflow }
}

/**
 * Execute one frozen gate child under C8 bounds and return the explicit
 * outcome. Throws `invalid_input` only for out-of-bounds definitions, bad
 * executor options or a missing scratch root; every child-level problem is
 * a returned non-passing outcome, never an exception and never a silent
 * pass. A `pass` is provisional: acceptance still requires the caller's
 * checkout double-scan, final transaction rechecks and quiescence evidence.
 */
export async function executeGate(definition: ResolvedCheckDefinition, options: GateExecutorOptions): Promise<GateExecution> {
  assertDefinition(definition)
  const graceMs = options.graceMs ?? 5000
  if (!Number.isSafeInteger(graceMs) || graceMs < 50 || graceMs > 30000) {
    gateInvalid('graceMs must be within 50–30000 ms')
  }
  const scratchEntryBound = options.scratchEntryBound ?? 200000
  const scratchByteBound = options.scratchByteBound ?? 256 * 1024 * 1024
  const startedAt = Date.now()
  const endedAt = () => Date.now()

  // Declared-resource closure: verify content immediately before spawn (C8).
  const checks = collectPreChecks(definition)
  const revoked = options.signal?.aborted || options.beforeSpawn?.() === false
  if (driftReason(checks, 'pre') !== null || revoked) {
    return {
      outcome: revoked ? 'unknown' : 'gate_changed', exitCode: null, signal: null, timedOut: false,
      reasonCode: revoked ? 'spawn_authority_revoked' : driftReason(checks, 'pre'), stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
      resourceChecks: checks, scratchPath: null, scratchCleaned: false, scratchEntries: 0, scratchBytes: 0,
      startedAt, endedAt: endedAt(),
    }
  }

  let scratch: string
  try { scratch = mkdtempSync(join(options.scratchRoot, 'gate-'), { encoding: 'utf8' }) } catch {
    throw workbenchError('missing_resource', 'Gate executor: scratch root is missing or unwritable', 'create the runner-owned scratch root before executing a gate')
  }
  const home = join(scratch, 'home')
  const tmp = join(scratch, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(tmp, { recursive: true })

  // Constructed environment: fixed locale plus scratch HOME/TMPDIR and the
  // operator-confirmed entries; nothing is inherited from the Runner process.
  const environment: Record<string, string> = { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: home, TMPDIR: tmp }
  for (const entry of definition.environment) environment[entry.name] = entry.value

  const child = spawn(definition.executable, [...definition.argv], {
    cwd: definition.cwd, env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let limited = false
  let timedOut = false
  let stopped = false
  let requested = false
  let settled = false
  let closeCode: number | null = null
  let closeSignal: string | null = null
  let closed = false
  let resolveExecution!: (execution: GateExecution) => void
  const done = new Promise<GateExecution>(resolve => { resolveExecution = resolve })

  const timeout = setTimeout(() => { timedOut = true; requestCooperativeTermination() }, definition.timeoutMs)
  let grace: NodeJS.Timeout | null = null
  const onStop = () => { stopped = true; requestCooperativeTermination() }
  options.signal?.addEventListener('abort', onStop, { once: true })
  if (options.signal?.aborted) onStop()

  function requestCooperativeTermination(): void {
    if (requested) return
    requested = true
    try { child.kill('SIGTERM') } catch { /* an unspawnable child is handled by the error path */ }
    // The grace window starts when the cooperative request is made: a child
    // that ignores it yields an explicit `unknown` outcome, no kill
    // escalation, and its scratch area stays quarantined (C8).
    grace = setTimeout(() => { settleUnknown('child_unterminated') }, graceMs)
  }

  function markLimited(): void {
    if (limited) return
    limited = true
    try { child.stdout?.pause(); child.stderr?.pause() } catch { /* already ended */ }
    requestCooperativeTermination()
  }

  function absorb(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const previous = stream === 'stdout' ? stdoutBytes : stderrBytes
    const room = Math.min(32768 - previous, definition.outputBytes - stdoutBytes - stderrBytes)
    if (room <= 0) { markLimited(); return }
    const taken = chunk.subarray(0, room)
    if (stream === 'stdout') { stdoutChunks.push(taken); stdoutBytes = previous + taken.length }
    else { stderrChunks.push(taken); stderrBytes = previous + taken.length }
    if (chunk.length > room) markLimited()
  }
  child.stdout?.on('data', (chunk: Buffer) => absorb('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => absorb('stderr', chunk))
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (settled) return
    settled = true
    options.signal?.removeEventListener('abort', onStop)
    clearTimeout(timeout)
    if (grace !== null) clearTimeout(grace)
    let scratchCleaned = true
    try { rmSync(scratch, { recursive: true, force: true }) } catch { scratchCleaned = false }
    resolveExecution({
      outcome: 'spawn_error', exitCode: null, signal: null, timedOut,
      reasonCode: `spawn_${String(error.code ?? 'error').toLowerCase()}`,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutBytes, stderrBytes, resourceChecks: checks,
      scratchPath: scratch, scratchCleaned, scratchEntries: 0, scratchBytes: 0,
      startedAt, endedAt: endedAt(),
    })
  })
  child.on('close', (code: number | null, signal: string | null) => {
    closed = true
    closeCode = code
    closeSignal = signal
    finalizeAfterClose()
  })

  function settleUnknown(reasonCode: string): void {
    if (settled) return
    settled = true
    options.signal?.removeEventListener('abort', onStop)
    clearTimeout(timeout)
    if (grace !== null) clearTimeout(grace)
    resolveExecution({
      outcome: 'unknown', exitCode: null, signal: null, timedOut, reasonCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutBytes, stderrBytes, resourceChecks: checks,
      scratchPath: scratch, scratchCleaned: false, scratchEntries: 0, scratchBytes: 0,
      startedAt, endedAt: endedAt(),
    })
  }

  function finalizeAfterClose(): void {
    if (settled) return
    settled = true
    options.signal?.removeEventListener('abort', onStop)
    clearTimeout(timeout)
    if (grace !== null) clearTimeout(grace)
    // Declared-resource stability after exit (C8): drift is nonaccepting even on exit 0.
    collectPostChecks(definition, checks)
    let outcome: GateOutcome
    let reasonCode: string | null = null
    const drift = driftReason(checks, 'post')
    if (stopped) { outcome = 'unknown'; reasonCode = 'stop_recorded' }
    else if (drift !== null) { outcome = 'gate_changed'; reasonCode = drift }
    else if (limited) outcome = 'output_limit'
    else if (timedOut) outcome = 'timeout'
    else if (closeCode === 0 && closeSignal === null) outcome = 'pass'
    else if (closeCode !== null && closeCode !== 0 && closeSignal === null) outcome = 'nonzero'
    else { outcome = 'unknown'; reasonCode = 'signal_exit' }

    const walk = walkScratch(scratch, scratchEntryBound)
    let scratchCleaned = false
    if (walk.overflow || walk.bytes > scratchByteBound) {
      // Quarantine instead of unsafe cleanup; the outcome stays nonaccepting.
      resolveExecution({
        outcome: 'unknown', exitCode: closeCode, signal: closeSignal, timedOut,
        reasonCode: 'scratch_bound_exceeded',
        stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutBytes, stderrBytes, resourceChecks: checks,
        scratchPath: scratch, scratchCleaned: false, scratchEntries: walk.entries, scratchBytes: walk.bytes,
        startedAt, endedAt: endedAt(),
      })
      return
    }
    try { rmSync(scratch, { recursive: true, force: true }); scratchCleaned = true } catch { scratchCleaned = false }
    if ((outcome === 'pass' || outcome === 'nonzero') && !scratchCleaned) {
      outcome = 'unknown'
      reasonCode = 'scratch_quarantined'
    }
    resolveExecution({
      outcome, exitCode: closeCode, signal: closeSignal, timedOut, reasonCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdoutBytes, stderrBytes, resourceChecks: checks,
      scratchPath: scratch, scratchCleaned, scratchEntries: walk.entries, scratchBytes: walk.bytes,
      startedAt, endedAt: endedAt(),
    })
  }

  return done
}