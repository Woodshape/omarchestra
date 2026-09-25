// One-time, human-gated recovery of the 2026-09-25 failed 0.10.0 → 0.11.0
// update. The failed install restored every old asset byte but allocated new
// inodes, leaving the *unchanged* 0.10.0 receipt correctly fail-closed.
// No installer retry, shell reload, Owner restart or Pi action occurs here.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { WORKBENCH_PREVIEW_RELEASE } from './workbench-preview-release.ts'
import { createLiveCompanionPorts, type LiveCompanionPorts } from '../prototypes/first-vertical-slice/manual/live-companion-omarchy.ts'
import { CompanionInstallation } from '../prototypes/first-vertical-slice/companion/installation.ts'

const PLUGIN_ID = 'omarchestra.agent-console'
const ARCHIVE = fileURLToPath(new URL('../packages/local-workbench-v1/companion/retained/0.10.0/', import.meta.url))
const ARCHIVE_DIGEST = 'bfdf06b49550e72df9a7884e3e1cf496d28f408382dd8469fe9e50aca80437c8'
const FAILED_PLAN_DIGEST = '70c81d289cd242c9736184fab33da65c6c71467625f587121e240917d48d9a33'
const FAILED_RECEIPT_DIGEST = 'bb81331b750bb705c9e77a3ba7f9e9f7c729376df6864e4317af81fa4b47c6ad'
export interface IncidentEvidence { failedPlanDigest: string; failedReceiptDigest: string }
const INCIDENT: IncidentEvidence = { failedPlanDigest: FAILED_PLAN_DIGEST, failedReceiptDigest: FAILED_RECEIPT_DIGEST }

export interface RecoveryPaths {
  pluginRoot: string
  receiptPath: string
  shellJsonPath: string
  evidenceDir: string
  failedPlanPath: string
  failedLogPath: string
}

export function recoveryPaths(home: string): RecoveryPaths {
  const evidenceDir = join(home, '.local/state/omarchestra/manual-gates')
  return {
    pluginRoot: join(home, '.config/omarchy/plugins', PLUGIN_ID),
    receiptPath: join(home, '.local/state/omarchestra/companion-installation.json'),
    shellJsonPath: join(home, '.config/omarchy/shell.json'),
    evidenceDir,
    failedPlanPath: join(evidenceDir, 'companion-setup-53804-N1bl4F/installation-plan.json'),
    failedLogPath: join(evidenceDir, 'workbench-same-button-setup-20260925.log'),
  }
}

function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
function refuse(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error(`companion receipt recovery refused: ${reason}`)
}
function privateFile(path: string, mode: number): Buffer {
  const stat = fs.lstatSync(path)
  refuse(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === mode,
    `private evidence identity/mode changed at ${path}`)
  return fs.readFileSync(path)
}
function privateDirectory(path: string): void {
  const stat = fs.lstatSync(path)
  refuse(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    `private evidence directory changed at ${path}`)
}

export interface ReceiptRecoveryPlan {
  kind: 'rebind_failed_companion_receipt'
  installedVersion: '0.10.0'
  attemptedVersion: '0.11.0'
  failedPlanDigest: string
  receiptHash: string
  oldTreeDigest: string
  newIdentities: Array<{ relativePath: string; device: number; inode: number }>
  /** Read-only fingerprint, rechecked under an exclusive recovery lock. */
  currentTreeDigest: string
  backupPath: string
}

/** Read-only: refuse everything except the exact failed update and 15 intact old assets. */
export async function inspectCompanionReceiptRecovery(ports: LiveCompanionPorts, paths: RecoveryPaths,
  incident: IncidentEvidence = INCIDENT): Promise<ReceiptRecoveryPlan> {
  refuse(ports.paths.pluginRoot === paths.pluginRoot && ports.paths.receiptPath === paths.receiptPath
    && ports.paths.shellJson === paths.shellJsonPath, 'port paths do not match the explicit installation')
  privateDirectory(paths.evidenceDir)
  privateDirectory(resolve(paths.failedPlanPath, '..'))
  for (const path of [paths.evidenceDir, paths.failedPlanPath, paths.failedLogPath, paths.receiptPath]) {
    const identity = ports.filesystem.inspectNoFollow(path)
    refuse(identity.kind === (path === paths.evidenceDir ? 'directory' : 'file'), `evidence ancestor is unsafe at ${path}`)
  }
  const failedPlan = JSON.parse(privateFile(paths.failedPlanPath, 0o600).toString('utf8'))
  const logStat = fs.lstatSync(paths.failedLogPath)
  const log = privateFile(paths.failedLogPath, 0o600).toString('utf8')
  const receiptStat = fs.lstatSync(paths.receiptPath)
  const receiptBytes = privateFile(paths.receiptPath, 0o600).toString('utf8')
  const receipt = JSON.parse(receiptBytes)
  const config = ports.filesystem.readBytesNoFollow(paths.shellJsonPath)
  const names = fs.readdirSync(ARCHIVE).sort()
  const oldAssets = Object.fromEntries(names.map(name => {
    const path = join(ARCHIVE, name)
    refuse(fs.lstatSync(path).isFile() && !fs.lstatSync(path).isSymbolicLink(), `archive asset is unsafe: ${name}`)
    return [name, fs.readFileSync(path, 'utf8')]
  }))
  const archiveHash = createHash('sha256')
  for (const name of names) { archiveHash.update(name); archiveHash.update(oldAssets[name]) }
  refuse(archiveHash.digest('hex') === ARCHIVE_DIGEST && names.length === 15, 'historical release archive changed')
  refuse(receipt.schemaVersion === 1 && receipt.pluginId === PLUGIN_ID && receipt.release?.version === '0.10.0'
    && receipt.previousRelease?.version === '0.9.0' && Array.isArray(receipt.assets)
    && receipt.assets.length === names.length, 'receipt is not the exact 0.10.0 installation')
  refuse(ports.digest.stableDigest(receipt.release.assets) === ports.digest.stableDigest(oldAssets),
    'receipt release is not the archived 0.10.0')
  refuse(hash(receiptBytes) === incident.failedReceiptDigest && hash(receiptBytes) === failedPlan.precondition?.receiptDigest,
    'receipt is not the one captured by the failed installation plan')
  refuse(failedPlan.operation === 'update' && failedPlan.pluginId === PLUGIN_ID && failedPlan.release?.version === '0.11.0'
    && failedPlan.planDigest === incident.failedPlanDigest
    && ports.digest.stableDigest(failedPlan.release) === ports.digest.stableDigest(WORKBENCH_PREVIEW_RELEASE),
    'failed installation plan is not the exact 0.11.0 candidate')
  const { planDigest, ...planBody } = failedPlan
  refuse(ports.digest.stableDigest(planBody) === planDigest, 'failed plan digest changed')
  refuse(log.trim() === 'PROMPT_OPENED\nCOMMAND_EXIT_CODE=1'
    && receiptStat.ctimeMs < fs.lstatSync(paths.failedPlanPath).mtimeMs,
    'failed-attempt evidence or original receipt chronology changed')
  refuse(config === receipt.shellJson?.postimageBytes && hash(config) === receipt.shellJson?.postimageHash
    && hash(config) === failedPlan.precondition.shellJsonDigest, 'shell.json is not the original exact postimage')
  const shell = JSON.parse(config)
  refuse((shell.bar?.layout?.right || []).filter((item: any) => item.id === PLUGIN_ID).length === 1
    && (shell.plugins || []).filter((item: any) => item.id === PLUGIN_ID).length === 0,
    'bar placement changed')
  const root = ports.filesystem.inspectNoFollow(paths.pluginRoot)
  refuse(root.kind === 'directory' && root.owner === String(process.getuid()), 'plugin root or ancestor changed')
  const installedNames = ports.filesystem.listDirectoryNoFollow(paths.pluginRoot)
  refuse(JSON.stringify(installedNames) === JSON.stringify(names), 'plugin asset inventory changed')
  const expected: Array<{ identity: unknown; bytes: string | null }> = [{ identity: root, bytes: null }]
  const actual: Array<{ identity: unknown; bytes: string | null }> = [{ identity: root, bytes: null }]
  const replacements: ReceiptRecoveryPlan['newIdentities'] = []
  const priorNames = receipt.assets.map((asset: any) => asset.relativePath).sort()
  refuse(JSON.stringify(priorNames) === JSON.stringify(names), 'receipt asset inventory changed')
  const start = fs.lstatSync(paths.failedPlanPath).mtimeMs
  const end = logStat.mtimeMs
  for (const name of names) {
    const asset = receipt.assets.find((item: any) => item.relativePath === name)
    const file = join(paths.pluginRoot, name)
    const identity = ports.filesystem.inspectNoFollow(file)
    const bytes = ports.filesystem.readBytesNoFollow(file)
    const ctime = fs.lstatSync(file).ctimeMs
    refuse(asset.path === file && asset.device === identity.device && asset.inode !== identity.inode
      && asset.owner === identity.owner && asset.mode === identity.mode && asset.sha256 === hash(bytes)
      && bytes === oldAssets[name] && identity.kind === 'file' && identity.owner === String(process.getuid())
      && ctime >= start && ctime <= end, `asset identity, bytes, or failure chronology changed at ${name}`)
    expected.push({ identity: { ...identity, device: asset.device, inode: asset.inode }, bytes })
    actual.push({ identity, bytes })
    replacements.push({ relativePath: name, device: identity.device!, inode: identity.inode! })
  }
  expected.sort((left: any, right: any) => left.identity.path.localeCompare(right.identity.path))
  actual.sort((left: any, right: any) => left.identity.path.localeCompare(right.identity.path))
  refuse(ports.digest.stableDigest(expected) === failedPlan.precondition.pluginTreeDigest,
    'pre-failure parent or asset identities do not match the authorized plan')
  const compatibility = await ports.host.compatibility()
  refuse(ports.digest.stableDigest(compatibility) === failedPlan.precondition.hostCompatibilityDigest,
    'host compatibility changed since the failed attempt')
  return {
    kind: 'rebind_failed_companion_receipt', installedVersion: '0.10.0', attemptedVersion: '0.11.0',
    failedPlanDigest: planDigest, receiptHash: hash(receiptBytes),
    oldTreeDigest: failedPlan.precondition.pluginTreeDigest,
    currentTreeDigest: ports.digest.stableDigest(actual), newIdentities: replacements,
    backupPath: join(paths.evidenceDir, `companion-pre-rebind-${hash(receiptBytes)}.json`),
  }
}

export async function applyCompanionReceiptRecovery(ports: LiveCompanionPorts, paths: RecoveryPaths,
  plan: ReceiptRecoveryPlan, incident: IncidentEvidence = INCIDENT): Promise<{ backupPath: string; receiptHash: string }> {
  privateDirectory(paths.evidenceDir)
  const lockPath = join(paths.evidenceDir, '.companion-rebind.lock')
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try {
    const current = await inspectCompanionReceiptRecovery(ports, paths, incident)
    refuse(JSON.stringify(current) === JSON.stringify(plan), 'plan became stale before mutation')
    const original = privateFile(paths.receiptPath, 0o600).toString('utf8')
    const receipt = JSON.parse(original)
    const changed = new Map(plan.newIdentities.map(entry => [entry.relativePath, entry]))
    const updated = JSON.stringify({ ...receipt, assets: receipt.assets.map((asset: any) => {
      const identity = changed.get(asset.relativePath)
      refuse(identity, `unrecorded asset ${asset.relativePath}`)
      return { ...asset, device: identity.device, inode: identity.inode }
    }) })
    const backup = fs.openSync(plan.backupPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600)
    try { fs.writeFileSync(backup, original); fs.fsyncSync(backup) } finally { fs.closeSync(backup) }
    const directory = fs.openSync(paths.evidenceDir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    refuse(privateFile(plan.backupPath, 0o600).toString('utf8') === original, 'backup readback differs')
    const immediatelyBefore = await inspectCompanionReceiptRecovery(ports, paths, incident)
    refuse(JSON.stringify(immediatelyBefore) === JSON.stringify(plan), 'ownership changed after backup')
    ports.filesystem.writeBytesAtomic(paths.receiptPath, updated, String(process.getuid()), 0o600)
    const readback = privateFile(paths.receiptPath, 0o600).toString('utf8')
    refuse(readback === updated, 'new receipt readback differs; preserve backup')
    const next = await new CompanionInstallation(ports).inspect({ operation: 'update', release: WORKBENCH_PREVIEW_RELEASE })
    refuse(next.operation === 'update', 'post-recovery installer inspection refused; preserve backup')
    return { backupPath: plan.backupPath, receiptHash: hash(readback) }
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lockPath)
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--plan', '--apply'].includes(mode)) throw Error('use --plan or --apply')
  const home = process.env.HOME
  if (!home || resolve(home) !== home) throw Error('a real absolute HOME is required')
  const paths = recoveryPaths(home)
  const ports = createLiveCompanionPorts({ release: WORKBENCH_PREVIEW_RELEASE })
  const plan = await inspectCompanionReceiptRecovery(ports, paths)
  console.log(JSON.stringify(plan, null, 2))
  if (mode === '--plan') return
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('receipt recovery requires a visible operator TTY')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Rebind only these 15 restored 0.10.0 assets; backup receipt ${plan.receiptHash.slice(0, 12)}? [y/N] `)
    if (!/^(?:y|yes)$/i.test(answer.trim())) throw Error('receipt recovery declined; no mutation')
  } finally { prompt.close() }
  const result = await applyCompanionReceiptRecovery(ports, paths, plan)
  console.log(JSON.stringify({ kind: 'rebound', ...result }))
  console.log('No Companion update, shell reload, Owner restart, or Pi start occurred. A NEW exact 0.11.0 update plan still needs its own TTY confirmation.')
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
