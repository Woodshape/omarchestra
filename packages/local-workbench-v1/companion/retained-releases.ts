/**
 * Local Workbench v1 — retained historical Companion release bytes.
 *
 * `releases.ts` builds the active production release from the mutable plugin
 * source in `console/plugin/`. Editing that source therefore changes what the
 * package would install under a given version string. Before any redesign edits
 * QML, the exact accepted assets are frozen here so that:
 *
 * - tests can reproduce an accepted release byte-for-byte, and
 * - the manual preview can restore a receipt-backed accepted installation.
 *
 * 0.6.0 is the pre-task-first baseline and 0.7.0 is the accepted task-first
 * presentation (captured at HEAD 744598f). Phase 2 publishes the management
 * workbench as 0.8.0 so the accepted 0.7.0 bytes stay reproducible instead of
 * mutating under the same version string.
 *
 * The retained assets include the manual installation forwarder
 * (`AgentConsole.qml`) that the historical installer's panel entry point
 * requires. Retained releases are deliberately NOT part of
 * `WORKBENCH_RELEASE_CATALOG`; they exist only for reproducibility and
 * restoration. The active catalogue keeps exactly one production release.
 *
 * Each version's asset list and SHA-256 digests come from its own
 * `retained/<version>/digests.json`, so an added asset is a recorded change,
 * and `test/retained-release.test.mjs` re-verifies every recorded digest.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKBENCH_PLUGIN_ID,
  WORKBENCH_PROTOCOL_ID,
  freezeWorkbenchRelease,
  type WorkbenchRelease,
} from './contracts.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETAINED_ROOT = path.resolve(here, 'retained')

/** Forwarder file name used only by the preview (setup) release. */
export const RETAINED_FORWARDER_FILE = 'AgentConsole.qml'

interface RetainedDigestManifest {
  version: string
  algorithm: string
  pluginId: string
  protocol: string
  capturedFrom: string
  capturedAtHead: string
  capturedOnBranch: string
  assets: Record<string, string>
}

/** Recorded asset file names for one retained version, in a stable order. */
export function retainedAssetFiles(version: string): readonly string[] {
  return Object.keys(readDigests(version).assets)
}

function readDigests(version: string): RetainedDigestManifest {
  return JSON.parse(fs.readFileSync(path.join(retainedDir(version), 'digests.json'), 'utf8')) as RetainedDigestManifest
}

export interface RetainedReleaseRecord {
  /** Production release exactly as installed before the redesign. */
  release: WorkbenchRelease
  /** Preview release with the historical installer forwarder entry point. */
  previewRelease: WorkbenchRelease
  /** SHA-256 per retained file, as captured before the redesign. */
  digests: Readonly<Record<string, string>>
  /** Provenance of the capture, for audit. */
  provenance: Readonly<Record<string, string>>
}

function retainedDir(version: string): string {
  return path.join(RETAINED_ROOT, version)
}

function readRetained(version: string, name: string): string {
  return fs.readFileSync(path.join(retainedDir(version), name), 'utf8')
}

function buildBaseRelease(version: string): WorkbenchRelease {
  const compatibility = JSON.parse(readRetained(version, 'compatibility.json')) as {
    omarchy: string
    quickshell: string
  }
  const digests = readDigests(version)
  const assets: Record<string, string> = {}
  for (const name of Object.keys(digests.assets)) {
    if (name === RETAINED_FORWARDER_FILE) continue
    assets[name] = readRetained(version, name)
  }
  return freezeWorkbenchRelease({
    pluginId: WORKBENCH_PLUGIN_ID,
    version,
    protocol: WORKBENCH_PROTOCOL_ID,
    compatibility,
    assets,
  })
}

/**
 * The preview release overrides the panel entry point with a new forwarding
 * component, exactly as `manual/workbench-preview-release.ts` does. This is
 * deterministic: the forwarder bytes are retained and the manifest override is
 * a pure function of the base manifest.
 */
export function buildRetainedPreviewRelease(base: WorkbenchRelease): WorkbenchRelease {
  const manifest = JSON.parse(base.assets['manifest.json'])
  return freezeWorkbenchRelease({
    ...base,
    assets: {
      ...base.assets,
      'manifest.json': JSON.stringify({ ...manifest, entryPoints: { panel: RETAINED_FORWARDER_FILE } }),
      [RETAINED_FORWARDER_FILE]: readRetained(base.version, RETAINED_FORWARDER_FILE),
    },
  })
}

function loadRetained(version: string): RetainedReleaseRecord {
  const manifest = readDigests(version)
  const release = buildBaseRelease(version)
  return Object.freeze({
    release,
    previewRelease: buildRetainedPreviewRelease(release),
    digests: Object.freeze({ ...manifest.assets }),
    provenance: Object.freeze({
      algorithm: manifest.algorithm,
      capturedFrom: manifest.capturedFrom,
      capturedAtHead: manifest.capturedAtHead,
      capturedOnBranch: manifest.capturedOnBranch,
    }),
  })
}

/** Retained releases, keyed by version. Outside the active production catalogue. */
export const RETAINED_WORKBENCH_RELEASES: Readonly<Record<string, RetainedReleaseRecord>> = Object.freeze({
  '0.6.0': loadRetained('0.6.0'),
  '0.7.0': loadRetained('0.7.0'),
})
