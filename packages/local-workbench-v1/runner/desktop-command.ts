/** Installed Companion command boundary. No setup, plugin loading or shell reload. */
import { spawnSync } from 'node:child_process'
import { WORKBENCH_PLUGIN_ID, WORKBENCH_PLUGIN_VERSION, WORKBENCH_PROTOCOL_ID,
  WORKBENCH_PRESENTATION_CONTRACT, WORKBENCH_PRESENTATION_DESTINATIONS } from '../companion/contracts.ts'
import type { PresentationPort } from '../console/presentation-shell.ts'
import { validateSnapshot, type WorkbenchSnapshot } from '../console/schema.ts'

const METHODS = ['capabilities', 'presentationContract', 'open', 'applyProjection', 'takeIntent', 'intentResult', 'clear'] as const
type Method = typeof METHODS[number]
const REQUIRED = ['session.open', 'session.update', 'session.intent', 'session.hide', 'session.clear', 'session.resnapshot']
const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const validGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('companion_incompatible_envelope')
  return value as Record<string, unknown>
}
function parse(value: string): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 * 1024) throw new Error('companion_response_too_large')
  try { return JSON.parse(value) } catch { throw new Error('companion_incompatible_response') }
}
export interface DesktopCommandPort {
  call(pluginId: string, method: Method, payloadJson: string): string
  hide(pluginId: string): void
}
/** Only the fixed system shell IPC wrapper is executable; bounded and no shell. */
export function systemDesktopCommand(spawn: typeof spawnSync = spawnSync): DesktopCommandPort {
  const script = '/usr/share/omarchy/bin/omarchy-shell'
  const invoke = (argv: string[], allowEmpty = false): string => {
    const result = spawn(script, argv, { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 300 * 1024,
      shell: false, env: { PATH: '/usr/bin:/bin', OMARCHY_PATH: process.env.OMARCHY_PATH ?? '',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '' } })
    if (result.error || result.status !== 0 || (!allowEmpty && !result.stdout) || Buffer.byteLength(result.stdout ?? '') > 256 * 1024) {
      throw new Error('Companion shell unavailable. Start the compatible Omarchy shell and explicitly install/enable the workbench Companion before opening.')
    }
    const output = (result.stdout ?? '').trimEnd()
    if (['unknown', 'error', 'Target not found.', 'Function not found.'].includes(output)) throw new Error('Companion method unavailable; check the installed release and reload it separately if needed.')
    return output
  }
  return {
    call(pluginId, method, payloadJson) {
      if (pluginId !== WORKBENCH_PLUGIN_ID || !(METHODS as readonly string[]).includes(method)
          || typeof payloadJson !== 'string' || Buffer.byteLength(payloadJson) > 256 * 1024) throw new Error('invalid_desktop_call')
      // An empty takeIntent readback is the normal idle state. Other methods
      // must answer; never treat their empty output as a valid acknowledgement.
      return invoke(['shell', 'call', pluginId, method, payloadJson], method === 'takeIntent')
    },
    hide(pluginId) { if (pluginId !== WORKBENCH_PLUGIN_ID) throw new Error('invalid_desktop_target'); invoke(['shell', 'hide', pluginId], true) },
  }
}
export function negotiateCompanion(port: DesktopCommandPort): number {
  const capability = exact(parse(port.call(WORKBENCH_PLUGIN_ID, 'capabilities', '{}')),
    ['protocol', 'pluginId', 'version', 'pluginGeneration', 'capabilities'])
  if (capability.protocol !== WORKBENCH_PROTOCOL_ID || capability.pluginId !== WORKBENCH_PLUGIN_ID
      || capability.version !== WORKBENCH_PLUGIN_VERSION || !validGeneration(capability.pluginGeneration)
      || !Array.isArray(capability.capabilities) || capability.capabilities.length !== REQUIRED.length
      || REQUIRED.some((v, i) => capability.capabilities![i] !== v)) throw new Error('installed Companion version, identity or capability set is incompatible')
  const presentation = exact(parse(port.call(WORKBENCH_PLUGIN_ID, 'presentationContract', '{}')),
    ['protocol', 'pluginId', 'version', 'pluginGeneration', 'presentation', 'destinations'])
  if (presentation.protocol !== WORKBENCH_PROTOCOL_ID || presentation.pluginId !== WORKBENCH_PLUGIN_ID
      || presentation.version !== WORKBENCH_PLUGIN_VERSION || presentation.pluginGeneration !== capability.pluginGeneration
      || presentation.presentation !== WORKBENCH_PRESENTATION_CONTRACT
      || JSON.stringify(presentation.destinations) !== JSON.stringify(WORKBENCH_PRESENTATION_DESTINATIONS)) {
    throw new Error('loaded Companion presentation differs from the required release; do not send a projection')
  }
  return capability.pluginGeneration
}
/** A synchronous presentation port; every call checks the loaded incarnation. */
export function createDesktopView(port: DesktopCommandPort, generation: number): PresentationPort {
  let session: { sessionId: string; pluginGeneration: number } | null = null
  const call = (method: Method, payload: unknown): string => {
    if (negotiateCompanion(port) !== generation) throw new Error('stale_plugin_generation')
    const answer = port.call(WORKBENCH_PLUGIN_ID, method, JSON.stringify(payload))
    if (answer === 'false') throw new Error(`Companion ${method} refused the current session`)
    return answer
  }
  return {
    pluginGeneration: generation,
    open(envelope) {
      const value = envelope as { session: { sessionId: string; pluginGeneration: number }; projection: WorkbenchSnapshot }
      if (!id(value?.session?.sessionId) || value.session.pluginGeneration !== generation) throw new Error('invalid_companion_session')
      validateSnapshot(value.projection)
      const result = call('open', value)
      if (result !== 'true') throw new Error('Companion open was not acknowledged')
      session = { ...value.session }
      return true
    },
    applyProjection(snapshot) {
      if (!session) throw new Error('presentation_session_missing')
      const value = validateSnapshot(snapshot)
      if (value.sessionId !== session.sessionId || value.pluginGeneration !== generation) throw new Error('presentation_session_changed')
      if (call('applyProjection', value) !== 'true') throw new Error('Companion update was not acknowledged')
      return true
    },
    takeIntent(value) {
      if (!session || JSON.stringify(value) !== JSON.stringify(session)) throw new Error('presentation_session_changed')
      const result = call('takeIntent', session)
      if (result === '""') return '' // shell can return JSON-encoded empty string
      if (result === '' || result === 'ok') return ''
      if (Buffer.byteLength(result) > 32 * 1024) throw new Error('Companion intent exceeded bound')
      // The JSON returned by takeIntent is a plain bounded request; the adapter
      // validates it again against the authoritative projection.
      parse(result)
      return result
    },
    intentResult(feedback) {
      if (!session) throw new Error('presentation_session_missing')
      if (call('intentResult', feedback) !== 'true') throw new Error('Companion outcome was not acknowledged')
      return true
    },
    close() {
      if (!session) return
      const old = session; session = null
      // A shell reload may have replaced the loaded incarnation since open.
      // Never clear or hide a different generation's presentation.
      try { if (negotiateCompanion(port) !== generation) return } catch { return }
      try { call('clear', old) } finally {
        let stillOwned = false
        try { stillOwned = negotiateCompanion(port) === generation } catch { /* unknown incarnation */ }
        if (stillOwned) port.hide(WORKBENCH_PLUGIN_ID)
      }
    },
  }
}
