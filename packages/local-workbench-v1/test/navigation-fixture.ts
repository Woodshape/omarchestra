/** Fake OS/CLI facts for the actual native navigation entry point. No host I/O. */
import { type execFile } from 'node:child_process'
import { FOCUS_API_PROBE, stdioMatchesTty, systemNavigationCommand, type LocalProcessFact } from '../runner/local-pane-navigation.ts'

export function navigationFixture(herdr = false) {
  const fact = (pid: number, parent: number, name: string, tty: number, group: number, foregroundGroup: number): LocalProcessFact =>
    ({ pid, parent, name, tty, group, foregroundGroup, start: String(pid) })
  const self = fact(100, 90, 'pi', 2, 100, 100), shell = fact(90, herdr ? 80 : 70, 'bash', 2, 90, 100)
  const terminal = fact(70, 1, 'foot', 0, 70, -1)
  const f = {
    chain: herdr ? [self, shell, fact(80, 75, 'herdr', 1, 80, 75), fact(75, 60, 'herdr', 1, 75, 75), fact(60, 70, 'bash', 1, 60, 75), terminal] : [self, shell, terminal],
    environment: { XDG_RUNTIME_DIR: '/fixture/runtime', HYPRLAND_INSTANCE_SIGNATURE: 'fixture',
      ...(herdr ? { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/fixture/herdr.sock', HERDR_PANE_ID: 'w1:p1' } : {}) } as NodeJS.ProcessEnv,
    windowApi: 'lua' as 'lua' | 'legacy' | 'unsupported', stdio: true, devices: [2, 2], endpoint: 'original',
    windows: [{ pid: 70, address: '0xabc', mapped: true, hidden: false, class: 'foot' }], active: '0xdef',
    pane: { pane_id: 'w1:p1', terminal_id: 'term_1', tab_id: 'w1:t1', workspace_id: 'w1', focused: false },
    processes: { pane_id: 'w1:p1', shell_pid: 90, foreground_process_group_id: 100, foreground_processes: [{ pid: 100 }] },
    calls: [] as Array<{ file: string; args: string[] }>, mutations: [] as string[], reads: 0,
    beforeRead: (_read: number) => {}, onMutation: (_kind: string) => {}, failMutation: '', movesFocus: true,
  }
  const execute = ((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    f.calls.push({ file, args: [...args] })
    const json = (value: unknown) => callback(null, JSON.stringify(value))
    if (file === '/usr/bin/herdr' && args.join(' ') === 'pane current --current') return json({ result: { pane: f.pane } })
    if (file === '/usr/bin/herdr' && args.join(' ') === `pane process-info --pane ${f.pane.pane_id}`) return json({ result: { process_info: f.processes } })
    if (file === '/usr/bin/hyprctl' && args.join(' ') === '-j clients') {
      f.beforeRead(++f.reads); return json(f.windows)
    }
    if (file === '/usr/bin/hyprctl' && args[0] === 'eval' && args[1] === FOCUS_API_PROBE) return callback(null,
      f.windowApi === 'lua' ? 'ok' : f.windowApi === 'legacy' ? 'eval is only supported with the lua config manager' : 'unsupported focus API')
    if (file === '/usr/bin/hyprctl' && args.join(' ') === '-j activewindow') return json({ address: f.active })
    let kind: string, target: string
    if (file === '/usr/bin/herdr' && args[0] === 'agent' && args[1] === 'focus' && args[2] === f.pane.pane_id) {
      kind = 'pane'; target = args[2]; f.pane.focused = true
    } else if (file === '/usr/bin/hyprctl' && args[0] === 'dispatch') {
      const lua = /^hl\.dsp\.focus\(\{window="address:(0x[0-9a-f]+)"\}\)$/.exec(args[1])
      if (lua) { kind = 'window-lua'; target = lua[1] }
      else if (args[1] === 'focuswindow' && /^address:0x[0-9a-f]+$/.test(args[2] ?? '')) { kind = 'window'; target = args[2].slice(8) }
      else throw Error('unexpected fake dispatch argv')
      f.mutations.push(`${kind}:${target}`)
      if ((kind === 'window' && f.windowApi !== 'legacy') || (kind === 'window-lua' && f.windowApi !== 'lua')) return callback(null, 'Lua parse error or invalid dispatcher')
      f.onMutation(kind)
      if (f.failMutation === kind) return callback(Error('fake command failed'), 'private command output')
      if (f.movesFocus) f.active = target
      return callback(null, 'ok')
    } else throw Error(`unexpected fake navigation executable: ${file}`)
    f.mutations.push(`${kind}:${target}`); f.onMutation(kind)
    if (f.failMutation === kind) return callback(Error('fake command failed'), 'private command output')
    return json({ result: { type: 'agent_info' } })
  }) as unknown as typeof execFile
  const runtime = { environment: f.environment, pid: 100, command: systemNavigationCommand({ PATH: '/usr/bin:/bin' }, execute),
    chain: () => structuredClone(f.chain), endpoint: (path: string) => `${path}:${f.endpoint}`,
    stdioOnTty: (tty: number) => stdioMatchesTty(tty, [f.stdio, f.stdio], fd => ({ rdev: f.devices[fd], isCharacterDevice: () => true })) }
  return { f, runtime }
}
