/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Foreground, human-only observer gateway. It wires the owner-only Unix socket
 * to the pure observation gateway and publishes its validated collection
 * projection through the narrow Companion 0.3.0 observer seam. Controls are
 * bounded to status, pause, resume, and quit. This entrypoint does not create
 * Adoption state, start Pi or external work, or mutate an installation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import readline from 'node:readline/promises'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

import {
  OBSERVER_COMPANION_RELEASE,
} from '../companion/releases.ts'
import {
  LiveCompanionProjection,
  type ObserverCompanionShellPort,
} from '../observer/live-companion-projection.ts'
import {
  LiveObserverGateway,
  type GatewaySession,
} from '../observer/live-gateway-core.ts'
import {
  LiveFrameChannel,
  type DuplexStream,
} from '../observer/live-frame-channel.ts'
import {
  ObserverUnixSocketServer,
} from './live-observer-transport.ts'
import type { ObservedProjection } from '../observer/telemetry-policy.ts'
import type { RegistryClock } from '../observer/registry.ts'

const DEFAULT_SWEEP_INTERVAL_MS = 1_000
const MAX_CONTROL_LINE_CHARACTERS = 64
const MIN_SWEEP_INTERVAL_MS = 100
const MAX_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_EXECUTION_NODE_ID = 'observer-gateway-local'
export const OBSERVER_LIVE_AUTHORIZATION_PHRASE = 'I AUTHORIZE OMARCHESTRA OBSERVER LIVE BRIDGE'

export interface MonotonicObserverClock extends RegistryClock {}

/** Process-local monotonic clock. Wall-clock changes cannot affect leases. */
export class ProcessMonotonicObserverClock implements MonotonicObserverClock {
  private readonly startedAt = performance.now()

  now(): number {
    return Math.max(0, Math.floor(performance.now() - this.startedAt))
  }
}

export interface LiveObserverGatewayRunOptions {
  socketPath: string
  socketIdentityFile?: string
  executionNodeId?: string
  shell: ObserverCompanionShellPort
  clock?: RegistryClock
  sweepIntervalMs?: number
  input?: Readable
  output?: Writable
}

export interface LiveObserverGatewayStatus {
  state: 'running' | 'paused' | 'stopping'
  paused: boolean
  observerRevision: number
  observedSessions: number
  publication: 'healthy' | 'degraded'
}

/**
 * Run one foreground gateway until its bounded control input requests quit.
 * The function accepts streams and ports for fake-only tests; the CLI wrapper
 * below enforces the interactive TTY and exact authorization phrase.
 */
export async function runLiveObserverGateway(options: LiveObserverGatewayRunOptions): Promise<void> {
  const clock = options.clock ?? new ProcessMonotonicObserverClock()
  const publisher = new LiveCompanionProjection({ shell: options.shell })
  let paused = false
  let publication: Promise<void> = Promise.resolve()
  let pendingProjection: ObservedProjection | null = null
  let publicationState: LiveObserverGatewayStatus['publication'] = 'healthy'

  const publish = (projection: ObservedProjection): void => {
    if (paused) {
      pendingProjection = projection
      return
    }
    publication = publication
      .then(async () => {
        await publisher.publish(projection)
        publicationState = 'healthy'
      })
      .catch(() => {
        // A Companion presentation failure cannot disconnect or mutate the
        // disposable observer registry. A later revision retries normally.
        publicationState = 'degraded'
      })
  }

  const gateway = new LiveObserverGateway({
    clock,
    executionNodeId: options.executionNodeId ?? DEFAULT_EXECUTION_NODE_ID,
    onProjection: publish,
  })

  const server = new ObserverUnixSocketServer(options.socketPath, (socket) => {
    let session: GatewaySession | null = null
    const channel = new LiveFrameChannel(socket as unknown as DuplexStream, {
      onFrame: (frame) => session?.handleFrame(frame),
      onClose: (error) => session?.transportClosed(error),
    })
    session = gateway.accept(channel)
  })
  const sweepIntervalMs = boundedSweepInterval(options.sweepIntervalMs)

  await publisher.verify()
  await publisher.publish(gateway.snapshot())
  await server.start()
  if (options.socketIdentityFile !== undefined) {
    const identity = server.identity
    if (identity === null) throw new Error('observer socket identity was not captured')
    try {
      writeSocketIdentity(options.socketIdentityFile, identity)
    } catch (error) {
      try {
        await server.close()
      } catch {
        // Preserve the identity-file failure. Cleanup remains fail-closed.
      }
      throw error
    }
  }

  const sweepTimer = setInterval(() => {
    gateway.sweep()
  }, sweepIntervalMs)
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout

  let cleanupError: Error | null = null
  try {
    writeControl(output, `observer gateway listening on ${server.path}`)
    writeControl(output, 'controls: status | pause | resume | quit')
    for await (const control of boundedControlLines(input)) {
      if (control.tooLong) {
        writeControl(output, 'control rejected: line exceeds the bounded length')
        continue
      }
      const line = control.value.trim()
      if (line === 'status') {
        writeControl(output, JSON.stringify(status(gateway, paused, publicationState)))
        continue
      }
      if (line === 'pause') {
        paused = true
        writeControl(output, JSON.stringify(status(gateway, paused, publicationState)))
        continue
      }
      if (line === 'resume') {
        paused = false
        const latest = pendingProjection ?? gateway.snapshot()
        pendingProjection = null
        publish(latest)
        await publication
        writeControl(output, JSON.stringify(status(gateway, paused, publicationState)))
        continue
      }
      if (line === 'quit') {
        writeControl(output, JSON.stringify({ ...status(gateway, paused, publicationState), state: 'stopping' }))
        break
      }
      writeControl(output, 'control rejected: use status, pause, resume, or quit')
    }
  } finally {
    clearInterval(sweepTimer)
    try {
      await server.close()
    } catch (error) {
      cleanupError = asError(error)
    }
    gateway.close()
    await publication
  }
  if (cleanupError !== null) throw cleanupError
}

/** Load the existing manual shell adapter only from the explicit CLI path. */
export async function createLiveObserverShell(): Promise<ObserverCompanionShellPort> {
  const module = await import('./live-companion-omarchy.ts')
  return new module.LiveCompanionShell(undefined, OBSERVER_COMPANION_RELEASE)
}

function status(
  gateway: LiveObserverGateway,
  paused: boolean,
  publication: LiveObserverGatewayStatus['publication'],
): LiveObserverGatewayStatus {
  return {
    state: paused ? 'paused' : 'running',
    paused,
    observerRevision: gateway.snapshot().observerRevision,
    observedSessions: gateway.snapshot().agents.length,
    publication,
  }
}

interface BoundedControlLine {
  value: string
  tooLong: boolean
}

/** Consume controls without allowing readline to buffer an unbounded line. */
async function* boundedControlLines(input: Readable): AsyncGenerator<BoundedControlLine> {
  const decoder = new StringDecoder('utf8')
  let line = ''
  let tooLong = false

  for await (const chunk of input) {
    const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
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

  const tail = decoder.end()
  if (tail.length > 0 && !tooLong) {
    if (line.length + tail.length > MAX_CONTROL_LINE_CHARACTERS) {
      tooLong = true
      line = ''
    } else {
      line += tail
    }
  }
  if (tooLong) yield { value: '', tooLong: true }
  else if (line.length > 0) yield { value: line, tooLong: false }
}

function writeControl(output: Writable, line: string): void {
  output.write(`${line}\n`)
}

function boundedSweepInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SWEEP_INTERVAL_MS
  if (!Number.isSafeInteger(value) || value < MIN_SWEEP_INTERVAL_MS || value > MAX_SWEEP_INTERVAL_MS) {
    throw new Error(`observer sweep interval must be ${MIN_SWEEP_INTERVAL_MS}–${MAX_SWEEP_INTERVAL_MS} milliseconds`)
  }
  return value
}

function assertInteractiveTTY(): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error('live observer gateway requires an interactive TTY on stdin and stdout')
  }
}

interface CliOptions {
  socketPath: string
  socketIdentityFile?: string
  executionNodeId: string
  sweepIntervalMs?: number
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let live = false
  let socketPath: string | undefined
  let socketIdentityFile: string | undefined
  let executionNodeId = DEFAULT_EXECUTION_NODE_ID
  let sweepIntervalMs: number | undefined
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
    if (argument === '--execution-node-id') {
      executionNodeId = args[++index] ?? ''
      continue
    }
    if (argument === '--sweep-interval-ms') {
      const value = Number(args[++index])
      if (!Number.isSafeInteger(value)) throw new Error('--sweep-interval-ms must be a safe integer')
      sweepIntervalMs = value
      continue
    }
    throw new Error(`unknown observer gateway option ${String(argument)}`)
  }
  if (!live) throw new Error('observer gateway requires the explicit --live flag')
  if (socketPath === undefined || !path.isAbsolute(socketPath)) {
    throw new Error('--socket must be an absolute Unix-socket path')
  }
  if (socketIdentityFile !== undefined && !path.isAbsolute(socketIdentityFile)) {
    throw new Error('--socket-identity-file must be an absolute path')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionNodeId)) {
    throw new Error('--execution-node-id must be a bounded ASCII identity')
  }
  // Let the transport own canonical-path and ancestor-symlink checks, while
  // validating the interval before creating any live resource.
  boundedSweepInterval(sweepIntervalMs)
  return { socketPath, socketIdentityFile, executionNodeId, sweepIntervalMs }
}

function writeSocketIdentity(filePath: string, identity: { device: bigint; inode: bigint }): void {
  const encoded = `${identity.device.toString()}:${identity.inode.toString()}\n`
  if (Buffer.byteLength(encoded, 'utf8') > 128) throw new Error('observer socket identity exceeded its bound')
  fs.writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(filePath, 0o600)
}

async function requestAuthorization(): Promise<void> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type exactly ${OBSERVER_LIVE_AUTHORIZATION_PHRASE}\n> `)
    if (answer !== OBSERVER_LIVE_AUTHORIZATION_PHRASE) {
      throw new Error('observer live authorization phrase did not match exactly')
    }
  } finally {
    prompt.close()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--check') {
    if (args.length !== 1) throw new Error('--check does not accept additional arguments')
    console.log('observer gateway entrypoint check: PASS (no live resources opened)')
    return
  }
  assertInteractiveTTY()
  const options = parseCliOptions(args)
  await requestAuthorization()
  const shell = await createLiveObserverShell()
  await runLiveObserverGateway({
    ...options,
    shell,
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

const invokedPath = process.argv[1] === undefined ? null : path.resolve(process.argv[1])
const modulePath = path.resolve(fileURLToPath(import.meta.url))
if (invokedPath === modulePath) {
  main().catch(() => {
    console.error('observer gateway failed')
    process.exitCode = 1
  })
}

