// Local Workbench v1 — Add agent, Adoption review and Assignment preparation.
//
// Three contextual destinations that stay separate from Goal creation:
//   add_agent        choose one eligible observed session and a Role
//   adoption_review  inspect the exact binding before authorising anything
//   assignment       task text, target agent and one configured check, then
//                    one primary "Start review" that captures exact facts
//
// Every value is a plain injected projection value. Nothing here derives a
// label, fabricates a committed operation, or executes anything. Unsupported
// runtime actions are visibly disabled with a reason.
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
    property string mode: "add_agent"
    property string selectedObservedSessionId: ""
    property string selectedRole: ""
    property string selectedAgentRunId: ""
    property string selectedCheckId: ""
    property int selectedCheckVersion: 0
    property var assignmentDraft: ({})
    property var adoptionDetail: null
    property string reviewBlockedReason: ""
    signal draftChanged(string key, string value)
    signal navigate(string destination)
    signal selectObserved(string sessionId)
    signal selectRole(string role)
    signal selectAgent(string runId)
    signal selectCheck(string checkId, int version)
    signal reviewStart()
    signal intentRequested(var payload)
    implicitHeight: assignmentColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)
    readonly property bool connected: root.projection !== null && root.projection.connection === "connected"
    readonly property string draftKey: {
        if (!root.projection || !root.projection.selectedProjectId || !root.projection.selectedGoalId
                || !root.selectedAgentRunId) return ""
        return "assignment:" + root.projection.selectedProjectId + ":"
            + root.projection.selectedGoalId + ":" + root.selectedAgentRunId
    }
    readonly property string taskText: root.assignmentDraft.taskText || ""

    function writeDraft(patch) {
        if (root.draftKey === "") return
        var next = Object.assign({}, root.assignmentDraft)
        for (var key in patch) next[key] = patch[key]
        root.draftChanged(root.draftKey, JSON.stringify(next))
    }

    ColumnLayout {
        id: assignmentColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        // ---- Add agent ------------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "add_agent"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Add agent"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "Choose one unassigned session and the Role it should fill. Nothing is bound until you review and authorise."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Eligible sessions"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: !root.projection || !Array.isArray(root.projection.observedSessions)
                    || root.projection.observedSessions.length === 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No unassigned session is available. Start one outside the workbench first."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.observedSessions)
                    ? root.projection.observedSessions : []
                delegate: WorkbenchAction {
                    required property var modelData
                    Layout.fillWidth: true
                    highlighted: root.selectedObservedSessionId === modelData.observedSessionId
                    enabled: root.connected && modelData.availability === "available"
                    focusPolicy: Qt.StrongFocus
                    text: modelData.piStatus + "  ·  " + modelData.availability + " · " + modelData.lifecycle
                    onClicked: root.selectObserved(modelData.observedSessionId)
                }
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Role"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.roles) ? root.projection.roles : []
                delegate: WorkbenchAction {
                    required property var modelData
                    Layout.fillWidth: true
                    text: String(modelData)
                    highlighted: root.selectedRole === modelData
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.selectRole(String(modelData))
                }
            }
            WorkbenchAction {
                prominent: true
                objectName: "workbench-add-agent-continue"
                Layout.fillWidth: true
                text: "Review exact binding"
                enabled: root.connected && root.selectedObservedSessionId !== "" && root.selectedRole !== ""
                    && root.adoptionDetail !== null
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("adoption_review")
            }
            Text {
                Layout.fillWidth: true
                visible: root.selectedObservedSessionId !== "" && root.selectedRole !== ""
                    && root.adoptionDetail === null
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No authoritative adoption proposal matches this session and Role yet. Nothing can be authorised."
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
        }

        // ---- Adoption review ------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "adoption_review"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Adoption review"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: root.adoptionDetail === null ? "No adoption proposal is available for this selection."
                    : "Proposal: " + root.adoptionDetail.proposalId + "\n"
                        + "Observed session: " + root.adoptionDetail.observedSessionId + "\n"
                        + "Project / Node: " + root.adoptionDetail.projectId + " / " + root.adoptionDetail.executionNodeId + "\n"
                        + "Goal / Role: " + root.adoptionDetail.goalId + " / " + root.adoptionDetail.role + "\n"
                        + "Predecessor: " + (root.adoptionDetail.predecessorAgentRunId || "none")
                        + " · Vacancy generation: " + root.adoptionDetail.vacancyGeneration + "\n"
                        + "Stage: " + root.adoptionDetail.stage
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "ACK and committed delivery must precede readiness. No Assignment is created by adoption."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            WorkbenchAction {
                Layout.fillWidth: true
                text: "Authorize adoption"
                supportingText: "Runtime unavailable"
                enabled: false
                focusPolicy: Qt.StrongFocus
            }
        }

        // ---- Assignment preparation -----------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "assignment"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Assignment preparation"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Task"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            ScrollView {
                Layout.fillWidth: true
                Layout.preferredHeight: Style.space(84)
                clip: true
                WorkbenchTextArea {
                    id: taskEditor
                    objectName: "workbench-assignment-task"
                    textFormat: Text.PlainText
                    placeholderText: "Task"
                    wrapMode: TextEdit.WrapAnywhere
                    selectByMouse: true
                    activeFocusOnTab: true
                    text: root.taskText
                    onTextChanged: if (text !== root.taskText) root.writeDraft({ taskText: text })
                    // Tab inserts a tab character inside a multiline editor, so
                    // the editor would trap keyboard focus without an explicit
                    // hand-off to the next control.
                    Keys.onTabPressed: function(event) {
                        nextItemInFocusChain().forceActiveFocus()
                        event.accepted = true
                    }
                }
            }

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Target agent"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.managedAgents)
                    ? root.projection.managedAgents : []
                delegate: WorkbenchAction {
                    required property var modelData
                    Layout.fillWidth: true
                    highlighted: root.selectedAgentRunId === modelData.agentRunId
                    enabled: root.connected
                    focusPolicy: Qt.StrongFocus
                    text: modelData.role + " · " + modelData.piStatus + "  ·  " + modelData.controlMode
                    onClicked: root.selectAgent(modelData.agentRunId)
                }
            }

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Acceptance check"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: !root.projection || !Array.isArray(root.projection.checks)
                    || root.projection.checks.length === 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No acceptance check is configured for this Project. Configure checks before starting work."
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Repeater {
                model: root.projection && Array.isArray(root.projection.checks) ? root.projection.checks : []
                delegate: WorkbenchAction {
                    required property var modelData
                    Layout.fillWidth: true
                    highlighted: root.selectedCheckId === modelData.checkId
                        && root.selectedCheckVersion === modelData.version
                    enabled: root.connected && modelData.availability === "available"
                    focusPolicy: Qt.StrongFocus
                    text: modelData.name + " · v" + modelData.version
                    supportingText: modelData.mode + " · " + modelData.availability
                        + (modelData.reason === null ? "" : " — " + modelData.reason)
                    onClicked: root.selectCheck(modelData.checkId, modelData.version)
                }
            }
            WorkbenchAction {
                Layout.fillWidth: true
                text: "Configure checks"
                enabled: root.connected
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("checks")
            }
            Text {
                Layout.fillWidth: true
                visible: root.reviewBlockedReason !== ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: root.reviewBlockedReason
                color: root.reviewBlockedReason === "" ? root.mutedColor : Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            WorkbenchAction {
                prominent: true
                objectName: "workbench-start-review"
                Layout.fillWidth: true
                text: "Start review"
                enabled: root.connected && root.reviewBlockedReason === ""
                focusPolicy: Qt.StrongFocus
                onClicked: root.reviewStart()
            }
        }
    }
}
