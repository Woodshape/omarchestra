// Flat, discoverable actions with Qt activation and Omarchy cursor chrome.
import QtQuick
import QtQuick.Controls as Controls
import qs.Commons
import qs.Ui as Native

Controls.Button {
    id: root
    property bool prominent: false
    property string explanation: ""
    property string supportingText: ""
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true
    padding: Style.space(8)
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    font.bold: prominent || highlighted
    Accessible.description: [supportingText, explanation].filter(function(s) { return s !== "" }).join(". ")
    background: Item {
        // Resting affordance remains visible without a platform bevel/gradient.
        Rectangle {
            anchors.fill: parent
            radius: Style.cornerRadius
            color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, root.enabled ? 0.065 : 0.02)
            border.width: 1
            border.color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, root.enabled ? 0.14 : 0.05)
        }
        Native.CursorSurface {
            anchors.fill: parent
            foreground: Color.popups.text
            accent: Color.accent
            hasCursor: root.enabled && (root.hovered || root.visualFocus || root.down)
            current: root.highlighted
        }
        Rectangle {
            visible: root.highlighted || root.visualFocus
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: Style.space(2)
            color: Color.accent
        }
    }
    contentItem: Item {
        implicitWidth: Math.max(actionLabel.implicitWidth, supportLabel.implicitWidth)
        implicitHeight: actionLabel.implicitHeight + (supportLabel.visible ? Style.space(3) + supportLabel.implicitHeight : 0)
        Text {
            id: actionLabel
            width: parent.width
            text: root.text
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            color: root.prominent && root.enabled ? Color.accent : Color.popups.text
            opacity: root.enabled ? 1 : 0.5
            font: root.font
        }
        Text {
            id: supportLabel
            y: actionLabel.implicitHeight + Style.space(3)
            width: parent.width
            visible: root.supportingText !== ""
            text: root.supportingText
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            color: Color.popups.text
            opacity: 0.65
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
    }
    Controls.ToolTip.visible: hovered && explanation !== ""
    Controls.ToolTip.text: explanation
}
