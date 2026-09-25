// Local Workbench v1 — Board surface (reserved, visibly disabled).
//
// The Board destination is reserved for a future slice. It renders visibly
// disabled with a reason and emits no intent. No fake posting, subscription,
// message delivery, execution, or progress is presented as live functionality.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons

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

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)

    ColumnLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Board"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Board backend is not available in this slice. No posting, subscriptions, or message delivery are simulated."
            color: root.mutedColor
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
        }

        WorkbenchAction {
            Layout.fillWidth: true
            text: "Open Board"
            enabled: false
        }
    }
}
