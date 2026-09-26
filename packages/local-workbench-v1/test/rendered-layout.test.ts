import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { journeyFixture, JOURNEY_AGENT_RUN_ID, JOURNEY_CHECK_ID } from '../fixtures/journey.ts'
import { gateFailScenario } from '../fixtures/scenarios.ts'
import { WorkbenchAdapter } from '../console/live-projection-adapter.ts'
import { prepareQtFixture } from './qt-fixture.ts'

/** Controls that must never appear in the New Team Goal destination. */
// The gate passes the resolved binary through the environment so its
// availability check and this spawn cannot disagree.
const QT_RUNNER = process.env.QT_BIN || '/usr/lib/qt6/bin/qmltestrunner'

const FORBIDDEN_IN_GOAL_FORM = [
  'Acceptance check', 'Executable', 'argv', 'Environment', 'Timeout', 'Target agent',
  'Prepare assignment', 'Corrections',
]

/** Every destination the presentation contract advertises. */
const JOURNEY_DESTINATIONS = [
  'overview', 'new_goal', 'goal', 'add_agent', 'assignment', 'checks',
  'start_review', 'work', 'activity',
]

// Actual child components, Qt Quick Controls, layout and input. Theme, native
// surface and notification leaf are stand-ins; presentation-wake tests exercise
// the real Quickshell leaf/client separately. Never import the installed shell.
test('offscreen Qt renders the normal journey with literal text, keyboard editing and fixed geometry', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'workbench-qt-'))
  const put = (path: string, text: string) => { writeFileSync(join(scratch, path), text) }
  try {
    prepareQtFixture(scratch, true)
    put('tst_workbench.qml', `import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtTest
import "view"
Item {
  id: host
  width: 800; height: 900
  property var snapshot: ${JSON.stringify(journeyFixture)}
  property var failure: ${JSON.stringify(gateFailScenario)}
  WorkbenchOverview { id: pageOverview; width: 336; projection: host.snapshot; visible: false }
  WorkbenchGoal { id: pageGoal; width: 336; projection: host.snapshot; mode: "new_goal"; visible: false }
  WorkbenchAssignmentForm {
    id: pageAssignment; width: 336; projection: host.snapshot; mode: "assignment"
    selectedAgentRunId: "${JOURNEY_AGENT_RUN_ID}"; selectedCheckId: "${JOURNEY_CHECK_ID}"; selectedCheckVersion: 3
    assignmentDraft: ({ taskText: "run the parser test suite" }); reviewBlockedReason: ""; visible: false
  }
  WorkbenchChecks { id: pageChecks; width: 336; projection: host.snapshot; visible: false }
  WorkbenchReview {
    id: pageReview; width: 336; projection: host.snapshot; mode: "start_review"
    startReview: ({ taskText: "run the parser test suite" })
    startDetail: host.snapshot.details[1]; selectedCheck: host.snapshot.checks[0]
    truncationNote: "Showing the first 8 of 11 committed Assignments. The remainder stays in Activity."
    visible: false
  }
  WorkbenchHost { id: consoleView }
  TestCase {
    name: "WorkbenchJourney"; when: windowShown

    function visibleTexts(item, out) {
      if (!item.visible) return
      if (item.text !== undefined && item.textFormat !== undefined && String(item.text).length > 0) out.push(String(item.text))
      for (var i = 0; i < item.children.length; i++) visibleTexts(item.children[i], out)
    }
    function buttonWithText(item, value) {
      // Local wrappers retain Qt's down property, independent of style/class name.
      // Only a visible control can receive a synthesized click.
      if (item.visible && item.text === value && item.down !== undefined) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = buttonWithText(item.children[i], value)
        if (found !== null) return found
      }
      return null
    }
    function buttonWithTextPrefix(item, prefix) {
      if (item.visible && item.text !== undefined && item.text.indexOf(prefix) === 0 && item.down !== undefined) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = buttonWithTextPrefix(item.children[i], prefix)
        if (found !== null) return found
      }
      return null
    }
    function buttonsWithText(item, value, out) {
      if (item.visible && item.text === value && item.down !== undefined) out.push(item)
      for (var i = 0; i < item.children.length; i++) buttonsWithText(item.children[i], value, out)
      return out
    }
    function visualNamed(item, name) {
      if (item.objectName === name) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = visualNamed(item.children[i], name)
        if (found !== null) return found
      }
      return null
    }
    function panel() { return findChild(consoleView, "workbench-panel") }
    // The panel scrolls, so a control below the viewport must be revealed by
    // focus before a synthesized click can land on it.
    function clickItem(item) {
      verify(item !== null, "control exists")
      item.forceActiveFocus()
      wait(20)
      mouseClick(item)
      wait(20)
    }
    // The panel is a real Window, so its item tree starts at contentItem.
    function surfaceRoot() {
      var surface = panel()
      return surface && surface.contentItem ? surface.contentItem : surface
    }
    // Qt runs test functions in name order, so every test establishes the
    // authoritative projection it needs instead of inheriting one.
    function useRunnerProjectContext() {
      var value = JSON.parse(JSON.stringify(host.snapshot))
      for (var i = 0; i < value.projects.length; i++) {
        if (value.projects[i].projectId === value.selectedProjectId) {
          value.selectedProject = value.projects[i]
          break
        }
      }
      host.snapshot = value
    }
    function openJourney() {
      consoleView.close()
      consoleView.pluginGeneration = host.snapshot.pluginGeneration
      verify(consoleView.open({ session: host.snapshot, projection: host.snapshot }), "journey projection opens")
      consoleView.goTo("overview")
      panel().requestActivate()
      wait(20)
    }
    function openFailure() {
      consoleView.close()
      consoleView.pluginGeneration = host.failure.pluginGeneration
      verify(consoleView.open({ session: host.failure, projection: host.failure }), "failure projection opens")
      panel().requestActivate()
      wait(20)
    }

    function test_sessionCodesMatchRowsAndChangedCodeDisarmsTheOriginalButton() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot))
      updated.revision += 1
      updated.managedAgents[0].sessionCode = "BEEF-1234"
      updated.observedSessions[0].sessionCode = "AAAA-1111"
      var second = JSON.parse(JSON.stringify(updated.observedSessions[0]))
      second.observedSessionId = "second-observed"
      second.sessionCode = "BBBB-2222"
      second.choices[0].choiceId = "second-choice"
      updated.observedSessions.push(second)
      verify(consoleView.applyProjection(updated)); wait(30)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf("Pi AAAA-1111 · " + updated.observedSessions[0].activity) >= 0)
      verify(texts.indexOf("Pi BBBB-2222 · " + second.activity) >= 0)
      verify(texts.indexOf("Pi BEEF-1234 · " + updated.managedAgents[0].role + " · " + updated.managedAgents[0].piStatus) >= 0)
      var label = updated.observedSessions[0].choices[0].label
      clickItem(buttonsWithText(surfaceRoot(), label, [])[0])
      compare(consoleView.takeIntent(updated), "")
      verify(buttonWithText(surfaceRoot(), "Confirm: " + label) !== null)
      // Even a same-revision replacement of the visible identity must disarm.
      updated = JSON.parse(JSON.stringify(updated))
      updated.observedSessions[0].sessionCode = "CCCC-3333"
      verify(consoleView.applyProjection(updated)); wait(30)
      verify(buttonWithText(surfaceRoot(), "Confirm: " + label) === null)
      clickItem(buttonsWithText(surfaceRoot(), label, [])[0])
      compare(consoleView.takeIntent(updated), "", "new identity only re-arms")
      consoleView.goTo("add_agent"); wait(30)
      verify(buttonWithTextPrefix(surfaceRoot(), "Pi CCCC-3333") !== null)
      verify(buttonWithTextPrefix(surfaceRoot(), "Pi BBBB-2222") !== null)
      consoleView.goTo("assignment"); wait(30)
      verify(buttonWithTextPrefix(surfaceRoot(), "Pi BEEF-1234") !== null)
      consoleView.goTo("overview")
      updated = JSON.parse(JSON.stringify(updated)); updated.revision += 1
      updated.observedSessions[0].sessionCode = null
      verify(consoleView.applyProjection(updated)); wait(30)
      texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf("Session code unavailable · " + updated.observedSessions[0].activity) >= 0)
    }

    function test_observedActivityAndIneligibilityAreVisibleWithoutPopups() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot))
      var idle = updated.observedSessions[0]
      var busy = JSON.parse(JSON.stringify(idle))
      busy.observedSessionId = "busy-session"
      busy.activity = "busy"
      busy.adoptionReasonCode = "session_busy"
      busy.adoptionReason = "Adoption unavailable: Pi reports busy; wait until it is idle."
      busy.choices = []
      updated.observedSessions = [busy, idle]
      updated.revision += 1
      verify(consoleView.applyProjection(updated))
      wait(30)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.some(function(s) { return s.indexOf(" · busy") >= 0 }), texts.join("|"))
      verify(texts.some(function(s) { return s.indexOf(" · idle") >= 0 }), texts.join("|"))
      verify(!texts.some(function(s) { return s.indexOf(" · healthy") >= 0 }), "normal health is not repeated chrome")
      verify(texts.indexOf(busy.adoptionReason) >= 0, "runner reason is always visible")
      compare(buttonsWithText(surfaceRoot(), idle.choices[0].label, []).length, 1)
      compare(consoleView.takeIntent(updated), "", "projection never emits Adoption")
      consoleView.goTo("add_agent"); wait(30)
      texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf(busy.adoptionReason) >= 0, "Add agent shows the same reason")
      consoleView.goTo("overview")
      updated = JSON.parse(JSON.stringify(updated)); updated.revision += 1
      updated.observedSessions[0].activity = "idle"
      updated.observedSessions[0].adoptionReason = null
      updated.observedSessions[0].adoptionReasonCode = null
      updated.observedSessions[0].choices = [Object.assign({}, idle.choices[0], {choiceId: "fresh-choice"})]
      verify(consoleView.applyProjection(updated)); wait(30)
      compare(buttonsWithText(surfaceRoot(), idle.choices[0].label, []).length, 2)
      texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf(busy.adoptionReason) < 0, "obsolete reason is removed")
    }

    function test_stableAgentRowsSurviveChangedFactsAndReorderButNotReplacement() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot))
      updated.observedSessions[0].sessionCode = "AAAA-1111"
      var second = JSON.parse(JSON.stringify(updated.observedSessions[0]))
      second.observedSessionId = "second-observed"; second.sessionCode = "BBBB-2222"
      second.choices = []
      updated.observedSessions.push(second)
      verify(consoleView.applyProjection(updated)); wait(20)
      var originalProjection = consoleView.projection
      verify(consoleView.applyProjection(JSON.stringify(updated)))
      verify(consoleView.projection === originalProjection, "identical heartbeat does not replace the visible projection")
      var agent = visualNamed(surfaceRoot(), "workbench-managed-show-pane")
      var menu = visualNamed(surfaceRoot(), "workbench-agent-actions")
      var observed = buttonWithTextPrefix(surfaceRoot(), "Pi AAAA-1111")
      var details = visualNamed(surfaceRoot(), "workbench-observed-details")
      clickItem(menu); clickItem(details)
      verify(menu.highlighted); verify(details.highlighted)
      updated = JSON.parse(JSON.stringify(updated))
      updated.managedAgents[0].lastEvent = "new bounded event"
      updated.observedSessions[0].activity = "busy"
      updated.observedSessions.reverse()
      verify(consoleView.applyProjection(updated)); wait(30)
      verify(agent === visualNamed(surfaceRoot(), "workbench-managed-show-pane"))
      verify(observed === buttonWithTextPrefix(surfaceRoot(), "Pi AAAA-1111"))
      verify(menu.highlighted, "event update does not collapse actions")
      verify(details.highlighted, "activity/reorder does not collapse details")
      verify(details.activeFocus, "keyboard focus survives row updates")
      updated = JSON.parse(JSON.stringify(updated))
      updated.observedSessions[1].observedSessionId = "replacement-observed"
      verify(consoleView.applyProjection(updated)); wait(30)
      verify(observed !== buttonWithTextPrefix(surfaceRoot(), "Pi AAAA-1111"), "equal display code is not row identity")
      consoleView.goTo("add_agent"); wait(20)
      var picker = buttonWithTextPrefix(surfaceRoot(), "Pi AAAA-1111")
      clickItem(picker)
      updated = JSON.parse(JSON.stringify(updated)); updated.observedSessions[1].health = "degraded"
      verify(consoleView.applyProjection(updated)); wait(20)
      verify(picker === buttonWithTextPrefix(surfaceRoot(), "Pi AAAA-1111"))
      verify(picker.activeFocus, "Add agent picker preserves focus too")
      consoleView.goTo("assignment"); wait(20)
      var targetText = (updated.managedAgents[0].sessionCode ? "Pi " + updated.managedAgents[0].sessionCode : "Session code unavailable")
      var target = buttonWithTextPrefix(surfaceRoot(), targetText)
      clickItem(target)
      updated = JSON.parse(JSON.stringify(updated)); updated.managedAgents[0].lastEvent = "another bounded event"
      verify(consoleView.applyProjection(updated)); wait(20)
      verify(target === buttonWithTextPrefix(surfaceRoot(), targetText))
      verify(target.activeFocus, "Assignment target picker preserves focus too")
      updated = JSON.parse(JSON.stringify(updated)); updated.sessionId = "replacement-projection-session"
      verify(consoleView.open({session: updated, projection: updated})); wait(20)
      verify(target !== buttonWithTextPrefix(surfaceRoot(), targetText), "new Projection Session resets row-local state")
    }

    function test_compactRowsShowSharedProjectBlockerOncePerDestination() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot))
      var first = updated.observedSessions[0]
      first.sessionCode = "AAAA-1111"; first.choices = []
      first.adoptionReasonCode = "project_context_unavailable"
      first.adoptionReason = "Adoption unavailable: the selected Project context is unavailable."
      first.terminalNavigation = { target: "nav-a", enabled: true, state: "idle", reason: "Checked navigation, not atomic focus." }
      var second = JSON.parse(JSON.stringify(first))
      second.observedSessionId = "second-observed"; second.sessionCode = "BBBB-2222"
      updated.observedSessions.push(second)
      verify(consoleView.applyProjection(updated)); wait(30)
      for (var destination of ["overview", "add_agent"]) {
        consoleView.goTo(destination); wait(20)
        var texts = []; visibleTexts(surfaceRoot(), texts)
        compare(texts.filter(function(s) { return s === first.adoptionReason }).length, 1)
        verify(!texts.some(function(s) { return s.indexOf("connection available") >= 0 || s.indexOf(" · healthy") >= 0 }))
        verify(texts.indexOf("Pi AAAA-1111 · " + first.activity) >= 0)
        verify(texts.indexOf("Pi BBBB-2222 · " + second.activity) >= 0)
        verify(texts.indexOf(first.terminalNavigation.reason) < 0, "no permanent navigation disclaimer")
      }
    }

    function test_guardedDispatchRejectsLoadedIdentityDriftBeforeConsumingOrHiding() {
      openJourney()
      consoleView.manifest = { id: "omarchestra.agent-console", version: "0.14.0", companion: { protocol: "omarchestra.companion/v1" } }
      consoleView.pendingIntents = [{kind: "hide_workbench", target: null, payload: {}}]
      var request = { protocol: "omarchestra.companion/v1", pluginId: "omarchestra.agent-console", version: "0.14.0",
        presentation: "task-first-v2", pluginGeneration: host.snapshot.pluginGeneration, method: "takeIntent",
        payload: { sessionId: host.snapshot.sessionId, pluginGeneration: host.snapshot.pluginGeneration } }
      for (var field of ["protocol", "pluginId", "version", "presentation", "pluginGeneration"]) {
        var wrong = JSON.parse(JSON.stringify(request)); wrong[field] = "wrong"
        compare(JSON.parse(consoleView.dispatch(JSON.stringify(wrong))).result, false)
        compare(consoleView.pendingIntents.length, 1)
      }
      var wrongSession = JSON.parse(JSON.stringify(request)); wrongSession.payload.sessionId = "old-session"; wrongSession.method = "close"
      compare(JSON.parse(consoleView.dispatch(wrongSession)).result, false)
      compare(consoleView.opened, true)
      var pulse = Object.assign({}, request, {method: "heartbeat", payload: Object.assign({}, request.payload, {revision: host.snapshot.revision, cursor: host.snapshot.cursor + 1})})
      var original = consoleView.projection
      compare(JSON.parse(consoleView.dispatch(pulse)).result, true)
      verify(consoleView.projection === original)
      compare(consoleView.pendingIntents.length, 1)
      compare(JSON.parse(JSON.parse(consoleView.dispatch(request)).result).kind, "hide_workbench")
      consoleView.markPresentationStale()
      compare(JSON.parse(consoleView.dispatch(pulse)).result, "resnapshot", "heartbeat alone cannot revive stale data")
      compare(consoleView.projection.connection, "stale")
      request.method = "close"
      consoleView.manifest = Object.assign({}, consoleView.manifest, {version: "0.15.0"})
      request.version = "0.15.0"
      compare(JSON.parse(consoleView.dispatch(request)).result, false, "manifest refresh cannot relabel old loaded code")
      compare(JSON.parse(consoleView.capabilities()).version, "0.14.0")
      request.version = "0.14.0"
      consoleView.manifest = Object.assign({}, consoleView.manifest, {version: "0.14.0"})
      compare(JSON.parse(consoleView.dispatch(request)).result, true)
      compare(consoleView.opened, false)
    }

    function test_showTerminalPaneUsesOneClickAndOnlyRunnerTicketWithHonestResults() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot)); updated.revision += 1
      updated.observedSessions[0].terminalNavigation = { target: "navigate-observed", enabled: true, state: "idle", reason: "Checked navigation, not atomic focus." }
      updated.managedAgents[0].terminalNavigation = { target: "navigate-managed", enabled: true, state: "idle", reason: "Checked navigation, not atomic focus." }
      verify(consoleView.applyProjection(updated)); wait(30)
      for (var kind of ["observed", "managed"]) {
        clickItem(visualNamed(surfaceRoot(), "workbench-" + kind + "-show-pane"))
        var request = JSON.parse(consoleView.takeIntent(updated))
        compare(request.kind, "present"); compare(request.target, "navigate-" + kind)
        compare(Object.keys(request.payload).length, 0)
        compare(consoleView.takeIntent(updated), "", "no Adoption or second action")
      }
      updated = JSON.parse(JSON.stringify(updated))
      updated.observedSessions[0].terminalNavigation = { target: "navigate-observed", enabled: false, state: "checking", reason: "Checking terminal navigation…" }
      verify(consoleView.applyProjection(updated)); wait(30)
      compare(visualNamed(surfaceRoot(), "workbench-observed-show-pane").enabled, false)
      updated = JSON.parse(JSON.stringify(updated))
      updated.observedSessions[0].terminalNavigation = { target: "navigate-observed", enabled: true, state: "unknown", reason: "Navigation could not be verified; focus may have changed." }
      verify(consoleView.applyProjection(updated)); wait(30)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf("Focus unverified — it may have changed") >= 0)
      compare(consoleView.takeIntent(updated), "", "unknown does not retry")
      updated = JSON.parse(JSON.stringify(updated)); updated.connection = "disconnected"
      verify(consoleView.applyProjection(updated)); wait(30)
      compare(visualNamed(surfaceRoot(), "workbench-observed-show-pane").enabled, false)
    }

    function test_closeDockSendsPresentationOnlyRequest() {
      openJourney()
      consoleView.emitIntent({kind: "inspect_project", target: null, payload: {path: "/unsent"}})
      clickItem(findChild(consoleView, "workbench-close"))
      var changed = JSON.parse(JSON.stringify(host.snapshot)); changed.revision += 1
      verify(consoleView.applyProjection(changed))
      consoleView.markPresentationStale()
      var request = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(request.kind, "hide_workbench")
      compare(request.target, null)
      compare(Object.keys(request.payload).length, 0)
      compare(consoleView.opened, false, "Close hides locally without waiting for any IPC")
      compare(consoleView.takeIntent(host.snapshot), "", "only unsent clicks were discarded")
      verify(consoleView.applyProjection(host.snapshot))
      compare(consoleView.opened, false, "heartbeat cannot reopen a locally closed view")
    }

    function test_encodedProjectionUpdateUsesTheRealShellArgumentFormat() {
      openJourney()
      var updated = JSON.parse(JSON.stringify(host.snapshot))
      updated.revision += 1
      verify(consoleView.applyProjection(JSON.stringify(updated)), "encoded shell update is accepted")
      compare(consoleView.projection.revision, updated.revision)
      verify(!consoleView.applyProjection('{bad json'), "malformed shell update is rejected")
    }

    function test_zzSameRevisionReviewInvalidation() {
      useRunnerProjectContext()
      openJourney()
      consoleView.selectAgent("${JOURNEY_AGENT_RUN_ID}")
      consoleView.selectCheck("${JOURNEY_CHECK_ID}", 3)
      consoleView.saveDraft(consoleView.assignmentKey(), JSON.stringify({taskText:host.snapshot.details[1].goalText}))
      verify(consoleView.captureStartReview())
      var changed = JSON.parse(JSON.stringify(host.snapshot))
      changed.checks[0].digest = "b".repeat(64)
      verify(consoleView.applyProjection(changed))
      wait(20)
      compare(consoleView.startReview, null)
      compare(consoleView.assignmentDraft().taskText, host.snapshot.details[1].goalText)
      verify(consoleView.captureStartReview())
      compare(consoleView.startDetail(), null, "changed digest must not borrow an old resolved proposal")
    }
    function test_zzUnavailableCreate() {
      openJourney()
      var changed = JSON.parse(JSON.stringify(host.snapshot))
      changed.actions = changed.actions.map(function(a) { return Object.assign({}, a, {enabled:false, reason:"unavailable", reasonCode:"unavailable"}) })
      verify(consoleView.applyProjection(changed))
      consoleView.goTo("new_goal")
      findChild(consoleView, "workbench-goal-text").text = "Example goal"
      wait(20)
      compare(findChild(consoleView, "workbench-create-goal").enabled, false)
      verify(consoleView.applyProjection(host.snapshot))
      findChild(consoleView, "workbench-goal-text").text = "😀".repeat(2049)
      wait(20)
      compare(findChild(consoleView, "workbench-create-goal").enabled, false, "UTF-8 byte bound, not just character count")
    }
    function test_zzProjectIntentTransport() {
      openJourney()
      consoleView.goTo("new_goal")
      clickItem(buttonWithText(surfaceRoot(), "Change Project"))
      compare(consoleView.projectListOpen, true)
      compare(consoleView.destination, "new_goal")
      consoleView.selectProject(host.snapshot.selectedProjectId)
      verify(consoleView.takeIntent(host.snapshot) !== "", "project click reaches native polling")
    }
    function test_advancedCheckDraft() {
      openJourney()
      consoleView.selectCheck("${JOURNEY_CHECK_ID}", 3)
      consoleView.goTo("checks")
      wait(20)
      var advanced = findChild(consoleView, "workbench-check-advanced")
      compare(advanced.text, "Advanced definition")
      clickItem(advanced)
      var executable = visualNamed(surfaceRoot(), "check-field-executable")
      verify(executable !== null, "expanded executable editor exists")
      verify(executable.visible)
      compare(executable.text, "/usr/bin/node")
      executable.text = "relative"
      wait(20)
      compare(findChild(consoleView, "workbench-save-check").enabled, false)
      executable.text = "/usr/bin/node"
      var argv = visualNamed(surfaceRoot(), "check-field-argv")
      argv.text = "--test"
      argv.forceActiveFocus(); wait(20); keyClick(Qt.Key_Tab)
      verify(!argv.activeFocus)
      clickItem(findChild(consoleView, "workbench-save-check"))
      var request = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(request.kind, "configure_checks")
      compare(request.payload.definitionDraft.executable, "/usr/bin/node")
      compare(request.payload.definitionDraft.argv[0], "--test")
      console.log("CAPTURED_INTENT " + JSON.stringify(request))
      compare(consoleView.confirmation, null, "saving configuration is not starting execution")
    }

    function test_journeyOverview() {
      verify(consoleView.pluginGeneration > 0 && consoleView.pluginGeneration <= 9007199254740991)
      openJourney()
      var texts = []; visibleTexts(surfaceRoot(), texts)
      var joined = texts.join("\\n")
      verify(joined.indexOf("Preview · staged fixture — no real work") >= 0)
      verify(joined.indexOf("Project: /home/user/work/omarchestra") >= 0)
      verify(joined.indexOf("Goal: Ship the parser fix") >= 0)
      verify(joined.indexOf("New Team Goal") >= 0)
      verify(joined.indexOf("No assignment is running for this agent.") < 0)
      var menu = visualNamed(surfaceRoot(), "workbench-agent-actions")
      verify(menu !== null)
      clickItem(menu)
      var expanded = []; visibleTexts(surfaceRoot(), expanded)
      verify(expanded.join("\\n").indexOf("No assignment is running for this agent.") >= 0)
      var unavailable = buttonWithText(surfaceRoot(), "Take control")
      verify(unavailable !== null)
      compare(unavailable.enabled, false)
      menu.forceActiveFocus()
      keyClick(Qt.Key_Escape)
      wait(20)
      compare(consoleView.destination, "overview")
      verify(menu.activeFocus)
      verify(buttonWithText(surfaceRoot(), "Take control") === null)
      var primary = findChild(consoleView, "workbench-new-goal")
      verify(primary.width < pageOverview.width)
      primary.forceActiveFocus()
      wait(20)
      verify(primary.activeFocus)
      if (${JSON.stringify(process.env.WORKBENCH_VISUAL_EVIDENCE || '')} !== "") {
        var overviewImage = grabImage(surfaceRoot())
        overviewImage.save(${JSON.stringify(process.env.WORKBENCH_VISUAL_EVIDENCE || '')})
      }
      verify(joined.indexOf("pi-a1b2") >= 0)
      verify(joined.indexOf("Add agent") >= 0)
      verify(joined.indexOf("Prepare assignment") >= 0)
      verify(joined.indexOf("Work and result") >= 0)
      verify(joined.indexOf("Board backend is not available in this slice.") >= 0)
      var board = findChild(consoleView, "workbench-board")
      verify(board !== null)
      compare(board.enabled, false)
    }

    function test_newGoalHasNoAssignmentControls() {
      openJourney()
      consoleView.goTo("new_goal")
      wait(20)
      compare(consoleView.destination, "new_goal")
      var texts = []; visibleTexts(surfaceRoot(), texts)
      var joined = texts.join("\\n")
      verify(joined.indexOf("New Team Goal") >= 0)
      verify(joined.indexOf("Project: /home/user/work/omarchestra") >= 0)
      var forbidden = ${JSON.stringify(FORBIDDEN_IN_GOAL_FORM)}
      for (var i = 0; i < forbidden.length; i++) {
        verify(joined.indexOf(forbidden[i]) < 0, "New Team Goal must not offer " + forbidden[i])
      }
      var editor = findChild(consoleView, "workbench-goal-text")
      var create = findChild(consoleView, "workbench-create-goal")
      verify(editor !== null && create !== null)
      compare(create.enabled, false)
      editor.text = ""
      editor.forceActiveFocus()
      wait(10)
      keyClick(Qt.Key_X)
      compare(editor.text, "x")
      keyClick(Qt.Key_Tab)
      verify(!editor.activeFocus, "Tab moves focus out of the multiline Goal editor")
      wait(20)
      compare(create.enabled, true)
      mouseClick(create)
      wait(20)
      compare(consoleView.confirmation, null)
      var request = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(request.kind, "create_goal")
      compare(request.target, null)
      console.log("CAPTURED_INTENT " + JSON.stringify(request))
      compare(request.payload.projectId, host.snapshot.selectedProjectId)
      compare(consoleView.pendingIntents.length, 0)
    }

    function test_assignmentContextRequiresFreshRunnerMatch() {
      var previousSnapshot = host.snapshot
      useRunnerProjectContext()
      openJourney()
      consoleView.goTo("assignment")
      wait(20)
      consoleView.selectAgent("${JOURNEY_AGENT_RUN_ID}")
      consoleView.selectCheck("${JOURNEY_CHECK_ID}", 3)
      var task = findChild(consoleView, "workbench-assignment-task")
      task.text = host.snapshot.details[1].taskText
      wait(20)
      var status = findChild(surfaceRoot(), "workbench-assignment-context-status")
      verify(status !== null && status.visible)
      verify(status.text.indexOf("Every current Run in this Goal is ready") === 0)
      var start = findChild(consoleView, "workbench-start-review")
      verify(start.enabled)
      verify(consoleView.captureStartReview(), consoleView.reviewBlockedReason())
      compare(consoleView.destination, "start_review")
      var reviewStatus = findChild(surfaceRoot(), "workbench-start-context-status")
      verify(reviewStatus !== null && reviewStatus.visible)
      verify(reviewStatus.text.indexOf("Project context matches:") === 0)

      var unavailable = JSON.parse(JSON.stringify(host.snapshot))
      unavailable.revision += 1
      unavailable.selectedProject.contextMatch = false
      unavailable.projects[0].contextMatch = false
      verify(consoleView.applyProjection(unavailable))
      wait(20)
      verify(reviewStatus.text.indexOf("Project context does not match or is unavailable") === 0)
      verify(consoleView.reviewBlockedReason().indexOf("Every current Run in this Goal") >= 0)
      consoleView.goTo("assignment")
      wait(20)
      var currentStatus = findChild(surfaceRoot(), "workbench-assignment-context-status")
      var blockedStart = findChild(consoleView, "workbench-start-review")
      verify(currentStatus !== null && currentStatus.visible)
      verify(currentStatus.text.indexOf("Every Run must be ready") === 0)
      compare(blockedStart.enabled, false)
      compare(consoleView.pendingIntents.length, 0, "context presentation never emits an authority intent")

      var missing = JSON.parse(JSON.stringify(unavailable))
      missing.revision += 1
      delete missing.selectedProject
      verify(consoleView.applyProjection(missing))
      wait(20)
      currentStatus = findChild(surfaceRoot(), "workbench-assignment-context-status")
      verify(currentStatus !== null && currentStatus.visible)
      verify(currentStatus.text.indexOf("Project context is unavailable") === 0)
      compare(findChild(consoleView, "workbench-start-review").enabled, false)
      consoleView.goTo("start_review")
      wait(20)
      reviewStatus = findChild(surfaceRoot(), "workbench-start-context-status")
      verify(reviewStatus !== null && reviewStatus.visible)
      verify(reviewStatus.text.indexOf("Project context is unavailable") === 0)
      host.snapshot = previousSnapshot
    }

    function test_assignmentToExactStartReview() {
      useRunnerProjectContext()
      openJourney()
      consoleView.goTo("assignment")
      wait(20)
      compare(consoleView.destination, "assignment")
      // Selection first: the task draft is keyed by Project, Goal and agent, so
      // an editor with no target cannot retain typed text.
      consoleView.selectAgent("${JOURNEY_AGENT_RUN_ID}")
      consoleView.selectCheck("${JOURNEY_CHECK_ID}", 3)
      wait(20)
      var task = findChild(consoleView, "workbench-assignment-task")
      verify(task !== null)
      task.text = host.snapshot.details[1].taskText
      wait(20)
      var checkTexts = []; visibleTexts(surfaceRoot(), checkTexts)
      verify(checkTexts.indexOf("Unit tests · v3") >= 0)
      verify(checkTexts.some(function(text) { return text.indexOf("validator · available") >= 0 }))
      var start = findChild(consoleView, "workbench-start-review")
      verify(start !== null)
      verify(start.enabled, consoleView.reviewBlockedReason())
      clickItem(start)
      compare(consoleView.destination, "start_review")
      var texts = []; visibleTexts(surfaceRoot(), texts)
      var joined = texts.join("\\n")
      verify(joined.indexOf("Start review") >= 0)
      verify(joined.indexOf(host.snapshot.details[1].goalText) >= 0)
      verify(joined.indexOf("Task:") >= 0)
      verify(joined.indexOf("Acceptance check: Unit tests") >= 0)
      verify(joined.indexOf("Baseline digest:") < 0, "technical machinery is collapsed by default")
      clickItem(findChild(consoleView, "workbench-technical-details"))
      texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.join("\\n").indexOf('Argv (JSON, not shell): ["--test"]') >= 0)
      verify(texts.join("\\n").indexOf("Confirmation: confirmation-journey-1") >= 0)
      var confirmStart = findChild(consoleView, "workbench-confirm-start")
      verify(confirmStart !== null)
      compare(confirmStart.enabled, true)
      clickItem(confirmStart)
      compare(consoleView.confirmation.kind, "start_assignment")
      clickItem(confirmStart)
      var prepareIntent = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(prepareIntent.kind, "prepare_start_review")
      var startIntent = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(startIntent.kind, "start_assignment")
      compare(startIntent.target, "${JOURNEY_AGENT_RUN_ID}")
      compare(startIntent.payload.confirmationId, "confirmation-journey-1")
      compare(startIntent.payload.taskText, host.snapshot.details[1].taskText)
      compare(startIntent.payload.maxCorrections, 1)
      compare(startIntent.payload.elapsedMs, 900000)
      compare(consoleView.pendingIntents.length, 0)
    }

    function test_backAndEscapeWalkBackOut() {
      openJourney()
      consoleView.goTo("start_review")
      wait(20)
      compare(consoleView.destination, "start_review")
      panel().requestActivate()
      wait(20)
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "destination", "assignment")
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "destination", "goal")
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "destination", "overview")
      verify(findChild(consoleView, "workbench-back").visible === false)
    }

    function test_goalMenuIsInlineAndRestoresFocus() {
      openJourney()
      consoleView.goTo("goal")
      wait(20)
      var menu = findChild(consoleView, "workbench-goal-menu")
      verify(menu !== null)
      mouseClick(menu)
      wait(20)
      compare(consoleView.menuOpen, true)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      verify(texts.indexOf("No assignment is running for this Goal.") >= 0)
      var stop = buttonWithText(surfaceRoot(), "Stop assignment")
      verify(stop !== null)
      compare(stop.enabled, false)
      panel().requestActivate()
      wait(20)
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "menuOpen", false)
      verify(menu.activeFocus, "closing the menu returns focus to the control that opened it")
    }

    function test_loadedCompanionVersionAppearsBesideRunnerStatus() {
      openJourney()
      consoleView.manifest = { version: "0.14.0" }
      var version = findChild(surfaceRoot(), "workbench-version")
      verify(version !== null && version.visible)
      compare(version.text, "v0.14.0")
      verify(version.font.pixelSize < findChild(surfaceRoot(), "workbench-close").font.pixelSize,
        "version is visually secondary to the Runner status")
    }

    function test_adoptionConfirmsOnTheSameButtonWithoutAnExtraSurface() {
      openJourney()
      var button = buttonWithTextPrefix(surfaceRoot(), "Adopt ")
      verify(button !== null && button.enabled)
      clickItem(button)
      compare(consoleView.pendingIntents.length, 0, "the first press never grants adoption authority")
      verify(button.text.indexOf("Confirm: Adopt ") === 0 && button.highlighted)
      verify(findChild(surfaceRoot(), "workbench-inline-confirmation") === null)
      var heartbeat = JSON.parse(JSON.stringify(consoleView.projection))
      heartbeat.cursor += 1
      verify(consoleView.applyProjection(heartbeat))
      verify(button.highlighted, "heartbeat cannot silently reset the same-button confirmation")
      clickItem(button)
      compare(consoleView.pendingIntents.length, 1)
      compare(consoleView.pendingIntents[0].target, host.snapshot.observedSessions[0].choices[0].choiceId)
      verify(!button.highlighted)
    }

    function test_expiryAndChangedTargetRequireTwoNewPresses() {
      openJourney()
      var button = buttonWithTextPrefix(surfaceRoot(), "Adopt ")
      clickItem(button)
      verify(button.highlighted)
      consoleView.invalidateConfirmation("Expired")
      verify(!button.highlighted && button.text.indexOf("Adopt ") === 0)
      compare(consoleView.pendingIntents.length, 0)
      clickItem(button)
      verify(button.highlighted)
      var changed = JSON.parse(JSON.stringify(consoleView.projection))
      changed.revision += 1
      verify(consoleView.applyProjection(changed))
      verify(!button.highlighted, "relevant revision change disarms the button")
      clickItem(button)
      compare(consoleView.pendingIntents.length, 0, "a stale second press only arms the current choice")
      verify(button.highlighted)
      clickItem(button)
      compare(consoleView.pendingIntents.length, 1)
    }

    function test_visualAffordancesAndPages() {
      openJourney()
      var primary = findChild(consoleView, "workbench-new-goal")
      verify(primary.background.children[0].color.a > 0.04, "enabled actions have a resting fill")
      verify(primary.background.children[0].border.color.a > 0.1, "enabled actions have a subtle edge")
      var board = findChild(consoleView, "workbench-board")
      verify(board.background.children[0].color.a < primary.background.children[0].color.a)
      consoleView.selectAgent("${JOURNEY_AGENT_RUN_ID}")
      consoleView.selectCheck("${JOURNEY_CHECK_ID}", 3)
      var states = ["overview", "new_goal", "goal", "add_agent", "adoption_review", "assignment", "checks", "start_review", "work", "activity"]
      for (var i = 0; i < states.length; i++) {
        consoleView.goTo(states[i])
        wait(20)
        if (${JSON.stringify(process.env.WORKBENCH_VISUAL_EVIDENCE || '')} !== "") {
          var image = grabImage(surfaceRoot())
          image.save(${JSON.stringify(process.env.WORKBENCH_VISUAL_EVIDENCE || '')}.replace(/\\.png$/, "-" + states[i] + ".png"))
        }
      }
    }

    function test_fixedDock() {
      openJourney()
      var surface = panel()
      verify(surface !== null, "panel window found")
      var before = surface.width
      verify(before > 0, "panel has a width")
      var height = surface.height
      var destinations = ${JSON.stringify(JOURNEY_DESTINATIONS)}
      for (var i = 0; i < destinations.length; i++) {
        consoleView.goTo(destinations[i])
        wait(10)
        compare(surface.width, before)
        compare(surface.height, height)
      }
      consoleView.goTo("overview")
      wait(10)
    }

    function test_workAndResultShowsCommittedFacts() {
      openFailure()
      consoleView.goTo("work")
      wait(20)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      var joined = texts.join("\\n")
      verify(joined.indexOf("Work and result") >= 0)
      verify(joined.indexOf("Assignment: assignment-1 · failed") >= 0)
      verify(joined.indexOf("result fail") >= 0)
      verify(joined.indexOf("not tool/process termination") >= 0)
      var retry = buttonWithText(surfaceRoot(), "Retry with a new attempt")
      verify(retry !== null && retry.enabled)
      clickItem(retry)
      compare(consoleView.confirmation.kind, "retry")
      compare(consoleView.confirmation.payload.assignmentId, "assignment-1")
      panel().requestActivate()
      wait(20)
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "confirmation", null)
      compare(consoleView.pendingIntents.length, 0)
      consoleView.close()
    }

    function test_workRowsShowEveryCommittedAssignment() {
      openFailure()
      // A second committed Assignment must get its own row, its own facts and
      // its own interventions. It is never folded into the first row.
      var base = consoleView.projection.assignments[0]
      var second = {}
      for (var k in base) second[k] = base[k]
      second.assignmentId = "assignment-2"
      second.goalText = "Ship the second parser fix"
      second.state = "running"
      var projection = {}
      for (var m in consoleView.projection) projection[m] = consoleView.projection[m]
      projection.assignments = [base, second]
      verify(consoleView.applyProjection(projection))
      consoleView.goTo("work")
      wait(20)
      var texts = []; visibleTexts(surfaceRoot(), texts)
      var joined = texts.join("\\n")
      verify(joined.indexOf("Assignment: assignment-1 · failed") >= 0)
      verify(joined.indexOf("Assignment: assignment-2 · running") >= 0)
      verify(joined.indexOf("Goal: Ship the second parser fix") >= 0)
      verify(joined.indexOf("Task: " + second.taskText) >= 0)
      verify(joined.indexOf("not tool/process termination") >= 0)
      var retries = buttonsWithText(surfaceRoot(), "Retry with a new attempt", [])
      compare(retries.length, 2)
      clickItem(retries[1])
      compare(consoleView.confirmation.kind, "retry")
      compare(consoleView.confirmation.payload.assignmentId, "assignment-2")
      panel().requestActivate()
      wait(20)
      keyClick(Qt.Key_Escape)
      tryCompare(consoleView, "confirmation", null)
      compare(consoleView.pendingIntents.length, 0)
      consoleView.close()
    }

    function test_layout_data() { return [{tag: "dock", size: 396}, {tag: "compact", size: 300}] }
    function test_layout(data) {
      var pages = [pageOverview, pageGoal, pageAssignment, pageChecks, pageReview]
      for (var p = 0; p < pages.length; p++) {
        var page = pages[p]
        page.visible = true
        page.width = data.size
        wait(20)
        verify(page.implicitHeight > 0)
        var labels = []; visibleTexts(page, labels)
        verify(labels.length > 3)
        for (var i = 0; i < labels.length; i++) {
          var item = findTextItem(page, labels[i])
          if (item === null || !item.visible) continue
          if (item.text.indexOf("<b>") >= 0) compare(item.textFormat, Text.PlainText)
          verify(isFinite(item.width) && item.width >= 0)
          // Labels and editors must never extend beyond the component width.
          verify(item.width <= data.size, String(item.text).slice(0, 80) + " width=" + item.width)
        }
        var image = grabImage(page)
        verify(image.width > 0)
        page.visible = false
      }
      wait(10)
    }
    function findTextItem(item, value) {
      if (item.text !== undefined && String(item.text) === value) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = findTextItem(item.children[i], value)
        if (found !== null) return found
      }
      return null
    }
  }
}`)
    const result = spawnSync(QT_RUNNER, ['-input', scratch, '-import', join(scratch, 'imports'), '-platform', 'offscreen'], {
      timeout: 30000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'home'), XDG_CACHE_HOME: join(scratch, 'home'), XDG_STATE_HOME: join(scratch, 'home'), XDG_RUNTIME_DIR: join(scratch, 'runtime'), QT_QUICK_BACKEND: 'software', QML_DISABLE_DISK_CACHE: '1', QT_QUICK_CONTROLS_STYLE: 'Basic' },
    })
    const log = `${result.stdout}\n${result.stderr}`
    assert.equal(result.error, undefined, log)
    assert.equal(result.status, 0, log)
    assert.doesNotMatch(log, /ReferenceError|TypeError|Binding loop|Unable to assign|Cannot assign|QWARN/)
    assert.match(log, /0 failed/)
    const requests = [...log.matchAll(/CAPTURED_INTENT (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]))
    assert.ok(requests.some(request => request.kind === 'create_goal'))
    assert.ok(requests.some(request => request.kind === 'configure_checks'))
    const delivered: unknown[] = []
    const adapter = new WorkbenchAdapter({ source: { connect: async () => ({ send() {}, close() {} }) }, sink() {}, intentSink: intent => delivered.push(intent), clock: () => 0 })
    adapter.applySnapshot(journeyFixture)
    for (const request of requests) adapter.emitIntent(request.kind, request.target, request.payload)
    assert.equal(delivered.length, requests.length, 'actual Qt button payloads pass the actual adapter into an injected authority')
    adapter.stop()
    t.diagnostic(log.match(/^Totals:.*$/m)?.[0] ?? 'Qt results unavailable')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
