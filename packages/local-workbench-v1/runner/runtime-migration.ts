/** Explicit v1/v2 -> v3 ownership receipt migration.
 * Never called by owner startup or a bar click. It verifies the exact prior
 * receipt, preserves its bytes outside the state root, and writes a new stable
 * filesystem-identity receipt only after an exact operator plan is authorized.
 */
import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { acquireOwnerLock } from './owner-lock.ts'
import { captureDurableOwnedPaths, captureOwnedPaths, durableOwnedPaths, ownedPathIdentity, refuseOwnedIdentity, runtimeOwnedPaths, verifyOwnedReceipt, type DurableOwnedIdentity, type OwnedIdentity } from './owned-resources.ts'
import { readManifest } from './manifest.ts'
import { resolveRoots, ensureOwnedFileTarget, type WorkbenchRoots, type WorkbenchRootsInput } from './paths.ts'

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const tmpName = 'ownership.json.v3-new'
type LegacyReceipt = { version: 1 | 2; resources: Record<string, OwnedIdentity>; runtimePath?: string }
export interface RuntimeMigrationPlan {
  schemaVersion: 3
  receiptVersion: 1 | 2
  stateDir: string
  runtimeDir: string
  receiptHash: string
  nextHash: string
  driftedEphemeralPaths: string[]
  /** Legacy dev fields that differ; informational only and omitted from v3. */
  legacyDeviceDriftPaths: string[]
  nextResources: Record<string, DurableOwnedIdentity>
  digest: string
}

function rootsForMigration(input: WorkbenchRootsInput): WorkbenchRoots {
  if (!input.runtimeDir || !isAbsolute(input.runtimeDir)) refuseOwnedIdentity('migration requires the explicit existing runtime root')
  // Inspection is read-only: resolveRoots would create missing roots.
  let state
  try { state = lstatSync(input.stateDir) }
  catch { refuseOwnedIdentity('state root is missing; migration never creates or adopts it') }
  if (state.isSymbolicLink() || !state.isDirectory()) refuseOwnedIdentity('state root is not a real directory')
  let runtime
  try { runtime = lstatSync(input.runtimeDir) }
  catch { refuseOwnedIdentity('runtime root is missing; migration never creates or adopts it') }
  if (runtime.isSymbolicLink() || !runtime.isDirectory()) refuseOwnedIdentity('runtime root is not a real directory')
  const roots = resolveRoots(input)
  if (!roots.runtimeDir) refuseOwnedIdentity('migration requires a runtime root')
  const parent = lstatSync(dirname(roots.runtimeDir))
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) {
    refuseOwnedIdentity('runtime parent is not the current private user runtime root')
  }
  if (readdirSync(roots.runtimeDir).length !== 0) refuseOwnedIdentity('runtime root is not empty; never move or delete a socket by name')
  readManifest(roots)
  return roots
}
function legacyBytes(roots: WorkbenchRoots): { bytes: string; receipt: LegacyReceipt } {
  const path = join(roots.stateDir, 'ownership.json')
  ensureOwnedFileTarget(path)
  const s = lstatSync(path)
  if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 65536) refuseOwnedIdentity('legacy receipt ownership, mode, links or size is unsafe')
  const bytes = readFileSync(path, 'utf8')
  let parsed: any
  try { parsed = JSON.parse(bytes) } catch { refuseOwnedIdentity('legacy receipt is not valid JSON') }
  const v1 = parsed && parsed.version === 1 && Object.keys(parsed).sort().join(',') === 'resources,version'
  const v2 = parsed && parsed.version === 2 && Object.keys(parsed).sort().join(',') === 'resources,runtimePath,version'
  if ((!v1 && !v2) || !parsed.resources || typeof parsed.resources !== 'object' || Array.isArray(parsed.resources)) {
    refuseOwnedIdentity('not an exact v1 or v2 ownership receipt')
  }
  if (v2 && parsed.runtimePath !== roots.runtimeDir) refuseOwnedIdentity('v2 receipt runtime path differs from the explicit root')
  const keys = (parsed.version === 1
    ? [...new Set([...durableOwnedPaths(roots), ...runtimeOwnedPaths(roots)])]
    : durableOwnedPaths(roots)).sort()
  if (!same(Object.keys(parsed.resources).sort(), keys)) refuseOwnedIdentity('legacy receipt resource names do not match these explicit roots')
  for (const key of keys) {
    const value = parsed.resources[key]
    if (!value || Object.keys(value).sort().join(',') !== 'dev,ino,kind,uid'
        || !['file', 'directory'].includes(value.kind)
        || ![value.dev, value.ino, value.uid].every((x: unknown) => typeof x === 'string' && /^\d+$/.test(x))) {
      refuseOwnedIdentity('legacy receipt contains malformed identity')
    }
  }
  return { bytes, receipt: parsed }
}
function captureValidated(roots: WorkbenchRoots) {
  const { bytes, receipt } = legacyBytes(roots)
  const durablePaths = durableOwnedPaths(roots)
  const durableNow = captureOwnedPaths(durablePaths)
  const legacyDeviceDriftPaths: string[] = []
  for (const path of durablePaths) {
    const prior = receipt.resources[path], actual = durableNow[path]
    if (!prior || actual.ino !== prior.ino || actual.uid !== prior.uid || actual.kind !== prior.kind) {
      refuseOwnedIdentity(`durable owned resource changed: ${path}`)
    }
    if (prior.dev !== actual.dev) legacyDeviceDriftPaths.push(path)
  }
  const driftedEphemeralPaths: string[] = []
  if (receipt.version === 1) {
    const runtimeNow = captureOwnedPaths(runtimeOwnedPaths(roots))
    for (const [path, actual] of Object.entries(runtimeNow)) {
      const prior = receipt.resources[path]
      if (actual.kind !== 'directory' || prior.kind !== 'directory' || actual.uid !== prior.uid) {
        refuseOwnedIdentity(`runtime parent kind or owner changed: ${path}`)
      }
      if (!same(prior, actual)) driftedEphemeralPaths.push(path)
    }
  }
  const nextResources = captureDurableOwnedPaths(durablePaths)
  const next = JSON.stringify({ version: 3, resources: nextResources, runtimePath: roots.runtimeDir }) + '\n'
  const base = { schemaVersion: 3 as const, receiptVersion: receipt.version, stateDir: roots.stateDir, runtimeDir: roots.runtimeDir!,
    receiptHash: hash(bytes), nextHash: hash(next), driftedEphemeralPaths, legacyDeviceDriftPaths, nextResources }
  return { bytes, next, plan: { ...base, digest: hash(JSON.stringify(base)) } }
}
export function inspectRuntimeMigration(input: WorkbenchRootsInput): RuntimeMigrationPlan {
  return captureValidated(rootsForMigration(input)).plan
}
function flushParent(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writeExclusive(path: string, bytes: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  flushParent(dirname(path))
}
export function applyRuntimeMigration(input: WorkbenchRootsInput, expected: RuntimeMigrationPlan, evidenceDir: string,
  options: { afterBackup?: () => void; afterStage?: () => void } = {}): { backup: string; receiptHash: string } {
  if (!isAbsolute(evidenceDir) || realpathSync(evidenceDir) !== resolve(evidenceDir)) refuseOwnedIdentity('evidence directory must be canonical and outside the owned root')
  const roots = rootsForMigration(input)
  if (evidenceDir === roots.stateDir || evidenceDir.startsWith(roots.stateDir + sep)
      || evidenceDir === roots.runtimeDir || evidenceDir.startsWith(roots.runtimeDir! + sep)) refuseOwnedIdentity('evidence directory overlaps an owned root')
  const evidence = lstatSync(evidenceDir)
  if (!evidence.isDirectory() || evidence.isSymbolicLink() || evidence.uid !== process.getuid?.() || (evidence.mode & 0o777) !== 0o700) refuseOwnedIdentity('evidence directory is not private')
  // Check exact durable lock/store/fence identities before SQLite can even
  // write owner_acquired_at into the lock database.
  const beforeLock = captureValidated(roots)
  if (!same(beforeLock.plan, expected)) refuseOwnedIdentity('stale migration plan; inspect again before authorizing')
  const lock = acquireOwnerLock({ path: roots.ownerDatabasePath })
  try {
    const current = captureValidated(roots)
    if (!same(current.plan, expected)) refuseOwnedIdentity('stale migration plan; inspect again before authorizing')
    const backup = join(evidenceDir, `workbench-ownership-v${expected.receiptVersion}-${expected.receiptHash}.json`)
    const staged = join(roots.stateDir, tmpName)
    if (existsSync(backup) || existsSync(staged)) refuseOwnedIdentity('migration evidence or staged file already exists; preserve it for manual review')
    const original = ownedPathIdentity(join(roots.stateDir, 'ownership.json'))
    writeExclusive(backup, current.bytes)
    options.afterBackup?.()
    if (!same(ownedPathIdentity(join(roots.stateDir, 'ownership.json')), original) || !same(captureValidated(roots).plan, expected)) refuseOwnedIdentity('ownership changed after evidence backup')
    writeExclusive(staged, current.next)
    options.afterStage?.()
    if (!same(ownedPathIdentity(join(roots.stateDir, 'ownership.json')), original) || !same(captureValidated(roots).plan, expected)) refuseOwnedIdentity('ownership changed before migration commit')
    renameSync(staged, join(roots.stateDir, 'ownership.json'))
    flushParent(roots.stateDir)
    verifyOwnedReceipt(roots)()
    return { backup, receiptHash: hash(current.next) }
  } finally { lock.release() }
}
