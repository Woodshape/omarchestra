// SPIKE — fake-only fixture. Not production code and never a real loader.
//
// fake-loader.mjs — the injected loader port for the temporary-panel host.
// The host must create, drive, and destroy loaders only through this port so
// tests can observe exact teardown (deactivated, source cleared, destroyed)
// without any QML, Quickshell, or UI involvement.
//
// Frozen port surface for task 3.a:
//   create(spec) -> controller
//     spec = { sourceUrl, registrationId, generation, injections,
//              onLoaded(item), onLoadError(detail), onDestroyed() }
//   controller = { setActive(bool), setSource(url|null), destroy(),
//                  active, source, item, destroyed,
//                  finishLoad(item), failLoad(detail) }
//   shared = { omarchyPath, shellToken }  // properties a loaded item must receive
//   created / destroyed / loadedCounts    // fixture observation
//
// The host owns the item handle after onLoaded; tests never hand items to the
// host except through controller.finishLoad(item).

export function makeFakePanelItem(overrides = {}) {
  const item = {
    // Observed delivery surface (what a real panel plugin would implement).
    openLog: [],
    callLog: [],
    injected: {},
    closedCount: 0,
    returnValue: 'ok',
    throwOn: {},
    open(payloadJson) {
      item.openLog.push(String(payloadJson))
      if (item.throwOn.open) throw new Error('open failed')
    },
    close() {
      item.closedCount += 1
    },
    updateProjection(payloadJson) {
      item.callLog.push(String(payloadJson))
      if (item.throwOn.updateProjection) throw new Error('projection exploded')
      return item.returnValue
    },
  }
  return Object.assign(item, overrides)
}

export function createLoaderPort() {
  const created = []
  const destroyed = []

  const loader = {
    created,
    destroyed,
    shared: { omarchyPath: '/usr/share/omarchy', shellToken: 'fake-shell-instance' },

    create(spec) {
      const controller = {
        spec,
        active: true,
        source: spec.sourceUrl,
        item: null,
        destroyed: false,
        setActive(value) { controller.active = value === true },
        setSource(url) { controller.source = url },
        destroy() {
          if (controller.destroyed) return
          controller.destroyed = true
          destroyed.push(controller)
          if (typeof spec.onDestroyed === 'function') spec.onDestroyed()
        },
        /** Test control: simulate the async Loader resolving to an item. */
        finishLoad(item) {
          if (controller.destroyed) throw new Error('fixture: finishLoad after destroy')
          controller.item = item
          spec.onLoaded(item)
        },
        /** Test control: simulate the async Loader reporting an error. */
        failLoad(detail) {
          spec.onLoadError(detail)
        },
      }
      created.push(controller)
      return controller
    },
  }

  return loader
}