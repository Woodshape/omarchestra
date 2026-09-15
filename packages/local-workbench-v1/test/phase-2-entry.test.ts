/**
 * Local Workbench v1 Phase 2 — foreground entry point acceptance.
 *
 * Each subcommand runs in one bounded foreground process over a disposable
 * state root. The line protocol is exercised end to end: a real Git path is
 * inspected, the registration is confirmed, a Team Goal and a Project-scoped
 * check are created, the process exits on EOF, and a second process reopens
 * the same root to read the committed state back. No Assignment is delivered
 * and no acceptance check executes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY_USAGE, parseEntryArguments } from '../runner/main.ts'

const ENTRY = new URL('../runner/main.ts', import.meta.url).pathname

function runEntryProcess(flags: string[], stateDir: string, stdin: string): { status: number | null; lines: Array<Record<string, unknown>>; log: string } {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', ENTRY, ...flags], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: join(stateDir, 'home'),
      TMPDIR: join(stateDir, 'tmp'),
      XDG_RUNTIME_DIR: join(stateDir, 'runtime'),
    },
  })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = (result.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  return { status: result.status, lines, log }
}

test('the entry arguments are explicit and every root is required', () => {
  assert.equal(parseEntryArguments([]).command, 'help')
  assert.equal(parseEntryArguments(['help']).command, 'help')
  assert.throws(() => parseEntryArguments(['start']), /requires --state-dir/)
  assert.throws(() => parseEntryArguments(['start', '--state-dir']), /requires a value/)
  assert.throws(() => parseEntryArguments(['start', '--state-dir', '/tmp/x', '--nope', 'y']), /unknown argument/)
  const parsed = parseEntryArguments(['start', '--state-dir', '/tmp/state', '--runtime-dir', '/tmp/run', '--session', 's1'])
  assert.equal(parsed.command, 'start')
  assert.equal(parsed.stateDir, '/tmp/state')
  assert.equal(parsed.runtimeDir, '/tmp/run')
  assert.equal(parsed.sessionId, 's1')
  assert.match(ENTRY_USAGE, /workbench inspect --path <dir>/)
})

interface EntryRecord { kind: string;[key: string]: unknown }
interface EntryConnection { sessionId: string; pluginGeneration: number; runnerEpoch: number; revision: number; snapshot: Record<string, unknown> }

/**
 * One live foreground session. Records are read from stdout in arrival order;
 * intents are written to stdin using the runner's own revision, exactly as an
 * operator would after reading the projection.
 */
function startSession(stateDir: string, sessionId: string): {
  next(kind: string): Promise<EntryRecord>
  terminal(kind: string): Promise<EntryRecord>
  connection(record: EntryRecord): EntryConnection
  write(kind: string, target: string | null, payload: Record<string, unknown>, expectedRevision?: number): void
  acknowledged(): Promise<EntryRecord>
  end(): Promise<number | null>
  transcript(): string
} {
  const child = spawn(process.execPath, ['--experimental-strip-types', ENTRY, 'start', '--state-dir', stateDir, '--session', sessionId], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(stateDir, 'home'), TMPDIR: join(stateDir, 'tmp'), XDG_RUNTIME_DIR: join(stateDir, 'runtime') },
  })
  const queue: EntryRecord[] = []
  const waiters: Array<{ kind: string; resolve: (record: EntryRecord) => void }> = []
  let transcript = ''
  let streamEnded = false
  const lines = createInterface({ input: child.stdout })
  lines.on('close', () => { streamEnded = true })
  lines.on('line', (line) => {
    transcript += `${line}\n`
    if (line.trim() === '') return
    const record = JSON.parse(line) as EntryRecord
    const index = waiters.findIndex(waiter => waiter.kind === record.kind)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(record)
    else queue.push(record)
  })
  let counter = 0
  let revision = 0
  let epoch = 0
  const nextOf = (kind: string) => new Promise<EntryRecord>((resolve, reject) => {
    const index = queue.findIndex(record => record.kind === kind)
    if (index >= 0) return resolve(queue.splice(index, 1)[0])
    waiters.push({ kind, resolve })
    setTimeout(() => reject(new Error(`timed out waiting for ${kind}\n${transcript}`)), 20_000).unref()
  })
  const connection = (record: EntryRecord): EntryConnection => {
    const envelope = record.envelope as { session: { sessionId: string; pluginGeneration: number }; projection: Record<string, unknown> } | undefined
    const snapshot = envelope === undefined ? record.snapshot as Record<string, unknown> : envelope.projection
    revision = snapshot.revision as number
    epoch = snapshot.runnerEpoch as number
    return {
      sessionId: (envelope?.session.sessionId ?? snapshot.sessionId) as string,
      pluginGeneration: (envelope?.session.pluginGeneration ?? snapshot.pluginGeneration) as number,
      runnerEpoch: snapshot.runnerEpoch as number,
      revision,
      snapshot,
    }
  }
  return {
    next: nextOf,
    async terminal(kind) {
      for (;;) {
        const record = await nextOf(kind)
        if ((record.feedback as { status: string } | undefined)?.status !== 'submitted') return record
      }
    },
    connection,
    write(kind, target, payload, expectedRevision = revision) {
      child.stdin.write(`${JSON.stringify({ kind, target, payload, sessionId, pluginGeneration: 1, runnerEpoch: epoch, intentId: `entry-${++counter}`, expectedRevision })}\n`)
    },
    acknowledged: async () => {
      for (;;) {
        const record = await nextOf('feedback')
        if ((record.feedback as { status: string }).status === 'acknowledged') return record
        if ((record.feedback as { status: string }).status === 'submitted') continue
        throw new Error(`unexpected feedback ${JSON.stringify(record)}\n${transcript}`)
      }
    },
    async end() {
      child.stdin.end()
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
      // Drain stdout before reading the transcript: the closure record is the
      // last line the process writes.
      if (!streamEnded) await new Promise<void>((resolve) => lines.on('close', () => resolve()))
      return code
    },
    transcript: () => transcript,
  }
}

test('one foreground session takes the bounded management journey and a later process reads it back', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lw-p2-entry-'))
  const stateDir = join(base, 'state')
  const project = join(base, 'project')
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    mkdirSync(project, { recursive: true })
    execFileSync('git', ['init', '-q', project], { stdio: 'ignore' })

    // A read-only inspection of a real worktree needs no state root at all.
    const inspect = runEntryProcess(['inspect', '--path', project], stateDir, '')
    assert.equal(inspect.status, 0, inspect.log)
    const inspection = inspect.lines[0].inspection as { supported: boolean; canonicalPath: string; headOid: string | null }
    assert.equal(inspection.supported, true)
    assert.equal(inspection.canonicalPath, project)

    const rejectedInspection = runEntryProcess(['inspect', '--path', join(base, 'not-a-repo')], stateDir, '')
    assert.equal(rejectedInspection.status, 1, rejectedInspection.log)
    assert.equal(rejectedInspection.lines[0].inspection, null)
    assert.equal(rejectedInspection.lines[0].code, 'invalid_input')

    const session = startSession(stateDir, 'sess-entry')
    const ready = await session.next('ready')
    assert.equal(ready.executionUnavailable, 'Assignment delivery and acceptance-check execution are Phase 3')
    assert.equal(typeof ready.runnerEpoch, 'number')
    const connection = session.connection(await session.next('open'))
    assert.equal(connection.snapshot.selectedProjectId, null)
    assert.equal((connection.snapshot.fixture as { active: boolean }).active, false)

    // 1. Inspect a real Git path.
    session.write('inspect_project', null, { path: project })
    const inspectedFeedback = await session.acknowledged()
    assert.equal((inspectedFeedback.feedback as { status: string }).status, 'acknowledged')
    const inspected = session.connection(await session.next('projection'))
    const details = inspected.snapshot.details as Array<{ kind: string; registrationId: string; supported: boolean; canonicalPath: string }>
    assert.equal(details.length, 1)
    assert.equal(details[0].kind, 'registration')
    assert.equal(details[0].supported, true)
    assert.equal(details[0].canonicalPath, project)
    assert.match(session.transcript(), /"status":"submitted"/)
    assert.match(session.transcript(), /"status":"acknowledged"/)

    // 2. Confirm the exact registration the runner issued.
    session.write('confirm_register_project', details[0].registrationId, { registrationId: details[0].registrationId }, inspected.snapshot.revision as number)
    await session.acknowledged()
    const registered = session.connection(await session.next('projection'))
    const projectId = registered.snapshot.selectedProjectId as string
    assert.equal(typeof projectId, 'string')
    assert.equal((registered.snapshot.projects as Array<{ canonicalPath: string }>)[0].canonicalPath, project)
    assert.equal((registered.snapshot.details ?? []).length, 0)

    // 3. Create a Team Goal, then a Project-scoped check.
    session.write('create_goal', null, { projectId, goalText: 'Ship the durable workbench' }, registered.snapshot.revision as number)
    await session.acknowledged()
    const goal = session.connection(await session.next('projection'))
    assert.equal((goal.snapshot.goals as unknown[]).length, 1)

    session.write('create_check', null, {
      projectId,
      name: 'Package test suite',
      summary: 'Run the package test suite and report pass or fail only.',
      mode: 'validator',
      commandSummary: 'no command configured in Phase 2',
      definitionDraft: {
        executable: '/bin/true', argv: [], cwd: project, environment: [], resourcePaths: [],
        timeoutMs: 60000, outputBytes: 4096, maxCorrections: 1, elapsedMs: 600000,
      },
    }, goal.snapshot.revision as number)
    await session.acknowledged()
    const final = session.connection(await session.next('projection'))
    assert.equal((final.snapshot.checks as unknown[]).length, 1)
    assert.equal((final.snapshot.assignments as unknown[]).length, 0)
    assert.equal((final.snapshot.actions as Array<{ kind: string; enabled: boolean }>).find(action => action.kind === 'start_assignment')?.enabled, false)

    assert.equal(await session.end(), 0)
    // The closure record is last: nothing is written after the session ends.
    assert.equal(session.transcript().trimEnd().endsWith('{"kind":"closed","sessionId":"sess-entry"}'), true)

    // A separate process reads the committed state back.
    const status = runEntryProcess(['status', '--state-dir', stateDir], stateDir, '')
    assert.equal(status.status, 0, status.log)
    const statusRecord = status.lines[0] as { projects: Array<{ projectId: string; canonicalPath: string }>; goals: number; events: number }
    assert.deepEqual(statusRecord.projects, [{ projectId, canonicalPath: project }])
    assert.equal(statusRecord.goals, 1)
    // One event per committed mutation: register, goal, check.
    assert.equal(statusRecord.events, 3)

    const backup = runEntryProcess(['backup', '--state-dir', stateDir], stateDir, '')
    assert.equal(backup.status, 0, backup.log)
    assert.equal(backup.lines[0].kind, 'backup')
    assert.equal((backup.lines[0].support as { restoreSupported: boolean }).restoreSupported, false)

    // A malformed request in a fresh session fails closed with a code.
    const malformed = runEntryProcess(['start', '--state-dir', stateDir], stateDir, '{"kind":"inspect_project"}\n')
    assert.equal(malformed.status, 1, malformed.log)
    assert.equal(malformed.lines.find(line => line.kind === 'error')?.code, 'invalid_input')

    // An unsupported runtime action is refused before the runner commits, with
    // the Phase 3 reason rather than a fabricated acknowledgement.
    const disabled = runEntryProcess(['start', '--state-dir', stateDir], stateDir, `${JSON.stringify({ kind: 'start_assignment', target: null, payload: {} })}\n`)
    assert.equal(disabled.status, 1, disabled.log)
    const disabledError = disabled.lines.find(line => line.kind === 'error')
    assert.equal(disabledError?.code, 'invalid_input')
    assert.match(String(disabledError?.message), /Phase 3/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
