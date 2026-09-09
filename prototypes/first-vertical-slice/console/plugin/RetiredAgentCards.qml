// PROTOTYPE — NOT PRODUCTION.
//
// Additive retirement surface for the Agent Console. Renders exactly one card
// per retired Agent Run and exposes only the explicit terminal-history purge
// intent. The component does not own authority or durable state.

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var cards: []
    property string pendingAgentRunId: ""
    property int intentCounter: 0
    readonly property color cardText: Color.popups.text
    readonly property color cardMutedText: Qt.darker(root.cardText, 1.45)

    signal requestPurge(var payload)

    implicitWidth: retiredColumn.implicitWidth
    implicitHeight: retiredColumn.implicitHeight

    onCardsChanged: {
        if (root.pendingAgentRunId !== ""
                && !root.cards.some(function(card) { return card.agentRunId === root.pendingAgentRunId })) {
            root.pendingAgentRunId = ""
        }
    }

    function nextIntentId() {
        root.intentCounter += 1
        return "retired-purge-" + root.intentCounter
    }

    ColumnLayout {
        id: retiredColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Repeater {
            model: root.cards

            delegate: BorderSurface {
                required property var modelData

                Layout.fillWidth: true
                implicitHeight: retiredContent.implicitHeight + Style.space(20)
                color: Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: retiredContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        color: root.cardText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: modelData.agentRunId
                        color: root.cardMutedText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Retired"
                        color: root.cardMutedText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: !modelData.canPurge
                        text: modelData.purgeBlockedReason || "Successor history must be deleted first."
                        color: root.cardMutedText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }

                    Button {
                        Layout.fillWidth: true
                        visible: modelData.canPurge || root.pendingAgentRunId === modelData.agentRunId
                        enabled: modelData.canPurge
                        text: root.pendingAgentRunId === modelData.agentRunId
                            ? "Confirm permanent delete"
                            : "Delete retired history"
                        onClicked: {
                            if (root.pendingAgentRunId !== modelData.agentRunId) {
                                root.pendingAgentRunId = modelData.agentRunId
                                return
                            }
                            root.requestPurge({
                                intentId: root.nextIntentId(),
                                kind: "purge_retired",
                                agentRunId: modelData.agentRunId
                            })
                            root.pendingAgentRunId = ""
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.pendingAgentRunId === modelData.agentRunId
                        text: "This permanently deletes Omarchestra history. Pi conversations, session files, processes, tools, and external artifacts are not changed."
                        color: root.cardMutedText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }
                }
            }
        }
    }
}
