/**
 * Local Workbench v1 Phase 2 — fail-closed runner error model.
 *
 * Every rejection names the exact condition, a stable reason code for the
 * projection, and one concrete recovery action. Errors never suggest blanket
 * removal of unknown directories, automatic restore, or silent drift repair.
 */

export type RunnerErrorCode =
  | 'unsafe_path'
  | 'unexpected_resource'
  | 'missing_resource'
  | 'foreign_owner'
  | 'manifest_missing'
  | 'manifest_drift'
  | 'identity_drift'
  | 'second_owner'
  | 'unsupported_schema'
  | 'schema_drift'
  | 'store_unavailable'
  | 'backup_precondition'
  | 'backup_unavailable'
  | 'migration_unavailable'
  | 'restore_unavailable'
  | 'fence_missing'
  | 'fence_conflict'
  | 'integrity_failure'
  | 'handler_unavailable'
  | 'invalid_input'

export class WorkbenchError extends Error {
  readonly code: RunnerErrorCode
  readonly recovery: string

  constructor(code: RunnerErrorCode, message: string, recovery: string) {
    super(message)
    this.name = 'WorkbenchError'
    this.code = code
    this.recovery = recovery
  }
}

export function workbenchError(code: RunnerErrorCode, message: string, recovery: string): WorkbenchError {
  return new WorkbenchError(code, message, recovery)
}

/** True when the value is one of this module's structured rejections. */
export function isWorkbenchError(value: unknown): value is WorkbenchError {
  return value instanceof WorkbenchError
}

/** Normalize an unknown thrown value into a structured runner rejection. */
export function asWorkbenchError(value: unknown, code: RunnerErrorCode, recovery: string): WorkbenchError {
  if (isWorkbenchError(value)) return value
  const message = value instanceof Error ? value.message : String(value)
  return new WorkbenchError(code, message, recovery)
}
