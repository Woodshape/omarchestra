import { join } from 'node:path'
import { BridgeRegistry, type BridgeSourceInput } from './bridge-registry.ts'
import { listenForPiBridge } from './bridge-channel.ts'
import type { WorkbenchRunner } from './runner.ts'
/** Called only by the lifetime owner after opening and verifying its runner. */
export async function openOwnerPiBridge(runner: WorkbenchRunner, socketPath: string, options: { now?: () => number; onInput?: (event: BridgeSourceInput) => void } = {}) {
  if (!runner.roots.runtimeDir || socketPath !== join(runner.roots.runtimeDir, 'omarchestra-bridge.sock')) throw new Error('bridge_runtime_root_mismatch')
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, ...options })
  const listener = await listenForPiBridge(socketPath, registry)
  return { registry, close: listener.close }
}
