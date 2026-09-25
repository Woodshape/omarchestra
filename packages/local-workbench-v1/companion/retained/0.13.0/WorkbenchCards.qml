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
    property var armedConfirmation: null
    property bool actionable: false
    property bool historyExpanded: false
    implicitHeight: cardsColumn.implicitHeight
    signal intentRequested(var payload)
    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.rgba(textColor.r, textColor.g, textColor.b, 0.65)

    function actionPayload(kind, agentRunId, assignmentId) {
        switch (kind) {
        case "take_control":
            return { agentRunId: agentRunId }
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

    // An observed-session choice names its committed intent. A proposal choice
    // authorizes; a transport observation requests adoption.
    function choiceIntent(choiceId, actionKind) {
        if (actionKind === "authorize_adoption") {
            return { kind: "authorize_adoption", target: choiceId, payload: { proposalId: choiceId } }
        }
        return { kind: "request_adoption", target: choiceId, payload: { choiceId: choiceId } }
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
                    WorkbenchAction {
                        objectName: "workbench-managed-show-pane"
                        Layout.fillWidth: true
                        text: "Show terminal pane · " + (cardRow.modelData.sessionCode ? "Pi " + cardRow.modelData.sessionCode : "Session code unavailable")
                            + " · " + cardRow.modelData.piStatus
                        enabled: root.actionable && !!cardRow.modelData.terminalNavigation && cardRow.modelData.terminalNavigation.enabled
                        onClicked: root.intentRequested({ kind: "present", target: cardRow.modelData.terminalNavigation.target, payload: ({}) })
                    }
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
                    objectName: "workbench-managed-navigation-result"
                    Layout.fillWidth: true
                    text: cardRow.modelData.terminalNavigation ? cardRow.modelData.terminalNavigation.reason : "Terminal navigation unavailable."
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
                        readonly property var requestIntent: ({ kind: modelData.kind,
                            target: modelData.target, payload: cardPayload })
                        Layout.fillWidth: true
                        spacing: 0
                        WorkbenchAction {
                            Layout.fillWidth: true
                            confirmationIntent: actionRow.requestIntent
                            armedIntent: root.armedConfirmation
                            highlighted: awaitingConfirmation
                            text: confirmationText(actionRow.modelData.label || actionRow.modelData.kind)
                            enabled: actionRow.available
                            explanation: actionRow.available ? "" : (actionRow.modelData.reason || "Unavailable")
                            onClicked: root.intentRequested(actionRow.requestIntent)
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
                WorkbenchAction {
                    objectName: "workbench-observed-show-pane"
                    Layout.fillWidth: true
                    text: "Show terminal pane · " + (observedRow.modelData.sessionCode ? "Pi " + observedRow.modelData.sessionCode : "Session code unavailable")
                        + " · " + observedRow.modelData.piStatus
                    enabled: root.actionable && !!observedRow.modelData.terminalNavigation && observedRow.modelData.terminalNavigation.enabled
                    onClicked: root.intentRequested({ kind: "present", target: observedRow.modelData.terminalNavigation.target, payload: ({}) })
                }
                Caption {
                    objectName: "workbench-observed-navigation-result"
                    Layout.fillWidth: true
                    text: observedRow.modelData.terminalNavigation ? observedRow.modelData.terminalNavigation.reason : "Terminal navigation unavailable."
                }
                Caption {
                    Layout.fillWidth: true
                    objectName: "workbench-observed-facts"
                    text: "Observed · unmanaged · connection " + observedRow.modelData.availability
                        + " · " + observedRow.modelData.lifecycle + " · " + observedRow.modelData.activity
                        + " · " + observedRow.modelData.health
                }
                Caption {
                    objectName: "workbench-observed-adoption-reason"
                    Layout.fillWidth: true
                    visible: !!observedRow.modelData.adoptionReason
                    text: observedRow.modelData.adoptionReason || ""
                }
                Repeater {
                    model: observedRow.modelData.choices || []
                    delegate: WorkbenchAction {
                        required property var modelData
                        readonly property var requestIntent: root.choiceIntent(modelData.choiceId, modelData.actionKind)
                        Layout.fillWidth: true
                        confirmationIntent: requestIntent
                        armedIntent: root.armedConfirmation
                        highlighted: awaitingConfirmation
                        text: confirmationText(modelData.label)
                        enabled: root.actionable && modelData.enabled
                        onClicked: root.intentRequested(requestIntent)
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
                    readonly property var requestIntent: ({ kind: "purge",
                        target: retiredRow.modelData.agentRunId,
                        payload: { agentRunId: retiredRow.modelData.agentRunId } })
                    confirmationIntent: requestIntent
                    armedIntent: root.armedConfirmation
                    highlighted: awaitingConfirmation
                    text: confirmationText("Delete retired history")
                    onClicked: root.intentRequested(requestIntent)
                }
            }
        }
    }
}
