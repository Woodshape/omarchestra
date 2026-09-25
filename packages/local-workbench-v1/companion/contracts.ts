/**
 * Local Workbench v1 — Phase 1 Companion packaging constants.
 *
 * The workbench is an independently packaged additive Companion release. It
 * contains only its own release; it does not copy the historical prototype
 * catalog (0.2.0/0.3.0/0.4.0) and does not alter prototype release bytes or
 * defaults. Version 0.7.0 is the accepted task-first presentation; its exact
 * bytes are retained in `retained/0.7.0/`. Version 0.8.0 is the Phase 2
 * management workbench. The pre-redesign 0.6.0 bytes are retained separately
 * in `retained/0.6.0/`. Retained releases are never part of the active
 * production catalogue.
 */

export const WORKBENCH_PLUGIN_ID = 'omarchestra.agent-console'
export const WORKBENCH_PLUGIN_VERSION = '0.10.0'

/**
 * Loaded-presentation contract. The running shell keeps the panel instance
 * alive (`keepLoaded`), so a matching file fingerprint never proves which QML
 * the shell has loaded. The loaded component answers this identifier itself.
 */
export const WORKBENCH_PRESENTATION_CONTRACT = 'task-first-v2'
export const WORKBENCH_PRESENTATION_DESTINATIONS = Object.freeze([
  'overview', 'goal', 'new_goal', 'add_agent', 'adoption_review',
  'assignment', 'checks', 'start_review', 'work', 'activity',
])
export const WORKBENCH_PROTOCOL_ID = 'omarchestra.companion/v1'

export interface WorkbenchRelease {
  pluginId: string
  version: string
  protocol: string
  /** Capability-negotiated release; package versions are recorded in the installation receipt. */
  compatibility: null
  assets: Record<string, string>
}

export interface WorkbenchPresentationContract {
  protocol: string
  pluginId: string
  version: string
  pluginGeneration: number
  presentation: string
  destinations: string[]
}

export function freezeWorkbenchRelease(release: WorkbenchRelease): WorkbenchRelease {
  return Object.freeze({
    ...release,
    assets: Object.freeze({ ...release.assets }),
  })
}
