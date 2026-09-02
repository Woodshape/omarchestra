import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PROTOTYPE — NOT PRODUCTION.
//
// Launcher-contract seam (S3) for the live Agent Console gate:
//   1. every agent Ghostty launch uses --window-decoration=none;
//   2. no agent Ghostty launch pins --title;
//   3. the live Agent Console recipe is clearly human-only and is never
//      referenced by an automated recipe or automated module;
//   4. on the installed Omarchy API the live recipe fails closed — it reports
//      the recorded blocker and exits nonzero before creating or contacting
//      any live resource;
//   5. no standalone Quickshell, generic Qt/GTK, user-config staging,
//      symlink, or preinstalled-plugin fallback exists.
//
// All checks are static source audits. No live system is invoked.

const here = path.dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = path.resolve(here, '..', '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const ROLE_LABEL_WIZARD = path.join(here, '..', 'run-role-label-gate.sh')
const COMBINED_GATE = path.join(here, '..', 'run-live-agent-console-gate.sh')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')
const BLOCKER_DOC = path.join(PROTOTYPE_ROOT, 'docs', 'live-agent-console-launch-blocker.md')

const HUMAN_ONLY_RECIPE = 'prototype-live-agent-console-gate'

function readIfExists(file, missingMessage) {
  if (!fs.existsSync(file)) throw new Error(missingMessage)
  return fs.readFileSync(file, 'utf8')
}

/** Lines with their `#` comment tails stripped (bash/justfile style). */
function stripComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

/**
 * Extract full continuation command blocks for every `ghostty` invocation:
 * a line whose first token is ghostty plus following lines that end in `\\`.
 */
function ghosttyLaunchBlocks(source) {
  const blocks = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*ghostty(\s|$)/.test(lines[i])) continue
    let block = lines[i]
    while (block.endsWith('\\')) {
      i += 1
      block += '\n' + (lines[i] ?? '')
    }
    blocks.push(block)
  }
  return blocks
}

test('the combined live gate script exists with a fake-only --check mode', () => {
  const source = readIfExists(
    COMBINED_GATE,
    'expected human-only launcher manual/run-live-agent-console-gate.sh (not implemented yet)',
  )
  assert.match(source, /--check/, 'combined gate must expose a fake-only --check path')
})

test('the combined live gate script fails closed before any live resource on this Omarchy API', () => {
  const source = stripComments(readIfExists(
    COMBINED_GATE,
    'expected human-only launcher manual/run-live-agent-console-gate.sh (not implemented yet)',
  ))

  // The recorded blocker must be the fail-closed reason, surfaced to the human.
  assert.match(
    source,
    /live-agent-console-launch-blocker\.md/,
    'live recipe must point the operator at the blocker report',
  )
  assert.match(
    source,
    /exit 1/,
    'the live path must exit nonzero on the unsupported installed API',
  )
  assert.match(
    source,
    /prototype-vertical-slice-role-label-gate/,
    'the recipe must point users at the completed terminal-side human gate',
  )

  // Fail closed happens BEFORE it starts or contacts any live system. On the
  // installed API the launcher must therefore contain no live launch
  // primitives at all: no runner, Pi, Ghostty, Hyprland, provider, Boomux,
  // SSH, systemd, Quickshell, or Omarchy shell/UI contact.
  const forbiddenLiveTokens = [
    /\bpi\b/, /\bghostty\b/, /\bhyprctl\b/, /\bhyprland\b/i, /\bquickshell\b/,
    /\bomarchy-shell\b/, /\bboomux\b/, /\bssh\b/, /\bsystemctl\b/, /\bsystemd-run\b/,
  ]
  for (const pattern of forbiddenLiveTokens) {
    assert.doesNotMatch(source, pattern, `live launch primitive in fail-closed launcher: ${pattern}`)
  }
})

test('every agent Ghostty launch stays decorationless and never pins a title', () => {
  // The preserved decorationless Pi launcher keeps at least one audited
  // Ghostty launch. The combined fail-closed launcher launches nothing, so
  // every script that does launch Ghostty must obey the contract.
  const wizards = [
    ['run-role-label-gate.sh', readIfExists(ROLE_LABEL_WIZARD, 'existing decorationless Pi launcher must remain')],
  ]
  if (fs.existsSync(COMBINED_GATE)) {
    wizards.push(['run-live-agent-console-gate.sh', fs.readFileSync(COMBINED_GATE, 'utf8')])
  }
  for (const [name, source] of wizards) {
    for (const block of ghosttyLaunchBlocks(source)) {
      assert.match(
        block,
        /--window-decoration=none/,
        `${name} Ghostty launch must pass --window-decoration=none`,
      )
      assert.doesNotMatch(
        block,
        /(^|\s)--title=/,
        `${name} Ghostty launch must never pin --title`,
      )
    }
  }
  assert.ok(
    ghosttyLaunchBlocks(readIfExists(ROLE_LABEL_WIZARD, 'existing decorationless Pi launcher must remain')).length > 0,
    'run-role-label-gate.sh must retain its audited Ghostty launch',
  )
})

test('the live Agent Console recipe is human-only and unreachable from automated paths', () => {
  const justfile = readIfExists(JUSTFILE, 'expected repository justfile')
  assert.match(
    justfile,
    new RegExp(`^${HUMAN_ONLY_RECIPE}:`, 'm'),
    `justfile must define the clearly named human-only ${HUMAN_ONLY_RECIPE} recipe`,
  )
  assert.match(
    justfile,
    /run-live-agent-console-gate\.sh/,
    'the human recipe must invoke the combined gate launcher',
  )

  // The human recipe must be its own recipe: no other recipe body may invoke
  // it, and the fake-only check recipe may reference the launcher script only
  // through its fake-only --check mode.
  const automatedRecipes = ['prototype-vertical-slice', 'prototype-vertical-slice-manual-check', 'prototype-live-agent-console-check']
  for (const recipe of automatedRecipes) {
    const body = justRecipeBody(justfile, recipe)
    assert.ok(body !== null, `justfile must define the automated recipe ${recipe}`)
    assert.doesNotMatch(
      body,
      new RegExp(HUMAN_ONLY_RECIPE),
      `automated recipe ${recipe} must never invoke the human-only gate recipe`,
    )
    if (/run-live-agent-console-gate\.sh/.test(body)) {
      assert.match(
        body,
        /--check/,
        `automated recipe ${recipe} may call the combined launcher only with --check`,
      )
    }
  }
})

test('no automated test or acceptance module reaches the human-only gate', () => {
  const automatedRoots = [
    path.join(PROTOTYPE_ROOT, 'src'),
    path.join(PROTOTYPE_ROOT, 'manual', 'test'),
    path.join(PROTOTYPE_ROOT, 'console', 'test'),
  ]
  const files = []
  for (const root of automatedRoots) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) {
        files.push(path.join(root, entry.name))
      }
    }
  }
  assert.ok(files.length > 0, 'expected automated modules to audit')
  for (const file of files) {
    const value = stripComments(fs.readFileSync(file, 'utf8'))
    // The launcher-contract seam itself audits the recipe name statically;
    // every other automated module must not reference the human recipe.
    if (file.endsWith('live-agent-console-launcher.test.mjs') || file.endsWith('source-audit.test.mjs')) continue
    assert.doesNotMatch(
      value,
      new RegExp(HUMAN_ONLY_RECIPE),
      `automated module ${path.basename(file)} must not reference the human-only gate`,
    )
  }
})

test('the recorded blocker report exists and names the forbidden fallbacks', () => {
  const blocker = readIfExists(BLOCKER_DOC, 'expected docs/live-agent-console-launch-blocker.md')
  // The blocker report itself must name every forbidden fallback explicitly;
  // it is documentation, never executable launch code.
  assert.match(blocker, /quickshell -p/)
  assert.match(blocker, /~\/\.config\/omarchy\/plugins\//)
  assert.match(blocker, /shell\.json/)
})

test('no forbidden fallback replaces the blocked Omarchy plugin launch', () => {
  const audited = [
    ['run-live-agent-console-gate.sh', readIfExists(
      COMBINED_GATE,
      'expected human-only launcher manual/run-live-agent-console-gate.sh (not implemented yet)',
    )],
  ]
  const liveGateResources = path.join(here, '..', 'live-gate-resources.ts')
  if (fs.existsSync(liveGateResources)) {
    audited.push(['live-gate-resources.ts', fs.readFileSync(liveGateResources, 'utf8')])
  }

  for (const [name, source] of audited) {
    const value = stripComments(source)
    assert.doesNotMatch(
      value,
      /quickshell\s+(?:-p|--path)\b/,
      `${name} must not launch a standalone Quickshell instance`,
    )
    assert.doesNotMatch(
      value,
      /\bomarchy\s+plugin\s+(?:add|clone)\b/,
      `${name} must not install or clone an Omarchy plugin`,
    )
    assert.doesNotMatch(
      value,
      /\.config\/omarchy\/plugins/,
      `${name} must not stage or reference a plugin copy under user config`,
    )
    assert.doesNotMatch(
      value,
      /shell\.json/,
      `${name} must never read, edit, back up, or restore shell.json`,
    )
    assert.doesNotMatch(
      value,
      /\bln\s+(-[a-zA-Z]*s[a-zA-Z]*\s+)/,
      `${name} must not create symlinks as a launch fallback`,
    )
    assert.doesNotMatch(
      value,
      /\/usr\/share\/omarchy/,
      `${name} must never edit installed Omarchy sources`,
    )
  }
})

/** Return the body of one justfile recipe (comment-stripped), or null. */
function justRecipeBody(justfile, name) {
  const lines = justfile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}:`))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^[A-Za-z0-9_.-]+(:|\s|$)/.test(line) && !line.startsWith(' ') && !line.startsWith('\t') && line.trim() !== '') break
    body.push(line)
  }
  return stripComments(body.join('\n'))
}