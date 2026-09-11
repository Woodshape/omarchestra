// Local Workbench v1 — compact docked overview.
//
// Renders the runner status banner, fixture-mode label, Project selector,
// Active/Recent Team Goals, a compact agent overview, and navigation tabs.
// Board is visibly disabled with a reason and emits no intent. All values are
// injected plain projection values; this component never derives labels.
import QtQuick
import QtQuick.Layouts
import qs.Commons
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

    property var projection: null
    signal intentRequested(var payload)
    signal toggleDetail(string destination)
    implicitHeight: overviewColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)


    ColumnLayout {
        id: overviewColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        // Runner status banner
        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            text: root.projection === null ? "Loading"
                : "Runner: " + String(root.projection.connection)
            color: root.projection !== null && root.projection.connection === "gap"
                ? Color.urgent : Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            font.bold: true
        }

        // Fixture-mode label: injected data is never presented as live work.
        Text {
            Layout.fillWidth: true
            visible: root.projection !== null && root.projection.fixture
                && root.projection.fixture.active
            textFormat: Text.PlainText
            wrapMode: Text.WrapAnywhere
            text: root.projection === null ? "" : "Fixture · " + String(root.projection.fixture.label)
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
        }

        // Project selector
        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Project"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.projection && Array.isArray(root.projection.projects)
                ? root.projection.projects : []

            delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                text: modelData.canonicalPath
                enabled: root.projection !== null && root.projection.connection === "connected"
                focusPolicy: Qt.StrongFocus
                contentItem: Text { text: parent.text; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: root.textColor }
                highlighted: root.projection !== null
                    && root.projection.selectedProjectId === modelData.projectId
                onClicked: root.intentRequested({
                    kind: "select_project",
                    target: modelData.projectId,
                    payload: { projectId: modelData.projectId }
                })
            }
        }

        Text {
            Layout.fillWidth: true
            visible: !root.projection || !Array.isArray(root.projection.projects)
                || root.projection.projects.length === 0
            textFormat: Text.PlainText
            text: "No Project selected"
            color: root.mutedColor
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }

        // Team Goals
        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Team Goals"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Repeater {
            model: root.projection && Array.isArray(root.projection.goals)
                ? root.projection.goals : []

            delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                text: modelData.goalText
                enabled: root.projection !== null && root.projection.connection === "connected"
                focusPolicy: Qt.StrongFocus
                contentItem: Text { text: parent.text; textFormat: Text.PlainText; wrapMode: Text.WrapAnywhere; color: root.textColor }
                highlighted: root.projection !== null
                    && root.projection.selectedGoalId === modelData.goalId
                onClicked: root.intentRequested({
                    kind: "select_goal",
                    target: modelData.goalId,
                    payload: { goalId: modelData.goalId }
                })
            }
        }

        Button {
            Layout.fillWidth: true
            text: "New Team Goal"
            onClicked: root.toggleDetail("forms")
        }

        // Navigation tabs
        GridLayout {
            Layout.fillWidth: true
            columns: width < 500 ? 2 : 4
            Button { text: "Agents"; onClicked: root.toggleDetail("agents") }
            Button { text: "Assignments"; onClicked: root.toggleDetail("assignments") }
            Button {
                text: "Board"
                enabled: false
                ToolTip.visible: hovered
                ToolTip.text: "Board backend not available in this slice."
            }
            Button { text: "Activity"; onClicked: root.toggleDetail("activity") }
        }

        Text {
            Layout.fillWidth: true
            text: "Board backend is not available in this slice."
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.mutedColor
        }

        // Compact agent overview
        WorkbenchCards {
            Layout.fillWidth: true
            cards: root.projection && Array.isArray(root.projection.managedAgents)
                ? root.projection.managedAgents : []
            observed: root.projection ? root.projection.observedSessions : []
            retired: root.projection ? root.projection.retiredRuns : []
            actionable: root.projection !== null && root.projection.connection === "connected"
            onIntentRequested: function(payload) { root.intentRequested(payload) }
        }
    }
}
