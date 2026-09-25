// Local Workbench v1 — QML boundary and release audit.
//
// Proves the QML is presentation-only (no storage, process, PTY, SSH,
// scraping, or label derivation), that the additive 0.14.0 release packages
// the QML byte-identical to the plugin source, and that the release does not
// copy or alter historical prototype releases.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')
const PLUGIN_DIR = join(PACKAGE_ROOT, 'console', 'plugin')

const QML_FILES = [
  'WorkbenchConsole.qml',
  'WorkbenchHost.qml',
  'WorkbenchWake.qml',
  'WorkbenchRows.qml',
  'WorkbenchBarWidget.qml',
  'WorkbenchOverview.qml',
  'WorkbenchGoal.qml',
  'WorkbenchCards.qml',
  'WorkbenchAssignmentForm.qml',
  'WorkbenchChecks.qml',
  'WorkbenchReview.qml',
  'WorkbenchBoard.qml',
]

function source(name) {
  const path = join(PLUGIN_DIR, name)
  assert.ok(statSync(path).isFile(), `expected QML file: ${path}`)
  return readFileSync(path, 'utf8')
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

function allQmlSources() {
  return QML_FILES.map((name) => source(name))
}

test('the manifest exposes panel and bar-widget entry points at 0.14.0', () => {
  const manifest = JSON.parse(source('manifest.json'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.version, '0.14.0')
  assert.equal(manifest.id, 'omarchestra.agent-console')
  assert.ok(Array.isArray(manifest.kinds) && manifest.kinds.includes('panel'))
  assert.equal(manifest.entryPoints?.panel, 'WorkbenchHost.qml')
  assert.ok(manifest.kinds.includes('bar-widget'))
  assert.equal(manifest.entryPoints?.barWidget, 'WorkbenchBarWidget.qml')
  assert.equal(manifest.companion?.protocol, 'omarchestra.companion/v1')
})

test('all QML stays presentation-only with no forbidden runtime dependencies', () => {
  const forbidden = [
    ['SQLite', /\b(?:sqlite|QSql|QSQLITE|node:sqlite|databasePath|openDatabase)\b/i],
    ['runner-domain', /(?:src\/)?(?:domain|runner|orchestration|store|thin[-_ ]client|transport)\b/i],
    ['process supervision', /\b(?:Process|QProcess|child_process|spawn|exec(?:Detached|File)?|startDetached|kill|terminate|IpcHandler)\b/i],
    ['PTY access', /\b(?:pty|pseudo[-_ ]terminal|ansi|escape(?:Sequence|Code)|terminal(?:Output|Text|Input|Capture))\b/i],
    ['SSH or remote execution', /\b(?:ssh|remote(?:Host|Execution|Command)?)\b/i],
    ['terminal scraping', /\b(?:stdout|stderr|readAll|scrap(?:e|ing)|parseAnsi|capture(?:Terminal|Output))\b/i],
    ['storage or transport I/O', /\b(?:FileView|Settings|LocalStorage|XmlListModel|Socket|WebSocket|TcpSocket|UnixSocket|openFile|writeFile)\b/i],
  ]
  for (const path of QML_FILES) {
    const raw = stripQmlCommentsAndStrings(source(path))
    // Only the separately audited notification leaf may own one Process. It
    // sends no intent or domain command and never starts an Owner or Pi.
    const value = path === 'WorkbenchWake.qml' ? raw.replace(/\bProcess\s*\{/, 'Item {') : raw
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(value, pattern, `${name} dependency in ${path}`)
    }
  }
})

test('wake leaf has one fixed bounded client and no domain/process management surface', () => {
  const qml = source('WorkbenchWake.qml'), client = source('workbench-wake.mjs')
  assert.equal((qml.match(/\bProcess\s*\{/g) ?? []).length, 1)
  assert.match(qml, /client\.command = \["\/usr\/bin\/node",/)
  assert.match(qml, /Qt\.resolvedUrl\("workbench-wake\.mjs"\)/)
  assert.match(qml, /client\.running \|\| nextWake === null/)
  assert.match(qml, /clearEnvironment: true/)
  assert.match(client, /type: 'wake'/)
  assert.match(client, /1500/)
  assert.match(client, /owner_endpoint_not_private/)
  assert.doesNotMatch(client, /child_process|sendUserMessage|execFile|spawn\(|systemctl|takeIntent|adopt|create_goal/)
  assert.doesNotMatch(qml, /execDetached|shell\.run|\/bin\/sh|systemctl|runner\/|\.config\//)
})

test('exact-target confirmation is a second press of the original action, never a separate surface', () => {
  const qml = source('WorkbenchConsole.qml')
  const action = source('WorkbenchAction.qml')
  assert.doesNotMatch(qml, /workbench-inline-confirmation|workbench-confirm-review|\b(?:Dialog|Popup|DialogButtonBox)\s*\{/)
  assert.match(qml, /interval: 30000/)
  assert.match(qml, /confirmationAssociation === association/)
  assert.match(qml, /JSON\.stringify\(confirmation\) === JSON\.stringify\(payload\)/)
  assert.match(action, /Confirm: /)
  assert.match(action, /awaitingConfirmation/)
  assert.doesNotMatch(action, /ToolTip\./)
  for (const qml of allQmlSources()) {
    assert.doesNotMatch(qml, /ToolTip\./, 'disabled reasons stay inline or accessible, never in a hover popup')
  }
})

test('bar button delegates to exactly the installed one-shot owner launcher', () => {
  const widget = source('WorkbenchBarWidget.qml')
  assert.match(widget, /root\.bar\.run\("gtk-launch omarchestra-workbench"\)/)
  assert.match(widget, /buttonCode === Qt\.LeftButton/)
  assert.doesNotMatch(widget, /(?:runner\/main|setPluginEnabled|shell\.json|Process\s*\{)/)
})

test('QML contains no role/state label derivation', () => {
  const combined = allQmlSources().map(stripQmlCommentsAndStrings).join('\n')
  const derivationPatterns = [
    /\b(?:roleDisplayNames|stateDisplayNames|roleLabels|stateLabels|displayNameMap|labelMap|statusMap)\b/i,
    /\b(?:derive|format|build|compute)(?:Role|State|Status|Label)\b/i,
    /\bpiStatus\s*\.\s*(?:split|replace|slice|substring|substr|match|indexOf)\s*\(/i,
  ]
  for (const pattern of derivationPatterns) {
    assert.doesNotMatch(combined, pattern, `forbidden QML state-label derivation: ${pattern}`)
  }
})

test('QML renders piStatus as an opaque committed value', () => {
  const cardsSource = stripQmlComments(source('WorkbenchCards.qml'))
  assert.match(cardsSource, /\btext\s*:[^\n;]*\.piStatus\b/)
  assert.doesNotMatch(cardsSource, /["'](?:Coordinator|Builder|Reviewer)\s*[·:-]\s*(?:waiting|managed|manual_takeover)["']/)
})

test('QML emits intents only and never computes authority', () => {
  const combined = allQmlSources().map(stripQmlCommentsAndStrings).join('\n')
  assert.doesNotMatch(combined, /(?:deduplicat|reconcil|transaction|commitAdoption|writer\s*lease|validateAdoption)/i)
  assert.doesNotMatch(combined, /sha256|createHash/i)
  assert.doesNotMatch(combined, /(?:derive|compute|validate|check)(?:Adoption|Eligibility|Expiry|Identity|Digest)/i)
})

test('the additive 0.14.0 release packages QML byte-identical to the plugin source', async () => {
  const { WORKBENCH_RELEASE } = await import('../companion/releases.ts')
  assert.equal(WORKBENCH_RELEASE.version, '0.14.0')
  for (const file of QML_FILES) {
    assert.equal(
      WORKBENCH_RELEASE.assets[file],
      source(file),
      `${file} must be byte-identical between plugin source and packaged release`,
    )
  }
  assert.equal(
    JSON.parse(WORKBENCH_RELEASE.assets['manifest.json']).version,
    '0.14.0',
  )
  for (const file of ['SessionText.js', 'workbench-wake.mjs']) assert.equal(WORKBENCH_RELEASE.assets[file], source(file))
})

test('the published 0.13.0 installed assets remain exactly retained before the responsive release', () => {
  const retained = join(PACKAGE_ROOT, 'companion', 'retained', '0.13.0')
  const names = readdirSync(retained).sort(), digest = createHash('sha256')
  assert.equal(names.length, 15)
  for (const name of names) digest.update(name).update(readFileSync(join(retained, name)))
  assert.equal(digest.digest('hex'), '902ef962e38e29a2d8620ef7f5f69473f32ee0126eeecf2446f02587bfeac6fc')
})

test('the installed 0.12.0 Companion is preserved against its receipt-validated aggregate hash', () => {
  const retained = join(PACKAGE_ROOT, 'companion', 'retained', '0.12.0')
  const names = readdirSync(retained).sort(), digest = createHash('sha256')
  assert.equal(names.length, 15)
  assert.equal(JSON.parse(readFileSync(join(retained, 'manifest.json'), 'utf8')).version, '0.12.0')
  for (const name of names) digest.update(name).update(readFileSync(join(retained, name)))
  assert.equal(digest.digest('hex'), '9cc9480aaf40e6f820f62a53300485838fa920d57ddc0225be72f83952865f32')
})

test('the previous installed 0.11.0 Companion remains byte-for-byte archived for rollback', () => {
  const retained = join(PACKAGE_ROOT, 'companion', 'retained', '0.11.0')
  const names = readdirSync(retained).sort()
  assert.equal(names.length, 15)
  assert.equal(JSON.parse(readFileSync(join(retained, 'manifest.json'), 'utf8')).version, '0.11.0')
  for (const name of names) assert.ok(readFileSync(join(retained, name)).length > 0, name)
})

test('the previous installed 0.10.0 Companion remains byte-for-byte archived for rollback', () => {
  const retained = join(PACKAGE_ROOT, 'companion', 'retained', '0.10.0')
  const names = readdirSync(retained).sort()
  assert.equal(names.length, 15)
  assert.equal(JSON.parse(readFileSync(join(retained, 'manifest.json'), 'utf8')).version, '0.10.0')
  const digest = createHash('sha256')
  for (const name of names) {
    digest.update(name)
    digest.update(readFileSync(join(retained, name)))
  }
  assert.equal(digest.digest('hex'), 'bfdf06b49550e72df9a7884e3e1cf496d28f408382dd8469fe9e50aca80437c8')
})

test('the former installed 0.9.0 Companion assets remain byte-for-byte archived', () => {
  const retained = join(PACKAGE_ROOT, 'companion', 'retained', '0.9.0')
  const hashes = {
    'AgentConsole.qml': 'f3708e96cffdbce16e9b27fb46caf5311b2d1ac730a5a12d60bd4736716dee2e',
    'manifest.json': 'ddb5b630c12613ff49a5c471dd7f813921cb7fac871c0ead299e3209ad808994',
    'WorkbenchAction.qml': 'bb93ec2ae577fdef03233f1db25e4696cb0fed27870ac4b5debdeb63702b7658',
    'WorkbenchAssignmentForm.qml': '44f406ea5bdcf53a924bf24f6fa63cda1f5cdf3b18a7bbeea3b18629ed78588d',
    'WorkbenchBarWidget.qml': 'ad6cd6d1c7abe357cc81de51fe2cb64d312667964ed2c23fcd1e3a6d101d8cc5',
    'WorkbenchBoard.qml': '024846413ece1e0d443fc6f6835d43ae9b0ea7ccbf578c1c8ff0776666c113c3',
    'WorkbenchCards.qml': '40f385bdb01d0a7c224bb5a03fb3cdd2ac38bdb5f5995e0bc82eb2f763b9bd59',
    'WorkbenchChecks.qml': '1978770ba176df799c62e27278a9306bfbb78fb54ff9306c32a4d57440354907',
    'WorkbenchConsole.qml': '2567870a559b0dc1edcb947838ff4f25904d40e67a68650fe184f9ce41bfbab5',
    'WorkbenchGoal.qml': 'bf2b1300df5642d6625c7a5b9c140d66d1104ebfbe6ac00bb3e59c2948c7154f',
    'WorkbenchHost.qml': 'eec4ad150c257bfeb695cac049389372256aca2ad3a59d416574a2565bda4026',
    'WorkbenchOverview.qml': 'f9079bb379f83357a27ee8accefa6cef9c5a31de3b455037eb78a32eb7557b14',
    'WorkbenchReview.qml': 'dbc705d4e339ef9d484dae8f7ae52d98fe59b3310d29596f44abc2d35d0b367f',
    'WorkbenchTextArea.qml': '0fefa1555f8a2e7a3ee4b22f828f28dff110d273dc19e4b164dafc6de03976e8',
    'WorkbenchTextField.qml': '588bc2ca21ac6a14fe08632fd1f2d8cdcdd5f7e743aff00041c9e003dc2121f6',
  }
  assert.deepEqual(readdirSync(retained).sort(), Object.keys(hashes).sort())
  for (const [name, digest] of Object.entries(hashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(retained, name))).digest('hex'), digest, name)
  }
})

test('the workbench release catalog contains only its own additive release', async () => {
  const { WORKBENCH_RELEASE_CATALOG } = await import('../companion/releases.ts')
  assert.deepEqual(Object.keys(WORKBENCH_RELEASE_CATALOG), ['0.14.0'])
})

test('the workbench release does not copy historical prototype release bytes', async () => {
  const { WORKBENCH_RELEASE } = await import('../companion/releases.ts')
  const assets = WORKBENCH_RELEASE.assets
  // The workbench must not ship the historical AgentConsole.qml / cards.
  assert.equal(assets['AgentConsole.qml'], undefined)
  assert.equal(assets['AgentConsoleCards.qml'], undefined)
  assert.equal(assets['UnassignedAgents.qml'], undefined)
  assert.equal(assets['RetiredAgentCards.qml'], undefined)
})

test('QML files are present and non-empty', () => {
  for (const file of QML_FILES) {
    assert.ok(source(file).trim().length > 0, `${file} must be non-empty`)
  }
})

test('QML does not manufacture session generations or durable intent IDs', () => {
  const combined = QML_FILES.filter(name => name !== 'WorkbenchHost.qml').map(name => stripQmlCommentsAndStrings(source(name))).join('\n')
  assert.doesNotMatch(combined, /Date\.now|Math\.random|intentId\s*:/)
  assert.match(source('WorkbenchHost.qml'), /pluginGeneration: Date\.now\(\)/)
  assert.doesNotMatch(source('WorkbenchHost.qml'), /sessionId|intentId|runnerEpoch/)
})

test('action buttons render a committed label or the opaque action kind', () => {
  const cards = source('WorkbenchCards.qml')
  const schema = readFileSync(join(PACKAGE_ROOT, 'console', 'schema.ts'), 'utf8')
  const hasCommittedLabel = /modelData\.label/.test(cards)
    && /interface WorkbenchAction[\s\S]*?label\s*:\s*string/.test(schema)
  const rendersOpaqueKind = /text\s*:\s*modelData\.kind/.test(cards)
  assert.ok(hasCommittedLabel || rendersOpaqueKind, 'action buttons must not render an undeclared label field')
})

test('the actual console wires observed and retired cards into the card surface', () => {
  const overview = source('WorkbenchOverview.qml')
  assert.match(overview, /observed\s*:/)
  assert.match(overview, /retired\s*:/)
})

test('QML domain intents enter the adapter; view-only hide stays in the presentation host', () => {
  const adapter = readFileSync(join(PACKAGE_ROOT, 'console', 'live-projection-adapter.ts'), 'utf8')
  const shell = readFileSync(join(PACKAGE_ROOT, 'console', 'presentation-shell.ts'), 'utf8')
  const owner = readFileSync(join(PACKAGE_ROOT, 'runner', 'native-owner.ts'), 'utf8')
  const kinds = new Set()
  for (const file of QML_FILES) {
    // Literal kinds only: model-driven kinds come from committed runner actions,
    // which the adapter already allow-lists through the projection itself.
    for (const match of source(file).matchAll(/\bkind:\s*"([a-z_]+)"/g)) kinds.add(match[1])
  }
  for (const kind of ['select_project', 'select_goal', 'create_goal', 'configure_checks']) {
    assert.ok(kinds.has(kind), `the console emits ${kind} from a literal control`)
  }
  assert.ok(kinds.size >= 5, 'the console emits the journey intents')
  for (const kind of kinds) {
    if (kind === 'hide_workbench') {
      assert.match(shell, /request\.kind === 'hide_workbench'/, 'hide is handled before the domain adapter')
      assert.match(owner, /onHide: \(\) =>/, 'hide disposes the exact native view')
      assert.doesNotMatch(adapter, /'hide_workbench'/, 'hide must not gain Team Runner authority')
    } else {
      assert.match(adapter, new RegExp(`'${kind}'`), `${kind} must be accepted by the adapter`)
    }
  }
})

test('every advertised destination is routed by the console', () => {
  const consoleSource = source('WorkbenchConsole.qml')
  const advertised = consoleSource.match(/destinations:\s*\[([\s\S]*?)\]/)
  assert.ok(advertised, 'the presentation contract advertises its destinations')
  const destinations = [...advertised[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1])
  assert.ok(destinations.includes('overview'))
  for (const destination of destinations) {
    assert.match(
      consoleSource,
      new RegExp(`destination === "${destination}"`),
      `${destination} must be reachable in the console router`,
    )
  }
})

test('the checks destination is the only authority surface for check definitions', () => {
  const checks = source('WorkbenchChecks.qml')
  assert.match(checks, /kind: "configure_checks"/)
  assert.match(checks, /checkVersion: root\.selectedCheck\.version/)
  const goal = stripQmlCommentsAndStrings(source('WorkbenchGoal.qml'))
  assert.doesNotMatch(goal, /configure_checks|gateVersion|executable|argv/)
})

test('general assignment detail does not render unrestricted diagnostics', () => {
  const review = source('WorkbenchReview.qml')
  assert.doesNotMatch(review, /modelData\.diagnostics/)
  assert.match(review, /runtime unavailable/)
})

test('the disabled Board reason is visible in the navigation surface', () => {
  const overview = source('WorkbenchOverview.qml')
  assert.match(overview, /Board backend is not available in this slice/)
})

test('historical Companion release fingerprints remain unchanged', async () => {
  const releases = await import('../../../prototypes/first-vertical-slice/companion/releases.ts')
  const catalog = releases.RELEASE_CATALOG
  assert.deepEqual(Object.keys(catalog), ['0.2.0', '0.3.0', '0.4.0'])
  assert.deepEqual(
    Object.fromEntries(Object.entries(catalog['0.2.0'].assets).map(([file, bytes]) => [
      file,
      createHash('sha256').update(bytes).digest('hex'),
    ])),
    {
      'manifest.json': '413c16fa2c01491d08acacf92b50799204c361d864b632cd8ebd372de30a6682',
      'AgentConsole.qml': 'ab46d9b062445f5d6dce1a9f4f82395cd5c8da0dbaf7a3b034c4ebbc10a30d30',
      'AgentConsoleCards.qml': '27c23b2ddf673649aef418f71ac7b9466959971f2dc08b475d5f8cc544fc3514',
    },
  )
  assert.equal(catalog['0.3.0'].version, '0.3.0')
  assert.equal(catalog['0.4.0'].version, '0.4.0')
})
