// SPIKE — Seam 8: source-audit seam (red stage).
//
// The automated command graph contains no live shell IPC, GUI, user-config
// mutation, provider, remote, process-supervision, or service-manager path.
//
// Rules encoded here:
//   - the fake-only recipe `spike-omarchy-ephemeral-plugin-loader` exists and
//     its body is free of live-system launch primitives;
//   - no human/live recipe is created for this spike (the fusion prompt
//     forbids one);
//   - default spike modules (lib/, fixtures/, scripts/) contain no live-system
//     tokens; bounded local build tools (node, bash, git apply, patch,
//     mktemp, sha256sum, qmllint) are the only permitted process surface and
//     they may appear only in scripts/;
//   - the existing human-only prototype gate recipe is never referenced by
//     any spike module.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SPIKE_ROOT = path.resolve(here, '..')
const REPO_ROOT = path.resolve(SPIKE_ROOT, '..', '..')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')

const RECIPE = 'spike-omarchy-ephemeral-plugin-loader'

// Live-system tokens that must never appear in executable recipe or module text.
const LIVE_TOKENS = [
  ['Quickshell/Omarchy UI', /\b(?:quickshell|omarchy-shell)\b/],
  ['SSH', /\b(?:ssh|scp)\b/],
  ['Boomux', /\bboomux\b/],
  ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/],
  ['provider request', /\b(?:curl|wget)\b/],
  ['Hyprland action', /\bhyprctl\b/],
  ['Ghostty', /\bghostty\b/],
  ['Pi invocation', /\bpi[ \t]+-{1,2}/],
]

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const hash = line.search(/(^|\s)#/)
      return hash === -1 ? line : line.slice(0, hash)
    })
    .join('\n')
}

function justRecipeBody(justfile, name) {
  const lines = justfile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}:`))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t')
      && /^[A-Za-z0-9_.-]+\s*(:|$)/.test(line)) break
    body.push(line)
  }
  return stripComments(body.join('\n'))
}

function listFiles(root, extensions) {
  if (!fs.existsSync(root)) return []
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), extensions))
    else if (entry.isFile() && extensions.some((extension) => extension.test(entry.name))) {
      out.push(path.join(root, entry.name))
    }
  }
  return out
}

test(`the fake-only recipe ${RECIPE} exists`, () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const body = justRecipeBody(justfile, RECIPE)
  assert.ok(body !== null, `justfile must define the unattended fake-only recipe ${RECIPE}`)
})

test('the spike recipe is free of live-system launch primitives', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const body = justRecipeBody(justfile, RECIPE)
  if (body === null) {
    assert.fail(`missing recipe ${RECIPE} (red until task 4.b adds it)`)
  }
  for (const [name, pattern] of LIVE_TOKENS) {
    assert.doesNotMatch(body, pattern, `recipe ${RECIPE} must not reach ${name}`)
  }
})

test('the spike creates no human/live gate recipe', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const humanSpikeRecipes = justfile
    .split('\n')
    .map((line) => line.match(/^([A-Za-z0-9_.-]+):/)?.[1])
    .filter((name) => name && name.startsWith('spike-') && /gate|live|manual/i.test(name))
  assert.deepEqual(humanSpikeRecipes, [], 'this spike must not create a human/live recipe')
})

test('default spike modules contain no live-system tokens', () => {
  const auditedRoots = [
    path.join(SPIKE_ROOT, 'lib'),
    path.join(SPIKE_ROOT, 'fixtures'),
  ]
  const auditedScripts = [
    path.join(SPIKE_ROOT, 'scripts', 'run-fake-checks.mjs'),
    path.join(SPIKE_ROOT, 'scripts', 'verify-candidate-patch.sh'),
  ]
  const files = [
    ...auditedRoots.flatMap((root) => listFiles(root, [/\.mjs$/])),
    ...auditedScripts.filter((file) => fs.existsSync(file)),
  ]
  assert.ok(files.length > 0, 'expected lib/, fixtures/, and scripts/ modules to audit (red until tasks 3.a/3.b land)')
  for (const file of files) {
    const value = stripComments(fs.readFileSync(file, 'utf8'))
    for (const [name, pattern] of LIVE_TOKENS) {
      assert.doesNotMatch(value, pattern, `${name} token in ${path.relative(SPIKE_ROOT, file)}`)
    }
  }
})

test('lib/ and fixtures/ contain no process-spawn primitives; only scripts/ may spawn bounded tools', () => {
  const forbiddenRoots = [
    path.join(SPIKE_ROOT, 'lib'),
    path.join(SPIKE_ROOT, 'fixtures'),
  ]
  const spawnPattern = /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(/
  for (const root of forbiddenRoots) {
    for (const file of listFiles(root, [/\.mjs$/])) {
      const value = stripComments(fs.readFileSync(file, 'utf8'))
      assert.doesNotMatch(value, spawnPattern, `process spawn in ${path.relative(SPIKE_ROOT, file)}`)
    }
  }
  // scripts/run-fake-checks.mjs may spawn only the bounded node/bash verifier.
  const runner = path.join(SPIKE_ROOT, 'scripts', 'run-fake-checks.mjs')
  if (fs.existsSync(runner)) {
    const value = stripComments(fs.readFileSync(runner, 'utf8'))
    const forbidden = [
      ['SSH', /\b(?:ssh|scp)\b/],
      ['Boomux', /\bboomux\b/],
      ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/],
      ['provider request', /\b(?:curl|wget)\b/],
      ['Hyprland action', /\bhyprctl\b/],
      ['Ghostty', /\bghostty\b/],
      ['Pi invocation', /\bpi[ \t]+-{1,2}/],
    ]
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(value, pattern, `run-fake-checks must not reach ${name}`)
    }
  }
})

test('no spike module references the human-only prototype gate', () => {
  const human = 'prototype-live-agent-console-gate'
  const auditedRoots = [
    path.join(SPIKE_ROOT, 'lib'),
    path.join(SPIKE_ROOT, 'fixtures'),
  ]
  for (const root of auditedRoots) {
    for (const file of listFiles(root, [/\.mjs$/])) {
      const value = stripComments(fs.readFileSync(file, 'utf8'))
      assert.doesNotMatch(value, new RegExp(`\\b${human}\\b`),
        `${path.relative(SPIKE_ROOT, file)} must not reference the human-only gate`)
    }
  }
})