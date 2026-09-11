// Local Workbench v1 — Goal destination.
//
// mode "new_goal" creates a Team Goal: Project context, goal text, Cancel and
// Create only. Gate configuration, executable/argv, environment, timeout,
// corrections and Assignment controls deliberately do not exist here. They live
// in the separate Assignment and Checks destinations.
//
// mode "goal" shows the selected Goal with its secondary history/intervention
// actions. Unsupported runtime actions are visibly disabled with a reason and
// emit no intent.
import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui as Native
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
    property string mode: "goal"
    property bool menuOpen: false
    property string goalDraft: ""
    signal draftChanged(string value)
    signal toggleMenu()
    signal changeProject()
    signal navigate(string destination)
    signal intentRequested(var payload)
    implicitHeight: goalColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)
    readonly property bool connected: root.projection !== null && root.projection.connection === "connected"
    readonly property var selectedGoal: {
        if (!root.projection || !Array.isArray(root.projection.goals)) return null
        for (var i = 0; i < root.projection.goals.length; i++) {
            if (root.projection.goals[i].goalId === root.projection.selectedGoalId) return root.projection.goals[i]
        }
        return null
    }
    readonly property var selectedProject: {
        if (!root.projection || !Array.isArray(root.projection.projects)) return null
        for (var i = 0; i < root.projection.projects.length; i++) {
            if (root.projection.projects[i].projectId === root.projection.selectedProjectId) return root.projection.projects[i]
        }
        return null
    }

    readonly property var createAction: {
        if (!projection || !Array.isArray(projection.actions)) return null
        for (var i = 0; i < projection.actions.length; i++) {
            var action = projection.actions[i]
            if (action.kind === "create_goal" && action.target === null) return action
        }
        return null
    }
    function focusProjectControl() { goalProjectButton.forceActiveFocus() }
    function validGoalText(value) {
        try { return value.trim().length > 0 && encodeURIComponent(value).replace(/%[A-Fa-f0-9]{2}|[^%]/g, "x").length <= 8192
            && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) } catch (error) { return false }
    }

    readonly property var goalActions: {
        if (root.selectedGoal === null || !Array.isArray(root.selectedGoal.actions)) return []
        return root.selectedGoal.actions
    }

    /**
     * Maps a committed Goal action onto the exact payload field its intent
     * requires. Null means this Goal cannot supply the identity, which narrows
     * the control to unavailable. It never grants availability.
     */
    function actionPayload(action) {
        if (action === null || action === undefined || action.target === null) return null
        if (action.kind === "retire" || action.kind === "purge") return { agentRunId: action.target }
        return { assignmentId: action.target }
    }

    /** A closed contextual menu returns focus to the control that opened it. */
    onMenuOpenChanged: {
        if (!root.menuOpen && root.visible && menuButton !== null) menuButton.forceActiveFocus()
    }

    ColumnLayout {
        id: goalColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        // ---- New Team Goal -------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "new_goal"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "New Team Goal"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: "Project: " + (root.selectedProject ? root.selectedProject.canonicalPath : "none selected")
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Button {
                id: goalProjectButton
                Layout.fillWidth: true
                text: "Change Project"
                enabled: root.connected
                focusPolicy: Qt.StrongFocus
                onClicked: root.changeProject()
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Team Goal"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            ScrollView {
                Layout.fillWidth: true
                Layout.preferredHeight: Style.space(96)
                clip: true
                TextArea {
                    id: goalEditor
                    objectName: "workbench-goal-text"
                    textFormat: Text.PlainText
                    placeholderText: "Team Goal"
                    Accessible.name: "Team Goal"
                    wrapMode: TextEdit.WrapAnywhere
                    selectByMouse: true
                    activeFocusOnTab: true
                    text: root.goalDraft
                    onTextChanged: if (text !== root.goalDraft) root.draftChanged(text)
                    // Tab inserts a tab character inside a multiline editor, so
                    // the editor would trap keyboard focus without an explicit
                    // hand-off to the next control.
                    Keys.onTabPressed: function(event) {
                        nextItemInFocusChain().forceActiveFocus()
                        event.accepted = true
                    }
                }
            }
            Label {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                visible: goalEditor.text.trim().length > 0 && !root.validGoalText(goalEditor.text)
                text: "Keep the Goal within 8192 UTF-8 bytes and omit control characters."
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: Style.space(6)
                Button {
                    Layout.fillWidth: true
                    text: "Cancel"
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.navigate("overview")
                }
                Button {
                    objectName: "workbench-create-goal"
                    Layout.fillWidth: true
                    text: "Create"
                    enabled: root.connected && root.selectedProject !== null && root.createAction !== null
                        && root.createAction.enabled && root.validGoalText(goalEditor.text)
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.intentRequested({
                        kind: "create_goal",
                        target: null,
                        payload: {
                            projectId: root.projection ? root.projection.selectedProjectId : null,
                            goalText: goalEditor.text
                        }
                    })
                }
            }
        }

        // ---- Selected Goal -------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "goal"
            spacing: Style.space(8)

            RowLayout {
                Layout.fillWidth: true
                spacing: Style.space(6)
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAnywhere
                    text: root.selectedGoal === null ? "No Goal selected" : root.selectedGoal.goalText
                    color: root.textColor
                    font.family: Style.font.family
                    font.pixelSize: Style.font.heading
                    font.bold: true
                }
                Button {
                    id: menuButton
                    objectName: "workbench-goal-menu"
                    text: "⋮"
                    Accessible.name: "More Goal actions"
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.toggleMenu()
                }
            }
            Text {
                Layout.fillWidth: true
                visible: root.selectedGoal !== null
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: root.selectedGoal === null ? "" : "State: " + root.selectedGoal.state
                    + " · Outcome: " + (root.selectedGoal.outcome === null ? "not recorded" : root.selectedGoal.outcome)
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }

            // Secondary intervention actions, rendered only from the actions
            // the runner committed for this Goal. Unavailable operations stay
            // visible and disabled with the runner's exact reason.
            ColumnLayout {
                Layout.fillWidth: true
                visible: root.menuOpen
                spacing: Style.space(4)
                Text {
                    Layout.fillWidth: true
                    visible: root.goalActions.length === 0
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    text: "No secondary action is available for this Goal."
                    color: root.mutedColor
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                }
                Repeater {
                    model: root.goalActions
                    delegate: Button {
                        required property var modelData
                        readonly property var requestPayload: root.actionPayload(modelData)
                        readonly property bool available: root.connected && modelData.enabled
                            && requestPayload !== null
                        Layout.fillWidth: true
                        text: (modelData.label || modelData.kind)
                            + (available ? "" : ": " + (modelData.reason || "Unavailable"))
                        enabled: available
                        focusPolicy: Qt.StrongFocus
                        onClicked: root.intentRequested({
                            kind: modelData.kind,
                            target: modelData.target,
                            payload: requestPayload
                        })
                    }
                }
            }

            Button {
                Layout.fillWidth: true
                text: "Add agent"
                enabled: root.connected
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("add_agent")
            }
            Button {
                Layout.fillWidth: true
                text: "Prepare assignment"
                enabled: root.connected
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

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Retired history is listed with the managed agents."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.Wrap
            }
        }
    }
}
