import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeBridgeFrame, BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY } from '../runner/bridge-protocol.ts'
import { validateTerminalNavigation } from '../console/schema.ts'
import { showTerminalPane } from '../runner/pane-navigation.ts'
import { localPanePort, commandArgv, parseProcess, systemNavigationCommand, type LocalProcessFact } from '../runner/local-pane-navigation.ts'

test('navigation wire is capability-negotiated, closed and carries no local routing facts', () => {
  const registration = { processInstanceId: 'p'.repeat(32), piSessionId: 's', extensionInstanceId: 'e'.repeat(32),
    hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY],
    registrationAttempt: 1, sourceSequence: 1, lifecycle: 'running', activity: 'idle', health: 'healthy' }
  assert.doesNotThrow(() => encodeBridgeFrame('register', 'r', registration))
  const body = { connectionId: 'c'.repeat(32), connectionChallenge: 'd'.repeat(32), sourceSequence: 1, requestId: 'r', status: 'shown' }
  assert.doesNotThrow(() => encodeBridgeFrame('focus_result', 'm', body))
  for (const patch of [{ status: ['shown'] }, { status: 'focused-exactly' }, { pid: 100 }, { path: '/private' }, { paneId: 'w1:p1' }, { title: 'private' }]) {
    assert.throws(() => encodeBridgeFrame('focus_result', 'm', { ...body, ...patch }))
  }
  const navigation = { target: 'ticket', enabled: true, state: 'idle', reason: 'Checked navigation.' }
  assert.doesNotThrow(() => validateTerminalNavigation(navigation))
  for (const patch of [{ pid: 100 }, { target: null }, { state: 'checking' }, { state: 'focused-exactly' }]) assert.throws(() => validateTerminalNavigation({ ...navigation, ...patch }))
})

function fixture() {
  const fact = (pid: number, parent: number, name: string): LocalProcessFact => ({ pid, parent, name, group: 100, tty: name === 'herdr' ? 1 : 2, foregroundGroup: 100, start: String(pid) })
  const f = { chain: [fact(100, 90, 'pi'), fact(90, 80, 'bash'), fact(80, 70, 'herdr'), fact(70, 60, 'foot')],
    endpoint: 'endpoint', pane: { pane_id: 'w1:p1', terminal_id: 'term_1', tab_id: 'w1:t1', workspace_id: 'w1', focused: false },
    processes: { pane_id: 'w1:p1', shell_pid: 90, foreground_process_group_id: 100, foreground_processes: [{ pid: 100 }] },
    windows: [{ pid: 70, address: '0xabc', mapped: true, hidden: false, class: 'foot' }],
    active: '0xdef', mutations: [] as string[], inspections: 0,
    change: (_n: number) => {}, failMutation: '', activeWrong: false }
  const port = localPanePort({ pid: 100, chain: () => structuredClone(f.chain), endpoints: () => f.endpoint,
    command: async (command, target) => {
      if (command === 'current') { f.change(++f.inspections); return { result: { pane: f.pane } } }
      if (command === 'processes') return { result: { process_info: f.processes } }
      if (command === 'windows') return f.windows
      if (command === 'active') return { address: f.activeWrong ? '0xbad' : f.active }
      f.mutations.push(`${command}:${target}`)
      if (f.failMutation === command) throw Error('command_timeout')
      if (command === 'pane') f.pane.focused = true
      if (command === 'window') f.active = target!
      return null
    } })
  return { f, port }
}

test('same-window panes route pane first, exact window second; all pre/post checks pass', async () => {
  for (const id of ['w1:p1', 'w1:p9']) {
    const { f, port } = fixture(); f.pane.pane_id = f.processes.pane_id = id
    assert.equal(await showTerminalPane(port, () => true), 'shown')
    assert.deepEqual(f.mutations, [`pane:${id}`, 'window:0xabc'])
    assert.equal(f.inspections, 4)
  }
})

test('local correlation discards ancillary titles, arguments, paths and content', async () => {
  const { f, port } = fixture()
  const forbidden = () => { throw Error('private metadata must not be read') }
  for (const value of [f.pane, f.processes, f.processes.foreground_processes[0], f.windows[0]]) {
    for (const name of ['title', 'cwd', 'argv', 'output', 'environment']) Object.defineProperty(value, name, { get: forbidden })
  }
  assert.equal(await showTerminalPane(port, () => true), 'shown')
})

test('unsupported, missing, ambiguous and stale preflight never mutates focus', async () => {
  const changes = [
    f => f.chain[0].tty = 0, f => f.chain[2].name = 'unknown', f => f.chain[3].name = 'other',
    f => f.chain[2].foregroundGroup = 999, f => f.chain[2].tty = f.chain[0].tty,
    f => f.processes.shell_pid = 70, f => f.processes.shell_pid = 999, f => f.processes.foreground_process_group_id = 999,
    f => f.processes.foreground_processes = [], f => f.processes.pane_id = 'w1:p9',
    f => f.windows = [], f => f.windows.push({ ...f.windows[0], address: '0xbbb' }),
    f => f.windows[0].hidden = true, f => f.windows[0].mapped = false,
    f => f.windows[0].class = 'other', f => f.windows[0].address = 'activewindow',
  ] as ((f: ReturnType<typeof fixture>['f']) => void)[]
  for (const change of changes) {
    const { f, port } = fixture(); change(f)
    assert.equal(await showTerminalPane(port, () => true), 'unavailable')
    assert.deepEqual(f.mutations, [])
  }
})

test('reused PID/start/parent/TTY, changed pane and replaced endpoint before dispatch fail closed', async () => {
  const changes = [f => f.chain[0].start = 'reused', f => f.chain[0].parent = 999,
    f => f.chain[0].tty = 4, f => f.endpoint = 'replacement', f => f.pane.terminal_id = 'replacement'] as ((f: ReturnType<typeof fixture>['f']) => void)[]
  for (const change of changes) {
    const { f, port } = fixture(); f.change = n => { if (n === 2) change(f) }
    assert.equal(await showTerminalPane(port, () => true), 'unavailable')
    assert.deepEqual(f.mutations, [])
  }
})

test('after possible mutation window loss, pane replacement, failed commands and wrong focus are unknown', async () => {
  for (const phase of ['before-window', 'after-window', 'pane', 'window', 'wrong-active', 'wrong-pane']) {
    const { f, port } = fixture()
    if (phase === 'before-window') f.change = n => { if (n === 3) f.windows = [] }
    if (phase === 'after-window') f.change = n => { if (n === 4) f.pane.terminal_id = 'replacement' }
    if (phase === 'wrong-pane') f.change = n => { if (n === 4) f.pane.focused = false }
    f.failMutation = phase; f.activeWrong = phase === 'wrong-active'
    assert.equal(await showTerminalPane(port, () => true), 'unknown')
    assert.equal(f.mutations.length, phase === 'before-window' || phase === 'pane' ? 1 : 2)
  }
})

test('obsolete connection cancels further dispatch, but cannot undo a completed pane switch', async () => {
  const { f, port } = fixture()
  assert.equal(await showTerminalPane(port, () => false), 'unavailable')
  assert.equal(f.inspections, 0)
  assert.equal(await showTerminalPane(port, () => f.mutations.length === 0), 'unknown')
  assert.deepEqual(f.mutations, ['pane:w1:p1'])
})

test('hung inspection receives a real abort and never dispatches', async () => {
  const { f, port } = fixture()
  port.inspect = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  assert.equal(await showTerminalPane(port, () => true, 10), 'unavailable')
  assert.deepEqual(f.mutations, [])
})

test('fixed argv rejects target injection and all unknown commands', () => {
  assert.deepEqual(commandArgv('pane', 'w1:p9'), ['/usr/bin/herdr', ['agent', 'focus', 'w1:p9']])
  assert.deepEqual(commandArgv('window', '0xabc'), ['/usr/bin/hyprctl', ['dispatch', 'focuswindow', 'address:0xabc']])
  for (const target of ['--help', 'w1:p1;echo', 'activewindow', '0xabc;echo']) {
    assert.throws(() => commandArgv('pane', target)); assert.throws(() => commandArgv('window', target))
  }
  assert.throws(() => commandArgv('launch' as any, null))
})

test('native command port sets exact child kill, output and time bounds; errors never expose command output', async () => {
  const calls: any[] = [], abort = new AbortController()
  const command = systemNavigationCommand({ HOME: '/disposable' }, ((file, args, options, callback) => {
    calls.push({ file, args, options }); callback(null, '{"result":{}}')
  }) as any)
  await command('pane', 'w1:p1', abort.signal)
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout, 600)
  assert.equal(calls[0].options.killSignal, 'SIGKILL')
  assert.equal(calls[0].options.signal, abort.signal)
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024)
  const failure = systemNavigationCommand({}, ((_f, _a, _o, callback) => callback(Error('private output'), 'private output')) as any)
  await assert.rejects(failure('current', null, abort.signal), /^Error: navigation_command_failed$/)
})

test('proc stat parser preserves PID/start/parent/group/TTY and handles parenthesized names', () => {
  const fields = ['S', '90', '100', '1', '2', '100', ...Array(13).fill('0'), '12345']
  assert.deepEqual(parseProcess(100, `100 (pi (test)) ${fields.join(' ')}`), { pid: 100, parent: 90, group: 100, tty: 2, foregroundGroup: 100, start: '12345', name: 'pi (test)' })
  assert.throws(() => parseProcess(101, `100 (pi) ${fields.join(' ')}`))
})
