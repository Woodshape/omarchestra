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
    property var armedConfirmation: null
    signal intentRequested(var payload)
    signal navigate(string destination)
    implicitHeight: overviewColumn.implicitHeight

    // Runner-computed registration detail, if an inspection is pending. QML
    // renders this; it never derives Git facts itself.
    readonly property var registrationDetail: {
        if (!root.projection || !Array.isArray(root.projection.details)) return null
        for (var i = 0; i < root.projection.details.length; i++) {
            var detail = root.projection.details[i]
            if (detail && detail.kind === "registration") return detail
        }
        return null
    }

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

            RowLayout {
                Layout.fillWidth: true
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: "Team Goals"
                    color: root.textColor
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                    font.bold: true
                }
                WorkbenchAction {
                    id: newGoalButton
                    objectName: "workbench-new-goal"
                    text: "+ New Team Goal"
                    prominent: true
                    enabled: root.connected
                    onClicked: root.navigate("new_goal")
                }
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
                delegate: WorkbenchAction {
                    required property var modelData
                    Layout.fillWidth: true
                    text: modelData.goalText + (modelData.state === "active" ? "  ·  active" : "  ·  " + modelData.state)
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    highlighted: root.projection !== null
                        && root.projection.selectedGoalId === modelData.goalId
                    onClicked: root.intentRequested({
                        kind: "select_goal",
                        target: modelData.goalId,
                        payload: { goalId: modelData.goalId }
                    })
                }
            }

            WorkbenchCards {
                Layout.fillWidth: true
                cards: root.projection && Array.isArray(root.projection.managedAgents)
                    ? root.projection.managedAgents : []
                observed: root.projection ? root.projection.observedSessions : []
                retired: root.projection ? root.projection.retiredRuns : []
                actionable: root.connected
                armedConfirmation: root.armedConfirmation
                onIntentRequested: function(payload) { root.intentRequested(payload) }
            }

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Project registration"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: root.projection !== null && (root.projection.selectedProject
                    || (Array.isArray(root.projection.projects) && root.projection.projects.length > 0))
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: root.projection && root.projection.selectedProject
                    ? "Selected: " + root.projection.selectedProject.canonicalPath
                    : root.projection && Array.isArray(root.projection.projects) && root.projection.projects.length > 0
                        ? "Registered: " + root.projection.projects[0].canonicalPath : ""
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            // The runner resolves Git facts; this field only carries the path
            // the operator typed. Confirmation is a separate, explicit step.
            WorkbenchTextField {
                id: projectPathField
                Layout.fillWidth: true
                objectName: "workbench-project-path"
                placeholderText: "/absolute/path/to/a/git/worktree"
                enabled: root.connected
                onAccepted: root.intentRequested({ kind: "inspect_project", target: null, payload: { path: projectPathField.text } })
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: Style.space(4)
                WorkbenchAction {
                    objectName: "workbench-inspect-project"
                    text: "Inspect path"
                    enabled: root.connected && projectPathField.text.length > 0
                    onClicked: root.intentRequested({ kind: "inspect_project", target: null, payload: { path: projectPathField.text } })
                }
                WorkbenchAction {
                    objectName: "workbench-confirm-registration"
                    text: root.registrationDetail && root.registrationDetail.reconfirmation === true ? "Reconfirm context" : "Confirm and register"
                    prominent: true
                    enabled: root.connected && root.registrationDetail !== null && root.registrationDetail.supported === true
                    onClicked: {
                        var detail = root.registrationDetail
                        if (detail === null) return
                        root.intentRequested({
                            kind: "confirm_register_project",
                            target: detail.registrationId,
                            payload: { registrationId: detail.registrationId }
                        })
                    }
                }
            }
            Text {
                id: registrationNote
                Layout.fillWidth: true
                visible: text.length > 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                text: {
                    var detail = root.registrationDetail
                    if (detail === null) return ""
                    if (!detail.supported) return "Not registrable: " + detail.reasons.join(", ")
                    if (detail.reconfirmation === true) return "Repository identity changed. Reconfirming keeps this Project's Goals and history. It does not clear uncertain work or resume execution."
                    if (!detail.executionReady) return "Registrable, but not execution-ready: " + detail.readinessReasons.join(", ")
                    return "Registrable Git worktree at " + detail.canonicalPath
                }
            }

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Project tools"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
            }
            GridLayout {
                Layout.fillWidth: true
                columns: 2
                rowSpacing: Style.space(2)
                columnSpacing: Style.space(8)
                WorkbenchAction {
                    Layout.fillWidth: true
                    text: "Add agent"
                    enabled: root.connected && root.projection !== null && root.projection.selectedGoalId !== null
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("add_agent")
                }
                WorkbenchAction {
                    Layout.fillWidth: true
                    text: "Prepare assignment"
                    enabled: root.connected && root.projection !== null && root.projection.selectedGoalId !== null
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("assignment")
                }
                WorkbenchAction {
                    Layout.fillWidth: true
                    text: "Checks"
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("checks")
                }
                WorkbenchAction {
                    objectName: "workbench-work"
                    Layout.fillWidth: true
                    text: "Work and result"
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("work")
                }
                WorkbenchAction {
                    objectName: "workbench-board"
                    Layout.fillWidth: true
                    text: "Board"
                    enabled: false
                    focusPolicy: Qt.StrongFocus
                    explanation: "Board backend not available in this slice."
                }
                WorkbenchAction {
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
