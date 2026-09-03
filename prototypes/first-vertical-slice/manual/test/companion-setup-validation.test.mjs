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

test('live capability discovery returns the installed plugin response rather than controller-local constants', async () => {
  const { LiveCompanionShell } = await import('../live-companion-omarchy.ts')
  const commands = []
  const command = {
    run(argv) {
      commands.push([...argv])
      if (argv[2] === 'listPlugins') {
        return { status: 0, stdout: JSON.stringify([{ id: 'omarchestra.agent-console', enabled: true, kinds: ['panel'] }]), stderr: '' }
      }
      if (argv[2] === 'call' && argv[4] === 'capabilities') {
        return {
          status: 0,
          stdout: JSON.stringify({
            protocol: 'omarchestra.companion/v1',
            pluginId: 'omarchestra.agent-console',
            version: '0.2.0',
            pluginGeneration: 771,
            capabilities: ['session.open', 'session.update', 'session.intent', 'session.hide', 'session.clear', 'session.resnapshot'],
          }),
          stderr: '',
        }
      }
      return { status: 0, stdout: 'ok\n', stderr: '' }
    },
  }
  const shell = new LiveCompanionShell(command)
  const capabilities = await shell.capabilities('omarchestra.agent-console')
  assert.equal(capabilities.pluginGeneration, 771)
  assert.ok(commands.some((argv) => argv[2] === 'call' && argv[4] === 'capabilities'))
})

test('a rejected exit-zero shell response is included in the bounded live error', async () => {
  const { LiveCompanionShell } = await import('../live-companion-omarchy.ts')
  const shell = new LiveCompanionShell({
    run() { return { status: 0, stdout: 'unknown\n', stderr: '' } },
  })

  assert.throws(
    () => shell.enable('omarchestra.agent-console'),
    /stdout="unknown"/,
  )
})

test('rescan waits until the installed plugin is discoverable before one enable attempt', async () => {
  const { LiveCompanionShell } = await import('../live-companion-omarchy.ts')
  const commands = []
  let listAttempts = 0
  const command = {
    run(argv) {
      commands.push([...argv])
      if (argv[2] === 'rescanPlugins') return { status: 0, stdout: '', stderr: '' }
      if (argv[2] === 'listPlugins') {
        listAttempts += 1
        const plugins = listAttempts < 3
          ? []
          : [{ id: 'omarchestra.agent-console', enabled: false, kinds: ['panel'] }]
        return { status: 0, stdout: JSON.stringify(plugins), stderr: '' }
      }
      if (argv[2] === 'enablePlugin') {
        return listAttempts >= 3
          ? { status: 0, stdout: 'ok\n', stderr: '' }
          : { status: 0, stdout: 'unknown\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`)
    },
  }
  const shell = new LiveCompanionShell(command)

  await shell.rescan('omarchestra.agent-console')
  await shell.enable('omarchestra.agent-console')

  assert.equal(listAttempts, 3)
  assert.equal(commands.filter((argv) => argv[2] === 'enablePlugin').length, 1)
  assert.deepEqual(commands.map((argv) => argv[2]), [
    'rescanPlugins', 'listPlugins', 'listPlugins', 'listPlugins', 'enablePlugin',
  ])
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

test('projection control accepts multiple sequential commands without one-writer EOF', async () => {
  const { ProjectionControlQueue } = await import('../live-companion-omarchy.ts')
  const queue = new ProjectionControlQueue()
  queue.accept('reload\n')
  queue.accept('clear\nhide\n')
  queue.accept('quit\n')
  assert.deepEqual([
    await queue.next(),
    await queue.next(),
    await queue.next(),
    await queue.next(),
  ], ['reload', 'clear', 'hide', 'quit'])
  assert.throws(() => queue.accept('unknown\n'), /unknown|control/i)
})

test('the live verifier compares complete committed role presentation values', () => {
  const script = stripComments(read(SCRIPT))
  const start = script.indexOf('wait_for_projection() {')
  const end = script.indexOf('\nsend_projection_control() {', start)
  assert.ok(start >= 0 && end > start)
  const verifier = script.slice(start, end)
  assert.match(verifier, /coordinator="Coordinator · \$1"/)
  assert.match(verifier, /builder="Builder · \$2"/)
  assert.match(verifier, /reviewer="Reviewer · \$3"/)
  assert.match(verifier, /\.piStatus == \$coordinator/)
  assert.match(verifier, /\.piStatus == \$builder/)
  assert.match(verifier, /\.piStatus == \$reviewer/)
})

test('runtime identity files contain real newlines and cleanup binds every expected identity', () => {
  const script = stripComments(read(SCRIPT))
  assert.match(script, /write_private_line "\$RUNTIME_DIR\/\$role\.session-id" "\$session_id"/)
  assert.doesNotMatch(script, /"\$session_id\\n"/)
  const writerStart = script.indexOf('write_private_line() {')
  const writerEnd = script.indexOf('\nappend_private() {', writerStart)
  assert.ok(writerStart >= 0 && writerEnd > writerStart)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchestra-private-line-'))
  try {
    const output = path.join(scratch, 'session-id')
    const writerResult = spawnSync('bash', ['-c', `
      set -euo pipefail
      ${script.slice(writerStart, writerEnd)}
      write_private_line "$1" '2fdbd226-b15d-4696-bf9e-706b993daefb'
    `, 'test-private-line', output], { encoding: 'utf8' })
    assert.equal(writerResult.status, 0, `${writerResult.stdout}\n${writerResult.stderr}`)
    assert.equal(fs.readFileSync(output, 'utf8'), '2fdbd226-b15d-4696-bf9e-706b993daefb\n')
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  assert.match(script, /remove_exact_directory\(\) \{\s*local directory="\$1" expected="\$2" current/)
  assert.match(script, /if ! current=\$\(process_identity "\$pid"/)
  assert.match(script, /\[\[ ! -e "\/proc\/\$pid" \]\] && return 0/)
})

test('exact cleanup accepts a recorded Ghostty only after it reaches zombie shutdown', () => {
  const script = stripComments(read(SCRIPT))
  const start = script.indexOf('terminate_exact_pid() {')
  const end = script.indexOf('\nclose_exact_window() {', start)
  assert.ok(start >= 0 && end > start)
  const termination = script.slice(start, end)
  const zombieCheck = termination.indexOf('recorded_process_is_zombie "$pid" "$expected"')
  const identityRead = termination.indexOf('current=$(process_identity "$pid"')
  assert.ok(zombieCheck >= 0 && zombieCheck < identityRead,
    'an exact recorded zombie must be reaped before its empty cmdline can look like drift')
  assert.match(script, /recorded_process_is_zombie\(\)/)
  assert.match(script, /"\$actual_start" == "\$expected_start"/)
  assert.match(script, /"\$state" == Z/)
})

test('Pi PID registration waits for the visible host exec identity', () => {
  const script = stripComments(read(SCRIPT))
  const helperStart = script.indexOf('register_pi_pid_after_exec() {')
  const helperEnd = script.indexOf('\nterminate_exact_pid() {', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const helper = script.slice(helperStart, helperEnd)
  assert.match(helper, /process_identity "\$pid"/)
  assert.match(helper, /pi --no-extensions/)
  assert.match(helper, /register_pid "\$pid" "Pi \$role"/)
  assert.match(script, /register_pi_pid_after_exec "\$pi_pid" "\$role"/)
  assert.doesNotMatch(script, /register_pid "\$pi_pid" "Pi \$role"/)
})

test('PID registration binds both arguments before aligned cleanup bookkeeping', () => {
  const script = stripComments(read(SCRIPT))
  const registerStart = script.indexOf('register_pid() {')
  const registerEnd = script.indexOf('\nterminate_exact_pid() {', registerStart)
  const cleanupStart = script.indexOf('cleanup() {')
  const cleanupEnd = script.indexOf('\ntrap cleanup ', cleanupStart)
  assert.ok(registerStart >= 0 && registerEnd > registerStart)
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart)
  const registration = script.slice(registerStart, registerEnd)
  const cleanup = script.slice(cleanupStart, cleanupEnd)

  assert.match(registration, /\[\[ "\$#" -eq 2 \]\]/)
  assert.match(registration, /local pid="\$1" label="\$2" identity/)
  const result = spawnSync('bash', ['-c', `
    set -euo pipefail
    PIDS=(); PID_LABELS=(); PID_IDENTITIES=(); EVIDENCE_DIR=/fake
    process_identity() { printf '123\\tfake-command'; }
    append_private() { :; }
    ${registration}
    register_pid 42 'Ghostty coordinator'
    [[ \${#PIDS[@]} -eq 1 ]]
    [[ \${PIDS[0]} == 42 ]]
    [[ \${PID_LABELS[0]} == 'Ghostty coordinator' ]]
    [[ \${PID_IDENTITIES[0]} == $'123\\tfake-command' ]]
  `], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const cleanupResult = spawnSync('bash', ['-c', `
    set -u
    PIDS=(42); PID_LABELS=(); PID_IDENTITIES=()
    WINDOW_CLASSES=(); WINDOW_ADDRESSES=(); WINDOW_PIDS=()
    CLEANED=0; CLEANUP_SAFE=1; GATE_COMPLETED=1; PLUGIN_READY=0
    EVIDENCE_DIR=/missing; RUNNER_SOCKET=''; RUNNER_SOCKET_IDENTITY=''
    CONTROL_SOCKET=''; CONTROL_SOCKET_IDENTITY=''; RUNTIME_DIR=''; RUNTIME_IDENTITY=''
    close_exact_window() { :; }
    terminate_exact_pid() { return 99; }
    remove_exact_socket() { :; }
    remove_exact_directory() { :; }
    append_private() { :; }
    ${cleanup}
    cleanup
    [[ $? -eq 1 ]]
  `], { encoding: 'utf8' })
  assert.equal(cleanupResult.status, 0, `${cleanupResult.stdout}\n${cleanupResult.stderr}`)
  assert.match(cleanupResult.stderr, /PID bookkeeping mismatch/)
  assert.doesNotMatch(cleanupResult.stderr, /unbound variable/)
  assert.match(cleanup, /\$\{#PIDS\[@\]\} == \$\{#PID_LABELS\[@\]\}/)
  assert.match(cleanup, /\$\{#PIDS\[@\]\} == \$\{#PID_IDENTITIES\[@\]\}/)
  assert.ok(cleanup.indexOf('${#PIDS[@]} == ${#PID_LABELS[@]}')
    < cleanup.indexOf('terminate_exact_pid "${PIDS[$index]}"'))
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
  assert.match(script, /CONTROL_SOCKET_IDENTITY/)
  assert.match(script, /RUNTIME_PARENT_CANONICAL/)
  assert.match(script, /remove_exact_socket "\$CONTROL_SOCKET" "\$CONTROL_SOCKET_IDENTITY"/)
  assert.match(adapter, /captureLiveSocketIdentity/)
  assert.match(adapter, /identity\.dev/)
  assert.match(adapter, /identity\.ino/)
  assert.match(adapter, /sameSocketIdentity\(controlIdentity, currentControlIdentity\)/)
  assert.match(adapter, /control\.unref\(\)/, 'identity drift must avoid Node close-path unlink behavior')
  assert.doesNotMatch(script, /mkfifo|remove_exact_fifo|CONTROL_FIFO/, 'one-shot FIFOs cannot carry the multi-command gate')
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
