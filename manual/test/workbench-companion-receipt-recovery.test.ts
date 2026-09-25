import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKBENCH_PREVIEW_RELEASE } from '../workbench-preview-release.ts'
import { createLiveCompanionPorts } from '../../prototypes/first-vertical-slice/manual/live-companion-omarchy.ts'
import { CompanionInstallation } from '../../prototypes/first-vertical-slice/companion/installation.ts'
import { applyCompanionReceiptRecovery, inspectCompanionReceiptRecovery, recoveryPaths } from '../workbench-companion-receipt-recovery.ts'

const id = 'omarchestra.agent-console'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const assets = (version: string) => {
  const path = new URL(`../../packages/local-workbench-v1/companion/retained/${version}/`, import.meta.url)
  return Object.fromEntries(fs.readdirSync(path).map(name => [name, fs.readFileSync(new URL(name, path), 'utf8')]))
}
const release = (version: string) => ({ pluginId: id, version, protocol: 'omarchestra.companion/v1',
  compatibility: null, assets: assets(version) })
const compat = { omarchy: '4.0.4-1', quickshell: '0.3.1-1' }

async function fixture(t: import('node:test').TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'workbench-rebind-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const paths = recoveryPaths(home)
  for (const directory of [join(home, '.config/omarchy/plugins'), paths.pluginRoot,
    join(home, '.local/state/omarchestra'), paths.evidenceDir,
    join(paths.evidenceDir, 'companion-setup-53804-N1bl4F')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 })
  }
  fs.chmodSync(paths.evidenceDir, 0o700)
  fs.chmodSync(join(paths.evidenceDir, 'companion-setup-53804-N1bl4F'), 0o700)
  const preimage = JSON.stringify({ plugins: [], bar: { layout: { left: [], center: [], right: [] } } })
  const postimage = JSON.stringify({ plugins: [], bar: { layout: { left: [], center: [], right: [{ id }] } } })
  fs.writeFileSync(paths.shellJsonPath, postimage, { mode: 0o644 })
  const ports = createLiveCompanionPorts({ home, release: WORKBENCH_PREVIEW_RELEASE,
    receiptPath: paths.receiptPath, shellJson: paths.shellJsonPath, pluginRoot: paths.pluginRoot,
    pluginsRoot: join(home, '.config/omarchy/plugins') })
  // Only this disposable test's world-writable /tmp ancestor is represented as
  // safe; the production recovery uses the unmodified live no-follow port.
  const inspectActual = ports.filesystem.inspectNoFollow.bind(ports.filesystem)
  ports.filesystem.inspectNoFollow = path => {
    const value = inspectActual(path)
    return path === '/tmp' ? { ...value, mode: 0o755 } : value
  }
  // The injected host is a fake fact provider: no live Omarchy commands run.
  ports.host = { compatibility: async () => compat, currentOwner: async () => String(process.getuid()) } as typeof ports.host
  const archived = assets('0.10.0')
  for (const [name, bytes] of Object.entries(archived)) {
    fs.writeFileSync(join(paths.pluginRoot, name), bytes, { mode: 0o644 })
  }
  const receipt = {
    schemaVersion: 1, pluginId: id, release: release('0.10.0'), previousRelease: release('0.9.0'),
    compatibility: compat, planDigest: 'a'.repeat(64), installedAt: '2026-09-24T16:00:00.000Z',
    assets: Object.keys(archived).sort().map(relativePath => {
      const identity = ports.filesystem.inspectNoFollow(join(paths.pluginRoot, relativePath))
      return { relativePath, path: identity.path, sha256: digest(archived[relativePath]),
        owner: identity.owner, mode: identity.mode, device: identity.device, inode: identity.inode }
    }),
    shellJson: { preimageBytes: preimage, preimageHash: digest(preimage),
      postimageBytes: postimage, postimageHash: digest(postimage) },
  }
  const original = JSON.stringify(receipt)
  fs.writeFileSync(paths.receiptPath, original, { mode: 0o600 })
  // This bounded incident belongs to 0.11.0 forever, not whichever release is
  // currently in development. Do not widen production recovery authorization.
  const candidate = await new CompanionInstallation(ports).inspect({ operation: 'update', release: release('0.11.0') })
  fs.writeFileSync(paths.failedPlanPath, JSON.stringify(candidate), { mode: 0o600 })
  // Model the real atomic writer's rollback mistake: bytes restored, all
  // identities replaced, receipt and shell configuration unchanged.
  for (const [name, bytes] of Object.entries(archived)) {
    ports.filesystem.writeBytesAtomic(join(paths.pluginRoot, name), 'intermediate', String(process.getuid()), 0o644)
    ports.filesystem.writeBytesAtomic(join(paths.pluginRoot, name), bytes, String(process.getuid()), 0o644)
  }
  fs.writeFileSync(paths.failedLogPath, 'PROMPT_OPENED\nCOMMAND_EXIT_CODE=1\n', { mode: 0o600 })
  return { ports, paths, candidate, receipt, original,
    incident: { failedPlanDigest: candidate.planDigest, failedReceiptDigest: digest(original) } }
}

test('failed atomic rollback cannot update normally; exact plan rebinds only inodes with an external original receipt backup', async t => {
  const { ports, paths, candidate, original, incident } = await fixture(t)
  await assert.rejects(() => new CompanionInstallation(ports).inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE }), /identity|foreign/)
  const beforeAssets = fs.readdirSync(paths.pluginRoot).map(name => fs.readFileSync(join(paths.pluginRoot, name)))
  const beforeConfig = fs.readFileSync(paths.shellJsonPath)
  const plan = await inspectCompanionReceiptRecovery(ports, paths, incident)
  assert.equal(plan.newIdentities.length, 15)
  assert.equal(plan.oldTreeDigest, candidate.precondition.pluginTreeDigest)
  const result = await applyCompanionReceiptRecovery(ports, paths, plan, incident)
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), original)
  assert.equal(fs.lstatSync(result.backupPath).mode & 0o777, 0o600)
  assert.deepEqual(fs.readFileSync(paths.shellJsonPath), beforeConfig)
  assert.deepEqual(fs.readdirSync(paths.pluginRoot).map(name => fs.readFileSync(join(paths.pluginRoot, name))), beforeAssets)
  assert.equal(JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8')).release.version, '0.10.0')
  await new CompanionInstallation(ports).inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
  await assert.rejects(() => inspectCompanionReceiptRecovery(ports, paths, incident), /receipt/)
})

test('the recovery plan fails closed on drift, stale authorization or missing failure evidence', async t => {
  const { ports, paths, incident } = await fixture(t)
  const plan = await inspectCompanionReceiptRecovery(ports, paths, incident)
  await assert.rejects(() => applyCompanionReceiptRecovery(ports, paths,
    { ...plan, currentTreeDigest: 'a'.repeat(64) }, incident), /stale/)
  assert.equal(fs.existsSync(plan.backupPath), false)
  fs.appendFileSync(paths.shellJsonPath, '\n')
  await assert.rejects(() => inspectCompanionReceiptRecovery(ports, paths, incident), /shell.json/)
  fs.writeFileSync(paths.shellJsonPath, JSON.parse(fs.readFileSync(paths.receiptPath, 'utf8')).shellJson.postimageBytes)
  fs.writeFileSync(join(paths.pluginRoot, 'WorkbenchConsole.qml'), 'foreign content')
  await assert.rejects(() => inspectCompanionReceiptRecovery(ports, paths, incident), /asset identity|failure chronology/)
  assert.equal(fs.existsSync(plan.backupPath), false)
})
