// PROTOTYPE — NOT PRODUCTION.
//
// Presentation-only Omarchy panel for the persistent Companion Plugin. A
// host injects a validated plain projection through open() or
// applyProjection(); clear() and close() remove only ephemeral state; the
// intentRequested signal is a presentation intent surface that never
// computes protocol, cursor, or sequencing values itself. The Team Runner
// and the non-QML adapter remain the authorities for status, identity, and
// cursor.
//
// The observer-only lifecycle is a separate, standalone boundary: a host
// opens a panel showing only Unassigned Agents through openObservedAgents(),
// updates it through non-opening applyObservedAgents(), and dismisses it with
// clearObservedAgents(). Observer opening never creates a Projection Session,
// Active Session identity, managed card, or managed cursor, and managed
// open()/clear()/close() never touch observer state. Panel visibility is
// derived from the managed opened flag OR the observerOpened flag, so clearing
// observer state can hide the panel only when no managed session is active.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
    id: root

    // Presentation-only edge preference, configurable through shell call.
    property string edgeOverride: "left"
    readonly property string panelEdge: edgeOverride
    readonly property bool standaloneDock: observerOpened && !opened

    function setPanelEdge(value) {
        var parsed = parsePayload(value)
        var edge = parsed && parsed.edge
        if (["left", "right", "top", "bottom"].indexOf(edge) < 0) return false
        edgeOverride = edge
        return true
    }

    property var shell: null
    property var manifest: null
    property bool opened: false
    property var projection: ({
        status: "reconnecting",
        cursor: 0,
        cards: []
    })
    property var lastIntentResult: null
    property bool observerOpened: false
    property var observerProjection: ({ observerRevision: 0, agents: [] })
    property var observerIntentResult: null
    property var activeSession: null
    property var pendingIntents: []
    property int intentCounter: 0
    readonly property double pluginGeneration: Date.now() * 1000 + Math.floor(Math.random() * 1000)

    // Presentation-intent surface: the panel may only EMIT a user intent as
    // a plain payload. The non-QML adapter validates, deduplicates, and
    // acknowledges it; this component never speaks the runner protocol or
    // derives any cursor value.
    signal intentRequested(var payload)
    signal requestAdoption(var payload)
    signal authorizeAdoption(var payload)
    onIntentRequested: function(payload) {
        if (activeSession === null || pendingIntents.length >= 16) return
        var next = pendingIntents.slice()
        next.push(payload)
        pendingIntents = next
    }

    function requestPresent(role) {
        if (activeSession === null || typeof role !== "string") return
        intentCounter += 1
        root.intentRequested({
            intentId: "present-" + activeSession.sessionId + "-" + String(intentCounter),
            kind: "present_agent",
            role: role
        })
    }

    function takeIntent(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!sessionMatches(value) || pendingIntents.length === 0) return ""
        var next = pendingIntents.slice()
        var intent = next.shift()
        pendingIntents = next
        return JSON.stringify(intent)
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
            && session.teamGoalId === activeSession.teamGoalId
            && session.clientId === activeSession.clientId
            && session.sessionGeneration === activeSession.sessionGeneration
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
                "session.hide", "session.clear", "session.resnapshot",
                "session.observer"
            ]
        })
    }

    function applyProjection(value) {
        if (!value || typeof value !== "object") return false
        if (value.status !== "ready"
                && value.status !== "reconnecting"
                && value.status !== "gap") return false
        if (!Array.isArray(value.cards) || value.cards.length !== 3) return false

        for (var index = 0; index < value.cards.length; index += 1) {
            var card = value.cards[index]
            if (!card || typeof card.role !== "string"
                    || typeof card.agentRunId !== "string"
                    || typeof card.piStatus !== "string") return false
        }

        projection = value
        return true
    }

    // The shell calls this with the already validated Companion handoff. QML
    // only applies plain values and returns a presentation result.
    function applyHandoff(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!value || typeof value !== "object" || !sessionMatches(value)) return false
        return applyProjection({
            status: value.status,
            cursor: value.cursor,
            cards: value.cards
        })
    }

    // Intent acknowledgements are displayed as plain data. The adapter, not
    // QML, decides whether an intent is accepted or duplicate.
    function intentResult(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!value || typeof value !== "object" || !sessionMatches(value)
                || typeof value.intentId !== "string"
                || typeof value.result !== "string") return false
        lastIntentResult = ({
            intentId: value.intentId,
            result: value.result,
            detail: value.detail === undefined ? null : value.detail
        })
        return true
    }

    // Content validation shared by observer open/update. Standalone opening
    // additionally requires exactly empty choices; managed observer updates
    // retain the existing opaque-choice presentation behavior.

    function validObserverProjection(next, requireEmptyChoices) {
        if (!next || typeof next !== "object") return false
        if (typeof next.observerRevision !== "number" || next.observerRevision < 0) return false
        if (!Array.isArray(next.agents)) return false
        for (var index = 0; index < next.agents.length; index += 1) {
            var agent = next.agents[index]
            if (!agent || typeof agent !== "object") return false
            if (agent.piStatus !== "Unassigned · observed") return false
            if (!Array.isArray(agent.choices)
                    || (requireEmptyChoices && agent.choices.length !== 0)) return false
            if (typeof agent.observedSessionId !== "string"
                    || typeof agent.lifecycle !== "string"
                    || typeof agent.availability !== "string"
                    || typeof agent.health !== "string") return false
        }
        return true
    }

    // Opens a standalone observer-only panel. Accepts only an exact
    // sessionless { observerProjection } payload carrying Unassigned ·
    // observed agents with empty choices. A validated payload commits the
    // projection and observerOpened atomically; invalid data never opens the
    // panel. No managed identity, card, cursor, or session is created.

    function openObservedAgents(value) {
        var envelope = parsePayload(value)
        if (!envelope || typeof envelope !== "object") return false
        if (Object.keys(envelope).length !== 1
                || envelope.session !== undefined
                || envelope.projection !== undefined) return false
        var next = envelope.observerProjection
        if (!validObserverProjection(next, true)) return false
        observerProjection = ({
            observerRevision: next.observerRevision,
            agents: next.agents
        })
        observerOpened = true
        return true
    }

    // Non-opening observer update. This re-renders the observer projection in
    // the already visible panel (observer-only or alongside a managed panel)
    // but never opens the panel and never touches managed state.

    function applyObservedAgents(value) {
        var envelope = parsePayload(value)
        if (!envelope || typeof envelope !== "object") return false
        var managedObserverUpdate = envelope.session !== undefined
        if (managedObserverUpdate && !sessionMatches(envelope)) return false
        var next = envelope.observerProjection && typeof envelope.observerProjection === "object"
            ? envelope.observerProjection
            : envelope.projection && typeof envelope.projection === "object"
                ? envelope.projection : envelope
        if (!validObserverProjection(next, !managedObserverUpdate)) return false
        observerProjection = ({
            observerRevision: next.observerRevision,
            agents: next.agents
        })
        return true
    }

    function applyObserverProjection(value) {
        return applyObservedAgents(value)
    }

    // Clears only observer presentation state. The panel hides only when no
    // managed session is open (visibility is derived from the opened flag OR
    // the observerOpened flag); managed state is never cleared or hidden.

    function clearObservedAgents() {
        observerOpened = false
        observerProjection = ({ observerRevision: 0, agents: [] })
        observerIntentResult = null
        unassignedAgents.clearIntentState()
        return true
    }

    function observedIntentResult(value) {
        var result = parsePayload(value)
        if (!result || typeof result !== "object") return false
        if (result.session !== undefined && !sessionMatches(result)) return false
        observerIntentResult = result
        return unassignedAgents.applyIntentResult(result)
    }

    function applyObserverIntentResult(value) {
        return observedIntentResult(value)
    }

    function open(payloadJson) {
        var envelope = parsePayload(payloadJson)
        var session = sessionFrom(envelope)
        if (!envelope || !session
                || session.pluginGeneration !== pluginGeneration
                || typeof session.sessionId !== "string"
                || typeof session.teamGoalId !== "string"
                || typeof session.clientId !== "string") return false
        var value = envelope.projection
        // The panel opens only when a validated projection applies. An
        // invalid or missing payload must never open the surface showing
        // QML-authored placeholder state: the authoritative snapshot from
        // the runner adapter is the only thing that may open it.
        if (!applyProjection(value)) return false
        pendingIntents = []
        intentCounter = 0
        activeSession = ({
            sessionId: session.sessionId,
            teamGoalId: session.teamGoalId,
            clientId: session.clientId,
            sessionGeneration: session.sessionGeneration,
            pluginGeneration: session.pluginGeneration
        })
        opened = true
        return true
    }

    function close() {
        opened = false
        activeSession = null
        projection = ({ status: "reconnecting", cursor: 0, cards: [] })
        lastIntentResult = null
        pendingIntents = []
    }

    // Clears all ephemeral presentation state without closing the surface or
    // touching any installed plugin state. The next authoritative snapshot
    // fully re-derives the visible projection.
    function clear(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!sessionMatches(value)) return false
        projection = ({ status: "reconnecting", cursor: 0, cards: [] })
        lastIntentResult = null
        pendingIntents = []
        activeSession = null
        return true
    }

    PanelWindow {
        id: panel
        visible: root.opened || root.observerOpened
        anchors {
            top: !root.standaloneDock || root.panelEdge !== "bottom"
            bottom: !root.standaloneDock || root.panelEdge !== "top"
            left: !root.standaloneDock || root.panelEdge !== "right"
            right: !root.standaloneDock || root.panelEdge !== "left"
        }
        implicitWidth: Style.space(360)
        implicitHeight: Style.space(280)
        color: "transparent"
        WlrLayershell.namespace: "omarchestra-agent-console"
        WlrLayershell.layer: root.standaloneDock ? WlrLayer.Top : WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        exclusionMode: root.standaloneDock ? ExclusionMode.Auto : ExclusionMode.Ignore
        mask: Region { item: surface }

        BorderSurface {
            id: surface
            width: root.standaloneDock ? parent.width : Math.min(parent.width - Style.space(48), Style.space(900))
            height: root.standaloneDock ? parent.height : consoleColumn.implicitHeight + Style.space(36)
            anchors.centerIn: parent
            color: Color.popups.background
            borderSpec: Border.surfaceSpec(
                "popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
            radius: Style.cornerRadius

            ColumnLayout {
                id: consoleColumn
                anchors.fill: parent
                anchors.margins: Style.space(18)
                spacing: Style.space(12)

                ColumnLayout {
                    id: managedConsole
                    Layout.fillWidth: true
                    visible: root.opened
                    spacing: Style.space(12)

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Style.space(10)

                        Text {
                            Layout.fillWidth: true
                            text: "Agent Console"
                            color: Color.popups.text
                            font.family: Style.font.family
                            font.pixelSize: Style.font.heading
                            font.bold: true
                        }

                        Text {
                            text: "cursor " + String(root.projection.cursor)
                            color: Qt.darker(Color.popups.text, 1.45)
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                        }
                    }

                    Text {
                        Layout.fillWidth: true
                        text: root.projection.status
                        color: root.projection.status === "gap"
                            ? Color.urgent : Color.accent
                        font.family: Style.font.family
                        font.pixelSize: Style.font.body
                        font.bold: true
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.projection.status === "ready"
                        text: "Projection ready"
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.projection.status === "reconnecting"
                        text: "Reconnecting to the Team Runner projection"
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.projection.status === "gap"
                        text: "Projection gap: awaiting an authoritative snapshot"
                        color: Color.urgent
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    AgentConsoleCards {
                        Layout.fillWidth: true
                        cards: root.projection.cards
                        onPresentRequested: function(role) { root.requestPresent(role) }
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.lastIntentResult !== null
                        text: root.lastIntentResult === null ? "" : "Present action: " + root.lastIntentResult.result
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }
                }

                UnassignedAgents {
                    id: unassignedAgents
                    Layout.fillWidth: true
                    visible: root.opened || root.observerOpened
                    projection: root.observerProjection
                    onRequestAdoption: function(payload) { root.requestAdoption(payload) }
                    onAuthorizeAdoption: function(payload) { root.authorizeAdoption(payload) }
                }
            }
        }
    }
}
