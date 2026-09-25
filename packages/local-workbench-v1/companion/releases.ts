/**
 * Local Workbench v1 — additive Companion release.
 *
 * This package contains only its own active release (0.13.0). It does not copy
 * the historical prototype catalog (0.2.0/0.3.0/0.4.0) and does not alter
 * prototype release bytes or defaults. The active release assets are read from
 * the plugin directory so the packaged bytes are always identical to the
 * source. The accepted 0.6.0 and 0.7.0 assets are retained separately so they
 * stay reproducible after the source changes. The exact installed 0.9.0
 * assets and the exact installed 0.10.0/0.11.0/0.12.0 assets are retained.
 * The installed 0.12.0 preflight was receipt-validated before publishing 0.13.0.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WORKBENCH_PLUGIN_ID,
  WORKBENCH_PLUGIN_VERSION,
  WORKBENCH_PROTOCOL_ID,
  freezeWorkbenchRelease,
  type WorkbenchRelease,
} from './contracts.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(here, '..', 'console', 'plugin')

function readQml(name: string): string {
  return fs.readFileSync(path.join(PLUGIN_DIR, name), 'utf8')
}

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  id: WORKBENCH_PLUGIN_ID,
  name: 'Local Workbench',
  version: WORKBENCH_PLUGIN_VERSION,
  author: 'Omarchestra',
  license: 'MIT',
  description: 'Presentation-only Local Workbench console for a committed team projection.',
  kinds: ['panel', 'bar-widget'],
  activation: 'on-demand',
  keepLoaded: true,
  companion: { protocol: WORKBENCH_PROTOCOL_ID },
  entryPoints: { panel: 'WorkbenchHost.qml', barWidget: 'WorkbenchBarWidget.qml' },
  barWidget: { displayName: 'Omarchestra', description: 'Open or hide the Workbench dock',
    category: 'Development', allowMultiple: false, defaultSection: 'right' },
})

export const WORKBENCH_RELEASE: WorkbenchRelease = freezeWorkbenchRelease({
  pluginId: WORKBENCH_PLUGIN_ID,
  version: WORKBENCH_PLUGIN_VERSION,
  protocol: WORKBENCH_PROTOCOL_ID,
  compatibility: null, // ADR 0005: shell/plugin API and loaded release, not a package-version pin.
  assets: {
    'manifest.json': MANIFEST,
    'WorkbenchConsole.qml': readQml('WorkbenchConsole.qml'),
    'WorkbenchHost.qml': readQml('WorkbenchHost.qml'),
    'WorkbenchBarWidget.qml': readQml('WorkbenchBarWidget.qml'),
    'WorkbenchOverview.qml': readQml('WorkbenchOverview.qml'),
    'WorkbenchAction.qml': readQml('WorkbenchAction.qml'),
    'WorkbenchTextArea.qml': readQml('WorkbenchTextArea.qml'),
    'WorkbenchTextField.qml': readQml('WorkbenchTextField.qml'),
    'WorkbenchCards.qml': readQml('WorkbenchCards.qml'),
    'WorkbenchBoard.qml': readQml('WorkbenchBoard.qml'),
    'WorkbenchGoal.qml': readQml('WorkbenchGoal.qml'),
    'WorkbenchAssignmentForm.qml': readQml('WorkbenchAssignmentForm.qml'),
    'WorkbenchChecks.qml': readQml('WorkbenchChecks.qml'),
    'WorkbenchReview.qml': readQml('WorkbenchReview.qml'),
  },
})

export const WORKBENCH_RELEASE_CATALOG: Readonly<Record<string, WorkbenchRelease>> = Object.freeze({
  [WORKBENCH_RELEASE.version]: WORKBENCH_RELEASE,
})
