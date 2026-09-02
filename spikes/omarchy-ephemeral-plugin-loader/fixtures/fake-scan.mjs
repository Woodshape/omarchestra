// SPIKE — fake-only fixture. Not production code.
//
// fake-scan.mjs — the injected installed-plugin-registry view. It mirrors the
// two facts the host may consume from the installed PluginRegistry: whether a
// scan is currently unresolved (`registry_busy`) and which plugin IDs and
// source directories are installed (collision checks). The host must observe
// this port read-only and must never mutate it.
//
// Frozen port surface for task 3.a:
//   state()          -> 'idle' | 'scanning'
//   installedPlugins() -> deep copy of { [pluginId]: manifest with __sourceDir }
//   subscribe(cb)    -> unsubscribe function; cb fires on pluginsChanged
//   setState(s), setPlugins(p), emitPluginsChanged()   // fixture controls

export function createScanPort({ plugins = {} } = {}) {
  let state = 'idle'
  let registry = plugins
  const listeners = []

  return {
    state() { return state },
    installedPlugins() { return JSON.parse(JSON.stringify(registry)) },
    subscribe(cb) {
      listeners.push(cb)
      return function unsubscribe() {
        const index = listeners.indexOf(cb)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    setState(next) { state = next },
    setPlugins(next) { registry = next },
    emitPluginsChanged() {
      for (const cb of [...listeners]) cb()
    },
  }
}

/** Convenience: one installed third-party-style plugin manifest. */
export function installedManifest(id, sourceDir) {
  return {
    schemaVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    kinds: ['panel'],
    entryPoints: { panel: 'Panel.qml' },
    __sourceDir: sourceDir,
    __isFirstParty: false,
  }
}