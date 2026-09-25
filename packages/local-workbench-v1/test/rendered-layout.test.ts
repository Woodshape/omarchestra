import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { journeyFixture, JOURNEY_AGENT_RUN_ID, JOURNEY_CHECK_ID } from '../fixtures/journey.ts'
import { gateFailScenario } from '../fixtures/scenarios.ts'
import { WorkbenchAdapter } from '../console/live-projection-adapter.ts'

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

const QML_FILES = [
  'WorkbenchConsole.qml',
  'WorkbenchHost.qml',
  'WorkbenchOverview.qml',
  'WorkbenchAction.qml',
  'WorkbenchTextArea.qml',
  'WorkbenchTextField.qml',
  'WorkbenchGoal.qml',
  'WorkbenchCards.qml',
  'WorkbenchAssignmentForm.qml',
  'WorkbenchChecks.qml',
  'WorkbenchReview.qml',
  'WorkbenchBoard.qml',
]

// Actual child components, Qt Quick Controls, layout and input. Only theme and
// decorative surface ports are inert stand-ins. Never import the installed shell.
test('offscreen Qt renders the normal journey with literal text, keyboard editing and fixed geometry', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'workbench-qt-'))
  const put = (path: string, text: string) => { writeFileSync(join(scratch, path), text) }
  try {
    for (const path of ['view', 'imports/qs/Commons', 'imports/qs/Ui', 'home', 'runtime']) mkdirSync(join(scratch, path), { recursive: true, mode: 0o700 })
    for (const name of QML_FILES) copyFileSync(new URL(`../console/plugin/${name}`, import.meta.url), join(scratch, 'view', name))
    // Substitute only the native layer-shell host. The actual dialog, forms,
    // scrolling, root methods and child components still execute in Qt.
    const consoleQml = readFileSync(new URL('../console/plugin/WorkbenchConsole.qml', import.meta.url), 'utf8')
      .replace(/^import Quickshell(?:\.Wayland)?\n/gm, '')
      .replace('PanelWindow {', 'Window {')
      .replace(/        anchors \{[\s\S]*?^        }\n/m, '')
      .replace(/        implicitWidth:/, '        width:')
      .replace(/        implicitHeight:/, '        height:')
      .replace(/^        (?:WlrLayershell\.[^\n]+|exclusionMode:[^\n]+|mask:[^\n]+)\n/gm, '')
    put('view/WorkbenchConsole.qml', consoleQml)
    put('imports/qs/Commons/qmldir', 'module qs.Commons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\nsingleton Border 1.0 Border.qml\n')
    put('imports/qs/Commons/Style.qml', `pragma Singleton
import QtQuick
QtObject {
  property int cornerRadius: 4
  property QtObject font: QtObject { property string family: "monospace"; property int body: 12; property int caption: 10; property int title: 14; property int heading: 16 }
  property QtObject spacing: QtObject { property int hairline: 1 }
  function space(value) { return value }
}`)
    put('imports/qs/Commons/Color.qml', `pragma Singleton
import QtQuick
QtObject {
  property color urgent: "#ff7070"; property color accent: "#80c0ff"
  property QtObject popups: QtObject { property color text: "#eeeeee"; property color background: "#202020"; property color border: "#808080" }
}`)
    put('imports/qs/Commons/Border.qml', `pragma Singleton
import QtQuick
QtObject { function flat(color, width) { return {} } function surfaceSpec(a,b,c,d) { return {} } }`)
    put('imports/qs/Ui/qmldir', 'module qs.Ui\nBorderSurface 1.0 BorderSurface.qml\nCursorSurface 1.0 CursorSurface.qml\n')
    put('imports/qs/Ui/CursorSurface.qml', `import QtQuick
Rectangle {
  property color foreground: "#eeeeee"
  property color accent: "#80c0ff"
  property bool hasCursor: false
  property bool current: false
  color: hasCursor ? "#404040" : current ? "#303840" : "transparent"
}`)
    put('imports/qs/Ui/BorderSurface.qml', 'import QtQuick\nRectangle { property var borderSpec: ({}) }\n')
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

    function test_closeDockSendsPresentationOnlyRequest() {
      openJourney()
      clickItem(findChild(consoleView, "workbench-close"))
      var request = JSON.parse(consoleView.takeIntent(host.snapshot))
      compare(request.kind, "hide_workbench")
      compare(request.target, null)
      compare(Object.keys(request.payload).length, 0)
      compare(consoleView.opened, true, "view remains open until owner handles the request")
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

    function test_assignmentToExactStartReview() {
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
      task.text = host.snapshot.details[1].goalText
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
      verify(joined.indexOf("runtime unavailable") >= 0)
      var confirmStart = findChild(consoleView, "workbench-confirm-start")
      verify(confirmStart !== null)
      compare(confirmStart.enabled, false)
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
      consoleView.manifest = { version: "0.12.0" }
      var version = findChild(surfaceRoot(), "workbench-version")
      verify(version !== null && version.visible)
      compare(version.text, "v0.12.0")
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
      verify(joined.indexOf("Task: Ship the second parser fix") >= 0)
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
