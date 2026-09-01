/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * store.ts — the sole owner of the SQLite persistence seam for the prototype.
 * Responsibilities: filesystem safety for the caller-supplied state directory,
 * schema version 1 with explicit migration, explicit immediate transactions,
 * owner-only permissions, durable reads (goal, bindings, assignment, events,
 * cursor) and transactional write primitives used by domain.ts.
 *
 * No other module may open a database or issue SQL. Journal mode is a runtime
 * choice; both supported modes are configured and reported, never ranked.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { AgentState, AssignmentState, ControlMode, EventRecord, Role, AckStatus } from './protocol.ts'
import { TEXT_LIMITS } from './protocol.ts'

export type JournalMode = 'default' | 'wal'

export interface JournalReport {
  requested: JournalMode
  effective: string
  sqliteVersion: string
}

export interface MountInfo {
  fstype: string | null
  magic: number | string | null
  source: string | null
  local: boolean
  detection: string
}

export interface RoleIdentity {
  role: Role
  agentRunId: string
  terminalSessionRef: string
  shellRunId: string
  piSessionId: string
  extensionInstanceId: string
  hostPid: number
}

export interface BootstrapConfig {
  teamGoalId: string
  goalText: string
  roles: RoleIdentity[]
  assignment: { id: string; role: Role; agentRunId: string; prompt: string }
}

export interface GoalRow {
  id: string
  goal_text: string
  event_cursor: number
  created_at: string
}

export interface BindingRow {
  team_goal_id: string
  role: Role
  agent_run_id: string
  terminal_session_ref: string
  shell_run_id: string
  pi_session_id: string
  extension_instance_id: string
  host_pid: number
  host_mode: 'tui'
  control_mode: ControlMode
  agent_state: AgentState
  last_source_sequence: number
  native_terminal_title: string
  pi_status: string
}

export interface AssignmentRow {
  id: string
  team_goal_id: string
  role: Role
  agent_run_id: string
  prompt: string
  state: AssignmentState
  accepted_extension_instance_id: string | null
  last_ack_status: AckStatus | null
  created_at: string
  updated_at: string
}

/** FUSE/network filesystem families that must never hold the scratch database. */
const NETWORK_FSTYPE_RE = /nfs|cifs|smb|sshfs|9p|afs|ncp|ceph|gluster|lustre|davfs|fuse/
const NETWORK_FS_MAGICS = new Set<number>([
  0x6969, // NFS
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x65735546, // FUSE
  0x01021997, // 9P (distinct from tmpfs 0x01021994)
  0x5346544e, // NTFS over common network bridges
])

function findRepositoryRoot(startDir: string): string | null {
  let current = path.resolve(startDir)
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current
    } catch {
      return null
    }
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function rejectSymlinkComponents(resolvedPath: string): void {
  let current = resolvedPath
  for (;;) {
    try {
      const st = fs.lstatSync(current)
      if (st.isSymbolicLink()) throw new Error(`state directory path component ${current} is a symlink`)
      if (current !== resolvedPath && !st.isDirectory()) {
        throw new Error(`state directory ancestor ${current} is not a directory`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * Establish the caller-supplied state directory: outside the repository, no
 * symlinks, current-user ownership, mode 0700, on an established-local
 * filesystem. Detection is best-effort and its limits are recorded (task 1.b
 * fact F7): known network/FUSE mounts are rejected, but locality is not proven.
 */
export function ensureStateDirectory(rawDir: string): { stateDir: string; mount: MountInfo } {
  if (typeof rawDir !== 'string' || rawDir.trim().length === 0) {
    throw new Error('a caller-supplied state directory is required')
  }
  const resolved = path.resolve(rawDir)
  const repoRoot = findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)))
  if (repoRoot !== null && (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep))) {
    throw new Error(`state directory ${resolved} is inside the repository; scratch state must live outside Git`)
  }

  rejectSymlinkComponents(resolved)
  let supplied: fs.Stats | null = null
  try {
    supplied = fs.lstatSync(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (supplied === null) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const real = fs.realpathSync(resolved)
  if (real !== resolved) {
    throw new Error(`state directory ${resolved} resolves through a symlink to ${real}`)
  }
  const st = fs.lstatSync(real)
  if (!st.isDirectory()) throw new Error(`state directory ${real} is not a directory`)
  if (process.getuid !== undefined && st.uid !== process.getuid()) {
    throw new Error(`state directory ${real} is not owned by the current user`)
  }
  fs.chmodSync(real, 0o700)
  const after = fs.lstatSync(real)
  if ((after.mode & 0o777) !== 0o700) {
    throw new Error(`state directory ${real} could not be restricted to mode 0700`)
  }

  const mount = inspectMount(real)
  if (!mount.local) {
    throw new Error(`state directory ${real} appears to be on a non-local filesystem (${mount.fstype}); refusing`)
  }
  return { stateDir: real, mount }
}

function inspectMount(dir: string): MountInfo {
  const stats = fs.statfsSync(dir)
  const magic = typeof stats.type === 'number' ? stats.type : stats.type
  const mountInfo = readProcMountinfo(dir)
  const fstype = mountInfo?.fstype ?? null
  const magicIsNetwork = typeof magic === 'number' && NETWORK_FS_MAGICS.has(magic)
  const fstypeIsNetwork = fstype !== null && NETWORK_FSTYPE_RE.test(fstype)
  return {
    fstype,
    magic: magic ?? null,
    source: mountInfo?.source ?? null,
    local: !magicIsNetwork && !fstypeIsNetwork,
    detection:
      'best-effort: statfs magic plus /proc/self/mountinfo fstype; known network/FUSE families rejected, locality not proven',
  }
}

function readProcMountinfo(dir: string): { fstype: string; source: string } | null {
  try {
    const raw = fs.readFileSync('/proc/self/mountinfo', 'utf8')
    let best: { mountPointLength: number; fstype: string; source: string } | null = null
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      const separator = line.indexOf(' - ')
      if (separator === -1) continue
      const left = line.slice(0, separator).split(' ')
      if (left.length < 5) continue
      const mountPoint = left[4].replace(/\\040/g, ' ').replace(/\\134/g, '\\')
      if (dir === mountPoint || dir.startsWith(mountPoint + path.sep)) {
        const right = line.slice(separator + 3).split(' ')
        if (right.length < 2) continue
        const candidate = { mountPointLength: mountPoint.length, fstype: right[0], source: right[1] }
        if (best === null || candidate.mountPointLength > best.mountPointLength) best = candidate
      }
    }
    return best === null ? null : { fstype: best.fstype, source: best.source }
  } catch {
    return null
  }
}

export interface InsertEventInput {
  teamGoalId: string
  role: Role | null
  eventType: string
  sourceExtensionInstanceId: string | null
  sourceEventId: string | null
  sourceSequence: number | null
  payload: Record<string, unknown>
}

export interface BindingPatch {
  controlMode?: ControlMode
  agentState?: AgentState
  lastSourceSequence?: number
  nativeTerminalTitle?: string
  piStatus?: string
}

export interface AssignmentPatch {
  state?: AssignmentState
  acceptedExtensionInstanceId?: string | null
  lastAckStatus?: AckStatus
}

export class Store {
  private db: DatabaseSync
  private stateDir: string
  private databasePath: string
  private journalReport: JournalReport
  private mount: MountInfo
  private inTransaction = false

  private constructor(db: DatabaseSync, stateDir: string, mount: MountInfo, journal: JournalMode) {
    this.db = db
    this.stateDir = stateDir
    this.databasePath = path.join(stateDir, 'runner.sqlite')
    this.mount = mount
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    if (journal === 'wal') {
      // WAL is a measured runtime option, never a declared winner.
      this.db.exec('PRAGMA journal_mode = WAL')
    }
    const effectiveRow = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    const versionRow = this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    this.journalReport = {
      requested: journal,
      effective: effectiveRow.journal_mode,
      sqliteVersion: versionRow.version,
    }
    fs.chmodSync(this.databasePath, 0o600)
    this.verifyDatabasePermissions()
    this.migrate()
  }

  static open(stateDir: string, journal: JournalMode, mount: MountInfo): Store {
    const databasePath = path.join(stateDir, 'runner.sqlite')
    let dbStat: fs.Stats | null = null
    try {
      dbStat = fs.lstatSync(databasePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (dbStat !== null) {
      if (dbStat.isSymbolicLink()) throw new Error(`database path ${databasePath} is a symlink`)
      if (!dbStat.isFile()) throw new Error(`database path ${databasePath} is not a regular file`)
    }
    const db = new DatabaseSync(databasePath)
    try {
      return new Store(db, stateDir, mount, journal)
    } catch (error) {
      try {
        db.close()
      } catch {
        // closing a failed open is best-effort
      }
      throw error
    }
  }

  get journal(): JournalReport {
    return this.journalReport
  }

  get mountInfo(): MountInfo {
    return this.mount
  }

  get stateDirectory(): string {
    return this.stateDir
  }

  get databaseFile(): string {
    return this.databasePath
  }

  get schemaVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  }

  /** Owner-only verification for the database and any present sidecars. */
  verifyDatabasePermissions(): { path: string; mode: string }[] {
    const checked: { path: string; mode: string }[] = []
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const candidate = this.databasePath + suffix
      let st: fs.Stats
      try {
        st = fs.lstatSync(candidate)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) throw new Error(`database file ${candidate} is a symlink`)
      if (process.getuid !== undefined && st.uid !== process.getuid()) {
        throw new Error(`database file ${candidate} is not owned by the current user`)
      }
      if ((st.mode & 0o077) !== 0) {
        fs.chmodSync(candidate, st.mode & 0o700)
      }
      const verified = fs.lstatSync(candidate)
      if ((verified.mode & 0o077) !== 0) {
        throw new Error(`database file ${candidate} has group/other permissions`)
      }
      checked.push({ path: candidate, mode: (verified.mode & 0o777).toString(8).padStart(4, '0') })
    }
    return checked
  }

  // -------------------------------------------------------------------------
  // Schema versioning
  // -------------------------------------------------------------------------

  private migrate(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    const version = versionRow.user_version
    if (version > 1) {
      throw new Error(`database schema version ${version} is newer than the supported version 1; failing closed`)
    }
    if (version === 1) {
      const applied = this.db
        .prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = 1')
        .get() as { count: number }
      if (applied.count !== 1) throw new Error('schema version 1 without a migration record')
      this.verifySchemaObjects()
      return
    }
    if (version !== 0) throw new Error(`unexpected database schema version ${version}`)
    const tableRow = this.db
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get() as { count: number }
    if (tableRow.count !== 0) throw new Error('unversioned database already contains tables; refusing to migrate')
    this.withImmediateTransaction(() => {
      this.db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE team_goals (
          id TEXT PRIMARY KEY,
          goal_text TEXT NOT NULL,
          event_cursor INTEGER NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
          created_at TEXT NOT NULL
        );
        CREATE TABLE role_bindings (
          team_goal_id TEXT NOT NULL REFERENCES team_goals(id),
          role TEXT NOT NULL CHECK (role IN ('coordinator','builder','reviewer')),
          agent_run_id TEXT NOT NULL UNIQUE,
          terminal_session_ref TEXT NOT NULL UNIQUE,
          shell_run_id TEXT NOT NULL UNIQUE,
          pi_session_id TEXT NOT NULL UNIQUE,
          extension_instance_id TEXT NOT NULL UNIQUE,
          host_pid INTEGER NOT NULL CHECK (host_pid > 0),
          host_mode TEXT NOT NULL CHECK (host_mode = 'tui'),
          control_mode TEXT NOT NULL CHECK (control_mode IN ('managed','manual_takeover')),
          agent_state TEXT NOT NULL CHECK (agent_state IN ('waiting','working')),
          last_source_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_source_sequence >= 0),
          native_terminal_title TEXT NOT NULL,
          pi_status TEXT NOT NULL,
          PRIMARY KEY (team_goal_id, role)
        );
        CREATE TABLE assignments (
          id TEXT PRIMARY KEY,
          team_goal_id TEXT NOT NULL REFERENCES team_goals(id),
          role TEXT NOT NULL CHECK (role = 'builder'),
          agent_run_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','active','needs_reconciliation')),
          accepted_extension_instance_id TEXT,
          last_ack_status TEXT CHECK (last_ack_status IN ('accepted','busy','duplicate','invalid')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          team_goal_id TEXT NOT NULL REFERENCES team_goals(id),
          role TEXT,
          event_type TEXT NOT NULL,
          source_extension_instance_id TEXT,
          source_event_id TEXT,
          source_sequence INTEGER,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (source_extension_instance_id, source_event_id)
        );
      `)
      this.db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, 'first-vertical-slice-schema-v1', new Date().toISOString())
      this.db.exec('PRAGMA user_version = 1')
    })
    const after = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (after !== 1) throw new Error('migration did not set schema version 1')
    this.verifySchemaObjects()
  }

  private verifySchemaObjects(): void {
    const required = ['schema_migrations', 'team_goals', 'role_bindings', 'assignments', 'events']
    for (const name of required) {
      const row = this.db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { count: number }
      if (row.count !== 1) throw new Error(`required table ${name} is missing`)
    }
  }

  // -------------------------------------------------------------------------
  // Transactions
  // -------------------------------------------------------------------------

  /**
   * One explicit immediate write transaction. Nested transactions fail
   * loudly. On any error the transaction is rolled back and rethrown.
   */
  withImmediateTransaction<T>(fn: () => T): T {
    if (this.inTransaction) throw new Error('nested transactions are not permitted')
    this.inTransaction = true
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // rollback of an already-failed transaction is best-effort
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  private assertInTransaction(where: string): void {
    if (!this.inTransaction) {
      throw new Error(`${where} must run inside an explicit immediate transaction`)
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getGoal(): GoalRow | null {
    const row = this.db.prepare('SELECT * FROM team_goals ORDER BY created_at LIMIT 1').get() as GoalRow | undefined
    return row ?? null
  }

  getBindings(): BindingRow[] {
    return this.db
      .prepare('SELECT * FROM role_bindings ORDER BY CASE role WHEN \'coordinator\' THEN 0 WHEN \'builder\' THEN 1 ELSE 2 END')
      .all() as BindingRow[]
  }

  getBinding(teamGoalId: string, role: Role): BindingRow {
    const row = this.db
      .prepare('SELECT * FROM role_bindings WHERE team_goal_id = ? AND role = ?')
      .get(teamGoalId, role) as BindingRow | undefined
    if (row === undefined) throw new Error(`no role binding for role ${role}`)
    return row
  }

  getAssignments(): AssignmentRow[] {
    return this.db.prepare('SELECT * FROM assignments ORDER BY created_at').all() as AssignmentRow[]
  }

  getAssignmentById(id: string): AssignmentRow | null {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as AssignmentRow | undefined
    return row ?? null
  }

  getActiveAssignmentForRole(teamGoalId: string, role: Role): AssignmentRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM assignments WHERE team_goal_id = ? AND role = ? AND state IN ('pending','active','needs_reconciliation') ORDER BY created_at DESC LIMIT 1",
      )
      .get(teamGoalId, role) as AssignmentRow | undefined
    return row ?? null
  }

  /** Bounded ascending page of durable events strictly after a cursor. */
  getEventsAfter(cursor: number, limit: number = 256): EventRecord[] {
    const boundedLimit = Math.min(Math.max(1, limit), 256)
    const rows = this.db
      .prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?')
      .all(cursor, boundedLimit) as Record<string, unknown>[]
    return rows.map(rowToEventRecord)
  }

  getAllEvents(): EventRecord[] {
    const rows = this.db.prepare('SELECT * FROM events ORDER BY sequence ASC').all() as Record<string, unknown>[]
    return rows.map(rowToEventRecord)
  }

  countBridgeConnectedEvents(teamGoalId: string, role: Role): number {
    const row = this.db
      .prepare("SELECT count(*) AS count FROM events WHERE team_goal_id = ? AND role = ? AND event_type = 'bridge_connected'")
      .get(teamGoalId, role) as { count: number }
    return row.count
  }

  // -------------------------------------------------------------------------
  // Transactional writes (must run inside withImmediateTransaction)
  // -------------------------------------------------------------------------

  /**
   * Insert one durable event and advance the Team Goal cursor to the inserted
   * sequence within the same transaction. Returns the inserted sequence.
   */
  insertEventTx(input: InsertEventInput): number {
    this.assertInTransaction('insertEventTx')
    const payloadJson = JSON.stringify(input.payload)
    if (Buffer.byteLength(payloadJson, 'utf8') > TEXT_LIMITS.eventPayload) {
      throw new Error('event payload exceeds the bounded payload size')
    }
    const info = this.db
      .prepare(
        `INSERT INTO events (event_id, team_goal_id, role, event_type, source_extension_instance_id, source_event_id, source_sequence, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cryptoRandomId(),
        input.teamGoalId,
        input.role,
        input.eventType,
        input.sourceExtensionInstanceId,
        input.sourceEventId,
        input.sourceSequence,
        payloadJson,
        new Date().toISOString(),
      )
    const sequence = Number(info.lastInsertRowid)
    this.db
      .prepare('UPDATE team_goals SET event_cursor = ? WHERE id = ? AND event_cursor < ?')
      .run(sequence, input.teamGoalId, sequence)
    return sequence
  }

  sourceEventExistsTx(sourceExtensionInstanceId: string, sourceEventId: string): boolean {
    this.assertInTransaction('sourceEventExistsTx')
    const row = this.db
      .prepare('SELECT sequence FROM events WHERE source_extension_instance_id = ? AND source_event_id = ?')
      .get(sourceExtensionInstanceId, sourceEventId)
    return row !== undefined
  }

  updateBindingTx(teamGoalId: string, role: Role, patch: BindingPatch): BindingRow {
    this.assertInTransaction('updateBindingTx')
    const current = this.getBinding(teamGoalId, role)
    const controlMode = patch.controlMode ?? current.control_mode
    const agentState = patch.agentState ?? current.agent_state
    const lastSourceSequence = patch.lastSourceSequence ?? current.last_source_sequence
    const nativeTerminalTitle = patch.nativeTerminalTitle ?? current.native_terminal_title
    const piStatus = patch.piStatus ?? current.pi_status
    this.db
      .prepare(
        `UPDATE role_bindings
         SET control_mode = ?, agent_state = ?, last_source_sequence = ?, native_terminal_title = ?, pi_status = ?
         WHERE team_goal_id = ? AND role = ?`,
      )
      .run(controlMode, agentState, lastSourceSequence, nativeTerminalTitle, piStatus, teamGoalId, role)
    return this.getBinding(teamGoalId, role)
  }

  updateAssignmentTx(id: string, patch: AssignmentPatch): AssignmentRow {
    this.assertInTransaction('updateAssignmentTx')
    const current = this.getAssignmentById(id)
    if (current === null) throw new Error(`unknown assignment ${id}`)
    const state = patch.state ?? current.state
    const accepted =
      patch.acceptedExtensionInstanceId !== undefined ? patch.acceptedExtensionInstanceId : current.accepted_extension_instance_id
    const ack = patch.lastAckStatus ?? current.last_ack_status
    this.db
      .prepare(
        'UPDATE assignments SET state = ?, accepted_extension_instance_id = ?, last_ack_status = ?, updated_at = ? WHERE id = ?',
      )
      .run(state, accepted, ack, new Date().toISOString(), id)
    const updated = this.getAssignmentById(id)
    if (updated === null) throw new Error(`assignment ${id} disappeared during update`)
    return updated
  }

  // -------------------------------------------------------------------------
  // Bootstrap (atomic)
  // -------------------------------------------------------------------------

  /** Insert Team Goal, three exact bindings with initial labels, the pending
   *  Builder assignment and the bootstrap event in one transaction. */
  bootstrapTx(config: BootstrapConfig, labels: Map<Role, { nativeTerminalTitle: string; piStatus: string }>): void {
    this.assertInTransaction('bootstrapTx')
    const now = new Date().toISOString()
    this.db
      .prepare('INSERT INTO team_goals (id, goal_text, event_cursor, created_at) VALUES (?, ?, 0, ?)')
      .run(config.teamGoalId, config.goalText, now)
    const insertBinding = this.db.prepare(
      `INSERT INTO role_bindings
       (team_goal_id, role, agent_run_id, terminal_session_ref, shell_run_id, pi_session_id, extension_instance_id, host_pid, host_mode,
        control_mode, agent_state, last_source_sequence, native_terminal_title, pi_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tui', 'managed', 'waiting', 0, ?, ?)`,
    )
    for (const identity of config.roles) {
      const label = labels.get(identity.role)
      if (label === undefined) throw new Error(`missing initial labels for role ${identity.role}`)
      insertBinding.run(
        config.teamGoalId,
        identity.role,
        identity.agentRunId,
        identity.terminalSessionRef,
        identity.shellRunId,
        identity.piSessionId,
        identity.extensionInstanceId,
        identity.hostPid,
        label.nativeTerminalTitle,
        label.piStatus,
      )
    }
    this.db
      .prepare(
        `INSERT INTO assignments (id, team_goal_id, role, agent_run_id, prompt, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(config.assignment.id, config.teamGoalId, config.assignment.role, config.assignment.agentRunId, config.assignment.prompt, now, now)
  }

  close(): void {
    this.db.close()
  }
}

function rowToEventRecord(row: Record<string, unknown>): EventRecord {
  return {
    sequence: Number(row.sequence),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    role: row.role === null ? null : (String(row.role) as Role),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return `evt-${out}`
}