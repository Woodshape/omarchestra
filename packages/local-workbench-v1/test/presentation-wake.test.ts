import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { prepareQtFixture } from './qt-fixture.ts'
import { startNativeOwner, requestOwner } from '../runner/native-owner.ts'
import { WORKBENCH_RELEASE } from '../companion/releases.ts'
import { BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY,
  decodeBridgeFrame, encodeBridgeFrame } from '../runner/bridge-protocol.ts'

// Actual private Quickshell -> packaged QML Process -> packaged Node client ->
// private Owner -> guarded Quickshell IPC -> adapter -> fake Pi. No installed
// shell, physical compositor or native Pi navigator is contacted.
test('real Quickshell click wake reaches the native Owner and Pi bridge without a heartbeat tick', async t => {
  // qs appends /runtime/quickshell/by-id/<id>/ipc.sock; keep the basename
  // short even under the full gate's nested TMPDIR (Unix sun_path is bounded).
  const root = mkdtempSync(join(tmpdir(), 'q-'))
  prepareQtFixture(root)
  mkdirSync(join(root, 'r'), { mode: 0o700 })
  assert.ok(join(root, 'r/quickshell/by-id/1234567890/ipc.sock').length < 104, 'private Qt IPC path fits sun_path')
  const env = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'r'),
    QT_QPA_PLATFORM: 'offscreen', QT_QUICK_BACKEND: 'software', QML_IMPORT_PATH: join(root, 'imports') }
  writeFileSync(join(root, 'shell.qml'), `import QtQuick
import Quickshell
import Quickshell.Io
import "view"
ShellRoot {
  WorkbenchHost { id: view; manifest: (${WORKBENCH_RELEASE.assets['manifest.json']}) }
  IpcHandler {
    target: "fixture"
    function capabilities(unused: string): string { return view.capabilities() }
    function presentationContract(unused: string): string { return view.presentationContract() }
    function dispatch(payload: string): string { return view.dispatch(payload) }
    function clickPane(): void {
      view.requestConfirmation({kind: "present", target: view.projection.observedSessions[0].terminalNavigation.target, payload: {}})
    }
    function clickClose(): void { view.requestHide() }
    function isOpen(): string { return String(view.opened) }
  }
}`)
  const qs = spawn('/usr/bin/qs', ['-p', root], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', exit: number | null = null, failure: Error | null = null
  const kill = () => { if (qs.pid) { try { process.kill(-qs.pid, 'SIGKILL') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e } } }
  const exited = new Promise<void>(resolve => {
    qs.once('error', error => { failure = error; resolve() })
    qs.once('exit', code => { exit = code; resolve() })
  })
  for (const stream of [qs.stdout, qs.stderr]) stream!.on('data', chunk => {
    output = (output + String(chunk)).slice(-64 * 1024)
  })
  const deadline = setTimeout(kill, 12_000)
  let owner: Awaited<ReturnType<typeof startNativeOwner>> | null = null
  t.after(async () => {
    clearTimeout(deadline); kill(); await exited
    try { await owner?.close() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  function ipc(method: string, payload?: string): string {
    const result = spawnSync('/usr/bin/qs', ['ipc', '-n', '-p', root, 'call', '--', 'fixture', method, ...(payload === undefined ? [] : [payload])],
      { env, encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 300 * 1024 })
    if (result.error || result.status !== 0) throw Error(`private IPC unavailable: ${result.stderr}`)
    return result.stdout.trimEnd()
  }
  const readyBy = Date.now() + 4000
  let ready = false
  while (Date.now() < readyBy && !ready && !failure && exit === null) {
    try { ready = JSON.parse(ipc('capabilities', '{}')).version === WORKBENCH_RELEASE.version } catch { /* starting */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(ready, true, output || String(failure))
  const calls: string[] = []
  let focus = 0, clickStarted = 0, bridgeElapsed = 0
  owner = await startNativeOwner({ roots: { stateDir: join(root, 'state'), runtimeDir: join(root, 'owner-runtime') },
    monotonic: () => 1000, // deterministic warm-click path; Qt watchdog still runs normally
    schedule(_tick, ms) { assert.equal(ms, 1000); return () => {} },
    desktop: {
      call(_plugin, method, payload) { calls.push(method === 'dispatch' ? JSON.parse(payload).method : method); return ipc(method, payload) },
      hide() { assert.fail('unguarded hide must never be called') },
    },
  })
  const peer = { send(bytes: Buffer) {
    const frame = decodeBridgeFrame(bytes.subarray(0, -1))
    if (frame.type === 'focus_request') {
      assert.ok(owner!.runner.store.getIntentResult(frame.body.requestId as string), 'receipt persisted before bridge send')
      bridgeElapsed = performance.now() - clickStarted
      focus++; calls.push('BRIDGE_FOCUS_REQUEST')
    }
  }, close() {} }
  owner.registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('register', 'registration', {
    processInstanceId: 'p'.repeat(32), piSessionId: 'disposable-session', extensionInstanceId: 'e'.repeat(32),
    hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY],
    registrationAttempt: 1, sourceSequence: 1, lifecycle: 'running', activity: 'idle', health: 'healthy',
  }).subarray(0, -1)))
  assert.equal((await requestOwner(join(root, 'owner-runtime'), 'open')).status, 'opened', output)
  calls.length = 0
  const started = performance.now(); clickStarted = started
  ipc('clickPane')
  const focusBy = Date.now() + 2500
  while (focus === 0 && Date.now() < focusBy) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(focus, 1, output)
  assert.deepEqual(calls.slice(0, calls.indexOf('BRIDGE_FOCUS_REQUEST')), ['takeIntent'], 'one guarded read before Pi; no polling callback or cosmetic IPC')
  assert.equal(calls.filter(call => call === 'applyProjection').length, 1)
  t.diagnostic(`disposable trigger IPC -> bridge send: ${bridgeElapsed.toFixed(1)} ms; through completed Owner tick: ${(performance.now() - started).toFixed(1)} ms. Includes test-trigger IPC; not physical focus latency.`)
  calls.length = 0
  ipc('clickClose')
  const closeBy = Date.now() + 2500
  while (!calls.includes('close') && Date.now() < closeBy) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(calls, ['takeIntent', 'close'])
  assert.equal(ipc('isOpen'), 'false')
  assert.equal(owner.runner.store.listBindings().length, 0, 'navigation did not adopt')
  assert.doesNotMatch(output, /ReferenceError|TypeError|is not a function|Failed to load configuration/)
})
