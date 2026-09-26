/**
 * AL-04 pure C6 Candidate submission validator tests. Disposable, no
 * filesystem, no store; only the structural digest seam imports the store
 * module without opening a database.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CANDIDATE_LIMITS,
  isProjectRelativeArtifactPath,
  isSha256Digest,
  validateArtifactPath,
  validateCandidateSubmission,
  type ArtifactRef,
  type CandidateSubmission,
} from '../runner/candidate.ts'
import { candidateDigest } from '../runner/store.ts'

const DIGEST = (salt: string) => (salt + '0'.repeat(64)).slice(0, 64)
const KIB = 1024

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assignmentId: 'assignment-1',
    attemptId: 'attempt-1',
    agentRunId: 'run-1',
    controlEpoch: 3,
    summary: 'Candidate summary\nsecond line',
    artifactRefs: [{ path: 'docs/report.md', digest: DIGEST('a'), length: 2048 }],
    ...overrides,
  }
}

test('accepts a well-formed bounded submission and returns the exact payload', () => {
  const submission_ = validateCandidateSubmission(submission())
  assert.deepEqual(submission_, {
    assignmentId: 'assignment-1', attemptId: 'attempt-1', agentRunId: 'run-1', controlEpoch: 3,
    summary: 'Candidate summary\nsecond line',
    artifactRefs: [{ path: 'docs/report.md', digest: DIGEST('a'), length: 2048 }],
  })
  assert.equal(Object.keys(submission_).sort().join(','), 'agentRunId,artifactRefs,assignmentId,attemptId,controlEpoch,summary')
})

test('accepts control-epoch zero, full-size summary and tab/newline/CR text', () => {
  const validated = validateCandidateSubmission(submission({
    controlEpoch: 0,
    summary: `${'a'.repeat(8189)}\t\n\r`,
  }))
  assert.equal(Buffer.byteLength(validated.summary), CANDIDATE_LIMITS.maxSummaryBytes)
})

test('rejects non-object payloads', () => {
  for (const value of [null, undefined, 42, 'payload', [], true]) {
    assertRejectedPayload(value)
  }
})

function assertRejectedPayload(value: unknown): void {
  assert.throws(() => validateCandidateSubmission(value), (error: unknown) => {
    assert.equal((error as Error).name, 'WorkbenchError')
    assert.equal((error as { code?: string }).code, 'invalid_input')
    return true
  })
}

test('rejects wrong payload field sets', () => {
  const missing = submission() as Record<string, unknown>
  delete missing.summary
  assertRejectedPayload(missing, /fields must be exactly/)
  assertRejectedPayload(submission({ candidateId: 'candidate-1' }), /fields must be exactly/)
  assertRejectedPayload(submission({ digest: DIGEST('d') }), /fields must be exactly/)
  assertRejectedPayload(submission({ preManifestDigest: DIGEST('m') }), /fields must be exactly/)
})

test('rejects invalid identity identifiers', () => {
  for (const field of ['assignmentId', 'attemptId', 'agentRunId'] as const) {
    for (const value of ['', 'a'.repeat(129), 'with space', 'bad/slash', 'bad.dot', 7, null]) {
      assertRejectedPayload(submission({ [field]: value }), new RegExp(`${field} must be`))
    }
  }
})

test('rejects invalid control epochs', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', NaN, null]) {
    assertRejectedPayload(submission({ controlEpoch: value }), /controlEpoch must be/)
  }
})

test('rejects out-of-bounds or unsafe summary text', () => {
  assertRejectedPayload(submission({ summary: '' }), /summary must be/)
  assertRejectedPayload(submission({ summary: 'a'.repeat(8193) }), /exceeds 8192/)
  assertRejectedPayload(submission({ summary: 'é'.repeat(4097) }), /exceeds 8192/)
  assertRejectedPayload(submission({ summary: 'bad\u0000nul' }), /control characters|non-empty/)
  assertRejectedPayload(submission({ summary: 'bad\u0001c0' }), /only tab, newline/)
  assertRejectedPayload(submission({ summary: 'bad\u007Fdel' }), /only tab, newline/)
  assertRejectedPayload(submission({ summary: 'bad\u009Fc1' }), /only tab, newline/)
  assertRejectedPayload(submission({ summary: 'lone\uD800surrogate' }), /unpaired surrogate/)
})

test('rejects artifactRefs container violations', () => {
  assertRejectedPayload(submission({ artifactRefs: 'docs/report.md' }), /artifactRefs must be an array/)
  assertRejectedPayload(submission({ artifactRefs: null }), /artifactRefs must be an array/)
  const seventeen = Array.from({ length: CANDIDATE_LIMITS.maxArtifactRefs + 1 }, (_, index) => (
    { path: `docs/report-${index}.md`, digest: DIGEST(String(index)), length: 1 }
  ))
  assertRejectedPayload(submission({ artifactRefs: seventeen }), /at most 16/)
})

test('rejects artifact reference shape violations', () => {
  const base = { path: 'docs/report.md', digest: DIGEST('a'), length: 1 }
  assertRejectedPayload(submission({ artifactRefs: [null] }), /not an object/)
  assertRejectedPayload(submission({ artifactRefs: [[base.path, base.digest]] }), /not an object/)
  assertRejectedPayload(submission({ artifactRefs: [{ ...base, mediaKind: 'text/plain' }] }), /fields must be exactly/)
  assertRejectedPayload(submission({ artifactRefs: [{ path: base.path, digest: base.digest }] }), /fields must be exactly/)
})

test('rejects malformed artifact digests', () => {
  for (const digest of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${'g'.repeat(63)}0`, 7, null]) {
    assertRejectedPayload(submission({ artifactRefs: [{ path: 'docs/report.md', digest, length: 1 }] }), /lowercase 64-hex/)
  }
})

test('rejects out-of-bounds declared artifact sizes', () => {
  const atCap = CANDIDATE_LIMITS.maxArtifactFileBytes
  assert.equal(validateCandidateSubmission(submission({ artifactRefs: [{ path: 'docs/report.md', digest: DIGEST('a'), length: atCap }] })).artifactRefs[0]!.length, atCap)
  for (const length of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, atCap + 1, '1', null]) {
    assertRejectedPayload(submission({ artifactRefs: [{ path: 'docs/report.md', digest: DIGEST('a'), length }] }), /artifact length|per-file/)
  }
})

test('rejects duplicate artifact paths', () => {
  const ref = { path: 'docs/report.md', digest: DIGEST('a'), length: 1 }
  assertRejectedPayload(submission({ artifactRefs: [ref, { ...ref, digest: DIGEST('b') }] }), /paths must be unique/)
})

test('rejects traversal, absolute, URI, and unsafe artifact paths', () => {
  for (const path of [
    'a/../b', '../b', 'a/..', '..', './b', 'a/./b', 'a//b', 'a/', '/a', '/etc/passwd',
    'a\\..\\b', 'back\\slash.md', 'file:///etc/passwd', 'https://example.invalid/report.md',
    'C:/windows/report.md', 'C:report.md', 'mailto:report.md', 'bad\u0000nul.md', 'bad\u0001c0.md',
    'a'.repeat(4097), 'surrogate\uD800.md', '', 7, null,
  ]) {
    assert.throws(() => validateArtifactPath(path), (error: unknown) => {
      assert.match(String((error as Error).message), /Candidate submission/)
      return true
    })
  }
})

test('accepts contained relative paths at exact bounds', () => {
  assert.equal(validateArtifactPath('a'.repeat(CANDIDATE_LIMITS.maxArtifactPathBytes)), 'a'.repeat(CANDIDATE_LIMITS.maxArtifactPathBytes))
  assert.equal(validateArtifactPath('docs/日本語/report.md'), 'docs/日本語/report.md')
  assert.equal(validateArtifactPath('docs/v2:final/report.md'), 'docs/v2:final/report.md')
  assert.equal(validateArtifactPath('.../ellipsis/report.md'), '.../ellipsis/report.md')
  assert.equal(validateArtifactPath('docs/.hidden/report.md'), 'docs/.hidden/report.md')
})

test('boolean path and digest helpers agree with the throwing validators', () => {
  assert.equal(isProjectRelativeArtifactPath('docs/report.md'), true)
  assert.equal(isProjectRelativeArtifactPath('../escape.md'), false)
  assert.equal(isProjectRelativeArtifactPath('/etc/passwd'), false)
  assert.equal(isSha256Digest(DIGEST('a')), true)
  assert.equal(isSha256Digest('A'.repeat(64)), false)
  assert.equal(isSha256Digest(7), false)
})

test('returns a fresh typed object; input mutation cannot smuggle changes', () => {
  const input = submission()
  const validated = validateCandidateSubmission(input)
  const refs = input.artifactRefs as Array<Record<string, unknown>>
  refs[0]!.path = '../escape.md'
  assert.equal(validated.artifactRefs[0]!.path, 'docs/report.md')
})

test('validated submissions are structurally digestable by the durable Candidate seam', () => {
  const validated: CandidateSubmission = validateCandidateSubmission(submission())
  const fromIdentity = candidateDigest(validated)
  assert.match(fromIdentity, /^[a-f0-9]{64}$/)
  // Identity fields bind the digest: a different Attempt or control epoch is a
  // different payload even with identical text and artifacts.
  const otherAttempt: CandidateSubmission = validateCandidateSubmission(submission({ attemptId: 'attempt-2' }))
  const otherEpoch: CandidateSubmission = validateCandidateSubmission(submission({ controlEpoch: 4 }))
  assert.notEqual(candidateDigest(otherAttempt), fromIdentity)
  assert.notEqual(candidateDigest(otherEpoch), fromIdentity)
  // A resubmission of the exact payload stays one stable digest (AL-04 idempotency input).
  assert.equal(candidateDigest(validateCandidateSubmission(submission())), fromIdentity)
})

test('reference bounds stay within the C9 aggregate implied cap', () => {
  const refs: ArtifactRef[] = Array.from({ length: CANDIDATE_LIMITS.maxArtifactRefs }, (_, index) => (
    { path: `docs/report-${index}.md`, digest: DIGEST(String(index)), length: CANDIDATE_LIMITS.maxArtifactFileBytes }
  ))
  const validated = validateCandidateSubmission(submission({ artifactRefs: refs }))
  const total = validated.artifactRefs.reduce((sum, ref) => sum + ref.length, 0)
  assert.equal(total, 16 * 16 * 1024 * 1024)
})