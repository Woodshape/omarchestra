import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { toggleWorkbench, type TogglePorts } from '../workbench-service-toggle.ts'

const unit = 'omarchestra-workbench-owner.service'
test('the installed one-shot never displays transient desktop notifications', () => {
  const source = readFileSync(new URL('../workbench-service-toggle.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /notify-send|Notification\s*\{|Dialog\s*\{|Popup\s*\{/)
})
function harness(options: { offline?: boolean; socket?: boolean; unitState?: string; fragment?: string; reload?: string; active?: string; startupReady?: boolean; presentation?: 'open' | 'hidden' } = {}) {
  const calls: string[] = [], actions: string[] = []
  let started = false
  const ports: TogglePorts = {
    async status() {
      if (options.offline && (!started || options.startupReady === false)) throw Error('offline')
      return { status: 'running', presentation: options.presentation ?? 'hidden' }
    },
    async action(type) { actions.push(type); return { status: type === 'open' ? 'opened' : 'hidden' } },
    systemctl(args) {
      calls.push(args.join(' '))
      if (args[0] === 'reset-failed' && args[1] === unit) return ''
      if (args[0] === 'start' && args[1] === unit) { started = true; return '' }
      if (args.includes('--property=UnitFileState')) return options.unitState ?? 'enabled'
      if (args.includes('--property=FragmentPath')) return options.fragment ?? '/owned/service'
      if (args.includes('--property=NeedDaemonReload')) return options.reload ?? 'no'
      if (args.includes('--property=ActiveState')) return options.active ?? 'inactive'
      throw Error('unknown_systemctl_call')
    },
    socketExists: () => options.socket ?? false,
    realpath: path => path,
    unitSource: '/owned/service',
    sleep: async () => {},
  }
  return { ports, calls, actions }
}

test('one bar click starts only the enabled exact user service then opens, without spawning Pi', async () => {
  const { ports, calls, actions } = harness({ offline: true })
  assert.equal(await toggleWorkbench(ports), 'opened')
  assert.deepEqual(calls, [
    `show ${unit} --property=UnitFileState --value`,
    `show ${unit} --property=FragmentPath --value`,
    `show ${unit} --property=NeedDaemonReload --value`,
    `show ${unit} --property=ActiveState --value`,
    `start ${unit}`,
  ])
  assert.deepEqual(actions, ['open'])
})

test('already running owner toggles without contacting systemd and Close leaves service alive', async () => {
  for (const [presentation, result, action] of [['hidden', 'opened', 'open'], ['open', 'hidden', 'hide']] as const) {
    const { ports, calls, actions } = harness({ presentation })
    assert.equal(await toggleWorkbench(ports), result)
    assert.deepEqual(calls, [])
    assert.deepEqual(actions, [action])
  }
})

test('no bar click starts a foreign, disabled, stale or already-active owner service', async () => {
  for (const options of [
    { socket: true }, { unitState: 'disabled' }, { fragment: '/foreign/service' },
    { reload: 'yes' }, { active: 'active' }, { active: 'activating' },
  ]) {
    const { ports, calls, actions } = harness({ offline: true, ...options })
    await assert.rejects(toggleWorkbench(ports))
    assert.equal(calls.some(call => call.startsWith('start ')), false)
    assert.deepEqual(actions, [])
  }
})

test('a failed exact service clears only its failed counter before one supervised start', async () => {
  const { ports, calls, actions } = harness({ offline: true, active: 'failed' })
  assert.equal(await toggleWorkbench(ports), 'opened')
  assert.deepEqual(calls.slice(-2), [`reset-failed ${unit}`, `start ${unit}`])
  assert.deepEqual(actions, ['open'])
})

test('service that does not become ready never fabricates an open dock', async () => {
  const { ports, calls, actions } = harness({ offline: true, startupReady: false })
  await assert.rejects(toggleWorkbench(ports), /started_but_unavailable/)
  assert.deepEqual(calls.at(-1), `start ${unit}`)
  assert.deepEqual(actions, [])
})

test('unconfirmed action, unknown status and unverifiable service fail without a fake success', async () => {
  const invalid = harness()
  invalid.ports.status = async () => ({ status: 'running', presentation: 'garbage' })
  await assert.rejects(toggleWorkbench(invalid.ports), /presentation_unknown/)
  const unconfirmed = harness()
  unconfirmed.ports.action = async () => ({ status: 'unavailable' })
  await assert.rejects(toggleWorkbench(unconfirmed.ports), /action_not_confirmed/)
  const missing = harness({ offline: true })
  missing.ports.systemctl = () => { throw Error('unit_not_installed') }
  await assert.rejects(toggleWorkbench(missing.ports), /unit_not_installed/)
})
