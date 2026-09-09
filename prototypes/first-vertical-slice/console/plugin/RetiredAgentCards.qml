// PROTOTYPE — NOT PRODUCTION.
//
// Additive retirement surface for the Agent Console. Renders exactly one card
// per retired Agent Run with a `Retired · <Role>` label and the same opaque
// committed presentation strings used elsewhere. The component deliberately
// does not generate IDs, does not own authority, and exposes no actionable
// actions — the user can only observe the historical state.

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var cards: []
    readonly property color cardText: Color.popups.text
    readonly property color cardMutedText: Qt.darker(root.cardText, 1.45)

    implicitWidth: retiredColumn.implicitWidth
    implicitHeight: retiredColumn.implicitHeight

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
                }
            }
        }
    }
}
