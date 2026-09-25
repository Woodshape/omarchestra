// Native presentation host incarnation only; not a runner/session identity.
// The injected WorkbenchConsole remains deterministic in automated tests.
import QtQuick

WorkbenchConsole {
    pluginGeneration: Date.now() * 1000 + Math.floor(Math.random() * 1000)
}
