// Local Workbench v1 — Phase 1 source audit.
//
// Proves the package is desktop/provider-free: no imports from prototype or
// spike evidence, no process supervision, no live-system tokens, no
// configuration/provider access, and no runtime dependencies. Automation uses
// injected fixtures and disposable state only.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(here, '..')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile() && /\.(ts|mjs|qml|json)$/.test(entry.name)) out.push(path)
  }
  return out
}

const allFiles = walk(PACKAGE_ROOT).filter((p) => !p.includes('/test/'))
const PHASE_GATE = join(PACKAGE_ROOT, 'scripts', 'phase-gate.sh')

function source(path) {
  return readFileSync(path, 'utf8')
}

test('the package declares no runtime dependencies', () => {
  const pkg = JSON.parse(source(join(PACKAGE_ROOT, 'package.json')))
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('no module imports prototype or spike evidence', () => {
  for (const path of allFiles) {
    const value = source(path)
    assert.doesNotMatch(value, /from\s+['"][^'"]*prototypes\//, `prototype import in ${path}`)
    assert.doesNotMatch(value, /from\s+['"][^'"]*spikes\//, `spike import in ${path}`)
  }
})

test('no non-test module spawns processes or touches live systems', () => {
  const liveTokens = [
    ['Pi', /\bpi[ \t]+(?:-{1,2}|"|')|\bpi[ \t]*$/],
    ['Ghostty', /\bghostty\b/],
    ['Hyprland action', /\bhyprctl\b/],
    // Compatibility field NAMES such as `quickshell: '0.3.1-1'` are data, not
    // commands; only a quickshell command invocation counts as live.
    ['Quickshell command', /\bquickshell\s+(?:-|--|monitor\b|shell\b)/],
    ['Omarchy shell IPC command', /\bomarchy-shell\b/],
    ['SSH', /\bssh\b|\bscp\b/],
    ['Boomux', /\bboomux\b/],
    ['systemd', /\b(?:systemctl|systemd-run|journalctl)\b/],
    ['process spawn', /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork)\s*\(|(?<=[^.\w])exec\s*\(/],
    ['PTY', /\bpty\b|\bpseudo-terminal\b/i],
  ]
  for (const path of allFiles) {
    const value = source(path)
    for (const [name, pattern] of liveTokens) {
      assert.doesNotMatch(value, pattern, `${name} token in ${path}`)
    }
  }
})

test('no module reads user configuration or provider state', () => {
  const configTokens = [
    /\.config\/omarchy/,
    /shell\.json/,
    /\.env\b/,
    /provider/,
    /credentials/,
    /XDG_STATE_HOME/,
    /\.local\/state/,
  ]
  for (const path of allFiles) {
    const value = source(path)
    for (const pattern of configTokens) {
      assert.doesNotMatch(value, pattern, `config/provider token in ${path}`)
    }
  }
})

test('the companion release module reads only its own plugin directory', () => {
  const releaseSource = source(join(PACKAGE_ROOT, 'companion', 'releases.ts'))
  assert.match(releaseSource, /console['"]\s*,\s*['"]plugin['"]/)
  assert.doesNotMatch(releaseSource, /prototypes|spikes|\.config|\.env/)
})

test('the package contains no SQLite or durable store module', () => {
  for (const path of allFiles) {
    const value = source(path)
    assert.doesNotMatch(value, /node:sqlite|DatabaseSync|BEGIN IMMEDIATE/, `sqlite token in ${path}`)
  }
})

test('the package contains no gate execution or dispatch module', () => {
  for (const path of allFiles) {
    const value = source(path)
    assert.doesNotMatch(value, /validator\s*\.\s*spawn\b|gate\s*\.\s*exec\b|dispatchAssignment|sendUserMessage/, `dispatch token in ${path}`)
  }
})

test('the Phase 0/1 gate is foreground and does not load external configuration', () => {
  const value = source(PHASE_GATE)
  const executable = value.replace(/^\s*#.*$/gm, '')
  assert.match(value, /Phase 0\/1 presentation gate/)
  assert.match(executable, /env -i/)
  assert.match(executable, /QML lint: UNAVAILABLE/)
  assert.doesNotMatch(executable, /dotenv|\.env|tee|nohup|disown/)
  assert.doesNotMatch(executable, /OMARCHY_QML_IMPORT_DIR|XDG_CONFIG_HOME=\$HOME|XDG_STATE_HOME=\$HOME/)
})
