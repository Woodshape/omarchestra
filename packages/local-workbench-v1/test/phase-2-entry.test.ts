/** Native foreground lifecycle with one real child owner and disposable roots. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENTRY_USAGE, parseEntryArguments } from '../runner/main.ts'
const ENTRY = new URL('../runner/main.ts', import.meta.url).pathname
function invoke(args: string[], root: string, input = '') {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', ENTRY, ...args], {
    input, encoding: 'utf8', timeout: 12_000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: root, XDG_RUNTIME_DIR: join(root, 'runtime') },
  })
  assert.equal(result.error, undefined, String(result.error))
  return { status: result.status, records: result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)), stderr: result.stderr }
}
async function closeExact(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owner did not stop after SIGTERM')) }, 5000)
    child.once('close', () => { clearTimeout(timer); resolve() })
  })
}
test('entry flags require explicit roots and distinguish owner from one-shot clients', () => {
  assert.equal(parseEntryArguments([]).command, 'help')
  assert.throws(() => parseEntryArguments(['start']), /requires --state-dir/)
  assert.throws(() => parseEntryArguments(['start', '--state-dir', '/tmp/x']), /requires --runtime-dir/)
  assert.throws(() => parseEntryArguments(['open']), /requires --runtime-dir/)
  assert.throws(() => parseEntryArguments(['status', '--runtime-dir', '/tmp/x', '--state-dir', '/tmp/y']), /not valid/)
  assert.match(ENTRY_USAGE, /workbench hide/)
})
test('status/hide are owner clients; EOF does not stop the child or advance the epoch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'n-'))
  const state = join(root, 'state'), runtime = join(root, 'runtime'), project = join(root, 'project')
  mkdirSync(project)
  assert.equal(spawnSync('git', ['init', '--quiet', project], { timeout: 5000 }).status, 0)
  const inspected = invoke(['inspect', '--path', project], root)
  assert.equal(inspected.status, 0)
  assert.equal(inspected.records[0].inspection.supported, true)
  assert.equal(existsSync(state), false)
  const absent = invoke(['status', '--runtime-dir', runtime], root)
  assert.equal(absent.status, 1, 'status never opens an owner or creates history')
  assert.match(absent.records[0].message, /owner is not running; start it first/)
  assert.equal(existsSync(state), false)
  const child = spawn(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', ENTRY,
    'start', '--state-dir', state, '--runtime-dir', runtime], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: root, XDG_RUNTIME_DIR: runtime },
  })
  let log = ''
  const lines = createInterface({ input: child.stdout })
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner did not become ready: ${log}`)), 10_000)
    lines.on('line', line => {
      log += `${line}\n`
      let record: Record<string, unknown>
      try { record = JSON.parse(line) } catch { return }
      if (record.kind === 'ready') { clearTimeout(timer); resolve(record) }
      else if (record.kind === 'error') { clearTimeout(timer); reject(new Error(String(record.message))) }
    })
    child.once('close', code => { clearTimeout(timer); reject(new Error(`owner exited ${code}: ${log}`)) })
  })
  t.after(async () => { try { await closeExact(child) } finally { lines.close(); rmSync(root, { recursive: true, force: true }) } })
  const started = await ready
  const first = invoke(['status', '--runtime-dir', runtime], root)
  assert.equal(first.status, 0, JSON.stringify(first))
  assert.equal(first.records[0].result.runnerEpoch, started.runnerEpoch)
  child.stdin.end() // EOF is presentation-client closure, not owner shutdown.
  const second = invoke(['status', '--runtime-dir', runtime], root)
  assert.equal(second.status, 0)
  assert.equal(second.records[0].result.runnerEpoch, started.runnerEpoch)
  assert.equal(invoke(['hide', '--runtime-dir', runtime], root).records[0].result.status, 'hidden')
  assert.equal(invoke(['status', '--runtime-dir', runtime], root).records[0].result.runnerEpoch, started.runnerEpoch)
  await closeExact(child)
  assert.equal(invoke(['status', '--runtime-dir', runtime], root).status, 1)
  const backup = invoke(['backup', '--state-dir', state, '--runtime-dir', runtime], root)
  assert.equal(backup.status, 0, JSON.stringify(backup))
})
