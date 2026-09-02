/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Versioned, immutable Companion Plugin release catalog. The asset strings are
 * the source snapshot packaged by the explicit setup path. No filesystem read
 * is performed while importing this module.
 */

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

    // Presentation-intent surface: the panel may only EMIT a user intent as
    // a plain payload. The non-QML adapter validates, deduplicates, and
    // acknowledges it; this component never speaks the runner protocol or
    // derives any cursor value.
    signal intentRequested(var payload)

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
        var value = payloadJson
        if (typeof payloadJson === "string") {
            try {
                value = JSON.parse(payloadJson || "{}")
            } catch (error) {
                return false
            }
        }
        if (!value || typeof value !== "object") return false
        return applyProjection({
            status: value.status,
            cursor: value.cursor,
            cards: value.cards
        })
    }

    // Intent acknowledgements are displayed as plain data. The adapter, not
    // QML, decides whether an intent is accepted or duplicate.
    function intentResult(payloadJson) {
        var value = payloadJson
        if (typeof payloadJson === "string") {
            try {
                value = JSON.parse(payloadJson || "{}")
            } catch (error) {
                return false
            }
        }
        if (!value || typeof value !== "object"
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
        var value = payloadJson
        if (typeof payloadJson === "string") {
            try {
                value = JSON.parse(payloadJson || "{}")
            } catch (error) {
                value = null
            }
        }
        if (value && value.projection !== undefined) value = value.projection
        // The panel opens only when a validated projection applies. An
        // invalid or missing payload must never open the surface showing
        // QML-authored placeholder state: the authoritative snapshot from
        // the runner adapter is the only thing that may open it.
        if (!applyProjection(value)) return false
        opened = true
        return true
    }

    function close() {
        opened = false
    }

    // Clears all ephemeral presentation state without closing the surface or
    // touching any installed plugin state. The next authoritative snapshot
    // fully re-derives the visible projection.
    function clear() {
        projection = ({ status: "reconnecting", cursor: 0, cards: [] })
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
        mask: Region {}

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
export const RELEASE_CATALOG: Readonly<Record<string, CompanionRelease>> = Object.freeze({
  [COMPANION_RELEASE.version]: COMPANION_RELEASE,
})

export function companionRelease(version = COMPANION_PLUGIN_VERSION): CompanionRelease {
  const result = RELEASE_CATALOG[version]
  if (result === undefined) throw new CompanionInstallationError('invalid_release', `unknown Companion release ${version}`)
  return result
}
