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
} from '../observer/live-adoption-gateway-core.ts'
import {
  LiveAdoptionRunner,
  type ObservedRecord,
} from '../observer/live-adoption-runner.ts'
import { LiveAdoptionStore } from './live-adoption-store.ts'
import {
  LiveFrameChannel,
  type DuplexStream,
} from '../observer/live-frame-channel.ts'
import {
  ObserverUnixSocketServer,
} from './live-observer-transport.ts'
import { ROLES, type Role } from '../src/protocol.ts'
import type { AdoptionClock } from '../observer/adoption.ts'
import {
  AgentRegistry,
  type RegistryCapabilityIssuer,
  type RegistryClock,
  type RegistryPersistence,
} from '../observer/registry.ts'

const MAX_CONTROL_LINE_CHARACTERS = 64
const DEFAULT_EXECUTION_NODE_ID = 'adoption-gateway-local'
const DEFAULT_TEAM_GOAL_ID = 'adoption-team-goal-local'
export const ADOPTION_LIVE_AUTHORIZATION_PHRASE = 'I AUTHORIZE OMARCHESTRA ADOPTION LIVE BRIDGE'

export interface LiveAdoptionGatewayRunOptions {
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
  // Independent closure review found missing authority and recovery wiring.
  // Keep this resource boundary closed until the required fake integration passes.
  throw new Error('live_adoption_incomplete: Companion, lifecycle, recovery and managed bridge integration remain blocked')
  const executionNodeId = options.executionNodeId ?? DEFAULT_EXECUTION_NODE_ID
  const teamGoalId = options.teamGoalId ?? DEFAULT_TEAM_GOAL_ID
  const roles = options.roles ?? (['coordinator', 'builder', 'reviewer'] as Role[])

  const store = new LiveAdoptionStore({
    databasePath: path.join(path.dirname(options.socketPath), 'adoption.sqlite'),
    executionNodeId,
    teamGoalId,
    roles,
  })
  const databasePath = path.join(path.dirname(options.socketPath), 'adoption.sqlite')
  const runner = new LiveAdoptionRunner({
    store,
    executionNodeId,
    teamGoalId,
    roles,
    clock: new ProcessMonotonicAdoptionClock(),
  })
  const registry = new AgentRegistry({
    clock: new ProcessMonotonicAdoptionClock(),
    persistence: new InMemoryPersistence(),
    capabilityIssuer: defaultCapabilityIssuer(),
    executionNodeId,
  })
  const gateway = new LiveAdoptionGatewayCore({
    executionNodeId,
    teamGoalId,
    roles,
    runner,
  })

  const server = new ObserverUnixSocketServer(options.socketPath, (socket) => {
    const channel = new LiveFrameChannel(socket as unknown as DuplexStream, {
      onFrame: (frame) => handleFrame(gateway, runner, registry, channel, frame),
      onClose: () => {},
    })
    void channel
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

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  let cleanupError: Error | null = null
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
        writeControl(output, JSON.stringify({ ...status(gateway, runner), state: 'stopping' }))
        break
      }
      writeControl(output, 'control rejected: use status or quit')
    }
  } finally {
    try {
      await server.close()
    } catch (error) {
      cleanupError = asError(error)
    }
    store.close()
    // Capture and verify the exact owned database/sidecar identities, then
    // remove only those exact files. A substituted file or symlink is never
    // removed and is reported as a cleanup failure.
    try {
      removeDatabaseExact(databasePath, options.databaseIdentityFile)
    } catch (error) {
      cleanupError = asError(error)
    }
  }
  if (cleanupError !== null) throw cleanupError
}

function handleFrame(
  gateway: LiveAdoptionGatewayCore,
  runner: LiveAdoptionRunner,
  registry: AgentRegistry,
  channel: LiveFrameChannel,
  frame: { type: string; messageId: string; body: Record<string, unknown> },
): void {
  if (frame.type === 'observer.register') {
    const envelope = registry.register(channel, frame.body)
    const body = frame.body as Record<string, unknown>
    const record: ObservedRecord = {
      observedSessionId: String(envelope.observedSessionId),
      executionNodeId: String(envelope.executionNodeId),
      processIncarnationId: String(body.processIncarnationId),
      piSessionId: String(body.piSessionId),
      extensionInstanceId: String(body.extensionInstanceId),
      connectionId: String(envelope.connectionId),
      connectionChallenge: String(envelope.connectionChallenge),
      registryRevision: Number(envelope.registryRevision),
      lifecycle: 'running',
      activity: 'idle',
      availability: 'available',
      health: 'healthy',
      piStatus: 'Unassigned · observed',
      acceptedSourceSequence: Number(envelope.acceptedSourceSequence),
    }
    runner.registerObserved(record, channel)
    channel.send('observer.registered', `gateway-${nextMessageId()}`, envelope)
    return
  }
  if (frame.type === 'observer.heartbeat' || frame.type === 'observer.lifecycle') {
    const record = registry.heartbeat(channel, frame.body)
    runner.updateObserved(recordToObserved(record))
    return
  }
  if (frame.type === 'observer.close') {
    const record = registry.close(channel, frame.body)
    if (record !== null) runner.updateObserved(recordToObserved(record))
    return
  }
  if (frame.type === 'adoption.ack') {
    void gateway.accept(channel).handleFrame(frame).catch(() => {
      // A rejected acknowledgement leaves the session observed/unassigned.
    })
    return
  }
}

function recordToObserved(record: Record<string, unknown>): ObservedRecord {
  return {
    observedSessionId: String(record.observedSessionId),
    executionNodeId: String(record.executionNodeId),
    processIncarnationId: String(record.processIncarnationId),
    piSessionId: String(record.piSessionId),
    extensionInstanceId: String(record.extensionInstanceId),
    connectionId: String(record.connectionId),
    connectionChallenge: String(record.connectionChallenge),
    registryRevision: Number(record.registryRevision),
    lifecycle: String(record.lifecycle) as ObservedRecord['lifecycle'],
    activity: String(record.activity) as ObservedRecord['activity'],
    availability: String(record.availability) as ObservedRecord['availability'],
    health: String(record.health) as ObservedRecord['health'],
    piStatus: 'Unassigned · observed',
    acceptedSourceSequence: Number(record.acceptedSourceSequence ?? record.lastSourceSequence ?? 0),
  }
}

class InMemoryPersistence implements RegistryPersistence {
  private state: unknown | null = null
  load(): unknown | null {
    return this.state
  }
  save(value: unknown): void {
    this.state = value
  }
}

function defaultCapabilityIssuer(): RegistryCapabilityIssuer {
  return {
    issue(purpose: 'observed' | 'connection' | 'challenge'): string {
      return `${purpose}-${cryptoRandomId()}`
    },
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
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
  fs.writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

/**
 * Capture the exact owned database/sidecar identities, write them to the
 * identity evidence file (one `path device:inode` line per file), then remove
 * only those exact files. A substituted file, symlink, or unrelated resource
 * is never removed and is reported as a cleanup failure.
 */
function removeDatabaseExact(databasePath: string, identityFile: string | undefined): void {
  const owned: Array<{ path: string; identity: string }> = []
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = databasePath + suffix
    try {
      const stat = fs.lstatSync(candidate, { bigint: true })
      if (stat.isFile() && !stat.isSymbolicLink()) {
        owned.push({ path: candidate, identity: `${stat.dev}:${stat.ino}` })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (identityFile !== undefined) {
    const lines = owned.map((entry) => `${entry.path} ${entry.identity}`).join('\n')
    if (Buffer.byteLength(lines, 'utf8') > 4096) throw new Error('Adoption database identity exceeded its bound')
    fs.writeFileSync(identityFile, lines, { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(identityFile, 0o600)
  }
  for (const entry of owned) {
    const stat = fs.lstatSync(entry.path, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`refusing to remove substituted Adoption database file: ${entry.path}`)
    }
    if (`${stat.dev}:${stat.ino}` !== entry.identity) {
      throw new Error(`refusing to remove substituted Adoption database file: ${entry.path}`)
    }
    fs.unlinkSync(entry.path)
  }
}

function assertInteractiveTTY(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('live Adoption gateway requires an interactive TTY on stdin and stdout')
  }
}

interface CliOptions {
  live: boolean
  socketPath: string
  socketIdentityFile?: string
  databaseIdentityFile?: string
  executionNodeId: string
  teamGoalId: string
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let live = false
  let socketPath: string | undefined
  let socketIdentityFile: string | undefined
  let databaseIdentityFile: string | undefined
  let executionNodeId = DEFAULT_EXECUTION_NODE_ID
  let teamGoalId = DEFAULT_TEAM_GOAL_ID
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
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
  return { live, socketPath, socketIdentityFile, databaseIdentityFile, executionNodeId, teamGoalId }
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
  await requestAuthorization()
  await runLiveAdoptionGateway({
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

let messageCounter = 0
function nextMessageId(): string {
  messageCounter += 1
  return `gateway-${messageCounter.toString(16).padStart(32, '0')}`
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
