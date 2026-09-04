// PROTOTYPE — NOT PRODUCTION.
//
// Static reachability and privacy audit for the observer bridge. This test is
// fake-only: it reads source and the justfile, but never imports a live shell,
// opens a socket, reads user state, launches Pi, or invokes desktop controls.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const OBSERVER_ROOT = path.resolve(TEST_DIR, '..')
const PROTOTYPE_ROOT = path.resolve(OBSERVER_ROOT, '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const MANUAL_ROOT = path.join(PROTOTYPE_ROOT, 'manual')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')

const PURE_BRIDGE_MODULES = [
  path.join(OBSERVER_ROOT, 'live-frame-channel.ts'),
  path.join(OBSERVER_ROOT, 'live-gateway-core.ts'),
  path.join(OBSERVER_ROOT, 'live-companion-projection.ts'),
]
const MANUAL_BRIDGE_MODULES = [
  path.join(MANUAL_ROOT, 'live-observer-transport.ts'),
  path.join(MANUAL_ROOT, 'live-observer-extension.ts'),
  path.join(MANUAL_ROOT, 'live-observer-gateway.ts'),
]
const FAKE_ENTRYPOINTS = [
  path.join(OBSERVER_ROOT, 'test', 'live-frame-channel.test.ts'),
  path.join(OBSERVER_ROOT, 'test', 'live-gateway-core.test.ts'),
  path.join(OBSERVER_ROOT, 'test', 'live-companion-projection.test.ts'),
  path.join(OBSERVER_ROOT, 'test', 'live-observer-bridge.test.ts'),
  path.join(MANUAL_ROOT, 'test', 'live-observer-launcher.test.mjs'),
]

function read(file) {
  assert.equal(fs.existsSync(file), true, `expected file: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function shellWithoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function collectImportGraph(entry) {
  const visited = new Set()
  const visit = (file) => {
    const resolved = path.resolve(file)
    if (visited.has(resolved) || !fs.existsSync(resolved)) return
    visited.add(resolved)
    const source = read(resolved)
    const imports = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(imports)) {
      if (match[1].startsWith('.')) visit(path.resolve(path.dirname(resolved), match[1]))
    }
  }
  visit(entry)
  return visited
}

function justRecipeBody(source, recipe) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${recipe}:`))
  if (start < 0) return null
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && !/^\s/.test(line) && /^[A-Za-z0-9_.-]+(?:\s+\*\w+)?\s*:/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

const FORBIDDEN_LIVE_PRIMITIVES = [
  ['child process', /node:child_process|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/],
  ['Pi launch', /(?:^|\s)(?:env\s+)?pi\s+(?:-e|--mode|--extension)\b/i],
  ['desktop control', /\b(?:ghostty|hyprctl|quickshell|boomux|systemctl|systemd-run|journalctl)\b/i],
  ['remote process', /\b(?:ssh|scp|sftp)\b/i],
  ['PTY or terminal scraping', /\bpty\b|pseudo[- ]terminal|parseAnsi|terminal scraping/i],
]

for (const [name, pattern] of FORBIDDEN_LIVE_PRIMITIVES) {
  // Keep the list visible in failure output and make accidental additions to
  // this audit difficult to hide in a helper.
  assert.equal(typeof name, 'string')
  assert.ok(pattern instanceof RegExp)
}

test('pure observer bridge modules have no live I/O or authority imports', () => {
  for (const file of PURE_BRIDGE_MODULES) {
    const source = stripComments(read(file))
    assert.doesNotMatch(source, /node:(?:fs|net|dgram|http|https|tls|child_process)/,
      `${path.basename(file)} must remain transport-injected`)
    for (const [name, pattern] of FORBIDDEN_LIVE_PRIMITIVES) {
      assert.doesNotMatch(source, pattern, `${name} reached ${path.relative(PROTOTYPE_ROOT, file)}`)
    }
    assert.doesNotMatch(source, /(?:from|import)\s+['"][^'"]*(?:adoption|installation|projection-session|live-companion-omarchy)[^'"]*['"]/i)
  }
})

test('manual observer seams are explicit and do not create Pi, terminal, or Adoption authority', () => {
  const transport = stripComments(read(MANUAL_BRIDGE_MODULES[0]))
  const extension = stripComments(read(MANUAL_BRIDGE_MODULES[1]))
  const gateway = stripComments(read(MANUAL_BRIDGE_MODULES[2]))

  assert.match(transport, /node:net/)
  assert.match(transport, /server\.listen\(socketPath\)/)
  assert.match(transport, /chmodSync\(socketPath/)
  assert.match(transport, /stat\.dev|stat\.ino/)
  assert.match(transport, /removeSocketExact/)
  assert.doesNotMatch(transport, /node:(?:dgram|http|https|tls)/)
  assert.doesNotMatch(transport, /\b(?:port|host)\s*:/i)
  assert.doesNotMatch(transport, /\b(?:spawn|exec|fork)\s*\(/)

  assert.match(extension, /connectObserverSocket/)
  assert.match(extension, /OMARCHESTRA_OBSERVER_SOCKET/)
  assert.doesNotMatch(extension, /process\.stdin|process\.stdout|process\.env\.(?!OMARCHESTRA_OBSERVER_SOCKET)/)
  assert.doesNotMatch(extension, /sendUserMessage|ctx\.cwd|ProjectionSessionManager|adoption\.ts/i)
  for (const [name, pattern] of FORBIDDEN_LIVE_PRIMITIVES) {
    assert.doesNotMatch(extension, pattern, `${name} reached the Pi extension entrypoint`)
  }

  assert.match(gateway, /ObserverUnixSocketServer/)
  assert.match(gateway, /ProcessMonotonicObserverClock/)
  assert.match(gateway, /applyObservedAgents|LiveCompanionProjection/)
  assert.match(gateway, /status.*pause.*resume.*quit|status \| pause \| resume \| quit/s)
  assert.doesNotMatch(gateway, /node:child_process|sendUserMessage|ProjectionSessionManager|adoption\.ts/i)
  assert.doesNotMatch(gateway, /(?:summon|enable|disable|rescan|uninstall|install)\s*\(/i)
  for (const [name, pattern] of FORBIDDEN_LIVE_PRIMITIVES) {
    assert.doesNotMatch(gateway, pattern, `${name} reached the observer gateway entrypoint`)
  }
})

test('fake observer entrypoints cannot reach live adapters, installed state, Adoption, or managed work', () => {
  const forbidden = [
    'manual/live-observer-transport.ts',
    'manual/live-observer-extension.ts',
    'manual/live-observer-gateway.ts',
    'manual/live-companion-omarchy.ts',
    'manual/live-bridge-core.ts',
    'manual/live-role-label-extension.ts',
    'companion/installation.ts',
    'companion/projection-session.ts',
    'observer/adoption.ts',
    'src/runner.ts',
    'src/store.ts',
    'src/transport.ts',
    'src/visible-bridge.ts',
  ]
  for (const entry of FAKE_ENTRYPOINTS) {
    const graph = [...collectImportGraph(entry)].map((file) => path.relative(PROTOTYPE_ROOT, file))
    for (const banned of forbidden) {
      assert.equal(graph.includes(banned), false,
        `${path.relative(PROTOTYPE_ROOT, entry)} reaches ${banned}`)
    }
  }
})

test('fake-only recipe invokes only tests, syntax checks, and no-resource --check', () => {
  const justfile = read(JUSTFILE)
  const body = justRecipeBody(justfile, 'prototype-live-observer-check')
  assert.ok(body !== null, 'missing prototype-live-observer-check recipe')
  assert.match(body, /live-observer-launcher\.test\.mjs/)
  assert.match(body, /live-observer-bridge\.test\.ts/)
  assert.match(body, /live-bridge-source-audit\.test\.mjs/)
  assert.match(body, /run-live-observer-bridge\.sh" --check/)

  const executable = shellWithoutComments(body)
  assert.doesNotMatch(executable, /(?:^|\s)--live(?:\s|$)/)
  assert.doesNotMatch(executable, /\b(?:pi|omarchy-shell|ghostty|hyprctl|quickshell|boomux|ssh|scp|sftp|systemctl|systemd-run)\b/i)
  assert.doesNotMatch(executable, /--fingerprint|\.config\/omarchy|\.pi\//i)
  assert.doesNotMatch(executable, /manual\/live-observer-(?:transport|extension|gateway)\.ts/)
  assert.doesNotMatch(executable, /manual\/live-companion-omarchy\.ts|companion\/installation\.ts/)
  assert.doesNotMatch(executable, /observer\/adoption\.ts|src\/(?:runner|store|transport|visible-bridge)\.ts/)
  assert.doesNotMatch(executable, /\btee\b|(?:^|[/'"])evidence(?:\/|[/'"])/m)
  assert.doesNotMatch(executable, /run-live-observer-bridge\.sh\s+--live/)

  const humanBody = justRecipeBody(justfile, 'prototype-live-observer-bridge')
  assert.ok(humanBody !== null, 'missing prototype-live-observer-bridge recipe')
  assert.match(humanBody, /run-live-observer-bridge\.sh['"]? --live/)
})

test('launcher --check branch cannot inspect user state or invoke live paths', () => {
  const script = shellWithoutComments(read(path.join(MANUAL_ROOT, 'run-live-observer-bridge.sh')))
  const start = script.indexOf('if [[ "${1:-}" == "--check" ]]')
  const end = script.indexOf('\nfi', start)
  assert.ok(start >= 0 && end > start)
  const branch = script.slice(start, end)
  assert.match(branch, /bash -n/)
  assert.match(branch, /\$GATEWAY.*--check/)
  assert.doesNotMatch(branch, /HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|mktemp|mkdir|omarchy-shell|--fingerprint/i)
  assert.doesNotMatch(branch, /\bpi\s+-e|ghostty|hyprctl|systemctl|boomux|ssh/i)
})

test('observer privacy and projection audits remain content-free and unassigned', () => {
  const extension = stripComments(read(path.join(OBSERVER_ROOT, 'extension-adapter.ts')))
  const projection = stripComments(read(path.join(OBSERVER_ROOT, 'live-companion-projection.ts')))
  const gateway = stripComments(read(path.join(OBSERVER_ROOT, 'live-gateway-core.ts')))
  const projectionValidator = stripComments(read(path.join(OBSERVER_ROOT, 'companion-projection.ts')))

  for (const hook of [
    'input', 'message_start', 'message_update', 'message_end', 'tool_call', 'tool_result',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'context',
    'before_agent_start', 'agent_end', 'turn_start', 'turn_end', 'user_bash',
    'before_provider_request', 'after_provider_response',
  ]) {
    assert.doesNotMatch(extension, new RegExp(`\\.on\\(\\s*['"]${hook}['"]`), `forbidden hook ${hook}`)
  }
  assert.doesNotMatch(extension, /getEntries|getBranch|buildContextEntries|getSystemPrompt|ctx\.cwd|sendUserMessage|pi\.exec/)
  assert.match(projection, /applyObservedAgents/)
  assert.match(projectionValidator, /Unassigned · observed/)
  assert.match(gateway, /choices: \[\]/)
  assert.doesNotMatch(projection, /summon|clear|hide|ProjectionSessionManager|submitObserverIntent|observedIntentResult/i)
  assert.doesNotMatch(gateway, /adoption\.ack.*(?:registry|commit)|Team Goal|Assignment|sendUserMessage/i)
})
