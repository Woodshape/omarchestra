/**
 * Local Workbench v1 — Phase 1 Companion packaging constants.
 *
 * The workbench is an independently packaged additive Companion release. Its
 * active source lives directly in `console/plugin/`; the current release
 * version is metadata, not a source directory. Historical source belongs to
 * Git history, not copied bundles under `retained/`. The prototype catalog
 * (0.2.0/0.3.0/0.4.0) remains separate and unchanged.
 */

export const WORKBENCH_PLUGIN_ID = 'omarchestra.agent-console'
export const WORKBENCH_PLUGIN_VERSION = '0.14.0'

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
