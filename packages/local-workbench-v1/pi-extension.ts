import { createPiBridgeExtension } from './runner/pi-bridge-extension.ts'
/** Explicitly installed Pi extension entry; imports no prototype or workbench service. */
export default createPiBridgeExtension()
