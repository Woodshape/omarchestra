/** Exact durable identities and owner-lifetime runtime identities.
 * An XDG_RUNTIME_DIR is recreated at login; its inodes cannot be a durable
 * receipt. The persistent store, lock, fence ledger and state parents can.
 * No receipt authorizes a missing/replaced durable file or a stale socket.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workbenchError } from './errors.ts'
import { ensureOwnedFileTarget, type WorkbenchRoots } from './paths.ts'

export interface OwnedIdentity { dev: string; ino: string; uid: string; kind: 'file' | 'directory' }
interface ReceiptV2 { version: 2; resources: Record<string, OwnedIdentity>; runtimePath: string | null }
const RECEIPT = 'ownership.json'
export function refuseOwnedIdentity(detail: string): never {
  throw workbenchError('identity_drift', detail, 'preserve this root and its ownership evidence; do not recreate missing files or copy another root over it')
}
export function ownedIdentity(path: string): OwnedIdentity {
  let s
  try { s = lstatSync(path, { bigint: true }) } catch { return refuseOwnedIdentity(`owned resource missing: ${path}`) }
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) refuseOwnedIdentity(`unsupported owned resource: ${path}`)
  if (s.isFile() && s.nlink !== 1n) refuseOwnedIdentity(`owned file has multiple links: ${path}`)
  return { dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), kind: s.isFile() ? 'file' : 'directory' }
}
function ancestorPaths(start: string): string[] {
  const result: string[] = []
  let p = start
  for (;;) { result.push(p); const parent = dirname(p); if (parent === p) break; p = parent }
  return result
}
/** Stable, disk-backed evidence. The runtime tree is deliberately excluded. */
export function durableOwnedPaths(roots: WorkbenchRoots): string[] {
  return Array.from(new Set([
    roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath,
    ...ancestorPaths(roots.stateDir),
  ])).sort()
}
/** Not persisted: this identity is re-acquired at every owner start. */
export function runtimeOwnedPaths(roots: WorkbenchRoots): string[] {
  return roots.runtimeDir === null ? [] : ancestorPaths(roots.runtimeDir).sort()
}
export function captureOwnedPaths(paths: readonly string[]): Record<string, OwnedIdentity> {
  return Object.fromEntries(paths.map(path => [path, ownedIdentity(path)]))
}
function capture(roots: WorkbenchRoots): ReceiptV2 {
  return { version: 2, resources: captureOwnedPaths(durableOwnedPaths(roots)), runtimePath: roots.runtimeDir }
}
function encoded(value: unknown): string { return JSON.stringify(value) }
function verify(roots: WorkbenchRoots, receipt: ReceiptV2, runtimeAtOpen: Record<string, OwnedIdentity>): void {
  if (encoded(capture(roots)) !== encoded(receipt)) refuseOwnedIdentity('owned durable file or parent identity changed')
  if (encoded(captureOwnedPaths(runtimeOwnedPaths(roots))) !== encoded(runtimeAtOpen)) refuseOwnedIdentity('owned runtime directory or parent identity changed during owner lifetime')
  for (const p of [roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath]) ensureOwnedFileTarget(p)
  for (const p of [roots.stateDir, roots.runtimeDir].filter((p): p is string => p !== null)) {
    const s = lstatSync(p)
    if ((s.mode & 0o777) !== 0o700 || (process.getuid && s.uid !== process.getuid())) refuseOwnedIdentity(`owned directory permissions changed: ${p}`)
  }
}
export function verifyOwnedReceipt(roots: WorkbenchRoots): () => void {
  const path = join(roots.stateDir, RECEIPT)
  ensureOwnedFileTarget(path)
  let bytes: string, receipt: ReceiptV2
  try {
    const stats = lstatSync(path)
    if (stats.size > 65536) refuseOwnedIdentity('ownership receipt exceeds bound')
    bytes = readFileSync(path, 'utf8')
    receipt = JSON.parse(bytes)
  } catch { return refuseOwnedIdentity('missing or invalid exact-resource receipt; incomplete or older root requires explicit recovery') }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.version !== 2) refuseOwnedIdentity('legacy or malformed ownership receipt requires explicit, lock-held runtime migration; never edit or recreate it by name')
  const runtimeAtOpen = captureOwnedPaths(runtimeOwnedPaths(roots))
  verify(roots, receipt, runtimeAtOpen)
  const receiptIdentity = ownedIdentity(path)
  const manifestBytes = readFileSync(roots.manifestPath, 'utf8')
  return () => {
    ensureOwnedFileTarget(path)
    if (encoded(ownedIdentity(path)) !== encoded(receiptIdentity) || readFileSync(path, 'utf8') !== bytes) refuseOwnedIdentity('ownership receipt changed')
    verify(roots, receipt, runtimeAtOpen)
    if (readFileSync(roots.manifestPath, 'utf8') !== manifestBytes) refuseOwnedIdentity('ownership manifest changed')
  }
}
export function createOwnedReceipt(roots: WorkbenchRoots): () => void {
  const receipt = capture(roots)
  const path = join(roots.stateDir, RECEIPT)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, encoded(receipt) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
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
