/** Receipt-backed backup retention. Never infer deletion authority from a name. */
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ensureOwnedFileTarget } from './paths.ts'
import { workbenchError } from './errors.ts'
export interface BackupFile { name: string; dev: string; ino: string; digest: string }
export interface Inventory { version: 1; directory: string; files: BackupFile[] }
function fail(): never { throw workbenchError('backup_precondition', 'backup inventory or owned resources changed', 'preserve all backup files; never adopt or delete files by filename alone') }
function directoryIdentity(dir: string): string {
  const s = lstatSync(dir, { bigint: true })
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o777n) !== 0o700n) fail()
  return `${s.dev}:${s.ino}:${s.uid}`
}
export function backupFile(dir: string, name: string): BackupFile {
  if (!/^backup-[0-9]+\.(sqlite|json)$/.test(name)) fail()
  const path = join(dir, name)
  ensureOwnedFileTarget(path)
  const s = lstatSync(path, { bigint: true })
  if (s.nlink !== 1n) fail()
  return { name, dev: String(s.dev), ino: String(s.ino), digest: createHash('sha256').update(readFileSync(path)).digest('hex') }
}
export function readInventory(dir: string, allowEmpty = false): Inventory {
  const names = readdirSync(dir)
  if (names.length === 0 && allowEmpty) return { version: 1, directory: directoryIdentity(dir), files: [] }
  const path = join(dir, 'inventory.json')
  ensureOwnedFileTarget(path)
  let value: Inventory
  try {
    if (lstatSync(path).size > 65536) fail()
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch { return fail() }
  if (value.version !== 1 || value.directory !== directoryIdentity(dir) || !Array.isArray(value.files) || value.files.length > 16) fail()
  if (Object.keys(value).sort().join(',') !== 'directory,files,version') fail()
  const expected = ['inventory.json', ...value.files.map(f => f.name)].sort()
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) fail()
  for (const file of value.files) {
    const actual = backupFile(dir, file.name)
    if (actual.dev !== file.dev || actual.ino !== file.ino || Object.keys(file).sort().join(',') !== 'dev,digest,ino,name') fail()
    if (actual.digest !== file.digest) throw workbenchError('integrity_failure', `owned backup bytes changed: ${file.name}`, 'preserve the damaged copy and inspect the other retained backup')
  }
  return value
}
export function writeInventory(dir: string, inventory: Inventory): void {
  if (directoryIdentity(dir) !== inventory.directory) fail()
  const temp = join(dir, 'inventory.json.new')
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, JSON.stringify(inventory) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, join(dir, 'inventory.json'))
  const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}
export function deleteRecordedBackup(dir: string, inventory: Inventory, names: string[]): void {
  // Full revalidation occurs immediately before synchronous exact deletion.
  const current = readInventory(dir)
  if (JSON.stringify(current) !== JSON.stringify(inventory)) fail()
  for (const name of names) {
    const recorded = inventory.files.find(f => f.name === name)
    if (!recorded || JSON.stringify(backupFile(dir, name)) !== JSON.stringify(recorded)) fail()
  }
  for (const name of names) unlinkSync(join(dir, name))
  inventory.files = inventory.files.filter(f => !names.includes(f.name))
  writeInventory(dir, inventory)
}
