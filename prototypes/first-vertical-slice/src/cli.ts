/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * cli.ts — foreground runner lifecycle. Requires a caller-supplied state
 * directory; no repository-local default exists. The runner runs in the
 * foreground, prints a readiness report, and shuts down cleanly on SIGTERM
 * or SIGINT. It starts no other process and owns no agent.
 *
 * Usage:
 *   node src/cli.ts --state-dir <dir> [--journal default|wal]
 *                   [--bootstrap-json <inline JSON>] [--socket-name <name>]
 */

import { pathToFileURL } from 'node:url'
import { Domain } from './domain.ts'
import { Runner } from './runner.ts'
import { ensureStateDirectory, Store, type BootstrapConfig } from './store.ts'
import { ROLES, TEXT_LIMITS, isBoundedId, type Role } from './protocol.ts'

interface CliOptions {
  stateDir: string
  journal: 'default' | 'wal'
  bootstrapJson: string | null
  socketName: string
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { stateDir: '', journal: 'default', bootstrapJson: null, socketName: 'runner.sock' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--state-dir' && next !== undefined) {
      options.stateDir = next
      i += 1
    } else if (arg === '--journal' && next !== undefined) {
      if (next !== 'default' && next !== 'wal') {
        throw new Error(`--journal must be "default" or "wal"; got ${next}`)
      }
      options.journal = next
      i += 1
    } else if (arg === '--bootstrap-json' && next !== undefined) {
      options.bootstrapJson = next
      i += 1
    } else if (arg === '--socket-name' && next !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(next) || next === '.' || next === '..') {
        throw new Error('--socket-name must be one bounded filename, not a path')
      }
      options.socketName = next
      i += 1
    } else {
      throw new Error(`unknown or incomplete CLI argument: ${arg}`)
    }
  }
  if (options.stateDir.length === 0) {
    throw new Error('--state-dir is required (a caller-supplied directory outside the repository)')
  }
  return options
}

function parseBootstrap(json: string): BootstrapConfig {
  const raw = JSON.parse(json) as Record<string, unknown>
  if (typeof raw.teamGoalId !== 'string' || !isBoundedId(raw.teamGoalId)) {
    throw new Error('bootstrap teamGoalId must be a bounded identifier')
  }
  if (typeof raw.goalText !== 'string' || raw.goalText.length === 0 || raw.goalText.length > TEXT_LIMITS.goalText) {
    throw new Error('bootstrap goalText must be a bounded non-empty string')
  }
  if (!Array.isArray(raw.roles) || raw.roles.length !== ROLES.length) {
    throw new Error('bootstrap must declare exactly three role identities')
  }
  const roles = raw.roles.map((entry) => {
    const role = entry as Record<string, unknown>
    const role2 = role.role
    if (typeof role2 !== 'string' || !(ROLES as readonly string[]).includes(role2)) {
      throw new Error('bootstrap role identity has an invalid role')
    }
    for (const field of ['agentRunId', 'terminalSessionRef', 'shellRunId', 'piSessionId', 'extensionInstanceId'] as const) {
      if (typeof role[field] !== 'string' || !isBoundedId(role[field])) {
        throw new Error(`bootstrap role identity field ${field} must be a bounded identifier`)
      }
    }
    if (typeof role.hostPid !== 'number' || !Number.isInteger(role.hostPid) || role.hostPid <= 0) {
      throw new Error('bootstrap role identity hostPid must be a positive integer')
    }
    return {
      role: role2 as Role,
      agentRunId: String(role.agentRunId),
      terminalSessionRef: String(role.terminalSessionRef),
      shellRunId: String(role.shellRunId),
      piSessionId: String(role.piSessionId),
      extensionInstanceId: String(role.extensionInstanceId),
      hostPid: role.hostPid,
    }
  })
  const rolesSeen = new Set<string>()
  for (const entry of roles) {
    if (rolesSeen.has(entry.role)) throw new Error('bootstrap role identities must be unique')
    rolesSeen.add(entry.role)
  }
  const assignment = raw.assignment as Record<string, unknown>
  if (
    typeof raw.assignment !== 'object' ||
    raw.assignment === null ||
    typeof assignment.id !== 'string' ||
    !isBoundedId(assignment.id) ||
    typeof assignment.prompt !== 'string' ||
    assignment.prompt.length === 0 ||
    assignment.prompt.length > TEXT_LIMITS.prompt
  ) {
    throw new Error('bootstrap assignment must carry a bounded id and prompt')
  }
  const builder = roles.find((role) => role.role === 'builder')
  if (
    builder === undefined ||
    typeof assignment.agentRunId !== 'string' ||
    !isBoundedId(assignment.agentRunId) ||
    assignment.agentRunId !== builder.agentRunId
  ) {
    throw new Error('bootstrap assignment agentRunId must equal the durable Builder binding')
  }
  return {
    teamGoalId: raw.teamGoalId,
    goalText: raw.goalText,
    roles,
    assignment: {
      id: assignment.id,
      role: 'builder',
      agentRunId: assignment.agentRunId,
      prompt: assignment.prompt,
    },
  }
}

export async function runRunner(options: CliOptions): Promise<void> {
  // Dedicated foreground process: ensure SQLite rollback journals and WAL
  // sidecars are owner-only from the instant SQLite creates them.
  process.umask(0o077)
  const { stateDir, mount } = ensureStateDirectory(options.stateDir)
  const store = Store.open(stateDir, options.journal, mount)
  const domain = new Domain(store)
  let config: BootstrapConfig | null = null
  let freshBootstrap = false
  if (options.bootstrapJson !== null) {
    config = parseBootstrap(options.bootstrapJson)
    const result = domain.bootstrapIfNeeded(config)
    freshBootstrap = result.created
  }
  if (domain.store.getGoal() === null) {
    throw new Error('no durable Team Goal exists; pass --bootstrap-json on first start')
  }
  const runner = new Runner(domain, {
    stateDir,
    journal: options.journal,
    socketName: options.socketName,
    freshBootstrap,
  })
  await runner.start()

  const report = {
    event: 'runner_ready',
    pid: process.pid,
    stateDir,
    socket: runner.socketFile,
    journalRequested: runner.journalReport.requested,
    journalEffective: runner.journalReport.effective,
    sqliteVersion: runner.journalReport.sqliteVersion,
    schemaVersion: runner.schemaVersion,
    mount: runner.mountInfo,
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    try {
      await runner.stop()
      store.close()
      process.stdout.write(
        `${JSON.stringify({ event: 'runner_stopped', signal, pid: process.pid })}\n`,
        () => process.exit(0),
      )
    } catch (error) {
      process.stderr.write(`runner stop failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    await runRunner(options)
  } catch (error) {
    process.stderr.write(`runner failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  void main()
}