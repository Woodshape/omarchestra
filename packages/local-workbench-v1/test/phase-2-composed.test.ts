/**
 * Local Workbench v1 Phase 2 — composed path across the real runner, the real
 * presentation adapter and the real QML host.
 *
 * One full journey is driven end to end over disposable storage: the durable
 * runner produces the authoritative snapshot, the actual QML host renders it
 * offscreen, an operator types a path and clicks the committed affordances, and
 * the captured intents travel back through the actual presentation shell into
 * the runner. No Assignment is delivered and no acceptance check executes.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority, sha256 } from '../runner/authority.ts'
import { readResolvedCheck } from '../runner/check-definition.ts'
import { createWorkbenchHost } from '../runner/host.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'
import { validateDetail } from '../console/detail-schema.ts'

const QT_RUNNER = '/usr/lib/qt6/bin/qmltestrunner'
const QML_FILES = [
  'WorkbenchConsole.qml', 'WorkbenchHost.qml', 'WorkbenchOverview.qml', 'WorkbenchAction.qml',
  'WorkbenchTextArea.qml', 'WorkbenchTextField.qml', 'WorkbenchGoal.qml', 'WorkbenchCards.qml',
  'WorkbenchAssignmentForm.qml', 'WorkbenchChecks.qml', 'WorkbenchReview.qml', 'WorkbenchBoard.qml',
]

type HarnessMode = 'inspect' | 'confirm' | 'reconfirm' | 'check' | 'edit-check' | 'render' | 'observe' | 'authorize' | 'goal' | 'page' | 'add-agent' | 'add-agent-wrong-role' | 'adoption-review'

function harness(snapshot: unknown, projectPath: string, mode: HarnessMode): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of QML_FILES) {
    const source = readFileSync(new URL(`../console/plugin/${name}`, import.meta.url), 'utf8')
    files[`view/${name}`] = name === 'WorkbenchConsole.qml'
      ? source
          .replace(/^import Quickshell(?:\.Wayland)?\n/gm, '')
          .replace('PanelWindow {', 'Window {')
          .replace(/        anchors \{[\s\S]*?^        }\n/m, '')
          .replace(/        implicitWidth:/, '        width:')
          .replace(/        implicitHeight:/, '        height:')
          .replace(/^        (?:WlrLayershell\.[^\n]+|exclusionMode:[^\n]+|mask:[^\n]+)\n/gm, '')
      : source
  }
  files['imports/qs/Commons/qmldir'] = 'module qs.Commons\nsingleton Style 1.0 Style.qml\nsingleton Color 1.0 Color.qml\nsingleton Border 1.0 Border.qml\n'
  files['imports/qs/Commons/Style.qml'] = `pragma Singleton
import QtQuick
QtObject {
  property int cornerRadius: 4
  property QtObject font: QtObject { property string family: "monospace"; property int body: 12; property int caption: 10; property int title: 14; property int heading: 16 }
  property QtObject spacing: QtObject { property int hairline: 1 }
  function space(value) { return value }
}`
  files['imports/qs/Commons/Color.qml'] = `pragma Singleton
import QtQuick
QtObject {
  property color urgent: "#ff7070"; property color accent: "#80c0ff"
  property QtObject popups: QtObject { property color text: "#eeeeee"; property color background: "#202020"; property color border: "#808080" }
}`
  files['imports/qs/Commons/Border.qml'] = `pragma Singleton
import QtQuick
QtObject { function flat(color, width) { return {} } function surfaceSpec(a,b,c,d) { return {} } }`
  files['imports/qs/Ui/qmldir'] = 'module qs.Ui\nBorderSurface 1.0 BorderSurface.qml\nCursorSurface 1.0 CursorSurface.qml\n'
  files['imports/qs/Ui/CursorSurface.qml'] = 'import QtQuick\nRectangle { property color foreground: "#eeeeee"\n property color accent: "#80c0ff"\n property bool hasCursor: false\n property bool current: false\n color: "transparent" }\n'
  files['imports/qs/Ui/BorderSurface.qml'] = 'import QtQuick\nRectangle { property var borderSpec: ({}) }\n'
  files['tst_composed.qml'] = `import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtTest
import "view"
Item {
  id: host
  width: 800; height: 900
  property var snapshot: ${JSON.stringify(snapshot)}
  WorkbenchConsole { id: consoleView; pluginGeneration: 1 }
  TestCase {
    name: "Composed"; when: windowShown
    // The scrolled panel holds the page items; traversal starts at its
    // content item, not the console root.
    function surfaceRoot() {
      var panel = findChild(consoleView, "workbench-panel")
      return panel && panel.contentItem ? panel.contentItem : panel
    }
    function buttonWithText(item, value) {
      if (item.visible && item.text === value && item.down !== undefined) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = buttonWithText(item.children[i], value)
        if (found !== null) return found
      }
      return null
    }
    function buttonWithTextPrefix(item, prefix) {
      if (item.text !== undefined && String(item.text).indexOf(prefix) === 0 && item.down !== undefined) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = buttonWithTextPrefix(item.children[i], prefix)
        if (found !== null) return found
      }
      return null
    }
    function itemNamed(item, name) {
      if (item.objectName === name) return item
      for (var i = 0; i < item.children.length; i++) {
        var found = itemNamed(item.children[i], name)
        if (found !== null) return found
      }
      return null
    }
    // The panel scrolls, so a control below the viewport must be revealed by
    // focus before a synthesized click can land on it.
    function clickItem(item) {
      verify(item !== null, "control exists")
      item.forceActiveFocus()
      wait(20)
      mouseClick(item)
      wait(20)
    }
    function session() {
      return JSON.stringify({ sessionId: host.snapshot.sessionId, pluginGeneration: 1 })
    }
    function emit() {
      console.log("COMPOSED_INTENT " + JSON.stringify(JSON.parse(consoleView.takeIntent(session()))))
    }
    function test_zzComposed() {
      compare(consoleView.open(JSON.stringify({
        session: { sessionId: host.snapshot.sessionId, pluginGeneration: 1 },
        projection: host.snapshot
      })), true)
      compare(host.snapshot.fixture.active, false)
      if (${mode === 'inspect' ? 'true' : 'false'}) {
        var field = findChild(consoleView, "workbench-project-path")
        verify(field !== null)
        field.text = ${JSON.stringify(projectPath)}
        wait(20)
        clickItem(buttonWithText(surfaceRoot(), "Inspect path"))
        emit()
      } else if (${mode === 'confirm' || mode === 'reconfirm' ? 'true' : 'false'}) {
        var confirm = buttonWithText(surfaceRoot(), ${JSON.stringify(mode === 'reconfirm' ? 'Reconfirm context' : 'Confirm and register')})
        verify(confirm !== null)
        compare(confirm.enabled, true)
        clickItem(confirm)
        emit()
      } else if (${mode === 'goal' ? 'true' : 'false'}) {
        consoleView.goTo("new_goal")
        wait(20)
        var goalField = findChild(consoleView, "workbench-goal-text")
        verify(goalField !== null)
        goalField.text = ${JSON.stringify(projectPath)}
        wait(20)
        clickItem(findChild(consoleView, "workbench-create-goal"))
        emit()
      } else if (${mode === 'check' ? 'true' : 'false'}) {
        consoleView.goTo("checks")
        wait(20)
        var newCheck = findChild(consoleView, "workbench-new-check")
        verify(newCheck !== null)
        compare(newCheck.enabled, true)
        clickItem(newCheck)
        // The editor opens empty; nothing is committed until the operator fills
        // the same validated definition fields and presses Create.
        compare(findChild(consoleView, "workbench-create-check").enabled, false)
        var nameField = itemNamed(surfaceRoot(), "workbench-check-name")
        verify(nameField !== null)
        nameField.text = "Composed gate check"
        wait(20)
        var executable = itemNamed(surfaceRoot(), "check-field-executable")
        verify(executable !== null)
        executable.text = "/bin/true"
        wait(20)
        var cwd = itemNamed(surfaceRoot(), "check-field-cwd")
        verify(cwd !== null)
        cwd.text = ${JSON.stringify(projectPath)}
        wait(20)
        var resource = itemNamed(surfaceRoot(), "check-field-resourcePaths")
        verify(resource !== null)
        resource.text = ${JSON.stringify(projectPath + '/validator.conf')}
        wait(20)
        var create = findChild(consoleView, "workbench-create-check")
        compare(create.enabled, true)
        clickItem(create)
        emit()
      } else if (${mode === 'edit-check' ? 'true' : 'false'}) {
        consoleView.goTo("checks")
        wait(20)
        clickItem(buttonWithTextPrefix(surfaceRoot(), "Composed gate check · v"))
        clickItem(findChild(consoleView, "workbench-check-advanced"))
        var editExecutable = itemNamed(surfaceRoot(), "check-field-executable")
        var editCwd = itemNamed(surfaceRoot(), "check-field-cwd")
        var editResources = itemNamed(surfaceRoot(), "check-field-resourcePaths")
        verify(editExecutable !== null && editCwd !== null && editResources !== null)
        editExecutable.text = "/bin/true"
        editCwd.text = ${JSON.stringify(projectPath)}
        editResources.text = ${JSON.stringify(projectPath + '/validator.conf')}
        wait(20)
        var save = findChild(consoleView, "workbench-save-check")
        compare(save.enabled, true)
        clickItem(save)
        emit()
      } else if (${mode === 'page' ? 'true' : 'false'}) {
        var pages = findChild(consoleView, "workbench-pages")
        verify(pages !== null)
        compare(pages.count, 1)
        var nextPage = pages.itemAt(0).children.filter(function(item) {
          return item.objectName === "workbench-page-next"
        })[0]
        verify(nextPage !== undefined)
        compare(nextPage.enabled, true)
        var scroll = findChild(consoleView, "workbench-scroll")
        scroll.contentY = Math.max(0, scroll.contentHeight - scroll.height)
        wait(30)
        clickItem(nextPage)
        emit()
      } else if (${mode === 'add-agent' || mode === 'add-agent-wrong-role' || mode === 'adoption-review' ? 'true' : 'false'}) {
        consoleView.goTo("add_agent")
        wait(20)
        clickItem(buttonWithTextPrefix(surfaceRoot(), ${JSON.stringify(mode === 'adoption-review' ? 'proposal_pending  ·' : 'observed  ·')}))
        clickItem(buttonWithText(surfaceRoot(), ${JSON.stringify(mode === 'add-agent-wrong-role' ? 'reviewer' : 'implementer')}))
        if (${mode === 'add-agent-wrong-role' ? 'true' : 'false'}) {
          var forbidden = findChild(consoleView, "workbench-request-adoption")
          verify(forbidden !== null)
          compare(forbidden.enabled, false)
          compare(consoleView.takeIntent(session()), "")
          return
        }
        if (${mode === 'add-agent' ? 'true' : 'false'}) {
          var request = findChild(consoleView, "workbench-request-adoption")
          verify(request !== null)
          compare(request.enabled, true)
          clickItem(request)
          var adoptionConfirm = findChild(consoleView, "workbench-inline-confirmation")
          verify(adoptionConfirm !== null && adoptionConfirm.visible)
          var confirmButton = findChild(adoptionConfirm, "workbench-confirm-review")
          verify(confirmButton !== null && confirmButton.enabled)
          confirmButton.clicked()
        } else {
          var review = findChild(consoleView, "workbench-add-agent-continue")
          compare(review.enabled, true)
          clickItem(review)
          clickItem(findChild(consoleView, "workbench-authorize-adoption"))
        }
        emit()
      } else if (${mode === 'observe' ? 'true' : 'false'}) {
        wait(20)
        var adoptChoice = buttonWithTextPrefix(surfaceRoot(), "Adopt ")
        verify(adoptChoice !== null, "the observed session is rendered as an adoptable choice")
        compare(adoptChoice.enabled, true)
        clickItem(adoptChoice)
        // Requesting adoption is a declared, confirmed action: the inline
        // review must remain in the dock and its button carries the exact intent.
        var review = findChild(consoleView, "workbench-inline-confirmation")
        verify(review !== null && review.visible, "the review is in the dock")
        var confirmButton = findChild(review, "workbench-confirm-review")
        verify(confirmButton !== null && confirmButton.enabled)
        confirmButton.clicked()
        wait(20)
        emit()
      } else if (${mode === 'authorize' ? 'true' : 'false'}) {
        wait(20)
        var authorizeChoice = buttonWithTextPrefix(surfaceRoot(), "Authorize adoption as ")
        verify(authorizeChoice !== null, "the proposal is rendered as an authorization choice")
        compare(authorizeChoice.enabled, true)
        clickItem(authorizeChoice)
        emit()
      } else {
        // Render only: the committed projection keeps the path entry for the
        // next Project but has no confirmable registration left.
        verify(buttonWithText(surfaceRoot(), "Inspect path") !== null)
        compare(findChild(consoleView, "workbench-confirm-registration").enabled, false)
      }
    }
  }
}`

  return files
}

function runQml(files: Record<string, string>): string {
  const scratch = mkdtempSync(join(tmpdir(), 'workbench-composed-'))
  try {
    for (const path of ['view', 'imports/qs/Commons', 'imports/qs/Ui', 'home', 'runtime']) mkdirSync(join(scratch, path), { recursive: true, mode: 0o700 })
    for (const [path, text] of Object.entries(files)) writeFileSync(join(scratch, path), text)
    const result = spawnSync(QT_RUNNER, ['-input', scratch, '-import', join(scratch, 'imports'), '-platform', 'offscreen'], {
      timeout: 30000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin', HOME: join(scratch, 'home'), XDG_CONFIG_HOME: join(scratch, 'home'),
        XDG_CACHE_HOME: join(scratch, 'home'), XDG_STATE_HOME: join(scratch, 'home'),
        XDG_RUNTIME_DIR: join(scratch, 'runtime'), QT_QUICK_BACKEND: 'software',
        QML_DISABLE_DISK_CACHE: '1', QT_QUICK_CONTROLS_STYLE: 'Basic',
      },
    })
    const log = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, log)
    assert.doesNotMatch(log, /ReferenceError|TypeError|Binding loop|Unable to assign|Cannot assign|QWARN/)
    assert.match(log, /0 failed/)
    return log
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function capturedIntents(log: string): Array<{ kind: string; target: string | null; payload: Record<string, unknown> }> {
  return [...log.matchAll(/COMPOSED_INTENT (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]))
}

class FakeStream extends EventEmitter {
  other!: FakeStream; closed = false
  write(bytes: Buffer) { if (this.closed) throw new Error('closed'); this.other.emit('data', bytes); return true }
  destroy() { if (this.closed) return; this.closed = true; this.emit('close'); if (!this.other.closed) this.other.destroy() }
}
function paired() { const a = new FakeStream(), b = new FakeStream(); a.other = b; b.other = a; return { a, b } }

/** Collects what the real adapter pushed at the QML host. */
function composedView(rendered: Array<Record<string, unknown>>) {
  const results: Array<Record<string, unknown>> = []
  const queue: string[] = []
  return {
    rendered,
    results,
    queue,
    view: {
      pluginGeneration: 1,
      open: (envelope: unknown) => { rendered.push((envelope as { projection: Record<string, unknown> }).projection); return true },
      applyProjection: (snapshot: unknown) => { rendered.push(snapshot as Record<string, unknown>); return true },
      takeIntent: () => queue.shift() ?? '',
      intentResult: (feedback: unknown) => { results.push(feedback as Record<string, unknown>); return true },
      close: () => {},
    },
  }
}

test('the real runner, real adapter and real QML host complete one management journey', async () => {
  if (!existsSync(QT_RUNNER)) {
    assert.fail('qmltestrunner is required for the composed QML path; this gate refuses to pass without it')
  }
  const base = mkdtempSync(join(tmpdir(), 'lw-p2-composed-'))
  const stateRoot = join(base, 'state')
  const project = join(base, 'project')
  let runner: ReturnType<typeof openWorkbenchRunner> | null = null
  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    mkdirSync(project, { recursive: true })
    execFileSync('git', ['init', '-q', project], { stdio: 'ignore' })
    writeFileSync(join(project, 'validator.conf'), 'composed-v1\n')

    let tick = 1_000
    const clock = () => (tick += 10)
    let counter = 0
    const newId = (prefix: string) => `${prefix}${(counter += 1).toString().padStart(4, '0')}-${'0'.repeat(20)}`
    runner = openWorkbenchRunner({ roots: { stateDir: stateRoot }, clock, newId })
    const authority = new WorkbenchAuthority({ runner, sessionId: 'sess-composed', pluginGeneration: 1, clock, newId })

    // The injected port stands in for the QML host: it records what the real
    // adapter sent it and returns exactly the intents the QML run captured.
    const rendered: Array<Record<string, unknown>> = []
    const results: Array<Record<string, unknown>> = []
    const queue: string[] = []
    const view = {
      pluginGeneration: 1,
      open: (envelope: unknown) => { rendered.push((envelope as { projection: Record<string, unknown> }).projection); return true },
      applyProjection: (snapshot: unknown) => { rendered.push(snapshot as Record<string, unknown>); return true },
      takeIntent: () => queue.shift() ?? '',
      intentResult: (feedback: unknown) => { results.push(feedback as Record<string, unknown>); return true },
      close: () => {},
    }
    const host = createWorkbenchHost({ authority, view, clock })
    await host.start()
    assert.equal(rendered.length, 1, 'the shell must open the port exactly once for the runner session')
    assert.equal((rendered[0].fixture as { active: boolean }).active, false, 'the durable path never renders the fixture label')
    assert.equal(rendered[0].connection, 'connected')

    // Step 1: the operator inspects a real Git path.
    const firstRun = runQml(harness(rendered[0], project, 'inspect'))
    const first = capturedIntents(firstRun)
    assert.deepEqual(first.map(intent => intent.kind), ['inspect_project'])
    assert.equal(first[0].payload.path, project)
    queue.push(JSON.stringify(first[0]))
    host.tick()
    assert.deepEqual(results.slice(-1).map(result => result.status), ['acknowledged'])
    const afterInspect = rendered[rendered.length - 1]
    const detail = validateDetail((afterInspect.details as unknown[])[0]) as { kind: string; registrationId: string; supported: boolean }
    assert.equal(detail.kind, 'registration')
    assert.equal(detail.supported, true)
    assert.equal(afterInspect.selectedProjectId, null)

    // Step 2: the operator confirms that exact registration.
    const secondRun = runQml(harness(afterInspect, project, 'confirm'))
    const second = capturedIntents(secondRun)
    assert.deepEqual(second.map(intent => intent.kind), ['confirm_register_project'])
    assert.equal(second[0].target, detail.registrationId)
    queue.push(JSON.stringify(second[0]))
    host.tick()
    assert.deepEqual(results.slice(-1).map(result => result.status), ['acknowledged'])
    const afterConfirm = rendered[rendered.length - 1]
    assert.equal((afterConfirm.projects as unknown[]).length, 1)
    assert.equal((afterConfirm.projects as Array<{ canonicalPath: string }>)[0].canonicalPath, project)
    assert.equal(((afterConfirm.details as unknown[] | undefined) ?? []).length, 0)

    // Step 3: the operator opens the checks destination and adds a check to the
    // committed Project.
    const thirdRun = runQml(harness(afterConfirm, project, 'check'))
    const third = capturedIntents(thirdRun)
    assert.deepEqual(third.map(intent => intent.kind), ['create_check'])
    assert.equal(third[0].payload.projectId, afterConfirm.selectedProjectId)
    assert.equal((third[0].payload.definitionDraft as { cwd: string }).cwd, project)
    queue.push(JSON.stringify(third[0]))
    host.tick()
    assert.deepEqual(results.slice(-1).map(result => result.status), ['acknowledged'])

    // Committed state is read back from the durable store, not the projection.
    const final = rendered[rendered.length - 1]
    assert.equal((final.checks as unknown[]).length, 1)
    assert.equal((final.assignments as unknown[]).length, 0)
    assert.equal((final.actions as Array<{ kind: string; enabled: boolean }>).find(action => action.kind === 'start_assignment')?.enabled, false)
    const stored = runner.store.listChecks(final.selectedProjectId as string)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].projectId, final.selectedProjectId)
    assert.equal(readResolvedCheck(stored[0]).resources[0].digest, sha256('composed-v1\n'))
    assert.equal(runner.store.listEvents().filter(event => event.kind === 'check_created').length, 1)

    // A second QML journey edits the exact version, producing a new runner-resolved definition.
    writeFileSync(join(project, 'validator.conf'), 'composed-v2\n')
    const edit = capturedIntents(runQml(harness(final, project, 'edit-check')))
    assert.deepEqual(edit.map(intent => intent.kind), ['configure_checks'])
    assert.equal(edit[0].payload.checkVersion, 1)
    queue.push(JSON.stringify(edit[0])); host.tick()
    assert.deepEqual(results.slice(-1).map(result => result.status), ['acknowledged'])
    const updatedCheck = runner.store.latestCheck(final.selectedProjectId as string, stored[0].checkId)!
    assert.equal(updatedCheck.version, 2)
    assert.equal(readResolvedCheck(updatedCheck).resources[0].digest, sha256('composed-v2\n'))
    assert.notEqual(updatedCheck.digest, stored[0].digest)

    // The runner's committed snapshot renders in the real QML with no warning
    // and no remaining registration affordance.
    runQml(harness(final, project, 'render'))

    // A copied repository at the same path is not the registered directory.
    // Reconfirmation is a new, visible operator action through the real QML.
    const originalProject = runner.store.getProject(final.selectedProjectId as string)!
    renameSync(project, join(base, 'old-project'))
    cpSync(join(base, 'old-project'), project, { recursive: true })
    const inspection = capturedIntents(runQml(harness(final, project, 'inspect')))[0]
    queue.push(JSON.stringify(inspection)); host.tick()
    const changed = rendered.at(-1)!
    assert.equal((changed.details as Array<{ reconfirmation: boolean }>)[0].reconfirmation, true)
    assert.equal((changed.checks as Array<{ availability: string }>)[0].availability, 'unavailable')
    const reconfirm = capturedIntents(runQml(harness(changed, project, 'reconfirm')))[0]
    queue.push(JSON.stringify(reconfirm)); host.tick()
    const updated = runner.store.getProject(originalProject.projectId)!
    assert.notEqual(updated.contextDigest, originalProject.contextDigest)
    assert.equal(updated.revision, originalProject.revision + 1)
    assert.equal(runner.store.listChecks(updated.projectId).length, 2)
    assert.equal((rendered.at(-1)!.assignments as unknown[]).length, 0)

    // The actual Qt pager emits a bounded intent for records after page one;
    // the adapter and runner advance the page rather than silently dropping.
    for (let i = 0; i < 130; i++) runner.store.putProject({ projectId: `page-project-${i}`,
      executionNodeId: runner.nodeId, canonicalPath: join(base, `page-project-${i}`), gitCommonDir: join(base, `page-project-${i}/.git`),
      headOid: null, dirty: false, contextDigest: null, revision: 1, createdAt: i + 1 })
    authority.selectProject('page-project-0')
    host.tick()
    const firstPage = rendered.at(-1)!
    assert.equal((firstPage.projects as unknown[]).length, 64)
    const nextPage = capturedIntents(runQml(harness(firstPage, project, 'page')))[0]
    assert.equal(nextPage.kind, 'navigate_page')
    assert.deepEqual(nextPage.payload, { collection: 'projects', offset: 64 })
    queue.push(JSON.stringify(nextPage)); host.tick()
    assert.equal((rendered.at(-1)!.pages as { projects: { offset: number } }).projects.offset, 64)

    host.stop()
    // Each terminal acknowledgement reached the view, and every durable commit
    // reported the revision the runner actually wrote.
    const acknowledged = results.filter(result => result.status === 'acknowledged')
    const submitted = results.filter(result => result.status === 'submitted')
    assert.equal(acknowledged.length, 7, 'every intent was acknowledged')
    assert.equal(submitted.length, 7, 'the view also saw each intent in flight')
    const revisions = acknowledged.map(result => result.committedRevision).filter(value => typeof value === 'number') as number[]
    assert.equal(revisions.length, 5, 'registration, check creation/edit, reconfirmation and page navigation report committed revisions')
    assert.ok(revisions.every(value => value >= 1))
    assert.equal(results[results.length - 1].status, 'acknowledged')

    // A fresh presentation must still show the durable context when the
    // selected Project/Goal live past the first bounded collection page.
    authority.selectProject('page-project-99')
    for (let i = 0; i < 130; i++) authority.createGoal('page-project-99', `Selected goal ${i}`)
    const fresh = new WorkbenchAuthority({ runner, sessionId: 'composed-reopen', pluginGeneration: 1, clock, newId })
    const selected = validateSnapshot(buildSnapshot({ authority: fresh, adoption: fresh.adoption, connection: 'connected' }))
    assert.equal(selected.pages?.projects.offset, 64)
    assert.equal(selected.pages?.goals.offset, 128)
    assert.equal(selected.selectedProject?.projectId, 'page-project-99')
    assert.equal(selected.selectedGoal?.goalId, fresh.selectedGoalId)
    const selectedIntent = capturedIntents(runQml(harness(selected, 'Goal from reopened selection', 'goal')))[0]
    assert.equal(selectedIntent.kind, 'create_goal')
    assert.equal(selectedIntent.payload.projectId, 'page-project-99')
  } finally {
    try { runner?.close() } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true })
  }
})

test('real QML intents traverse the adapter, one runner, framed fake Pi and back to rendered readiness', async () => {
  if (!existsSync(QT_RUNNER)) {
    assert.fail('qmltestrunner is required for the composed QML path; this gate refuses to pass without it')
  }
  const base = mkdtempSync(join(tmpdir(), 'lw-p2-adopt-'))
  const stateRoot = join(base, 'state')
  const project = join(base, 'project')
  let runner: ReturnType<typeof openWorkbenchRunner> | null = null
  try {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    mkdirSync(project, { recursive: true })
    execFileSync('git', ['init', '-q', project], { stdio: 'ignore' })

    let tick = 1_000
    const clock = () => (tick += 10)
    let counter = 0
    const newId = (prefix: string) => `${prefix}${(counter += 1).toString().padStart(4, '0')}-${'0'.repeat(20)}`
    runner = openWorkbenchRunner({ roots: { stateDir: stateRoot }, clock, newId })
    const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, now: () => tick })
    const authority = new WorkbenchAuthority({
      runner, sessionId: 'sess-adopt', pluginGeneration: 1, clock, newId, registry,
    })
    const composed = composedView([])
    const host = createWorkbenchHost({ authority, view: composed.view, clock })
    await host.start()

    // Register a real local Project first: adoption names a committed Project.
    const inspectRun = runQml(harness(composed.rendered[0], project, 'inspect'))
    const inspectIntent = capturedIntents(inspectRun)[0]
    composed.queue.push(JSON.stringify(inspectIntent))
    host.tick()
    const registrationId = (validateDetail((composed.rendered.at(-1)?.details as unknown[])[0]) as { registrationId: string }).registrationId
    const confirmRun = runQml(harness(composed.rendered.at(-1), project, 'confirm'))
    const confirmIntent = capturedIntents(confirmRun)[0]
    assert.equal(confirmIntent.target, registrationId)
    composed.queue.push(JSON.stringify(confirmIntent))
    host.tick()
    assert.equal(((composed.rendered.at(-1)?.projects as unknown[]).length), 1)

    // Two real QML creations persist separate Goals; Adoption names the
    // second selected Goal rather than borrowing an observation's cwd/title.
    for (const goalText of ['First team goal', 'Second team goal']) {
      const created = capturedIntents(runQml(harness(composed.rendered.at(-1), goalText, 'goal')))[0]
      assert.equal(created.kind, 'create_goal')
      composed.queue.push(JSON.stringify(created)); host.tick()
      assert.equal(composed.results.at(-1)?.status, 'acknowledged')
    }
    assert.equal(runner.store.listGoals().length, 2)
    const goalId = authority.selectedGoalId!
    const statuses: Array<string | undefined> = []
    const hooks = new Map<string, (event: unknown, ctx: unknown) => void>()
    const fakePi = { mode: 'tui', sessionManager: { getSessionId: () => 'pi-session-composed' }, isIdle: () => true,
      ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value) } } }
    const links: ReturnType<typeof paired>[] = []
    let sequence = 0
    createPiBridgeExtension({
      newId: prefix => prefix === 'process' ? 'process-' + 'a'.repeat(32) : prefix === 'extension'
        ? 'extension-' + 'b'.repeat(32) : `${prefix}-${(++sequence).toString(16).padStart(32, '0')}`,
      schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
      connect: async (onFrame, onClose) => {
        const pair = paired(); links.push(pair)
        attachBridgeStream(pair.a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
        return attachBridgeStream(pair.b, { onFrame: (_peer, frame) => onFrame(frame), onClose })
      },
    })({ on(name, handler) { hooks.set(name, handler as (event: unknown, ctx: unknown) => void) } })
    hooks.get('session_start')!(null, fakePi)
    await new Promise(resolve => setImmediate(resolve))
    host.tick()
    assert.equal(statuses.at(-1), 'Unassigned · observed')
    const afterObserve = composed.rendered.at(-1) as Record<string, unknown>
    assert.equal((afterObserve.observedSessions as unknown[]).length, 1)

    // Step 1: the operator clicks the rendered observation. The intent names the
    // observation choiceId, so the runner accepts it rather than reporting a
    // missing resource.
    const roleUnavailable = { ...afterObserve, observedSessions: (afterObserve.observedSessions as Array<{ choices: Array<{ role?: string }> }>)
      .map(card => ({ ...card, choices: card.choices.filter(choice => choice.role !== 'reviewer') })) }
    runQml(harness(validateSnapshot(roleUnavailable), project, 'add-agent-wrong-role'))
    const observeRun = runQml(harness(afterObserve, project, 'add-agent'))
    const observeIntent = capturedIntents(observeRun)[0]
    assert.equal(observeIntent.kind, 'request_adoption')
    assert.equal(typeof observeIntent.payload.choiceId, 'string')
    assert.equal(observeIntent.payload.choiceId, observeIntent.target)
    composed.queue.push(JSON.stringify(observeIntent))
    host.tick()
    assert.equal(composed.results.at(-1)?.status, 'acknowledged')

    // Step 2: the projection now carries the Proposal as an authorization
    // choice, and the operator authorizes it.
    const afterProposal = composed.rendered.at(-1) as Record<string, unknown>
    const proposalCards = (afterProposal.observedSessions as Array<{ choices: Array<{ actionKind?: string }> }>)
      .filter(card => card.choices.some(choice => choice.actionKind === 'authorize_adoption'))
    assert.equal(proposalCards.length, 1, 'the pending Proposal must be rendered for authorization')
    const authorizeRun = runQml(harness(afterProposal, project, 'adoption-review'))
    const authorizeIntent = capturedIntents(authorizeRun)[0]
    assert.equal(authorizeIntent.kind, 'authorize_adoption')
    composed.queue.push(JSON.stringify(authorizeIntent))
    host.tick()
    assert.equal(composed.results.at(-1)?.status, 'acknowledged')

    // A same-Pi ACK and framed commit/receipt occurred synchronously after
    // operator authorization. No test injects a fabricated readiness event.
    host.tick()
    const readyAgent = (composed.rendered.at(-1) as { managedAgents: Array<{ agentRunId: string; piStatus: string }> }).managedAgents[0]
    assert.ok(readyAgent)
    assert.equal(readyAgent.piStatus, 'ready')
    assert.equal(statuses.at(-1), 'implementer · ready')
    assert.deepEqual(runner.store.listMemberships(goalId).map(m => m.runId), [readyAgent.agentRunId])
    assert.equal(runner.store.listMemberships(runner.store.listGoals().find(g => g.goalId !== goalId)!.goalId).length, 0)
    assert.equal(runner.store.listDeliveries(readyAgent.agentRunId).length, 1)
    hooks.get('input')!({ source: 'interactive', get text() { throw Error('private Pi content accessed') } }, fakePi)
    host.tick()
    assert.equal((composed.rendered.at(-1) as { managedAgents: Array<{ piStatus: string }> }).managedAgents[0].piStatus, 'manual_takeover')
    assert.equal(statuses.at(-1), 'implementer · manual takeover')

    // Phase 2 still delivers no Assignment and runs no acceptance check.
    assert.equal(runner.store.listEvents().filter(event => event.kind.startsWith('assignment')).length, 0)
    assert.equal((composed.rendered.at(-1)?.assignments as unknown[]).length, 0)
    assert.ok(runner.store.listEvents().some(event => event.kind === 'adoption_committed'))
    assert.ok(runner.store.listEvents().some(event => event.kind === 'adoption_ready'))
    assert.equal(links.length, 1)
    host.stop()
    hooks.get('session_shutdown')!(null, fakePi)
  } finally {
    try { runner?.close() } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true })
  }
})
