// PROTOTYPE — NOT PRODUCTION
//
// AgentProjectionFixture.qml — an inert QML-facing fixture demonstrating the
// thin-client authority boundary. It shows the exact projection shape a future
// Omarchy Agent Console would consume: role cards rendered from snapshot and
// event data delivered by the runner protocol.
//
// This fixture is deliberately NOT a console. It owns no storage, performs no
// I/O itself, and holds no durable state. In the real product a small native
// bridge (outside QML) would connect to the runner's owner-only Unix socket,
// speak omarchestra.first-vertical-slice/v1, and hand QML plain snapshot and
// event values through the same properties shown below. QML renders
// projections and sends runner-validated intents; it never opens the
// database, never derives labels, and never supervises processes.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: root

    // Injected by the desktop shell; documented fixture contract only.
    // The transport itself lives outside QML: the host supplies one validated
    // snapshot and the ordered events accepted by the thin projection client.
    property string teamGoalId: "team-goal-vertical-slice-1"
    property string projectionSnapshotJson: "{}"
    property string projectionEventsJson: "[]"
    property var snapshot: {
        try {
            return JSON.parse(projectionSnapshotJson)
        } catch (e) {
            return {}
        }
    }
    property var projectionEvents: {
        try {
            var parsed = JSON.parse(projectionEventsJson)
            return Array.isArray(parsed) ? parsed : []
        } catch (e) {
            return []
        }
    }
    readonly property var latestProjectionEvent: projectionEvents.length > 0
        ? projectionEvents[projectionEvents.length - 1] : null

    readonly property var roleDisplayNames: ({
        coordinator: "Coordinator",
        builder: "Builder",
        reviewer: "Reviewer"
    })

    width: 480
    height: 320
    color: "#14141c"

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        Label {
            text: "Team Goal: " + root.teamGoalId
                  + "  ·  cursor " + (root.snapshot.cursor !== undefined ? root.snapshot.cursor : "-")
            color: "#dcdce6"
            font.bold: true
        }

        Repeater {
            model: root.snapshot.roles ? root.snapshot.roles.length : 0

            delegate: Rectangle {
                required property int index
                property var roleEntry: root.snapshot.roles[index]

                Layout.fillWidth: true
                implicitHeight: 64
                radius: 6
                color: "#1e1e2a"

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    spacing: 2

                    Label {
                        text: roleEntry ? roleEntry.nativeTerminalTitle : ""
                        color: "#eaeaf4"
                        font.family: "monospace"
                    }
                    Label {
                        text: roleEntry ? ("Pi status: " + roleEntry.piStatus
                              + "  ·  control=" + roleEntry.controlMode
                              + "  ·  assignment=" + (roleEntry.assignmentState || "none")) : ""
                        color: "#9a9ab0"
                        font.family: "monospace"
                    }
                }
            }
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#85859d"
            font.family: "monospace"
            text: "Ordered events: " + root.projectionEvents.length
                  + (root.latestProjectionEvent
                     ? "  ·  latest #" + root.latestProjectionEvent.sequence
                       + " " + root.latestProjectionEvent.eventType
                     : "  ·  latest -")
        }

        Label {
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            color: "#6d6d84"
            font.italic: true
            text: "Thin client: renders snapshot and event data only. It cannot open the"
                  + " database, derive labels, or send assignment/takeover frames."
        }
    }
}