// PROTOTYPE — NOT PRODUCTION.
//
// Phase 2 red gate for fake-only reachability, privacy, and authority. This
// suite is static and must never contact Pi, a provider, a desktop, an
// installed plugin, user configuration, a terminal runtime, SSH, or a service.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const OBSERVER_ROOT = path.resolve(TEST_DIR, '..')
const PROTOTYPE_ROOT = path.resolve(OBSERVER_ROOT, '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')

const EXPECTED_MODULES = [
  'contracts.ts',
  'telemetry-policy.ts',
  'fakes.ts',
  'registry.ts',
  'adoption.ts',
  'extension-adapter.ts',
  'fake-pi-host.ts',
  'companion-projection.ts',
  'acceptance.ts',
]

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function implementationFiles() {
  return EXPECTED_MODULES.map((name) => path.join(OBSERVER_ROOT, name))
}

function collectImportGraph(entry) {
  const visited = new Set()
  const visit = (file) => {
    const resolved = path.resolve(file)
    if (visited.has(resolved) || !fs.existsSync(resolved)) return
    visited.add(resolved)
    const source = fs.readFileSync(resolved, 'utf8')
    const imports = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(imports)) {
      if (!match[1].startsWith('.')) continue
      visit(path.resolve(path.dirname(resolved), match[1]))
    }
  }
  visit(entry)
  return visited
}

function justRecipeBody(source, recipe) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${recipe}:`))
  if (start === -1) return null
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && !/^\s/.test(line) && /^[A-Za-z0-9_.-]+(?:\s+\*\w+)?\s*:/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

test('all observer implementation seams exist under the removable prototype directory', () => {
  for (const file of implementationFiles()) {
    assert.equal(fs.existsSync(file), true, `missing observer implementation seam ${path.basename(file)}`)
    assert.equal(fs.statSync(file).isFile(), true)
  }
})

test('observer implementation modules contain no live-system or process-launch primitive', () => {
  const forbidden = [
    ['child process', /node:child_process|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/],
    ['network socket', /node:net|node:dgram|node:http|node:https|node:tls|\bWebSocket\b/],
    ['PTY', /\bpty\b|pseudo[- ]terminal|parseAnsi/i],
    ['live Pi command', /\bpi\s+(?:-e|--extension|--mode|--provider|--model)\b/],
    ['Ghostty', /\bghostty\b/i],
    ['Hyprland action', /\bhyprctl\b/i],
    ['Quickshell or Omarchy command', /\b(?:quickshell|omarchy-shell)\s+(?:-|--|summon|call|hide)/i],
    ['SSH', /\b(?:ssh|scp|sftp)\b/i],
    ['Boomux', /\bboomux\b/i],
    ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/i],
    ['provider request', /\b(?:curl|wget)\b|before_provider_request|after_provider_response/i],
  ]

  for (const file of implementationFiles()) {
    assert.equal(fs.existsSync(file), true, `missing module ${file}`)
    const source = stripComments(fs.readFileSync(file, 'utf8'))
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(source, pattern, `${name} is reachable from ${path.relative(PROTOTYPE_ROOT, file)}`)
    }
  }
})

test('observer modules cannot reach installation, existing SQLite, human adapters, or private evidence', () => {
  const entries = [
    'registry.ts',
    'adoption.ts',
    'extension-adapter.ts',
    'companion-projection.ts',
    'acceptance.ts',
  ].map((name) => path.join(OBSERVER_ROOT, name))
  const forbidden = [
    'src/store.ts',
    'companion/installation.ts',
    'companion/fake-omarchy.ts',
    'companion/releases.ts',
    'manual/live-companion-omarchy.ts',
    'manual/live-role-label-extension.ts',
  ]

  for (const entry of entries) {
    assert.equal(fs.existsSync(entry), true, `missing graph entry ${entry}`)
    const graph = [...collectImportGraph(entry)].map((file) => path.relative(PROTOTYPE_ROOT, file))
    for (const banned of forbidden) {
      assert.equal(graph.includes(banned), false, `${path.basename(entry)} reaches ${banned}`)
    }
  }

  const combined = implementationFiles()
    .filter((file) => fs.existsSync(file))
    .map((file) => stripComments(fs.readFileSync(file, 'utf8')))
    .join('\n')
  assert.doesNotMatch(combined, /\.config\/omarchy|~\/\.pi|manual-gates|private evidence/i)
  assert.doesNotMatch(combined, /prototype-companion-setup-validation|prototype-vertical-slice-role-label-gate/)
})

test('the pure contracts and telemetry policy own no I/O', () => {
  for (const name of ['contracts.ts', 'telemetry-policy.ts']) {
    const file = path.join(OBSERVER_ROOT, name)
    assert.equal(fs.existsSync(file), true)
    const source = stripComments(fs.readFileSync(file, 'utf8'))
    assert.doesNotMatch(source, /node:(?:fs|net|http|https|tls|child_process)|\bfetch\s*\(|XMLHttpRequest/)
    assert.doesNotMatch(source, /from\s+['"][^'"]*(?:adoption|registry|companion|qml)[^'"]*['"]/i)
  }
})

test('the Pi adapter subscribes to lifecycle only and never observes content-bearing hooks', () => {
  const file = path.join(OBSERVER_ROOT, 'extension-adapter.ts')
  assert.equal(fs.existsSync(file), true)
  const source = stripComments(fs.readFileSync(file, 'utf8'))
  const forbiddenHooks = [
    'input', 'message_start', 'message_update', 'message_end', 'tool_call',
    'tool_result', 'tool_execution_start', 'tool_execution_update',
    'tool_execution_end', 'context', 'before_agent_start', 'user_bash',
    'before_provider_request', 'after_provider_response',
  ]
  for (const hook of forbiddenHooks) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\.on\\(\\s*['"]${hook}['"]`),
      `observer adapter must not subscribe to content-bearing ${hook}`,
    )
  }
  assert.doesNotMatch(source, /getEntries|getBranch|buildContextEntries|getSystemPrompt|process\.env|ctx\.cwd/)
  assert.doesNotMatch(source, /sendUserMessage|sendMessage|appendEntry|registerTool|pi\.exec/)
})

test('the automated observer gate is fake-only and cannot invoke a human-only recipe', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const body = justRecipeBody(justfile, 'prototype-observer-adoption-check')
  assert.ok(body !== null, 'missing prototype-observer-adoption-check recipe')
  const executable = stripComments(body)
  assert.match(body, /observer\/test|observer\/acceptance/)
  assert.doesNotMatch(executable, /\bpi\s+(?:-e|--)|ghostty|hyprctl|quickshell|omarchy-shell|\bssh\b|\bboomux\b|systemctl|systemd-run/i)
  assert.doesNotMatch(body, /prototype-companion-setup-validation|prototype-vertical-slice-role-label-gate/)
  assert.doesNotMatch(body, /manual\/run-|live-companion-omarchy|live-role-label-extension/)
})

test('observer acceptance imports only fake/runtime core modules and never launches a process', () => {
  const entry = path.join(OBSERVER_ROOT, 'acceptance.ts')
  assert.equal(fs.existsSync(entry), true)
  const graph = [...collectImportGraph(entry)].map((file) => path.relative(PROTOTYPE_ROOT, file))
  assert.ok(graph.includes('observer/fakes.ts'), 'acceptance must use the fake ports')
  for (const banned of [
    'manual/live-companion-omarchy.ts',
    'manual/live-role-label-extension.ts',
    'companion/installation.ts',
    'src/store.ts',
  ]) {
    assert.equal(graph.includes(banned), false, `acceptance reaches ${banned}`)
  }
  const source = stripComments(fs.readFileSync(entry, 'utf8'))
  assert.doesNotMatch(source, /node:child_process|\b(?:spawn|execFile|fork)\s*\(/)
})
