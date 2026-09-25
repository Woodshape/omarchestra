// READ-ONLY SPIKE. Diagnostic candidates are not bridge identity or focus authority.
// Never import this into the product. No mutation command or terminal I/O exists here.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function processFact(pid, stat) {
  if (!Number.isSafeInteger(pid) || pid < 1 || stat.length > 8192) throw Error('invalid_process_fact')
  const close = stat.lastIndexOf(')')
  if (close < 0 || Number(stat.slice(0, stat.indexOf(' '))) !== pid) throw Error('invalid_process_fact')
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(fields[1]), tty = Number(fields[4]), startTicks = fields[19]
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(tty) || !/^\d+$/.test(startTicks ?? '')) throw Error('invalid_process_fact')
  return { pid, ppid, tty, startTicks, name: stat.slice(stat.indexOf('(') + 1, close) }
}

/** Read only topology/process fields; never retain cwd, titles, argv or agent data. */
export function paneFacts(response) {
  const list = response?.result?.panes
  if (!Array.isArray(list) || list.length > 64) throw Error('invalid_pane_inventory')
  return list.map(p => {
    if (typeof p.pane_id !== 'string' || !/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(p.pane_id)
        || typeof p.terminal_id !== 'string' || p.terminal_id.length > 128) throw Error('invalid_pane_identity')
    return { paneId: p.pane_id, terminalId: p.terminal_id }
  })
}
export function processInfo(response, pane) {
  const p = response?.result?.process_info
  if (!p || p.pane_id !== pane.paneId || !Array.isArray(p.foreground_processes) || p.foreground_processes.length > 256) throw Error('invalid_pane_process_info')
  const pids = p.foreground_processes.map(p => p.pid)
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw Error('invalid_pane_process_info')
  return { ...pane, pids }
}
export function windowFacts(response) {
  if (!Array.isArray(response) || response.length > 256) throw Error('invalid_window_inventory')
  return response.map(w => {
    if (typeof w.address !== 'string' || !/^0x[0-9a-f]+$/.test(w.address) || !Number.isSafeInteger(w.pid)
        || w.pid < 1 || typeof w.mapped !== 'boolean' || typeof w.hidden !== 'boolean') throw Error('invalid_window_identity')
    return { address: w.address, pid: w.pid, mapped: w.mapped, hidden: w.hidden }
  })
}
export function focusSchemaFacts(schema) {
  const req = schema?.schemas?.request
  if (!Array.isArray(req?.oneOf) || !req.$defs) throw Error('invalid_api_schema')
  const methods = {}
  for (const name of ['pane.focus', 'agent.focus']) {
    const entry = req.oneOf.find(v => v.properties?.method?.const === name)
    const ref = entry?.properties?.params?.$ref?.split('/').at(-1)
    if (!ref || !req.$defs[ref]?.properties) throw Error('missing_focus_method')
    methods[name] = Object.keys(req.$defs[ref].properties).sort()
  }
  return { protocol: schema.protocol, methods,
    snapshotFields: Object.keys(schema.schemas.success_response.$defs.SessionSnapshot.properties).sort() }
}

/** Non-authoritative diagnostic only: detects shared windows and changed PIDs.
 * A candidate never permits a focus operation or changes Adoption eligibility.
 */
export function diagnoseCandidate(before, after, panes, windows) {
  const same = before.length === after.length && before.every((p, i) => {
    const q = after[i]
    return p.pid === q.pid && p.ppid === q.ppid && p.startTicks === q.startTicks && p.tty === q.tty && p.name === q.name
  })
  if (!same || before.length === 0) return { kind: 'unavailable', reason: 'process_chain_changed' }
  if (before[0].tty === 0) return { kind: 'unavailable', reason: 'no_controlling_terminal' }
  const paneCandidates = panes.filter(p => p.pids.includes(before[0].pid))
  if (paneCandidates.length > 1) return { kind: 'unavailable', reason: 'ambiguous_pane' }
  const windowCandidates = windows.filter(w => w.mapped && !w.hidden && before.some(p => p.pid === w.pid))
  if (windowCandidates.length !== 1) return { kind: 'unavailable', reason: windowCandidates.length ? 'ambiguous_window' : 'no_window_candidate' }
  if (before.some(p => p.name === 'herdr') && paneCandidates.length !== 1) return { kind: 'unavailable', reason: 'unresolved_multiplexer_pane' }
  return { kind: 'diagnostic_candidate', paneId: paneCandidates[0]?.paneId ?? null,
    terminalId: paneCandidates[0]?.terminalId ?? null, windowAddress: windowCandidates[0].address,
    focusAllowed: false, reason: 'no_bridge_or_atomic_attachment_proof' }
}

// Fixed argv, local-only reads, bounded output/time, no shell and no implicit launch.
function readCommand(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
}
function chain(pid) {
  const facts = [], seen = new Set()
  for (let depth = 0; depth < 32 && pid > 1; depth++) {
    if (seen.has(pid)) throw Error('cyclic_process_chain')
    seen.add(pid)
    const fact = processFact(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'))
    facts.push(fact); pid = fact.ppid
  }
  if (pid > 1) throw Error('process_chain_too_deep')
  return facts
}
export function inspectLocal(pids) {
  if (process.env.HERDR_ENV !== '1') throw Error('inspect from an explicitly selected Herdr pane, not the desktop-focused default')
  const before = pids.map(chain)
  const schema = focusSchemaFacts(JSON.parse(readCommand('/usr/bin/herdr', ['api', 'schema', '--json'])))
  const panes = paneFacts(JSON.parse(readCommand('/usr/bin/herdr', ['pane', 'list'])))
    .map(p => processInfo(JSON.parse(readCommand('/usr/bin/herdr', ['pane', 'process-info', '--pane', p.paneId])), p))
  const windows = windowFacts(JSON.parse(readCommand('/usr/bin/hyprctl', ['-j', 'clients'])))
  return { scope: 'read-only diagnostic; no bridge correlation, focus or Adoption', schema,
    candidates: pids.map((pid, i) => ({ pid, ...diagnoseCandidate(before[i], chain(pid), panes, windows) })) }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const pids = process.argv.slice(3).map(v => /^\d+$/.test(v) ? Number(v) : NaN)
    if (process.argv[2] !== '--inspect-local' || !pids.length || pids.length > 8 || pids.some(p => !Number.isSafeInteger(p) || p < 1)) {
      throw Error('usage: node probe.mjs --inspect-local PID [PID ...] (read-only, current Herdr session only)')
    }
    console.log(JSON.stringify(inspectLocal(pids), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
