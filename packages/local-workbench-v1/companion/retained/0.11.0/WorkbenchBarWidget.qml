// Companion-owned Omarchy bar button. The installed desktop launcher is a
// one-shot owner client; this widget owns no agent or durable state.
import QtQuick
import qs.Ui

BarWidget {
    id: root
    moduleName: "omarchestra.agent-console"
    implicitWidth: button.implicitWidth
    implicitHeight: button.implicitHeight

    BarIconButton {
        id: button
        anchors.fill: parent
        bar: root.bar
        text: "◎"
        tooltipText: "Omarchestra Workbench öffnen/schließen"
        onPressed: function(buttonCode) {
            if (buttonCode === Qt.LeftButton && root.bar)
                root.bar.run("gtk-launch omarchestra-workbench")
        }
    }
}
