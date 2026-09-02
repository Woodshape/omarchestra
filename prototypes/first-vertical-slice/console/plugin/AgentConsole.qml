// PROTOTYPE — NOT PRODUCTION.
//
// Presentation-only Omarchy panel. A host injects a validated plain
// projection through open() or applyProjection(). The Team Runner and the
// non-QML adapter remain the authorities for status, identity, and cursor.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
    id: root

    property var shell: null
    property var manifest: null
    property bool opened: false
    property var projection: ({
        status: "reconnecting",
        cursor: 0,
        cards: []
    })

    function applyProjection(value) {
        if (!value || typeof value !== "object") return false
        if (value.status !== "ready"
                && value.status !== "reconnecting"
                && value.status !== "gap") return false
        if (!Array.isArray(value.cards) || value.cards.length !== 3) return false

        for (var index = 0; index < value.cards.length; index += 1) {
            var card = value.cards[index]
            if (!card || typeof card.role !== "string"
                    || typeof card.agentRunId !== "string"
                    || typeof card.piStatus !== "string") return false
        }

        projection = value
        return true
    }

    function open(payloadJson) {
        var value = payloadJson
        if (typeof payloadJson === "string") {
            try {
                value = JSON.parse(payloadJson || "{}")
            } catch (error) {
                value = null
            }
        }
        if (value && value.projection !== undefined) value = value.projection
        // The panel opens only when a validated projection applies. An
        // invalid or missing payload must never open the surface showing
        // QML-authored placeholder state: the authoritative snapshot from
        // the runner adapter is the only thing that may open it.
        if (!applyProjection(value)) return false
        opened = true
        return true
    }

    function close() {
        opened = false
    }

    PanelWindow {
        id: panel
        visible: root.opened
        anchors {
            top: true
            bottom: true
            left: true
            right: true
        }
        color: "transparent"
        WlrLayershell.namespace: "omarchestra-agent-console"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        exclusionMode: ExclusionMode.Ignore
        mask: Region {}

        BorderSurface {
            id: surface
            width: Math.min(parent.width - Style.space(48), Style.space(900))
            height: consoleColumn.implicitHeight + Style.space(36)
            anchors.centerIn: parent
            color: Color.popups.background
            borderSpec: Border.surfaceSpec(
                "popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
            radius: Style.cornerRadius

            ColumnLayout {
                id: consoleColumn
                anchors.fill: parent
                anchors.margins: Style.space(18)
                spacing: Style.space(12)

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Style.space(10)

                    Text {
                        Layout.fillWidth: true
                        text: "Agent Console"
                        color: Color.popups.text
                        font.family: Style.font.family
                        font.pixelSize: Style.font.heading
                        font.bold: true
                    }

                    Text {
                        text: "cursor " + String(root.projection.cursor)
                        color: Qt.darker(Color.popups.text, 1.45)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }
                }

                Text {
                    Layout.fillWidth: true
                    text: root.projection.status
                    color: root.projection.status === "gap"
                        ? Color.urgent : Color.accent
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.projection.status === "ready"
                    text: "Projection ready"
                    color: Qt.darker(Color.popups.text, 1.35)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.projection.status === "reconnecting"
                    text: "Reconnecting to the Team Runner projection"
                    color: Qt.darker(Color.popups.text, 1.35)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }

                Text {
                    Layout.fillWidth: true
                    visible: root.projection.status === "gap"
                    text: "Projection gap: awaiting an authoritative snapshot"
                    color: Color.urgent
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }

                AgentConsoleCards {
                    Layout.fillWidth: true
                    cards: root.projection.cards
                }
            }
        }
    }
}
