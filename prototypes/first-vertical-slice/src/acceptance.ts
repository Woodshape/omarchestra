/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * acceptance.ts — the unattended fake-only acceptance gate for the first
 * vertical-slice prototype. For each supported journal mode ("default" and
 * "wal", both reported without ranking) it runs the complete guided scenario
 * against a fresh outside-repository temporary state directory, prints
 * complete inspectable state after every guided step, and enforces the
 * mechanical acceptance assertions.
 *
 * The only permitted subprocesses are the exact local foreground Node runner
 * launches (first start and restart). Fakes are in-process only: no Pi,
 * Boomux, Ghostty, Hyprland, SSH, systemd, GUI, provider, hidden agent,
 * public listener, or remote command is invoked.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  MAX_FRAME_BYTES,
  NdjsonDecoder,
  ProtocolError,
  encodeFrame,
  validateAssignmentAck,
  type EventRecord,
  type Role,
  type SnapshotBody,
} from './protocol.ts'
import { attachFrameChannelToStreams } from './transport.ts'
import { FakeVisibleBridge, type VisibleHostIdentity } from './visible-bridge.ts'
import { ThinProjectionClient } from './thin-client.ts'
import { Domain } from './domain.ts'
import { ensureStateDirectory, Store, type BootstrapConfig } from './store.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_DIR = path.dirname(HERE)
const CLI_PATH = path.join(HERE, 'cli.ts')

const BOOTSTRAP = {
  teamGoalId: 'team-goal-vertical-slice-1',
  goalText: 'Vertical-slice prototype: prove durable role-labelled visible-agent seams (throwaway).',
  roles: [
    {
      role: 'coordinator',
      agentRunId: 'agent-run-coordinator-1',
      terminalSessionRef: 'terminal-coordinator-1',
      piSessionId: 'pi-session-coordinator-1',
      extensionInstanceId: 'bridge-ext-coordinator-1',
      hostPid: 41001,
      shellRunId: 'shell-run-coordinator-1',
    },
    {
      role: 'builder',
      agentRunId: 'agent-run-builder-1',
      terminalSessionRef: 'terminal-builder-1',
      piSessionId: 'pi-session-builder-1',
      extensionInstanceId: 'bridge-ext-builder-1',
      hostPid: 41002,
      shellRunId: 'shell-run-builder-1',
    },
    {
      role: 'reviewer',
      agentRunId: 'agent-run-reviewer-1',
      terminalSessionRef: 'terminal-reviewer-1',
      piSessionId: 'pi-session-reviewer-1',
      extensionInstanceId: 'bridge-ext-reviewer-1',
      hostPid: 41003,
      shellRunId: 'shell-run-reviewer-1',
    },
  ],
  assignment: {
    id: 'assignment-builder-1',
    role: 'builder',
    agentRunId: 'agent-run-builder-1',
    prompt:
      'Harmless prototype assignment: confirm the visible bridge seam by replying with the fixed prototype acknowledgement phrase.',
  },
} as const

const DISPLAY: Record<Role, string> = { coordinator: 'Coordinator', builder: 'Builder', reviewer: 'Reviewer' }

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Static source audits (in-process; scoped to the prototype per task 1.b F12)
// ---------------------------------------------------------------------------

function readSrc(name: string): string {
  return fs.readFileSync(path.join(HERE, name), 'utf8')
}

function auditFileContent(relativePath: string, content: string, forbidden: RegExp, reason: string): void {
  const match = forbidden.exec(content)
  if (match !== null) {
    throw new Error(
      `source audit failed: ${relativePath} contains forbidden pattern ${JSON.stringify(match[0])} (${reason})`,
    )
  }
}

function runSourceAudits(): void {
  const srcFiles = fs.readdirSync(HERE).filter((name) => name.endsWith('.ts'))
  // The auditor (acceptance.ts) is excluded from token scans per task 1.b F12:
  // its own patterns necessarily contain the audited tokens.
  const auditees = srcFiles.filter((name) => name !== 'acceptance.ts')

  // 1. Only store.ts may reference the SQLite API (dependency-graph level).
  const sqliteOwners = auditees.filter((name) => /node:sqlite|DatabaseSync/.test(readSrc(name)))
  assert(
    sqliteOwners.length === 1 && sqliteOwners[0] === 'store.ts',
    `SQLite API must be owned only by src/store.ts; found in: ${sqliteOwners.join(', ')}`,
  )

  // 2. Presentation layer and the QML fixture must not reference storage.
  const qmlPath = path.join(PROTOTYPE_DIR, 'qml', 'AgentProjectionFixture.qml')
  const qmlContent = fs.readFileSync(qmlPath, 'utf8')
  for (const [rel, content] of [
    ['src/presentation.ts', readSrc('presentation.ts')],
    ['src/thin-client.ts', readSrc('thin-client.ts')],
    ['qml/AgentProjectionFixture.qml', qmlContent],
  ] as const) {
    auditFileContent(rel, content, /node:sqlite|DatabaseSync|PRAGMA|journal_mode/, 'presentation code must not touch storage')
  }
  assert(
    /property string projectionEventsJson\s*:/.test(qmlContent) &&
      /JSON\.parse\(projectionEventsJson\)/.test(qmlContent) &&
      /projectionEvents/.test(qmlContent),
    'QML projection fixture exposes injected snapshot and ordered event projections',
  )

  // 3. The thin client must not import storage, domain, runner, or CLI modules.
  auditFileContent(
    'src/thin-client.ts',
    readSrc('thin-client.ts'),
    /from '\.\/(store|domain|runner|cli)\.ts'/,
    'thin client must depend only on protocol and transport',
  )

  // 4. No forbidden process or GUI coupling in executable prototype sources.
  const forbiddenProcess =
    /node:(child_process|worker_threads)|child_process|shell[ \t]*:[ \t]*true|process[.]kill[ \t]*\(|node-pty|injectPty|writeToPty|createAgentSession|runRpcMode|rpc-mode|systemd-run|systemctl|hyprctl|qmlscene|quickshell|xdg-open|WAYLAND_DISPLAY|boomux[ \t]+(open|create|close|read)|(^|[^A-Za-z0-9_])ssh[ \t]+-/
  for (const name of auditees) {
    auditFileContent(`src/${name}`, readSrc(name), forbiddenProcess, 'forbidden process or GUI coupling')
  }

  // 5. Transport stays on filesystem Unix paths; no TCP/HTTP coupling.
  for (const name of auditees) {
    auditFileContent(
      `src/${name}`,
      readSrc(name),
      /0\.0\.0\.0|127\.0\.0\.1|localhost|https?:\/\/|listen\(\s*\d/,
      'TCP or HTTP coupling is forbidden; only filesystem Unix sockets',
    )
  }

  out('AUDIT  source-audits: PASS (sole SQLite owner; QML snapshot/events storage-free; no process/GUI/TCP coupling)')
}

/** Every executable module imports and links cleanly (parse + link check). */
async function runModuleLinkCheck(): Promise<void> {
  for (const name of [
    'protocol.ts',
    'presentation.ts',
    'store.ts',
    'domain.ts',
    'transport.ts',
    'visible-bridge.ts',
    'thin-client.ts',
    'runner.ts',
    'cli.ts',
  ]) {
    await import(`./${name}`)
  }
  out('AUDIT  module-link-check: PASS (all runner modules parse and link under the installed Node)')
}

function runProtocolNegativeChecks(): void {
  let threw = false
  try {
    encodeFrame('snapshot', 'msg-oversize', { blob: 'x'.repeat(MAX_FRAME_BYTES + 1) })
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'encodeFrame must reject oversized frames')

  const decoder = new NdjsonDecoder()
  threw = false
  try {
    decoder.push(
      `${JSON.stringify({
        protocol: 'omarchestra.first-vertical-slice/v1',
        type: 'bridge.hello',
        messageId: 'm1',
        body: {},
        extra: 1,
      })}\n`,
    )
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'decoder must reject unknown top-level frame fields')

  threw = false
  try {
    decoder.push(
      `${JSON.stringify({ protocol: 'omarchestra.other/v9', type: 'bridge.hello', messageId: 'm2', body: {} })}\n`,
    )
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'decoder must reject unsupported protocol versions')

  threw = false
  try {
    validateAssignmentAck({ assignmentId: 'a1', ack: 'sideways' })
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'body validator must reject invalid acknowledgement enum values')

  threw = false
  try {
    decoder.push('{"protocol":"omarchestra.first-vertical-slice/v1"}\n')
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'decoder must reject incomplete envelopes')

  threw = false
  try {
    const oversizedIncoming = JSON.stringify({
      protocol: 'omarchestra.first-vertical-slice/v1',
      type: 'protocol_error',
      messageId: 'incoming-oversize',
      body: { code: 'oversize', detail: 'x'.repeat(MAX_FRAME_BYTES) },
    })
    new NdjsonDecoder().push(`${oversizedIncoming}\n`)
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'decoder must reject oversized incoming frames')

  threw = false
  try {
    encodeFrame('presentation_update', 'bad-presentation', { role: 'builder', unexpected: true })
  } catch (error) {
    threw = error instanceof ProtocolError
  }
  assert(threw, 'runner body validator must reject malformed presentation updates')

  out('AUDIT  protocol-negative-checks: PASS (outgoing/incoming bounds, strict fields, version and enum validation)')
}

/** Round-trip frames through the injected SSH-stdio-shaped stream boundary. */
async function runSshStdioSeamCheck(): Promise<void> {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const received: unknown[] = []
  let closed = false
  const channel = attachFrameChannelToStreams(
    { stdin: incoming, stdout: outgoing },
    {
      onFrame: (frame) => received.push(frame),
      onClose: () => {
        closed = true
      },
    },
  )
  channel.send('hello_ack', 'ssh-seam-1', { connectionKind: 'projection', teamGoalId: 't', role: null })
  const wireLine = await new Promise<string>((resolve) => {
    outgoing.setEncoding('utf8')
    outgoing.on('data', (chunk: string) => resolve(chunk.trim()))
  })
  const wire = JSON.parse(wireLine) as Record<string, unknown>
  assert(wire.protocol === 'omarchestra.first-vertical-slice/v1', 'SSH-stdio seam frames carry the versioned protocol')
  incoming.write(
    `${JSON.stringify({
      protocol: 'omarchestra.first-vertical-slice/v1',
      type: 'projection.hello',
      messageId: 'm1',
      body: { teamGoalId: 't', clientId: 'c', resumeAfter: null },
    })}\n`,
  )
  await sleep(50)
  assert(received.length === 1, 'SSH-stdio seam decoded the injected frame')
  assert(!closed, 'SSH-stdio seam stayed open')
  out('AUDIT  ssh-stdio-seam: PASS (interface-only round trip over injected streams; no SSH process exists)')
}

async function runDomainSafetyNegativeChecks(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-vertical-negative-'))
  const target = path.join(base, 'target')
  const link = path.join(base, 'state-link')
  fs.mkdirSync(target, { mode: 0o700 })
  fs.symlinkSync(target, link)
  let threw = false
  try {
    ensureStateDirectory(link)
  } catch {
    threw = true
  }
  assert(threw, 'caller-supplied state-directory symlinks are rejected')

  const ancestorTarget = path.join(base, 'ancestor-target')
  const ancestorLink = path.join(base, 'ancestor-link')
  const escapedChild = path.join(ancestorTarget, 'must-not-be-created')
  fs.mkdirSync(ancestorTarget, { mode: 0o700 })
  fs.symlinkSync(ancestorTarget, ancestorLink)
  threw = false
  try {
    ensureStateDirectory(path.join(ancestorLink, 'must-not-be-created'))
  } catch {
    threw = true
  }
  assert(threw, 'state directories with symlinked ancestors are rejected')
  assert(!fs.existsSync(escapedChild), 'symlink-ancestor refusal occurs before creating anything through the link')

  const state = path.join(base, 'state')
  const established = ensureStateDirectory(state)
  const store = Store.open(established.stateDir, 'default', established.mount)
  const domain = new Domain(store)
  const config = JSON.parse(JSON.stringify(BOOTSTRAP)) as BootstrapConfig
  domain.bootstrapIfNeeded(config)

  threw = false
  try {
    domain.acceptAssignment(
      BOOTSTRAP.assignment.id,
      'coordinator',
      BOOTSTRAP.roles.find((role) => role.role === 'coordinator')!.extensionInstanceId,
    )
  } catch {
    threw = true
  }
  assert(threw, 'Coordinator cannot acknowledge the Builder assignment')

  threw = false
  try {
    domain.recordDuplicateAck(
      BOOTSTRAP.assignment.id,
      'builder',
      BOOTSTRAP.roles.find((role) => role.role === 'builder')!.extensionInstanceId,
    )
  } catch {
    threw = true
  }
  assert(threw, 'duplicate acknowledgement is rejected before durable acceptance')

  threw = false
  const builder = BOOTSTRAP.roles.find((role) => role.role === 'builder')!
  try {
    domain.bridgeHandshake({ ...builder, teamGoalId: BOOTSTRAP.teamGoalId, hostMode: 'tui', shellRunId: 'changed-shell-run' })
  } catch {
    threw = true
  }
  assert(threw, 'changed Shell Run identity is rejected')
  store.close()
  fs.rmSync(base, { recursive: true, force: true })
  out('AUDIT  domain-safety-negatives: PASS (direct/ancestor symlinks, wrong-role ack, premature duplicate, changed Shell Run rejected)')
}

// ---------------------------------------------------------------------------
// Runner process lifecycle (the only permitted subprocess usage)
// ---------------------------------------------------------------------------

interface RunnerHandle {
  child: ChildProcess
  ready: Record<string, unknown>
  stdoutLines: string[]
  stderrLines: string[]
}

const processLedger: Array<{ label: string; pid: number | null; argv: string[] }> = []

function runnerLaunchArgv(stateDir: string, journalMode: string, bootstrapJson: string): string[] {
  const safeNodeFlags = process.execArgv.filter((flag) =>
    flag === '--experimental-sqlite' || flag === '--experimental-strip-types',
  )
  return [
    ...safeNodeFlags,
    CLI_PATH,
    '--state-dir',
    stateDir,
    '--journal',
    journalMode,
    '--bootstrap-json',
    bootstrapJson,
  ]
}

async function startRunner(
  label: string,
  stateDir: string,
  journalMode: string,
  bootstrapJson: string,
  registerChild: (child: ChildProcess) => void = () => {},
): Promise<RunnerHandle> {
  const argv = runnerLaunchArgv(stateDir, journalMode, bootstrapJson)
  const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
  registerChild(child)
  processLedger.push({ label, pid: child.pid ?? null, argv: [process.execPath, ...argv] })
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  let readyResolve: ((value: Record<string, unknown>) => void) | null = null
  const readyPromise = new Promise<Record<string, unknown>>((resolve) => {
    readyResolve = resolve
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) continue
      stdoutLines.push(line)
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.event === 'runner_ready' && readyResolve !== null) {
          readyResolve(parsed)
          readyResolve = null
        }
      } catch {
        // non-JSON runner output is kept for inspection
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) continue
      stderrLines.push(line)
    }
  })
  const ready = await withTimeout(readyPromise, 15000, `${label} readiness report`)
  await withTimeout(waitForSocket(String(ready.socket)), 5000, `${label} socket appearance`)
  return { child, ready, stdoutLines, stderrLines }
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    try {
      if (fs.lstatSync(socketPath).isSocket()) return
    } catch {
      // not there yet
    }
    await sleep(25)
  }
  throw new Error(`socket ${socketPath} never appeared`)
}

async function stopRunner(label: string, handle: RunnerHandle): Promise<void> {
  const exited = new Promise<number | null>((resolve) => {
    handle.child.once('exit', (code) => resolve(code))
  })
  handle.child.kill('SIGTERM')
  const code = await withTimeout(exited, 10000, `${label} graceful exit`)
  assert(code === 0, `${label} exited cleanly after SIGTERM (exit code ${code})`)
  assert(
    handle.stdoutLines.some((line) => line.includes('runner_stopped')),
    `${label} printed a runner_stopped record`,
  )
  assert(handle.stderrLines.length === 0, `${label} produced no stderr output`)
}

// ---------------------------------------------------------------------------
// Scenario state rendering and assertions
// ---------------------------------------------------------------------------

function assertSnapshotShape(snapshot: SnapshotBody, where: string): void {
  assert(snapshot.roles.length === 3, `${where}: exactly three role projections`)
  const roles = snapshot.roles.map((role) => role.role)
  assert(new Set(roles).size === 3, `${where}: role bindings are distinct`)
  for (const role of snapshot.roles) {
    assert(
      role.nativeTerminalTitle.length > 0 && role.piStatus.length > 0,
      `${where}: labels non-empty for ${role.role}`,
    )
  }
  assert(new Set(snapshot.roles.map((r) => r.nativeTerminalTitle)).size === 3, `${where}: native titles pairwise distinct`)
  assert(new Set(snapshot.roles.map((r) => r.piStatus)).size === 3, `${where}: Pi statuses pairwise distinct`)
}

function roleProjectionOf(snapshot: SnapshotBody, role: Role): Record<string, unknown> {
  const entry = snapshot.roles.find((candidate) => candidate.role === role)
  assert(entry !== undefined, `${where(role)}: role ${role} present in snapshot`)
  return entry as unknown as Record<string, unknown>
}

function where(role: Role): string {
  return `role ${role}`
}

function assertLabelsContain(snapshot: SnapshotBody, role: Role, state: string, label: string): void {
  const entry = roleProjectionOf(snapshot, role)
  assert(
    entry.nativeTerminalTitle === `Omarchestra — ${DISPLAY[role]} — ${state}`,
    `${label}: native terminal title for ${role} must be the exact contract string carrying ${state}`,
  )
  assert(
    entry.piStatus === `${DISPLAY[role]} · ${state}`,
    `${label}: Pi status for ${role} must be the exact contract string carrying ${state}`,
  )
}

function expectRoleStates(snapshot: SnapshotBody, expected: Record<Role, string>, label: string): void {
  for (const [role, state] of Object.entries(expected) as [Role, string][]) {
    assertLabelsContain(snapshot, role, state, label)
  }
}

function renderSnapshot(where_: string, snapshot: SnapshotBody): void {
  out(`--- STATE ${where_} (durable cursor ${snapshot.cursor}) ---`)
  out(json(snapshot))
}

let inspectionCounter = 0
async function captureSnapshot(socketPath: string, label: string): Promise<SnapshotBody> {
  const client = new ThinProjectionClient(BOOTSTRAP.teamGoalId, `inspection-${++inspectionCounter}`, socketPath)
  await withTimeout(client.connect(null), 8000, `${label} snapshot`)
  const snapshot = client.snapshot
  assert(snapshot !== null, `${label}: authoritative snapshot received`)
  client.disconnect()
  renderSnapshot(label, snapshot)
  return snapshot
}

function assertEventsOrdered(events: EventRecord[], cursor: number, label: string): void {
  const sequences = events.map((event) => event.sequence)
  for (let i = 0; i < sequences.length; i += 1) {
    assert(sequences[i] === i + 1, `${label}: durable sequences are contiguous from 1 (position ${i} has ${sequences[i]})`)
  }
  assert(new Set(events.map((event) => event.eventId)).size === events.length, `${label}: event ids are unique`)
  assert(cursor === sequences.length, `${label}: durable cursor ${cursor} equals the event count`)
}

// ---------------------------------------------------------------------------
// One complete guided scenario for one journal mode
// ---------------------------------------------------------------------------

interface ScenarioOptions {
  failAfterFirstRunnerStart?: boolean
  observeFirstRunner?: (resource: { pid: number; stateDir: string }) => void
}

interface ScenarioResources {
  stateDir: string | null
  children: Set<ChildProcess>
}

async function stopChildForCleanup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  try {
    await withTimeout(exited, 3000, 'failed-scenario runner cleanup')
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await withTimeout(exited, 3000, 'failed-scenario forced runner cleanup')
  }
}

async function cleanupScenarioResources(resources: ScenarioResources): Promise<void> {
  for (const child of resources.children) await stopChildForCleanup(child)
  resources.children.clear()
  if (resources.stateDir !== null) {
    fs.rmSync(resources.stateDir, { recursive: true, force: true })
    resources.stateDir = null
  }
}

async function runScenario(journalMode: 'default' | 'wal', options: ScenarioOptions = {}): Promise<void> {
  const resources: ScenarioResources = { stateDir: null, children: new Set() }
  try {
    await runScenarioBody(journalMode, options, resources)
  } finally {
    await cleanupScenarioResources(resources)
  }
}

async function runScenarioBody(
  journalMode: 'default' | 'wal',
  options: ScenarioOptions,
  resources: ScenarioResources,
): Promise<void> {
  out('')
  out('======================================================================')
  out(`SCENARIO journal=${journalMode} (requested and effective modes reported; no mode is ranked)`)
  out('======================================================================')

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-vertical-slice-'))
  resources.stateDir = stateDir
  out(`GATE   fresh caller-owned state directory: ${stateDir}`)
  const bootstrapJson = JSON.stringify(BOOTSTRAP)
  const ledgerBefore = processLedger.length

  // -- Step 1: schema/bootstrap ------------------------------------------------
  const first = await startRunner(
    `runner-${journalMode}-first`, stateDir, journalMode, bootstrapJson,
    (child) => resources.children.add(child),
  )
  if (first.child.pid === undefined) throw new Error('runner process did not expose a PID')
  options.observeFirstRunner?.({ pid: first.child.pid, stateDir })
  if (options.failAfterFirstRunnerStart === true) {
    throw new Error('intentional acceptance cleanup probe failure after first runner start')
  }
  const socketPath = String(first.ready.socket)
  out('STEP 1 schema/bootstrap — runner readiness report (requested vs effective journal mode):')
  out(json(first.ready))

  const journalRequested = String(first.ready.journalRequested)
  const journalEffective = String(first.ready.journalEffective)
  assert(journalRequested === journalMode, 'runner reports the requested journal mode')
  assert(Number(first.ready.schemaVersion) === 1, 'runner reports SQLite schema version 1')
  if (journalMode === 'wal') assert(journalEffective === 'wal', 'WAL scenario reports effective journal mode wal')

  const mount = first.ready.mount as Record<string, unknown>
  assert(mount.local === true, 'state directory is on an established-local filesystem')
  assert(
    stateDir.startsWith(os.tmpdir()) && !stateDir.startsWith(process.cwd() + path.sep),
    'state directory lives outside the repository',
  )

  const dbPath = path.join(stateDir, 'runner.sqlite')
  const expectedUid = process.getuid?.()
  const dbStat = fs.lstatSync(dbPath)
  const dbMode = (dbStat.mode & 0o777).toString(8).padStart(4, '0')
  assert(dbMode === '0600', `database file is owner-only (mode ${dbMode})`)
  const dirStat = fs.lstatSync(stateDir)
  const dirMode = (dirStat.mode & 0o777).toString(8).padStart(4, '0')
  assert(dirMode === '0700', `state directory is owner-only (mode ${dirMode})`)
  const socketStat = fs.lstatSync(socketPath)
  const socketMode = (socketStat.mode & 0o777).toString(8).padStart(4, '0')
  assert(socketMode === '0600', `Unix socket is owner-only (mode ${socketMode})`)
  if (expectedUid !== undefined) {
    assert(dbStat.uid === expectedUid && dirStat.uid === expectedUid && socketStat.uid === expectedUid, 'state paths are owned by the current UID')
  }
  if (journalMode === 'wal') {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = dbPath + suffix
      assert(fs.existsSync(sidecar), `WAL sidecar ${path.basename(sidecar)} exists while the connection is open`)
      const sidecarStat = fs.lstatSync(sidecar)
      const sidecarMode = (sidecarStat.mode & 0o777).toString(8).padStart(4, '0')
      assert(sidecarMode === '0600', `WAL sidecar ${path.basename(sidecar)} is owner-only (mode ${sidecarMode})`)
      if (expectedUid !== undefined) assert(sidecarStat.uid === expectedUid, `${path.basename(sidecar)} is owned by the current UID`)
    }
  }
  out('STEP 1 filesystem and permission checks passed (database outside Git, owner-only files and socket).')
  out(json({ schemaVersion: first.ready.schemaVersion, uid: expectedUid ?? null, directoryMode: dirMode, databaseMode: dbMode, socketMode, mount }))
  const bootstrapSnapshot = await captureSnapshot(socketPath, 'step-1-bootstrap')
  assert(bootstrapSnapshot.cursor === 1, 'bootstrap snapshot has the initial durable cursor')

  // -- Step 2: all bridge handshakes -------------------------------------------
  const identities = new Map<Role, VisibleHostIdentity>(
    BOOTSTRAP.roles.map((entry) => [
      entry.role as Role,
      {
        teamGoalId: BOOTSTRAP.teamGoalId,
        role: entry.role as Role,
        agentRunId: entry.agentRunId,
        terminalSessionRef: entry.terminalSessionRef,
        piSessionId: entry.piSessionId,
        extensionInstanceId: entry.extensionInstanceId,
        hostPid: entry.hostPid,
        shellRunId: entry.shellRunId,
      },
    ]),
  )
  const coordinator = new FakeVisibleBridge(identities.get('coordinator')!, socketPath)
  const builder = new FakeVisibleBridge(identities.get('builder')!, socketPath)
  const reviewer = new FakeVisibleBridge(identities.get('reviewer')!, socketPath)
  await withTimeout(coordinator.connect(), 8000, 'coordinator handshake')
  await withTimeout(builder.connect(), 8000, 'builder handshake')
  await withTimeout(reviewer.connect(), 8000, 'reviewer handshake')
  out('STEP 2 all three fake visible-host bridges completed the real handshake over the owner-only Unix socket:')
  for (const fake of [coordinator, builder, reviewer]) {
    assert(fake.snapshot !== null, `${fake.role} received an authoritative snapshot after handshake`)
    const identity = identities.get(fake.role)!
    out(`  ${fake.role}: agentRunId=${identity.agentRunId} hostPid=${identity.hostPid} shellRunId=${identity.shellRunId}`)
    renderSnapshot(`handshake-${fake.role}`, fake.snapshot!)
  }
  assertSnapshotShape(builder.snapshot!, 'after handshakes')

  const beforeUnauthorizedBusy = await captureSnapshot(socketPath, 'before-wrong-role-busy-ack')
  coordinator.sendAssignmentAcknowledgement(BOOTSTRAP.assignment.id, 'busy')
  const busyError = await coordinator.waitForProtocolError(5000)
  assert(busyError.body.code === 'unauthorized_assignment_ack', 'wrong-role busy acknowledgement is rejected')
  coordinator.disconnect()
  const afterUnauthorizedBusy = await captureSnapshot(socketPath, 'after-wrong-role-busy-ack')
  assert(
    JSON.stringify(afterUnauthorizedBusy) === JSON.stringify(beforeUnauthorizedBusy),
    'wrong-role busy acknowledgement makes no durable state or event change',
  )
  await coordinator.connect()

  const beforeUnknownInvalid = await captureSnapshot(socketPath, 'before-unknown-invalid-ack')
  coordinator.sendAssignmentAcknowledgement('unknown-assignment', 'invalid')
  const invalidError = await coordinator.waitForProtocolError(5000)
  assert(invalidError.body.code === 'unauthorized_assignment_ack', 'unknown invalid acknowledgement is rejected')
  coordinator.disconnect()
  const afterUnknownInvalid = await captureSnapshot(socketPath, 'after-unknown-invalid-ack')
  assert(
    JSON.stringify(afterUnknownInvalid) === JSON.stringify(beforeUnknownInvalid),
    'unknown invalid acknowledgement makes no durable state or event change',
  )
  await coordinator.connect()
  out('STEP 2 assignment acknowledgement authorization rejects wrong-role/unknown busy and invalid statuses without durable change.')

  // -- Step 3: initial labels ----------------------------------------------------
  expectRoleStates(
    builder.snapshot!,
    { coordinator: 'waiting', builder: 'waiting', reviewer: 'waiting' },
    'initial labels',
  )
  out('STEP 3 initial labels verified: all three roles present both surfaces as waiting and mutually distinct.')
  renderSnapshot('step-3-initial-label-contract', builder.snapshot!)

  // -- Step 4: first assignment acceptance ---------------------------------------
  await withTimeout(builder.waitForAssignment(5000), 6000, 'initial Builder assignment delivery')
  const acceptedAck = await withTimeout(builder.waitForAck('accepted'), 6000, 'accepted acknowledgement')
  assert(acceptedAck.assignmentId === BOOTSTRAP.assignment.id, 'accepted acknowledgement names the prototype assignment')
  assert(builder.deliveredTurns === 1, `exactly one fake visible Builder turn occurred (got ${builder.deliveredTurns})`)
  await builder.waitForPresentationState('managed')
  out('STEP 4 first managed assignment accepted through the visible-bridge boundary:')
  out(json({ ack: acceptedAck, fakeVisibleTurns: builder.deliveredTurns, presentationUpdate: builder.presentationUpdate }))
  const builderUpdate = builder.presentationUpdate
  assert(
    builderUpdate !== null &&
      builderUpdate.nativeTerminalTitle === `Omarchestra — Builder — managed` &&
      builderUpdate.piStatus === `Builder · managed`,
    'Builder labels update to managed after assignment acceptance',
  )
  assert(
    coordinator.presentationUpdate !== null && coordinator.presentationUpdate.piStatus === 'Coordinator · waiting' &&
      reviewer.presentationUpdate !== null && reviewer.presentationUpdate.piStatus === 'Reviewer · waiting',
    'Coordinator and Reviewer labels remain waiting through the Builder assignment',
  )
  const acceptedSnapshot = await captureSnapshot(socketPath, 'step-4-assignment-accepted')
  assert(roleProjectionOf(acceptedSnapshot, 'builder').assignmentState === 'active', 'accepted assignment is durable')

  // -- Step 5: Builder reconnect under management replays without a second turn ----
  builder.disconnect()
  await withTimeout(sleep(100), 200, 'disconnect settle')
  await withTimeout(builder.connect(), 8000, 'builder managed reconnect')
  await withTimeout(builder.waitForAssignment(5000), 6000, 'assignment replay on managed reconnect')
  const duplicateAck = await withTimeout(builder.waitForAck('duplicate'), 6000, 'duplicate acknowledgement')
  assert(duplicateAck.assignmentId === BOOTSTRAP.assignment.id, 'replay acknowledged the same stable assignment id')
  assert(builder.deliveredTurns === 1, `replay must not create a second turn (turns=${builder.deliveredTurns})`)
  out('STEP 5 Builder reconnect under management caused replay; the duplicate was suppressed:')
  out(json({ ack: duplicateAck, fakeVisibleTurns: builder.deliveredTurns, snapshot: builder.snapshot }))
  const assignmentsBeforeTakeover = builder.receivedFrames.filter((frame) => frame.type === 'assignment').length
  assert(
    assignmentsBeforeTakeover === 2,
    `assignment delivered exactly twice before takeover (initial + one replay); got ${assignmentsBeforeTakeover}`,
  )
  const beforeTakeoverSnapshot = await captureSnapshot(socketPath, 'step-5-duplicate-suppressed')
  assert(beforeTakeoverSnapshot.assignment?.lastAckStatus === 'duplicate', 'duplicate acknowledgement is durable')

  // -- Step 6: Builder-only manual takeover ------------------------------------------
  const coordinatorUpdateBeforeTakeover = JSON.stringify(coordinator.presentationUpdate)
  const reviewerUpdateBeforeTakeover = JSON.stringify(reviewer.presentationUpdate)
  const coordinatorProjectionBeforeTakeover = JSON.stringify(roleProjectionOf(beforeTakeoverSnapshot, 'coordinator'))
  const reviewerProjectionBeforeTakeover = JSON.stringify(roleProjectionOf(beforeTakeoverSnapshot, 'reviewer'))
  builder.submitInteractiveInput('Manual takeover probe (prototype)')
  await builder.waitForPresentationState('manual_takeover')
  const builderUpdateAfterTakeover = builder.presentationUpdate
  assert(
    builderUpdateAfterTakeover !== null &&
      builderUpdateAfterTakeover.nativeTerminalTitle === `Omarchestra — Builder — manual_takeover` &&
      builderUpdateAfterTakeover.piStatus === `Builder · manual_takeover`,
    'both Builder label surfaces update to manual_takeover',
  )
  await coordinator.waitForQuiet(200)
  await reviewer.waitForQuiet(200)
  assert(
    JSON.stringify(coordinator.presentationUpdate) === coordinatorUpdateBeforeTakeover,
    'Coordinator presentation projection is byte-identical across the Builder takeover',
  )
  assert(
    JSON.stringify(reviewer.presentationUpdate) === reviewerUpdateBeforeTakeover,
    'Reviewer presentation projection is byte-identical across the Builder takeover',
  )
  const afterTakeoverSnapshot = await captureSnapshot(socketPath, 'step-6-builder-takeover')
  assert(
    JSON.stringify(roleProjectionOf(afterTakeoverSnapshot, 'coordinator')) === coordinatorProjectionBeforeTakeover,
    'complete Coordinator projection is byte-identical across Builder takeover',
  )
  assert(
    JSON.stringify(roleProjectionOf(afterTakeoverSnapshot, 'reviewer')) === reviewerProjectionBeforeTakeover,
    'complete Reviewer projection is byte-identical across Builder takeover',
  )
  out('STEP 6 Builder-only manual takeover (both Builder surfaces update; Coordinator and Reviewer byte-identical):')
  out(json({ builderPresentationUpdate: builderUpdateAfterTakeover }))
  renderSnapshot('step-6-complete-state', afterTakeoverSnapshot)

  // -- Step 7: projection client saves its cursor and disconnects ----------------------
  const projection = new ThinProjectionClient(BOOTSTRAP.teamGoalId, 'console-fixture', socketPath)
  await withTimeout(projection.connect(null), 8000, 'projection baseline connect')
  const savedCursor = projection.cursor
  assert(savedCursor !== null && savedCursor > 0, 'projection captured a durable cursor')
  const preStopSnapshot = projection.snapshot
  assert(preStopSnapshot !== null, 'pre-stop authoritative snapshot captured')
  const builderDurable = roleProjectionOf(preStopSnapshot, 'builder')
  assert(builderDurable.controlMode === 'manual_takeover', 'durable Builder control mode is manual_takeover')
  assert(builderDurable.assignmentState === 'needs_reconciliation', 'durable Builder assignment became needs_reconciliation')
  assert(
    roleProjectionOf(preStopSnapshot, 'coordinator').controlMode === 'managed' &&
      roleProjectionOf(preStopSnapshot, 'reviewer').controlMode === 'managed',
    'Coordinator and Reviewer control modes unchanged by the Builder takeover',
  )
  out(`STEP 7 thin projection client captured durable cursor ${savedCursor} and disconnected.`)
  out(json({ savedCursor, snapshot: preStopSnapshot }))
  projection.disconnect()

  // -- Step 8: stop only the exact runner process ----------------------------------------
  await stopRunner(`runner-${journalMode}-first`, first)
  resources.children.delete(first.child)
  out(`STEP 8 runner stopped cleanly; durable state remains in ${stateDir}`)
  renderSnapshot('step-8-last-committed-state', preStopSnapshot)
  out(json({ databasePath: dbPath, databaseExists: fs.existsSync(dbPath), stateDirectoryMode: dirMode, databaseMode: dbMode }))

  // -- Step 9: recreate the runner over the same scratch database --------------------------
  assert(processLedger.length - ledgerBefore === 1, 'process ledger holds exactly one runner invocation so far')
  const second = await startRunner(
    `runner-${journalMode}-restart`, stateDir, journalMode, bootstrapJson,
    (child) => resources.children.add(child),
  )
  out('STEP 9 runner recreated over the same scratch database:')
  out(json(second.ready))
  assert(String(second.ready.journalEffective) === journalEffective, 'effective journal mode is stable across restart')
  assert(String(second.ready.socket) === socketPath, 'recreated runner serves the same socket path')
  const recoveredBeforeReconnect = await captureSnapshot(socketPath, 'step-9-recovered-before-bridge-reconnect')
  assert(roleProjectionOf(recoveredBeforeReconnect, 'builder').controlMode === 'manual_takeover', 'takeover recovered before bridges reconnect')

  // -- Step 10: projection resumes before bridge reconnects -------------------------------
  const resumed = new ThinProjectionClient(BOOTSTRAP.teamGoalId, 'console-fixture', socketPath)
  await withTimeout(resumed.connect(savedCursor), 8000, 'projection resume connect')
  assert(resumed.snapshot !== null, 'resumed projection received an authoritative snapshot')
  assert(
    JSON.stringify(resumed.events.map((event) => event.sequence)) === JSON.stringify([savedCursor! + 1]),
    'resume page contains exactly the runner restart event after the saved cursor',
  )
  out(`STEP 10 projection resumed after saved cursor ${savedCursor} before bridge reconnects:`)
  out(json({ resumeAfter: savedCursor, resumedEvents: resumed.events, snapshot: resumed.snapshot }))

  // -- Step 11: the same fake bridge identities reconnect and stream live -----------------
  await withTimeout(coordinator.connect(), 8000, 'coordinator reconnect')
  await withTimeout(builder.connect(), 8000, 'builder reconnect under manual takeover')
  await withTimeout(reviewer.connect(), 8000, 'reviewer reconnect')
  const builderAfterRestart = roleProjectionOf(builder.snapshot!, 'builder')
  assert(builderAfterRestart.controlMode === 'manual_takeover', 'Builder reconnects in manual takeover')
  assert(builderAfterRestart.assignmentState === 'needs_reconciliation', 'needs_reconciliation survived the restart')
  assertLabelsContain(builder.snapshot!, 'builder', 'manual_takeover', 'labels after restart')
  await builder.waitForQuiet(300)
  const postReconnectAssignments = builder.receivedFrames.filter((frame) => frame.type === 'assignment').length
  assert(
    postReconnectAssignments === 2,
    `no assignment was dispatched to the manual_takeover Builder after restart (assignments seen: ${postReconnectAssignments})`,
  )
  await withTimeout(resumed.waitForEventCount(4, 8000), 9000, 'streamed reconnect events for the resumed projection')
  const resumeSequences = resumed.events.map((event) => event.sequence)
  assert(
    JSON.stringify(resumeSequences) === JSON.stringify([savedCursor! + 1, savedCursor! + 2, savedCursor! + 3, savedCursor! + 4]),
    'resume page followed by three live bridge events in strict sequence',
  )
  const liveSequences = resumed.frames
    .filter((frame) => frame.type === 'event')
    .map((frame) => Number(frame.body.sequence))
  assert(
    JSON.stringify(liveSequences) === JSON.stringify([savedCursor! + 2, savedCursor! + 3, savedCursor! + 4]),
    'bridge reconnects are delivered as live event frames after the snapshot',
  )
  assert(resumed.cursor === savedCursor! + 4, 'thin client advances its durable cursor through live events')
  out('STEP 11 same identity tuples reconnected; bindings and labels survived; reconnect events streamed live:')
  out(json({ builder: builderAfterRestart, snapshot: builder.snapshot, resumeSequences, liveSequences }))
  const reconnectSnapshot = await captureSnapshot(socketPath, 'step-11-complete-reconnected-state')

  // -- Step 12: final state and the complete durable event list ---------------------------------
  const replay = new ThinProjectionClient(BOOTSTRAP.teamGoalId, 'replay-fixture', socketPath)
  await withTimeout(replay.connect(0), 8000, 'full replay connect')
  const finalSnapshot = replay.snapshot
  assert(finalSnapshot !== null, 'final authoritative snapshot captured')
  assertSnapshotShape(finalSnapshot, 'final state')
  const allEvents = replay.events
  assertEventsOrdered(allEvents, finalSnapshot.cursor, 'final event list')
  expectRoleStates(
    finalSnapshot,
    { coordinator: 'waiting', builder: 'manual_takeover', reviewer: 'waiting' },
    'final role states',
  )
  out('STEP 12 final durable state and complete ordered event list (replayed from cursor 0):')
  renderSnapshot('final', finalSnapshot)
  out('--- EVENT LIST (durable, ordered) ---')
  out(json(allEvents))

  // Durable comparison: goal, bindings, assignment, takeover, labels survived.
  assert(finalSnapshot.teamGoal.id === preStopSnapshot.teamGoal.id, 'Team Goal id survived')
  assert(finalSnapshot.teamGoal.goalText === preStopSnapshot.teamGoal.goalText, 'Team Goal text survived')
  for (const role of finalSnapshot.roles) {
    const before = preStopSnapshot.roles.find((candidate) => candidate.role === role.role)
    assert(before !== undefined, `binding for ${role.role} survived`)
    assert(
      JSON.stringify(before) === JSON.stringify(role),
      `role ${role.role} binding, control mode, labels, and assignment state survived exactly`,
    )
  }
  assert(
    finalSnapshot.assignment !== null &&
      preStopSnapshot.assignment !== null &&
      finalSnapshot.assignment.id === preStopSnapshot.assignment.id &&
      finalSnapshot.assignment.state === preStopSnapshot.assignment.state &&
      finalSnapshot.assignment.lastAckStatus === preStopSnapshot.assignment.lastAckStatus,
    'assignment identity, needs_reconciliation state, and last acknowledgement survived',
  )
  assert(finalSnapshot.cursor >= preStopSnapshot.cursor, 'durable cursor advanced monotonically across restart')
  assert(reconnectSnapshot.cursor === finalSnapshot.cursor, 'complete reconnect snapshot agrees with final durable cursor')

  // -- Cleanup: stop the second runner and remove the temporary state directory ----
  await stopRunner(`runner-${journalMode}-restart`, second)
  resources.children.delete(second.child)
  assert(processLedger.length - ledgerBefore === 2, 'process ledger holds exactly two runner invocations')
  fs.rmSync(stateDir, { recursive: true, force: true })
  resources.stateDir = null
  assert(!fs.existsSync(stateDir), 'temporary state directory removed')
  out(`SCENARIO journal=${journalMode}: PASS (both runner launches recorded; temporary state wiped)`)
}

// (helper removed: delivery-count assertions are inline)

// ---------------------------------------------------------------------------
// Gate orchestration
// ---------------------------------------------------------------------------

async function runFailureCleanupProbe(): Promise<void> {
  let observed: { pid: number; stateDir: string } | null = null
  let failed = false
  try {
    await runScenario('default', {
      failAfterFirstRunnerStart: true,
      observeFirstRunner: (resource) => { observed = resource },
    })
  } catch (error) {
    failed = error instanceof Error && error.message.includes('intentional acceptance cleanup probe failure')
  }
  assert(failed, 'failure cleanup probe reached the intentional post-start failure')
  assert(observed !== null, 'failure cleanup probe captured its exact runner identity')
  const resource = observed as { pid: number; stateDir: string }
  assert(!fs.existsSync(`/proc/${resource.pid}`), 'failed scenario left no runner process')
  assert(!fs.existsSync(resource.stateDir), 'failed scenario removed its exact scratch directory')
  out('AUDIT  failed-scenario-cleanup: PASS (exact runner and scratch directory absent)')
}

async function main(): Promise<void> {
  out('OMARCHESTRA FIRST VERTICAL SLICE — PROTOTYPE, NOT PRODUCTION')
  out(`node ${process.version}, platform ${process.platform}`)
  const [major, minor] = process.versions.node.split('.').map(Number)
  assert(major > 22 || (major === 22 && minor >= 6), 'installed Node meets the >=22.6.0 runtime floor')

  runSourceAudits()
  await runModuleLinkCheck()
  runProtocolNegativeChecks()
  await runSshStdioSeamCheck()
  await runDomainSafetyNegativeChecks()
  await runFailureCleanupProbe()

  await runScenario('default')
  await runScenario('wal')

  out('')
  out('======================================================================')
  out('VERDICT')
  out('======================================================================')
  out('Automated gate result: PASS — verdict "supported with constraints".')
  out('')
  out('Supported by this fake-only evidence:')
  out('- TypeScript/Node foreground runner with SQLite schema versioning, explicit')
  out('  immediate transactions, and owner-only scratch state outside the repository;')
  out('- strict bounded versioned NDJSON over an owner-only Unix socket with identity')
  out('  handshake, snapshot, ordered durable events, acknowledgement/deduplication,')
  out('  and reconnect; an SSH-stdio seam exists as an injected-stream interface only;')
  out('- three fixed roles with persistent native-title and Pi-status labels derived')
  out('  from durable state and updated only after the owning transaction commits;')
  out('- one managed Builder assignment with replay suppression (no second turn);')
  out('- Builder-only manual takeover switching assignment state to needs_reconciliation')
  out('  while Coordinator and Reviewer projections remain byte-identical;')
  out('- runner stop/recreate over the same scratch database with the same bridge')
  out('  identities reconnecting and the thin projection resuming from its cursor;')
  out('- a QML-facing thin client that receives snapshots/events only and cannot')
  out('  mutate storage; no hidden agent process is created or required.')
  out('')
  out('Remaining constraints (explicitly unresolved here):')
  out('- fake presentation adapters do not prove real Pi title/status rendering;')
  out('- the SSH-stdio transport is an interface with fake streams only;')
  out('- journal mode stays undecided: default and WAL were both measured, none ranked;')
  out('- same-user Unix-socket permissions are the only prototype trust boundary;')
  out('- recovery is proven only for runner restart with surviving bridge identities;')
  out('- migrations beyond version 1, retention, cancellation, reconciliation, and the')
  out('  full workflow are out of scope for this slice;')
  out('- local-filesystem detection is best-effort (known network/FUSE mounts are')
  out('  rejected; locality is not proven).')
  out('')
  out('Every runner invocation in the process ledger:')
  out(json(processLedger))
  out('')
  out('ACCEPTANCE GATE COMPLETE')
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error) => {
    out(`GATE FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
}