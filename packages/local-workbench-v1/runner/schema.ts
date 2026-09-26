/**
 * Local Workbench v1 Phase 2 — declared store schema (version 10; separate
 * pending proposals plus the one-Assignment lifecycle substrate).
 *
 * The declared shape is the contract the runner validates before accepting
 * management frames. Any missing table or unexpected table is drift that
 * blocks startup; the runner never repairs schema silently. Schema 9 stores are
 * refused by startup; the separate offline plan-bound upgrade is explicit.
 */

export const STORE_SCHEMA_VERSION = 10

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
  {
    name: 'assignments',
    columns: ['assignment_id', 'project_id', 'goal_id', 'agent_run_id', 'binding_digest', 'goal_text', 'task_text', 'write_authority', 'state', 'limits_json', 'attempt_count', 'revision', 'created_at', 'updated_at'],
  },
  {
    name: 'attempts',
    columns: ['attempt_id', 'assignment_id', 'ordinal', 'state', 'run_binding_json', 'run_binding_digest', 'gate_id', 'gate_version', 'gate_digest', 'gate_json', 'context_json', 'limits_json', 'writer_epoch', 'control_epoch', 'delivery_id', 'created_at', 'updated_at'],
  },
  {
    name: 'assignment_writers',
    columns: ['project_id', 'assignment_id', 'attempt_id', 'epoch', 'state', 'updated_at'],
  },
  {
    name: 'assignment_outbox',
    columns: ['delivery_id', 'assignment_id', 'attempt_id', 'run_id', 'frame_json', 'payload_digest', 'state', 'reason_code', 'deadline', 'created_at'],
  },
  {
    name: 'candidates',
    columns: ['candidate_id', 'assignment_id', 'attempt_id', 'agent_run_id', 'control_epoch', 'summary', 'artifact_refs_json', 'digest', 'pre_manifest_digest', 'state', 'created_at'],
  },
  {
    name: 'gate_results',
    columns: ['result_id', 'assignment_id', 'attempt_id', 'candidate_id', 'gate_digest', 'executable_digest', 'outcome', 'pre_manifest_digest', 'post_manifest_digest', 'exit_code', 'reason_code', 'evidence_json', 'state', 'revision', 'created_at'],
  },
  {
    name: 'assignment_stops',
    columns: ['stop_id', 'assignment_id', 'trigger', 'revision', 'dispatch_revoked', 'cancellation_status', 'reason_code', 'created_at', 'updated_at'],
  },
  {
    name: 'handoffs',
    columns: ['handoff_id', 'assignment_id', 'attempt_id', 'agent_run_id', 'control_epoch', 'claimed_state', 'summary', 'artifact_refs_json', 'outstanding_effects', 'digest', 'created_at'],
  },
]

/** Frozen schema-9 prefix (b84e02f). Kept for explicit forward migration,
 * never accepted by ordinary startup. */
export const STORE_V9_TABLES = STORE_TABLES.slice(0, STORE_TABLES.findIndex(table => table.name === 'assignments'))
export const STORE_V9_DDL = `
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

export const ASSIGNMENT_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  goal_id TEXT NOT NULL REFERENCES goals(goal_id),
  agent_run_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  goal_text TEXT NOT NULL,
  task_text TEXT NOT NULL,
  write_authority INTEGER NOT NULL CHECK (write_authority IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('admitted', 'dispatching', 'running', 'candidate', 'validating', 'attention', 'reconciling', 'accepted', 'stopped', 'failed')),
  limits_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assignments_active_project
  ON assignments (project_id) WHERE state NOT IN ('accepted', 'stopped', 'failed');
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  state TEXT NOT NULL CHECK (state IN ('admitted', 'dispatching', 'running', 'candidate', 'validating', 'accepted', 'rejected', 'attention', 'stopped')),
  run_binding_json TEXT NOT NULL,
  run_binding_digest TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  gate_version INTEGER NOT NULL CHECK (gate_version > 0),
  gate_digest TEXT NOT NULL,
  gate_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL,
  control_epoch INTEGER NOT NULL,
  delivery_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assignment_id, ordinal)
);
CREATE INDEX IF NOT EXISTS attempts_by_assignment ON attempts (assignment_id);
CREATE TABLE IF NOT EXISTS assignment_writers (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  assignment_id TEXT REFERENCES assignments(assignment_id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES attempts(attempt_id) ON DELETE SET NULL,
  epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('none', 'held', 'uncertain')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assignment_outbox (
  delivery_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'attempting', 'written', 'not_sent', 'unknown')),
  reason_code TEXT,
  deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id)
);
CREATE INDEX IF NOT EXISTS assignment_outbox_by_assignment ON assignment_outbox (assignment_id);
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  summary TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  pre_manifest_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'validated', 'rejected')),
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id)
);
CREATE INDEX IF NOT EXISTS candidates_by_assignment ON candidates (assignment_id);
CREATE TABLE IF NOT EXISTS gate_results (
  result_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  gate_digest TEXT NOT NULL,
  executable_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'nonzero', 'spawn_error', 'timeout', 'output_limit', 'candidate_changed', 'gate_changed', 'unknown')),
  pre_manifest_digest TEXT NOT NULL,
  post_manifest_digest TEXT,
  exit_code INTEGER,
  reason_code TEXT,
  evidence_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'accepted', 'nonaccepting')),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id)
);
CREATE INDEX IF NOT EXISTS gate_results_by_assignment ON gate_results (assignment_id);
CREATE TABLE IF NOT EXISTS assignment_stops (
  stop_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('operator', 'elapsed_limit', 'attempt_limit', 'protocol_uncertainty', 'gate_failure_attention')),
  revision INTEGER NOT NULL,
  dispatch_revoked INTEGER NOT NULL CHECK (dispatch_revoked IN (0, 1)),
  cancellation_status TEXT NOT NULL CHECK (cancellation_status IN ('not_requested', 'requested', 'acknowledged', 'unsupported', 'timeout', 'unknown')),
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (assignment_id)
);
CREATE TABLE IF NOT EXISTS handoffs (
  handoff_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL,
  control_epoch INTEGER NOT NULL,
  claimed_state TEXT NOT NULL CHECK (claimed_state IN ('candidate', 'partial', 'blocked')),
  summary TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL,
  outstanding_effects TEXT NOT NULL CHECK (outstanding_effects IN ('none_reported', 'may_be_active', 'unknown')),
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (attempt_id)
);
CREATE INDEX IF NOT EXISTS handoffs_by_assignment ON handoffs (assignment_id);
`

export const STORE_DDL = STORE_V9_DDL + ASSIGNMENT_SCHEMA_DDL.trimStart()

export const REQUIRED_PRAGMAS = {
  foreign_keys: 1,
  synchronous: 2,
  busy_timeout: 1000,
} as const

export const REQUIRED_JOURNAL_MODE = 'delete'
