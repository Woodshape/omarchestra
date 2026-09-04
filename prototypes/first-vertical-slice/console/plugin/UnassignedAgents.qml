// PROTOTYPE — NOT PRODUCTION.
//
// Presentation-only view of the bounded observer projection. The adapter
// supplies opaque status, lifecycle, availability, health, choices, and
// exact proposal values. This component emits only plain presentation intents.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var projection: ({ observerRevision: 0, agents: [] })
    property var observedIntentResult: null
    property var pendingProposal: null
    property int intentCounter: 0

    signal requestAdoption(var payload)
    signal authorizeAdoption(var payload)

    implicitWidth: agentsColumn.implicitWidth
    implicitHeight: agentsColumn.implicitHeight + confirmationColumn.implicitHeight + Style.space(16)

    function nextIntentId(kind) {
        intentCounter += 1
        return "observer-" + kind + "-" + String(intentCounter)
    }

    function clearIntentState() {
        observedIntentResult = null
        pendingProposal = null
        intentCounter = 0
    }

    function applyIntentResult(value) {
        if (!value || typeof value !== "object") return false
        observedIntentResult = value
        if (value.phase !== "proposal"
                || typeof value.proposalId !== "string"
                || typeof value.proposalDigest !== "string") {
            pendingProposal = null
            return true
        }
        pendingProposal = ({
            proposalId: value.proposalId,
            proposalDigest: value.proposalDigest,
            displayLabel: value.displayLabel,
            remainingMs: value.remainingMs
        })
        return true
    }

    ColumnLayout {
        id: agentsColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Text {
            Layout.fillWidth: true
            text: "Unassigned Agents"
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Text {
            Layout.fillWidth: true
            visible: !root.projection || !Array.isArray(root.projection.agents)
                    || root.projection.agents.length === 0
            text: "No observed Pi sessions"
            color: Qt.darker(Color.popups.text, 1.35)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }

        Repeater {
            model: root.projection && Array.isArray(root.projection.agents)
                ? root.projection.agents : []

            delegate: BorderSurface {
                id: agentCard
                required property var modelData
                readonly property string observedSessionId: modelData.observedSessionId

                Layout.fillWidth: true
                implicitHeight: agentColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                    Color.popups.text.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                        Color.popups.text.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: agentColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: Style.space(12)
                    spacing: Style.space(4)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        color: Color.popups.text
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Availability: " + modelData.availability
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Lifecycle: " + modelData.lifecycle
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Health: " + modelData.health
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Flow {
                        Layout.fillWidth: true
                        spacing: Style.space(6)

                        Repeater {
                            model: modelData.choices || []

                            delegate: Button {
                                required property var modelData

                                text: modelData.label
                                enabled: modelData.enabled
                                onClicked: root.requestAdoption({
                                    intentId: root.nextIntentId("request"),
                                    kind: "request_adoption",
                                    observedSessionId: agentCard.observedSessionId,
                                    choiceId: modelData.choiceId
                                })
                            }
                        }
                    }
                }
            }
        }
    }

    ColumnLayout {
        id: confirmationColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: agentsColumn.bottom
        anchors.topMargin: Style.space(8)
        spacing: Style.space(4)

        Text {
            Layout.fillWidth: true
            visible: root.observedIntentResult !== null
            text: root.observedIntentResult === null ? "" : root.observedIntentResult.detail
            color: Qt.darker(Color.popups.text, 1.25)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
        }

        Button {
            Layout.fillWidth: true
            visible: root.pendingProposal !== null
            enabled: root.pendingProposal !== null
            text: root.pendingProposal === null
                ? ""
                : "Confirm " + String(root.pendingProposal.displayLabel)
            onClicked: root.authorizeAdoption({
                intentId: root.nextIntentId("authorize"),
                kind: "authorize_adoption",
                proposalId: root.pendingProposal.proposalId,
                proposalDigest: root.pendingProposal.proposalDigest
            })
        }
    }
}
