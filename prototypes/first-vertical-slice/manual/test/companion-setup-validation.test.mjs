import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// PROTOTYPE — NOT PRODUCTION.
//
// Static and fake-only contract checks for the replacement Companion setup
// procedure. These tests never invoke live mode, Omarchy IPC, a runner, Pi,
// Ghostty, Hyprland, or a provider.

const here = path.dirname(fileURLToPath(import.meta.url))
const MANUAL_ROOT = path.resolve(here, '..')
const PROTOTYPE_ROOT = path.resolve(MANUAL_ROOT, '..')
const SCRIPT = path.join(MANUAL_ROOT, 'run-companion-setup-validation.sh')
const ADAPTER = path.join(MANUAL_ROOT, 'live-companion-omarchy.ts')
const INSTALLATION = path.join(PROTOTYPE_ROOT, 'companion', 'installation.ts')
const OLD_SCRIPT = path.join(MANUAL_ROOT, 'run-live-agent-console-gate.sh')
const JUSTFILE = path.resolve(PROTOTYPE_ROOT, '..', '..', 'justfile')

function read(file) {
  assert.equal(fs.existsSync(file), true, `expected file: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')
}

test('the replacement procedure and live adapter exist without importing live code during checks', () => {
  const script = read(SCRIPT)
  const adapter = read(ADAPTER)
  assert.match(script, /--check/)
  assert.match(script, /HUMAN[- ]ONLY|human-only/i)
  assert.match(adapter, /export class LiveCompanionShell/)
  assert.match(adapter, /CompanionShellPort/)
  assert.match(adapter, /CompanionInstallationPorts/)
  assert.match(adapter, /capabilities\s*\(/)
  assert.match(adapter, /summon\s*\(/)
  assert.match(adapter, /call\s*\(/)
  assert.match(adapter, /hide\s*\(/)
  assert.match(adapter, /omarchy-shell/)
  assert.match(adapter, /rescanPlugins/)
  assert.match(adapter, /enablePlugin/)
})

test('the replacement --check path is the real fake-only invocation', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-companion-check-'))
  try {
    const result = spawnSync('bash', [SCRIPT, '--check'], {
      cwd: path.resolve(PROTOTYPE_ROOT, '..', '..'),
      env: {
        ...process.env,
        HOME: path.join(scratch, 'home'),
        XDG_STATE_HOME: path.join(scratch, 'state'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.error, undefined, result.error?.message ?? '')
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /PASS \(fake-only\)/)
    assert.equal(fs.existsSync(path.join(scratch, 'state')), false,
      'fake-only --check must not create private live evidence')
    assert.equal(fs.existsSync(path.join(scratch, 'home')), false,
      'fake-only --check must not inspect or create user installation state')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
})

test('live mode requires a TTY and cannot accept authorization from an environment flag', () => {
  const script = read(SCRIPT)
  const adapter = read(ADAPTER)
  assert.match(script, /! -t 0|\[\[\s*!\s*-t 0/)
  assert.match(script, /! -t 1|\[\[\s*!\s*-t 1/)
  assert.match(adapter, /process\.stdin\.isTTY/)
  assert.match(adapter, /process\.stdout\.isTTY/)
  assert.match(adapter, /I AUTHORIZE OMARCHESTRA COMPANION INSTALL 0\.2\.0/)
  assert.match(adapter, /typed authorization phrase did not match exactly/)
  assert.doesNotMatch(stripComments(script), /OMARCHESTRA_CONFIRM|OMARCHESTRA_AUTHORIZE|SKIP_AUTH/)
  assert.doesNotMatch(stripComments(adapter), /OMARCHESTRA_CONFIRM|OMARCHESTRA_AUTHORIZE|SKIP_AUTH/)

  const result = spawnSync('bash', [SCRIPT], {
    cwd: path.resolve(PROTOTYPE_ROOT, '..', '..'),
    input: 'I AUTHORIZE OMARCHESTRA COMPANION INSTALL 0.2.0\n',
    env: { ...process.env, PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.notEqual(result.status, 0, 'piped live mode must fail before setup')
  assert.match(`${result.stdout}\n${result.stderr}`, /TTY/i)
})

test('the exact immutable plan is displayed and authorized before installation execution', () => {
  const script = read(SCRIPT)
  const adapter = read(ADAPTER)
  const planDisplay = adapter.indexOf('Exact Companion installation plan')
  const planWrite = adapter.indexOf("installation-plan.json")
  const prompt = adapter.indexOf('const phrase = await promptExactAuthorization()')
  const execute = adapter.indexOf('authorizedInstaller.execute(plan, grant)')
  assert.ok(planDisplay >= 0)
  assert.ok(planWrite >= 0)
  assert.ok(prompt > planDisplay)
  assert.ok(execute > prompt)
  assert.match(script, /--live --evidence-dir/)
  assert.match(adapter, /planDigest/)
  assert.match(adapter, /authorization\.issue\(plan, phrase\)/)
})

test('live setup uses supported Omarchy operations and runtime cleanup excludes installation state', () => {
  const script = stripComments(read(SCRIPT))
  const adapter = stripComments(read(ADAPTER))
  assert.match(adapter, /\['omarchy-shell', 'shell', 'rescanPlugins'\]/)
  assert.match(adapter, /\['omarchy-shell', 'shell', 'enablePlugin'/)
  assert.match(adapter, /\['omarchy-shell', 'shell', 'summon'/)
  assert.match(adapter, /\['omarchy-shell', 'shell', 'call'/)
  assert.match(adapter, /\['omarchy-shell', 'shell', 'hide'/)
  assert.doesNotMatch(script, /(?:^|[[:space:]])(?:import|source)\s+.*installation\.ts/)
  assert.doesNotMatch(script, /\bomarchy-shell\s+shell\s+(?:disable|uninstall|remove)/)
  assert.match(script, /Persistent plugin: untouched by runtime cleanup/)
  assert.match(read(SCRIPT), /never disables, unloads, updates, or uninstalls/)
  assert.match(script, /INSTALLATION_BEFORE/)
  assert.match(script, /INSTALLATION_AFTER/)
  assert.match(script, /\[\[ "\$INSTALLATION_BEFORE" == "\$INSTALLATION_AFTER" \]\]/)
})

test('private evidence and exact resource identities are enforced by the live procedure', () => {
  const script = stripComments(read(SCRIPT))
  const adapter = stripComments(read(ADAPTER))
  assert.match(script, /umask 077/)
  assert.match(script, /chmod 700/)
  assert.match(script, /chmod 600/)
  assert.match(adapter, /createPrivateEvidenceDirectory/)
  assert.match(adapter, /mode: 0o700|mode 0700/)
  assert.match(adapter, /mode: 0o600|mode 0600/)
  assert.match(script, /process_identity/)
  assert.match(script, /\/proc\/\$pid\/stat/)
  assert.match(script, /terminate_exact_pid/)
  assert.match(script, /stat -c '%d:%i'/)
  assert.match(script, /remove_exact_socket/)
  assert.match(script, /remove_exact_directory/)
  assert.match(script, /WINDOW_ADDRESSES/)
  assert.match(script, /closewindow "address:\$address"/)
  assert.match(script, /RUNTIME_IDENTITY/)
})

test('the retired launcher and ephemeral-loader spike are historical only, not setup dependencies', () => {
  const oldSource = read(OLD_SCRIPT)
  const justfile = read(JUSTFILE)
  const script = stripComments(read(SCRIPT))
  const rawScript = read(SCRIPT)
  assert.match(oldSource, /FAIL CLOSED|RETIRED|rejected/i)
  assert.match(oldSource, /live-agent-console-launch-blocker\.md/)
  assert.match(rawScript, /separate from the retired/)
  assert.doesNotMatch(script, /run-live-agent-console-gate\.sh/)
  assert.doesNotMatch(script, /omarchy-ephemeral-plugin-loader/)

  const automated = ['prototype-vertical-slice', 'prototype-vertical-slice-manual-check', 'prototype-live-agent-console-check']
  for (const recipe of automated) {
    const start = justfile.indexOf(`${recipe}:`)
    assert.ok(start >= 0, `missing recipe ${recipe}`)
    const next = justfile.slice(start + recipe.length + 1).search(/\n[A-Za-z0-9_.-]+:/)
    const body = justfile.slice(start, next < 0 ? undefined : start + recipe.length + 1 + next)
    assert.doesNotMatch(body, /run-live-agent-console-gate\.sh/)
    assert.doesNotMatch(body, /prototype-live-agent-console-gate/)
  }
})
