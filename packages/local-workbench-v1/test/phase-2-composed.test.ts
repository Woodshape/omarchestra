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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { createWorkbenchHost } from '../runner/host.ts'
import type { ObserverPort, TransportEvent, WorkbenchFrame } from '../runner/transport.ts'
import { validateDetail } from '../console/detail-schema.ts'

const QT_RUNNER = '/usr/lib/qt6/bin/qmltestrunner'
const QML_FILES = [
  'WorkbenchConsole.qml', 'WorkbenchHost.qml', 'WorkbenchOverview.qml', 'WorkbenchAction.qml',
  'WorkbenchTextArea.qml', 'WorkbenchTextField.qml', 'WorkbenchGoal.qml', 'WorkbenchCards.qml',
  'WorkbenchAssignmentForm.qml', 'WorkbenchChecks.qml', 'WorkbenchReview.qml', 'WorkbenchBoard.qml',
]

type HarnessMode = 'inspect' | 'confirm' | 'check' | 'render' | 'observe' | 'authorize'

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
      } else if (${mode === 'confirm' ? 'true' : 'false'}) {
        var confirm = buttonWithText(surfaceRoot(), "Confirm and register")
        verify(confirm !== null)
        compare(confirm.enabled, true)
        clickItem(confirm)
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
        var create = findChild(consoleView, "workbench-create-check")
        compare(create.enabled, true)
        clickItem(create)
        emit()
      } else if (${mode === 'observe' ? 'true' : 'false'}) {
        wait(20)
        var adoptChoice = buttonWithTextPrefix(surfaceRoot(), "Adopt ")
        verify(adoptChoice !== null, "the observed session is rendered as an adoptable choice")
        compare(adoptChoice.enabled, true)
        clickItem(adoptChoice)
        // Requesting adoption is a declared, confirmed action: the real dialog
        // must appear and its OK button must carry the captured intent.
        var dialog = findChild(consoleView, "workbench-confirmation")
        verify(dialog !== null, "the confirmation dialog exists")
        verify(dialog.opened, "the confirmation dialog opened for the adoption request")
        var okButton = dialog.standardButton(Dialog.Ok)
        verify(okButton !== null)
        okButton.clicked()
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

/** Injected observer transport: records every frame and delivers test events. */
class ComposedPort implements ObserverPort {
  readonly transportId = 'composed-port'
  readonly sent: WorkbenchFrame[] = []
  private handlers: Array<(event: TransportEvent) => void> = []
  send(frame: WorkbenchFrame): void { this.sent.push(frame) }
  subscribe(handler: (event: TransportEvent) => void): () => void {
    this.handlers.push(handler)
    return () => { this.handlers = this.handlers.filter(item => item !== handler) }
  }
  close(): void { this.handlers = [] }
  emit(event: Partial<TransportEvent> & { type: TransportEvent['type'] }): void {
    const full: TransportEvent = {
      runId: '', bindingDigest: '', transportId: this.transportId, source: 'extension', detail: '', ...event,
    }
    for (const handler of [...this.handlers]) handler(full)
  }
  last(kind: string): WorkbenchFrame | undefined {
    return [...this.sent].reverse().find(frame => frame.kind === kind)
  }
}

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
    assert.equal(runner.store.listEvents().filter(event => event.kind === 'check_created').length, 1)

    // The runner's committed snapshot renders in the real QML with no warning
    // and no remaining registration affordance.
    runQml(harness(final, project, 'render'))

    host.stop()
    // Each terminal acknowledgement reached the view, and every durable commit
    // reported the revision the runner actually wrote.
    const acknowledged = results.filter(result => result.status === 'acknowledged')
    const submitted = results.filter(result => result.status === 'submitted')
    assert.equal(acknowledged.length, 3, 'every intent was acknowledged')
    assert.equal(submitted.length, 3, 'the view also saw each intent in flight')
    const revisions = acknowledged.map(result => result.committedRevision).filter(value => typeof value === 'number') as number[]
    assert.equal(revisions.length, 2, 'confirm and create must both report a committed revision')
    assert.ok(revisions.every(value => value >= 1))
    assert.equal(results[results.length - 1].status, 'acknowledged')
  } finally {
    try { runner?.close() } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true })
  }
})

test('the real QML host requests and authorizes one adoption over a real transport', async () => {
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
    const port = new ComposedPort()
    const authority = new WorkbenchAuthority({
      runner, sessionId: 'sess-adopt', pluginGeneration: 1, clock, newId, transport: () => port,
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

    // The extension reports one visible Pi; the observer sees no adoptable card
    // rendered by the fixture path.
    port.emit({ type: 'session_observed', observedSessionId: 'pi-session-composed', role: 'implementer' })
    host.tick()
    const afterObserve = composed.rendered.at(-1) as Record<string, unknown>
    assert.equal((afterObserve.observedSessions as unknown[]).length, 1)

    // Step 1: the operator clicks the rendered observation. The intent names the
    // observation choiceId, so the runner accepts it rather than reporting a
    // missing resource.
    const observeRun = runQml(harness(afterObserve, project, 'observe'))
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
    const authorizeRun = runQml(harness(afterProposal, project, 'authorize'))
    const authorizeIntent = capturedIntents(authorizeRun)[0]
    assert.equal(authorizeIntent.kind, 'authorize_adoption')
    composed.queue.push(JSON.stringify(authorizeIntent))
    host.tick()
    assert.equal(composed.results.at(-1)?.status, 'acknowledged')

    // The exact transport was asked to adopt, and only the committed delivery
    // makes the Run ready.
    const adoptFrame = port.last('adopt')
    assert.ok(adoptFrame, 'authorization must send the exact adopt frame')
    port.emit({ type: 'adopt_ack', runId: adoptFrame?.runId ?? '', bindingDigest: adoptFrame?.bindingDigest ?? '', nonce: adoptFrame?.nonce ?? '' })
    host.tick()
    const afterCommit = composed.rendered.at(-1) as Record<string, unknown>
    const committedAgent = (afterCommit.managedAgents as Array<{ agentRunId: string; piStatus: string }>)[0]
    assert.equal(committedAgent.piStatus, 'committed')
    port.emit({ type: 'readiness', runId: committedAgent.agentRunId, bindingDigest: adoptFrame?.bindingDigest ?? '' })
    host.tick()
    const readyAgent = (composed.rendered.at(-1) as { managedAgents: Array<{ piStatus: string }> }).managedAgents[0]
    assert.equal(readyAgent.piStatus, 'ready')

    // Phase 2 still delivers no Assignment and runs no acceptance check.
    assert.equal(runner.store.listEvents().filter(event => event.kind.startsWith('assignment')).length, 0)
    assert.equal((composed.rendered.at(-1)?.assignments as unknown[]).length, 0)
    assert.ok(runner.store.listEvents().some(event => event.kind === 'adoption_committed'))
    assert.ok(runner.store.listEvents().some(event => event.kind === 'adoption_ready'))
    host.stop()
  } finally {
    try { runner?.close() } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true })
  }
})
