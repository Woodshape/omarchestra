/** Exact local resource identities. A matching filename is not ownership.
 * This receipt is local to one state root, not a portable backup/restore recipe.
 * Incomplete bootstrap is refused; no automatic reconstruction of lost evidence.
 */
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workbenchError } from './errors.ts'
import { ensureOwnedFileTarget, type WorkbenchRoots } from './paths.ts'

interface Identity { dev: string; ino: string; uid: string; kind: 'file' | 'directory' }
interface Receipt { version: 1; resources: Record<string, Identity> }
const RECEIPT = 'ownership.json'
function refused(detail: string): never {
  throw workbenchError('identity_drift', detail, 'preserve this root and its ownership evidence; do not recreate missing files or copy another root over it')
}
function identity(path: string): Identity {
  let s
  try { s = lstatSync(path, { bigint: true }) } catch { return refused(`owned resource missing: ${path}`) }
  if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) refused(`unsupported owned resource: ${path}`)
  if (s.isFile() && s.nlink !== 1n) refused(`owned file has multiple links: ${path}`)
  return { dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), kind: s.isFile() ? 'file' : 'directory' }
}
function paths(roots: WorkbenchRoots): string[] {
  const result = [roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath]
  for (const start of [roots.stateDir, roots.runtimeDir].filter((p): p is string => p !== null)) {
    let p = start
    for (;;) { if (!result.includes(p)) result.push(p); const parent = dirname(p); if (parent === p) break; p = parent }
  }
  return result.sort()
}
function capture(roots: WorkbenchRoots): Receipt {
  return { version: 1, resources: Object.fromEntries(paths(roots).map(p => [p, identity(p)])) }
}
function encoded(value: unknown): string { return JSON.stringify(value) }
function verify(roots: WorkbenchRoots, receipt: Receipt): void {
  if (encoded(capture(roots)) !== encoded(receipt)) refused('owned file or parent identity changed')
  for (const p of [roots.manifestPath, roots.ownerDatabasePath, roots.databasePath, roots.fenceDatabasePath]) ensureOwnedFileTarget(p)
  for (const p of [roots.stateDir, roots.runtimeDir].filter((p): p is string => p !== null)) {
    const s = lstatSync(p)
    if ((s.mode & 0o777) !== 0o700 || (process.getuid && s.uid !== process.getuid())) refused(`owned directory permissions changed: ${p}`)
  }
}
export function verifyOwnedReceipt(roots: WorkbenchRoots): () => void {
  const path = join(roots.stateDir, RECEIPT)
  ensureOwnedFileTarget(path)
  let bytes: string, receipt: Receipt
  try {
    const stats = lstatSync(path)
    if (stats.size > 65536) refused('ownership receipt exceeds bound')
    bytes = readFileSync(path, 'utf8')
    receipt = JSON.parse(bytes)
  } catch { return refused('missing or invalid exact-resource receipt; incomplete or older root requires explicit recovery') }
  verify(roots, receipt)
  const receiptIdentity = identity(path)
  const manifestBytes = readFileSync(roots.manifestPath, 'utf8')
  return () => {
    ensureOwnedFileTarget(path)
    if (encoded(identity(path)) !== encoded(receiptIdentity) || readFileSync(path, 'utf8') !== bytes) refused('ownership receipt changed')
    verify(roots, receipt)
    if (readFileSync(roots.manifestPath, 'utf8') !== manifestBytes) refused('ownership manifest changed')
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
/** Recheck before every durable read/write, not only at startup. close must
 * still release descriptors after a drift failure and never unlinks anything.
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
