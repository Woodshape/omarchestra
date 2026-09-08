// PROTOTYPE — NOT PRODUCTION.
//
// Static reachability and privacy audit for the live Adoption slice. This test
// is fake-only: it reads source and the justfile, but never imports a live
// shell, opens a socket, reads user state, launches Pi, or invokes desktop
// controls.

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

const PURE_ADOPTION_MODULES = [
  path.join(OBSERVER_ROOT, 'live-adoption-store.ts'),
  path.join(OBSERVER_ROOT, 'live-adoption-runner.ts'),
  path.join(OBSERVER_ROOT, 'live-adoption-gateway-core.ts'),
  path.join(OBSERVER_ROOT, 'live-adoption-companion.ts'),
]
const FAKE_ENTRYPOINTS = [
  path.join(OBSERVER_ROOT, 'test', 'live-adoption-runner.test.ts'),
  path.join(OBSERVER_ROOT, 'test', 'live-adoption-gateway.test.ts'),
  path.join(OBSERVER_ROOT, 'test', 'live-adoption-companion.test.ts'),
]
const DURABILITY_ENTRYPOINT = path.join(OBSERVER_ROOT, 'test', 'live-adoption-durability.test.ts')

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
  ['provider request', /\b(?:curl|wget)\b|before_provider_request|after_provider_response/i],
]

test('pure Adoption modules have no live I/O, SQLite, or manual/live adapter imports', () => {
  for (const file of PURE_ADOPTION_MODULES) {
    const source = stripComments(read(file))
    assert.doesNotMatch(source, /node:(?:fs|net|dgram|http|https|tls|child_process|sqlite)/,
      `${path.basename(file)} must remain transport/persistence-injected`)
    for (const [name, pattern] of FORBIDDEN_LIVE_PRIMITIVES) {
      assert.doesNotMatch(source, pattern, `${name} reached ${path.relative(PROTOTYPE_ROOT, file)}`)
    }
    assert.doesNotMatch(source, /(?:from|import)\s+['"][^'"]*(?:manual\/|installation|projection-session|live-companion-omarchy)[^'"]*['"]/i)
  }
})

test('fake Adoption entrypoints cannot reach the durable adapter, SQLite, sockets, or live authority', () => {
  const forbidden = [
    'manual/live-adoption-store.ts',
    'manual/live-observer-transport.ts',
    'manual/live-observer-extension.ts',
    'manual/live-observer-gateway.ts',
    'manual/live-companion-omarchy.ts',
    'companion/installation.ts',
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
    const source = stripComments(read(entry))
    assert.doesNotMatch(source, /node:sqlite|node:net|node:child_process|sendUserMessage|pi\.exec/i)
  }
})

test('only the durability test reaches the durable SQLite adapter', () => {
  const graph = [...collectImportGraph(DURABILITY_ENTRYPOINT)].map((file) => path.relative(PROTOTYPE_ROOT, file))
  assert.equal(graph.includes('manual/live-adoption-store.ts'), true,
    'durability test must exercise the durable adapter')
  const source = stripComments(read(DURABILITY_ENTRYPOINT))
  assert.doesNotMatch(source, /node:net|node:child_process|sendUserMessage|pi\.exec|ghostty|hyprctl|boomux|ssh|systemctl/i)
})

test('the managed-bridge test exercises the extension without opening a resource or reaching the durable adapter', () => {
  const entry = path.join(OBSERVER_ROOT, 'test', 'live-adoption-managed-bridge.test.ts')
  const graph = [...collectImportGraph(entry)].map((file) => path.relative(PROTOTYPE_ROOT, file))
  assert.equal(graph.includes('manual/live-adoption-store.ts'), false,
    'managed-bridge test must not reach the durable SQLite adapter')
  const source = stripComments(read(entry))
  assert.doesNotMatch(source, /node:net|node:child_process|sendUserMessage|pi\.exec|ghostty|hyprctl|boomux|ssh|systemctl/i)
})

test('the dedicated live-Adoption recipe is fake-only and cannot invoke live mode or write evidence', () => {
  const justfile = read(JUSTFILE)
  const body = justRecipeBody(justfile, 'prototype-live-adoption-check')
  assert.ok(body !== null, 'missing prototype-live-adoption-check recipe')
  assert.match(body, /live-adoption-runner\.test\.ts/)
  assert.match(body, /live-adoption-gateway\.test\.ts/)
  assert.match(body, /live-adoption-companion\.test\.ts/)
  assert.match(body, /live-adoption-durability\.test\.ts/)
  assert.match(body, /live-adoption-composed\.test\.ts/)

  const executable = shellWithoutComments(body)
  assert.doesNotMatch(executable, /(?:^|\s)--live(?:\s|$)/)
  assert.doesNotMatch(executable, /\b(?:pi|omarchy-shell|ghostty|hyprctl|quickshell|boomux|ssh|scp|sftp|systemctl|systemd-run)\b/i)
  assert.doesNotMatch(executable, /manual\/live-adoption-store\.ts|manual\/live-observer-(?:transport|extension|gateway)\.ts/)
  assert.doesNotMatch(executable, /\btee\b|(?:^|[/'"])evidence(?:\/|[/'"])/m)
})

test('the human-only Adoption launcher --check branch is no-resource and cannot launch Pi', () => {
  const script = shellWithoutComments(read(path.join(MANUAL_ROOT, 'run-live-adoption-bridge.sh')))
  const start = script.indexOf('if [[ "${1:-}" == "--check" ]]')
  const end = script.indexOf('\nfi', start)
  assert.ok(start >= 0 && end > start)
  const branch = script.slice(start, end)
  assert.match(branch, /bash -n/)
  assert.match(branch, /\$GATEWAY.*--check/)
  assert.doesNotMatch(branch, /HOME|XDG_STATE_HOME|XDG_RUNTIME_DIR|mktemp|mkdir|omarchy-shell|--fingerprint/i)
  assert.doesNotMatch(branch, /\bpi\s+-e|ghostty|hyprctl|systemctl|boomux|ssh/i)
})

test('manual Adoption entrypoints require TTY and exact authorization before authority resources', () => {
  const gateway = read(path.join(MANUAL_ROOT, 'live-adoption-gateway.ts'))
  const run = gateway.slice(gateway.indexOf('export async function runLiveAdoptionGateway'))
  assert.ok(run.indexOf('assertInteractiveTTY()') >= 0)
  assert.ok(run.indexOf('await requestAuthorization()') < run.indexOf('new AdoptionRuntimeOwnership'))
  const launcher = read(path.join(MANUAL_ROOT, 'run-live-adoption-bridge.sh'))
  const stop = launcher.indexOf('if [[ ! -t 0 || ! -t 1 ]]')
  assert.ok(stop > launcher.indexOf('if [[ "${1:-}" == "--check" ]]'))
  assert.ok(stop < launcher.indexOf('EVIDENCE_DIR=$(mktemp'))
  assert.match(launcher.slice(stop, stop + 250), /exit 2/)
})

test('the launcher verifies exact database/sidecar identities and never infers PASS from gateway exit', () => {
  const script = shellWithoutComments(read(path.join(MANUAL_ROOT, 'run-live-adoption-bridge.sh')))
  // The launcher must capture and verify database/sidecar identities.
  assert.match(script, /DATABASE_IDENTITY/)
  assert.match(script, /remove_exact_database/)
  assert.match(script, /--database-identity-file/)
  // The verdict must be gated on verified cleanup, not gateway exit alone.
  assert.match(script, /GATEWAY_OK/)
  assert.match(script, /CLEANUP_SAFE/)
  // PASS must be written only when both gateway success and cleanup are verified.
  const passIndex = script.indexOf('PASS — human-only Adoption procedure completed')
  const gatewayOkIndex = script.indexOf('GATEWAY_OK == 1')
  const cleanupSafeIndex = script.indexOf('CLEANUP_SAFE == 1')
  assert.ok(passIndex > gatewayOkIndex && passIndex > cleanupSafeIndex,
    'PASS must be written only after verified gateway success and cleanup')
})

test('the gateway uses creation-time database ownership rather than cleanup-time capture', () => {
  const gateway = read(path.join(MANUAL_ROOT, 'live-adoption-gateway.ts'))
  assert.match(gateway, /new AdoptionRuntimeOwnership/)
  assert.match(gateway, /databaseIdentityFile/)
  assert.match(gateway, /ownedDatabase\.remove\(\)/)
})
