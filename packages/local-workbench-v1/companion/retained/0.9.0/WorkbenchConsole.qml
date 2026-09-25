// Local Workbench v1 — task-first presentation console.
//
// Renders a validated plain projection and emits presentation intents. A host
// injects the authoritative snapshot through open()/applyProjection(); clear()
// and close() remove only ephemeral presentation state. This component never
// computes protocol, cursor, sequencing, readiness, or writer values itself.
// The runner remains the sole authority for durable state, admission, gates,
// and projections.
//
// One contextual destination is shown at a time with a Back path. Creation is
// not dispatch: no field, fixture or preview configuration grants authority or
// executes a command. Board and unsupported runtime actions are visibly
// disabled with reasons and emit no intent. Fixture mode is persistently
// labelled so injected data is never mistaken for live work.
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

    // Fixed dock geometry. Opening a destination changes only the content
    // inside the surface. It must never resize the layer surface: the shell
    // re-reserves compositor edge space on every size change, which shifts
    // neighbouring terminals. A full-screen workspace mode is deliberately
    // deferred until the console carries more functionality than a dock can
    // hold.
    readonly property int panelWidth: Style.space(420)
    readonly property int panelHeight: Style.space(560)
    property var shell: null
    property var manifest: null
    property bool opened: false
    property var projection: null
    property var activeSession: null
    property var pendingIntents: []
    property string destination: "overview"
    property string checksOrigin: "overview"
    property string pendingGoalNavigation: ""
    property bool menuOpen: false
    property bool projectListOpen: false
    property var confirmation: null
    property var drafts: ({})
    property string draftError: ""
    property string confirmationText: ""
    property bool confirmationDetailsOpen: false
    property var lastIntentResult: null
    property double pluginGeneration: 0 // Injected by the presentation host.
    // Presentation-only selection state. Never authority.
    property string selectedAgentRunId: ""
    property string selectedObservedSessionId: ""
    property string selectedRole: ""
    property string selectedCheckId: ""
    property int selectedCheckVersion: 0
    // The captured exact start review. Cleared whenever its association moves.
    property var startReview: null

    signal intentRequested(var payload)

    readonly property color textColor: Color.popups.text
    readonly property color mutedColor: Qt.darker(root.textColor, 1.45)

    readonly property var selectedProject: {
        if (projection && projection.selectedProject !== undefined) return projection.selectedProject
        if (!projection || !Array.isArray(projection.projects)) return null
        for (var i = 0; i < projection.projects.length; i++) {
            if (projection.projects[i].projectId === projection.selectedProjectId) return projection.projects[i]
        }
        return null
    }
    readonly property var selectedGoal: {
        if (projection && projection.selectedGoal !== undefined) return projection.selectedGoal
        if (!projection || !Array.isArray(projection.goals)) return null
        for (var i = 0; i < projection.goals.length; i++) {
            if (projection.goals[i].goalId === projection.selectedGoalId) return projection.goals[i]
        }
        return null
    }
    // Any relevant identity, revision or selection change invalidates the
    // captured review and its confirmation without touching draft text. The
    // captured task text is part of the association: a review that would start
    // different work than it shows must never survive.
    readonly property string reviewAssociation: JSON.stringify([
        projection ? projection.sessionId : "",
        projection ? projection.pluginGeneration : 0,
        projection ? projection.runnerEpoch : 0,
        projection ? projection.revision : -1,
        projection ? projection.selectedProjectId : null,
        projection ? projection.selectedGoalId : null,
        selectedAgentRunId, selectedCheckId, selectedCheckVersion,
        assignmentDraft().taskText || ""])
    onReviewAssociationChanged: {
        if (startReview !== null && startReview.association !== reviewAssociation) {
            startReview = null
            confirmation = null
            confirmDialog.close()
        }
    }

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

    function draftValue(key) {
        return drafts[key] || ""
    }

    function goalDraftKey() {
        if (!projection || !projection.selectedProjectId) return ""
        return "goal:new:" + projection.selectedProjectId
    }

    function assignmentKey() {
        if (!projection || !projection.selectedProjectId || !projection.selectedGoalId || !selectedAgentRunId) return ""
        return "assignment:" + projection.selectedProjectId + ":" + projection.selectedGoalId + ":" + selectedAgentRunId
    }

    function assignmentDraft() {
        var key = assignmentKey()
        if (!key) return {}
        try { return JSON.parse(drafts[key] || "{}") } catch (error) { return {} }
    }

    function checksDraftKey() {
        if (!projection || !projection.selectedProjectId) return ""
        // A new check is edited before it has an id; its draft is keyed by the
        // Project so unsaved field text survives navigation and restart while
        // remaining separate from every existing check's draft.
        return "checks:" + projection.selectedProjectId + ":" + (selectedCheckId || "new")
    }

    function checkById(checkId, version) {
        if (!projection || !Array.isArray(projection.checks)) return null
        for (var i = 0; i < projection.checks.length; i++) {
            if (projection.checks[i].checkId === checkId && projection.checks[i].version === version) return projection.checks[i]
        }
        return null
    }

    function selectedCheck() {
        return checkById(selectedCheckId, selectedCheckVersion)
    }

    function startDetail() {
        if (!projection || !Array.isArray(projection.details) || startReview === null) return null
        for (var i = 0; i < projection.details.length; i++) {
            var entry = projection.details[i]
            if (entry.kind === "start" && entry.projectId === projection.selectedProjectId
                    && selectedCheck() && entry.gate.digest === selectedCheck().digest
                    && entry.goalText === startReview.taskText
                    && entry.goalId === projection.selectedGoalId
                    && entry.agentRunId === startReview.agentRunId
                    && entry.gate.gateId === startReview.checkId
                    && entry.gate.version === startReview.checkVersion) return entry
        }
        return null
    }

    function adoptionDetail() {
        if (!projection || !Array.isArray(projection.details)) return null
        for (var i = 0; i < projection.details.length; i++) {
            var entry = projection.details[i]
            if (entry.kind === "adoption" && entry.observedSessionId === selectedObservedSessionId
                    && entry.goalId === projection.selectedGoalId && entry.role === selectedRole) return entry
        }
        return null
    }

    // The committed outcome detail for one Assignment. Stop, handoff and
    // diagnostics facts belong beside the work they describe; they are never
    // rendered as a generic transcript and never claim more than they prove.
    function workDetail(assignment) {
        if (assignment === null || assignment === undefined
                || !projection || !Array.isArray(projection.details)) return null
        for (var i = 0; i < projection.details.length; i++) {
            var entry = projection.details[i]
            if (entry.assignmentId === assignment.assignmentId
                    && ["stop", "handoff", "diagnostics"].indexOf(entry.kind) >= 0) return entry
        }
        return null
    }

    // The schema bounds this collection to 100. Render every supplied Assignment
    // with its own outcome facts; do not silently discard rows or redirect to events.
    function workRows() {
        if (!projection || !Array.isArray(projection.assignments)) return []
        var rows = []
        for (var i = 0; i < projection.assignments.length; i++) {
            var detail = workDetail(projection.assignments[i])
            rows.push({
                assignment: projection.assignments[i],
                resultText: detail === null ? "" : detailText(detail)
            })
        }
        return rows
    }

    function workTruncationNote() {
        if (!projection || !Array.isArray(projection.assignments) || projection.assignments.length <= 8) return ""
        return "Showing all " + projection.assignments.length + " committed Assignments. Scroll to see more."
    }

    function hasSelectedGoal() {
        return projection !== null && projection.selectedGoalId !== null
    }

    function parentDestination(value) {
        if (value === "new_goal" || value === "goal" || value === "activity") return "overview"
        if (value === "add_agent" || value === "work") return hasSelectedGoal() ? "goal" : "overview"
        if (value === "adoption_review") return "add_agent"
        if (value === "assignment") return hasSelectedGoal() ? "goal" : "overview"
        if (value === "start_review") return "assignment"
        if (value === "checks") return checksOrigin
        return "overview"
    }

    // Keyboard safety: a closed contextual surface returns focus to the control
    // that opened it, and a destination change moves focus to a visible control
    // instead of leaving it on a hidden one.
    function focusDestination() {
        if (destination !== "overview") backButton.forceActiveFocus()
        else overview.focusPrimary()
    }

    function back() {
        if (confirmDialog.opened) { confirmDialog.close(); confirmation = null; return }
        if (menuOpen) { menuOpen = false; return }
        if (projectListOpen) { projectListOpen = false; return }
        if (destination === "overview") return
        destination = parentDestination(destination)
        focusDestination()
    }

    function goTo(value) {
        if (value === "checks" && destination !== "checks") checksOrigin = destination
        menuOpen = false
        projectListOpen = false
        destination = value
        focusDestination()
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

    // A matching on-disk fingerprint never proves which QML the long-lived
    // shell instance actually loaded. The loaded component answers the
    // presentation contract itself, so a stale instance is detected before any
    // projection is applied. Read-only; grants no authority.
    function presentationContract() {
        if (!manifest || !manifest.companion) return ""
        return JSON.stringify({
            protocol: manifest.companion.protocol,
            pluginId: manifest.id,
            version: manifest.version,
            pluginGeneration: pluginGeneration,
            presentation: "task-first-v2",
            destinations: ["overview", "goal", "new_goal", "add_agent", "adoption_review",
                "assignment", "checks", "start_review", "work", "activity"]
        })
    }

    // The host supplies a validated plain projection. QML only applies it.
    function applyProjection(value) {
        // The installed shell invokes methods with an encoded JSON argv;
        // open() already decodes its envelope, but subsequent updates arrive
        // here directly as strings. Treat both paths identically.
        value = parsePayload(value)
        if (!value || typeof value !== "object") return false
        if (typeof value.revision !== "number" || value.revision < 0) return false
        if (typeof value.cursor !== "number" || value.cursor < 0) return false
        if (typeof value.connection !== "string") return false
        if (!Array.isArray(value.managedAgents)) return false
        if (!Array.isArray(value.observedSessions)) return false
        if (!Array.isArray(value.retiredRuns)) return false
        if (!Array.isArray(value.assignments)) return false
        if (!Array.isArray(value.checks)) return false
        // Even a same-revision replacement may narrow action availability.
        // Never rebind a displayed confirmation or queued click to changed data.
        if (projection && JSON.stringify(projection) !== JSON.stringify(value)) {
            startReview = null
            menuOpen = false
            confirmation = null
            pendingIntents = []
            confirmDialog.close()
            lastIntentResult = null
        }
        projection = value
        if (root.pendingGoalNavigation && value.selectedGoalId === root.pendingGoalNavigation) {
            root.pendingGoalNavigation = ""
            goTo("goal")
        }
        projectionWatchdog.restart()
        return true
    }

    function markPresentationStale() {
        pendingGoalNavigation = ""
        if (!projection || projection.connection !== "connected") return
        projection = Object.assign({}, projection, { connection: "stale" })
        confirmation = null
        pendingIntents = []
        lastIntentResult = null
        startReview = null
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
        pendingGoalNavigation = ""
        confirmation = null
        confirmDialog.close()
        opened = false
        menuOpen = false
        projectListOpen = false
        activeSession = null
        projection = null
        lastIntentResult = null
        pendingIntents = []
        startReview = null
    }

    function clear(payloadJson) {
        var value = parsePayload(payloadJson)
        if (!sessionMatches(value)) return false
        pendingGoalNavigation = ""
        projection = null
        confirmation = null
        confirmDialog.close()
        lastIntentResult = null
        pendingIntents = []
        activeSession = null
        opened = false
        startReview = null
        destination = "overview"
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

    // Hiding the view is presentation-only. It is available even if the
    // authority connection has gone stale; it never becomes a runner intent.
    function requestHide() {
        if (activeSession === null || pendingIntents.length >= 16) return
        var request = { kind: "hide_workbench", target: null, payload: {} }
        pendingIntents = pendingIntents.concat([request])
        root.intentRequested(request)
    }

    function requestConfirmation(payload) {
        if (!projection || projection.connection !== "connected") return
        var descriptions = {
            take_control: "Take control? Automatic work pauses. Running tools may continue.",
            return_to_team: "Return to team? Request a handoff; work stays paused until reconciled.",
            accept: "Submit this handoff for acceptance-check validation? This does not bypass the check.",
            resume: "Resume this assignment after reconciliation?",
            retry: "Retry this assignment within its existing limits?",
            stop: "Stop orchestration? New work stops, but Pi and running tools may continue. Files are retained.",
            retire: "Retire this agent binding permanently? This does not stop Pi or prove writer safety.",
            purge: "Delete this retired history permanently? Pi conversations and external work are not deleted.",
            request_adoption: "Request adoption of this session into the selected Goal? No work is dispatched."
        }
        confirmationText = descriptions[payload.kind] || "Confirm this action for the selected item?"
        if (root.selectedGoal) confirmationText += "\nGoal: " + root.selectedGoal.goalText
        var subjects = [].concat(projection.managedAgents || [], projection.assignments || [], projection.retiredRuns || [], projection.observedSessions || [])
        for (var i = 0; i < subjects.length; i++) {
            var item = subjects[i]
            if (item.agentRunId === payload.target || item.assignmentId === payload.target || item.observedSessionId === payload.target) {
                confirmationText += "\nFor: " + (item.goalText || item.role || item.piStatus || "selected item")
                break
            }
        }
        if (payload.kind === "request_adoption" && Array.isArray(projection.observedSessions)) {
            for (var s = 0; s < projection.observedSessions.length; s++) {
                var card = projection.observedSessions[s]
                for (var c = 0; c < card.choices.length; c++) {
                    if (card.choices[c].choiceId === payload.target && card.choices[c].role)
                        confirmationText += "\nRole: " + card.choices[c].role
                }
            }
        }
        if (payload.target) confirmationText += "\nReference: …" + String(payload.target).slice(-8)
        confirmationDetailsOpen = false
        if (payload.kind === "select_goal") { selectGoal(payload.target); return }
        // Non-destructive declarations commit without a modal confirmation; the
        // runner still validates and may reject them.
        if (["select_project", "create_goal", "configure_checks", "inspect_project",
                "confirm_register_project", "create_check", "authorize_adoption"].indexOf(payload.kind) >= 0) {
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

    // Presentation-only selection and review capture.
    function selectProject(projectId) {
        pendingGoalNavigation = ""
        projectListOpen = false
        emitIntent({ kind: "select_project", target: projectId, payload: { projectId: projectId } })
    }

    function selectGoal(goalId) {
        selectedAgentRunId = ""
        selectedCheckId = ""
        selectedCheckVersion = 0
        pendingGoalNavigation = goalId
        emitIntent({ kind: "select_goal", target: goalId, payload: { goalId: goalId } })
        if (projection && projection.selectedGoalId === goalId) {
            pendingGoalNavigation = ""
            goTo("goal")
        }
    }

    function selectAgent(runId) {
        selectedAgentRunId = runId
    }

    function selectObserved(sessionId) {
        selectedObservedSessionId = sessionId
    }

    function selectRole(role) {
        selectedRole = role
    }

    function selectCheck(checkId, version) {
        selectedCheckId = checkId
        selectedCheckVersion = version
    }

    function captureStartReview() {
        if (!projection || projection.connection !== "connected") return false
        if (!projection.managedAgents.some(function(card) { return card.agentRunId === root.selectedAgentRunId })) return false
        if (!selectedAgentRunId || !selectedCheckId) return false
        var check = checkById(selectedCheckId, selectedCheckVersion)
        if (!check || check.availability !== "available") return false
        var taskText = (assignmentDraft().taskText || "").trim()
        if (taskText === "") return false
        startReview = ({
            checkId: check.checkId,
            checkVersion: check.version,
            agentRunId: selectedAgentRunId,
            taskText: taskText,
            association: reviewAssociation
        })
        destination = "start_review"
        focusDestination()
        return true
    }

    function reviewAvailable() {
        if (!projection || projection.connection !== "connected") return false
        if (!projection.managedAgents.some(function(card) { return card.agentRunId === root.selectedAgentRunId })) return false
        if (!selectedAgentRunId || !selectedCheckId) return false
        var check = checkById(selectedCheckId, selectedCheckVersion)
        return check !== null && check.availability === "available"
    }

    function reviewBlockedReason() {
        if (!projection || projection.connection !== "connected") return "Waiting for an authoritative projection."
        if (!selectedAgentRunId || !projection.managedAgents.some(function(card) { return card.agentRunId === root.selectedAgentRunId })) return "Choose a current target agent."
        if ((assignmentDraft().taskText || "").trim() === "") return "Describe the task before reviewing start."
        if (!selectedCheckId) return "Configure an acceptance check before starting."
        var check = checkById(selectedCheckId, selectedCheckVersion)
        if (check === null) return "The selected check version is no longer available. Configure checks."
        if (check.availability !== "available") return check.reason || "The selected check is not available."
        return ""
    }

    // Exact-fact detail copy. Rendered literally; never authority.
    function detailText(detail) {
        if (!detail) return "Unavailable detail"
        if (detail.kind === "adoption") return "Adoption " + detail.proposalId + " · " + detail.stage
            + "\nExact observed session: " + detail.observedSessionId + "\nProject / Node: " + detail.projectId + " / " + detail.executionNodeId
            + "\nGoal / Role: " + detail.goalId + " / " + detail.role + "\nPredecessor: " + (detail.predecessorAgentRunId || "none")
            + " · Vacancy generation: " + detail.vacancyGeneration + "\nACK and committed delivery must precede readiness. No Assignment is created."
        if (detail.kind === "handoff") return "Handoff " + detail.handoffId + " · " + detail.claimedState
            + "\nRun / Assignment / Attempt: " + detail.agentRunId + " / " + detail.assignmentId + " / " + detail.attemptId
            + "\nControl epoch: " + detail.controlEpoch + " · Outstanding effects: " + detail.outstandingEffects
            + "\n" + detail.summary + "\nArtifacts: " + detail.artifactRefs.join(", ")
            + "\nClaims are not proof tools stopped. Accept requests gate validation; it never bypasses the gate."
        if (detail.kind === "stop") return "Stop " + detail.stopId + " · " + detail.trigger + "\nAssignment: " + detail.assignmentId
            + "\nDispatch revoked: " + (detail.dispatchRevoked ? "yes" : "not confirmed")
            + "\nCancellation: " + detail.cancellationStatus + "\nCancellation acknowledgement is not tool/process termination. Files are retained."
        if (detail.kind === "diagnostics") return "Restricted diagnostics · " + detail.state + "\nAssignment / Attempt: " + detail.assignmentId + " / " + detail.attemptId
            + "\n" + detail.reason + "\nExplicit consent permits a filtered excerpt only. Filtering cannot guarantee secret removal. No output is included in this projection."
        if (detail.kind === "start") return "Start confirmation " + detail.confirmationId
            + "\nProject / Goal / Run: " + detail.projectId + " / " + detail.goalId + " / " + detail.agentRunId
            + "\nGoal: " + detail.goalText + "\nNode: " + detail.executionNodeId + "\nGit context: " + detail.gitCommonDir + " · HEAD " + detail.headOid
            + "\nBaseline: " + detail.baselineDigest + "\nDirty baseline: " + (detail.dirty ? "explicit acknowledgement required; existing changes retained" : "clean at capture")
            + "\nGate: " + detail.gate.gateId + " v" + detail.gate.version + " · " + detail.gate.digest
            + "\nExecutable: " + detail.gate.executable + " · digest " + detail.gate.executableDigest
            + "\nArgv (JSON, not shell): " + JSON.stringify(detail.gate.argv)
            + "\nCwd: " + detail.gate.cwd + "\nExplicit environment: " + JSON.stringify(detail.gate.environment)
            + "\nFrozen resources: " + JSON.stringify(detail.gate.resources)
            + "\nTimeout ms / output bytes: " + detail.gate.timeoutMs + " / " + detail.gate.outputBytes
            + "\nCorrections / elapsed ms: " + detail.maxCorrections + " / " + detail.elapsedMs
            + "\nSemantic claim: " + detail.gate.semanticClaim
            + "\nThis is code execution. No isolation or rollback. A passing gate establishes only its encoded checks."
        return "Unavailable detail"
    }

    // Escape is handled inside the panel window. The layer-shell panel is a
    // separate window, so a handler on this root item would never receive a key
    // event from panel focus; `surface` is the ancestor of every panel control.
    function handleEscape(event) {
        if (confirmDialog.opened) { confirmDialog.close(); confirmation = null; event.accepted = true; return }
        if (menuOpen) { menuOpen = false; event.accepted = true; return }
        if (projectListOpen) { projectListOpen = false; event.accepted = true; return }
        if (destination !== "overview") { back(); event.accepted = true; return }
        event.accepted = false
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
            title: "Confirm exact action"
            palette: overview.palette
            modal: true
            anchors.centerIn: parent
            width: Math.max(1, Math.min(parent.width - Style.space(24), Style.space(640)))
            height: Math.max(1, Math.min(parent.height - Style.space(24), implicitHeight))
            standardButtons: Dialog.Ok | Dialog.Cancel
            padding: Style.space(12)
            background: Rectangle {
                color: Color.popups.background
                radius: Style.cornerRadius
                border.width: 1
                border.color: Color.accent
            }
            header: Label {
                text: confirmDialog.title
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                padding: Style.space(12)
                color: Color.popups.text
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
            }
            footer: DialogButtonBox {
                standardButtons: confirmDialog.standardButtons
                padding: Style.space(8)
                spacing: Style.space(8)
                background: Item {}
                delegate: WorkbenchAction {}
                onAccepted: confirmDialog.accept()
                onRejected: confirmDialog.reject()
            }
            closePolicy: Popup.CloseOnEscape
            onAccepted: {
                if (root.confirmation) root.emitIntent(root.confirmation)
                root.confirmation = null
            }
            onRejected: root.confirmation = null
            contentItem: ScrollView {
                clip: true
                contentWidth: availableWidth
                Column {
                    width: parent.width
                    spacing: Style.space(8)
                    Label {
                        width: parent.width
                        text: root.confirmation ? root.confirmationText : "Expired"
                        textFormat: Text.PlainText
                        wrapMode: Text.WrapAnywhere
                        color: Color.popups.text
                    }
                    WorkbenchAction {
                        text: root.confirmationDetailsOpen ? "Hide exact target" : "Exact target"
                        onClicked: root.confirmationDetailsOpen = !root.confirmationDetailsOpen
                    }
                    Label {
                        width: parent.width
                        visible: root.confirmationDetailsOpen
                        text: root.confirmation ? JSON.stringify(root.confirmation) : ""
                        textFormat: Text.PlainText
                        wrapMode: Text.WrapAnywhere
                        color: Color.popups.text
                    }
                }
            }
        }

        Native.BorderSurface {
            id: surface
            anchors.fill: parent
            Keys.onEscapePressed: function(event) { root.handleEscape(event) }
            color: Color.popups.background
            borderSpec: Border.surfaceSpec(
                "popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
            radius: Style.cornerRadius

            Flickable {
                id: scroll
                objectName: "workbench-scroll"
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

                    // Persistent context header: connection, preview label,
                    // Project selector and current Goal. Never an internal ID.
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Style.space(6)

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Style.space(6)
                            WorkbenchAction {
                                id: backButton
                                objectName: "workbench-back"
                                visible: root.destination !== "overview"
                                text: "← Back"
                                Accessible.name: "Back"
                                focusPolicy: Qt.StrongFocus
                                onClicked: root.back()
                            }
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                wrapMode: Text.WrapAnywhere
                                text: "Runner: " + (root.projection === null ? "loading" : String(root.projection.connection))
                                color: root.projection !== null && root.projection.connection === "gap"
                                    ? Color.urgent : Color.accent
                                font.family: Style.font.family
                                font.pixelSize: Style.font.body
                                font.bold: true
                            }
                            WorkbenchAction {
                                objectName: "workbench-close"
                                text: "×"
                                Accessible.name: "Close workbench dock"
                                focusPolicy: Qt.StrongFocus
                                enabled: root.opened && root.activeSession !== null
                                onClicked: root.requestHide()
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: root.projection !== null && root.projection.fixture
                                && root.projection.fixture.active
                            textFormat: Text.PlainText
                            wrapMode: Text.WrapAnywhere
                            text: root.projection === null ? "" : "Preview · " + String(root.projection.fixture.label)
                            color: Color.urgent
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                            font.bold: true
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: Style.space(6)
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                wrapMode: Text.WrapAnywhere
                                text: "Project: " + (root.selectedProject ? root.selectedProject.canonicalPath
                                    : (root.projection ? "select a Project" : "unavailable"))
                                color: root.textColor
                                font.family: Style.font.family
                                font.pixelSize: Style.font.caption
                            }
                            WorkbenchAction {
                                id: changeProjectButton
                                visible: root.destination !== "new_goal"
                                text: "Change"
                                Accessible.name: "Change Project"
                                focusPolicy: Qt.StrongFocus
                                enabled: root.projection !== null && root.projection.connection === "connected"
                                onClicked: root.projectListOpen = !root.projectListOpen
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            visible: root.projectListOpen
                            spacing: Style.space(4)
                            onVisibleChanged: {
                                if (visible) Qt.callLater(function() {
                                    var first = projectRepeater.itemAt(0)
                                    if (first && root.projectListOpen) first.forceActiveFocus()
                                })
                                else if (root.destination === "new_goal") goalPage.focusProjectControl()
                                else changeProjectButton.forceActiveFocus()
                            }
                            Repeater {
                                id: projectRepeater
                                model: root.projection && Array.isArray(root.projection.projects)
                                    ? root.projection.projects : []
                                delegate: WorkbenchAction {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    text: modelData.canonicalPath
                                    highlighted: root.projection !== null
                                        && root.projection.selectedProjectId === modelData.projectId
                                    focusPolicy: Qt.StrongFocus
                                    onClicked: root.selectProject(modelData.projectId)
                                }
                            }
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: root.selectedGoal !== null
                            textFormat: Text.PlainText
                            wrapMode: Text.WrapAnywhere
                            text: root.selectedGoal === null ? "" : "Goal: " + root.selectedGoal.goalText
                            color: root.mutedColor
                            font.family: Style.font.family
                            font.pixelSize: Style.font.caption
                        }
                    }

                    WorkbenchOverview {
                        id: overview
                        Layout.fillWidth: true
                        visible: root.destination === "overview" || root.destination === "activity"
                        mode: root.destination
                        projection: root.projection
                        onNavigate: function(value) { root.goTo(value) }
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    WorkbenchGoal {
                        id: goalPage
                        Layout.fillWidth: true
                        visible: root.destination === "goal" || root.destination === "new_goal"
                        mode: root.destination
                        projection: root.projection
                        menuOpen: root.menuOpen
                        goalDraft: root.draftValue(root.goalDraftKey())
                        onDraftChanged: function(value) {
                            if (root.goalDraftKey() !== "") root.saveDraft(root.goalDraftKey(), value)
                        }
                        onToggleMenu: root.menuOpen = !root.menuOpen
                        onChangeProject: root.projectListOpen = !root.projectListOpen
                        onNavigate: function(value) { root.goTo(value) }
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    WorkbenchAssignmentForm {
                        id: assignmentPage
                        Layout.fillWidth: true
                        visible: root.destination === "add_agent" || root.destination === "adoption_review"
                            || root.destination === "assignment"
                        mode: root.destination
                        projection: root.projection
                        selectedObservedSessionId: root.selectedObservedSessionId
                        selectedRole: root.selectedRole
                        selectedAgentRunId: root.selectedAgentRunId
                        selectedCheckId: root.selectedCheckId
                        selectedCheckVersion: root.selectedCheckVersion
                        assignmentDraft: root.assignmentDraft()
                        adoptionDetail: root.adoptionDetail()
                        reviewBlockedReason: root.reviewBlockedReason()
                        onDraftChanged: function(key, value) { if (key !== "") root.saveDraft(key, value) }
                        onNavigate: function(value) { root.goTo(value) }
                        onSelectObserved: function(sessionId) { root.selectObserved(sessionId) }
                        onSelectRole: function(role) { root.selectRole(role) }
                        onSelectAgent: function(runId) { root.selectAgent(runId) }
                        onSelectCheck: function(checkId, version) { root.selectCheck(checkId, version) }
                        onReviewStart: root.captureStartReview()
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    WorkbenchChecks {
                        id: checksPage
                        Layout.fillWidth: true
                        visible: root.destination === "checks"
                        projection: root.projection
                        selectedCheckId: root.selectedCheckId
                        selectedCheckVersion: root.selectedCheckVersion
                        checksDraft: root.draftValue(root.checksDraftKey())
                        onDraftChanged: function(value) { if (root.checksDraftKey() !== "") root.saveDraft(root.checksDraftKey(), value) }
                        onNavigate: function(value) { root.goTo(value) }
                        onSelectCheck: function(checkId, version) { root.selectCheck(checkId, version) }
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    WorkbenchReview {
                        id: reviewPage
                        Layout.fillWidth: true
                        visible: root.destination === "start_review" || root.destination === "work"
                        mode: root.destination
                        projection: root.projection
                        startReview: root.startReview
                        startDetail: root.startDetail()
                        selectedCheck: root.selectedCheck()
                        rows: root.workRows()
                        agents: root.projection && Array.isArray(root.projection.managedAgents)
                            ? root.projection.managedAgents : []
                        truncationNote: root.workTruncationNote()
                        onNavigate: function(value) { root.goTo(value) }
                        onIntentRequested: function(payload) { root.requestConfirmation(payload) }
                    }

                    // Authoritative collection navigation. Every page advertises
                    // its total and adjacent offsets; QML never drops hidden
                    // records or computes admission from a truncated list.
                    Repeater {
                        objectName: "workbench-pages"
                        model: root.projection && root.projection.pages
                            ? Object.keys(root.projection.pages).filter(function(key) {
                                return root.projection.pages[key].total > root.projection.pages[key].limit
                            }) : []
                        delegate: RowLayout {
                            required property string modelData
                            Layout.fillWidth: true
                            readonly property var page: root.projection.pages[modelData]
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                color: root.mutedColor
                                text: modelData + " " + (page.offset + 1) + "–" + Math.min(page.offset + page.limit, page.total) + " / " + page.total
                            }
                            WorkbenchAction {
                                objectName: "workbench-page-previous"
                                text: "Previous"
                                enabled: page.hasPrevious && root.projection.connection === "connected"
                                onClicked: root.emitIntent({ kind: "navigate_page", target: null,
                                    payload: { collection: modelData, offset: page.offset - page.limit } })
                            }
                            WorkbenchAction {
                                objectName: "workbench-page-next"
                                text: "Next"
                                enabled: page.hasNext && root.projection.connection === "connected"
                                onClicked: root.emitIntent({ kind: "navigate_page", target: null,
                                    payload: { collection: modelData, offset: page.offset + page.limit } })
                            }
                        }
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
                        text: root.lastIntentResult === null ? "" : root.lastIntentResult.reasonCode === "fixture_only_no_management"
                            ? "Preview only — no work was created, saved or started."
                            : (({ submitted: "Request sent; awaiting confirmation.", acknowledged: "Change recorded.",
                                 rejected: "Request was not accepted. Check current availability.", unknown: "Outcome unknown. Refresh before trying again.",
                                 stale: "Request is out of date. Review the current state.", expired: "Request expired. Review again." })[root.lastIntentResult.status] || "Request status unavailable.")
                              + (root.lastIntentResult.reasonCode && root.lastIntentResult.status !== "acknowledged"
                                 ? "\nReason: " + root.lastIntentResult.reasonCode : "")
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
