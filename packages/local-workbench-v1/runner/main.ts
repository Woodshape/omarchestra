/** Foreground native owner and separate one-shot presentation/status clients. */
import { inspectProjectPath } from './git-context.ts'
import { openWorkbenchRunner } from './runner.ts'
import { describeBackupSupport } from './backup.ts'
import { startNativeOwner, requestOwner } from './native-owner.ts'
import { systemDesktopCommand, type DesktopCommandPort } from './desktop-command.ts'

export interface EntryArguments {
  command: 'start' | 'open' | 'hide' | 'status' | 'backup' | 'inspect' | 'help'
  stateDir: string | null
  runtimeDir: string | null
  path: string | null
}
export const ENTRY_USAGE = [
  'workbench start   --state-dir <dir> --runtime-dir <dir>',
  'workbench open    --runtime-dir <dir>',
  'workbench hide    --runtime-dir <dir>',
  'workbench status  --runtime-dir <dir>',
  'workbench backup  --state-dir <dir> --runtime-dir <dir> (owner stopped)',
  'workbench inspect --path <dir>',
].join('\n')
const FLAGS = ['--state-dir', '--runtime-dir', '--path'] as const
export function parseEntryArguments(argv: readonly string[]): EntryArguments {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help') return { command: 'help', stateDir: null, runtimeDir: null, path: null }
  if (!['start', 'open', 'hide', 'status', 'backup', 'inspect'].includes(command)) throw new Error(`unknown subcommand ${command}; expected ${ENTRY_USAGE}`)
  const values = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i], value = rest[++i]
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`unknown argument ${flag}`)
    if (!value || value.startsWith('--') || values.has(flag)) throw new Error(`${flag} requires one value`)
    values.set(flag, value)
  }
  const stateDir = values.get('--state-dir') ?? null, runtimeDir = values.get('--runtime-dir') ?? null, path = values.get('--path') ?? null
  if (command === 'start' && !stateDir) throw new Error('start requires --state-dir')
  if (command === 'backup' && !stateDir) throw new Error('backup requires --state-dir')
  if (command === 'inspect' && !path) throw new Error('inspect requires --path')
  if (['start', 'open', 'hide', 'status', 'backup'].includes(command) && !runtimeDir) throw new Error(`${command} requires --runtime-dir`)
  if ((['open', 'hide', 'status'].includes(command) && (stateDir || path)) || (['start', 'backup'].includes(command) && path)
      || (command === 'inspect' && (stateDir || runtimeDir))) throw new Error('arguments are not valid for this subcommand')
  return { command: command as EntryArguments['command'], stateDir, runtimeDir, path }
}

export async function runEntry(argv: readonly string[], io: { write(line: string): void; desktop?: DesktopCommandPort } = {
  write: line => process.stdout.write(`${line}\n`),
}): Promise<number> {
  let parsed: EntryArguments
  try { parsed = parseEntryArguments(argv) }
  catch (error) { io.write(JSON.stringify({ kind: 'error', message: (error as Error).message, usage: ENTRY_USAGE })); return 2 }
  if (parsed.command === 'help') { io.write(JSON.stringify({ kind: 'help', usage: ENTRY_USAGE })); return 0 }
  try {
    if (parsed.command === 'inspect') {
      const inspection = inspectProjectPath(parsed.path!)
      io.write(JSON.stringify({ kind: 'inspection', inspection }))
      return inspection.supported ? 0 : 1
    }
    if (parsed.command === 'backup') {
      const runner = openWorkbenchRunner({ roots: { stateDir: parsed.stateDir!, runtimeDir: parsed.runtimeDir! } })
      try { io.write(JSON.stringify({ kind: 'backup', metadata: runner.backup(), support: describeBackupSupport() })) }
      finally { runner.close() }
      return 0
    }
    if (parsed.command !== 'start') {
      const result = await requestOwner(parsed.runtimeDir!, parsed.command)
      io.write(JSON.stringify({ kind: parsed.command, result }))
      return result.status === 'unavailable' ? 1 : 0
    }
    const owner = await startNativeOwner({ roots: { stateDir: parsed.stateDir!, runtimeDir: parsed.runtimeDir! },
      desktop: io.desktop ?? systemDesktopCommand() })
    io.write(JSON.stringify({ kind: 'ready', runnerEpoch: owner.runner.epoch, stateDir: owner.runner.roots.stateDir,
      runtimeDir: owner.runner.roots.runtimeDir, socketPath: owner.socketPath,
      executionUnavailable: 'Assignment delivery and acceptance-check execution are Phase 3' }))
    await new Promise<void>(resolve => {
      const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve() }
      process.once('SIGINT', done); process.once('SIGTERM', done)
    })
    await owner.close()
    io.write(JSON.stringify({ kind: 'closed', runnerEpoch: owner.runner.epoch }))
    return 0
  } catch (error) {
    const failure = error as { code?: string; message?: string; recovery?: string }
    io.write(JSON.stringify({ kind: 'error', code: failure.code ?? 'unavailable', message: failure.message ?? String(error), recovery: failure.recovery ?? null }))
    return 1
  }
}

const flushStdout = () => new Promise<void>(resolve => { process.stdout.write('', () => resolve()) })
if (process.argv[1] !== undefined && /(?:^|[/\\])main\.ts$/.test(process.argv[1])) {
  runEntry(process.argv.slice(2)).then(async code => { await flushStdout(); process.exitCode = code }, async error => {
    await flushStdout(); process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1
  })
}
