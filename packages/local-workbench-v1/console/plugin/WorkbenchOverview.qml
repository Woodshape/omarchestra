// Local Workbench v1 — Project home and Activity destination.
//
// Renders the active Goal, a compact agent summary, the primary "New Team Goal"
// action and secondary destination links from plain injected projection values.
// Board is visibly disabled with a reason and emits no intent. Labels are never
// derived here: piStatus and goal text are opaque committed presentation
// strings.
import QtQuick
import QtQuick.Layouts
import qs.Commons
import QtQuick.Controls

Control {
    id: root
    palette.window: Color.popups.background
    palette.windowText: Color.popups.text
    palette.base: Color.popups.background
    palette.text: Color.popups.text
    palette.button: Qt.lighter(Color.popups.background, 1.15)
    palette.buttonText: Color.popups.text
    palette.highlight: Color.accent
    palette.highlightedText: Color.popups.background
    font.family: Style.font.family

    property var projection: null
    property string mode: "overview"
    signal intentRequested(var payload)
    signal navigate(string destination)
    implicitHeight: overviewColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)
    readonly property bool connected: root.projection !== null && root.projection.connection === "connected"

    /** Keyboard entry point for this destination. Focuses the primary action. */
    function focusPrimary() {
        newGoalButton.forceActiveFocus()
    }

    ColumnLayout {
        id: overviewColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        // ---- Activity destination -------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "activity"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Activity"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: !root.projection || !Array.isArray(root.projection.activity)
                    || root.projection.activity.length === 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No committed activity recorded for this runner session."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.activity)
                    ? root.projection.activity : []
                delegate: Text {
                    required property var modelData
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAnywhere
                    text: "[" + modelData.cursor + "] " + modelData.label
                        + (modelData.reasonCode === null ? "" : " (" + modelData.reasonCode + ")")
                    color: root.textColor
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }
            }
        }

        // ---- Project home ---------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode !== "activity"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Team Goals"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: !root.projection || !Array.isArray(root.projection.goals)
                    || root.projection.goals.length === 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No Team Goal yet. Create one to describe the outcome this Project should reach."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.goals)
                    ? root.projection.goals : []
                delegate: Button {
                    required property var modelData
                    Layout.fillWidth: true
                    text: modelData.goalText + (modelData.state === "active" ? "  ·  active" : "  ·  " + modelData.state)
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    highlighted: root.projection !== null
                        && root.projection.selectedGoalId === modelData.goalId
                    contentItem: Text {
                        text: parent.text
                        textFormat: Text.PlainText
                        wrapMode: Text.WrapAnywhere
                        color: root.textColor
                    }
                    onClicked: root.intentRequested({
                        kind: "select_goal",
                        target: modelData.goalId,
                        payload: { goalId: modelData.goalId }
                    })
                }
            }
            Button {
                id: newGoalButton
                objectName: "workbench-new-goal"
                Layout.fillWidth: true
                text: "New Team Goal"
                enabled: root.connected
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("new_goal")
            }

            WorkbenchCards {
                Layout.fillWidth: true
                cards: root.projection && Array.isArray(root.projection.managedAgents)
                    ? root.projection.managedAgents : []
                observed: root.projection ? root.projection.observedSessions : []
                retired: root.projection ? root.projection.retiredRuns : []
                actionable: root.connected
                onIntentRequested: function(payload) { root.intentRequested(payload) }
            }

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Assignments and checks"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            GridLayout {
                Layout.fillWidth: true
                columns: 2
                Button {
                    Layout.fillWidth: true
                    text: "Add agent"
                    enabled: root.connected && root.projection !== null && root.projection.selectedGoalId !== null
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("add_agent")
                }
                Button {
                    Layout.fillWidth: true
                    text: "Prepare assignment"
                    enabled: root.connected && root.projection !== null && root.projection.selectedGoalId !== null
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("assignment")
                }
                Button {
                    Layout.fillWidth: true
                    text: "Checks"
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("checks")
                }
                Button {
                    objectName: "workbench-work"
                    Layout.fillWidth: true
                    text: "Work and result"
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("work")
                }
                Button {
                    objectName: "workbench-board"
                    Layout.fillWidth: true
                    text: "Board"
                    enabled: false
                    focusPolicy: Qt.StrongFocus
                    ToolTip.visible: hovered
                    ToolTip.text: "Board backend not available in this slice."
                }
                Button {
                    Layout.fillWidth: true
                    text: "Activity"
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("activity")
                }
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "Board backend is not available in this slice."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
        }
    }
}
