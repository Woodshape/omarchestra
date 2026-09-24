/**
 * Local Workbench v1 Phase 2 — declared store schema (version 9; separate pending proposals).
 *
 * The declared shape is the contract the runner validates before accepting
 * management frames. Any missing table or unexpected table is drift that
 * blocks startup; the runner never repairs schema silently.
 */

export const STORE_SCHEMA_VERSION = 9

export interface TableSpec {
  name: string
  columns: string[]
}

export const STORE_TABLES: TableSpec[] = [
  { name: 'meta', columns: ['key', 'value'] },
  {
    name: 'projects',
    columns: ['project_id', 'execution_node_id', 'canonical_path', 'git_common_dir', 'head_oid', 'dirty', 'context_digest', 'revision', 'created_at'],
  },
  { name: 'goals', columns: ['goal_id', 'project_id', 'goal_text', 'state', 'outcome', 'created_at'] },
  {
    name: 'check_definitions',
    columns: ['project_id', 'check_id', 'version', 'digest', 'canonical_json', 'name', 'mode', 'created_at'],
  },
  {
    name: 'bindings',
    columns: ['run_id', 'project_id', 'role', 'state', 'binding_digest', 'control_epoch', 'writer_state', 'predecessor_run_id', 'generation', 'updated_at'],
  },
  { name: 'binding_identities', columns: ['run_id', 'goal_id', 'incarnation_json', 'incarnation_key'] },
  { name: 'adoption_proposals', columns: ['proposal_id', 'run_id', 'project_id', 'goal_id', 'role', 'observed_session_id', 'incarnation_json', 'connection_id', 'challenge', 'nonce', 'digest', 'generation', 'predecessor_run_id', 'expires_at', 'ack_deadline', 'state', 'delivery_json', 'delivery_state'] },
  { name: 'bridge_deliveries', columns: ['frame_id', 'run_id', 'kind', 'frame_json', 'connection_id', 'deadline', 'state', 'reason_code', 'created_at'] },
  { name: 'role_memberships', columns: ['goal_id', 'role', 'run_id'] },
  { name: 'management_operations', columns: ['intent_id', 'session_id', 'payload_hash', 'kind', 'run_id', 'target_json', 'created_at'] },
  { name: 'uncertain_effects', columns: ['run_id', 'project_id', 'recorded_at'] },
  { name: 'events', columns: ['event_id', 'cursor', 'base_revision', 'revision', 'kind', 'created_at', 'run_id'] },
  {
    name: 'intent_dedup',
    columns: ['intent_id', 'session_id', 'payload_hash', 'status', 'reason_code', 'committed_revision', 'created_at', 'reason', 'detail'],
  },
]

export const STORE_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  execution_node_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  head_oid TEXT,
  dirty INTEGER NOT NULL DEFAULT 0,
  context_digest TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
  goal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  goal_text TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS check_definitions (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  check_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, check_id, version)
);
CREATE TABLE IF NOT EXISTS bindings (
  run_id TEXT PRIMARY KEY,
  project_id TEXT,
  role TEXT,
  state TEXT NOT NULL,
  binding_digest TEXT,
  control_epoch INTEGER NOT NULL DEFAULT 0,
  writer_state TEXT NOT NULL DEFAULT 'none',
  predecessor_run_id TEXT,
  generation INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS binding_identities (
  run_id TEXT PRIMARY KEY REFERENCES bindings(run_id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  incarnation_json TEXT NOT NULL,
  incarnation_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS adoption_proposals (
  proposal_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  role TEXT NOT NULL,
  observed_session_id TEXT NOT NULL UNIQUE,
  incarnation_json TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  nonce TEXT NOT NULL,
  digest TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  predecessor_run_id TEXT,
  expires_at INTEGER NOT NULL,
  ack_deadline INTEGER,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'authorized')),
  delivery_json TEXT,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('none', 'queued', 'attempting', 'written', 'unknown', 'not_sent')),
  UNIQUE (goal_id, role)
);
CREATE TABLE IF NOT EXISTS role_memberships (
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  role TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES binding_identities(run_id) ON DELETE CASCADE,
  PRIMARY KEY (goal_id, role)
);
CREATE TABLE IF NOT EXISTS uncertain_effects (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL UNIQUE,
  base_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  run_id TEXT
);
CREATE TRIGGER event_cursor_order BEFORE INSERT ON events
WHEN NEW.cursor <= COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'event_cursor'), -1)
BEGIN
  SELECT RAISE(ABORT, 'event cursor must advance');
END;
CREATE TRIGGER event_cursor_high_water AFTER INSERT ON events
BEGIN
  INSERT INTO meta (key, value) VALUES ('event_cursor', CAST(NEW.cursor AS TEXT))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
END;
CREATE TABLE IF NOT EXISTS bridge_deliveries (
  frame_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES bindings(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('adopt', 'committed')),
  frame_json TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'attempting', 'written', 'not_sent', 'unknown')),
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, kind)
);
CREATE TABLE IF NOT EXISTS management_operations (
  intent_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('retire', 'purge')),
  run_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intent_dedup (
  intent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  committed_revision INTEGER,
  created_at INTEGER NOT NULL,
  reason TEXT,
  detail TEXT
);
`

export const REQUIRED_PRAGMAS = {
  foreign_keys: 1,
  synchronous: 2,
  busy_timeout: 1000,
} as const

export const REQUIRED_JOURNAL_MODE = 'delete'
