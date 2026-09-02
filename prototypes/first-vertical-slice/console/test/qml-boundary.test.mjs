import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = resolve(TEST_DIR, '..', '..')
const CONSOLE_PLUGIN_ROOT = join(PROTOTYPE_ROOT, 'console', 'plugin')
const CONSOLE_QML = join(CONSOLE_PLUGIN_ROOT, 'AgentConsole.qml')
const CARDS_QML = join(CONSOLE_PLUGIN_ROOT, 'AgentConsoleCards.qml')
const MANIFEST = join(CONSOLE_PLUGIN_ROOT, 'manifest.json')

const REQUIRED_STATUSES = ['ready', 'reconnecting', 'gap']
const REQUIRED_ROLES = ['coordinator', 'builder', 'reviewer']

const COMMITTED_PROJECTION = {
  status: 'ready',
  cursor: 12,
  cards: [
    {
      role: 'coordinator',
      agentRunId: 'agent-run-coordinator-1',
      piStatus: 'Coordinator · waiting',
    },
    {
      role: 'builder',
      agentRunId: 'agent-run-builder-1',
      piStatus: 'Builder · managed',
    },
    {
      role: 'reviewer',
      agentRunId: 'agent-run-reviewer-1',
      piStatus: 'Reviewer · waiting',
    },
  ],
}

function source(path) {
  assert.ok(existsSync(path), `expected QML boundary file: ${path}`)
  return readFileSync(path, 'utf8')
}

function manifest() {
  assert.ok(existsSync(MANIFEST), `expected QML plugin manifest: ${MANIFEST}`)
  return JSON.parse(readFileSync(MANIFEST, 'utf8'))
}

function qmlFilesUnder(directory) {
  if (!existsSync(directory)) return []
  const entries = readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return qmlFilesUnder(path)
    return entry.isFile() && entry.name.endsWith('.qml') ? [path] : []
  })
}

function allQmlSources() {
  return [
    ...qmlFilesUnder(join(PROTOTYPE_ROOT, 'qml')),
    ...qmlFilesUnder(join(PROTOTYPE_ROOT, 'console')),
  ].sort()
}

function stripQmlComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function stripQmlCommentsAndStrings(value) {
  return stripQmlComments(value)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}

function combinedQmlSource() {
  return allQmlSources().map((path) => source(path)).join('\n')
}

test('the plugin manifest exposes a schema-versioned panel entry point', () => {
  const value = manifest()
  const consoleSource = stripQmlComments(source(CONSOLE_QML))

  assert.equal(value.schemaVersion, 1)
  assert.ok(Array.isArray(value.kinds) && value.kinds.includes('panel'))
  assert.equal(value.entryPoints?.panel, 'AgentConsole.qml')
  assert.match(String(value.id), /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  assert.doesNotMatch(String(value.id), /^omarchy\./)
  assert.equal(statSync(CONSOLE_QML).isFile(), true)
  assert.equal(statSync(CARDS_QML).isFile(), true)
  assert.match(consoleSource, /^import\s+Quickshell\b/m)
  assert.match(consoleSource, /\b(?:PanelWindow|FloatingWindow)\b/)
})

test('plain injected projection data exposes three opaque committed piStatus labels', () => {
  const consoleSource = stripQmlComments(source(CONSOLE_QML))
  const cardsSource = stripQmlComments(source(CARDS_QML))
  const labels = COMMITTED_PROJECTION.cards.map((card) => card.piStatus)

  assert.equal(COMMITTED_PROJECTION.cards.length, 3)
  assert.deepEqual(
    COMMITTED_PROJECTION.cards.map((card) => card.role),
    REQUIRED_ROLES,
  )
  assert.deepEqual(labels, [
    'Coordinator · waiting',
    'Builder · managed',
    'Reviewer · waiting',
  ])

  for (const status of REQUIRED_STATUSES) {
    const projection = { ...COMMITTED_PROJECTION, status }
    assert.equal(projection.cards.length, 3)
    assert.deepEqual(projection.cards.map((card) => card.piStatus), labels)
  }

  assert.match(consoleSource, /property\s+var\s+projection\b/)
  assert.match(consoleSource, /function\s+open\s*\(/)
  assert.match(consoleSource, /function\s+applyProjection\s*\(/)
  assert.match(consoleSource, /cards\s*\.\s*length\s*!==\s*3|cards\s*\.\s*length\s*===\s*3/)
  assert.match(cardsSource, /Repeater\s*\{[\s\S]*\bmodel\s*:/)
  assert.match(cardsSource, /\btext\s*:[^\n;]*\.piStatus\b/)
  assert.doesNotMatch(cardsSource, /["'](?:Coordinator|Builder|Reviewer)\s*[·:-]\s*(?:waiting|managed|manual_takeover)["']/)

  // The card label is one opaque committed value. QML must not split it or
  // rebuild it from role/control/assignment fields.
  assert.doesNotMatch(consoleSource + cardsSource, /\bpiStatus\s*\.\s*(?:split|replace|slice|substring|substr|match)\s*\(/)
  assert.doesNotMatch(consoleSource + cardsSource, /\b(?:role|controlMode|agentState|assignmentState)\s*\.\s*(?:toUpperCase|toLowerCase|replace|split)\s*\(/)
})

test('QML presents ready, reconnecting, and explicit gap states from injected projection status', () => {
  const value = stripQmlComments(source(CONSOLE_QML))

  assert.match(value, /\bprojection\.status\b|\broot\.projection\.status\b/)
  for (const status of REQUIRED_STATUSES) {
    assert.match(value, new RegExp(`["']${status}["']`), `missing explicit ${status} presentation`)
  }
})

test('all QML stays presentation-only and has no forbidden runtime dependencies', () => {
  const forbidden = [
    ['SQLite', /\b(?:sqlite|QSql|QSQLITE|node:sqlite|databasePath|openDatabase)\b/i],
    // The installed plugin may report its declared Companion protocol as
    // capability metadata; it still may not import or implement runner logic.
    ['runner-domain', /(?:src\/)?(?:domain|runner|orchestration|store|thin[-_ ]client|transport)\b/i],
    ['process supervision', /\b(?:Process|QProcess|child_process|spawn|exec(?:Detached|File)?|startDetached|kill|terminate|IpcHandler)\b/i],
    ['PTY access', /\b(?:pty|pseudo[-_ ]terminal|ansi|escape(?:Sequence|Code)|terminal(?:Output|Text|Input|Capture))\b/i],
    ['SSH or remote execution', /\b(?:ssh|remote(?:Host|Execution|Command)?)\b/i],
    ['terminal scraping', /\b(?:stdout|stderr|readAll|scrap(?:e|ing)|parseAnsi|capture(?:Terminal|Output))\b/i],
    ['storage or transport I/O', /\b(?:FileView|Settings|LocalStorage|XmlListModel|Socket|WebSocket|TcpSocket|UnixSocket|openFile|writeFile)\b/i],
  ]

  for (const path of allQmlSources()) {
    const value = stripQmlCommentsAndStrings(source(path))
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(value, pattern, `${name} dependency in ${path}`)
    }
  }
})

test('QML contains no role/state label maps or client-side label derivation', () => {
  const value = stripQmlCommentsAndStrings(combinedQmlSource())
  const derivationPatterns = [
    /\b(?:roleDisplayNames|stateDisplayNames|roleLabels|stateLabels|displayNameMap|labelMap|statusMap)\b/i,
    /\b(?:derive|format|build|compute)(?:Role|State|Status|Label)\b/i,
    /\bpiStatus\s*\.\s*(?:split|replace|slice|substring|substr|match|indexOf)\s*\(/i,
    /\b(?:role|controlMode|agentState|assignmentState)\s*\+\s*["'`]/i,
    /["'](?:Coordinator|Builder|Reviewer)\s*[·:-]\s*["']\s*\+/i,
  ]

  for (const pattern of derivationPatterns) {
    assert.doesNotMatch(value, pattern, `forbidden QML state-label derivation: ${pattern}`)
  }
})

test('QML syntax and lint pass through qmllint without launching a UI', () => {
  const files = [CONSOLE_QML, CARDS_QML]
  for (const path of files) source(path)

  const executable = process.env.QMLLINT_BIN || 'qmllint'
  const importDirectory = process.env.OMARCHY_QML_IMPORT_DIR || '/usr/share/omarchy/shell'
  const result = spawnSync(
    executable,
    ['-I', importDirectory, ...files],
    {
      cwd: PROTOTYPE_ROOT,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  )

  assert.equal(result.error, undefined, `could not execute ${executable}: ${result.error?.message || ''}`)
  assert.equal(
    result.status,
    0,
    `${executable} reported QML errors (this invokes only the static linter, never Quickshell):\n${result.stdout}\n${result.stderr}`,
  )
})

// ---------------------------------------------------------------------------
// Companion milestone boundary extensions (task 3.c)
// ---------------------------------------------------------------------------

test('the Companion manifest stays a panel-only surface advertising the companion protocol', () => {
  const value = manifest()
  assert.deepEqual(value.kinds, ['panel'], 'the plugin surface must stay panel-only')
  assert.deepEqual(Object.keys(value.entryPoints ?? {}), ['panel'], 'exactly one panel entry point')
  assert.equal(value.companion?.protocol, 'omarchestra.companion/v1')
  assert.doesNotMatch(
    JSON.stringify(value),
    /registerTemporaryPlugin|temporary-panel|\bomarchy\./i,
    'the manifest must not reference rejected registration paths',
  )
})

test('the adapted Companion QML gains no filesystem, cursor, reconnect, shell-command, terminal, or orchestration authority', () => {
  const extraForbidden = [
    ['filesystem access', /\b(?:FileReader|FileSystemModel|FolderListModel|readDir(?:Sync)?|readdir|rmdir|unlink|mkdir|openDir)\b/i],
    ['cursor computation', /\bcursor\s*(?:\+\+|--|\+=|-=|[+\-*\/]=)|\bcursor\s*[+\-*\/]\s*\d/],
    ['reconnect or resnapshot authority', /\b(?:reconnect|resnapshot|resumeAfter|event_page|recoveryCursor)\b/i],
    ['shell command execution', /\b(?:QProcess|omarchy-shell|hyprctl|systemctl|pkill|killall|popen)\b|\bexec\s*\(|\bbash\b/],
    ['terminal authority', /\b(?:ghostty|pty|terminal\s+(?:output|input|capture))\b/i],
    ['orchestration authority', /\b(?:orchestration|assignment\s+dispatch|writer\s+lease|adoption)\b/i],
    ['installation or configuration paths', /\bshell\.json\b|\.config\/omarchy/],
  ]
  for (const file of allQmlSources()) {
    const value = stripQmlCommentsAndStrings(source(file))
    for (const [name, pattern] of extraForbidden) {
      assert.doesNotMatch(value, pattern, `${name} in ${file}`)
    }
  }
})
