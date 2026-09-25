/** Native leaf port. Only the explicitly loaded Pi extension invokes it after
 * a connection-bound user request. Routing and OS facts stay inside that Pi.
 */
import { execFile } from 'node:child_process'
import { readFileSync, lstatSync, fstatSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { showTerminalPane, type PaneNavigationPort } from './pane-navigation.ts'

export type NavigationCommand = 'current' | 'processes' | 'windows' | 'pane' | 'window' | 'window-lua' | 'focus-api' | 'active'
type WindowApi = 'lua' | 'legacy'
// Construct a dispatcher value, but do not invoke it or hl.dispatch. No focus.
// Current Hyprland wraps it as HL.Dispatcher userdata, not a raw Lua function.
export const FOCUS_API_PROBE = 'local d = hl.dsp.focus({window="address:0x0"}); assert(type(d) == "function" or getmetatable(d) == "HL.Dispatcher")'
const LEGACY_EVAL_REPLY = 'eval is only supported with the lua config manager'
export type CommandRunner = (command: NavigationCommand, target: string | null, signal: AbortSignal) => Promise<unknown>
const paneId = (value: unknown): value is string => typeof value === 'string' && /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(value)
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{1,16}$/.test(value)
const boundedId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_:.-]{1,128}$/.test(value)
const fail = (): never => { throw Error('local_navigation_unavailable') }

/** Enumerated commands only. No shell, caller-selected executable, terminal
 * input, attach, layout mutation, remote forwarding or fallback session. */
export function commandArgv(command: NavigationCommand, target: string | null): [string, string[]] {
  switch (command) {
    case 'current': return ['/usr/bin/herdr', ['pane', 'current', '--current']]
    case 'processes': if (!paneId(target)) return fail(); return ['/usr/bin/herdr', ['pane', 'process-info', '--pane', target]]
    case 'windows': return ['/usr/bin/hyprctl', ['-j', 'clients']]
    case 'pane': if (!paneId(target)) return fail(); return ['/usr/bin/herdr', ['agent', 'focus', target]]
    case 'window': if (!address(target)) return fail(); return ['/usr/bin/hyprctl', ['dispatch', 'focuswindow', `address:${target}`]]
    case 'window-lua': if (!address(target)) return fail(); return ['/usr/bin/hyprctl', ['dispatch', `hl.dsp.focus({window="address:${target}"})`]]
    case 'focus-api': return ['/usr/bin/hyprctl', ['eval', FOCUS_API_PROBE]]
    case 'active': return ['/usr/bin/hyprctl', ['-j', 'activewindow']]
    default: return fail()
  }
}
export function systemNavigationCommand(env: NodeJS.ProcessEnv, execute: typeof execFile = execFile): CommandRunner {
  return (command, target, signal) => new Promise((resolve, reject) => {
    const [file, args] = commandArgv(command, target)
    execute(file, args, { env, shell: false, encoding: 'utf8', timeout: 600,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal }, (error, stdout) => {
      if (error) { reject(Error('navigation_command_failed')); return }
      try {
        if (command === 'focus-api') {
          if (stdout.trim() === 'ok') resolve('lua')
          else if (stdout.trim() === LEGACY_EVAL_REPLY) resolve('legacy')
          else reject(Error('navigation_focus_api_unavailable'))
        } else if (command === 'window' || command === 'window-lua') {
          if (stdout.trim() !== 'ok') return reject(Error('navigation_window_refused'))
          resolve(null)
        } else {
          const value = JSON.parse(stdout)
          if (value?.error) return reject(Error('navigation_command_refused'))
          resolve(value)
        }
      } catch { reject(Error('navigation_invalid_response')) }
    })
  })
}
export interface LocalProcessFact { pid: number; parent: number; group: number; tty: number; foregroundGroup: number; start: string; name: string }
export function parseProcess(pid: number, stat: string): LocalProcessFact {
  const close = stat.lastIndexOf(')'), open = stat.indexOf('(')
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  if (stat.length > 8192 || open < 0 || close <= open || Number(stat.slice(0, open).trim()) !== pid) return fail()
  const parent = Number(fields[1]), group = Number(fields[2]), tty = Number(fields[4]), foregroundGroup = Number(fields[5]), start = fields[19]
  if (![parent, group, tty, foregroundGroup].every(Number.isSafeInteger) || parent < 0 || group < 1 || !/^\d+$/.test(start ?? '')) return fail()
  return { pid, parent, group, tty, foregroundGroup, start, name: stat.slice(open + 1, close) }
}
function processChain(pid: number): LocalProcessFact[] {
  const result: LocalProcessFact[] = [], seen = new Set<number>()
  for (let n = 0; n < 32 && pid > 1; n++) {
    if (seen.has(pid)) return fail()
    seen.add(pid)
    const fact = parseProcess(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'))
    result.push(fact)
    if (fact.name === 'foot') return result // bounded initial support: original Foot ancestry
    pid = fact.parent
  }
  return fail()
}
function endpoint(path: string, uid: number): string {
  if (!isAbsolute(path)) return fail()
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const st = lstatSync(parent)
    if (!st.isDirectory() || st.isSymbolicLink() || (st.uid !== uid && st.uid !== 0) || (st.mode & 0o022)) return fail()
    if (parent === '/') break
  }
  const st = lstatSync(path)
  if (!st.isSocket() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022)) return fail()
  return `${st.dev}:${st.ino}`
}

interface LocalPortOptions { command: CommandRunner; chain: () => LocalProcessFact[]; endpoints: () => string; pid: number }
async function inspectWindow(options: LocalPortOptions, chain: LocalProcessFact[], signal: AbortSignal): Promise<{ address: string; pid: number; api: WindowApi }> {
  const windows = await options.command('windows', null, signal) as any
  if (!Array.isArray(windows) || windows.length > 256) return fail()
  // Count ALL windows for this terminal process, not just whichever is visible.
  const matches = windows.filter(w => w.pid === chain.at(-1)!.pid)
  if (matches.length !== 1) return fail()
  const window = matches[0]
  if (!address(window.address) || window.mapped !== true || window.hidden !== false || window.class !== 'foot') return fail()
  const api = await options.command('focus-api', null, signal)
  if (api !== 'lua' && api !== 'legacy') return fail()
  return { address: window.address as string, pid: window.pid as number, api }
}
function windowActions(command: CommandRunner, api: () => WindowApi | null) {
  return {
    async focusWindow(target: string, signal: AbortSignal) {
      const mode = api()
      if (!mode) return fail()
      // Never retry a failed dispatch using another syntax or window.
      await command(mode === 'lua' ? 'window-lua' : 'window', target, signal)
    },
    async activeWindow(signal: AbortSignal) {
      const value = await command('active', null, signal) as any
      if (!address(value?.address)) return fail()
      return value.address as string
    },
  }
}

/** Reimplemented against public facts, not imported spike evidence. Test ports
 * provide all process/endpoint data; automated tests never inspect user state. */
export function localPanePort(options: LocalPortOptions): PaneNavigationPort {
  let api: WindowApi | null = null
  return {
    ...windowActions(options.command, () => api),
    async inspect(signal) {
      const endpoints = options.endpoints(), chain = options.chain(), self = chain[0]
      const serverIndex = chain.findIndex(p => p.name === 'herdr')
      const client = chain.findLast(p => p.name === 'herdr')
      if (!self || self.pid !== options.pid || self.tty === 0 || chain.at(-1)?.name !== 'foot'
          || serverIndex < 1 || !client || client.tty === 0 || client.tty === self.tty
          || client.foregroundGroup !== client.group) return fail()
      const response = await options.command('current', null, signal) as any
      const pane = response?.result?.pane
      if (!paneId(pane?.pane_id) || !boundedId(pane.terminal_id) || !boundedId(pane.tab_id)
          || !boundedId(pane.workspace_id) || typeof pane.focused !== 'boolean') return fail()
      const processResponse = await options.command('processes', pane.pane_id, signal) as any
      const info = processResponse?.result?.process_info
      if (info?.pane_id !== pane.pane_id || !Array.isArray(info.foreground_processes) || info.foreground_processes.length > 256
          || info.foreground_process_group_id !== self.group || !chain.slice(1, serverIndex).some(p => p.pid === info.shell_pid)
          || info.foreground_processes.filter((p: any) => p.pid === self.pid).length !== 1) return fail()
      const window = await inspectWindow(options, chain, signal)
      if (endpoints !== options.endpoints() || JSON.stringify(chain) !== JSON.stringify(options.chain())) return fail()
      api = window.api
      const identity = JSON.stringify([endpoints, chain, pane.pane_id, pane.terminal_id, pane.tab_id, pane.workspace_id, window.address, window.pid, api])
      return { identity, paneId: pane.pane_id, windowAddress: window.address, paneFocused: pane.focused }
    },
    async focusPane(target, signal) { await options.command('pane', target, signal) },
  }
}

/** Linux procfs tty_nr is signed dev_t; fstat rdev is its unsigned device
 * number for the supported PTYs. Interactive descriptors on ANOTHER TTY do not
 * prove that this Pi's UI is in its controlling-terminal/ancestor window. */
export function stdioMatchesTty(tty: number, stdio: readonly boolean[] = [process.stdin.isTTY === true, process.stdout.isTTY === true],
  stat: (fd: number) => { rdev: number; isCharacterDevice(): boolean } = fstatSync): boolean {
  if (stdio.length !== 2 || !Number.isInteger(tty) || tty === 0 || tty < -2147483648 || tty > 2147483647) return false
  return [0, 1].every(fd => {
    if (stdio[fd] !== true) return false
    const value = stat(fd)
    return value.isCharacterDevice() && value.rdev === (tty >>> 0)
  })
}

/** Only a direct foreground Pi/shell chain to its original Foot window. In
 * particular a Herdr/tmux/screen failure must never become window-only focus. */
export function localWindowPort(options: LocalPortOptions & { stdioOnTty: (tty: number) => boolean }): PaneNavigationPort {
  let api: WindowApi | null = null
  const shells = new Set(['bash', 'zsh', 'fish', 'sh', 'dash'])
  return {
    ...windowActions(options.command, () => api),
    async inspect(signal) {
      const endpoints = options.endpoints(), chain = options.chain(), self = chain[0]
      if (chain.length < 2 || chain.length > 32 || !self || !options.stdioOnTty(self.tty) || self.pid !== options.pid
          || self.tty === 0 || self.group !== self.pid || self.foregroundGroup !== self.group || chain.at(-1)?.name !== 'foot'
          || chain.slice(0, -1).some((p, i) => p.parent !== chain[i + 1].pid)
          || chain.slice(1, -1).some(p => !shells.has(p.name) || p.tty !== self.tty || p.foregroundGroup !== self.group)) return fail()
      const window = await inspectWindow(options, chain, signal)
      if (!options.stdioOnTty(self.tty) || endpoints !== options.endpoints() || JSON.stringify(chain) !== JSON.stringify(options.chain())) return fail()
      api = window.api
      return { identity: JSON.stringify(['standalone', endpoints, chain, window.address, window.pid, api]),
        paneId: null, paneFocused: null, windowAddress: window.address }
    },
    async focusPane() { return fail() }, // never manufacture a pane or query Herdr
  }
}

/** Pure routing classification. Any inherited Herdr hint requires a full Herdr
 * route; unsupported or stale metadata never falls back to a standalone window. */
export function navigationRoute(e: NodeJS.ProcessEnv) {
  const path = (value: string | undefined): value is string => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value)
  if (!path(e.XDG_RUNTIME_DIR) || !/^[A-Za-z0-9_-]{1,200}$/.test(e.HYPRLAND_INSTANCE_SIGNATURE ?? '')) return fail()
  const herdr = Object.keys(e).some(key => key.startsWith('HERDR_'))
  if (herdr && (e.HERDR_ENV !== '1' || !paneId(e.HERDR_PANE_ID) || !path(e.HERDR_SOCKET_PATH))) return fail()
  // Minimal local routing environment, never inherit remote/agent command options.
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: e.HOME, XDG_CONFIG_HOME: e.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: e.XDG_RUNTIME_DIR, HYPRLAND_INSTANCE_SIGNATURE: e.HYPRLAND_INSTANCE_SIGNATURE }
  if (herdr) Object.assign(env, { HERDR_ENV: '1', HERDR_SOCKET_PATH: e.HERDR_SOCKET_PATH, HERDR_PANE_ID: e.HERDR_PANE_ID,
    HERDR_TAB_ID: e.HERDR_TAB_ID, HERDR_WORKSPACE_ID: e.HERDR_WORKSPACE_ID })
  const compositor = join(e.XDG_RUNTIME_DIR, 'hypr', e.HYPRLAND_INSTANCE_SIGNATURE!, '.socket.sock')
  return { herdr, environment: env, sockets: herdr ? [e.HERDR_SOCKET_PATH!, compositor] : [compositor] }
}

interface LocalNavigationRuntime {
  environment?: NodeJS.ProcessEnv; pid?: number; command?: CommandRunner
  chain?: () => LocalProcessFact[]; endpoint?: (path: string) => string; stdioOnTty?: (tty: number) => boolean
}
/** Lazy explicit native boundary. Test-only injected OS ports never inspect user
 * state. Production callers supply only the addressed connection guard. No local
 * environment or routing fact is transmitted or logged. */
export async function showLocalTerminalPane(isCurrent: () => boolean, runtime: LocalNavigationRuntime = {}) {
  try {
    const route = navigationRoute(runtime.environment ?? process.env), pid = runtime.pid ?? process.pid
    const inspectEndpoint = runtime.endpoint ?? ((path: string) => endpoint(path, process.getuid!()))
    const options = { command: runtime.command ?? systemNavigationCommand(route.environment), pid,
      chain: runtime.chain ?? (() => processChain(pid)), endpoints: () => route.sockets.map(inspectEndpoint).join('|') }
    const port = route.herdr ? localPanePort(options) : localWindowPort({ ...options,
      stdioOnTty: runtime.stdioOnTty ?? (tty => stdioMatchesTty(tty)) })
    return await showTerminalPane(port, isCurrent)
  } catch { return 'unavailable' as const }
}
