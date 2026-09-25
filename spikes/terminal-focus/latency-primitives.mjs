/** Explicit read-only local timing. Never call takeIntent, focus, open or hide.
 * Output contains only aggregate durations, not native response metadata.
 */
import { pathToFileURL } from 'node:url'
import { systemDesktopCommand } from '../../packages/local-workbench-v1/runner/desktop-command.ts'
import { systemNavigationCommand } from '../../packages/local-workbench-v1/runner/local-pane-navigation.ts'

export async function measureReadOnlyPrimitives() {
  const e = process.env
  if (e.HERDR_ENV !== '1') throw Error('Requires existing Herdr caller context')
  const env = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'HYPRLAND_INSTANCE_SIGNATURE',
    'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID']
    .filter(k => e[k] !== undefined).map(k => [k, e[k]]))
  env.PATH = '/usr/bin:/bin'; env.HERDR_ENV = '1'
  const nav = systemNavigationCommand(env), desktop = systemDesktopCommand(), signal = new AbortController().signal
  const samples = { capabilities: [], presentationContract: [], paneCurrent: [], paneProcessInfo: [],
    windowList: [], activeWindow: [], inspectionReadCommands: [] }
  const time = async (name, fn) => {
    const start = performance.now(), result = await fn()
    samples[name].push(performance.now() - start)
    return result
  }
  for (let n = 0; n < 10; n++) {
    await time('capabilities', () => desktop.call('omarchestra.agent-console', 'capabilities', '{}'))
    await time('presentationContract', () => desktop.call('omarchestra.agent-console', 'presentationContract', '{}'))
    const start = performance.now()
    const current = await time('paneCurrent', () => nav('current', null, signal))
    const id = current?.result?.pane?.pane_id
    if (typeof id !== 'string') throw Error('Caller pane unavailable')
    await time('paneProcessInfo', () => nav('processes', id, signal))
    await time('windowList', () => nav('windows', null, signal))
    samples.inspectionReadCommands.push(performance.now() - start)
    await time('activeWindow', () => nav('active', null, signal))
  }
  const stats = xs => {
    const s = [...xs].sort((a, b) => a - b), round = x => Math.round(x * 10) / 10
    return { n: s.length, minMs: round(s[0]), medianMs: round((s[4] + s[5]) / 2), p90Ms: round(s[8]), maxMs: round(s.at(-1)) }
  }
  return { scope: 'Read-only native primitives; no takeIntent, no focus, no full-click timing',
    measurements: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values)])) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only-local') throw Error('Usage: node latency-primitives.mjs --read-only-local')
  console.log(JSON.stringify(await measureReadOnlyPrimitives(), null, 2))
}
