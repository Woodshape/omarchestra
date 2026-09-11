// Local Workbench v1 — Phase 1 presentation-only console.
//
// Renders a validated plain projection and emits presentation intents. A host
// injects the authoritative snapshot through open()/applyProjection(); clear()
// and close() remove only ephemeral presentation state. This component never
// computes protocol, cursor, sequencing, readiness, or writer values itself.
// The runner remains the sole authority for durable state, admission, gates,
// and projections.
//
// Board and unsupported runtime actions are visibly disabled with reasons and
// emit no intent. Fixture mode is persistently labeled so injected data is
// never mistaken for live work.
import QtQuick
import QtQuick.Controls
import QtQuick.Window
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui as Native

Item {
    id: root

    property string edgeOverride: "left"
    readonly property string panelEdge: edgeOverride

    // Fixed dock geometry. Opening a detail changes only the content inside
    // the surface. It must never resize the layer surface: the shell
    // re-reserves compositor edge space on every size change, which shifts
    // neighbouring terminals. A full-screen workspace mode is deliberately
    // deferred until the console carries more functionality than a dock can
    // hold.
    readonly property int panelWidth: Style.space(420)
    readonly property int panelHeight: Style.space(560)
    property var shell: null
    property var manifest: null
    property bool opened: false
    property bool detailOpen: false
    property var projection: null
    property var activeSession: null
    property var pendingIntents: []
    property string destination: "assignments"
    property var confirmation: null
    property var drafts: ({})
    property string draftError: ""
    property bool previewOnly: false
    property string confirmationText: ""
    property var lastIntentResult: null
    property double pluginGeneration: 0 // Injected by the presentation host.

    signal intentRequested(var payload)

    function getDraftState() {
        return JSON.parse(JSON.stringify(drafts))
    }

    function setDraftState(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) return false
        var keys = Object.keys(value)
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].length > 512 || typeof value[keys[i]] !== "string" || value[keys[i]].length > 24000) return false
        }
        drafts = JSON.parse(JSON.stringify(value))
        return true
    }

    function saveDraft(key, value) {
        var next = getDraftState()
        next[key] = value
        if (!setDraftState(next)) draftError = "Draft storage is full. Keep this form open and copy its text before changing targets."
        else draftError = ""
    }

    function setPanelEdge(value) {
        var parsed = parsePayload(value)
        var edge = parsed && parsed.edge
        if (["left", "right", "top", "bottom"].indexOf(edge) < 0) return false
        edgeOverride = edge
        return true
    }

    function parsePayload(payloadJson) {
        if (typeof payloadJson !== "string") return payloadJson
        try {
            return JSON.parse(payloadJson || "{}")
        } catch (error) {
            return null
        }
    }

    function sessionFrom(value) {
        if (!value || typeof value !== "object") return null
        return value.session && typeof value.session === "object" ? value.session : value
    }

    function sessionMatches(value) {
        var session = sessionFrom(value)
        return activeSession !== null && session !== null
            && session.sessionId === activeSession.sessionId
            && session.pluginGeneration === activeSession.pluginGeneration
    }

    function capabilities() {
        if (!manifest || !manifest.companion) return ""
        return JSON.stringify({
            protocol: manifest.companion.protocol,
            pluginId: manifest.id,
            version: manifest.version,
            pluginGeneration: pluginGeneration,
            capabilities: [
                "session.open", "session.update", "session.intent",
                "session.hide", "session.clear", "session.resnapshot"
            ]
        })
    }

    // The host supplies a validated plain projection. QML only applies it.
    function applyProjection(value) {
        if (!value || typeof value !== "object") return false
        if (typeof value.revision !== "number" || value.revision < 0) return false
        if (typeof value.cursor !== "number" || value.cursor < 0) return false
        if (typeof value.connection !== "string") return false
        if (!Array.isArray(value.managedAgents)) return false
        if (!Array.isArray(value.observedSessions)) return false
        if (!Array.isArray(value.retiredRuns)) return false
        if (!Array.isArray(value.assignments)) return false
        // Even a same-revision replacement may narrow action availability.
        // Never rebind a displayed confirmation or queued click to changed data.
        if (projection && JSON.stringify(projection) !== JSON.stringify(value)) {
            confirmation = null
            pendingIntents = []
            confirmDialog.close()
            lastIntentResult = null
        }
        projection = value
        projectionWatchdog.restart()
        return true
    }

    function markPresentationStale() {
        if (!projection || projection.connection !== "connected") return
        projection = Object.assign({}, projection, { connection: "stale" })
        confirmation = null
        pendingIntents = []
        lastIntentResult = null
        confirmDialog.close()
    }

    function open(payloadJson) {
        var envelope = parsePayload(payloadJson)
        var session = sessionFrom(envelope)
        if (!envelope || !session
                || session.pluginGeneration !== pluginGeneration
                || typeof session.sessionId !== "string") return false
        var value = envelope.projection
        if (!applyProjection(value)) return false
        pendingIntents = []
        activeSession = ({
            sessionId: session.sessionId,
            pluginGeneration: session.pluginGeneration
        })
        opened = true
        return true
    }

    function openPreview(payloadJson) {
        var envelope = parsePayload(payloadJson)
        if (!envelope || !envelope.projection || !envelope.projection.fixture || envelope.projection.fixture.active !== true) return false
        if (activeSession !== null && !sessionMatches(envelope)) return false
        return open(envelope)
    }

    function updatePreview(payloadJson) {
        var envelope = parsePayload(payloadJson)
        if (!sessionMatches(envelope) || !envelope.projection || !envelope.projection.fixture || envelope.projection.fixture.active !== true) return false
        return applyProjection(envelope.projection)
    }

    function close() {
        confirmation = null
        confirmDialog.close()
        opened = false
        detailOpen = false
        activeSession = null
        projection = null
        lastIntentResult = null
        pendingIntents = []
    }

    function clear(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!sessionMatches(value)) return false
        projection = null
        confirmation = null
        confirmDialog.close()
        lastIntentResult = null
        pendingIntents = []
        activeSession = null
        detailOpen = false
        opened = false
        return true
    }

    // Presentation-intent surface: emit a plain user intent. The non-QML
    // adapter validates, deduplicates, and acknowledges it.
    function emitIntent(payload) {
        if (activeSession === null || pendingIntents.length >= 16 || !projection || projection.connection !== "connected") return
        var next = pendingIntents.slice()
        next.push(payload)
        pendingIntents = next
        root.intentRequested(payload)
    }

    function requestConfirmation(payload) {
        if (!projection || projection.connection !== "connected") return
        previewOnly = payload.kind === "preview_detail"
        if (previewOnly) {
            confirmation = payload
            confirmationText = detail.detailText(payload.payload.detail) + "\n\nPresentation preview only. Confirm/send is disabled until the runtime port exists."
            confirmDialog.open()
            confirmationTimer.restart()
            return
        }
        confirmationText = payload.kind + " · " + String(payload.target) + "\n" + JSON.stringify(payload.payload)
            + "\nRetirement/stop do not prove tools ended. Purge never deletes external work."
        if (payload.kind === "select_project" || payload.kind === "select_goal") {
            emitIntent(payload)
            return
        }
        confirmation = payload
        confirmDialog.open()
        confirmationTimer.restart()
    }

    function takeIntent(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!sessionMatches(value) || pendingIntents.length === 0) return ""
        var next = pendingIntents.slice()
        var intent = next.shift()
        pendingIntents = next
        return JSON.stringify(intent)
    }

    function intentResult(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!value || typeof value !== "object" || !sessionMatches(value)
                || typeof value.intentId !== "string"
                || typeof value.status !== "string") return false
        lastIntentResult = value
        return true
    }

    PanelWindow {
        id: panel
        objectName: "workbench-panel"
        visible: root.opened
        anchors {
            top: root.panelEdge !== "bottom"
            bottom: root.panelEdge !== "top"
            left: root.panelEdge !== "right"
            right: root.panelEdge !== "left"
        }
        implicitWidth: Math.min(screen ? screen.width : root.panelWidth, root.panelWidth)
        implicitHeight: Math.min(screen ? screen.height : root.panelHeight, root.panelHeight)
        color: "transparent"
        WlrLayershell.namespace: "omarchestra-local-workbench"
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
        exclusionMode: ExclusionMode.Auto
        mask: Region { item: surface }

        Timer {
            id: projectionWatchdog
            interval: 2000
            onTriggered: root.markPresentationStale()
        }
        Timer {
            id: confirmationTimer
            interval: 30000
            onTriggered: { root.confirmation = null; confirmDialog.close() }
        }
        Dialog {
            id: confirmDialog
            objectName: "workbench-confirmation"
            title: root.previewOnly ? "Review only — runtime unavailable" : "Confirm exact action"
            palette: overview.palette
            modal: true
            anchors.centerIn: parent
            width: Math.max(1, Math.min(parent.width - Style.space(24), Style.space(640)))
            height: Math.max(1, Math.min(parent.height - Style.space(24), implicitHeight))
            standardButtons: root.previewOnly ? Dialog.Cancel : Dialog.Ok | Dialog.Cancel
            closePolicy: Popup.CloseOnEscape
            onAccepted: {
                if (root.confirmation && !root.previewOnly) root.emitIntent(root.confirmation)
                root.confirmation = null
            }
            onRejected: root.confirmation = null
            contentItem: ScrollView {
                clip: true
                contentWidth: availableWidth
                Label {
                    width: parent.width
                    text: root.confirmation ? root.confirmationText : "Expired"
                    textFormat: Text.PlainText
                    wrapMode: Text.WrapAnywhere
                    color: Color.popups.text
                }
            }
        }

        Native.BorderSurface {
            id: surface
            anchors.fill: parent
            color: Color.popups.background
            borderSpec: Border.surfaceSpec(
                "popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
            radius: Style.cornerRadius

            Flickable {
                id: scroll
                ScrollBar.vertical: ScrollBar { }
                function revealFocus(item) {
                    if (!item) return
                    var ancestor = item
                    while (ancestor && ancestor !== scroll.contentItem) ancestor = ancestor.parent
                    if (!ancestor) return
                    var point = item.mapToItem(scroll.contentItem, 0, 0)
                    var next = scroll.contentY
                    if (point.y < next) next = point.y
                    else if (point.y + item.height > next + scroll.height) next = point.y + item.height - scroll.height
                    scroll.contentY = Math.max(0, Math.min(next, scroll.contentHeight - scroll.height))
                }
                Connections {
                    target: scroll.Window.window
                    function onActiveFocusItemChanged() { scroll.revealFocus(scroll.Window.window.activeFocusItem) }
                }
                boundsBehavior: Flickable.StopAtBounds
                flickableDirection: Flickable.VerticalFlick
                anchors.fill: parent
                anchors.margins: Style.space(12)
                contentHeight: column.implicitHeight
                clip: true

                ColumnLayout {
                    id: column
                    width: parent.width
                    spacing: Style.space(10)

                    WorkbenchOverview {
                        id: overview
                        Layout.fillWidth: true
                        projection: root.projection
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                        onToggleDetail: function(destination) {
                            root.destination = destination
                            root.detailOpen = destination !== "agents"
                        }
                    }

                    WorkbenchDetail {
                        id: detail
                        Layout.fillWidth: true
                        drafts: root.drafts
                        onDraftChanged: function(key, value) { root.saveDraft(key, value) }
                        visible: root.detailOpen
                        projection: root.projection
                        destination: root.destination
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    Label {
                        Layout.fillWidth: true
                        text: root.draftError
                        visible: text.length > 0
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Color.popups.text
                    }
                    Text {
                        Layout.fillWidth: true
                        visible: root.lastIntentResult !== null
                        textFormat: Text.PlainText
                        text: root.lastIntentResult === null ? "" : "Intent " + root.lastIntentResult.intentId + ": " + root.lastIntentResult.status
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        wrapMode: Text.Wrap
                    }
                }
            }
        }
    }
}
