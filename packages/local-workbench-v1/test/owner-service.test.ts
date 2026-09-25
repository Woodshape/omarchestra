import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const unit = fileURLToPath(new URL('../../../manual/omarchestra-workbench-owner.service', import.meta.url))
const source = readFileSync(unit, 'utf8')

test('bounded systemd verifier accepts the foreground owner as a background user service', t => {
  const home = mkdtempSync(join(tmpdir(), 'omarchestra-service-verify-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const bin = join(home, '.local/share/mise/installs/node/latest/bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(home, 'claude/omarchestra'), { recursive: true })
  symlinkSync(process.execPath, join(bin, 'node'))
  const result = spawnSync('/usr/bin/timeout', [
    '--signal=TERM', '--kill-after=2s', '10s', '/usr/bin/systemd-analyze', '--user', 'verify', unit,
  ], { encoding: 'utf8', timeout: 13_000, env: { ...process.env, HOME: home } })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('service owns only one explicit owner and cannot create a hidden agent or alter Omarchy', () => {
  assert.match(source, /^Type=exec$/m)
  assert.match(source, /^ExecStart=%h\/.local\/share\/mise\/installs\/node\/latest\/bin\/node --experimental-strip-types --experimental-sqlite %h\/claude\/omarchestra\/packages\/local-workbench-v1\/runner\/main\.ts start --state-dir %h\/\.local\/state\/omarchestra\/workbench-phase2-live --runtime-dir %t\/omarchestra-workbench-phase2-live$/m)
  assert.match(source, /^WantedBy=graphical-session\.target$/m)
  assert.match(source, /^Restart=on-failure$/m)
  assert.match(source, /^StartLimitBurst=3$/m)
  assert.match(source, /^UMask=0077$/m)
  assert.doesNotMatch(source, /^(?:ExecStartPre|ExecStopPost|RuntimeDirectory|StateDirectory|User|RemainAfterExit)=/m)
  assert.doesNotMatch(source, /\b(?:pi|boomux|gtk-launch|omarchy-shell|omarchy-restart-shell|systemctl)\b/)
})
