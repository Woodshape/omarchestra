/** Exact durable filesystem identities and owner-lifetime path identities.
 *
 * Linux may assign a different st_dev to the same persistent Btrfs filesystem
 * after login/reboot. Durable receipts therefore pin stable mount source/root/
 * type, Btrfs subvolume ID, and inode; the current Owner lifetime additionally
 * pins the current mount ID and inode. It never pins st_dev. The
 * runtime tree is deliberately excluded from durable receipts because XDG
 *_RUNTIME_DIR is recreated at login.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { workbenchError } from './errors.ts'
import { ensureOwnedFileTarget, type WorkbenchRoots } from './paths.ts'

export interface OwnedPathIdentity { ino: string; uid: string; kind: 'file' | 'directory' }
/** Legacy v1/v2 receipt shape; dev is read only to validate an old receipt during explicit migration. */
export interface OwnedIdentity extends OwnedPathIdentity { dev: string }
export interface DurableOwnedIdentity extends OwnedPathIdentity { fsType: string; source: string; mountRoot: string; mountPoint: string; btrfsSubvolumeId: string | null }
interface LiveOwnedIdentity extends OwnedPathIdentity { mountId: string }
interface MountRecord { mountId: string; root: string; mountPoint: string; fsType: string; source: string; btrfsSubvolumeId: string | null }
interface ReceiptV3 { version: 3; resources: Record<string, DurableOwnedIdentity>; runtimePath: string | null }
export function refuseOwnedIdentity(detail: string): never {
  throw workbenchError('identity_drift', detail, 'preserve this root and its ownership evidence; do not recreate missing files or copy another root over it')
}
function inspectOwnedPath(path: string) {
  let s
  try { s = lstatSync(path, { bigint: true }) } catch { return refuseOwnedIdentity(`owned resource missing: ${path}`) }
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) refuseOwnedIdentity(`unsupported owned resource: ${path}`)
  if (s.isFile() && s.nlink !== 1n) refuseOwnedIdentity(`owned file has multiple links: ${path}`)
  return s
}
export function ownedPathIdentity(path: string): OwnedPathIdentity {
  const s = inspectOwnedPath(path)
  return { ino: String(s.ino), uid: String(s.uid), kind: s.isFile() ? 'file' : 'directory' }
}
export function ownedIdentity(path: string): OwnedIdentity {
  const s = inspectOwnedPath(path)
  return { dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), kind: s.isFile() ? 'file' : 'directory' }
}
function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}
function readMountRecords(): MountRecord[] {
  let text: string
  try { text = readFileSync('/proc/self/mountinfo', 'utf8') }
  catch { return refuseOwnedIdentity('cannot read current Linux mount identity') }
  const records: MountRecord[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const separator = line.indexOf(' - ')
    if (separator < 0) continue
    const before = line.slice(0, separator).split(' ')
    const after = line.slice(separator + 3).split(' ')
    if (before.length < 6 || after.length < 2 || !/^\d+$/.test(before[0])) continue
    const fsType = decodeMountField(after[0])
    const superOptions = after[2] ?? ''
    const subvolume = fsType === 'btrfs' ? /(?:^|,)subvolid=(\d+)(?:,|$)/.exec(superOptions) : null
    records.push({ mountId: before[0], root: decodeMountField(before[3]), mountPoint: decodeMountField(before[4]),
      fsType, source: decodeMountField(after[1]), btrfsSubvolumeId: subvolume?.[1] ?? null })
  }
  if (records.length === 0) refuseOwnedIdentity('Linux mount table is empty or malformed')
  return records
}
function mountFor(path: string, records: readonly MountRecord[]): MountRecord {
  const target = resolve(path)
  const matches = records.filter(record => target === record.mountPoint
    || target.startsWith(record.mountPoint === '/' ? '/' : `${record.mountPoint}/`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)
  if (!matches[0]) return refuseOwnedIdentity(`cannot identify the mounted filesystem for ${path}`)
  return matches[0]
}
function captureLivePaths(paths: readonly string[]): Record<string, LiveOwnedIdentity> {
  const mounts = readMountRecords()
  return Object.fromEntries(paths.map(path => {
    const identity = ownedPathIdentity(path)
    const mount = mountFor(path, mounts)
    return [path, { ...identity, mountId: mount.mountId }]
  }))
}
export function captureOwnedPaths(paths: readonly string[]): Record<string, OwnedIdentity> {
  return Object.fromEntries(paths.map(path => [path, ownedIdentity(path)]))
}
export function captureDurableOwnedPaths(paths: readonly string[]): Record<string, DurableOwnedIdentity> {
  const mounts = readMountRecords()
  return Object.fromEntries(paths.map(path => {
    const identity = ownedPathIdentity(path)
    const mount = mountFor(path, mounts)
    if (mount.fsType === 'btrfs' && !mount.btrfsSubvolumeId) refuseOwnedIdentity(`Btrfs subvolume identity is unavailable for ${path}`)
    return [path, { fsType: mount.fsType, source: mount.source, mountRoot: mount.root, mountPoint: mount.mountPoint,
      btrfsSubvolumeId: mount.btrfsSubvolumeId, ino: identity.ino, uid: identity.uid, kind: identity.kind }]
  }))
}
function ancestorPaths(start: string): string[] {
  const result: string[] = []
  let p = start
  for (;;) { result.push(p); const parent = dirname(p); if (parent === p) break; p = parent }
  return result
}
/** Stable, disk-backed evidence. Runtime directories are deliberately excluded. */
export function durableOwnedPaths(roots: WorkbenchRoots): string[] {
  return Array.from(new Set([
    roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath,
    ...ancestorPaths(roots.stateDir),
  ])).sort()
}
/** Acquired at owner start, never persisted: mount ID plus inode/owner/type, never st_dev. */
export function runtimeOwnedPaths(roots: WorkbenchRoots): string[] {
  return roots.runtimeDir === null ? [] : ancestorPaths(roots.runtimeDir).sort()
}
function encoded(value: unknown): string { return JSON.stringify(value) }
function checkModes(roots: WorkbenchRoots): void {
  for (const p of [roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath]) ensureOwnedFileTarget(p)
  for (const p of [roots.stateDir, roots.runtimeDir].filter((p): p is string => p !== null)) {
    const s = lstatSync(p)
    if ((s.mode & 0o777) !== 0o700 || (process.getuid && s.uid !== process.getuid())) refuseOwnedIdentity(`owned directory permissions changed: ${p}`)
  }
}
function verifyLifetime(roots: WorkbenchRoots, liveAtOpen: Record<string, LiveOwnedIdentity>): void {
  const paths = Array.from(new Set([...durableOwnedPaths(roots), ...runtimeOwnedPaths(roots)])).sort()
  if (encoded(captureLivePaths(paths)) !== encoded(liveAtOpen)) refuseOwnedIdentity('owned resource or mount identity changed during owner lifetime')
  checkModes(roots)
}
export function verifyOwnedReceipt(roots: WorkbenchRoots): () => void {
  const path = join(roots.stateDir, 'ownership.json')
  ensureOwnedFileTarget(path)
  let bytes: string, receipt: ReceiptV3
  try {
    const stats = lstatSync(path)
    if (stats.size > 65536) refuseOwnedIdentity('ownership receipt exceeds bound')
    bytes = readFileSync(path, 'utf8')
    receipt = JSON.parse(bytes)
  } catch { return refuseOwnedIdentity('missing or invalid exact-resource receipt; incomplete or older root requires explicit recovery') }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 3
      || Object.keys(receipt).sort().join(',') !== 'resources,runtimePath,version'
      || (receipt.runtimePath !== null && typeof receipt.runtimePath !== 'string')
      || !receipt.resources || typeof receipt.resources !== 'object' || Array.isArray(receipt.resources)) {
    return refuseOwnedIdentity('legacy or malformed ownership receipt requires explicit, lock-held migration; never edit or recreate it by name')
  }
  const expectedPaths = durableOwnedPaths(roots)
  if (encoded(Object.keys(receipt.resources).sort()) !== encoded(expectedPaths)) refuseOwnedIdentity('ownership receipt resource names do not match these explicit roots')
  if (receipt.runtimePath !== roots.runtimeDir) refuseOwnedIdentity('ownership receipt runtime path differs from the explicit root')
  for (const identity of Object.values(receipt.resources)) {
    if (!identity || Object.keys(identity).sort().join(',') !== 'btrfsSubvolumeId,fsType,ino,kind,mountPoint,mountRoot,source,uid'
        || !['file', 'directory'].includes(identity.kind)
        || ![identity.fsType, identity.source, identity.mountRoot, identity.mountPoint, identity.ino, identity.uid].every(value => typeof value === 'string' && value.length > 0)
        || (identity.btrfsSubvolumeId !== null && (typeof identity.btrfsSubvolumeId !== 'string' || !/^\d+$/.test(identity.btrfsSubvolumeId)))) {
      refuseOwnedIdentity('ownership receipt contains a malformed durable identity')
    }
  }
  if (encoded(captureDurableOwnedPaths(expectedPaths)) !== encoded(receipt.resources)) refuseOwnedIdentity('owned durable filesystem or inode identity changed')
  const allPaths = Array.from(new Set([...expectedPaths, ...runtimeOwnedPaths(roots)])).sort()
  const liveAtOpen = captureLivePaths(allPaths)
  verifyLifetime(roots, liveAtOpen)
  const receiptIdentity = ownedPathIdentity(path)
  const manifestBytes = readFileSync(roots.manifestPath, 'utf8')
  return () => {
    ensureOwnedFileTarget(path)
    if (encoded(ownedPathIdentity(path)) !== encoded(receiptIdentity) || readFileSync(path, 'utf8') !== bytes) refuseOwnedIdentity('ownership receipt changed')
    verifyLifetime(roots, liveAtOpen)
    if (readFileSync(roots.manifestPath, 'utf8') !== manifestBytes) refuseOwnedIdentity('ownership manifest changed')
  }
}
export function createOwnedReceipt(roots: WorkbenchRoots): () => void {
  const receipt: ReceiptV3 = { version: 3, resources: captureDurableOwnedPaths(durableOwnedPaths(roots)), runtimePath: roots.runtimeDir }
  const path = join(roots.stateDir, 'ownership.json')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(receipt) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  const directory = openSync(roots.stateDir, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return verifyOwnedReceipt(roots)
}
/** Recheck before every durable read/write, not only at startup. Close still
 * releases descriptors after a drift failure and never unlinks anything.
 */
export function guardOwned<T extends object>(value: T, check: () => void): T {
  return new Proxy(value, {
    get(target, key) {
      const member = Reflect.get(target, key)
      if (typeof member !== 'function' || key === 'close') return member
      return (...args: unknown[]) => { check(); return member.apply(target, args) }
    },
  })
}
