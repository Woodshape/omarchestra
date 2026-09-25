// Local Workbench v1 — Phase 1 source audit.
//
// Audits bounded native leaves: no prototype/spike imports,
// process supervision, external service commands, provider credentials or
// runtime dependencies. S4's owner-only local Pi socket is tested only under
// a disposable root with a fake host; no live Pi or desktop is launched.

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
const PHASE_2_GATE = join(PACKAGE_ROOT, 'scripts', 'phase-2-gate.sh')
// Phase 2 needs exactly one bounded, read-only local Git inspection. No other
// non-test module may spawn, and the one that does must use a fixed argv.
const ONLY_GIT_INSPECTOR = join(PACKAGE_ROOT, 'runner', 'git-context.ts')
const FIXED_DESKTOP_PORT = join(PACKAGE_ROOT, 'runner', 'desktop-command.ts')
const NAVIGATION_PORT = join(PACKAGE_ROOT, 'runner', 'local-pane-navigation.ts')

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

test('only the fixed bounded desktop-command adapter may call the installed shell', () => {
  const code = source(FIXED_DESKTOP_PORT)
  assert.match(code, /systemDesktopCommand\(spawn: typeof spawnSync = spawnSync\)/)
  assert.match(code, /spawn\(script, argv, \{ encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL'/)
  assert.match(code, /const script = '\/usr\/share\/omarchy\/bin\/omarchy-shell'/)
  assert.match(code, /invoke\(\['shell', 'call', pluginId, method, payloadJson\], method === 'takeIntent'\)/)
  assert.match(code, /shell: false/)
  assert.doesNotMatch(code, /\['shell', '(?:setup|reload)'|install\(|reload\(|\.config\/omarchy|sendUserMessage/)
})

test('no other non-test module spawns processes or invokes external desktop/services', () => {
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
    if (path === ONLY_GIT_INSPECTOR || path === FIXED_DESKTOP_PORT || path === NAVIGATION_PORT) continue
    const value = source(path)
    for (const [name, pattern] of liveTokens) {
      assert.doesNotMatch(value, pattern, `${name} token in ${path}`)
    }
  }
})

test('the single Git inspector spawns only fixed git argv with no shell', () => {
  const value = source(ONLY_GIT_INSPECTOR)
  assert.match(value, /spawnSync\('\/usr\/bin\/git', \['-c', 'core.fsmonitor=false', \.\.\.argv\]/)
  assert.match(value, /GIT_OPTIONAL_LOCKS: '0'/)
  assert.match(value, /GIT_CONFIG_GLOBAL: '\/dev\/null'/)
  assert.match(value, /GIT_CONFIG_NOSYSTEM: '1'/)
  assert.match(value, /GIT_NO_LAZY_FETCH: '1'/)
  assert.match(value, /GIT_ALLOW_PROTOCOL: ''/)
  assert.doesNotMatch(value, /process\.env/)
  assert.match(value, /shell: false/)
  assert.doesNotMatch(value, /shell\s*:\s*true/)
  assert.doesNotMatch(value, /execSync|execFile|execFileSync|\bfork\b/)
  assert.doesNotMatch(value, /`git|<git'|git\s+\$\{/)
  // Permit only this exact read-only config query; all other config commands
  // remain forbidden alongside repository mutation commands.
  const readConfig = String.raw`['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']`
  assert.ok(value.includes(readConfig))
  const withoutReadConfig = value.replace(readConfig, '[]')
  assert.doesNotMatch(withoutReadConfig, /'commit'|'checkout'|'reset'|'clean'|'push'|'fetch'|'add'|'apply'|'restore'|'gc'|'stash'|'update-index'|'write-tree'|'init'|'clone'|'rm'|'mv'|'config'|'remote'|'tag'|'branch'|'worktree'|'submodule'|'switch'|'rebase'|'merge'|'cherry-pick'|'revert'|'am'/)
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
  const bridgeAdapter = join(PACKAGE_ROOT, 'runner', 'pi-bridge-extension.ts')
  for (const path of allFiles) {
    const value = path === NAVIGATION_PORT ? source(path).replace('process.env', 'explicit-local-routing-context')
      : path === FIXED_DESKTOP_PORT ? source(path).replace(/process\.env\.(OMARCHY_PATH|XDG_RUNTIME_DIR|WAYLAND_DISPLAY)/g, 'explicit-desktop-environment')
      : path === bridgeAdapter
      // The explicitly installed Pi adapter locates the owner-only Unix
      // socket from XDG_RUNTIME_DIR; never transmit its path or any env value.
      ? source(path).replace('process.env.XDG_RUNTIME_DIR', 'private-runtime-directory')
      : source(path)
    for (const pattern of configTokens) {
      assert.doesNotMatch(value, pattern, `config/provider token in ${path}`)
    }
  }
  assert.equal((source(bridgeAdapter).match(/process\.env\./g) ?? []).length, 1)
})

test('checked navigation has one lazy bounded native leaf, not an Owner desktop escape', () => {
  const code = source(NAVIGATION_PORT)
  assert.match(code, /export async function showLocalTerminalPane/)
  assert.equal((code.match(/process\.env/g) ?? []).length, 1)
  assert.match(code, /commandArgv\(command, target\)/)
  assert.match(code, /shell: false, encoding: 'utf8', timeout: 600/)
  assert.match(code, /killSignal: 'SIGKILL', maxBuffer: 1024 \* 1024, signal/)
  assert.match(code, /\['dispatch', 'focuswindow', `address:\$\{target\}`\]/)
  assert.match(code, /\['agent', 'focus', target\]/)
  assert.doesNotMatch(code, /sendUserMessage|sendText|sendKey|kill\(|spawn\(|shell: true|\.config\/omarchy|shell\.json/)
  for (const path of allFiles) {
    if (path.endsWith('/pi-bridge-extension.ts')) continue
    assert.doesNotMatch(source(path), /from ['"].*local-pane-navigation\.ts['"]/, path)
  }
})

test('the companion release module reads only its own plugin directory', () => {
  const releaseSource = source(join(PACKAGE_ROOT, 'companion', 'releases.ts'))
  assert.match(releaseSource, /console['"]\s*,\s*['"]plugin['"]/)
  assert.doesNotMatch(releaseSource, /prototypes|spikes|\.config|\.env/)
})

test('durable SQLite usage is confined to the runner composition', () => {
  // Phase 2 introduces one runner/store/fence owner. SQLite and exclusive
  // authority transactions must not leak into presentation, fixture,
  // companion or retained-release modules.
  const runnerDir = join(PACKAGE_ROOT, 'runner') + '/'
  const sqliteTokens = /node:sqlite|DatabaseSync|BEGIN IMMEDIATE|BEGIN EXCLUSIVE/
  let runnerOwners = 0
  for (const path of allFiles) {
    if (path.startsWith(runnerDir)) {
      if (sqliteTokens.test(source(path))) runnerOwners += 1
      continue
    }
    assert.doesNotMatch(source(path), sqliteTokens, `sqlite token outside the runner in ${path}`)
  }
  assert.ok(runnerOwners >= 3, 'the runner must own the store, owner lock and fence ledger')
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

test('the Phase 2 foundation gate is foreground, disposable and never live', () => {
  const value = source(join(PACKAGE_ROOT, 'scripts', 'phase-2-foundation-gate.sh'))
  const executable = value.replace(/^\s*#.*$/gm, '')
  assert.match(value, /Phase 2 foundation gate/)
  assert.match(executable, /env -i/)
  assert.doesNotMatch(executable, /dotenv|\.env|tee|nohup|disown|systemctl|ghostty|hyprctl/)
  assert.doesNotMatch(executable, /\$HOME\/(?:\.config|\.local)/)
})

test('the Phase 2 gate is foreground, disposable, provider-free and asserts zero dispatch', () => {
  const value = source(PHASE_2_GATE)
  const executable = value.replace(/^\s*#.*$/gm, '')
  assert.match(value, /Phase 2 acceptance gate/)
  assert.match(executable, /env -i/)
  assert.doesNotMatch(executable, /dotenv|\.env|tee|nohup|disown|systemctl|ghostty|hyprctl/)
  assert.doesNotMatch(executable, /\$HOME\/(?:\.config|\.local)/)
  assert.match(executable, /mktemp -d/)
  assert.match(executable, /trap 'rm -rf -- "\$scratch"' EXIT/)
  // The gate refuses to pass without the real offscreen QML render.
  assert.match(executable, /qmltestrunner/)
  assert.match(executable, /QML offscreen render: UNAVAILABLE/)
  assert.match(executable, /exit 1/)
  // The two Phase 2 invariants are stated in the gate itself.
  assert.match(executable, /zero Assignment deliveries and zero acceptance-check executions/)
})
