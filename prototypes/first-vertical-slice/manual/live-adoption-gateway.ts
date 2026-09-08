/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * manual/live-adoption-gateway.ts — the foreground, human-only Adoption
 * gateway. It wires the owner-only Unix socket to the LiveAdoptionGatewayCore
 * and the durable Adoption store, registers observed sessions, and routes
 * `adoption.ack` to the runner. Controls are bounded to status and quit. This
 * entrypoint does not launch Pi, dispatch work, or mutate an installation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import readline from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'

import {
  LiveAdoptionGatewayCore,
  type GatewaySession,
} from '../observer/live-adoption-gateway-core.ts'
import {
  LiveAdoptionRunner,
} from '../observer/live-adoption-runner.ts'
import { LiveAdoptionStore } from './live-adoption-store.ts'
import { AdoptionRuntimeOwnership } from './adoption-owned-database.ts'
import { LiveAdoptionPresentation } from '../observer/live-adoption-presentation.ts'
import { ADOPTION_COMPANION_RELEASE } from '../companion/releases.ts'
import { createLiveCompanionPorts, captureLiveInstallationFingerprint, DirectLiveCommandPort } from './live-companion-omarchy.ts'
import {
  LiveFrameChannel,
  type DuplexStream,
} from '../observer/live-frame-channel.ts'
import {
  ObserverUnixSocketServer,
} from './live-observer-transport.ts'
import { ROLES, type Role } from '../src/protocol.ts'
import type { AdoptionClock } from '../observer/adoption.ts'

const MAX_CONTROL_LINE_CHARACTERS = 64
const DEFAULT_EXECUTION_NODE_ID = 'adoption-gateway-local'
const DEFAULT_TEAM_GOAL_ID = 'adoption-team-goal-local'
export const ADOPTION_LIVE_AUTHORIZATION_PHRASE = 'I AUTHORIZE OMARCHESTRA ADOPTION LIVE BRIDGE'

export interface LiveAdoptionGatewayRunOptions {
  resume?: boolean
  socketPath: string
  socketIdentityFile?: string
  databaseIdentityFile?: string
  executionNodeId?: string
  teamGoalId?: string
  roles?: Role[]
  input?: Readable
  output?: Writable
}

export interface LiveAdoptionGatewayStatus {
  state: 'running' | 'stopping'
  commitCount: number
  observedSessions: number
}

/** Process-local monotonic clock so live proposals and acknowledgements expire. */
export class ProcessMonotonicAdoptionClock implements AdoptionClock {
  private readonly startedAt = performance.now()

  now(): number {
    return Math.max(0, Math.floor(performance.now() - this.startedAt))
  }
}

/**
 * Run one foreground Adoption gateway until its bounded control input requests
 * quit. The function accepts streams and ports for fake-only tests; the CLI
 * wrapper below enforces the interactive TTY and exact authorization phrase.
 */
export async function runLiveAdoptionGateway(options: LiveAdoptionGatewayRunOptions): Promise<void> {
  assertInteractiveTTY()
  await requestAuthorization()
  const executionNodeId = options.executionNodeId ?? DEFAULT_EXECUTION_NODE_ID
  const teamGoalId = options.teamGoalId ?? DEFAULT_TEAM_GOAL_ID
  const roles = options.roles ?? (['coordinator', 'builder', 'reviewer'] as Role[])

  const databasePath = path.join(path.dirname(options.socketPath), 'adoption.sqlite')
  if (options.resume && (!options.databaseIdentityFile || !options.socketIdentityFile)) throw new Error('resume requires the original ownership evidence files')
  const ownedDatabase = new AdoptionRuntimeOwnership(databasePath,
    options.resume ? readOwnedEvidence(options.databaseIdentityFile!) : undefined)
  let store: LiveAdoptionStore | undefined
  let presentation: LiveAdoptionPresentation | undefined
  let server: ObserverUnixSocketServer | undefined
  let released = false
  try {
  if (options.resume) removeRecoveredSocket(options.socketPath, readOwnedEvidence(options.socketIdentityFile!))
  if (options.databaseIdentityFile !== undefined && !options.resume) {
    writeOwnedEvidence(options.databaseIdentityFile, ownedDatabase.manifest())
  }
  store = new LiveAdoptionStore({
    databasePath,
    executionNodeId,
    teamGoalId,
    roles,
  })
  const clock = new ProcessMonotonicAdoptionClock()
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId,
    teamGoalId,
    roles,
    clock,
  })
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId,
    teamGoalId,
    roles,
    runner,
    clock,
  })

  const command = new DirectLiveCommandPort()
  const ports = createLiveCompanionPorts({ command, release: ADOPTION_COMPANION_RELEASE })
  ports.shell.capabilities(ADOPTION_COMPANION_RELEASE.pluginId)
  presentation = new LiveAdoptionPresentation({ runner, executionNodeId, teamGoalId, roles,
    shell: {
      async fingerprint() { return captureLiveInstallationFingerprint(ports) },
      async call(method, payload) {
        const response = command.run(['omarchy-shell', 'shell', 'call', ADOPTION_COMPANION_RELEASE.pluginId, method, payload])
        if (response.status !== 0) throw new Error('Companion Adoption IPC failed')
        return response.stdout.trim()
      },
    },
  })
  await presentation.open()
  server = new ObserverUnixSocketServer(options.socketPath, (socket) => {
    let session: GatewaySession
    const channel = new LiveFrameChannel(socket as unknown as DuplexStream, {
      onFrame: (frame) => { void session.handleFrame(frame).catch(() => channel.close()) },
      onClose: (error) => session?.transportClosed(error ?? null),
    })
    session = gateway.accept(channel)
  })

  try {
    await server.start()
    if (options.socketIdentityFile !== undefined) {
      const identity = server.identity
      if (identity === null) throw new Error('Adoption socket identity was not captured')
      writeSocketIdentity(options.socketIdentityFile, identity)
    }
  } catch (error) {
    try {
      await server.close()
    } catch {
      // Preserve the startup failure.
    }
    throw error
  }

  let polling: Promise<void> | null = null
  let presentationError: unknown = null
  const timer = setInterval(() => {
    gateway.sweep()
    if (polling || presentationError) return
    polling = presentation.poll().catch(error => {
      presentationError = error
      runner.onConnectionLost()
      void server!.close().catch(() => {})
    }).finally(() => { polling = null })
  }, 250)
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  let cleanupError: Error | null = null
  let acceptanceVerified = false
  try {
    writeControl(output, `Adoption gateway listening on ${server.path}`)
    writeControl(output, 'controls: status | quit')
    for await (const control of boundedControlLines(input)) {
      if (control.tooLong) {
        writeControl(output, 'control rejected: line exceeds the bounded length')
        continue
      }
      const line = control.value.trim()
      if (line === 'status') {
        writeControl(output, JSON.stringify(status(gateway, runner)))
        continue
      }
      if (line === 'quit') {
        const facts = runner.acceptanceFacts()
        acceptanceVerified = Object.values(facts).every(value => value === true)
        writeControl(output, JSON.stringify({ acceptanceFacts: facts }))
        writeControl(output, JSON.stringify({ ...status(gateway, runner), state: 'stopping' }))
        break
      }
      writeControl(output, 'control rejected: use status or quit')
    }
  } finally {
    released = true
    clearInterval(timer)
    await polling
    try { await presentation.close() } catch (error) { cleanupError = asError(error) }
    try {
      await server.close()
    } catch (error) {
      cleanupError = asError(error)
    }
    try { store.close() } catch (error) { cleanupError = asError(error) }
    // Verify the database identity captured at creation, then
    // remove only those exact files. A substituted file or symlink is never
    // removed and is reported as a cleanup failure.
    try {
      ownedDatabase.remove()
    } catch (error) {
      cleanupError = asError(error)
    }
  }
  if (presentationError !== null) throw asError(presentationError)
  if (cleanupError !== null) throw cleanupError
  if (!acceptanceVerified) throw new Error('Adoption acceptance incomplete: commit, readiness, takeover and pre-cleanup disconnect are required')
  } catch (error) {
    const failures: unknown[] = [error]
    if (!released) {
      for (const cleanup of [() => server?.close(), () => presentation?.close(),
        () => store?.close(), () => options.resume ? ownedDatabase.close() : ownedDatabase.remove()]) {
        try { await cleanup() } catch (failure) { failures.push(failure) }
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Adoption failed and exact cleanup was incomplete')
    throw error
  }
}

function status(
  gateway: LiveAdoptionGatewayCore,
  runner: LiveAdoptionRunner,
): LiveAdoptionGatewayStatus {
  return {
    state: 'running',
    commitCount: gateway.commitCount,
    observedSessions: runner.snapshot().agents.length,
  }
}

interface BoundedControlLine {
  value: string
  tooLong: boolean
}

async function* boundedControlLines(input: Readable): AsyncGenerator<BoundedControlLine> {
  let line = ''
  let tooLong = false
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const complete = newline !== -1
      const end = complete ? newline : text.length
      const segment = text.slice(start, end)
      if (tooLong) {
        if (complete) {
          yield { value: '', tooLong: true }
          tooLong = false
        }
      } else {
        if (line.length + segment.length > MAX_CONTROL_LINE_CHARACTERS) {
          line = ''
          tooLong = true
        } else {
          line += segment
        }
        if (complete) {
          yield { value: line, tooLong }
          line = ''
          tooLong = false
        }
      }
      if (!complete) break
      start = newline + 1
    }
  }
  if (line.length > 0) yield { value: line, tooLong }
}

function writeControl(output: Writable, line: string): void {
  output.write(`${line}\n`)
}

function writeSocketIdentity(filePath: string, identity: { device: bigint; inode: bigint }): void {
  const encoded = `${identity.device.toString()}:${identity.inode.toString()}\n`
  if (Buffer.byteLength(encoded, 'utf8') > 128) throw new Error('Adoption socket identity exceeded its bound')
  writeOwnedEvidence(filePath, encoded)
}

function evidenceDescriptor(file: string, writable: boolean): number {
  const parent = fs.lstatSync(path.dirname(file))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!()
      || (parent.mode & 0o077) !== 0 || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('unsafe evidence directory')
  const fd = fs.openSync(file, fs.constants.O_NOFOLLOW | (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY))
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 4096) {
    fs.closeSync(fd)
    throw new Error('unsafe ownership evidence file')
  }
  return fd
}

function readOwnedEvidence(file: string): string {
  const fd = evidenceDescriptor(file, false)
  try { return fs.readFileSync(fd, 'utf8') } finally { fs.closeSync(fd) }
}

function writeOwnedEvidence(file: string, value: string): void {
  if (Buffer.byteLength(value) > 4096) throw new Error('ownership evidence exceeds bound')
  const fd = evidenceDescriptor(file, true)
  try { fs.ftruncateSync(fd); fs.writeFileSync(fd, value); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function removeRecoveredSocket(socket: string, expected: string): void {
  if (!/^[0-9]+:[0-9]+$/.test(expected.trim())) throw new Error('invalid original socket identity')
  let stat: fs.BigIntStats
  try { stat = fs.lstatSync(socket, { bigint:true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!stat.isSocket() || stat.isSymbolicLink() || `${stat.dev}:${stat.ino}` !== expected.trim()) throw new Error('recovery socket identity changed')
  fs.unlinkSync(socket)
}

function assertInteractiveTTY(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('live Adoption gateway requires an interactive TTY on stdin and stdout')
  }
}

interface CliOptions {
  resume: boolean
  live: boolean
  socketPath: string
  socketIdentityFile?: string
  databaseIdentityFile?: string
  executionNodeId: string
  teamGoalId: string
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let live = false
  let resume = false
  let socketPath: string | undefined
  let socketIdentityFile: string | undefined
  let databaseIdentityFile: string | undefined
  let executionNodeId = DEFAULT_EXECUTION_NODE_ID
  let teamGoalId = DEFAULT_TEAM_GOAL_ID
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--resume') { resume = true; continue }
    if (argument === '--live') {
      live = true
      continue
    }
    if (argument === '--socket') {
      socketPath = args[++index]
      continue
    }
    if (argument === '--socket-identity-file') {
      socketIdentityFile = args[++index]
      continue
    }
    if (argument === '--database-identity-file') {
      databaseIdentityFile = args[++index]
      continue
    }
    if (argument === '--execution-node-id') {
      executionNodeId = args[++index] ?? ''
      continue
    }
    if (argument === '--team-goal-id') {
      teamGoalId = args[++index] ?? ''
      continue
    }
    throw new Error(`unknown Adoption gateway option ${String(argument)}`)
  }
  if (!live) throw new Error('Adoption gateway requires the explicit --live flag')
  if (socketPath === undefined || !path.isAbsolute(socketPath)) {
    throw new Error('--socket must be an absolute Unix-socket path')
  }
  if (socketIdentityFile !== undefined && !path.isAbsolute(socketIdentityFile)) {
    throw new Error('--socket-identity-file must be an absolute path')
  }
  if (databaseIdentityFile !== undefined && !path.isAbsolute(databaseIdentityFile)) {
    throw new Error('--database-identity-file must be an absolute path')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionNodeId)) {
    throw new Error('--execution-node-id must be a bounded ASCII identity')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(teamGoalId)) {
    throw new Error('--team-goal-id must be a bounded ASCII identity')
  }
  return { resume, live, socketPath, socketIdentityFile, databaseIdentityFile, executionNodeId, teamGoalId }
}

async function requestAuthorization(): Promise<void> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type exactly ${ADOPTION_LIVE_AUTHORIZATION_PHRASE}\n> `)
    if (answer !== ADOPTION_LIVE_AUTHORIZATION_PHRASE) {
      throw new Error('Adoption live authorization phrase did not match exactly')
    }
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--check') {
    if (args.length !== 1) throw new Error('--check does not accept additional arguments')
    console.log('Adoption gateway entrypoint check: PASS (no live resources opened)')
    return
  }
  assertInteractiveTTY()
  const options = parseCliOptions(args)
  await runLiveAdoptionGateway({
    resume: options.resume,
    socketPath: options.socketPath,
    socketIdentityFile: options.socketIdentityFile,
    databaseIdentityFile: options.databaseIdentityFile,
    executionNodeId: options.executionNodeId,
    teamGoalId: options.teamGoalId,
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1])
const modulePath = path.resolve(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  main().catch((error) => {
    const detail = asError(error).message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024)
    console.error(`Adoption gateway failed: ${detail}`)
    process.exitCode = 1
  })
}
