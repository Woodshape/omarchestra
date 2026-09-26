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
    readonly property string loadedVersion: "0.14.0"
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
    property string confirmationAssociation: ""
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

    property string wakeSocket: ""
    WorkbenchWake { id: wake }
    signal intentRequested(var payload)
    onIntentRequested: wake.notify(root.wakeSocket, root.activeSession)

    // The contract/generation check and operation run in one shell invocation.
    // A reloaded instance cannot consume an old view's queue, clear it or hide it.
    function dispatch(encoded) {
        var request = parsePayload(encoded)
        var result = false
        if (request && manifest && manifest.companion
                && Object.keys(request).sort().join(",") === "method,payload,pluginGeneration,pluginId,presentation,protocol,version"
                && request.protocol === manifest.companion.protocol && request.pluginId === manifest.id
                && request.version === loadedVersion && manifest.version === loadedVersion && request.pluginGeneration === pluginGeneration
                && request.presentation === "task-first-v2") {
            if (request.method === "open") result = open(request.payload)
            else if (sessionMatches(request.payload)) {
                if (request.method === "applyProjection") result = applyProjection(request.payload)
                else if (request.method === "takeIntent") result = takeIntent(request.payload)
                else if (request.method === "intentResult") result = intentResult(request.payload)
                else if (request.method === "close" || request.method === "clear") result = clear(request.payload)
                else if (request.method === "heartbeat") result = heartbeat(request.payload)
            }
        }
        return JSON.stringify({ protocol: manifest && manifest.companion ? manifest.companion.protocol : "",
            version: loadedVersion, pluginGeneration: pluginGeneration, result: result })
    }

    function heartbeat(value) {
        if (!projection || projection.connection !== "connected" || projection.revision !== value.revision) return "resnapshot"
        if (!Number.isSafeInteger(value.cursor) || value.cursor < projection.cursor) return false
        // Cursor/liveness only: no replacement of any visible model or binding.
        projection.cursor = value.cursor
        projectionWatchdog.restart()
        return true
    }

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
        assignmentDraft().taskText || "", assignmentDraft().maxCorrections || "1", assignmentDraft().elapsedMs || "900000",
        selectedProject ? selectedProject.contextMatch : false,
        projection && projection.managedAgents ? projection.managedAgents.filter(function(card) { return card.agentRunId === selectedAgentRunId }) : [],
        selectedCheck() ? selectedCheck().digest : null])
    onReviewAssociationChanged: {
        if (startReview !== null && startReview.association !== reviewAssociation) {
            startReview = null
            if (confirmation !== null && confirmation.kind === "start_assignment")
                invalidateConfirmation("The start review changed. Select the current action again.")
        }
    }
    onSelectedObservedSessionIdChanged: checkConfirmationAssociation()
    onSelectedRoleChanged: checkConfirmationAssociation()
    onSelectedAgentRunIdChanged: checkConfirmationAssociation()
    onSelectedCheckIdChanged: checkConfirmationAssociation()
    onSelectedCheckVersionChanged: checkConfirmationAssociation()

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
                    && entry.taskText === startReview.taskText
                    && entry.goalId === projection.selectedGoalId
                    && entry.agentRunId === startReview.agentRunId
                    && entry.gate.gateId === startReview.checkId
                    && entry.gate.version === startReview.checkVersion
                    && entry.maxCorrections === startReview.maxCorrections
                    && entry.elapsedMs === startReview.elapsedMs) return entry
        }
        return null
    }

    function projectedAction(kind, target) {
        if (!projection) return null
        var actions = [].concat(projection.actions || [])
        var agents = projection.managedAgents || []
        for (var i = 0; i < agents.length; i++) actions = actions.concat(agents[i].actions || [])
        for (var j = 0; j < actions.length; j++) {
            if (actions[j].kind === kind && actions[j].target === target) return actions[j]
        }
        return null
    }

    function startConfirmationIntent() {
        var detail = startDetail()
        var action = detail ? projectedAction("start_assignment", detail.agentRunId) : null
        if (!detail || !action || !action.enabled) return null
        return { kind: "start_assignment", target: detail.agentRunId, payload: {
            confirmationId: detail.confirmationId, agentRunId: detail.agentRunId, goalText: detail.goalText,
            taskText: detail.taskText, checkId: detail.gate.gateId, checkVersion: detail.gate.version,
            maxCorrections: detail.maxCorrections, elapsedMs: detail.elapsedMs
        } }
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
        if (confirmation !== null) { invalidateConfirmation(""); return }
        if (menuOpen) { menuOpen = false; return }
        if (projectListOpen) { projectListOpen = false; return }
        if (destination === "overview") return
        destination = parentDestination(destination)
        focusDestination()
    }

    function goTo(value) {
        if (confirmation !== null && value !== destination) invalidateConfirmation("")
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
            version: loadedVersion,
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
            version: loadedVersion,
            pluginGeneration: pluginGeneration,
            presentation: "task-first-v2",
            destinations: ["overview", "goal", "new_goal", "add_agent", "adoption_review",
                "assignment", "checks", "start_review", "work", "activity"]
        })
    }

    // Capture the exact review context without heartbeat-only cursor noise.
    // The runner still validates the submitted immutable target independently.
    function confirmationContext(payload, snapshot) {
        if (!payload || !snapshot || snapshot.connection !== "connected") return ""
        var facts = [snapshot.sessionId, snapshot.pluginGeneration, snapshot.runnerEpoch,
            snapshot.revision, snapshot.selectedProjectId, snapshot.selectedGoalId,
            selectedObservedSessionId, selectedRole, selectedAgentRunId,
            selectedCheckId, selectedCheckVersion, payload.kind, payload.target,
            JSON.stringify(payload.payload)]
        if (payload.kind === "request_adoption") {
            var found = false
            var sessions = snapshot.observedSessions || []
            for (var i = 0; i < sessions.length; i++) {
                var card = sessions[i]
                var choices = card.choices || []
                for (var j = 0; j < choices.length; j++) {
                    var choice = choices[j]
                    if (choice.choiceId !== payload.target) continue
                    facts.push(card.observedSessionId, card.sessionCode, card.lifecycle, card.availability,
                        card.activity, card.health, choice.role, choice.label, choice.enabled, choice.actionKind)
                    found = choice.enabled && (choice.actionKind === undefined || choice.actionKind === "request_adoption")
                }
            }
            if (!found) return ""
        } else {
            // Maintenance actions also bind the displayed committed detail and
            // targeted record. A same-revision replacement is not a heartbeat.
            facts.push(snapshot.details || [])
            if (payload.kind === "start_assignment") {
                var reviewed = root.startDetail()
                var startAction = root.projectedAction("start_assignment", payload.target)
                if (!reviewed || !startAction || !startAction.enabled || reviewed.agentRunId !== payload.target
                        || JSON.stringify(payload) !== JSON.stringify(root.startConfirmationIntent())) return ""
            }
            if (payload.kind === "authorize_adoption") {
                var observed = snapshot.observedSessions || []
                for (var o = 0; o < observed.length; o++) {
                    var offered = observed[o].choices || []
                    for (var c = 0; c < offered.length; c++) {
                        if (offered[c].choiceId === payload.target) facts.push(observed[o])
                    }
                }
            }
            var targets = [].concat(snapshot.managedAgents || [], snapshot.assignments || [], snapshot.retiredRuns || [])
            for (var t = 0; t < targets.length; t++) {
                var item = targets[t]
                if (item.agentRunId === payload.target || item.assignmentId === payload.target
                        || item.runId === payload.target) facts.push(item)
            }
        }
        return JSON.stringify(facts)
    }

    function invalidateConfirmation(reason) {
        if (confirmation === null) return
        confirmationTimer.stop()
        confirmation = null
        confirmationAssociation = ""
        // Changed or expired context disarms the original action button.
    }

    function checkConfirmationAssociation() {
        if (confirmation !== null && confirmationContext(confirmation, projection) !== confirmationAssociation)
            invalidateConfirmation("This exact target or its authority changed. Select the current action again.")
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
        if (projection && JSON.stringify(projection) === JSON.stringify(value)) {
            projectionWatchdog.restart()
            return true
        }
        value = Object.assign({}, value)
        // Even a same-revision replacement may narrow action availability.
        // Never rebind a displayed confirmation or queued click to changed data.
        if (projection && JSON.stringify(projection) !== JSON.stringify(value)) {
            // A cursor-only heartbeat refresh is not a new choice or authority.
            var before = Object.assign({}, projection)
            var after = Object.assign({}, value)
            delete before.cursor
            delete after.cursor
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                // Drop captured clicks/reviews on changed facts, not ordinary
                // disclosure state. Never retain an obsolete execution review.
                pendingIntents = pendingIntents.filter(function(request) { return request.kind === "hide_workbench" })
                if (startReview !== null && startReview.association !== reviewAssociation) startReview = null
                if (after.connection !== "connected") startReview = null
                if (before.sessionId !== after.sessionId || before.pluginGeneration !== after.pluginGeneration
                        || before.runnerEpoch !== after.runnerEpoch || before.selectedProjectId !== after.selectedProjectId
                        || before.selectedGoalId !== after.selectedGoalId || after.connection !== "connected") {
                    menuOpen = false
                    lastIntentResult = null
                }
            } else {
                projection.cursor = value.cursor
                projectionWatchdog.restart()
                return true
            }
            if (confirmation !== null && confirmationContext(confirmation, value) !== confirmationAssociation)
                invalidateConfirmation("This exact target or its authority changed. Select the current action again.")
        }
        // Preserve equal subtrees too: unrelated Activity/cursor updates must
        // not replace every array-backed delegate in the dock.
        if (projection) {
            var stable = Object.assign({}, value)
            Object.keys(stable).forEach(function(key) {
                if (JSON.stringify(projection[key]) === JSON.stringify(stable[key])) stable[key] = projection[key]
            })
            value = stable
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
        invalidateConfirmation("Connection lost. Wait for the current state and select the action again.")
        pendingIntents = pendingIntents.filter(function(request) { return request.kind === "hide_workbench" })
        lastIntentResult = null
        startReview = null
    }

    function open(payloadJson) {
        var envelope = parsePayload(payloadJson)
        var session = sessionFrom(envelope)
        if (!envelope || !session
                || session.pluginGeneration !== pluginGeneration
                || typeof session.sessionId !== "string") return false
        var value = envelope.projection
        if (activeSession !== null && !sessionMatches(envelope)) invalidateConfirmation("")
        if (!applyProjection(value)) return false
        pendingIntents = []
        activeSession = ({
            sessionId: session.sessionId,
            pluginGeneration: session.pluginGeneration
        })
        wakeSocket = typeof envelope.wakeSocket === "string" && envelope.wakeSocket.length <= 1024 ? envelope.wakeSocket : ""
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
        wakeSocket = ""
        wake.reset()
        pendingGoalNavigation = ""
        invalidateConfirmation("")
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
        wakeSocket = ""
        wake.reset()
        pendingGoalNavigation = ""
        projection = null
        invalidateConfirmation("")
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
        if (activeSession === null) return
        // Hide locally now. Discard only not-yet-read view clicks; accepted
        // runner commands keep their own outcome. Retain the session until the
        // Owner's guarded clear, and never let a heartbeat reopen this surface.
        opened = false
        invalidateConfirmation("")
        var request = { kind: "hide_workbench", target: null, payload: {} }
        pendingIntents = [request]
        root.intentRequested(request)
    }

    function requestConfirmation(payload) {
        if (!projection || projection.connection !== "connected") return
        if (payload.kind === "select_goal") { invalidateConfirmation(""); selectGoal(payload.target); return }
        // Non-destructive declarations retain their existing single-click path.
        if (["present", "select_project", "create_goal", "configure_checks", "inspect_project",
                "confirm_register_project", "create_check", "authorize_adoption"].indexOf(payload.kind) >= 0) {
            invalidateConfirmation("")
            emitIntent(payload)
            return
        }
        var association = confirmationContext(payload, projection)
        if (!association) { invalidateConfirmation("Unavailable"); return }
        if (confirmation !== null && confirmationAssociation === association
                && JSON.stringify(confirmation) === JSON.stringify(payload)) {
            var pending = confirmation
            invalidateConfirmation("")
            emitIntent(pending)
            return
        }
        invalidateConfirmation("")
        confirmationAssociation = association
        confirmation = payload
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

    function currentGoalContextMatches() {
        return projection !== null && typeof projection.selectedProject === "object"
            && projection.selectedProject !== null && projection.selectedProject.contextMatch === true
    }

    function captureStartReview() {
        if (!projection || projection.connection !== "connected" || !currentGoalContextMatches()) return false
        if (!selectedAgentRunId || !selectedCheckId) return false
        var action = projectedAction("prepare_start_review", selectedAgentRunId)
        var check = checkById(selectedCheckId, selectedCheckVersion)
        var draft = assignmentDraft()
        var taskText = (draft.taskText || "").trim()
        var maxCorrectionsText = String(draft.maxCorrections === undefined ? "1" : draft.maxCorrections)
        var elapsedText = String(draft.elapsedMs === undefined ? "900000" : draft.elapsedMs)
        if (!action || !action.enabled || !check || check.availability !== "available" || taskText === "") return false
        if (!/^(0|[1-3])$/.test(maxCorrectionsText) || !/^[0-9]+$/.test(elapsedText)) return false
        var maxCorrections = Number(maxCorrectionsText), elapsedMs = Number(elapsedText)
        if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 1000 || elapsedMs > 3600000) return false
        startReview = ({ checkId: check.checkId, checkVersion: check.version, agentRunId: selectedAgentRunId,
            taskText: taskText, maxCorrections: maxCorrections, elapsedMs: elapsedMs, association: reviewAssociation })
        destination = "start_review"
        focusDestination()
        emitIntent({ kind: "prepare_start_review", target: selectedAgentRunId, payload: {
            checkId: check.checkId, checkVersion: check.version, taskText: taskText,
            maxCorrections: maxCorrections, elapsedMs: elapsedMs
        } })
        return true
    }

    function reviewAvailable() {
        if (!projection || projection.connection !== "connected" || !currentGoalContextMatches()) return false
        if (!projection.managedAgents.some(function(card) { return card.agentRunId === root.selectedAgentRunId })) return false
        if (!selectedAgentRunId || !selectedCheckId) return false
        var check = checkById(selectedCheckId, selectedCheckVersion)
        return check !== null && check.availability === "available"
    }

    function reviewBlockedReason() {
        if (!projection || projection.connection !== "connected") return "Waiting for an authoritative projection."
        if (!selectedAgentRunId || !projection.managedAgents.some(function(card) { return card.agentRunId === root.selectedAgentRunId })) return "Choose a current target agent."
        if (!currentGoalContextMatches()) return "Every current Run in this Goal must be ready and report this Project root on a fresh bridge. Omarchestra will not change Pi's working directory."
        var startAction = projectedAction("prepare_start_review", selectedAgentRunId)
        if (!startAction || !startAction.enabled) return startAction && startAction.reason ? startAction.reason : "Start review is unavailable for this Run."
        if ((assignmentDraft().taskText || "").trim() === "") return "Describe the task before reviewing start."
        var draft = assignmentDraft()
        var corrections = String(draft.maxCorrections === undefined ? "1" : draft.maxCorrections)
        var elapsed = Number(draft.elapsedMs === undefined ? "900000" : draft.elapsedMs)
        if (!/^(0|[1-3])$/.test(corrections) || !Number.isSafeInteger(elapsed) || elapsed < 1000 || elapsed > 3600000) return "Set corrections to 0–3 and elapsed time to 1000–3600000 ms."
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
            + "\nGoal: " + detail.goalText + "\nTask: " + detail.taskText + "\nNode: " + detail.executionNodeId + "\nGit context: " + detail.gitCommonDir + " · HEAD " + detail.headOid
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
        if (confirmation !== null) { invalidateConfirmation(""); event.accepted = true; return }
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
            onTriggered: root.invalidateConfirmation("Expired")
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
                            Text {
                                objectName: "workbench-version"
                                visible: root.manifest !== null && typeof root.manifest.version === "string"
                                text: visible ? "v" + root.manifest.version : ""
                                textFormat: Text.PlainText
                                color: root.mutedColor
                                font.family: Style.font.family
                                font.pixelSize: Style.font.caption
                                Accessible.name: visible ? "Workbench version " + root.manifest.version : ""
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
                        armedConfirmation: root.confirmation
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
                        armedConfirmation: root.confirmation
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
                        armedConfirmation: root.confirmation
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
                        startIntent: root.startConfirmationIntent()
                        selectedCheck: root.selectedCheck()
                        rows: root.workRows()
                        agents: root.projection && Array.isArray(root.projection.managedAgents)
                            ? root.projection.managedAgents : []
                        truncationNote: root.workTruncationNote()
                        armedConfirmation: root.confirmation
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
