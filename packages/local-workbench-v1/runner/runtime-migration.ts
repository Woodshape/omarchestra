/** Explicit v1 → v2 ownership receipt migration for a reboot-recreated /run.
 * This is never called by owner startup or a bar click. It preserves the exact
 * legacy bytes outside the state root before an atomic forward-only replace.
 */
import { constants, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { acquireOwnerLock } from './owner-lock.ts'
import { captureOwnedPaths, durableOwnedPaths, ownedIdentity, refuseOwnedIdentity, runtimeOwnedPaths, verifyOwnedReceipt, type OwnedIdentity } from './owned-resources.ts'
import { readManifest } from './manifest.ts'
import { resolveRoots, ensureOwnedFileTarget, type WorkbenchRoots, type WorkbenchRootsInput } from './paths.ts'

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const tmpName = 'ownership.json.v2-new'
export interface RuntimeMigrationPlan {
  schemaVersion: 1
  stateDir: string
  runtimeDir: string
  receiptHash: string
  nextHash: string
  driftedEphemeralPaths: string[]
  digest: string
}

function rootsForMigration(input: WorkbenchRootsInput): WorkbenchRoots {
  if (!input.runtimeDir || !isAbsolute(input.runtimeDir)) refuseOwnedIdentity('migration requires the explicit existing runtime root')
  // inspect is read-only: resolveRoots would create a missing runtime directory.
  try { if (!lstatSync(input.runtimeDir).isDirectory()) refuseOwnedIdentity('runtime root is not a directory') }
  catch { refuseOwnedIdentity('runtime root is missing; migration never creates or adopts it') }
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
function legacyBytes(roots: WorkbenchRoots): { bytes: string; receipt: { version: 1; resources: Record<string, OwnedIdentity> } } {
  const path = join(roots.stateDir, 'ownership.json')
  ensureOwnedFileTarget(path)
  const s = lstatSync(path)
  if (s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 65536) refuseOwnedIdentity('legacy receipt ownership, mode, links or size is unsafe')
  const bytes = readFileSync(path, 'utf8')
  let parsed: any
  try { parsed = JSON.parse(bytes) } catch { refuseOwnedIdentity('legacy receipt is not valid JSON') }
  if (!parsed || Object.keys(parsed).sort().join(',') !== 'resources,version' || parsed.version !== 1 || !parsed.resources || typeof parsed.resources !== 'object' || Array.isArray(parsed.resources)) refuseOwnedIdentity('not an exact v1 ownership receipt')
  const keys = [...new Set([...durableOwnedPaths(roots), ...runtimeOwnedPaths(roots)])].sort()
  if (!same(Object.keys(parsed.resources).sort(), keys)) refuseOwnedIdentity('legacy receipt resource names do not match these explicit roots')
  for (const key of keys) {
    const value = parsed.resources[key]
    if (!value || Object.keys(value).sort().join(',') !== 'dev,ino,kind,uid'
        || !['file', 'directory'].includes(value.kind)
        || ![value.dev, value.ino, value.uid].every(x => typeof x === 'string' && /^\d+$/.test(x))) refuseOwnedIdentity('legacy receipt contains malformed identity')
  }
  return { bytes, receipt: parsed }
}
function captureValidated(roots: WorkbenchRoots) {
  const { bytes, receipt } = legacyBytes(roots)
  const durable = captureOwnedPaths(durableOwnedPaths(roots))
  for (const [path, actual] of Object.entries(durable)) {
    if (!same(receipt.resources[path], actual)) refuseOwnedIdentity(`durable owned resource changed: ${path}`)
  }
  const currentRuntime = captureOwnedPaths(runtimeOwnedPaths(roots))
  const drifted: string[] = []
  for (const [path, actual] of Object.entries(currentRuntime)) {
    const prior = receipt.resources[path]
    if (actual.kind !== 'directory' || prior.kind !== 'directory' || actual.uid !== prior.uid) refuseOwnedIdentity(`runtime parent kind or owner changed: ${path}`)
    if (!same(prior, actual)) drifted.push(path)
  }
  const next = JSON.stringify({ version: 2, resources: durable, runtimePath: roots.runtimeDir }) + '\n'
  const base = { schemaVersion: 1 as const, stateDir: roots.stateDir, runtimeDir: roots.runtimeDir!,
    receiptHash: hash(bytes), nextHash: hash(next), driftedEphemeralPaths: drifted }
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
    const backup = join(evidenceDir, `workbench-ownership-v1-${expected.receiptHash}.json`)
    const staged = join(roots.stateDir, tmpName)
    if (existsSync(backup) || existsSync(staged)) refuseOwnedIdentity('migration evidence or staged file already exists; preserve it for manual review')
    const original = ownedIdentity(join(roots.stateDir, 'ownership.json'))
    writeExclusive(backup, current.bytes)
    options.afterBackup?.()
    if (!same(ownedIdentity(join(roots.stateDir, 'ownership.json')), original) || !same(captureValidated(roots).plan, expected)) refuseOwnedIdentity('ownership changed after evidence backup')
    writeExclusive(staged, current.next)
    options.afterStage?.()
    if (!same(ownedIdentity(join(roots.stateDir, 'ownership.json')), original) || !same(captureValidated(roots).plan, expected)) refuseOwnedIdentity('ownership changed before migration commit')
    renameSync(staged, join(roots.stateDir, 'ownership.json'))
    flushParent(roots.stateDir)
    verifyOwnedReceipt(roots)()
    return { backup, receiptHash: hash(current.next) }
  } finally { lock.release() }
}
