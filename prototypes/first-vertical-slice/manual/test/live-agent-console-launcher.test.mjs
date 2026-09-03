import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PROTOTYPE — NOT PRODUCTION.
//
// Historical-path contract for the retired per-run Agent Console launcher.
// The replacement human setup procedure is tested separately. These checks
// prove that the old launcher and ephemeral-loader spike remain rejected
// evidence and are not active recipe dependencies.

const here = path.dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = path.resolve(here, '..', '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const ROLE_LABEL_WIZARD = path.join(here, '..', 'run-role-label-gate.sh')
const OLD_LAUNCHER = path.join(here, '..', 'run-live-agent-console-gate.sh')
const BLOCKER_DOC = path.join(PROTOTYPE_ROOT, 'docs', 'live-agent-console-launch-blocker.md')
const SPIKE_README = path.join(REPO_ROOT, 'spikes', 'omarchy-ephemeral-plugin-loader', 'README.md')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')

const OLD_HUMAN_RECIPE = 'prototype-live-agent-console-gate'
const NEW_HUMAN_RECIPE = 'prototype-companion-setup-validation'
const AUTOMATED_RECIPES = [
  'prototype-vertical-slice',
  'prototype-vertical-slice-manual-check',
  'prototype-live-agent-console-check',
  'prototype-companion-check',
]

function readIfExists(file, message = `expected file: ${file}`) {
  assert.equal(fs.existsSync(file), true, message)
  return fs.readFileSync(file, 'utf8')
}

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

function justRecipeBody(justfile, name) {
  const lines = justfile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}:`))
  if (start === -1) return null
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t')
        && /^[A-Za-z0-9_.-]+\s*(:|$)/.test(line)) break
    body.push(line)
  }
  return stripComments(body.join('\n'))
}

function ghosttyLaunchBlocks(source) {
  const blocks = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*ghostty(\s|$)/.test(lines[index])) continue
    let block = lines[index]
    while (block.endsWith('\\')) {
      index += 1
      block += `\n${lines[index] ?? ''}`
    }
    blocks.push(block)
  }
  return blocks
}

test('the retired launcher remains fail-closed historical evidence', () => {
  const source = readIfExists(OLD_LAUNCHER)
  const blocker = readIfExists(BLOCKER_DOC)
  const spike = readIfExists(SPIKE_README)
  assert.match(source, /FAIL CLOSED|RETIRED|rejected/i)
  assert.match(source, /live-agent-console-launch-blocker\.md/)
  assert.match(blocker, /REJECTED PATH|historical/i)
  assert.match(spike, /rejected-path evidence|rejected/i)
  assert.match(source, /--check/)
  assert.match(source, /exit 1/)
})

test('the old launcher retains every forbidden fallback rejection', () => {
  const source = stripComments(readIfExists(OLD_LAUNCHER))
  for (const pattern of [
    /quickshell\s+(?:-p|--path)\b/,
    /\.config\/omarchy\/plugins/,
    /shell\.json/,
    /\/usr\/share\/omarchy/,
    /\bln\s+[^\n]*-s/,
  ]) {
    // The historical blocker text is comment-only. It may document a rejected
    // fallback, but executable launcher text must not perform one.
    const executable = source
      .split('\n')
      .filter((line) => !line.includes('BLOCKED') && !line.includes('printf') && !line.includes('cat <<'))
      .join('\n')
    assert.doesNotMatch(executable, pattern, `retired launcher must not execute fallback ${pattern}`)
  }
})

test('no active recipe depends on the retired launcher or spike', () => {
  const justfile = readIfExists(JUSTFILE)
  assert.doesNotMatch(justfile, new RegExp(`^${OLD_HUMAN_RECIPE}:`, 'm'))
  for (const recipe of AUTOMATED_RECIPES) {
    const body = justRecipeBody(justfile, recipe)
    assert.ok(body !== null, `missing automated recipe ${recipe}`)
    assert.doesNotMatch(body, /run-live-agent-console-gate\.sh/)
    assert.doesNotMatch(body, /prototype-live-agent-console-gate/)
    assert.doesNotMatch(body, /omarchy-ephemeral-plugin-loader/)
  }
})

test('the replacement setup recipe is the only active human Agent Console path', () => {
  const justfile = readIfExists(JUSTFILE)
  const body = justRecipeBody(justfile, NEW_HUMAN_RECIPE)
  assert.ok(body !== null, `missing human-only recipe ${NEW_HUMAN_RECIPE}`)
  assert.match(body, /run-companion-setup-validation\.sh/)
  assert.doesNotMatch(body, /--check/, 'the human recipe must leave --check explicit to automation')

  const checkBody = justRecipeBody(justfile, 'prototype-live-agent-console-check')
  assert.ok(checkBody !== null)
  assert.match(checkBody, /run-companion-setup-validation\.sh/)
  assert.match(checkBody, /--check/)
})

test('the preserved role-label launcher remains decorationless and title-free', () => {
  const source = readIfExists(ROLE_LABEL_WIZARD)
  const blocks = ghosttyLaunchBlocks(source)
  assert.ok(blocks.length > 0, 'the prior terminal-side human gate must retain its launch')
  for (const block of blocks) {
    assert.match(block, /--window-decoration=none/)
    assert.doesNotMatch(block, /(^|\s)--title=/)
  }
})

test('automated modules reference neither the retired human recipe nor its spike', () => {
  const roots = [
    path.join(PROTOTYPE_ROOT, 'src'),
    path.join(PROTOTYPE_ROOT, 'manual', 'test'),
    path.join(PROTOTYPE_ROOT, 'console', 'test'),
  ]
  const files = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) files.push(path.join(root, entry.name))
    }
  }
  for (const file of files) {
    const value = stripComments(fs.readFileSync(file, 'utf8'))
    if (file.endsWith('live-agent-console-launcher.test.mjs')
        || file.endsWith('companion-setup-validation.test.mjs')
        || file.endsWith('source-audit.test.mjs')) continue
    assert.doesNotMatch(value, new RegExp(OLD_HUMAN_RECIPE), path.basename(file))
    assert.doesNotMatch(value, /omarchy-ephemeral-plugin-loader/, path.basename(file))
  }
})
