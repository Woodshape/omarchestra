/**
 * Local Workbench v1 Phase 2 — foreground entry point.
 *
 * One foreground process owns one state root. Every subcommand takes its roots
 * as explicit arguments: there is no hidden daemon, no listening socket, no
 * discovery of a user's installation or configuration, and no work dispatch.
 *
 * `start` speaks a bounded line protocol on stdin/stdout. Each stdin line is
 * one presentation intent, each stdout line is one projection or feedback
 * record. The process exits on EOF, SIGINT or SIGTERM. Assignment delivery and
 * acceptance-check execution remain unavailable and are reported as reasons,
 * never faked.
 *
 * This module spawns no process. The single bounded Git inspection lives in
 * `git-context.ts` and is called through it.
 */

import { createInterface } from 'node:readline'
import type { PresentationPort } from '../console/presentation-shell.ts'
import { WorkbenchAuthority } from './authority.ts'
import { inspectProjectPath } from './git-context.ts'
import { createWorkbenchHost, type WorkbenchHost } from './host.ts'
import { openWorkbenchRunner, type WorkbenchRunner } from './runner.ts'
import { probePiInstallation, type InstallationReport } from './transport.ts'

export interface EntryArguments {
  command: 'start' | 'status' | 'backup' | 'inspect' | 'help'
  stateDir: string | null
  runtimeDir: string | null
  extensionRoot: string | null
  sessionId: string | null
  path: string | null
}

export const ENTRY_USAGE = [
  'workbench start   --state-dir <dir> [--runtime-dir <dir>] [--extension-root <dir>] [--session <id>]',
  'workbench status  --state-dir <dir> [--extension-root <dir>]',
  'workbench backup  --state-dir <dir>',
  'workbench inspect --path <dir>',
].join('\n')

const FLAGS = ['--state-dir', '--runtime-dir', '--extension-root', '--session', '--path'] as const

export function parseEntryArguments(argv: readonly string[]): EntryArguments {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help') {
    return { command: 'help', stateDir: null, runtimeDir: null, extensionRoot: null, sessionId: null, path: null }
  }
  if (!['start', 'status', 'backup', 'inspect'].includes(command)) {
    throw new Error(`unknown subcommand ${command}; expected one of ${ENTRY_USAGE}`)
  }
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!(FLAGS as readonly string[]).includes(token)) throw new Error(`unknown argument ${token}; expected ${FLAGS.join(', ')}`)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    values.set(token, value)
    index += 1
  }
  const read = (flag: string) => values.get(flag) ?? null
  if (command !== 'inspect' && read('--state-dir') === null) throw new Error(`${command} requires --state-dir`)
  if (command === 'inspect' && read('--path') === null) throw new Error('inspect requires --path')
  return {
    command: command as EntryArguments['command'],
    stateDir: read('--state-dir'),
    runtimeDir: read('--runtime-dir'),
    extensionRoot: read('--extension-root'),
    sessionId: read('--session'),
    path: read('--path'),
  }
}

/**
 * Presentation port over one line-oriented foreground channel. Nothing is
 * buffered beyond the current line, and the operator's intents arrive in the
 * same order they were written.
 */
export function createStdioView(write: (line: string) => void): PresentationPort & { push(payload: string): void } {
  const queue: string[] = []
  return {
    pluginGeneration: 0,
    open(envelope: unknown) {
      write(JSON.stringify({ kind: 'open', envelope }))
      return true
    },
    applyProjection(snapshot: unknown) {
      write(JSON.stringify({ kind: 'projection', snapshot }))
      return true
    },
    takeIntent() {
      return queue.shift() ?? ''
    },
    intentResult(feedback: unknown) {
      write(JSON.stringify({ kind: 'feedback', feedback }))
      return true
    },
    close() {
      // Closure is reported by the entry point after the session loop ends, so
      // the record order always reads: ready, open, ..., closed.
    },
    /**
     * Accept one operator line. The durable runner owns session, epoch and
     * revision, so only the request fields cross into the shell. A line that is
     * not a request object is forwarded unchanged and rejected downstream.
     */
    push(payload: string) {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown> | null
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.kind === 'string') {
          const body = parsed.payload !== null && typeof parsed.payload === 'object' ? parsed.payload : {}
          queue.push(JSON.stringify({ kind: parsed.kind, target: parsed.target ?? null, payload: body }))
          return
        }
      } catch { /* forwarded below for a downstream rejection */ }
      queue.push(payload)
    },
  }
}

export interface StartOptions {
  runner: WorkbenchRunner
  view: PresentationPort & { push(payload: string): void }
  sessionId: string
  install: InstallationReport | null
  clock?: () => number
  newId?: (prefix: string) => string
}

/** Compose the durable runner with one presentation port and drain intents. */
export function startForeground(options: StartOptions): { host: WorkbenchHost; close(): void } {
  const authority = new WorkbenchAuthority({
    runner: options.runner,
    sessionId: options.sessionId,
    pluginGeneration: 1,
    clock: options.clock,
    newId: options.newId,
  })
  const host = createWorkbenchHost({ authority, view: options.view, clock: options.clock })
  void host.start()
  return {
    host,
    close() {
      host.stop()
    },
  }
}

function emitRecord(write: (line: string) => void, record: Record<string, unknown>): void {
  write(JSON.stringify(record))
}

export async function runEntry(
  argv: readonly string[],
  io: { write: (line: string) => void; stdin: NodeJS.ReadableStream } = {
    write: line => process.stdout.write(`${line}\n`),
    stdin: process.stdin,
  },
): Promise<number> {
  let parsed: EntryArguments
  try {
    parsed = parseEntryArguments(argv)
  } catch (error) {
    io.write(JSON.stringify({ kind: 'error', message: error instanceof Error ? error.message : String(error), usage: ENTRY_USAGE }))
    return 2
  }
  if (parsed.command === 'help') {
    io.write(JSON.stringify({ kind: 'help', usage: ENTRY_USAGE }))
    return 0
  }
  if (parsed.command === 'inspect') {
    try {
      const inspection = inspectProjectPath(parsed.path as string)
      io.write(JSON.stringify({ kind: 'inspection', inspection }))
      return inspection.supported ? 0 : 1
    } catch (error) {
      const failure = error as { code?: string; message?: string; recovery?: string }
      io.write(JSON.stringify({ kind: 'inspection', inspection: null, code: failure.code ?? 'invalid_input', message: failure.message ?? String(error), recovery: failure.recovery ?? null }))
      return 1
    }
  }

  const install = parsed.extensionRoot === null ? null : probePiInstallation(parsed.extensionRoot)
  if (install !== null && install.state !== 'available') io.write(JSON.stringify({ kind: 'installation', install }))

  let runner: WorkbenchRunner | null = null
  try {
    runner = openWorkbenchRunner({
      roots: { stateDir: parsed.stateDir as string, runtimeDir: parsed.runtimeDir },
    })
  } catch (error) {
    const failure = error as { code?: string; message?: string; recovery?: string }
    io.write(JSON.stringify({ kind: 'error', code: failure.code ?? 'invalid_input', message: failure.message ?? String(error), recovery: failure.recovery ?? null }))
    return 1
  }

  try {
    if (parsed.command === 'status') {
      emitRecord(io.write, {
        kind: 'status',
        runner: runner.describe(),
        projects: runner.store.listProjects().map(project => ({ projectId: project.projectId, canonicalPath: project.canonicalPath })),
        goals: runner.store.listGoals().length,
        events: runner.store.listEvents().length,
        install,
        executionUnavailable: 'Assignment delivery and acceptance-check execution are Phase 3',
      })
      return 0
    }
    if (parsed.command === 'backup') {
      const metadata = runner.backup()
      emitRecord(io.write, { kind: 'backup', metadata, support: { restoreSupported: false, migrationsSupported: false } })
      return 0
    }

    const view = createStdioView(io.write)
    const session = parsed.sessionId ?? `wb-${runner.nodeId}`
    // The ready record precedes the first projection: a reader always knows
    // which session and epoch the projections belong to before it sees one.
    io.write(JSON.stringify({
      kind: 'ready',
      sessionId: session,
      stateDir: runner.roots.stateDir,
      runnerEpoch: runner.epoch,
      install,
      executionUnavailable: 'Assignment delivery and acceptance-check execution are Phase 3',
    }))
    const sessionHost = startForeground({ runner, view, sessionId: session, install })
    const lines = createInterface({ input: io.stdin })
    try {
      for await (const line of lines) {
        const text = line.trim()
        if (text === '') continue
        view.push(text)
        sessionHost.host.tick()
      }
    } finally {
      lines.close()
      sessionHost.close()
    }
    io.write(JSON.stringify({ kind: 'closed', sessionId: session }))
    return 0
  } catch (error) {
    const failure = error as { code?: string; message?: string; recovery?: string }
    io.write(JSON.stringify({ kind: 'error', code: failure.code ?? 'invalid_input', message: failure.message ?? String(error), recovery: failure.recovery ?? null }))
    return 1
  } finally {
    try { runner.close() } catch { /* already closed by the failing path */ }
  }
}

// Direct invocation only. Importing this module (for example from a test) must
// not start a runner.
const flushStdout = () => new Promise<void>((resolve) => { process.stdout.write('', () => resolve()) })
if (process.argv[1] !== undefined && /(?:^|[/\\])main\.ts$/.test(process.argv[1])) {
  runEntry(process.argv.slice(2)).then(async (code) => {
    // A piped stdout is asynchronous: drain it so the closure record reaches a
    // reader before the process exits.
    await flushStdout()
    process.exitCode = code
  }, async (error: unknown) => {
    await flushStdout()
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
