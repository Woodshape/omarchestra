// Local Workbench v1 — role-independent agent cards.
//
// Renders managed agent cards, observed sessions, and retired runs from plain
// injected values. piStatus is an opaque committed presentation string and is
// never rebuilt from role/control/assignment fields. Disabled actions show a
// reason; the runner computes domain eligibility, QML only narrows for
// stale/unsupported presentation.
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

    property var cards: []
    property var observed: []
    property var retired: []
    property bool actionable: false
    property bool historyExpanded: false
    implicitHeight: cardsColumn.implicitHeight
    signal intentRequested(var payload)

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)


    ColumnLayout {
        id: cardsColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Managed agents"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.cards

            delegate: Native.BorderSurface {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: cardColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: cardColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        textFormat: Text.PlainText
                        color: root.textColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        wrapMode: Text.WrapAnywhere
                    }

                    Text {
                        textFormat: Text.PlainText
                        Layout.fillWidth: true
                        text: modelData.role + " · " + modelData.controlMode + " · " + modelData.connectionStatus
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        textFormat: Text.PlainText
                        visible: modelData.assignment !== null
                        text: modelData.assignment === null ? "" : "Assignment: " + modelData.assignment
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }

                    Repeater {
                        model: modelData.actions || []

                        delegate: Button {
                            required property var modelData
                            Layout.fillWidth: true
                            text: modelData.kind + (modelData.enabled ? "" : ": " + (modelData.reason || "Unavailable"))
                            enabled: root.actionable && modelData.enabled
                            contentItem: Text {
                                text: parent.text
                                textFormat: Text.PlainText
                                wrapMode: Text.WrapAnywhere
                                color: root.textColor
                            }
                            focusPolicy: Qt.StrongFocus
                            onClicked: root.intentRequested({
                                kind: modelData.kind,
                                target: modelData.target,
                                payload: {}
                            })
                        }
                    }
                }
            }
        }

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Unassigned sessions"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.observed

            delegate: Native.BorderSurface {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: observedColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: observedColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        textFormat: Text.PlainText
                        color: root.textColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        wrapMode: Text.WrapAnywhere
                    }

                    Text {
                        textFormat: Text.PlainText
                        wrapMode: Text.WrapAnywhere
                        Layout.fillWidth: true
                        text: "Availability: " + modelData.availability + " · Lifecycle: " + modelData.lifecycle
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Repeater {
                        model: modelData.choices || []

                        delegate: Button {
                            required property var modelData
                            Layout.fillWidth: true
                            text: modelData.label
                            contentItem: Text { text: parent.text; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: root.textColor }
                            focusPolicy: Qt.StrongFocus
                            enabled: root.actionable && modelData.enabled
                            onClicked: root.intentRequested({
                                kind: "request_adoption",
                                target: modelData.choiceId,
                                payload: { choiceId: modelData.choiceId }
                            })
                        }
                    }
                }
            }
        }

        Button {
            Layout.fillWidth: true
            text: "Retired history (" + root.retired.length + ")"
            onClicked: root.historyExpanded = !root.historyExpanded
        }

        Repeater {
            model: root.historyExpanded ? root.retired : []

            delegate: Native.BorderSurface {
                required property var modelData
                Layout.fillWidth: true
                implicitHeight: retiredColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: retiredColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        textFormat: Text.PlainText
                        color: root.textColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        wrapMode: Text.WrapAnywhere
                    }

                    Text {
                        textFormat: Text.PlainText
                        Layout.fillWidth: true
                        visible: !modelData.canPurge
                        text: modelData.purgeBlockedReason || "Successor history must be deleted first."
                        color: root.mutedColor
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }

                    Button {
                        Layout.fillWidth: true
                        visible: modelData.canPurge
                        enabled: root.actionable && modelData.canPurge
                        text: "Delete retired history"
                        onClicked: root.intentRequested({
                            kind: "purge",
                            target: modelData.agentRunId,
                            payload: { agentRunId: modelData.agentRunId }
                        })
                    }
                }
            }
        }
    }
}
