// Local Workbench v1 — Project-level acceptance check configuration.
//
// Reusable check definitions live with the Project, not inside a single Team
// Goal. Selecting a check for an assignment narrows what is verified; it never
// turns validation off. Missing or invalid configuration blocks Start review
// with an explicit reason. Only an operator may edit a definition, and saving
// emits one intent that the runner must commit. This component executes
// nothing.
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

    property var projection: null
    property string selectedCheckId: ""
    property int selectedCheckVersion: 0
    property string checksDraft: ""
    property bool advancedOpen: false
    onSelectedCheckIdChanged: advancedOpen = false
    onSelectedCheckVersionChanged: advancedOpen = false
    signal draftChanged(string value)
    signal navigate(string destination)
    signal selectCheck(string checkId, int version)
    signal intentRequested(var payload)
    implicitHeight: checksColumn.implicitHeight

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)
    readonly property bool connected: root.projection !== null && root.projection.connection === "connected"
    // Mirrors the runner's closed `CheckMode` union. Adding a mode is a schema
    // change, never a free-text QML edit.
    readonly property var checkModes: ["validator", "artifact_presence"]
    readonly property var selectedCheck: {
        if (!root.projection || !Array.isArray(root.projection.checks)) return null
        for (var i = 0; i < root.projection.checks.length; i++) {
            if (root.projection.checks[i].checkId === root.selectedCheckId
                    && root.projection.checks[i].version === root.selectedCheckVersion) return root.projection.checks[i]
        }
        return null
    }
    readonly property var editState: {
        try { return JSON.parse(root.checksDraft || "{}") } catch (error) { return {} }
    }
    readonly property string draftName: editState.name === undefined
        ? (root.selectedCheck === null ? "" : root.selectedCheck.name) : String(editState.name)
    readonly property string draftSummary: editState.summary === undefined
        ? (root.selectedCheck === null ? "" : root.selectedCheck.summary) : String(editState.summary)
    readonly property string draftCommand: editState.commandSummary === undefined
        ? (root.selectedCheck === null ? "" : root.selectedCheck.commandSummary) : String(editState.commandSummary)
    readonly property string draftMode: editState.mode === undefined
        ? (root.selectedCheck === null ? "validator" : root.selectedCheck.mode) : String(editState.mode)

    function writeDraft(patch) {
        var next = Object.assign({}, root.editState)
        for (var key in patch) next[key] = patch[key]
        root.draftChanged(JSON.stringify(next))
    }

    readonly property var configurationDetail: {
        if (!projection || !projection.details) return null
        for (var i = 0; i < projection.details.length; i++) {
            var d = projection.details[i]
            if (d.kind === "check_configuration" && d.projectId === projection.selectedProjectId
                    && d.checkId === selectedCheckId && d.checkVersion === selectedCheckVersion) return d
        }
        return null
    }
    readonly property var fields: {
        var d = configurationDetail ? configurationDetail.definitionDraft : null
        return Object.assign({ executable: d ? d.executable : "", argv: d ? d.argv.join("\n") : "",
            cwd: d ? d.cwd : "", environment: d ? d.environment.map(function(e) { return e.name + "=" + e.value }).join("\n") : "",
            resourcePaths: d ? d.resourcePaths.join("\n") : "", timeoutMs: d ? String(d.timeoutMs) : "60000",
            outputBytes: d ? String(d.outputBytes) : "65536", maxCorrections: d ? String(d.maxCorrections) : "1",
            elapsedMs: d ? String(d.elapsedMs) : "900000" }, editState.fields || {})
    }
    readonly property var fieldSpecs: [
        {key:"executable", label:"Absolute executable"}, {key:"argv", label:"Arguments — one per line; no shell expansion"},
        {key:"cwd", label:"Working directory — absolute path"}, {key:"environment", label:"Nonsecret environment — NAME=value, one per line"},
        {key:"resourcePaths", label:"Validator resources — absolute paths, one per line"},
        {key:"timeoutMs", label:"Check timeout (ms, 100–300000)"}, {key:"outputBytes", label:"Output limit (bytes, 1–65536)"},
        {key:"maxCorrections", label:"Maximum corrections (0–3)"}, {key:"elapsedMs", label:"Work time limit (ms, 1000–3600000)"}
    ]
    function writeField(key, value) {
        var next = Object.assign({}, editState.fields || {})
        next[key] = value
        writeDraft({fields: next})
    }
    function definitionDraft() {
        return { executable: fields.executable, argv: fields.argv === "" ? [] : fields.argv.split("\n"), cwd: fields.cwd,
            environment: fields.environment === "" ? [] : fields.environment.split("\n").map(function(line) {
                var at = line.indexOf("=")
                return {name: at < 0 ? line : line.slice(0, at), value: at < 0 ? "" : line.slice(at + 1)}
            }), resourcePaths: fields.resourcePaths === "" ? [] : fields.resourcePaths.split("\n"),
            timeoutMs: Number(fields.timeoutMs), outputBytes: Number(fields.outputBytes),
            maxCorrections: Number(fields.maxCorrections), elapsedMs: Number(fields.elapsedMs) }
    }
    readonly property string definitionError: {
        var d = definitionDraft()
        if (d.executable[0] !== "/" || d.cwd[0] !== "/") return "Set the absolute executable and working directory in Advanced definition."
        var limits = [[d.timeoutMs,100,300000], [d.outputBytes,1,65536], [d.maxCorrections,0,3], [d.elapsedMs,1000,3600000]]
        for (var i = 0; i < limits.length; i++) if (!Number.isInteger(limits[i][0]) || limits[i][0] < limits[i][1] || limits[i][0] > limits[i][2]) return "Use whole numbers within the displayed limits."
        if (d.argv.length > 64 || d.environment.length > 32 || d.resourcePaths.length > 64) return "Too many arguments, environment entries or resources."
        if (fields.environment !== "" && fields.environment.split("\n").some(function(line) { return line.indexOf("=") < 1 })) return "Use NAME=value for every environment entry."
        var names = []
        for (var j = 0; j < d.environment.length; j++) {
            var e = d.environment[j]
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name) || names.indexOf(e.name) >= 0) return "Use unique environment names (NAME=value)."
            names.push(e.name)
        }
        var paths = [d.executable, d.cwd].concat(d.resourcePaths)
        for (var k = 0; k < paths.length; k++) if (paths[k][0] !== "/" || paths[k].split("/").indexOf("..") >= 0) return "Use absolute paths without parent traversal."
        return ""
    }
    readonly property bool editAvailable: projection && Array.isArray(projection.actions) && projection.actions.some(function(a) {
        return a.kind === "configure_checks" && a.target === root.selectedCheckId && a.enabled
    })

    function shortDigest(value) {
        return typeof value === "string" && value.length >= 8 ? value.slice(0, 8) : String(value)
    }

    ColumnLayout {
        id: checksColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "Acceptance checks"
            color: root.textColor
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }
        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            text: "Checks are configured per Project and reused across Team Goals. Choosing a check for an assignment never turns validation off."
            color: root.mutedColor
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
        Text {
            Layout.fillWidth: true
            visible: !root.projection || !Array.isArray(root.projection.checks)
                || root.projection.checks.length === 0
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            text: "No acceptance check is configured for this Project. Starting work stays blocked until one is saved."
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }
        Repeater {
            model: root.projection && Array.isArray(root.projection.checks) ? root.projection.checks : []
            delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                highlighted: root.selectedCheckId === modelData.checkId
                    && root.selectedCheckVersion === modelData.version
                enabled: root.connected
                focusPolicy: Qt.StrongFocus
                contentItem: Text {
                    text: modelData.name + " · v" + modelData.version + " · " + modelData.mode + "\n"
                        + modelData.commandSummary + "\n"
                        + modelData.availability + " · digest " + root.shortDigest(modelData.digest)
                        + (modelData.reason === null ? "" : " — " + modelData.reason)
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAnywhere
                    color: root.textColor
                }
                onClicked: root.selectCheck(modelData.checkId, modelData.version)
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            visible: root.selectedCheck !== null
            spacing: Style.space(6)

            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: "Edit definition"
                color: root.textColor
                font.family: Style.font.family
                font.pixelSize: Style.font.title
                font.bold: true
            }
            TextField {
                objectName: "workbench-check-name"
                Layout.fillWidth: true
                placeholderText: "Check name"
                text: root.draftName
                onTextChanged: if (text !== root.draftName) root.writeDraft({ name: text })
            }
            TextField {
                Layout.fillWidth: true
                placeholderText: "What it verifies"
                text: root.draftSummary
                onTextChanged: if (text !== root.draftSummary) root.writeDraft({ summary: text })
            }
            TextField {
                Layout.fillWidth: true
                placeholderText: "Command summary (display only)"
                text: root.draftCommand
                onTextChanged: if (text !== root.draftCommand) root.writeDraft({ commandSummary: text })
            }
            ComboBox {
                objectName: "workbench-check-mode"
                Layout.fillWidth: true
                model: root.checkModes
                currentIndex: Math.max(0, root.checkModes.indexOf(root.draftMode))
                onActivated: function(index) { root.writeDraft({ mode: root.checkModes[index] }) }
            }
            Button {
                objectName: "workbench-check-advanced"
                text: root.advancedOpen ? "Hide advanced definition" : "Advanced definition"
                onClicked: root.advancedOpen = !root.advancedOpen
            }
            ColumnLayout {
                Layout.fillWidth: true
                visible: root.advancedOpen
                Repeater {
                    model: root.fieldSpecs
                    delegate: ColumnLayout {
                        required property var modelData
                        Layout.fillWidth: true
                        Label { Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap; text: modelData.label }
                        ScrollView {
                            Layout.fillWidth: true
                            Layout.preferredHeight: Style.space(64)
                            clip: true
                            TextArea {
                                objectName: "check-field-" + modelData.key
                                Accessible.name: modelData.label
                                textFormat: TextEdit.PlainText
                                wrapMode: TextEdit.WrapAnywhere
                                text: String(root.fields[modelData.key])
                                onTextChanged: if (text !== String(root.fields[modelData.key])) root.writeField(modelData.key, text)
                                Keys.onTabPressed: function(event) { nextItemInFocusChain().forceActiveFocus(); event.accepted = true }
                            }
                        }
                    }
                }
                Label {
                    Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap
                    text: "Draft only. Saving never executes this command. The runner must resolve and freeze the executable, environment and resource hashes before a separate start confirmation. No secrets."
                }
            }
            Label {
                Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap
                visible: root.definitionError !== ""
                text: root.definitionError
            }
            Text {
                Layout.fillWidth: true
                visible: root.advancedOpen
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                text: root.selectedCheck === null ? ""
                    : "Exact identity: " + root.selectedCheck.checkId + " v" + root.selectedCheck.version
                        + " · digest " + root.selectedCheck.digest
                color: root.mutedColor
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
            }
            Label {
                Layout.fillWidth: true; textFormat: Text.PlainText; wrapMode: Text.Wrap
                visible: !root.editAvailable
                text: "Editing this check is unavailable in the current projection. Your draft is retained."
            }
            Button {
                objectName: "workbench-save-check"
                Layout.fillWidth: true
                text: "Save check"
                enabled: root.connected && root.editAvailable && root.draftName.trim().length > 0
                    && root.projection.selectedProjectId !== null && root.definitionError === ""
                focusPolicy: Qt.StrongFocus
                onClicked: if (root.selectedCheck !== null) root.intentRequested({
                    kind: "configure_checks",
                    target: root.selectedCheck.checkId,
                    payload: {
                        projectId: root.projection.selectedProjectId,
                        checkId: root.selectedCheck.checkId,
                        checkVersion: root.selectedCheck.version,
                        name: root.draftName,
                        summary: root.draftSummary,
                        mode: root.draftMode,
                        commandSummary: root.draftCommand,
                        definitionDraft: root.definitionDraft()
                    }
                })
            }
        }
    }
}
