/**
 * Local Workbench v1 Phase 2 — lifetime owner lock (contract C3).
 *
 * One runner holds an exclusive transaction on a separate owner.sqlite
 * connection for its whole lifetime. SQLite transaction locking alone is not
 * enough for management authority, so this lock is acquired before the store
 * is opened and released last. A second runner fails closed. Locks are never
 * taken over by PID inspection, timestamp comparison, or stale-file deletion:
 * OS release after a crash still requires matching ownership evidence before
 * history is opened.
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync } from 'node:fs'
import { workbenchError } from './errors.ts'

export interface OwnerLock {
  readonly path: string
  readonly acquiredAt: number
  release(): void
}

export interface OwnerLockOptions {
  path: string
  clock?: () => number
}

export function acquireOwnerLock(options: OwnerLockOptions): OwnerLock {
  const clock = options.clock ?? (() => Date.now())
  let db: DatabaseSync
  try {
    db = new DatabaseSync(options.path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw workbenchError('store_unavailable', `cannot open owner lock ${options.path}: ${message}`, 'verify the workbench root is writable by the current user')
  }
  try {
    // SQLite derives journal permissions from the database at journal creation.
    // Set the required mode before BEGIN/DDL, and fail rather than best-effort.
    chmodSync(options.path, 0o600)
    db.exec('PRAGMA busy_timeout = 1000')
    const observed = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>
    const mode = String(observed.journal_mode ?? '').toLowerCase()
    if (mode !== 'delete') {
      throw workbenchError('schema_drift', `owner lock journal_mode is ${mode}`, 'stop other processes using this root and re-run; do not delete the lock file')
    }
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    try { db.close() } catch { /* already failing */ }
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    throw workbenchError(
      'second_owner',
      `another workbench runner owns ${options.path}`,
      'stop the other runner, or open this root with the process that already owns it; ownership is never taken over by deleting lock files',
    )
  }
  const acquiredAt = clock()
  try {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('owner_acquired_at', String(acquiredAt))
  } catch {
    // A fresh lock database has no meta table; create it inside the exclusive
    // transaction so ownership evidence stays with the held lock.
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('owner_acquired_at', String(acquiredAt))
  }
  let released = false
  return {
    path: options.path,
    acquiredAt,
    release() {
      if (released) return
      released = true
      try { db.exec('COMMIT') } catch { /* ignore: lock is released by close */ }
      try { db.close() } catch { /* closing is best-effort on shutdown */ }
    },
  }
}
