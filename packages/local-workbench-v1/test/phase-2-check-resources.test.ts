import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { STORE_SCHEMA_VERSION } from '../runner/schema.ts'
import { WorkbenchAuthority, canonicalJson, sha256 } from '../runner/authority.ts'
import { readResolvedCheck, verifyCheckResources } from '../runner/check-definition.ts'

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'wb-check-resources-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, 'project'), stateDir = join(root, 'state')
  mkdirSync(project); mkdirSync(stateDir, { mode: 0o700 })
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: project, timeout: 5000, env: {
    PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  } })
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'fixture')
  const runner = openWorkbenchRunner({ roots: { stateDir } })
  t.after(() => runner.close())
  const authority = new WorkbenchAuthority({ runner, sessionId: 'session', pluginGeneration: 1 })
  const inspected = authority.inspect(project)
  const registered = authority.confirmRegistration(inspected.inspectionId)
  const script = join(project, 'verify.sh'), config = join(project, 'validator.conf'), marker = join(project, 'executed')
  writeFileSync(script, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 })
  writeFileSync(config, 'v1\n')
  const draft = { executable: script, argv: ['--config', config], cwd: project,
    environment: [{ name: 'CI', value: '1' }], resourcePaths: [config],
    timeoutMs: 1000, outputBytes: 4096, maxCorrections: 1, elapsedMs: 60000 }
  const fields = { name: 'Smoke check', summary: 'A configured script', mode: 'validator', commandSummary: 'smoke', definitionDraft: draft }
  return { root, project, script, config, marker, runner, authority, registered, draft, fields }
}

test('configured check resolves full canonical definition, pins bytes and versions changes without executing', t => {
  const f = fixture(t)
  const first = f.authority.createCheck(f.registered.projectId, f.fields)
  const parsed = readResolvedCheck(first)
  assert.equal(parsed.cwd, f.project)
  assert.equal(parsed.executable, f.script)
  assert.equal(parsed.executableDigest, sha256(readFileSync(f.script).toString()))
  assert.equal(parsed.resources[0].digest, sha256('v1\n'))
  assert.equal(parsed.resources[0].path, f.config)
  assert.equal(parsed.resources[0].length, 3)
  assert.equal(parsed.maxCorrections, 1)
  assert.equal(first.digest, sha256(first.canonicalJson))
  assert.equal(first.canonicalJson, canonicalJson(parsed))
  assert.equal(f.runner.store.getCheck(first.projectId, first.checkId, 1)?.digest, first.digest)
  assert.equal(verifyCheckResources(first, f.registered).version, 1)
  writeFileSync(f.config, 'v2\n')
  assert.throws(() => verifyCheckResources(first, f.registered), /resource changed since configuration/)
  const second = f.authority.configureCheck(first.projectId, first.checkId, first.version, f.fields)
  assert.equal(second.version, 2)
  assert.notEqual(second.digest, first.digest)
  assert.equal(readResolvedCheck(second).resources[0].digest, sha256('v2\n'))
  assert.equal(verifyCheckResources(second, f.registered).version, 2)
  assert.equal(f.runner.store.getCheck(first.projectId, first.checkId, 1)?.digest, first.digest)
  assert.equal(readResolvedCheck(first).resources[0].digest, sha256('v1\n'))
  assert.throws(() => f.authority.configureCheck(first.projectId, first.checkId, 1, f.fields), /version 2/)
  assert.equal(f.runner.store.listChecks(first.projectId).length, 2)
  assert.equal(readFileSync(f.script, 'utf8').includes('executed'), true)
  assert.throws(() => readFileSync(f.marker), /ENOENT/, 'saving checks must never invoke the script')
})

test('invalid drafts, missing/escaped/symlink/oversized resources fail before any version/event', t => {
  const f = fixture(t)
  const first = f.authority.createCheck(f.registered.projectId, f.fields)
  const initial = f.authority.currentRevision
  const config = f.fields.definitionDraft
  const bad = [
    { ...config, resourcePaths: [join(f.project, 'absent')] },
    { ...config, resourcePaths: [join(f.root, 'outside')] },
    { ...config, resourcePaths: [f.project] },
    { ...config, resourcePaths: [f.config, f.config] },
    { ...config, executable: join(f.project, 'absent') },
    { ...config, executable: f.config },
    { ...config, cwd: f.root },
    { ...config, environment: [{ name: 'OPENAI_API_KEY', value: 'anything' }] },
    { ...config, environment: [{ name: 'PATH', value: '/tmp' }] },
    { ...config, resourcePaths: [f.config], digest: 'f'.repeat(64) },
    {},
  ]
  const link = join(f.project, 'link'); symlinkSync(f.config, link)
  bad.push({ ...config, resourcePaths: [link] })
  const sub = join(f.project, 'alias'); symlinkSync(f.root, sub)
  bad.push({ ...config, resourcePaths: [join(sub, 'outside')] })
  const huge = join(f.project, 'huge'); writeFileSync(huge, ''); truncateSync(huge, 64 * 1024 * 1024 + 1)
  assert.throws(() => f.authority.configureCheck(first.projectId, first.checkId, 1,
    { ...f.fields, definitionDraft: { ...config, resourcePaths: [huge] } }), /file must be a bounded regular file/)
  const second = join(f.project, 'second'); writeFileSync(second, ''); truncateSync(huge, 40 * 1024 * 1024)
  truncateSync(second, 25 * 1024 * 1024)
  bad.push({ ...config, resourcePaths: [huge, second] })
  for (const definitionDraft of bad) {
    assert.throws(() => f.authority.configureCheck(first.projectId, first.checkId, 1, { ...f.fields, definitionDraft }), /Check definition:/)
  }
  assert.equal(f.runner.store.listChecks(first.projectId).length, 1)
  assert.equal(f.authority.currentRevision, initial)
})

test('intent rejection is durable, does not change check version and cannot be replayed as a later grant', t => {
  const f = fixture(t)
  const intent = { protocol: 'omarchestra.workbench/v1', intentId: 'bad-check', sessionId: 'session', pluginGeneration: 1,
    runnerEpoch: f.runner.epoch, expectedRevision: f.authority.currentRevision, kind: 'create_check', target: null,
    payload: { ...f.fields, projectId: f.registered.projectId, definitionDraft: { ...f.draft, resourcePaths: [join(f.root, 'missing')] } } }
  const rejected = f.authority.handleIntent(intent)
  assert.equal(rejected.status, 'rejected')
  assert.equal(f.authority.handleIntent(intent).status, 'rejected')
  assert.equal(f.runner.store.listChecks(f.registered.projectId).length, 0)
  assert.equal(f.authority.handleIntent({ ...intent, payload: { ...intent.payload, definitionDraft: f.draft } }).reasonCode, 'intent_identity_conflict')
  const valid = f.authority.handleIntent({ ...intent, intentId: 'valid-check', payload: { ...intent.payload, definitionDraft: f.draft } })
  assert.equal(valid.status, 'acknowledged')
  assert.equal(f.runner.store.listChecks(f.registered.projectId).length, 1)
})

test('schema 7 retained roots are refused instead of silently treating old drafts as resolved checks', t => {
  const f = fixture(t)
  const storePath = f.runner.store.path, stateDir = f.runner.roots.stateDir
  assert.equal(STORE_SCHEMA_VERSION, 8)
  f.runner.close()
  const db = new DatabaseSync(storePath)
  db.exec('PRAGMA user_version = 7')
  db.close()
  assert.throws(() => openWorkbenchRunner({ roots: { stateDir } }), /schema version 7 is not supported/)
})

test('stored definition rejects corruption rather than projecting unchecked bytes', t => {
  const f = fixture(t)
  const first = f.authority.createCheck(f.registered.projectId, f.fields)
  assert.throws(() => readResolvedCheck({ ...first, canonicalJson: first.canonicalJson + ' ' }), /digest is invalid/)
  assert.throws(() => readResolvedCheck({ ...first, name: 'not the stored name' }), /identity\/shape drift/)
  chmodSync(f.script, 0o600)
  assert.throws(() => verifyCheckResources(first, f.registered), /executable is not marked executable/)
  assert.throws(() => f.authority.configureCheck(first.projectId, first.checkId, 1, f.fields), /executable is not marked executable/)
})
