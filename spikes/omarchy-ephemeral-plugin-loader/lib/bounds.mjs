// SPIKE — fake-only model support. Not production code and never a real IPC
// surface. Shared limits, typed errors, and small value helpers for the
// frozen `omarchy.temporary-panel/v1` contract
// (contracts/temporary-panel-v1.md).

export const LIMITS = Object.freeze({
  requestBytes: 32768,
  pathBytes: 4096,
  manifestBytes: 65536,
  entryPointBytes: 1048576,
  payloadBytes: 16384,
  methodBytes: 64,
  registrations: 16,
  queuedCallsPerRegistration: 32,
  queuedBytesPerRegistration: 65536,
  identityBytes: 256,
  diagnosticsBytes: 1024,
  callValueBytes: 4096,
  maxDepth: 16,
  entryPointStringBytes: 1024,
  manifestIdBytes: 128,
  manifestNameBytes: 256,
  manifestVersionBytes: 64,
  operationRecords: 64,
  tombstones: 64,
  tombstoneMs: 5 * 60 * 1000,
})

/** Stable error codes with their retryability (contract error table). */
export const ERRORS = Object.freeze({
  bad_json: false,
  request_too_large: false,
  unsupported_version: false,
  unknown_operation: false,
  invalid_field: false,
  invalid_identity: false,
  unknown_operation_id: false,
  unknown_registration: false,
  stale_registration: false,
  registry_busy: true,
  capacity_exceeded: true,
  duplicate_pending: true,
  path_invalid: false,
  path_not_owned: false,
  symlink_component: false,
  source_unsafe: false,
  manifest_too_large: false,
  manifest_invalid: false,
  panel_scope_required: false,
  entry_point_invalid: false,
  plugin_id_collision: false,
  source_collision: false,
  failed_collision: false,
  invalid_payload: false,
  queue_full: true,
  invalid_method: false,
  not_summoned: false,
  unknown_method: false,
  plugin_load_failed: false,
  plugin_call_failed: false,
  source_changed: false,
  teardown_pending: true,
})

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Depth of a JSON-shaped value; objects and arrays count as one level. */
export function depthOf(value, seen = 0) {
  if (value === null || typeof value !== 'object') return seen
  if (seen > LIMITS.maxDepth + 4) return seen
  let max = seen + 1
  const children = Array.isArray(value) ? value : Object.values(value)
  for (const child of children) {
    max = Math.max(max, depthOf(child, seen + 1))
  }
  return max
}

export function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8')
}

/** Truncate a UTF-8 string to at most maxBytes bytes without splitting points. */
export function truncateUtf8(value, maxBytes) {
  const text = String(value)
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8')
  let end = maxBytes
  // Avoid splitting a multi-byte sequence.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** Bounded diagnostic text. */
export function diagnose(text) {
  return truncateUtf8(String(text ?? ''), LIMITS.diagnosticsBytes)
}

/** One typed response envelope. */
export function envelope(operation, ok, payload) {
  if (ok) return { version: 1, operation, ok: true, result: payload }
  const code = ERRORS.hasOwnProperty(payload.code) ? payload.code : 'invalid_field'
  return {
    version: 1,
    operation,
    ok: false,
    error: {
      code,
      message: diagnose(payload.message || code),
      retryable: ERRORS[code],
    },
  }
}

/** Installed-style entry-point safety (mirrors PluginRegistry.isSafeEntryPoint). */
export function isSafeEntryPoint(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.charAt(0) === '/') return false
  if (value.indexOf('..') !== -1) return false
  return true
}

/** Method names accepted by the call seam. */
export function isValidMethodName(method) {
  if (typeof method !== 'string') return false
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method)) return false
  if (method.startsWith('_')) return false
  if (method === 'open' || method === 'close' || method === 'destroy') return false
  return true
}