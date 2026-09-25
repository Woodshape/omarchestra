import QtQuick
import QtQuick.Controls as Controls
import qs.Commons

Controls.TextArea {
    id: root
    color: Color.popups.text
    placeholderTextColor: Qt.rgba(color.r, color.g, color.b, 0.5)
    selectionColor: Color.accent
    selectedTextColor: Color.popups.background
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    padding: Style.space(10)
    selectByMouse: true
    activeFocusOnTab: true
    textFormat: TextEdit.PlainText
    wrapMode: TextEdit.WrapAnywhere
    background: Rectangle {
        color: Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.025)
        radius: Style.cornerRadius
        border.width: 1
        border.color: root.activeFocus ? Color.accent : Qt.rgba(Color.popups.text.r, Color.popups.text.g, Color.popups.text.b, 0.22)
    }
}
