// Local Workbench v1 — exact Start review and compact Work/Result.
//
// The review renders the exact captured facts: Project, Goal, target agent,
// Git context, baseline, frozen gate identity and the semantic claim the gate
// does and does not make. Confirm start stays visibly disabled because runtime
// execution is unavailable in this slice, and no click here can report a
// committed start. Work/Result shows only committed assignment facts.
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
    property string mode: "start_review"
    property var startReview: null
    property var startDetail: null
    property var selectedCheck: null
    property var armedConfirmation: null
    property bool technicalOpen: false
    onStartReviewChanged: technicalOpen = false
    onStartDetailChanged: technicalOpen = false
    onVisibleChanged: technicalOpen = false
    /** Bounded work rows: `{ assignment, resultText }`, one per committed Assignment. */
    property var rows: []
    /** Managed agent cards, matched to an Assignment by agentRunId. */
    property var agents: []
    /** Stated when the bounded row list hides committed Assignments. */
    property string truncationNote: ""
    signal navigate(string destination)
    signal intentRequested(var payload)
    implicitHeight: reviewColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)
    readonly property bool connected: root.projection !== null && root.projection.connection === "connected"
    readonly property bool actionable: root.connected

    function cardForAssignment(assignment) {
        if (assignment === null || assignment === undefined || !Array.isArray(root.agents)) return null
        for (var i = 0; i < root.agents.length; i++) {
            if (root.agents[i].agentRunId === assignment.agentRunId) return root.agents[i]
        }
        return null
    }

    /**
     * Assignment-scoped interventions for one committed card. The runner still
     * owns eligibility; this only selects the subset shown beside the result.
     */
    function interventionActionsFor(card) {
        var kinds = ["take_control", "return_to_team", "accept", "resume", "retry", "stop"]
        if (card === null || !Array.isArray(card.actions)) return []
        return card.actions.filter(function (action) {
            return kinds.indexOf(action.kind) !== -1
        })
    }

    /** Null means this row cannot supply the identity its intent requires. */
    function interventionPayload(assignment) {
        if (assignment === null || assignment === undefined) return null
        return { assignmentId: assignment.assignmentId }
    }

    ColumnLayout {
        id: reviewColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        // ---- Exact start review ---------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "start_review"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Start review"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                objectName: "workbench-start-context-status"
                Layout.fillWidth: true
                visible: root.projection !== null && typeof root.projection.selectedProjectId === "string"
                    && root.projection.selectedProjectId.length > 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: !visible ? "" : typeof root.projection.selectedProject !== "object"
                    || root.projection.selectedProject === null
                    ? "Project context is unavailable in this snapshot. Start remains blocked until the Runner provides a fresh context report."
                    : root.projection.selectedProject.contextMatch === true
                        ? "Project context matches: every current Run in this Goal is ready and reports this Project root on a fresh bridge."
                        : "Project context does not match or is unavailable. Start remains blocked; Omarchestra will not change Pi's working directory."
                color: visible && typeof root.projection.selectedProject === "object"
                    && root.projection.selectedProject !== null && root.projection.selectedProject.contextMatch === true
                    ? root.mutedColor : Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                Layout.fillWidth: true
                visible: root.startDetail === null
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No authoritative start proposal matches this Goal, target and check. Nothing can be confirmed."
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: root.startReview === null ? "Review expired. Return to the assignment to review again."
                    : "Task: " + root.startReview.taskText
                        + "\nAgent: " + (root.cardForAssignment(root.startReview) ? root.cardForAssignment(root.startReview).role : "Unavailable")
                        + "\nAcceptance check: " + (root.selectedCheck ? root.selectedCheck.name : "Unavailable")
                        + (root.startDetail ? "\nCommand: " + root.startDetail.gate.executable + " " + JSON.stringify(root.startDetail.gate.argv)
                            + "\nLocation: " + root.startDetail.gate.cwd
                            + "\nExisting changes: " + (root.startDetail.dirty ? "retained; no isolation or rollback" : "clean at capture")
                            + "\nCheck timeout: " + root.startDetail.gate.timeoutMs / 1000 + " seconds"
                            + " · Output limit: " + root.startDetail.gate.outputBytes + " bytes"
                            + "\nCorrection limit: " + root.startDetail.maxCorrections
                            + " · Work time limit: " + root.startDetail.elapsedMs / 1000 + " seconds" : "")
                color: root.textColor
            }
            WorkbenchAction {
                objectName: "workbench-technical-details"
                visible: root.startDetail !== null
                text: root.technicalOpen ? "Hide technical details" : "Technical details"
                Accessible.name: text
                onClicked: root.technicalOpen = !root.technicalOpen
            }
            Text {
                Layout.fillWidth: true
                visible: root.startDetail !== null && root.technicalOpen
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: root.startDetail === null ? "" :
                    "Confirmation: " + root.startDetail.confirmationId + "\n"
                    + "Project / Goal / Agent: " + root.startDetail.projectId + " / "
                        + root.startDetail.goalId + " / " + root.startDetail.agentRunId + "\n"
                    + "Goal: " + root.startDetail.goalText + "\n"
                    + "Node: " + root.startDetail.executionNodeId + "\n"
                    + "Git context: " + root.startDetail.gitCommonDir + " · HEAD " + root.startDetail.headOid + "\n"
                    + "Baseline digest: " + root.startDetail.baselineDigest + "\n"
                    + "Dirty baseline: " + (root.startDetail.dirty ? "yes — existing changes are retained" : "clean at capture") + "\n"
                    + "Check: " + root.startDetail.gate.gateId + " v" + root.startDetail.gate.version
                        + " · " + root.startDetail.gate.digest + "\n"
                    + "Executable: " + root.startDetail.gate.executable
                        + " · digest " + root.startDetail.gate.executableDigest + "\n"
                    + "Argv (JSON, not shell): " + JSON.stringify(root.startDetail.gate.argv) + "\n"
                    + "Cwd: " + root.startDetail.gate.cwd + "\n"
                    + "Explicit environment: " + JSON.stringify(root.startDetail.gate.environment) + "\n"
                    + "Frozen resources: " + JSON.stringify(root.startDetail.gate.resources) + "\n"
                    + "Timeout ms / output bytes: " + root.startDetail.gate.timeoutMs
                        + " / " + root.startDetail.gate.outputBytes + "\n"
                    + "Corrections / elapsed ms: " + root.startDetail.maxCorrections
                        + " / " + root.startDetail.elapsedMs
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "This is code execution with no isolation or rollback. A passing check establishes only its encoded claim, never semantic correctness."
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            WorkbenchAction {
                Layout.fillWidth: true
                text: "Back to assignment"
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("assignment")
            }
            WorkbenchAction {
                objectName: "workbench-confirm-start"
                Layout.fillWidth: true
                text: "Confirm start"
                supportingText: "runtime unavailable"
                enabled: false
                focusPolicy: Qt.StrongFocus
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "Nothing is committed by this review. Starting work requires the runtime execution port."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
        }

        // ---- Work and result ------------------------------------------
        ColumnLayout {
            Layout.fillWidth: true
            visible: root.mode === "work"
            spacing: Style.space(8)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Work and result"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.heading
                font.bold: true
            }
            Text {
                Layout.fillWidth: true
                visible: root.rows.length === 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: "No assignment has been started in this Project."
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Repeater {
                model: root.rows

                delegate: Native.BorderSurface {
                    id: workRow
                    required property var modelData
                    readonly property var rowAssignment: modelData.assignment
                    readonly property var rowCard: root.cardForAssignment(rowAssignment)
                    Layout.fillWidth: true
                    implicitHeight: rowColumn.implicitHeight + Style.space(20)
                    color: "transparent"
                    borderSpec: Border.flat("transparent", 0)
                    radius: Style.cornerRadius

                    ColumnLayout {
                        id: rowColumn
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        anchors.leftMargin: Style.space(12)
                        anchors.rightMargin: Style.space(12)
                        spacing: Style.space(4)

                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            wrapMode: Text.WrapAnywhere
                            text: "Assignment: " + workRow.rowAssignment.assignmentId + " · " + workRow.rowAssignment.state + "\n"
                                + "Goal / Agent: " + workRow.rowAssignment.goalId + " / " + workRow.rowAssignment.agentRunId + "\n"
                                + "Task: " + workRow.rowAssignment.goalText + "\n"
                                + "Check: " + workRow.rowAssignment.gateId + " v" + workRow.rowAssignment.gateVersion
                                    + " · result " + workRow.rowAssignment.gateResult + "\n"
                                + "Attempt: " + workRow.rowAssignment.attemptId
                                    + " · corrections " + workRow.rowAssignment.correctionCount
                                    + "/" + workRow.rowAssignment.correctionLimit + "\n"
                                + "Candidate: " + workRow.rowAssignment.candidateRef + "\n"
                                + "Artifacts: " + (workRow.rowAssignment.artifactRefs.length === 0
                                    ? "none" : workRow.rowAssignment.artifactRefs.join(", "))
                            color: root.textColor
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                        }
                        Repeater {
                            model: root.interventionActionsFor(workRow.rowCard)

                            delegate: WorkbenchAction {
                                required property var modelData
                                readonly property var requestPayload: root.interventionPayload(workRow.rowAssignment)
                                readonly property bool available: root.actionable && modelData.enabled
                                    && requestPayload !== null
                                readonly property var requestIntent: ({ kind: modelData.kind,
                                    target: modelData.target, payload: requestPayload })
                                Layout.fillWidth: true
                                confirmationIntent: requestIntent
                                armedIntent: root.armedConfirmation
                                highlighted: awaitingConfirmation
                                text: confirmationText(modelData.label || modelData.kind)
                                supportingText: available ? "" : (modelData.reason || "Unavailable")
                                enabled: available
                                focusPolicy: Qt.StrongFocus
                                onClicked: root.intentRequested(requestIntent)
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            visible: String(modelData.resultText) !== ""
                            textFormat: Text.PlainText
                            wrapMode: Text.WrapAnywhere
                            text: String(modelData.resultText)
                            color: root.mutedColor
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                        }
                    }
                }
            }
            Text {
                Layout.fillWidth: true
                visible: root.truncationNote !== ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                text: root.truncationNote
                color: Color.urgent
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            WorkbenchAction {
                Layout.fillWidth: true
                text: "Back to Project"
                focusPolicy: Qt.StrongFocus
                onClicked: root.navigate("overview")
            }
        }
    }
}
