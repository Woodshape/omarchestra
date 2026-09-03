// PROTOTYPE — NOT PRODUCTION.
//
// Cards are deliberately fed plain values. In particular, piStatus is an
// opaque committed presentation string and is never rebuilt in this component.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var cards: []
    readonly property color cardText: Color.popups.text
    signal presentRequested(string role)
    readonly property color cardMutedText: Qt.darker(root.cardText, 1.45)

    implicitWidth: cardColumn.implicitWidth
    implicitHeight: cardColumn.implicitHeight

    ColumnLayout {
        id: cardColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Repeater {
            model: root.cards

            delegate: BorderSurface {
                required property var modelData

                Layout.fillWidth: true
                implicitHeight: cardContent.implicitHeight + Style.space(20)
                color: Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                MouseArea {
                    anchors.fill: parent
                    enabled: modelData && typeof modelData.role === "string"
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.presentRequested(modelData.role)
                }

                ColumnLayout {
                    id: cardContent
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
                }
            }
        }
    }
}
