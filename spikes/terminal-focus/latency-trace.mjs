/** Disposable call-path trace. All desktop/Pi endpoints are fakes; no native focus.
 * Run explicitly with Node's TypeScript support. Importing performs no I/O.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startNativeOwner, requestOwner } from '../../packages/local-workbench-v1/runner/native-owner.ts'
import { WORKBENCH_PLUGIN_ID, WORKBENCH_PLUGIN_VERSION, WORKBENCH_PROTOCOL_ID,
  WORKBENCH_PRESENTATION_CONTRACT, WORKBENCH_PRESENTATION_DESTINATIONS } from '../../packages/local-workbench-v1/companion/contracts.ts'
import { BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY,
  decodeBridgeFrame, encodeBridgeFrame } from '../../packages/local-workbench-v1/runner/bridge-protocol.ts'

export async function traceClickPath() {
  const root = mkdtempSync(join(tmpdir(), 'wb-navigation-latency-'))
  const runtimeDir = join(root, 'runtime')
  let now = 0, pending = null, owner
  const trace = []
  const capabilities = { protocol: WORKBENCH_PROTOCOL_ID, pluginId: WORKBENCH_PLUGIN_ID,
    version: WORKBENCH_PLUGIN_VERSION, pluginGeneration: 1,
    capabilities: ['session.open', 'session.update', 'session.intent', 'session.hide', 'session.clear', 'session.resnapshot'] }
  const contract = { protocol: WORKBENCH_PROTOCOL_ID, pluginId: WORKBENCH_PLUGIN_ID,
    version: WORKBENCH_PLUGIN_VERSION, pluginGeneration: 1,
    presentation: WORKBENCH_PRESENTATION_CONTRACT, destinations: WORKBENCH_PRESENTATION_DESTINATIONS }
  const desktop = {
    call(_plugin, method, encoded) {
      if (method === 'dispatch') {
        const request = JSON.parse(encoded)
        trace.push(request.method)
        let result = true
        if (request.method === 'takeIntent') { const value = pending; pending = null; result = value ? JSON.stringify(value) : '' }
        return JSON.stringify({ protocol: WORKBENCH_PROTOCOL_ID, version: WORKBENCH_PLUGIN_VERSION, pluginGeneration: 1, result })
      }
      trace.push(method)
      if (method === 'capabilities') return JSON.stringify(capabilities)
      if (method === 'presentationContract') return JSON.stringify(contract)
      if (method === 'takeIntent') { const value = pending; pending = null; return value ? JSON.stringify(value) : '' }
      return 'true'
    },
    hide() { trace.push('hide') },
  }
  try {
    owner = await startNativeOwner({ roots: { stateDir: join(root, 'state'), runtimeDir }, desktop,
      clock: () => now, monotonic: () => now })
    const peer = { send(bytes) {
      const frame = decodeBridgeFrame(bytes.subarray(0, -1))
      if (frame.type === 'focus_request') trace.push('BRIDGE_FOCUS_REQUEST')
    }, close() {} }
    owner.registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('register', 'registration', {
      processInstanceId: 'p'.repeat(32), piSessionId: 'disposable-session', extensionInstanceId: 'e'.repeat(32),
      hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY],
      registrationAttempt: 1, sourceSequence: 1, lifecycle: 'running', activity: 'idle', health: 'healthy',
    }).subarray(0, -1)))
    const opened = await requestOwner(runtimeDir, 'open')
    if (opened.status !== 'opened') throw Error('disposable open failed')
    trace.length = 0
    now += 1000; owner.tick()
    const idle = trace.splice(0)
    pending = { kind: 'present', target: owner.registry.list()[0].navigation.ticket, payload: {} }
    now += 1000; owner.tick()
    const click = [...trace], sentAt = click.indexOf('BRIDGE_FOCUS_REQUEST')
    if (sentAt < 0) throw Error('no fake bridge dispatch')
    trace.length = 0
    pending = { kind: 'hide_workbench', target: null, payload: {} }
    now += 1000; owner.tick()
    const close = [...trace]
    return { scope: 'Production composition; injected desktop and Pi peer; counts only, not elapsed time',
      idleTickShellCalls: idle, clickTick: click, shellCallsBeforeBridgeSend: sentAt,
      shellCallsAfterBridgeSend: click.length - sentAt - 1, closeTick: close,
      shellCallsThroughHide: close.indexOf('close') + 1 }
  } finally {
    try { await owner?.close() } finally { rmSync(root, { recursive: true, force: true }) }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await traceClickPath(), null, 2))
}
