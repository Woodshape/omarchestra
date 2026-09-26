/** One-shot graphical launcher. Only the exact, explicitly enabled user service may start the owner. */
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestOwner, ownerSocket } from '../packages/local-workbench-v1/runner/native-owner.ts'

const UNIT = 'omarchestra-workbench-owner.service'
const UNIT_SOURCE = fileURLToPath(new URL('./omarchestra-workbench-owner.service', import.meta.url))
const MAX_COMMAND_BYTES = 16 * 1024

export interface TogglePorts {
  status(): Promise<Record<string, unknown>>
  action(type: 'open' | 'hide'): Promise<Record<string, unknown>>
  systemctl(args: readonly string[]): string
  socketExists(): boolean
  realpath(path: string): string
  unitSource: string
  sleep(ms: number): Promise<void>
}

export function userSystemctl(args: readonly string[]): string {
  const result = spawnSync('/usr/bin/timeout', [
    '--signal=TERM', '--kill-after=2s', '12s', '/usr/bin/systemctl', '--user', ...args,
  ], { encoding: 'utf8', maxBuffer: MAX_COMMAND_BYTES, timeout: 15_000 })
  if (result.error || result.status !== 0 || result.signal) throw new Error('owner_service_command_failed')
  return result.stdout.trim()
}

export async function toggleWorkbench(ports: TogglePorts): Promise<'opened' | 'hidden'> {
  let status: Record<string, unknown> | null = null
  try { status = await ports.status() } catch { /* Only a genuinely absent socket may start the service. */ }
  if (status === null) {
    if (ports.socketExists()) throw new Error('owner_socket_unavailable; exact recovery required')
    if (ports.systemctl(['show', UNIT, '--property=UnitFileState', '--value']) !== 'enabled') throw new Error('owner_service_not_enabled')
    const fragment = ports.systemctl(['show', UNIT, '--property=FragmentPath', '--value'])
    if (!fragment || ports.realpath(fragment) !== ports.realpath(ports.unitSource)) throw new Error('owner_service_not_owned')
    if (ports.systemctl(['show', UNIT, '--property=NeedDaemonReload', '--value']) !== 'no') throw new Error('owner_service_reload_required')
    const active = ports.systemctl(['show', UNIT, '--property=ActiveState', '--value'])
    if (active !== 'inactive' && active !== 'failed') throw new Error('active_or_failed_owner_unreachable')
    // A bounded startup failure can leave systemd at start-limit-hit. Clear
    // only this exact verified unit's failed counter, then let systemd acquire
    // the single-owner lock. Never reset a live/unreachable owner.
    if (active === 'failed') ports.systemctl(['reset-failed', UNIT])
    ports.systemctl(['start', UNIT])
    for (let attempt = 0; attempt < 16; attempt++) {
      try { status = await ports.status() } catch { /* process starting */ }
      if (status !== null) break
      await ports.sleep(200)
    }
    if (status === null) throw new Error('owner_service_started_but_unavailable')
  }
  if (status.status !== 'running') throw new Error('owner_status_unavailable')
  const action = status.presentation === 'open' ? 'hide' : status.presentation === 'hidden' ? 'open' : null
  if (!action) throw new Error('owner_presentation_unknown')
  const result = await ports.action(action)
  const expected = action === 'open' ? 'opened' : 'hidden'
  if (result.status !== expected) throw new Error('owner_action_not_confirmed')
  return expected
}

export function liveTogglePorts(): TogglePorts {
  const runtimeDir = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'omarchestra-workbench-phase2-live')
  return {
    status: () => requestOwner(runtimeDir, 'status', 1500),
    action: type => requestOwner(runtimeDir, type, 5000),
    systemctl: userSystemctl,
    socketExists: () => {
      try { lstatSync(ownerSocket(runtimeDir)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    },
    realpath: path => realpathSync(path),
    unitSource: UNIT_SOURCE,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  toggleWorkbench(liveTogglePorts()).then(
    result => { process.stdout.write(`${result}\n`) },
    error => {
      const reason = error instanceof Error ? error.message : 'unknown'
      process.stderr.write(`Omarchestra Dock: ${reason}\n`)
      // Never use a transient desktop notification: the operator explicitly
      // rejected pop-ups. A failed one-shot reports only to its caller/log;
      // it must not claim the dock opened or start another Pi.
      process.exitCode = 1
    },
  )
}
