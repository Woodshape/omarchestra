// PROTOTYPE — NOT PRODUCTION.
//
// Source-audit seam (S5) for the live Agent Console fusion: the dependency
// graph and recipe audit must prove that default automated commands cannot
// launch or control Pi, a provider, Ghostty, Hyprland actions,
// Quickshell/Omarchy UI, SSH, Boomux, or systemd.
//
// Rules encoded here:
//   - the automated prototype recipes run only Node test/lint processes and
//     the exact local prototype runner launches already authorized by the
//     existing vertical-slice gate;
//   - the human-only recipes (`prototype-vertical-slice-role-label-gate`,
//     `prototype-companion-setup-validation`,
//     `prototype-live-observer-bridge`) are the only places live systems may
//     ever be referenced, and they are never invoked by an automated recipe or
//     module;
//   - the live Companion adapter (`manual/live-companion-omarchy.ts`) is
//     reachable only from human-only scripts/gateways and their seam tests;
//   - routine projection modules never import installation or configuration
//     mutation code, and Companion modules contain no live-system, process,
//     or storage tokens;
//   - default (non-test) modules of the live console seam contain no
//     process-supervision, scraping, SQLite, or live-system tokens.
//
// Fully static. No live system is contacted.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = path.resolve(here, '..', '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const JUSTFILE = path.join(REPO_ROOT, 'justfile')

const AUTOMATED_RECIPES = [
  'prototype-vertical-slice',
  'prototype-vertical-slice-manual-check',
  'prototype-live-agent-console-check',
  'prototype-companion-check',
  'prototype-live-observer-check',
]
const HUMAN_RECIPES = [
  'prototype-vertical-slice-role-label-gate',
  'prototype-companion-setup-validation',
  'prototype-live-observer-bridge',
]

// Tokens that, in executable (comment-stripped) recipe or module text, mean a
// live system is being launched or contacted.
const LIVE_TOKENS = [
  // Pi only counts when invoked as a command (pi -e, pi --no-extensions, ...);
  // identity strings such as piSessionId/pi-session-* are legitimate data.
  ['Pi', /\bpi[ \t]+(?:-{1,2}|"|')|\bpi[ \t]*$/],
  ['Ghostty', /\bghostty\b/],
  ['Hyprland action', /\bhyprctl\b/],
  ['Quickshell/Omarchy UI', /\b(?:quickshell|omarchy-shell)\b/],
  ['SSH', /\bssh\b|\bscp\b/],
  ['Boomux', /\bboomux\b/],
  ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/],
  ['provider request', /\bcurl\b|\bwget\b|\bprovider\b/],
]

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      // just/bash comments; keep shebang-less content intact and never strip
      // inside a JSON-ish string on the same line is unnecessary for recipes.
      const hash = line.search(/(^|\s)#/)
      return hash === -1 ? line : line.slice(0, hash)
    })
    .join('\n')
}

/** Return the comment-stripped body of one justfile recipe, or null. */
function justRecipeBody(justfile, name) {
  const lines = justfile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}:`))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t') && /^[A-Za-z0-9_.-]+\s*(:|$)/.test(line)) break
    body.push(line)
  }
  return stripComments(body.join('\n'))
}

function listFiles(root, extensions) {
  if (!fs.existsSync(root)) return []
  const out = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), extensions))
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(path.join(root, entry.name))
    }
  }
  return out
}

test('every automated prototype recipe is free of live-system launch primitives', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  for (const recipe of AUTOMATED_RECIPES) {
    const body = justRecipeBody(justfile, recipe)
    assert.ok(body !== null, `justfile must define the automated recipe ${recipe}`)
    for (const [name, pattern] of LIVE_TOKENS) {
      assert.doesNotMatch(
        body,
        pattern,
        `automated recipe ${recipe} must not reach ${name}`,
      )
    }
    // No automated recipe may even reference the human-only gate recipe name.
    for (const human of HUMAN_RECIPES) {
      assert.doesNotMatch(
        body,
        new RegExp(`\\b${human}\\b`),
        `automated recipe ${recipe} must not invoke human recipe ${human}`,
      )
    }
  }
})

test('the fake-only live Agent Console check invokes only the replacement launcher in --check mode', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const body = justRecipeBody(justfile, 'prototype-live-agent-console-check')
  assert.ok(body !== null, 'justfile must define the unattended fake-only check recipe')
  assert.match(body, /run-companion-setup-validation\.sh/)
  assert.match(body, /--check/, 'the check recipe may call the replacement launcher only with --check')
  // The check recipe runs the fake-only test suites of every seam.
  assert.match(body, /node --test|node "\$\{flags\[@\]\}" --test|node .*--test/,
    'the check recipe must run the automated test suites')
})

test('the human-only recipes exist and are never referenced from automated code', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  for (const recipe of HUMAN_RECIPES) {
    assert.match(justfile, new RegExp(`^${recipe}:`, 'm'), `missing human recipe ${recipe}`)
  }

  const automatedRoots = [
    path.join(PROTOTYPE_ROOT, 'src'),
    path.join(PROTOTYPE_ROOT, 'companion'),
    path.join(PROTOTYPE_ROOT, 'manual', 'test'),
    path.join(PROTOTYPE_ROOT, 'console', 'test'),
  ]
  for (const root of automatedRoots) {
    for (const file of listFiles(root, ['.ts', '.mjs'])) {
      const value = stripComments(fs.readFileSync(file, 'utf8'))
      for (const recipe of HUMAN_RECIPES) {
        // The audit/launcher seam tests must statically verify the human-only
        // boundary, so they may name the recipes; no automated module may
        // execute them.
        const isSeamAudit = /(?:live-agent-console-launcher|companion-setup-validation|source-audit)\.test\.mjs$/.test(file)
        if (isSeamAudit) {
          assert.doesNotMatch(
            value,
            new RegExp(`(?:spawn|exec|\\bsh\\b|\\bbash\\b)[^\\n]*${recipe}`),
            `${path.basename(file)} must not execute human recipe ${recipe}`,
          )
          continue
        }
        assert.doesNotMatch(
          value,
          new RegExp(`\\b${recipe}\\b`),
          `automated module ${path.basename(file)} must not reference human recipe ${recipe}`,
        )
      }
    }
  }
})

test('default live-console modules contain no live-system or process-supervision tokens', () => {
  const auditedFiles = [
    ...listFiles(path.join(PROTOTYPE_ROOT, 'console'), ['.ts']).filter(
      (file) => !file.includes(`${path.sep}test${path.sep}`),
    ),
    path.join(PROTOTYPE_ROOT, 'manual', 'live-gate-resources.ts'),
  ]
  const present = auditedFiles.filter((file) => fs.existsSync(file))
  // Red while the implementation modules do not exist yet.
  assert.ok(present.length >= auditedFiles.length, `expected implementation modules to audit: ${
    auditedFiles.filter((file) => !fs.existsSync(file)).map((file) => path.relative(PROTOTYPE_ROOT, file)).join(', ')
  }`)

  const forbidden = [
    ...LIVE_TOKENS,
    ['process spawn', /(?<!\.)\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|(?<=[^.\w])exec\s*\(/],
    ['PTY', /\bpty\b|\bpseudo-terminal\b/i],
    ['SQLite', /\bsqlite\b/i],
    ['terminal scraping', /\bscrap(?:e|ing)\b|\bparseAnsi\b/i],
  ]
  for (const file of present) {
    const value = stripComments(fs.readFileSync(file, 'utf8'))
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(value, pattern, `${name} token in default module ${path.relative(PROTOTYPE_ROOT, file)}`)
    }
  }
})

test('the existing acceptance gate keeps its exact spawn boundary', () => {
  const acceptance = fs.readFileSync(path.join(PROTOTYPE_ROOT, 'src', 'acceptance.ts'), 'utf8')
  // The only permitted subprocess remains the local foreground runner CLI:
  // exactly one spawn call, and its argv is built by runnerLaunchArgv, whose
  // final entry is the prototype runner CLI path.
  const spawnCalls = acceptance.match(/\bspawn\s*\(/g) ?? []
  assert.equal(spawnCalls.length, 1, 'acceptance must contain exactly one spawn call')
  assert.match(acceptance, /CLI_PATH = .*cli\.ts/, 'the spawned binary must be the prototype runner CLI')
  assert.match(
    acceptance,
    /const child = spawn\(process\.execPath, argv,/,
    'acceptance must spawn only process.execPath with the runner argv',
  )
  const launchFn = acceptance.match(/function runnerLaunchArgv[\s\S]*?\n\}/)
  assert.ok(launchFn, 'acceptance must build runner argv in runnerLaunchArgv')
  assert.match(launchFn[0], /CLI_PATH/, 'runner argv must launch the prototype runner CLI')
  assert.match(launchFn[0], /'--state-dir'/, 'runner launch must be bounded to an explicit state dir')
  // No other execution primitives may appear.
  for (const primitive of [/(?<!\.)\bexec\s*\(/, /(?<!\.)\bexecFile\s*\(/, /(?<!\.)\bfork\s*\(/, /(?<!\.)\bspawnSync\s*\(/]) {
    assert.doesNotMatch(acceptance, primitive, `acceptance must not use ${primitive}`)
  }
})

// ---------------------------------------------------------------------------
// Companion milestone boundary extensions (task 3.c)
// ---------------------------------------------------------------------------

const LIVE_SCRIPTS = [
  'run-companion-setup-validation.sh',
  'run-live-agent-console-gate.sh',
  'run-live-observer-bridge.sh',
]
const LIVE_ADAPTER_FILE = 'live-companion-omarchy.ts'

test('the fusion harness recipe orchestrates agents but can never reach Companion live setup', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  const start = justfile.split('\n').findIndex((line) => /^fusion\b/.test(line))
  assert.ok(start !== -1, 'justfile must define the fusion recipe')
  const bodyLines = []
  for (let i = start + 1; i < justfile.split('\n').length; i += 1) {
    const line = justfile.split('\n')[i]
    if (line.trim() !== '' && /^[A-Za-z0-9_.*-]+\s*(?:\*\w+)?\s*:\s*$|^[A-Za-z0-9_.*-]+ \*\w+:/.test(line)) break
    bodyLines.push(line)
  }
  const body = stripComments(bodyLines.join('\n'))
  for (const human of HUMAN_RECIPES) {
    assert.doesNotMatch(body, new RegExp(`\\b${human}\\b`), 'fusion must never invoke a human-only recipe')
  }
  for (const script of LIVE_SCRIPTS) {
    assert.doesNotMatch(body, new RegExp(script.replace(/\./g, '\\.')), `fusion must never invoke ${script}`)
  }
  assert.doesNotMatch(body, new RegExp(LIVE_ADAPTER_FILE), 'fusion must never reference the live Companion adapter')
  // Beyond its own Fusion Harness `pi -e` command, fusion must not reach any
  // live desktop, terminal, remote, or service system.
  const withoutHarnessCommand = body.replace(/pi\s+-e[\s\S]*$/, '')
  for (const [name, pattern] of LIVE_TOKENS) {
    if (name === 'Pi') continue
    assert.doesNotMatch(withoutHarnessCommand, pattern, `fusion must not reach ${name}`)
  }
})

test('automated recipes reach the replacement human launcher only through --check', () => {
  const justfile = fs.readFileSync(JUSTFILE, 'utf8')
  for (const recipe of AUTOMATED_RECIPES) {
    const body = justRecipeBody(justfile, recipe)
    assert.ok(body !== null, `justfile must define the automated recipe ${recipe}`)
    const launcherLines = body
      .split('\n')
      .filter((line) => line.includes('run-companion-setup-validation.sh'))
    for (const line of launcherLines) {
      // Only the execution form carries --check; `bash -n` and `shellcheck`
      // are bounded static analyses that never execute the script.
      if (/\bbash\s+-n\b|\bshellcheck\b/.test(line)) continue
      assert.match(
        line,
        /--check/,
        `automated recipe ${recipe} may call the companion launcher only with --check`,
      )
    }
  }
})

test('the live Companion adapter is reachable only from human-only paths and seam tests', () => {
  const routineRoots = [
    path.join(PROTOTYPE_ROOT, 'companion'),
    path.join(PROTOTYPE_ROOT, 'console'),
    path.join(PROTOTYPE_ROOT, 'src'),
  ]
  for (const root of routineRoots) {
    for (const file of listFiles(root, ['.ts'])) {
      if (file.includes(`${path.sep}test${path.sep}`)) continue
      const value = fs.readFileSync(file, 'utf8')
      assert.doesNotMatch(
        value,
        new RegExp(LIVE_ADAPTER_FILE),
        `${path.relative(PROTOTYPE_ROOT, file)} must never reference the live Companion adapter`,
      )
    }
  }
  for (const file of listFiles(path.join(PROTOTYPE_ROOT, 'manual'), ['.ts', '.mjs', '.sh'])) {
    const base = path.basename(file)
    if (
      base === 'run-companion-setup-validation.sh'
      || base === 'companion-setup-validation.test.mjs'
      || base === 'run-live-observer-bridge.sh'
      || base === 'live-observer-gateway.ts'
    ) continue
    const value = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(
      value,
      new RegExp(LIVE_ADAPTER_FILE),
      `${base} must not reference the live Companion adapter`,
    )
  }
})

function collectImportGraph(entry) {
  const visited = new Set()
  const visit = (file) => {
    const resolved = path.resolve(file)
    if (visited.has(resolved) || !fs.existsSync(resolved)) return
    visited.add(resolved)
    const content = fs.readFileSync(resolved, 'utf8')
    const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      visit(path.resolve(path.dirname(resolved), specifier))
    }
  }
  visit(entry)
  return visited
}

test('routine projection modules cannot import installation or configuration mutation code', () => {
  const forbidden = [
    'companion/installation.ts',
    'companion/fake-omarchy.ts',
    'companion/releases.ts',
    'manual/live-companion-omarchy.ts',
    'src/store.ts',
  ]
  const entries = [
    path.join(PROTOTYPE_ROOT, 'companion', 'projection-session.ts'),
    path.join(PROTOTYPE_ROOT, 'companion', 'fake-companion-shell.ts'),
    path.join(PROTOTYPE_ROOT, 'console', 'projection-core.ts'),
    path.join(PROTOTYPE_ROOT, 'console', 'live-projection-adapter.ts'),
  ]
  for (const entry of entries) {
    assert.equal(fs.existsSync(entry), true, `expected routine module ${entry}`)
    const relative = [...collectImportGraph(entry)].map((file) => path.relative(PROTOTYPE_ROOT, file))
    for (const banned of forbidden) {
      assert.equal(
        relative.includes(banned),
        false,
        `routine module graph of ${path.basename(entry)} must exclude ${banned}`,
      )
    }
  }

  // Adaptation, not duplication: the session runs on the existing seam.
  const sessionGraph = [...collectImportGraph(entries[0])].map((file) => path.relative(PROTOTYPE_ROOT, file))
  assert.ok(sessionGraph.includes('console/projection-core.ts'), 'the session must reuse the existing projection core')
  assert.ok(sessionGraph.includes('console/live-projection-adapter.ts'), 'the session must reuse the existing live adapter')
  assert.ok(sessionGraph.includes('companion/contracts.ts'), 'the session must use the shared companion contract')
})

function stripBlockAndLineComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

test('companion prototype modules contain no live-system, process, or storage tokens', () => {
  const files = listFiles(path.join(PROTOTYPE_ROOT, 'companion'), ['.ts']).filter(
    (file) => !file.includes(`${path.sep}test${path.sep}`),
  )
  const expectedModules = [
    'companion/contracts.ts',
    'companion/installation.ts',
    'companion/fake-omarchy.ts',
    'companion/path-validation.ts',
    'companion/releases.ts',
    'companion/projection-session.ts',
    'companion/fake-companion-shell.ts',
    'companion/acceptance.ts',
  ]
  for (const expected of expectedModules) {
    assert.ok(files.includes(path.join(PROTOTYPE_ROOT, expected)), `expected module to audit: ${expected}`)
  }

  // Compatibility field NAMES such as `quickshell: '0.3.1-1'` are data, not
  // commands; only a quickshell command invocation counts as live.
  const forbidden = [
    ['Ghostty', /\bghostty\b/],
    ['Hyprland action', /\bhyprctl\b/],
    ['Quickshell command', /\bquickshell\s+(?:-|--|monitor\b|shell\b)/],
    ['Omarchy shell IPC command', /\bomarchy-shell\b/],
    ['SSH', /\bssh\b|\bscp\b/],
    ['Boomux', /\bboomux\b/],
    ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/],
    ['provider request', /\bcurl\b|\bwget\b|\bprovider\b/],
    ['process spawn', /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|(?<=[^.\w])exec\s*\(/],
    ['PTY', /\bpty\b|\bpseudo-terminal\b/i],
    ['SQLite', /\bsqlite\b/i],
    ['terminal scraping', /\bscrap(?:e|ing)\b|\bparseAnsi\b/i],
  ]
  for (const file of files) {
    const value = stripBlockAndLineComments(fs.readFileSync(file, 'utf8'))
    for (const [name, pattern] of forbidden) {
      assert.doesNotMatch(value, pattern, `${name} token in companion module ${path.relative(PROTOTYPE_ROOT, file)}`)
    }
  }
})
