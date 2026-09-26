/**
 * AL-04 pure bounded C6 Candidate payload validator.
 *
 * Validates the exact structured submission an extension may send for one
 * Attempt: exact Run/Attempt/control identity, bounded summary text, and
 * bounded Project-relative artifact references with stable SHA-256 digests.
 *
 * The module is pure and dependency-light: no filesystem, no SQLite, no
 * bridge frames, no persistence, and no digest computation. The Runner
 * derives `candidateId`, the canonical digest and the pre-gate manifest
 * digest itself (`store.candidateDigest`); a caller-supplied digest or
 * candidate identity is rejected here before any store sees the payload.
 * Path rules are lexical containment only. Symlink traversal cannot be
 * proven from text: the resolution step (C6) must still verify on disk that
 * every reference resolves to a regular non-symlink file inside the
 * confirmed Project root, and re-verify the declared digest and length.
 *
 * Artifact shape intentionally mirrors `store.ArtifactRef`
 * (`{path, digest, length}`) so a validated submission is structurally
 * assignable to the durable Candidate record inputs.
 */
import { workbenchError } from './errors.ts'

/** C6/C9 submission bounds. The C9 256 MiB aggregate is implied by 16 refs × 16 MiB. */
export const CANDIDATE_LIMITS = {
  maxSummaryBytes: 8192,
  maxArtifactRefs: 16,
  maxArtifactPathBytes: 4096,
  maxArtifactFileBytes: 16 * 1024 * 1024,
} as const

export interface ArtifactRef { path: string; digest: string; length: number }

/** Bounded C6 Candidate as submitted by the exact current Run. */
export interface CandidateSubmission {
  assignmentId: string
  attemptId: string
  agentRunId: string
  controlEpoch: number
  summary: string
  artifactRefs: ArtifactRef[]
}

const CANDIDATE_FIELDS = 'agentRunId,artifactRefs,assignmentId,attemptId,controlEpoch,summary'
const ARTIFACT_REF_FIELDS = 'digest,length,path'
const ID = /^[A-Za-z0-9_-]{1,128}$/
const SHA256 = /^[a-f0-9]{64}$/
/** URI scheme or Windows drive prefix (`file:`, `https:`, `C:`). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
/** C0 controls except tab/newline/carriage return, DEL, and the C1 range. */
const SUMMARY_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
/** All C0 controls, DEL, and the C1 range. Paths are single-line by definition. */
const PATH_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/

function submissionInvalid(message: string): never {
  throw workbenchError('invalid_input', `Candidate submission: ${message}`, 'supply the exact bounded C6 payload from the exact current Run/Attempt; Runner-derived identity is never caller-supplied')
}

function lifecycleId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) submissionInvalid(`${field} must be a 1–128 character [A-Za-z0-9_-] identifier`)
  return value
}

function safeCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) submissionInvalid(`${field} must be a non-negative safe integer`)
  return value
}

/** A lowercase 64-hex SHA-256 digest. */
export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

/**
 * Lexical Project-relative containment for one artifact reference. Rejects
 * absolute paths, any `.`/`..`/empty segment, backslash separators, NUL and
 * control characters, URI-scheme or drive prefixes, oversized paths, and
 * unpaired surrogates. Mid-path colons remain legal POSIX filenames.
 * This is text containment, not a filesystem guarantee: the resolution
 * step must additionally reject symlink components (C6/C9).
 */
export function validateArtifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) submissionInvalid('artifact path must be a non-empty string')
  if (!value.isWellFormed()) submissionInvalid('artifact path contains unpaired surrogate code points')
  if (Buffer.byteLength(value) > CANDIDATE_LIMITS.maxArtifactPathBytes) submissionInvalid(`artifact path exceeds ${CANDIDATE_LIMITS.maxArtifactPathBytes} UTF-8 bytes`)
  if (PATH_CONTROLS.test(value)) submissionInvalid('artifact path contains control characters')
  if (value.includes('\\')) submissionInvalid('artifact path must use "/" separators and never backslashes')
  if (value.startsWith('/')) submissionInvalid('artifact path must be Project-relative, never absolute')
  if (SCHEME.test(value)) submissionInvalid('artifact path must not carry a URI scheme or drive prefix')
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) submissionInvalid('artifact path must be a direct relative path without ".", "..", or empty segments')
  return value
}

/** Boolean form for frame-side pre-checks; diagnostics use validateArtifactPath. */
export function isProjectRelativeArtifactPath(value: unknown): value is string {
  try { validateArtifactPath(value); return true } catch { return false }
}

function validateArtifactRef(value: unknown): ArtifactRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) submissionInvalid('artifact reference is not an object')
  const ref = value as Record<string, unknown>
  if (Object.keys(ref).sort().join(',') !== ARTIFACT_REF_FIELDS) submissionInvalid('artifact reference fields must be exactly digest, length, path')
  const path = validateArtifactPath(ref.path)
  if (!isSha256Digest(ref.digest)) submissionInvalid('artifact digest must be a lowercase 64-hex SHA-256')
  const length = safeCount(ref.length, 'artifact length')
  if (length > CANDIDATE_LIMITS.maxArtifactFileBytes) submissionInvalid(`declared artifact size exceeds the per-file ${CANDIDATE_LIMITS.maxArtifactFileBytes} byte bound`)
  return { path, digest: ref.digest as string, length }
}

function validateSummaryText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) submissionInvalid('summary must be a non-empty string')
  if (!value.isWellFormed()) submissionInvalid('summary contains unpaired surrogate code points')
  if (Buffer.byteLength(value) > CANDIDATE_LIMITS.maxSummaryBytes) submissionInvalid(`summary exceeds ${CANDIDATE_LIMITS.maxSummaryBytes} UTF-8 bytes`)
  if (SUMMARY_CONTROLS.test(value)) submissionInvalid('summary may contain only tab, newline and carriage-return control characters (C13)')
  return value
}

/**
 * Validate one untrusted Candidate submission and return the typed payload.
 * Any violation rejects the whole payload; nothing is repaired or defaulted.
 * The returned object is structurally assignable to `store.candidateDigest`
 * inputs; the Runner still owns identity/digest derivation at persistence.
 */
export function validateCandidateSubmission(value: unknown): CandidateSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) submissionInvalid('payload is not an object')
  const payload = value as Record<string, unknown>
  if (Object.keys(payload).sort().join(',') !== CANDIDATE_FIELDS) submissionInvalid('payload fields must be exactly assignmentId, attemptId, agentRunId, controlEpoch, summary, artifactRefs')
  const assignmentId = lifecycleId(payload.assignmentId, 'assignmentId')
  const attemptId = lifecycleId(payload.attemptId, 'attemptId')
  const agentRunId = lifecycleId(payload.agentRunId, 'agentRunId')
  const controlEpoch = safeCount(payload.controlEpoch, 'controlEpoch')
  const summary = validateSummaryText(payload.summary)
  if (!Array.isArray(payload.artifactRefs)) submissionInvalid('artifactRefs must be an array')
  if (payload.artifactRefs.length > CANDIDATE_LIMITS.maxArtifactRefs) submissionInvalid(`artifactRefs must hold at most ${CANDIDATE_LIMITS.maxArtifactRefs} references`)
  const artifactRefs = (payload.artifactRefs as unknown[]).map(validateArtifactRef)
  const seen = new Set<string>()
  for (const ref of artifactRefs) {
    if (seen.has(ref.path)) submissionInvalid('artifact reference paths must be unique')
    seen.add(ref.path)
  }
  return { assignmentId, attemptId, agentRunId, controlEpoch, summary, artifactRefs }
}