import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateSnapshot } from '../console/schema.ts'
import { narrowFixture, wideFixture, boardDisabledFixture } from '../fixtures/projections.ts'
import { journeyFixture } from '../fixtures/journey.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(here, '..', 'console', 'plugin')

function source(name) {
  return readFileSync(join(PLUGIN_DIR, name), 'utf8')
}

test('narrow and wide fixtures validate as snapshots', () => {
  assert.equal(validateSnapshot(narrowFixture).fixture.label, 'narrow layout')
  assert.equal(validateSnapshot(wideFixture).fixture.label, 'wide layout')
})

test('the console keeps a fixed dock surface while contextual content replaces itself', () => {
  const consoleSource = source('WorkbenchConsole.qml')
  // One contextual destination at a time, all inside the same fixed surface.
  for (const name of ['WorkbenchOverview', 'WorkbenchGoal', 'WorkbenchAssignmentForm', 'WorkbenchChecks', 'WorkbenchReview']) {
    assert.match(consoleSource, new RegExp(`${name}\\s*\\{`), `${name} is composed into the console`)
  }
  assert.doesNotMatch(consoleSource, /WorkbenchDetail\s*\{/)
  assert.match(consoleSource, /readonly property int panelWidth: Style\.space\(\d+\)/)
  assert.match(consoleSource, /readonly property int panelHeight: Style\.space\(\d+\)/)
  // The layer surface must not resize with content, or the shell re-reserves
  // compositor edge space and neighbouring terminals shift.
  const geometry = consoleSource.match(/^        implicit(?:Width|Height):.*$/gm) ?? []
  assert.equal(geometry.length, 2)
  for (const line of geometry) {
    assert.doesNotMatch(line, /destination|confirmation|drafts|menuOpen|projectListOpen|startReview/)
    assert.match(line, /root\.panelWidth|root\.panelHeight/)
  }
})

test('the console renders a persistent fixture-mode label', () => {
  const consoleSource = source('WorkbenchConsole.qml')
  assert.match(consoleSource, /fixture\.active/)
  assert.match(consoleSource, /"Preview · "/)
  assert.equal(validateSnapshot(journeyFixture).fixture.active, true)
})

test('the Board surface is visibly disabled with a reason and emits no intent', () => {
  const boardSource = source('WorkbenchBoard.qml')
  assert.match(boardSource, /enabled: false/)
  assert.match(boardSource, /Board backend is not available in this slice/)
  assert.doesNotMatch(boardSource, /intentRequested/)
  assert.doesNotMatch(boardSource, /onClicked/)
})

test('the overview exposes the journey entry points and a disabled Board', () => {
  const overviewSource = source('WorkbenchOverview.qml')
  assert.match(overviewSource, /"New Team Goal"/)
  assert.match(overviewSource, /"Add agent"/)
  assert.match(overviewSource, /"Prepare assignment"/)
  assert.match(overviewSource, /"Checks"/)
  assert.match(overviewSource, /"Work and result"/)
  assert.match(overviewSource, /"Board"/)
  assert.match(overviewSource, /enabled: false/)
})

test('the console renders runner status and connection states', () => {
  const consoleSource = source('WorkbenchConsole.qml')
  assert.match(consoleSource, /"Runner: "/)
  assert.match(consoleSource, /connection/)
})

test('the console emits intents only through the presentation-intent surface', () => {
  const consoleSource = source('WorkbenchConsole.qml')
  assert.match(consoleSource, /signal intentRequested\(var payload\)/)
  assert.match(consoleSource, /function emitIntent\(/)
  assert.match(consoleSource, /pendingIntents\.length >= 16/)
})

test('boardDisabled fixture carries the disabled board marker', () => {
  assert.equal(validateSnapshot(boardDisabledFixture).fixture.label, 'board disabled')
})
