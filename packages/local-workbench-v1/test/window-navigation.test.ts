import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { navigationFixture } from './navigation-fixture.ts'
import { showTerminalPane } from '../runner/pane-navigation.ts'
import { commandArgv, FOCUS_API_PROBE, localWindowPort, navigationRoute, showLocalTerminalPane, stdioMatchesTty, systemNavigationCommand } from '../runner/local-pane-navigation.ts'

test('standalone foreground Pi focuses only its exact original window with three complete proofs', async () => {
  for (const mode of ['lua', 'legacy'] as const) {
    const { f, runtime } = navigationFixture(); f.windowApi = mode
    assert.equal(await showLocalTerminalPane(() => true, runtime), 'shown')
    assert.deepEqual(f.mutations, [`${mode === 'lua' ? 'window-lua' : 'window'}:0xabc`])
    assert.equal(f.reads, 3)
    assert.ok(f.calls.every(call => call.file === '/usr/bin/hyprctl'), 'no Herdr lookup, focus or fake pane')
  }
  const { f, runtime } = navigationFixture()
  f.chain = [ { ...f.chain[0], parent: 70 }, f.chain.at(-1)! ] // Foot directly executes Pi
  assert.equal(await showLocalTerminalPane(() => true, runtime), 'shown')
})

test('actual entry point fixes Lua window focus after Herdr, with no standalone fallback', async () => {
  const { f, runtime } = navigationFixture(true)
  assert.equal(await showLocalTerminalPane(() => true, runtime), 'shown')
  assert.deepEqual(f.mutations, ['pane:w1:p1', 'window-lua:0xabc'])
  assert.equal(f.reads, 4)
  const unsupported = navigationFixture(true)
  unsupported.f.chain = navigationFixture().f.chain
  assert.equal(await showLocalTerminalPane(() => true, unsupported.runtime), 'unavailable')
  assert.deepEqual(unsupported.f.mutations, [], 'a failed Herdr proof never falls back to its window')
})

test('stdio must be character devices on the same controlling TTY, not just interactive', () => {
  const matches = (tty: number, devices: number[], interactive = [true, true], character = true) =>
    stdioMatchesTty(tty, interactive, fd => ({ rdev: devices[fd], isCharacterDevice: () => character }))
  assert.equal(matches(34818, [34818, 34818]), true)
  assert.equal(matches(-2147448830, [2147518466, 2147518466]), true, 'signed procfs dev_t')
  for (const devices of [[34819, 34818], [34818, 34819], [0, 0]]) assert.equal(matches(34818, devices), false)
  assert.equal(matches(34818, [34818, 34818], [false, true]), false)
  assert.equal(matches(34818, [34818, 34818], [true, false]), false)
  assert.equal(matches(34818, [34818, 34818], [true, true], false), false)
  for (const tty of [0, NaN, 0.5, 2147483648, -2147483649]) assert.equal(matches(tty, [tty >>> 0, tty >>> 0]), false)
})

test('compositor mode drift after the Herdr mutation prevents the window step', async () => {
  const { f, runtime } = navigationFixture(true)
  f.beforeRead = n => { if (n === 3) f.windowApi = 'legacy' }
  assert.equal(await showLocalTerminalPane(() => true, runtime), 'unknown')
  assert.deepEqual(f.mutations, ['pane:w1:p1'])
})

test('standalone missing, ambiguous, nonforeground, non-TTY and multiplexer arrangements never focus', async () => {
  const changes: Array<(f: ReturnType<typeof navigationFixture>['f']) => void> = [
    f => f.stdio = false, f => f.devices[0] = 3, f => f.devices[1] = 3,
    f => f.chain[0].tty = 0, f => f.chain[0].foregroundGroup = 90,
    f => { f.chain[0].group = 90; f.chain[0].foregroundGroup = 90 },
    f => f.chain[1].name = 'tmux: server', f => f.chain[1].name = 'screen', f => f.chain[1].name = 'herdr',
    f => f.chain[1].name = 'sshd', f => f.chain[1].name = 'unknown-wrapper', f => f.chain[1].tty = 3,
    f => f.chain[1].foregroundGroup = 90, f => f.chain[0].parent = 999, f => f.chain[2].name = 'footclient',
    f => f.windows = [], f => f.windows.push({ ...f.windows[0], hidden: true }),
    f => f.windows[0].pid = 999, f => f.windows[0].class = 'kitty',
    f => f.windows[0].hidden = true, f => f.windows[0].mapped = false, f => f.windows[0].address = 'activewindow',
  ]
  for (const change of changes) {
    const { f, runtime } = navigationFixture(); change(f)
    assert.equal(await showLocalTerminalPane(() => true, runtime), 'unavailable')
    assert.deepEqual(f.mutations, [])
  }
})

test('routing requires explicit local compositor and refuses every partial Herdr hint', async () => {
  for (const hint of [{ HERDR_ENV: '1' }, { HERDR_ENV: '' }, { HERDR_PANE_ID: 'w1:p1' },
    { HERDR_SOCKET_PATH: '/fixture/herdr.sock' }, { HERDR_TAB_ID: 'w1:t1' }, { HERDR_FUTURE_ROUTING: 'unknown' }]) {
    const { f, runtime } = navigationFixture(); Object.assign(f.environment, hint)
    assert.equal(await showLocalTerminalPane(() => true, runtime), 'unavailable'); assert.deepEqual(f.calls, [])
  }
  for (const patch of [{ XDG_RUNTIME_DIR: 'relative' }, { HYPRLAND_INSTANCE_SIGNATURE: 'invalid/instance' }, { HYPRLAND_INSTANCE_SIGNATURE: '' }]) {
    const { f, runtime } = navigationFixture(); Object.assign(f.environment, patch)
    assert.equal(await showLocalTerminalPane(() => true, runtime), 'unavailable'); assert.deepEqual(f.calls, [])
  }
  const { f } = navigationFixture()
  Object.defineProperty(f.environment, 'SECRET', { enumerable: true, get() { throw Error('must not read unrelated environment') } })
  const route = navigationRoute(f.environment)
  assert.equal(route.herdr, false); assert.equal(Object.hasOwn(route.environment, 'SECRET'), false)
  assert.deepEqual(route.sockets, ['/fixture/runtime/hypr/fixture/.socket.sock'])
})

test('process/window/endpoint/API drift before mutation refuses; after mutation stays unknown', async () => {
  const changes: Array<(f: ReturnType<typeof navigationFixture>['f']) => void> = [
    f => f.chain[0].start = 'replacement', f => f.chain[0].parent = 999,
    f => f.chain[0].foregroundGroup = 999, f => f.chain[1].tty = 4,
    f => f.chain.at(-1)!.start = 'reused-terminal', f => f.endpoint = 'replacement',
    f => f.windows[0].address = '0xbbb', f => f.windows = [], f => f.windowApi = 'legacy', f => f.stdio = false,
    f => f.devices[0] = 3, f => f.devices[1] = 3,
  ]
  for (const phase of [2, 3]) for (const change of changes) {
    const { f, runtime } = navigationFixture(); f.beforeRead = n => { if (n === phase) change(f) }
    assert.equal(await showLocalTerminalPane(() => true, runtime), phase === 2 ? 'unavailable' : 'unknown')
    assert.equal(f.mutations.length, phase === 2 ? 0 : 1)
  }
})

test('missing focus API is detected before any mutation, including the Herdr pane step', async () => {
  for (const herdr of [false, true]) {
    const { f, runtime } = navigationFixture(herdr); f.windowApi = 'unsupported'
    assert.equal(await showLocalTerminalPane(() => true, runtime), 'unavailable'); assert.deepEqual(f.mutations, [])
  }
})

test('failed window command, wrong active window and expired connection never fake success or retry', async () => {
  for (const kind of ['command', 'wrong-focus', 'connection']) {
    const { f, runtime } = navigationFixture()
    if (kind === 'command') f.failMutation = 'window-lua'
    if (kind === 'wrong-focus') f.movesFocus = false
    assert.equal(await showLocalTerminalPane(() => kind !== 'connection' || f.mutations.length === 0, runtime), 'unknown')
    assert.deepEqual(f.mutations, ['window-lua:0xabc'])
  }
  const { f, runtime } = navigationFixture()
  assert.equal(await showLocalTerminalPane(() => false, runtime), 'unavailable'); assert.deepEqual(f.calls, [])
})

test('standalone port ignores ancillary window content and receives bounded aborts', async () => {
  const { f, runtime } = navigationFixture()
  for (const name of ['title', 'cwd', 'argv', 'output']) Object.defineProperty(f.windows[0], name, { get() { throw Error('private field read') } })
  const port = localWindowPort({ ...runtime, endpoints: () => 'endpoint', command: async (kind, target, signal) =>
    kind === 'windows' ? f.windows : runtime.command(kind, target, signal) })
  assert.equal(await showTerminalPane(port, () => true), 'shown')
  port.inspect = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  f.mutations.length = 0
  assert.equal(await showTerminalPane(port, () => true, 10), 'unavailable'); assert.deepEqual(f.mutations, [])
})

test('compositor API parsing is exact; failures never trigger speculative legacy fallback', async () => {
  for (const reply of ['ok', 'eval is only supported with the lua config manager', 'unknown request', 'ok but different', '']) {
    const command = systemNavigationCommand({}, ((_file, _args, _options, callback) => callback(null, reply)) as any)
    const call = command('focus-api', null, new AbortController().signal)
    if (reply === 'ok') assert.equal(await call, 'lua')
    else if (reply.startsWith('eval is only')) assert.equal(await call, 'legacy')
    else await assert.rejects(call, /navigation_focus_api_unavailable/)
  }
})

test('fixed Lua dispatcher syntax parses, old syntax does not, and the capability probe cannot focus', () => {
  assert.deepEqual(commandArgv('window-lua', '0xabc'), ['/usr/bin/hyprctl', ['dispatch', 'hl.dsp.focus({window="address:0xabc"})']])
  for (const value of ['0xabc"});os.exit()--', '0xabc;focus', 'activewindow', '0x0\n']) assert.throws(() => commandArgv('window-lua', value))
  // Real Lua parser with a fake dispatcher namespace. No Hyprland/socket access.
  const code = `for _, wrapped in ipairs({false, true}) do
local constructions, dispatches = 0, 0
hl = { dsp = { focus = function(options)
  assert(options.window == "address:0x0" or options.window == "address:0xabc")
  constructions = constructions + 1
  local fn = function() dispatches = dispatches + 1 end
  -- Model current Hyprland's protected HL.Dispatcher metatable as well as
  -- a raw closure. Construction itself never executes the dispatcher.
  if wrapped then return setmetatable({}, {__metatable = "HL.Dispatcher", __call = fn}) end
  return fn
end }, dispatch = function(fn) fn() end }
${FOCUS_API_PROBE}
assert(constructions == 1 and dispatches == 0)
assert(load('return hl.dispatch(focuswindow address:0xabc)') == nil)
assert(load('return hl.dispatch(${commandArgv('window-lua', '0xabc')[1][1]})'))()
assert(constructions == 2 and dispatches == 1)
end
`
  const result = spawnSync('/usr/bin/lua', ['-'], { input: code, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
    env: { PATH: '/usr/bin:/bin' } })
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
})
