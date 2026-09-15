/**
 * Local Workbench v1 Phase 2 — backup, migration and recovery preconditions
 * (contract C3).
 *
 * What is genuinely supported is recorded here, and nothing else. Backups are
 * taken only while this runner holds exclusive ownership, from an integrity-
 * clean store, into the owner-only backup directory, with a SHA-256 digest and
 * schema metadata. Two clean backups are retained; older ones this module
 * created are rotated. Migration is declared forward-only and becomes a real
 * step registry only when a future schema exists. Restore is not implemented,
 * so it fails closed with an explicit operator action instead of reporting a
 * success this phase cannot prove.
 */

import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { assertSchemaShape } from './store.ts'
import { backupFile, readInventory, writeInventory, deleteRecordedBackup } from './backup-inventory.ts'
import { join } from 'node:path'
import { workbenchError } from './errors.ts'
import { ensureBackupDirectory, type WorkbenchRoots } from './paths.ts'
import { STORE_SCHEMA_VERSION } from './schema.ts'
import type { WorkbenchStore } from './store.ts'

export const MAX_RETAINED_BACKUPS = 2
export const BACKUP_NAME_PATTERN = /^backup-\d+\.(?:sqlite|json)$/

export interface BackupMetadata {
  kind: 'omarchestra.workbench/backup'
  schemaVersion: number
  runnerEpoch: number
  integrity: string
  digest: string
  createdAt: number
  database: string
}

export interface BackupSupport {
  backupsSupported: boolean
  migrationsSupported: boolean
  restoreSupported: boolean
  reasons: string[]
}

export function describeBackupSupport(): BackupSupport {
  return {
    backupsSupported: true,
    migrationsSupported: false,
    restoreSupported: false,
    reasons: [
      'backups require exclusive ownership and an integrity-clean store',
      'no forward schema step exists beyond version ' + STORE_SCHEMA_VERSION + ', so migration is a verified no-op',
      'restore is unavailable in Phase 2: preserve the damaged database, then use an explicit operator recovery outside automation',
    ],
  }
}

export function hashFile(path: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}


export interface CreateBackupOptions {
  store: WorkbenchStore
  roots: WorkbenchRoots
  /** The caller asserts it holds the lifetime owner lock. */
  ownershipHeld: boolean
  clock?: () => number
}

/**
 * Create one verified backup and rotate older backups this module created.
 * `ownershipHeld` is not advisory: backups without exclusive ownership are
 * refused rather than producing a torn copy.
 */
export function createBackup(options: CreateBackupOptions): BackupMetadata {
  if (options.ownershipHeld !== true) {
    throw workbenchError('backup_precondition', 'a backup requires the lifetime owner lock', 'start the runner that owns this root, then request the backup from it')
  }
  const integrity = options.store.integrityCheck()
  if (integrity.toLowerCase() !== 'ok') {
    throw workbenchError('integrity_failure', `store integrity_check reported ${integrity}`, 'restore the latest verified backup; do not back up a damaged database as clean')
  }
  const dir = ensureBackupDirectory(options.roots)
  const createdAt = (options.clock ?? (() => Date.now()))()
  const database = join(dir, `backup-${createdAt}.sqlite`)
  const metadataPath = join(dir, `backup-${createdAt}.json`)
  // A filename collision does not confer ownership of the existing backup.
  // lstat also catches dangling symlinks, unlike existsSync.
  for (const target of [database, metadataPath]) {
    try {
      lstatSync(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw workbenchError('backup_unavailable', `backup target already exists: ${target}`, 'preserve the existing backup and retry with a fresh backup timestamp')
  }
  const inventory = readInventory(dir, true)
  try {
    options.store.backupTo(database)
    chmodSync(database, 0o600)
    const copy = new DatabaseSync(database, { readOnly: true })
    try { assertSchemaShape(copy, database) } finally { copy.close() }
  } catch (error) {
    // VACUUM failure may concern a substituted or pre-existing target. Preserve
    // evidence rather than unlinking a file whose creation was not confirmed.
    const message = error instanceof Error ? error.message : String(error)
    throw workbenchError('backup_unavailable', `backup failed: ${message}`, 'confirm the backup directory is owner-only and writable, then retry while the runner owns the root')
  }
  const metadata: BackupMetadata = {
    kind: 'omarchestra.workbench/backup',
    schemaVersion: STORE_SCHEMA_VERSION,
    runnerEpoch: options.store.epoch,
    integrity,
    digest: hashFile(database),
    createdAt,
    database: `backup-${createdAt}.sqlite`,
  }
  try {
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw workbenchError('backup_unavailable', `backup metadata could not be written: ${message}`, 'verify the backup directory is writable by the current user')
  }
  inventory.files.push(backupFile(dir, metadata.database), backupFile(dir, `backup-${createdAt}.json`))
  writeInventory(dir, inventory)
  rotateBackups(dir)
  return metadata
}

/** Delete only exact files recorded by this owner, after verifying all copies. */
function rotateBackups(dir: string): void {
  const inventory = readInventory(dir)
  const names = inventory.files.map(f => f.name).filter(name => name.endsWith('.sqlite'))
    .sort((a, b) => Number(a.slice(7, -7)) - Number(b.slice(7, -7)))
  if (names.length <= MAX_RETAINED_BACKUPS) return
  const excess = names.slice(0, names.length - MAX_RETAINED_BACKUPS)
  deleteRecordedBackup(dir, inventory, excess.flatMap(name => [name, name.replace(/\.sqlite$/, '.json')]))
}

/** Read and verify a retained backup's recorded digest and store integrity. */
export function verifyBackup(roots: WorkbenchRoots, databaseName: string): BackupMetadata {
  if (!/^backup-[0-9]+\.sqlite$/.test(databaseName)) {
    throw workbenchError('backup_unavailable', 'invalid backup basename', 'choose an exact recorded backup, not a path')
  }
  const inventory = readInventory(roots.backupDir)
  if (!inventory.files.some(file => file.name === databaseName)) {
    throw workbenchError('backup_unavailable', 'backup is not in the owned inventory', 'preserve unrecognized backups')
  }
  const database = join(roots.backupDir, databaseName)
  let text: string
  try {
    text = readFileSync(join(roots.backupDir, databaseName.replace(/\.sqlite$/, '.json')), 'utf8')
  } catch {
    throw workbenchError('backup_unavailable', `no metadata beside ${databaseName}`, 'keep the backup and its metadata together; a digest without metadata is not a verified backup')
  }
  let parsed: BackupMetadata
  try {
    parsed = JSON.parse(text) as BackupMetadata
  } catch {
    throw workbenchError('backup_unavailable', `backup metadata for ${databaseName} is not valid JSON`, 'restore the retained backup metadata file from an independent copy')
  }
  if (parsed.kind !== 'omarchestra.workbench/backup' || parsed.database !== databaseName || parsed.integrity !== 'ok'
      || !Number.isSafeInteger(parsed.runnerEpoch) || parsed.runnerEpoch < 1
      || !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0
      || typeof parsed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.digest)
      || Object.keys(parsed).sort().join(',') !== 'createdAt,database,digest,integrity,kind,runnerEpoch,schemaVersion') {
    throw workbenchError('backup_unavailable', 'invalid backup metadata', 'preserve the backup and its original metadata')
  }
  if (hashFile(database) !== parsed.digest) {
    throw workbenchError('integrity_failure', `backup ${databaseName} does not match its recorded digest`, 'discard this copy and use the other retained backup; do not edit the file')
  }
  if (parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw workbenchError('unsupported_schema', `backup ${databaseName} has schema ${parsed.schemaVersion}`, 'use a backup created by this workbench version')
  }
  const copy = new DatabaseSync(database, { readOnly: true })
  try { assertSchemaShape(copy, database) } finally { copy.close() }
  return parsed
}

export interface MigrationPlan {
  from: number
  to: number
  steps: string[]
  requiredBackup: boolean
}

/**
 * Migration policy: only the current schema is a verified no-op. The
 * development schema-1 roots are unsupported; no automatic migration exists.
 * No downgrade and no automatic restore is ever planned.
 */
export function planMigration(currentVersion: number): MigrationPlan {
  if (currentVersion === STORE_SCHEMA_VERSION) {
    return { from: currentVersion, to: STORE_SCHEMA_VERSION, steps: [], requiredBackup: false }
  }
  throw workbenchError(
    'migration_unavailable',
    `no supported forward migration from schema ${currentVersion} to ${STORE_SCHEMA_VERSION}`,
    'open this root with the workbench version that created it; do not downgrade or restore automatically',
  )
}

export interface MigrationPreconditions {
  ownershipHeld: boolean
  backupDatabase: string | null
}

/**
 * Assert the C3 preconditions for any future migration step: exclusive
 * ownership plus a verified retained backup. With no step to run this returns
 * the verified plan and never mutates the store.
 */
export function assertMigrationPreconditions(roots: WorkbenchRoots, currentVersion: number, preconditions: MigrationPreconditions): MigrationPlan {
  const plan = planMigration(currentVersion)
  if (plan.steps.length === 0) return plan
  if (preconditions.ownershipHeld !== true) {
    throw workbenchError('backup_precondition', 'migration requires the lifetime owner lock', 'run migrations from the owning foreground runner only')
  }
  if (preconditions.backupDatabase === null) {
    throw workbenchError('backup_precondition', 'migration requires a verified retained backup', 'create a backup while the runner owns the root, then retry the migration')
  }
  verifyBackup(roots, preconditions.backupDatabase)
  return plan
}

/** Restore is deliberately unavailable; never report unproven success. */
export function restoreBackup(): never {
  throw workbenchError(
    'restore_unavailable',
    'automatic restore is not implemented in Phase 2',
    'stop the runner, preserve the damaged database and its fences, then follow the documented operator recovery action; never delete the fence ledger',
  )
}
