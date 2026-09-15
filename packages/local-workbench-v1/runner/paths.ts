/**
 * Local Workbench v1 Phase 2 — injected roots and owner-only resource paths.
 *
 * All durable locations arrive as explicit injected roots. This module never
 * reads XDG or HOME defaults: the normal foreground entry resolves those, the
 * runner only validates what it is handed. Owner-only means the owned
 * directory is 0700, owned by the current uid, reached without a symlink, and
 * contains only known workbench resources.
 */

import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { workbenchError } from './errors.ts'

export const OWNED_DIRECTORY_MODE = 0o700
export const OWNED_FILE_MODE = 0o600

export interface WorkbenchRootsInput {
  /** Durable state root. Must be absolute, canonical, and not inside a Git Project. */
  stateDir: string
  /** Optional owner-only runtime root for local transport. */
  runtimeDir?: string | null
}

export interface WorkbenchRoots {
  stateDir: string
  runtimeDir: string | null
  manifestPath: string
  databasePath: string
  ownerDatabasePath: string
  fenceDatabasePath: string
  backupDir: string
}

/** Resource names the state root may contain. Unexpected entries fail closed. */
export const OWNED_STATE_ENTRIES = [
  'manifest.json',
  'manifest.json.new',
  'ownership.json',
  'workbench.sqlite',
  'owner.sqlite',
  'fences.sqlite',
  'backups',
] as const

const TRANSIENT_SUFFIXES = ['-journal', '-wal', '-shm']

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    throw workbenchError('unsafe_path', `cannot inspect ${path}: ${String(code)}`, 'verify the injected root and its permissions')
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null
}

function assertAbsolute(path: unknown, where: string): string {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw workbenchError('invalid_input', `${where} must be an absolute path`, 'pass an explicit absolute root')
  }
  const normalized = normalize(path)
  if (normalized === '/' || normalized === '.') {
    throw workbenchError('unsafe_path', `${where} must not be the filesystem root`, 'pass a dedicated workbench directory')
  }
  return normalized
}

/**
 * Reject a symlink substitution at the owned path itself or in any existing
 * ancestor below the provided base. Base is caller-owned and already trusted;
 * this keeps disposable test roots usable while owned subtrees stay canonical.
 */
export function assertNoSymlink(path: string): void {
  const stats = lstatOrNull(path)
  if (stats === null) return
  if (stats.isSymbolicLink()) {
    throw workbenchError('unsafe_path', `${path} is a symlink`, `replace the symlink with a real owned directory or choose a different root`)
  }
}

/**
 * Canonicalize and verify an owned directory: create it 0700 when missing,
 * reject symlinks, non-directories, foreign ownership, and group/other access.
 */
export function ensureOwnedDirectory(path: string): string {
  const target = assertAbsolute(path, 'owned directory')
  const existing = lstatOrNull(target)
  if (existing === null) {
    try {
      mkdirSync(target, { recursive: true, mode: OWNED_DIRECTORY_MODE })
      chmodSync(target, OWNED_DIRECTORY_MODE)
    } catch (error) {
      throw workbenchError('store_unavailable', `cannot create owned directory ${target}`, 'choose an injected root the runner can create, then re-run')
    }
  }
  const stats = lstatOrNull(target)!
  if (stats.isSymbolicLink()) {
    throw workbenchError('unsafe_path', `${target} is a symlink`, 'replace the symlink with a real owned directory or choose a different root')
  }
  if (!stats.isDirectory()) {
    throw workbenchError('unexpected_resource', `${target} is not a directory`, 'move the conflicting file aside; do not delete unknown directories')
  }
  const uid = currentUid()
  if (uid !== null && stats.uid !== uid) {
    throw workbenchError('foreign_owner', `${target} is owned by uid ${stats.uid}, not ${uid}`, 'select a workbench root owned by the current user')
  }
  if ((stats.mode & 0o077) !== 0) {
    throw workbenchError('unsafe_path', `${target} is accessible to group or other (mode ${(stats.mode & 0o777).toString(8)})`, 'correct the directory permissions to 0700; do not delete it')
  }
  const canonical = realpathSync(target)
  if (canonical !== resolve(target)) {
    throw workbenchError('unsafe_path', `${target} resolves to ${canonical}`, 'use the canonical path without a symlinked ancestor')
  }
  return canonical
}

/** Create or verify an owner-only file target without following symlinks. */
export function ensureOwnedFileTarget(path: string): void {
  assertNoSymlink(path)
  const stats = lstatOrNull(path)
  if (stats === null) return
  if (!stats.isFile()) {
    throw workbenchError('unexpected_resource', `${path} is not a regular file`, 'move the conflicting entry aside; do not delete unknown directories')
  }
  const uid = currentUid()
  if (uid !== null && stats.uid !== uid) {
    throw workbenchError('foreign_owner', `${path} is owned by uid ${stats.uid}`, 'select a workbench root owned by the current user')
  }
  if ((stats.mode & 0o077) !== 0) {
    throw workbenchError('unsafe_path', `${path} is accessible to group or other`, 'correct the file permissions to 0600; do not delete it')
  }
}

/**
 * Reject unexpected entries in the owned state root. SQLite journal/WAL
 * companions and the atomic manifest temp name are expected; anything else
 * names a drift the runner will not silently remove. A leftover manifest temp
 * file is still refused by the runner, which never adopts or repairs it.
 */
export function assertOwnedStateEntries(stateDir: string): void {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    throw workbenchError('store_unavailable', `cannot list ${stateDir}`, 'verify the workbench root is readable by the current user')
  }
  for (const name of names) {
    if ((OWNED_STATE_ENTRIES as readonly string[]).includes(name)) continue
    if (['workbench.sqlite', 'owner.sqlite', 'fences.sqlite'].some(database =>
      TRANSIENT_SUFFIXES.some(suffix => name === database + suffix))) {
      ensureOwnedFileTarget(join(stateDir, name))
      continue
    }
    throw workbenchError('unexpected_resource', `${join(stateDir, name)} is not a workbench resource`, 'move the conflicting entry aside; never remove unknown directories automatically')
  }
}

export function resolveRoots(input: WorkbenchRootsInput): WorkbenchRoots {
  if (input === null || typeof input !== 'object') {
    throw workbenchError('invalid_input', 'injected roots are required', 'pass { stateDir } explicitly')
  }
  const stateDir = ensureOwnedDirectory(input.stateDir)
  const runtimeDir = input.runtimeDir === undefined || input.runtimeDir === null
    ? null
    : ensureOwnedDirectory(input.runtimeDir)
  const roots: WorkbenchRoots = {
    stateDir,
    runtimeDir,
    manifestPath: join(stateDir, 'manifest.json'),
    databasePath: join(stateDir, 'workbench.sqlite'),
    ownerDatabasePath: join(stateDir, 'owner.sqlite'),
    fenceDatabasePath: join(stateDir, 'fences.sqlite'),
    backupDir: join(stateDir, 'backups'),
  }
  ensureOwnedFileTarget(roots.manifestPath)
  ensureOwnedFileTarget(roots.databasePath)
  ensureOwnedFileTarget(roots.ownerDatabasePath)
  ensureOwnedFileTarget(roots.fenceDatabasePath)
  assertOwnedStateEntries(stateDir)
  return roots
}

/** Assert the state root is not nested inside a registered Git Project. */
export function assertOutsideProject(stateDir: string, projectPath: string): void {
  const child = resolve(stateDir)
  const parent = resolve(projectPath)
  if (child === parent || child.startsWith(parent + '/') || parent.startsWith(child + '/')) {
    throw workbenchError('unsafe_path', `workbench state ${child} overlaps Project ${parent}`, 'choose a state root outside every registered Project')
  }
}

/** Directory that holds retained backups; created on demand by the backup module. */
export function ensureBackupDirectory(roots: WorkbenchRoots): string {
  return ensureOwnedDirectory(roots.backupDir)
}

export function dirOf(path: string): string {
  return dirname(path)
}
