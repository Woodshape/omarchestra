// SPIKE — fake-only model entry point. Not production code.
//
// Exports the frozen public surface consumed by test/helpers.mjs:
//   createTemporaryPanelHost({ fs, loader, config, scan, identity, clock })
//   createScratchRegistry({ fs, now })

export { createTemporaryPanelHost } from './host.mjs'
export { createScratchRegistry } from './scratch-registry.mjs'
export { LIMITS } from './bounds.mjs'