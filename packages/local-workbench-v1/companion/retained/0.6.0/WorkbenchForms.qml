// Presentation drafts only. No field or preview grants runtime authority.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
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
    property var drafts: ({})
    property string loadedKey: ""
    property bool restoring: false
    property string draftError: ""
    property string selectedRunId: ""
    readonly property string targetKey: projection ? JSON.stringify([projection.selectedProjectId, projection.selectedGoalId, selectedRunId]) : ""
    implicitHeight: formsColumn.implicitHeight
    signal intentRequested(var payload)
    signal draftChanged(string key, string value)

    function fieldState() {
        return { goalText: goalText.text, assignmentText: assignmentText.text,
            targetRun: selectedRunId, gateId: gateId.text, gateVersion: gateVersion.value,
            executable: executable.text, argv: argv.text, context: context.text,
            environment: environment.text, resources: resources.text,
            timeout: timeout.value, output: output.value,
            corrections: corrections.value, elapsed: elapsed.value }
    }

    function saveDraft() {
        if (restoring || !loadedKey) return
        var encoded = JSON.stringify(fieldState())
        if (encoded.length > 24000) { draftError = "Draft too large to retain. Shorten fields before switching targets."; return }
        draftError = ""
        draftChanged(loadedKey, encoded)
    }

    function loadDraft() {
        if (targetKey === loadedKey) return
        restoring = true
        loadedKey = targetKey
        var state = {}
        try { state = JSON.parse(drafts[loadedKey] || "{}") } catch (error) { state = {} }
        goalText.text = state.goalText || ""
        assignmentText.text = state.assignmentText || ""
        targetRun.currentIndex = targetRun.model.indexOf(selectedRunId)
        gateId.text = state.gateId || ""
        gateVersion.value = state.gateVersion || 1
        executable.text = state.executable || ""
        argv.text = state.argv || ""
        context.text = state.context || ""
        environment.text = state.environment || ""
        resources.text = state.resources || ""
        timeout.value = state.timeout || 60
        output.value = state.output || 65536
        corrections.value = state.corrections === undefined ? 1 : state.corrections
        elapsed.value = state.elapsed || 900
        restoring = false
    }

    onTargetKeyChanged: loadDraft()
    Component.onCompleted: loadDraft()

    function actionAvailable(kind) {
        if (!projection || projection.connection !== "connected") return false
        return projection.actions.some(function(action) { return action.kind === kind && action.enabled })
    }

    ColumnLayout {
        id: formsColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Label { Layout.fillWidth: true; textFormat: Text.PlainText; text: "New Team Goal"; color: Color.popups.text; font.bold: true }
        Label {
            Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap
            text: "Project: " + (root.projection ? root.projection.selectedProjectId || "Select a Project" : "Unavailable") + "\nLocal, adoption-first. No automatic Pi launch."
            color: Color.popups.text
        }
        TextArea { id: goalText; Keys.onTabPressed: (createGoal.enabled ? createGoal : assignmentText).forceActiveFocus(Qt.TabFocusReason); KeyNavigation.priority: KeyNavigation.BeforeItem; activeFocusOnTab: true; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Team Goal"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        Button {
            id: createGoal
            Layout.fillWidth: true; text: "Create Team Goal"; focusPolicy: Qt.StrongFocus
            enabled: root.actionAvailable("create_goal") && goalText.text.trim().length > 0 && goalText.text.length <= 8192
            onClicked: root.intentRequested({ kind: "create_goal", target: null, payload: { goalText: goalText.text, projectId: root.projection.selectedProjectId } })
        }

        Label { Layout.fillWidth: true; textFormat: Text.PlainText; text: "Assignment draft (not authorized)"; color: Color.popups.text; font.bold: true }
        TextArea { id: assignmentText; Keys.onTabPressed: targetRun.forceActiveFocus(Qt.TabFocusReason); KeyNavigation.priority: KeyNavigation.BeforeItem; activeFocusOnTab: true; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Assignment goal"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        ComboBox {
            id: targetRun; Layout.fillWidth: true; editable: false
            Accessible.name: "Target Agent Run identity"
            model: root.projection ? root.projection.managedAgents.map(function(card) { return card.agentRunId }) : []
            onModelChanged: currentIndex = model.indexOf(root.selectedRunId)
            onActivated: { root.saveDraft(); root.selectedRunId = currentText }
        }
        TextField { id: gateId; Layout.fillWidth: true; placeholderText: "Gate identity"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        Label { textFormat: Text.PlainText; text: "Gate version"; color: Color.popups.text }
        SpinBox { id: gateVersion; from: 1; to: 9999; value: 1; Accessible.name: "Gate version"; onValueModified: root.saveDraft() }
        TextField { id: executable; Layout.fillWidth: true; placeholderText: "Absolute validator executable"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        TextArea { id: argv; Keys.onTabPressed: context.forceActiveFocus(Qt.TabFocusReason); KeyNavigation.priority: KeyNavigation.BeforeItem; activeFocusOnTab: true; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Arguments: one per line, no shell expansion"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        TextField { id: context; Layout.fillWidth: true; placeholderText: "Canonical execution cwd"; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        TextArea { id: environment; Keys.onTabPressed: resources.forceActiveFocus(Qt.TabFocusReason); KeyNavigation.priority: KeyNavigation.BeforeItem; activeFocusOnTab: true; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Explicit nonsecret environment entries (NAME=value). No ambient inheritance."; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        TextArea { id: resources; Keys.onTabPressed: timeout.forceActiveFocus(Qt.TabFocusReason); KeyNavigation.priority: KeyNavigation.BeforeItem; activeFocusOnTab: true; Layout.fillWidth: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; placeholderText: "Validator resource paths. The runner must resolve and hash them before confirmation."; Accessible.name: placeholderText; onTextChanged: root.saveDraft() }
        Label { textFormat: Text.PlainText; text: "Timeout seconds / output bytes"; color: Color.popups.text }
        SpinBox { id: timeout; from: 1; to: 300; value: 60; Accessible.name: "Gate timeout seconds"; onValueModified: root.saveDraft() }
        SpinBox { id: output; from: 1; to: 65536; value: 65536; Accessible.name: "Gate output byte limit"; onValueModified: root.saveDraft() }
        Label { textFormat: Text.PlainText; text: "Maximum corrections / elapsed seconds"; color: Color.popups.text }
        SpinBox { id: corrections; from: 0; to: 3; value: 1; Accessible.name: "Maximum corrections"; onValueModified: root.saveDraft() }
        SpinBox { id: elapsed; from: 1; to: 3600; value: 900; Accessible.name: "Assignment elapsed seconds"; onValueModified: root.saveDraft() }
        Label {
            Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap; color: Color.popups.text
            text: "Selected Run: " + (root.selectedRunId || "none") + "\nGate execution is code execution. Review the exact runner-resolved gate digest, resource hashes, execution context and dirty baseline in Details. Draft text is never an authority confirmation."
        }
        Button { Layout.fillWidth: true; text: "Start Assignment — runtime unavailable"; enabled: false }
        Label { Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap; text: root.draftError; visible: text.length > 0; color: Color.popups.text }
    }
}
