import { WORKBENCH_RELEASE } from '../packages/local-workbench-v1/companion/releases.ts'

// Setup-only adapter for the historical installer's exact AgentConsole.qml
// entry-point requirement. This is a new forwarding component, not a copied
// historical console and not a second runtime. Package source assets are intact.
const manifest = JSON.parse(WORKBENCH_RELEASE.assets['manifest.json'])
export const WORKBENCH_PREVIEW_RELEASE = {
  ...WORKBENCH_RELEASE,
  assets: {
    ...WORKBENCH_RELEASE.assets,
    'manifest.json': JSON.stringify({ ...manifest, entryPoints: { ...manifest.entryPoints, panel: 'AgentConsole.qml' } }),
    'AgentConsole.qml': 'import QtQuick\n\nWorkbenchHost { }\n',
  },
}
