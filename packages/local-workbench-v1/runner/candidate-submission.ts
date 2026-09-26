/**
 * AL-04 Candidate submission coordinator.
 *
 * Owns the one dedicated structured port that associates a bounded C6
 * Candidate with the exact current Attempt. It is deliberately not a general
 * agent message: the extension frames one validated payload, the registry
 * trusts it only on the exact committed connection, and this module performs
 * the disk-side resolution C6 requires before the durable store records it.
 *
 * The association is idempotent for a stable duplicate and rejects changed
 * reuse. Artifact references are re-verified here (regular non-symlink file
 * inside the confirmed Project root, declared length, stable SHA-256) because
 * the pure validator only proves lexical containment.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sha256 } from './canonical-hash.ts'
import { CANDIDATE_LIMITS, validateCandidateSubmission, type ArtifactRef, type CandidateSubmission } from './candidate.ts'
import { isWorkbenchError } from './errors.ts'
import type { CandidateAssociation, CandidateSubmissionFacts, WorkbenchStore } from './store.ts'
import type { BridgeCandidateEvent, BridgeRegistry } from './bridge-registry.ts'

/** The closed outcome of one Candidate association attempt. */
export type CandidateOutcome = 'accepted' | 'duplicate' | 'invalid'
export interface CandidateSubmissionResult {
  submissionId: string
  payloadDigest: string
  outcome: CandidateOutcome
  candidateId: string | null
  digest: string | null
  reason: string | null
}

const ARTIFACT_BUFFER_BYTES = 64 * 1024

/** Resolve one artifact under the confirmed Project root, proving it on disk. */
function verifyArtifact(root: string, ref: ArtifactRef): string | null {
  const segments = ref.path.split('/')
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let stat
    try { stat = lstatSync(current) } catch { return 'artifact_missing' }
    if (stat.isSymbolicLink()) return 'artifact_escapes_project'
    if (!stat.isDirectory()) return 'artifact_not_a_file'
  }
  const target = join(root, ref.path)
  let entry
  try { entry = lstatSync(target) } catch { return 'artifact_missing' }
  if (entry.isSymbolicLink()) return 'artifact_escapes_project'
  if (!entry.isFile()) return 'artifact_not_a_file'
  if (entry.size !== ref.length) return 'artifact_length_mismatch'
  if (entry.size > CANDIDATE_LIMITS.maxArtifactFileBytes) return 'artifact_too_large'
  let fd
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC) } catch { return 'artifact_missing' }
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size !== ref.length) return 'artifact_changed'
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(ARTIFACT_BUFFER_BYTES)
    let total = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      total += read
      if (total > CANDIDATE_LIMITS.maxArtifactFileBytes) return 'artifact_too_large'
      hash.update(buffer.subarray(0, read))
    }
    if (total !== ref.length) return 'artifact_length_mismatch'
    const after = fstatSync(fd)
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return 'artifact_changed'
    if (hash.digest('hex') !== ref.digest) return 'artifact_digest_mismatch'
    return null
  } finally { closeSync(fd) }
}

/**
 * Verify each Candidate artifact still resolves under the confirmed Project root
 * with its exact declared digest and length. Exported so the AL-05 gate
 * orchestration can re-scan the checkout before and after validator execution.
 */
export function verifyCandidateArtifacts(root: string, refs: ArtifactRef[]): string | null {
  for (const ref of refs) {
    const problem = verifyArtifact(root, ref)
    if (problem) return problem
  }
  return null
}

export class CandidateSubmissionCoordinator {
  private readonly store: WorkbenchStore
  private readonly registry: BridgeRegistry
  private readonly clock: () => number
  private readonly newId: (prefix: string) => string
  private readonly associate: (input: { submission: CandidateSubmissionFacts; candidateId: string; createdAt: number }) => CandidateAssociation

  constructor(options: { store: WorkbenchStore; registry: BridgeRegistry; clock?: () => number; newId?: (prefix: string) => string; associate?: (input: { submission: CandidateSubmissionFacts; candidateId: string; createdAt: number }) => CandidateAssociation }) {
    this.store = options.store
    this.registry = options.registry
    this.clock = options.clock ?? (() => Date.now())
    this.newId = options.newId ?? (prefix => `${prefix}-${this.clock().toString(16)}`)
    this.associate = options.associate ?? (input => this.store.submitCandidate(input))
    this.registry.setCandidateHandler({ onSubmission: event => { void this.handle(event) } })
  }

  /** Process one framed submission and reply on the same exact committed connection. */
  private async handle(event: BridgeCandidateEvent): Promise<void> {
    const body = event.frame.body
    const result = this.process(body.runId as string, body.submissionId as string, body.payloadJson as string, body.payloadDigest as string)
    this.registry.prepareCandidateReceipt(body.runId as string, {
      submissionId: result.submissionId, payloadDigest: result.payloadDigest, outcome: result.outcome,
      candidateId: result.candidateId, digest: result.digest, reason: result.reason,
    })?.()
  }

  /** Associate one validated payload with its exact current Attempt, never mutating on rejection. */
  private process(runId: string, submissionId: string, payloadJson: string, payloadDigest: string): CandidateSubmissionResult {
    const reject = (reason: string) => ({ submissionId, payloadDigest, outcome: 'invalid' as const, candidateId: null, digest: null, reason })
    let submission: CandidateSubmission
    try {
      if (sha256(payloadJson) !== payloadDigest) return reject('payload_digest_mismatch')
      submission = validateCandidateSubmission(JSON.parse(payloadJson))
    } catch { return reject('invalid_payload') }
    if (submission.agentRunId !== runId) return reject('run_mismatch')
    const assignment = this.store.getAssignment(submission.assignmentId)
    const project = assignment ? this.store.getProject(assignment.projectId) : null
    if (!project) return reject('unknown_project')
    const problem = verifyCandidateArtifacts(project.canonicalPath, submission.artifactRefs)
    if (problem) return reject(problem)
    try {
      const association = this.associate({ submission, candidateId: this.newId('candidate'), createdAt: this.clock() })
      return { submissionId, payloadDigest, outcome: association.idempotent ? 'duplicate' : 'accepted',
        candidateId: association.candidate.candidateId, digest: association.candidate.digest, reason: null }
    } catch (error) {
      if (isWorkbenchError(error) && error.code === 'identity_drift') return reject('identity_conflict')
      return reject('store_rejected')
    }
  }
}
