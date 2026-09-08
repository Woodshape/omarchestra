/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Versioned, immutable Companion Plugin release catalog. The asset strings are
 * the source snapshot packaged by the explicit setup path. No filesystem read
 * is performed while importing this module.
 */

import { ADOPTION_PANEL_QML, ADOPTION_ROOT_MEMBERS } from '../console/adoption-panel-source.ts'

import {
  COMPANION_PLUGIN_ID,
  COMPANION_PLUGIN_VERSION,
  COMPANION_PROTOCOL_ID,
  CompanionInstallationError,
  freezeCompanionRelease,
  type CompanionRelease,
} from './contracts.ts'

const MANIFEST = JSON.stringify({
  schemaVersion: 1,
  id: COMPANION_PLUGIN_ID,
  name: 'Agent Console',
  version: COMPANION_PLUGIN_VERSION,
  author: 'Omarchestra',
  license: 'MIT',
  description: 'Presentation-only Agent Console cards for a committed team projection.',
  kinds: ['panel'],
  activation: 'on-demand',
  keepLoaded: true,
  companion: { protocol: COMPANION_PROTOCOL_ID },
  entryPoints: { panel: 'AgentConsole.qml' },
})

const AGENT_CONSOLE_QML = String.raw`// PROTOTYPE — NOT PRODUCTION.
//
// Presentation-only Omarchy panel for the persistent Companion Plugin. A
// host injects a validated plain projection through open() or
// applyProjection(); clear() and close() remove only ephemeral state; the
// intentRequested signal is a presentation intent surface that never
// computes protocol, cursor, or sequencing values itself. The Team Runner
// and the non-QML adapter remain the authorities for status, identity, and
// cursor.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui

Item {
    id: root

    property var shell: null
    property var manifest: null
    property bool opened: false
    property var projection: ({
        status: "reconnecting",
        cursor: 0,
        cards: []
    })
    property var lastIntentResult: null
    property var activeSession: null
    property var pendingIntents: []
    property int intentCounter: 0
    readonly property double pluginGeneration: Date.now() * 1000 + Math.floor(Math.random() * 1000)

    // Presentation-intent surface: the panel may only EMIT a user intent as
    // a plain payload. The non-QML adapter validates, deduplicates, and
    // acknowledges it; this component never speaks the runner protocol or
    // derives any cursor value.
    signal intentRequested(var payload)
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
                "session.hide", "session.clear", "session.resnapshot"
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
        visible: root.opened
        anchors {
            top: true
            bottom: true
            left: true
            right: true
        }
        color: "transparent"
        WlrLayershell.namespace: "omarchestra-agent-console"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        exclusionMode: ExclusionMode.Ignore
        mask: Region { item: surface }

        BorderSurface {
            id: surface
            width: Math.min(parent.width - Style.space(48), Style.space(900))
            height: consoleColumn.implicitHeight + Style.space(36)
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
        }
    }
}
`

const AGENT_CONSOLE_CARDS_QML = String.raw`// PROTOTYPE — NOT PRODUCTION.
//
// Cards are deliberately fed plain values. In particular, piStatus is an
// opaque committed presentation string and is never rebuilt in this component.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var cards: []
    readonly property color cardText: Color.popups.text
    signal presentRequested(string role)
    readonly property color cardMutedText: Qt.darker(root.cardText, 1.45)

    implicitWidth: cardColumn.implicitWidth
    implicitHeight: cardColumn.implicitHeight

    ColumnLayout {
        id: cardColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Repeater {
            model: root.cards

            delegate: BorderSurface {
                required property var modelData

                Layout.fillWidth: true
                implicitHeight: cardContent.implicitHeight + Style.space(20)
                color: Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(root.cardText.r, root.cardText.g, root.cardText.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                MouseArea {
                    anchors.fill: parent
                    enabled: modelData && typeof modelData.role === "string"
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.presentRequested(modelData.role)
                }

                ColumnLayout {
                    id: cardContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(12)
                    anchors.rightMargin: Style.space(12)
                    spacing: Style.space(3)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        color: root.cardText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: modelData.agentRunId
                        color: root.cardMutedText
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }
}
`

const OBSERVER_MANIFEST = String.raw`{
  "schemaVersion": 1,
  "id": "omarchestra.agent-console",
  "name": "Agent Console",
  "version": "0.3.0",
  "author": "Omarchestra",
  "license": "MIT",
  "description": "Presentation-only Agent Console cards for a committed team projection.",
  "kinds": [
    "panel"
  ],
  "activation": "on-demand",
  "keepLoaded": true,
  "companion": {
    "protocol": "omarchestra.companion/v1"
  },
  "entryPoints": {
    "panel": "AgentConsole.qml"
  }
}
`

const OBSERVER_UNASSIGNED_AGENTS_QML = String.raw`// PROTOTYPE — NOT PRODUCTION.
//
// Presentation-only view of the bounded observer projection. The adapter
// supplies opaque status, lifecycle, availability, health, choices, and
// exact proposal values. This component emits only plain presentation intents.
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Item {
    id: root

    property var projection: ({ observerRevision: 0, agents: [] })
    property var observedIntentResult: null
    property var pendingProposal: null
    property int intentCounter: 0

    signal requestAdoption(var payload)
    signal authorizeAdoption(var payload)

    implicitWidth: agentsColumn.implicitWidth
    implicitHeight: agentsColumn.implicitHeight + confirmationColumn.implicitHeight + Style.space(16)

    function nextIntentId(kind) {
        intentCounter += 1
        return "observer-" + kind + "-" + String(intentCounter)
    }

    function clearIntentState() {
        observedIntentResult = null
        pendingProposal = null
        intentCounter = 0
    }

    function applyIntentResult(value) {
        if (!value || typeof value !== "object") return false
        observedIntentResult = value
        if (value.phase !== "proposal"
                || typeof value.proposalId !== "string"
                || typeof value.proposalDigest !== "string") {
            pendingProposal = null
            return true
        }
        pendingProposal = ({
            proposalId: value.proposalId,
            proposalDigest: value.proposalDigest,
            displayLabel: value.displayLabel,
            remainingMs: value.remainingMs
        })
        return true
    }

    ColumnLayout {
        id: agentsColumn
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: Style.space(8)

        Text {
            Layout.fillWidth: true
            text: "Unassigned Agents"
            color: Color.popups.text
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            font.bold: true
        }

        Text {
            Layout.fillWidth: true
            visible: !root.projection || !Array.isArray(root.projection.agents)
                    || root.projection.agents.length === 0
            text: "No observed Pi sessions"
            color: Qt.darker(Color.popups.text, 1.35)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
        }

        Repeater {
            model: root.projection && Array.isArray(root.projection.agents)
                ? root.projection.agents : []

            delegate: BorderSurface {
                id: agentCard
                required property var modelData
                readonly property string observedSessionId: modelData.observedSessionId

                Layout.fillWidth: true
                implicitHeight: agentColumn.implicitHeight + Style.space(20)
                color: Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                    Color.popups.text.b, 0.045)
                borderSpec: Border.flat(
                    Qt.rgba(Color.popups.text.r, Color.popups.text.g,
                        Color.popups.text.b, 0.16),
                    Math.max(1, Style.spacing.hairline))
                radius: Style.cornerRadius

                ColumnLayout {
                    id: agentColumn
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: Style.space(12)
                    spacing: Style.space(4)

                    Text {
                        Layout.fillWidth: true
                        text: modelData.piStatus
                        color: Color.popups.text
                        font.family: Style.font.family
                        font.pixelSize: Style.font.title
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Availability: " + modelData.availability
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Lifecycle: " + modelData.lifecycle
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Text {
                        Layout.fillWidth: true
                        text: "Health: " + modelData.health
                        color: Qt.darker(Color.popups.text, 1.35)
                        font.family: Style.font.family
                        font.pixelSize: Style.font.caption
                    }

                    Flow {
                        Layout.fillWidth: true
                        spacing: Style.space(6)

                        Repeater {
                            model: modelData.choices || []

                            delegate: Button {
                                required property var modelData

                                text: modelData.label
                                enabled: modelData.enabled
                                onClicked: root.requestAdoption({
                                    intentId: root.nextIntentId("request"),
                                    kind: "request_adoption",
                                    observedSessionId: agentCard.observedSessionId,
                                    choiceId: modelData.choiceId
                                })
                            }
                        }
                    }
                }
            }
        }
    }

    ColumnLayout {
        id: confirmationColumn
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: agentsColumn.bottom
        anchors.topMargin: Style.space(8)
        spacing: Style.space(4)

        Text {
            Layout.fillWidth: true
            visible: root.observedIntentResult !== null
            text: root.observedIntentResult === null ? "" : root.observedIntentResult.detail
            color: Qt.darker(Color.popups.text, 1.25)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.Wrap
        }

        Button {
            Layout.fillWidth: true
            visible: root.pendingProposal !== null
            enabled: root.pendingProposal !== null
            text: root.pendingProposal === null
                ? ""
                : "Confirm " + String(root.pendingProposal.displayLabel)
            onClicked: root.authorizeAdoption({
                intentId: root.nextIntentId("authorize"),
                kind: "authorize_adoption",
                proposalId: root.pendingProposal.proposalId,
                proposalDigest: root.pendingProposal.proposalDigest
            })
        }
    }
}
`

function observerConsoleSource(source) {
  const replace = (from, to) => {
    const index = source.indexOf(from)
    if (index < 0) throw new Error('legacy Agent Console source shape changed')
    source = source.slice(0, index) + to + source.slice(index + from.length)
  }

  replace(
    `// cursor.\nimport QtQuick\n`,
    `// cursor.\n//\n// The observer-only lifecycle is a separate, standalone boundary: a host\n// opens a panel showing only Unassigned Agents through openObservedAgents(),\n// updates it through non-opening applyObservedAgents(), and dismisses it with\n// clearObservedAgents(). Observer opening never creates a Projection Session,\n// Active Session identity, managed card, or managed cursor, and managed\n// open()/clear()/close() never touch observer state. Panel visibility is\n// derived from the managed opened flag OR the observerOpened flag, so clearing\n// observer state can hide the panel only when no managed session is active.\nimport QtQuick\n`,
  )
  replace(
    `    property var lastIntentResult: null\n    property var activeSession: null\n`,
    `    property var lastIntentResult: null\n    property bool observerOpened: false\n    property var observerProjection: ({ observerRevision: 0, agents: [] })\n    property var observerIntentResult: null\n    property var activeSession: null\n`,
  )
  replace(
    `    signal intentRequested(var payload)\n    onIntentRequested: function(payload) {\n`,
    `    signal intentRequested(var payload)\n    signal requestAdoption(var payload)\n    signal authorizeAdoption(var payload)\n    onIntentRequested: function(payload) {\n`,
  )
  replace(
    `                "session.hide", "session.clear", "session.resnapshot"\n            ]\n`,
    `                "session.hide", "session.clear", "session.resnapshot",\n                "session.observer"\n            ]\n`,
  )
  replace(
    `    function open(payloadJson) {\n`,
    `    // Content validation shared by observer open/update. Standalone opening
    // additionally requires exactly empty choices; managed observer updates
    // retain the existing opaque-choice presentation behavior.

    function validObserverProjection(next, requireEmptyChoices) {\n        if (!next || typeof next !== "object") return false\n        if (typeof next.observerRevision !== "number" || next.observerRevision < 0) return false\n        if (!Array.isArray(next.agents)) return false\n        for (var index = 0; index < next.agents.length; index += 1) {\n            var agent = next.agents[index]\n            if (!agent || typeof agent !== "object") return false\n            if (agent.piStatus !== "Unassigned · observed") return false\n            if (!Array.isArray(agent.choices)\n                    || (requireEmptyChoices && agent.choices.length !== 0)) return false\n            if (typeof agent.observedSessionId !== "string"\n                    || typeof agent.lifecycle !== "string"\n                    || typeof agent.availability !== "string"\n                    || typeof agent.health !== "string") return false\n        }\n        return true\n    }\n\n    // Opens a standalone observer-only panel. Accepts only an exact
    // sessionless { observerProjection } payload carrying Unassigned ·
    // observed agents with empty choices. A validated payload commits the
    // projection and observerOpened atomically; invalid data never opens the
    // panel. No managed identity, card, cursor, or session is created.

    function openObservedAgents(value) {\n        var envelope = parsePayload(value)\n        if (!envelope || typeof envelope !== "object") return false\n        if (Object.keys(envelope).length !== 1\n                || envelope.session !== undefined\n                || envelope.projection !== undefined) return false\n        var next = envelope.observerProjection\n        if (!validObserverProjection(next, true)) return false\n        observerProjection = ({\n            observerRevision: next.observerRevision,\n            agents: next.agents\n        })\n        observerOpened = true\n        return true\n    }\n\n    // Non-opening observer update. This re-renders the observer projection in
    // the already visible panel (observer-only or alongside a managed panel)
    // but never opens the panel and never touches managed state.

    function applyObservedAgents(value) {\n        var envelope = parsePayload(value)\n        if (!envelope || typeof envelope !== "object") return false\n        var managedObserverUpdate = envelope.session !== undefined\n        if (managedObserverUpdate && !sessionMatches(envelope)) return false\n        var next = envelope.observerProjection && typeof envelope.observerProjection === "object"\n            ? envelope.observerProjection\n            : envelope.projection && typeof envelope.projection === "object"\n                ? envelope.projection : envelope\n        if (!validObserverProjection(next, !managedObserverUpdate)) return false\n        observerProjection = ({\n            observerRevision: next.observerRevision,\n            agents: next.agents\n        })\n        return true\n    }\n\n    function applyObserverProjection(value) {\n        return applyObservedAgents(value)\n    }\n\n    // Clears only observer presentation state. The panel hides only when no
    // managed session is open (visibility is derived from the opened flag OR
    // the observerOpened flag); managed state is never cleared or hidden.

    function clearObservedAgents() {\n        observerOpened = false\n        observerProjection = ({ observerRevision: 0, agents: [] })\n        observerIntentResult = null\n        unassignedAgents.clearIntentState()\n        return true\n    }\n\n    function observedIntentResult(value) {\n        var result = parsePayload(value)\n        if (!result || typeof result !== "object") return false\n        if (result.session !== undefined && !sessionMatches(result)) return false\n        observerIntentResult = result\n        return unassignedAgents.applyIntentResult(result)\n    }\n\n    function applyObserverIntentResult(value) {\n        return observedIntentResult(value)\n    }\n\n    function open(payloadJson) {\n`,
  )
  replace(
    `        id: panel\n        visible: root.opened\n`,
    `        id: panel\n        visible: root.opened || root.observerOpened\n`,
  )
  replace(
    `                spacing: Style.space(12)\n\n                RowLayout {\n                    Layout.fillWidth: true\n                    spacing: Style.space(10)\n\n                    Text {\n                        Layout.fillWidth: true\n                        text: "Agent Console"\n                        color: Color.popups.text\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.heading\n                        font.bold: true\n                    }\n\n                    Text {\n                        text: "cursor " + String(root.projection.cursor)\n                        color: Qt.darker(Color.popups.text, 1.45)\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.caption\n                    }\n                }\n\n                Text {\n                    Layout.fillWidth: true\n                    text: root.projection.status\n                    color: root.projection.status === "gap"\n                        ? Color.urgent : Color.accent\n                    font.family: Style.font.family\n                    font.pixelSize: Style.font.body\n                    font.bold: true\n                }\n\n                Text {\n                    Layout.fillWidth: true\n                    visible: root.projection.status === "ready"\n                    text: "Projection ready"\n                    color: Qt.darker(Color.popups.text, 1.35)\n                    font.family: Style.font.family\n                    font.pixelSize: Style.font.caption\n                }\n\n                Text {\n                    Layout.fillWidth: true\n                    visible: root.projection.status === "reconnecting"\n                    text: "Reconnecting to the Team Runner projection"\n                    color: Qt.darker(Color.popups.text, 1.35)\n                    font.family: Style.font.family\n                    font.pixelSize: Style.font.caption\n                }\n\n                Text {\n                    Layout.fillWidth: true\n                    visible: root.projection.status === "gap"\n                    text: "Projection gap: awaiting an authoritative snapshot"\n                    color: Color.urgent\n                    font.family: Style.font.family\n                    font.pixelSize: Style.font.caption\n                }\n\n                AgentConsoleCards {\n                    Layout.fillWidth: true\n                    cards: root.projection.cards\n                    onPresentRequested: function(role) { root.requestPresent(role) }\n                }\n\n                Text {\n                    Layout.fillWidth: true\n                    visible: root.lastIntentResult !== null\n                    text: root.lastIntentResult === null ? "" : "Present action: " + root.lastIntentResult.result\n                    color: Qt.darker(Color.popups.text, 1.35)\n                    font.family: Style.font.family\n                    font.pixelSize: Style.font.caption\n                }\n            }\n`,
    `                spacing: Style.space(12)\n\n                ColumnLayout {\n                    id: managedConsole\n                    Layout.fillWidth: true\n                    visible: root.opened\n                    spacing: Style.space(12)\n\n                    RowLayout {\n                        Layout.fillWidth: true\n                        spacing: Style.space(10)\n\n                        Text {\n                            Layout.fillWidth: true\n                            text: "Agent Console"\n                            color: Color.popups.text\n                            font.family: Style.font.family\n                            font.pixelSize: Style.font.heading\n                            font.bold: true\n                        }\n\n                        Text {\n                            text: "cursor " + String(root.projection.cursor)\n                            color: Qt.darker(Color.popups.text, 1.45)\n                            font.family: Style.font.family\n                            font.pixelSize: Style.font.caption\n                        }\n                    }\n\n                    Text {\n                        Layout.fillWidth: true\n                        text: root.projection.status\n                        color: root.projection.status === "gap"\n                            ? Color.urgent : Color.accent\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.body\n                        font.bold: true\n                    }\n\n                    Text {\n                        Layout.fillWidth: true\n                        visible: root.projection.status === "ready"\n                        text: "Projection ready"\n                        color: Qt.darker(Color.popups.text, 1.35)\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.caption\n                    }\n\n                    Text {\n                        Layout.fillWidth: true\n                        visible: root.projection.status === "reconnecting"\n                        text: "Reconnecting to the Team Runner projection"\n                        color: Qt.darker(Color.popups.text, 1.35)\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.caption\n                    }\n\n                    Text {\n                        Layout.fillWidth: true\n                        visible: root.projection.status === "gap"\n                        text: "Projection gap: awaiting an authoritative snapshot"\n                        color: Color.urgent\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.caption\n                    }\n\n                    AgentConsoleCards {\n                        Layout.fillWidth: true\n                        cards: root.projection.cards\n                        onPresentRequested: function(role) { root.requestPresent(role) }\n                    }\n\n                    Text {\n                        Layout.fillWidth: true\n                        visible: root.lastIntentResult !== null\n                        text: root.lastIntentResult === null ? "" : "Present action: " + root.lastIntentResult.result\n                        color: Qt.darker(Color.popups.text, 1.35)\n                        font.family: Style.font.family\n                        font.pixelSize: Style.font.caption\n                    }\n                }\n\n                UnassignedAgents {\n                    id: unassignedAgents\n                    Layout.fillWidth: true\n                    visible: root.opened || root.observerOpened\n                    projection: root.observerProjection\n                    onRequestAdoption: function(payload) { root.requestAdoption(payload) }\n                    onAuthorizeAdoption: function(payload) { root.authorizeAdoption(payload) }\n                }\n            }\n`,
  )
  replace(
    `    property var shell: null`,
    `    // Presentation-only edge preference, configurable through shell call.
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

    property var shell: null`,
  )
  replace(`            top: true\n            bottom: true\n            left: true\n            right: true`,
    `            top: !root.standaloneDock || root.panelEdge !== "bottom"\n            bottom: !root.standaloneDock || root.panelEdge !== "top"\n            left: !root.standaloneDock || root.panelEdge !== "right"\n            right: !root.standaloneDock || root.panelEdge !== "left"`)
  replace(`        color: "transparent"\n        WlrLayershell.namespace:`,
    `        implicitWidth: Style.space(360)\n        implicitHeight: Style.space(280)\n        color: "transparent"\n        WlrLayershell.namespace:`)
  replace(`        WlrLayershell.layer: WlrLayer.Overlay`,
    `        WlrLayershell.layer: root.standaloneDock ? WlrLayer.Top : WlrLayer.Overlay`)
  replace(`        exclusionMode: ExclusionMode.Ignore`,
    `        exclusionMode: root.standaloneDock ? ExclusionMode.Auto : ExclusionMode.Ignore`)
  replace(`            width: Math.min(parent.width - Style.space(48), Style.space(900))\n            height: consoleColumn.implicitHeight + Style.space(36)`,
    `            width: root.standaloneDock ? parent.width : Math.min(parent.width - Style.space(48), Style.space(900))\n            height: root.standaloneDock ? parent.height : consoleColumn.implicitHeight + Style.space(36)`)
  return source
}

const OBSERVER_AGENT_CONSOLE_QML = observerConsoleSource(AGENT_CONSOLE_QML)

export const COMPANION_RELEASE: CompanionRelease = freezeCompanionRelease({
  pluginId: COMPANION_PLUGIN_ID,
  version: COMPANION_PLUGIN_VERSION,
  protocol: COMPANION_PROTOCOL_ID,
  compatibility: {
    omarchy: '4.0.2-1',
    quickshell: '0.3.1-1',
  },
  assets: {
    'manifest.json': MANIFEST,
    'AgentConsole.qml': AGENT_CONSOLE_QML,
    'AgentConsoleCards.qml': AGENT_CONSOLE_CARDS_QML,
  },
})

export const DEFAULT_COMPANION_RELEASE = COMPANION_RELEASE

export const OBSERVER_COMPANION_RELEASE_VERSION = '0.3.0'
export const OBSERVER_COMPANION_RELEASE: CompanionRelease = freezeCompanionRelease({
  pluginId: COMPANION_PLUGIN_ID,
  version: OBSERVER_COMPANION_RELEASE_VERSION,
  protocol: COMPANION_PROTOCOL_ID,
  compatibility: {
    omarchy: '4.0.2-1',
    quickshell: '0.3.1-1',
  },
  assets: {
    'manifest.json': OBSERVER_MANIFEST,
    'AgentConsole.qml': OBSERVER_AGENT_CONSOLE_QML,
    'AgentConsoleCards.qml': AGENT_CONSOLE_CARDS_QML,
    'UnassignedAgents.qml': OBSERVER_UNASSIGNED_AGENTS_QML,
  },
})

export const ADOPTION_COMPANION_RELEASE: CompanionRelease = freezeCompanionRelease({
  ...OBSERVER_COMPANION_RELEASE,
  version: '0.4.0',
  assets: {
    ...OBSERVER_COMPANION_RELEASE.assets,
    'manifest.json': OBSERVER_MANIFEST.replace('"0.3.0"', '"0.4.0"'),
    'AgentConsole.qml': OBSERVER_AGENT_CONSOLE_QML.replace('    property var shell: null', ADOPTION_ROOT_MEMBERS + '\n    property var shell: null'),
    'AdoptionPanel.qml': ADOPTION_PANEL_QML,
  },
})

export const RELEASE_CATALOG: Readonly<Record<string, CompanionRelease>> = Object.freeze({
  [COMPANION_RELEASE.version]: COMPANION_RELEASE,
  [OBSERVER_COMPANION_RELEASE.version]: OBSERVER_COMPANION_RELEASE,
  [ADOPTION_COMPANION_RELEASE.version]: ADOPTION_COMPANION_RELEASE,
})

export function companionRelease(version = COMPANION_PLUGIN_VERSION): CompanionRelease {
  const result = RELEASE_CATALOG[version]
  if (result === undefined) throw new CompanionInstallationError('invalid_release', `unknown Companion release ${version}`)
  return result
}
