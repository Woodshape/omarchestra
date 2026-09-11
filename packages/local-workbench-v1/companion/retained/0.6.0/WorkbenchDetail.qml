// Local Workbench v1 — expandable detail area.
//
// Shows Assignment/gate detail, Activity, and forms (New Team Goal,
// Assignment, Adoption confirmation). Renders plain injected values and emits
// intents. Form drafts are preserved by the host adapter; this component only
// surfaces text fields and confirmation buttons.
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
    property string destination: "assignments"
    property var drafts: ({})
    signal draftChanged(string key, string value)
    implicitHeight: detailColumn.implicitHeight
    signal intentRequested(var payload)

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)

    function actionAvailable(kind, target) {
        if (!projection || projection.connection !== "connected") return false
        return projection.actions.some(function(action) {
            return action.kind === kind && action.target === target && action.enabled
        })
    }

    function detailText(detail) {
        if (detail.kind === "adoption") return "Adoption " + detail.proposalId + " · " + detail.stage
            + "\nExact observed session: " + detail.observedSessionId + "\nProject / Node: " + detail.projectId + " / " + detail.executionNodeId
            + "\nGoal / Role: " + detail.goalId + " / " + detail.role + "\nPredecessor: " + (detail.predecessorAgentRunId || "none")
            + " · Vacancy generation: " + detail.vacancyGeneration + "\nACK and committed delivery must precede readiness. No Assignment is created."
        if (detail.kind === "handoff") return "Handoff " + detail.handoffId + " · " + detail.claimedState
            + "\nRun / Assignment / Attempt: " + detail.agentRunId + " / " + detail.assignmentId + " / " + detail.attemptId
            + "\nControl epoch: " + detail.controlEpoch + " · Outstanding effects: " + detail.outstandingEffects
            + "\n" + detail.summary + "\nArtifacts: " + detail.artifactRefs.join(", ")
            + "\nClaims are not proof tools stopped. Accept requests gate validation; it never bypasses the gate."
        if (detail.kind === "stop") return "Stop " + detail.stopId + " · " + detail.trigger + "\nAssignment: " + detail.assignmentId
            + "\nDispatch revoked: " + (detail.dispatchRevoked ? "yes" : "not confirmed")
            + "\nCancellation: " + detail.cancellationStatus + "\nCancellation acknowledgement is not tool/process termination. Files are retained."
        if (detail.kind === "diagnostics") return "Restricted diagnostics · " + detail.state + "\nAssignment / Attempt: " + detail.assignmentId + " / " + detail.attemptId
            + "\n" + detail.reason + "\nExplicit consent permits a filtered excerpt only. Filtering cannot guarantee secret removal. No output is included in this projection."
        if (detail.kind === "start") return "Start confirmation " + detail.confirmationId
            + "\nProject / Goal / Run: " + detail.projectId + " / " + detail.goalId + " / " + detail.agentRunId
            + "\nGoal: " + detail.goalText + "\nNode: " + detail.executionNodeId + "\nGit context: " + detail.gitCommonDir + " · HEAD " + detail.headOid
            + "\nBaseline: " + detail.baselineDigest + "\nDirty baseline: " + (detail.dirty ? "explicit acknowledgement required; existing changes retained" : "clean at capture")
            + "\nGate: " + detail.gate.gateId + " v" + detail.gate.version + " · " + detail.gate.digest
            + "\nExecutable: " + detail.gate.executable + "\nArgv (JSON, not shell): " + JSON.stringify(detail.gate.argv)
            + "\nCwd: " + detail.gate.cwd + "\nExplicit environment: " + JSON.stringify(detail.gate.environment)
            + "\nFrozen resources: " + JSON.stringify(detail.gate.resources)
            + "\nTimeout ms / output bytes: " + detail.gate.timeoutMs + " / " + detail.gate.outputBytes
            + "\nCorrections / elapsed ms: " + detail.maxCorrections + " / " + detail.elapsedMs
            + "\nThis is code execution. No isolation or rollback. A passing gate establishes only its encoded checks."
        return "Unavailable detail"
    }

    ColumnLayout {
        id: detailColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(10)

        Label {
            Layout.fillWidth: true
            visible: root.destination === "assignments" && (!root.projection || root.projection.assignments.length === 0)
            text: "No Assignments. Create a Goal and adopt an eligible Pi before starting work."
            textFormat: Text.PlainText; wrapMode: Text.Wrap; color: root.textColor
        }
        Repeater {
            model: root.projection && root.destination !== "activity" ? root.projection.details || [] : []
            delegate: ColumnLayout {
                required property var modelData
                Layout.fillWidth: true
                Label {
                    Layout.fillWidth: true
                    text: root.detailText(modelData)
                    textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: root.textColor
                }
                Button {
                    Layout.fillWidth: true
                    visible: modelData.kind === "adoption" || modelData.kind === "start" || modelData.kind === "diagnostics"
                    text: modelData.kind === "diagnostics" ? "Review diagnostic consent" : "Review exact confirmation"
                    focusPolicy: Qt.StrongFocus
                    onClicked: root.intentRequested({ kind: "preview_detail", target: null, payload: { detail: modelData } })
                }
            }
        }

        // Assignment / gate detail
        Text {
            Layout.fillWidth: true
            visible: root.destination === "assignments"
            textFormat: Text.PlainText
            text: "Assignments"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.destination === "assignments" && root.projection && Array.isArray(root.projection.assignments)
                ? root.projection.assignments : []

            delegate: Native.BorderSurface {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: assignmentColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: assignmentColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.goalText
                        textFormat: Text.PlainText
                        color: root.textColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        wrapMode: Text.Wrap
                    }

                    Text {
                        Layout.fillWidth: true
                        textFormat: Text.PlainText
                        text: "Gate " + (modelData.gateId || "unavailable") + " v" + String(modelData.gateVersion)
                            + " · Attempt " + (modelData.attemptId || "unavailable")
                            + " · Candidate " + (modelData.candidateRef || "unavailable")
                            + "\nState: " + modelData.state
                            + (modelData.gateResult === null ? "" : " · Gate: " + modelData.gateResult)
                            + " · Corrections: " + modelData.correctionCount + "/" + modelData.correctionLimit
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Diagnostics withheld. Filtered detail requires explicit operator request."
                        textFormat: Text.PlainText
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }

                    Text {
                        Layout.fillWidth: true
                        textFormat: Text.PlainText
                        text: "Artifacts: " + (modelData.artifactRefs || []).join(", ") + "\nA passing artifact-presence gate does not establish semantic correctness."
                        wrapMode: Text.Wrap
                        color: root.mutedColor
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Style.space(6)

                        Button {
                            text: "Take control"
                            enabled: root.actionAvailable("take_control", modelData.agentRunId)
                            onClicked: root.intentRequested({
                                kind: "take_control",
                                target: modelData.agentRunId,
                                payload: { assignmentId: modelData.assignmentId }
                            })
                        }
                        Button {
                            text: "Return to team"
                            enabled: root.actionAvailable("return_to_team", modelData.agentRunId)
                            onClicked: root.intentRequested({
                                kind: "return_to_team",
                                target: modelData.agentRunId,
                                payload: { assignmentId: modelData.assignmentId }
                            })
                        }
                        Button {
                            text: "Stop"
                            enabled: root.actionAvailable("stop", modelData.assignmentId)
                            onClicked: root.intentRequested({
                                kind: "stop",
                                target: modelData.assignmentId,
                                payload: { assignmentId: modelData.assignmentId }
                            })
                        }
                    }
                }
            }
        }

        // Activity feed
        Text {
            Layout.fillWidth: true
            visible: root.destination === "activity"
            textFormat: Text.PlainText
            text: "Activity"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.destination === "activity" && root.projection && Array.isArray(root.projection.activity)
                ? root.projection.activity : []

            delegate: Text {
                required property var modelData
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "#" + modelData.cursor + " " + modelData.kind
                    + (modelData.reasonCode === null ? "" : " (" + modelData.reasonCode + ")")
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.Wrap
            }
        }

        Text {
            Layout.fillWidth: true
            visible: root.destination === "assignments"
            textFormat: Text.PlainText
            text: "Unavailable actions require authoritative eligibility. Stop revokes dispatch, not proof that Pi/tools ended."
            wrapMode: Text.Wrap
            color: root.mutedColor
        }

        WorkbenchForms {
            Layout.fillWidth: true
            visible: root.destination === "forms"
            projection: root.projection
            drafts: root.drafts
            onDraftChanged: function(key, value) { root.draftChanged(key, value) }
            onIntentRequested: function(payload) { root.intentRequested(payload) }
        }
    }
}
