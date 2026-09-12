// Plain committed agent/session rows. Eligibility and identities remain runner-owned.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import qs.Commons

Control {
    id: root
    property var cards: []
    property var observed: []
    property var retired: []
    property bool actionable: false
    property bool historyExpanded: false
    implicitHeight: cardsColumn.implicitHeight
    signal intentRequested(var payload)
    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.65)

    function actionPayload(kind, agentRunId, assignmentId) {
        switch (kind) {
        case "take_control":
        case "return_to_team":
        case "accept":
        case "resume":
        case "retry":
        case "stop":
            return (assignmentId === null || assignmentId === undefined)
                ? null : { assignmentId: assignmentId }
        case "retire":
        case "purge":
            return { agentRunId: agentRunId }
        default:
            return null
        }
    }

    component Caption: Text {
        textFormat: Text.PlainText
        color: root.mutedColor
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        wrapMode: Text.WrapAnywhere
    }
    component Heading: Caption {
        color: root.textColor
        font.bold: true
        topPadding: Style.space(12)
        bottomPadding: Style.space(4)
    }
    component Status: Text {
        textFormat: Text.PlainText
        color: root.textColor
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        wrapMode: Text.WrapAnywhere
    }

    ColumnLayout {
        id: cardsColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(6)

        Heading { Layout.fillWidth: true; text: "Managed agents" }
        Caption { Layout.fillWidth: true; visible: root.cards.length === 0; text: "No agents assigned yet." }
        Repeater {
            model: root.cards
            delegate: ColumnLayout {
                id: cardRow
                required property var modelData
                property bool actionsExpanded: false
                Keys.onEscapePressed: function(event) {
                    if (actionsExpanded) {
                        actionsExpanded = false
                        agentMenu.forceActiveFocus()
                        event.accepted = true
                    } else event.accepted = false
                }
                Layout.fillWidth: true
                spacing: Style.space(3)
                RowLayout {
                    Layout.fillWidth: true
                    Status { Layout.fillWidth: true; text: cardRow.modelData.piStatus }
                    WorkbenchAction {
                        id: agentMenu
                        objectName: "workbench-agent-actions"
                        text: "···"
                        Accessible.name: "Agent actions"
                        explanation: "Agent actions"
                        highlighted: cardRow.actionsExpanded
                        onClicked: cardRow.actionsExpanded = !cardRow.actionsExpanded
                    }
                }
                Caption {
                    Layout.fillWidth: true
                    text: cardRow.modelData.role + " · " + cardRow.modelData.controlMode + " · " + cardRow.modelData.connectionStatus
                }
                Caption {
                    Layout.fillWidth: true
                    visible: cardRow.modelData.assignment !== null
                    text: cardRow.modelData.assignment === null ? "" : "Assignment: " + cardRow.modelData.assignment
                }
                Repeater {
                    model: cardRow.actionsExpanded ? (cardRow.modelData.actions || []) : []
                    delegate: ColumnLayout {
                        id: actionRow
                        required property var modelData
                        readonly property var cardPayload: root.actionPayload(
                            modelData.kind, cardRow.modelData.agentRunId, cardRow.modelData.assignment)
                        readonly property bool available: root.actionable && modelData.enabled && cardPayload !== null
                        Layout.fillWidth: true
                        spacing: 0
                        WorkbenchAction {
                            Layout.fillWidth: true
                            text: actionRow.modelData.label || actionRow.modelData.kind
                            enabled: actionRow.available
                            explanation: actionRow.available ? "" : (actionRow.modelData.reason || "Unavailable")
                            onClicked: root.intentRequested({
                                kind: actionRow.modelData.kind,
                                target: actionRow.modelData.target,
                                payload: actionRow.cardPayload
                            })
                        }
                        Caption {
                            Layout.fillWidth: true
                            Layout.leftMargin: Style.space(8)
                            visible: !actionRow.available
                            text: actionRow.modelData.reason || "Unavailable"
                        }
                    }
                }
            }
        }

        Heading { Layout.fillWidth: true; text: "Unassigned sessions" }
        Caption { Layout.fillWidth: true; visible: root.observed.length === 0; text: "No observed sessions." }
        Repeater {
            model: root.observed
            delegate: ColumnLayout {
                id: observedRow
                required property var modelData
                Layout.fillWidth: true
                spacing: Style.space(3)
                Status { Layout.fillWidth: true; text: observedRow.modelData.piStatus }
                Caption {
                    Layout.fillWidth: true
                    text: "Observed · unmanaged · " + observedRow.modelData.availability + " · " + observedRow.modelData.lifecycle
                }
                Repeater {
                    model: observedRow.modelData.choices || []
                    delegate: WorkbenchAction {
                        required property var modelData
                        Layout.fillWidth: true
                        text: modelData.label
                        enabled: root.actionable && modelData.enabled
                        onClicked: root.intentRequested({
                            kind: "request_adoption",
                            target: modelData.choiceId,
                            payload: { choiceId: modelData.choiceId }
                        })
                    }
                }
            }
        }

        WorkbenchAction {
            Layout.fillWidth: true
            text: (root.historyExpanded ? "▾ " : "▸ ") + "Retired history (" + root.retired.length + ")"
            onClicked: root.historyExpanded = !root.historyExpanded
        }
        Repeater {
            model: root.historyExpanded ? root.retired : []
            delegate: ColumnLayout {
                id: retiredRow
                required property var modelData
                Layout.fillWidth: true
                spacing: Style.space(3)
                Status { Layout.fillWidth: true; text: retiredRow.modelData.piStatus }
                Caption {
                    Layout.fillWidth: true
                    visible: !retiredRow.modelData.canPurge
                    text: retiredRow.modelData.purgeBlockedReason || "Successor history must be deleted first."
                }
                WorkbenchAction {
                    Layout.fillWidth: true
                    visible: retiredRow.modelData.canPurge
                    enabled: root.actionable && retiredRow.modelData.canPurge
                    text: "Delete retired history"
                    onClicked: root.intentRequested({
                        kind: "purge",
                        target: retiredRow.modelData.agentRunId,
                        payload: { agentRunId: retiredRow.modelData.agentRunId }
                    })
                }
            }
        }
    }
}
