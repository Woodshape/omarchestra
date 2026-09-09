/** PROTOTYPE — NOT PRODUCTION. Additive Companion 0.4.0 presentation only. */
export const ADOPTION_PANEL_QML = String.raw`
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons

Item {
    id: root
    property double pluginGeneration: 0
    property var adoptionState: null
    property var intents: []
    property bool fresh: false
    property int intentCounter: 0
    function nextIntentId(kind) {
        root.intentCounter += 1
        return "adoption-" + kind + "-" + String(root.intentCounter)
    }
    Timer {
        id: freshness
        interval: 2000
        onTriggered: { root.fresh = false; root.intents = []; agents.clearIntentState() }
    }
    function matches(value) {
        return adoptionState !== null && value && value.session
            && JSON.stringify(value.session) === JSON.stringify(adoptionState.session)
    }
    function apply(value, opening) {
        if (!value || !value.session || value.session.pluginGeneration !== pluginGeneration
                || !value.observerProjection || !Array.isArray(value.observerProjection.agents)
                || !Array.isArray(value.managedCards) || typeof value.revision !== "number" || value.revision < 0) return false
        if (!opening && (!matches(value) || value.revision < adoptionState.revision)) return false
        if (opening && adoptionState !== null && !matches(value)) return false
        if (opening) { intents = []; agents.clearIntentState() }
        adoptionState = value
        fresh = true
        freshness.restart()
        return true
    }
    function submit(payload) {
        if (!adoptionState || !fresh || intents.length >= 16) return
        var queue = intents.slice()
        queue.push({ session: adoptionState.session, intent: payload })
        intents = queue
    }
    function take(value) {
        if (!matches(value)) return ""
        var queue = intents.slice()
        var result = queue.shift()
        intents = queue
        return result ? JSON.stringify(result) : ""
    }
    function result(value) {
        if (!matches(value)) return false
        return agents.applyIntentResult(value.result)
    }
    function clear(value) {
        if (!matches(value)) return false
        adoptionState = null
        fresh = false
        freshness.stop()
        intents = []
        agents.clearIntentState()
        return true
    }
    PanelWindow {
        visible: root.adoptionState !== null
        anchors { left: true; top: true; bottom: true }
        implicitWidth: 360
        color: Color.popups.background
        exclusionMode: ExclusionMode.Auto
        WlrLayershell.namespace: "omarchestra-adoption"
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        Flickable {
            anchors.fill: parent
            contentHeight: column.implicitHeight
            clip: true
            ColumnLayout {
                id: column
                width: parent.width
                Text { text: root.fresh ? "Adoption" : "Adoption · disconnected"; color: Color.popups.text }
                Repeater {
                    model: root.adoptionState ? root.adoptionState.managedCards : []
                    delegate: ColumnLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        spacing: Style.space(4)
                        Text {
                            Layout.fillWidth: true
                            text: modelData.piStatus + " · " + modelData.connectionStatus
                            color: Color.popups.text
                            wrapMode: Text.Wrap
                        }
                        Button {
                            Layout.fillWidth: true
                            visible: root.fresh && modelData.connectionStatus === "disconnected"
                            text: "Retire Agent Run · " + modelData.role
                            onClicked: root.submit({
                                intentId: root.nextIntentId("retire"),
                                kind: "request_retirement",
                                agentRunId: modelData.agentRunId
                            })
                        }
                        Text {
                            Layout.fillWidth: true
                            visible: modelData.connectionStatus === "disconnected"
                            text: "Retirement is irreversible and does not stop the process or its tools."
                            color: Qt.darker(Color.popups.text, 1.35)
                            font.pixelSize: Style.font.caption
                            wrapMode: Text.Wrap
                        }
                    }
                }
                RetiredAgentCards {
                    Layout.fillWidth: true
                    cards: root.adoptionState && Array.isArray(root.adoptionState.retiredCards)
                        ? root.adoptionState.retiredCards : []
                }
                UnassignedAgents {
                    id: agents
                    enabled: root.fresh
                    Layout.fillWidth: true
                    projection: root.adoptionState ? root.adoptionState.observerProjection : ({ observerRevision: 0, agents: [] })
                    onRequestAdoption: payload => root.submit(payload)
                    onAuthorizeAdoption: payload => root.submit(payload)
                }
            }
        }
    }
}
`

export const ADOPTION_ROOT_MEMBERS = String.raw`
    AdoptionPanel { id: adoptionPanel; pluginGeneration: root.pluginGeneration }
    function adoptionCapabilities() {
        return JSON.stringify({ version: "0.4.0", pluginGeneration: pluginGeneration,
            methods: ["adoptionOpen", "adoptionApply", "adoptionTakeIntent", "adoptionIntentResult", "adoptionClear"] })
    }
    function adoptionOpen(value) { return adoptionPanel.apply(parsePayload(value), true) }
    function adoptionApply(value) { return adoptionPanel.apply(parsePayload(value), false) }
    function adoptionTakeIntent(value) { return adoptionPanel.take(parsePayload(value)) }
    function adoptionIntentResult(value) { return adoptionPanel.result(parsePayload(value)) }
    function adoptionClear(value) { return adoptionPanel.clear(parsePayload(value)) }
`
