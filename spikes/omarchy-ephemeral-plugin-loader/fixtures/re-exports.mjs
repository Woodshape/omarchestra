// SPIKE — fixture re-export hub. Test files import port factories from here
// so the frozen port surface has one import site.

export { createFakeFsPort } from './fake-fs.mjs'
export { createLoaderPort, makeFakePanelItem } from './fake-loader.mjs'
export { createConfigPort } from './fake-config.mjs'
export { createScanPort, installedManifest } from './fake-scan.mjs'
export { createIdentityPort } from './fake-identity.mjs'
export { createClockPort } from './fake-clock.mjs'
export {
  validManifest,
  addValidSource,
  addRawManifestSource,
  oversizedManifest,
  nestedObject,
} from './panel-sources.mjs'
export {
  createScratchFsPort,
  createRealScratchFs,
  withRealTempDir,
  scratchPrefix,
  randomScratchSuffix,
} from './scratch-fs.mjs'