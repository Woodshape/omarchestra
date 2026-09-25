/** Installed Companion command boundary. No setup, plugin loading or shell reload. */
import { spawnSync } from 'node:child_process'
import { WORKBENCH_PLUGIN_ID, WORKBENCH_PLUGIN_VERSION, WORKBENCH_PROTOCOL_ID,
  WORKBENCH_PRESENTATION_CONTRACT, WORKBENCH_PRESENTATION_DESTINATIONS } from '../companion/contracts.ts'
import { PresentationRefreshUnavailable, type PresentationPort } from '../console/presentation-shell.ts'
import { validateSnapshot, type WorkbenchSnapshot } from '../console/schema.ts'

const METHODS = ['capabilities', 'presentationContract', 'open', 'applyProjection', 'takeIntent', 'intentResult', 'clear', 'dispatch'] as const
type Method = typeof METHODS[number]
class ChangedCompanion extends Error {}
export class DesktopCommandUnavailableError extends Error {
  constructor() { super('Companion shell unavailable. Start the compatible Omarchy shell and explicitly install/enable the workbench Companion before opening.'); this.name = 'DesktopCommandUnavailableError' }
}
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
      throw new DesktopCommandUnavailableError()
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
/** One guarded IPC per operation. The loaded component checks the complete
 * negotiated identity inside the same invocation as the requested operation. */
export function createDesktopView(port: DesktopCommandPort, generation: number, wakeSocket?: string): PresentationPort {
  let session: { sessionId: string; pluginGeneration: number } | null = null
  let displayed = ''
  const visible = (snapshot: WorkbenchSnapshot) => JSON.stringify({ ...snapshot, cursor: 0 })
  const call = (method: Method | 'close' | 'heartbeat', payload: unknown): string => {
    let encoded: string
    try {
      encoded = port.call(WORKBENCH_PLUGIN_ID, 'dispatch', JSON.stringify({
        protocol: WORKBENCH_PROTOCOL_ID, pluginId: WORKBENCH_PLUGIN_ID, version: WORKBENCH_PLUGIN_VERSION,
        presentation: WORKBENCH_PRESENTATION_CONTRACT, pluginGeneration: generation, method, payload,
      }))
    } catch (error) {
      if ((method === 'heartbeat' || method === 'applyProjection') && error instanceof DesktopCommandUnavailableError)
        throw new PresentationRefreshUnavailable()
      throw error
    }
    const response = exact(parse(encoded), ['protocol', 'version', 'pluginGeneration', 'result'])
    if (response.protocol !== WORKBENCH_PROTOCOL_ID || typeof response.version !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(response.version) || !validGeneration(response.pluginGeneration)
        || !['string', 'boolean'].includes(typeof response.result)) throw new Error('companion_incompatible_response')
    if (response.pluginGeneration !== generation) throw new ChangedCompanion('stale_plugin_generation')
    if (response.version !== WORKBENCH_PLUGIN_VERSION || response.result === false)
      throw new Error(`Companion ${method} refused the current session`)
    return String(response.result)
  }
  return {
    pluginGeneration: generation,
    open(envelope) {
      const value = envelope as { session: { sessionId: string; pluginGeneration: number }; projection: WorkbenchSnapshot }
      if (!id(value?.session?.sessionId) || value.session.pluginGeneration !== generation) throw new Error('invalid_companion_session')
      validateSnapshot(value.projection)
      const result = call('open', { ...value, wakeSocket: wakeSocket ?? null })
      if (result !== 'true') throw new Error('Companion open was not acknowledged')
      session = { ...value.session }
      displayed = visible(value.projection)
      return true
    },
    applyProjection(snapshot) {
      if (!session) throw new Error('presentation_session_missing')
      const value = validateSnapshot(snapshot)
      if (value.sessionId !== session.sessionId || value.pluginGeneration !== generation) throw new Error('presentation_session_changed')
      const encoded = visible(value)
      const unchanged = encoded === displayed
      let result = unchanged ? call('heartbeat', { ...session, revision: value.revision, cursor: value.cursor })
        : call('applyProjection', value)
      if (result === 'resnapshot') result = call('applyProjection', value)
      if (result !== 'true') throw new Error('Companion update was not acknowledged')
      displayed = encoded // Only after the real loaded view acknowledged it.
      return true
    },
    takeIntent(value) {
      if (!session || JSON.stringify(value) !== JSON.stringify(session)) throw new Error('presentation_session_changed')
      const result = call('takeIntent', session)
      if (result === '') return '' // The guarded reply has one exact empty value.
      if (Buffer.byteLength(result) > 32 * 1024) throw new Error('Companion intent exceeded bound')
      // The JSON returned by takeIntent is a plain bounded request; the adapter
      // validates it again against the authoritative projection.
      parse(result)
      return result
    },
    intentResult(feedback) {
      if (!session) throw new Error('presentation_session_missing')
      // A local submitted indicator is not an acknowledgement. Avoid blocking
      // real dispatch on this cosmetic round trip; committed outcomes still
      // follow the successfully displayed snapshot barrier.
      if ((feedback as { status?: string })?.status === 'submitted') return true
      if (call('intentResult', feedback) !== 'true') throw new Error('Companion outcome was not acknowledged')
      return true
    },
    close() {
      if (!session) return
      const old = session; session = null
      // Clear and hide only the addressed view, atomically with the generation
      // check. Never issue an unguarded shell hide against a successor instance.
      try {
        if (call('close', old) !== 'true') throw new Error('Companion close was not acknowledged')
      } catch (error) {
        // A verified successor must be left alone. Other failures are unknown,
        // not a successful hide; propagate them to the Owner's command result.
        if (!(error instanceof ChangedCompanion)) throw error
      }
    },
  }
}
