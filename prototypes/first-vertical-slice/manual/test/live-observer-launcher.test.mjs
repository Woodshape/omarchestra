import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PROTOTYPE — NOT PRODUCTION.
//
// Static and fake-only checks for the human observer bridge procedure. These
// tests may run the launcher --check path and bash syntax validation only. They
// never enter live mode, inspect an installed Companion, launch Pi, or contact
// a desktop, provider, terminal, or user configuration.

const here = path.dirname(fileURLToPath(import.meta.url))
const MANUAL_ROOT = path.resolve(here, '..')
const PROTOTYPE_ROOT = path.resolve(MANUAL_ROOT, '..')
const REPO_ROOT = path.resolve(PROTOTYPE_ROOT, '..', '..')
const SCRIPT = path.join(MANUAL_ROOT, 'run-live-observer-bridge.sh')
const GATEWAY = path.join(MANUAL_ROOT, 'live-observer-gateway.ts')
const EXTENSION = path.join(MANUAL_ROOT, 'live-observer-extension.ts')
const TRANSPORT = path.join(MANUAL_ROOT, 'live-observer-transport.ts')

function read(file) {
  assert.equal(fs.existsSync(file), true, `expected file: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

function shellWithoutComments(source) {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function runCheck(environment) {
  return spawnSync('bash', [SCRIPT, '--check'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

test('the human observer launcher and its three live seams exist and parse', () => {
  const script = read(SCRIPT)
  for (const file of [GATEWAY, EXTENSION, TRANSPORT]) read(file)
  assert.notEqual(fs.statSync(SCRIPT).mode & 0o111, 0, 'launcher must be executable')
  const syntax = spawnSync('bash', ['-n', SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(syntax.error, undefined, syntax.error?.message ?? '')
  assert.equal(syntax.status, 0, `${syntax.stdout}\n${syntax.stderr}`)
  assert.match(script, /PROTOTYPE[ —-]+NOT PRODUCTION/)
})

test('the observer catalog entry is distinct from the historical managed 0.2.0 entry', async () => {
  const releases = await import('../../companion/releases.ts')
  const legacy = releases.RELEASE_CATALOG['0.2.0']
  const observer = releases.RELEASE_CATALOG['0.3.0']
  assert.ok(legacy)
  assert.ok(observer)
  assert.equal(legacy.version, '0.2.0')
  assert.equal(observer.version, '0.3.0')
  assert.notEqual(observer, legacy)
  assert.equal(JSON.parse(observer.assets['manifest.json']).version, '0.3.0')
  assert.match(observer.assets['AgentConsole.qml'], /session\.observer/)
  assert.ok(observer.assets['UnassignedAgents.qml'])
})

test('the --check path is fake-only and does not create user or private live state', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-observer-launcher-check-'))
  try {
    const result = runCheck({
      HOME: path.join(scratch, 'home'),
      XDG_STATE_HOME: path.join(scratch, 'state'),
      XDG_RUNTIME_DIR: path.join(scratch, 'runtime'),
    })
    assert.equal(result.error, undefined, result.error?.message ?? '')
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /observer gateway entrypoint check: PASS/)
    assert.match(result.stdout, /observer bridge launcher: PASS \(fake-only\)/)
    for (const name of ['home', 'state', 'runtime']) {
      assert.equal(fs.existsSync(path.join(scratch, name)), false,
        `--check must not create ${name}`)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('live mode rejects piped input before command lookup or directory creation', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-observer-launcher-tty-'))
  try {
    const result = spawnSync('bash', [SCRIPT, '--live'], {
      cwd: REPO_ROOT,
      input: '\n',
      env: {
        ...process.env,
        HOME: path.join(scratch, 'home'),
        XDG_STATE_HOME: path.join(scratch, 'state'),
        XDG_RUNTIME_DIR: path.join(scratch, 'runtime'),
      },
      encoding: 'utf8',
      timeout: 5_000,
    })
    assert.equal(result.error, undefined, result.error?.message ?? '')
    assert.notEqual(result.status, 0, 'piped live mode must fail closed')
    assert.match(`${result.stdout}\n${result.stderr}`, /TTY/i)
    for (const name of ['home', 'state', 'runtime']) {
      assert.equal(fs.existsSync(path.join(scratch, name)), false,
        `TTY refusal must precede ${name} creation`)
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('the procedure records bounded read-only Companion verification and exact cleanup rules', () => {
  const script = read(SCRIPT)
  assert.match(script, /! -t 0/)
  assert.match(script, /! -t 1/)
  assert.match(script, /chmod 700/)
  assert.match(script, /chmod 600/)
  assert.match(script, /stat -c '%d:%i'/)
  assert.match(script, /EVIDENCE_IDENTITY/)
  assert.match(script, /RUNTIME_IDENTITY/)
  assert.match(script, /SOCKET_IDENTITY/)
  assert.match(script, /SOCKET_IDENTITY_FILE_ID/)
  assert.match(script, /remove_exact_socket/)
  assert.match(script, /remove_exact_runtime_directory/)
  assert.match(script, /rmdir --/)
  assert.match(script, /INSTALLATION_BEFORE/)
  assert.match(script, /INSTALLATION_AFTER/)
  assert.match(script, /--fingerprint/)
  assert.match(script, /0\.3\.0/)
  assert.match(script, /session\.observer/)
  assert.match(script, /companion-capabilities\.json/)
  assert.match(script, /observer-events\.ndjson/)
  assert.match(script, /outside the repository/)
})

test('the printed procedure covers fail-open, heartbeat, disconnect, expiry, reconnect, and controls', () => {
  const script = read(SCRIPT)
  for (const term of ['Fail-open', 'Heartbeat', 'Disconnect', 'Expiry', 'Reconnect', 'Pause/resume', 'status', 'pause', 'resume', 'quit']) {
    assert.match(script, new RegExp(term.replace('/', '\\/'), 'i'), `missing manual step ${term}`)
  }
  assert.match(script, /Unassigned · observed/)
  assert.match(script, /printed only/)
  assert.match(script, /never executes it/)
})

test('the launcher prints the visible Pi command but never invokes Pi or desktop/process control', () => {
  const script = read(SCRIPT)
  const executable = shellWithoutComments(script)
  assert.match(script, /env OMARCHESTRA_OBSERVER_SOCKET=.*pi -e/)
  assert.doesNotMatch(executable, /(?:^|[;&|]\s*)(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)*pi(?:\s|$)/im)
  assert.doesNotMatch(executable, /\b(?:ghostty|hyprctl|boomux|ssh|scp|sftp|systemctl|systemd-run)\b/i)
  assert.doesNotMatch(executable, /node:child_process|\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/)
  assert.doesNotMatch(executable, /mkfifo|rm\s+-rf/)
})

test('the check path references only static files and the no-resource gateway check', () => {
  const script = read(SCRIPT)
  const checkStart = script.indexOf('if [[ "${1:-}" == "--check" ]]')
  const checkEnd = script.indexOf('\nfi', checkStart)
  assert.ok(checkStart >= 0 && checkEnd > checkStart)
  const checkBranch = script.slice(checkStart, checkEnd)
  assert.match(checkBranch, /bash -n/)
  assert.match(checkBranch, /\$GATEWAY.*--check/)
  assert.doesNotMatch(checkBranch, /omarchy-shell|--fingerprint|XDG_STATE_HOME|HOME|mktemp|mkdir/)
  assert.doesNotMatch(checkBranch, /pi\s+-e|ghostty|hyprctl|systemctl|boomux|ssh/i)
})
