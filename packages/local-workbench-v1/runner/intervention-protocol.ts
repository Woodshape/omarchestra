/** Explicit managed handoff content, never ordinary-session telemetry. */
import { validateCandidateSubmission, type ArtifactRef } from './candidate.ts'

export const INTERVENTION_CAPABILITY = 'management.intervention'
export type ControlOperation = 'handoff' | 'probe' | 'resume'
export interface ControlTarget {
  runId: string; bindingDigest: string; controlEpoch: number
  connectionId: string; connectionChallenge: string; executionContextDigest: string
}
export interface ControlProof extends ControlTarget {
  requestId: string; operation: ControlOperation; outcome: string
  activity: string; pendingInput: boolean; sequence: number; receivedAt: number
}
export interface HandoffContent {
  summary: string; artifactRefs: ArtifactRef[]
  claimedState: 'candidate' | 'partial' | 'blocked'
  outstandingEffects: 'none_reported' | 'may_be_active' | 'unknown'
}
export function validateHandoffContent(value: unknown): HandoffContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'artifactRefs,claimedState,outstandingEffects,summary') throw new Error('invalid_handoff')
  const content = value as HandoffContent
  if (!['candidate', 'partial', 'blocked'].includes(content.claimedState)
      || !['none_reported', 'may_be_active', 'unknown'].includes(content.outstandingEffects)) throw new Error('invalid_handoff')
  // Reuse C6's closed summary/artifact byte, count and lexical path bounds.
  const validated = validateCandidateSubmission({ assignmentId: 'handoff', attemptId: 'handoff', agentRunId: 'handoff',
    controlEpoch: 0, summary: content.summary, artifactRefs: content.artifactRefs })
  return { summary: validated.summary, artifactRefs: validated.artifactRefs,
    claimedState: content.claimedState, outstandingEffects: content.outstandingEffects }
}
