// Presentation notification only. One bounded client at a time, with bursts
// coalesced. The Owner still reads and validates intents from the loaded view.
import QtQuick
import Quickshell.Io

Item {
    id: root
    property var nextWake: null
    function notify(socketPath, session) {
        if (!socketPath || !session) return
        nextWake = { socketPath: socketPath, sessionId: session.sessionId,
            pluginGeneration: session.pluginGeneration }
        send()
    }
    function send() {
        if (client.running || nextWake === null) return
        client.command = ["/usr/bin/node", decodeURIComponent(String(Qt.resolvedUrl("workbench-wake.mjs")).replace(/^file:\/\//, "")), JSON.stringify(nextWake)]
        nextWake = null
        client.running = true
    }
    function reset() { nextWake = null }
    Process {
        id: client
        clearEnvironment: true
        onExited: Qt.callLater(root.send)
    }
}
