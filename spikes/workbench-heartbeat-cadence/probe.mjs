/** Import-inert, disposable cadence probe. No installed shell, Pi or user state. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { prepareQtFixture } from '../../packages/local-workbench-v1/test/qt-fixture.ts'
import { startNativeOwner, requestOwner } from '../../packages/local-workbench-v1/runner/native-owner.ts'
import { WORKBENCH_RELEASE } from '../../packages/local-workbench-v1/companion/releases.ts'

export async function probeCadence({ stall = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'c-'))
  let qs, owner, deadline
  let stopped = Promise.resolve()
  let output = '', exited = false, failure = null
  const calls = []
  const kill = () => { if (qs?.pid) { try { process.kill(-qs.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } } }
  try {
    prepareQtFixture(root)
    mkdirSync(join(root, 'r'), { mode: 0o700 })
    assert.ok(join(root, 'r/quickshell/by-id/1234567890/ipc.sock').length < 104, 'Qt socket path must fit sun_path')
    const env = { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'r'),
      QT_QPA_PLATFORM: 'offscreen', QT_QUICK_BACKEND: 'software', QML_IMPORT_PATH: join(root, 'imports') }
    writeFileSync(join(root, 'shell.qml'), `import QtQuick
import Quickshell
import Quickshell.Io
import "view"
ShellRoot {
  WorkbenchHost {
    id: view; manifest: (${WORKBENCH_RELEASE.assets['manifest.json']})
    property string priorConnection: "none"
    onProjectionChanged: {
      var next = projection ? projection.connection : "none"
      if (next !== priorConnection) console.log("CADENCE_STATE " + JSON.stringify({at: Date.now(), connection: next}))
      priorConnection = next
    }
    onOpenedChanged: console.log("CADENCE_OPEN " + JSON.stringify({at: Date.now(), opened: opened}))
  }
  IpcHandler {
    target: "fixture"
    function capabilities(unused: string): string { return view.capabilities() }
    function presentationContract(unused: string): string { return view.presentationContract() }
    function dispatch(payload: string): string { return view.dispatch(payload) }
  }
}`)
    qs = spawn('/usr/bin/qs', ['-p', root], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    stopped = new Promise(resolve => {
      qs.once('error', error => { failure = error; exited = true; resolve() })
      qs.once('exit', () => { exited = true; resolve() })
    })
    for (const stream of [qs.stdout, qs.stderr]) stream.on('data', chunk => { output = (output + String(chunk)).slice(-128 * 1024) })
    deadline = setTimeout(kill, 25000)
    const ipc = (method, payload) => {
      const start = Date.now()
      const result = spawnSync('/usr/bin/qs', ['ipc', '-n', '-p', root, 'call', '--', 'fixture', method, payload],
        { env, encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 300 * 1024 })
      if (result.error || result.status !== 0) throw Error(`private IPC failed: ${result.error ?? result.stderr}`)
      const reply = result.stdout.trimEnd()
      calls.push({ at: start, elapsed: Date.now() - start, method: method === 'dispatch' ? JSON.parse(payload).method : method,
        result: method === 'dispatch' ? JSON.parse(reply).result : null })
      return reply
    }
    let ready = false
    const readyBy = Date.now() + 4000
    while (!ready && Date.now() < readyBy && !exited) {
      try { ready = JSON.parse(ipc('capabilities', '{}')).version === WORKBENCH_RELEASE.version } catch { /* starting */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(ready, output || String(failure))
    owner = await startNativeOwner({ roots: { stateDir: join(root, 'state'), runtimeDir: join(root, 'owner') },
      // Real default monotonic clock and default 1000 ms periodic scheduler.
      desktop: { call(_plugin, method, payload) { return ipc(method, payload) }, hide() { assert.fail('unguarded hide') } } })
    assert.equal((await requestOwner(join(root, 'owner'), 'open')).status, 'opened')
    await new Promise(resolve => setTimeout(resolve, 12000))
    assert.equal(exited, false, output)
    const healthyEnd = Date.now()
    if (stall) {
      // Freeze only this disposable Owner's Node loop; the private Qt process
      // keeps running its real 2000 ms watchdog. No live process is signalled.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2300)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    await owner.close(); owner = null
    await new Promise(resolve => setTimeout(resolve, 30))
    kill(); await stopped
    assert.doesNotMatch(output, /ReferenceError|TypeError|is not a function|Failed to load configuration/)
    const states = [...output.matchAll(/CADENCE_STATE (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]))
    const windows = [...output.matchAll(/CADENCE_OPEN (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]))
    const beats = calls.filter(call => call.method === 'heartbeat' && call.at < healthyEnd)
    return { release: WORKBENCH_RELEASE.version, scope: 'disposable real Owner scheduler + guarded IPC + QML watchdog; substitute chrome, no Pi',
      staleTransitions: states.filter(state => state.connection === 'stale' && state.at < healthyEnd).length,
      resnapshots: beats.filter(call => call.result === 'resnapshot').length,
      heartbeatGapsMs: beats.slice(1).map((call, i) => call.at - beats[i].at), states, windows,
      fault: stall ? { blockedMs: 2300,
        staleTransitions: states.filter(state => state.at >= healthyEnd && state.connection === 'stale').length,
        resnapshots: calls.filter(call => call.at >= healthyEnd && call.method === 'heartbeat' && call.result === 'resnapshot').length,
        recovered: states.some(state => state.at >= healthyEnd && state.connection === 'connected') } : null,
      calls: calls.filter(call => call.method !== 'takeIntent') }
  } finally {
    clearTimeout(deadline)
    kill(); await stopped
    try { await owner?.close() } finally { rmSync(root, { recursive: true, force: true }) }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await probeCadence(), null, 2))
}
