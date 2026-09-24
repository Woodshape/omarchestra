/** Immutable pending Adoption target, separate from committed Run membership. */
import { validateIncarnation, type PiIncarnation } from './binding-identity.ts'
import { sha256 } from './canonical-hash.ts'
import { decodeBridgeFrame } from './bridge-protocol.ts'
export interface PendingProposal {
  proposalId: string; runId: string; projectId: string; goalId: string; role: string; observedSessionId: string
  incarnation: PiIncarnation; connectionId: string; challenge: string; nonce: string; digest: string
  generation: number; predecessorRunId: string | null; expiresAt: number; ackDeadline: number | null
  state: 'proposed' | 'authorized'; deliveryJson: string | null
  deliveryState: 'none' | 'queued' | 'attempting' | 'written' | 'unknown' | 'not_sent'
}
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
const capability = (v: unknown) => id(v) && (v as string).length >= 32
const safe = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0
function invalid(): never { throw new Error('invalid_pending_adoption_proposal') }
export function proposalDigest(p: Omit<PendingProposal, 'digest' | 'ackDeadline' | 'state' | 'deliveryJson' | 'deliveryState'>): string {
  return sha256({ proposalId: p.proposalId, runId: p.runId, projectId: p.projectId, goalId: p.goalId, role: p.role,
    observedSessionId: p.observedSessionId, incarnation: validateIncarnation(p.incarnation), connectionId: p.connectionId,
    challenge: p.challenge, nonce: p.nonce, generation: p.generation, predecessorRunId: p.predecessorRunId, expiresAt: p.expiresAt })
}
export function validatePendingProposal(p: PendingProposal): PendingProposal {
  if (Object.keys(p).sort().join(',') !== 'ackDeadline,challenge,connectionId,deliveryJson,deliveryState,digest,expiresAt,generation,goalId,incarnation,nonce,observedSessionId,predecessorRunId,projectId,proposalId,role,runId,state') invalid()
  if (![p.proposalId, p.runId, p.projectId, p.goalId, p.role, p.observedSessionId].every(id)
      || !capability(p.connectionId) || !capability(p.challenge) || !capability(p.nonce)
      || (p.predecessorRunId !== null && !id(p.predecessorRunId))
      || !safe(p.generation) || p.generation === 0 || !safe(p.expiresAt)
      || (p.ackDeadline !== null && (!safe(p.ackDeadline) || p.ackDeadline > p.expiresAt))
      || !['proposed', 'authorized'].includes(p.state)
      || !['none', 'queued', 'attempting', 'written', 'unknown', 'not_sent'].includes(p.deliveryState)) invalid()
  if (p.state === 'proposed' && (p.ackDeadline !== null || p.deliveryState !== 'none' || p.deliveryJson !== null)) invalid()
  if (p.state === 'authorized' && (p.ackDeadline === null || p.deliveryJson === null || p.deliveryState === 'none')) invalid()
  if (p.digest !== proposalDigest(p)) invalid()
  if (p.deliveryJson !== null) {
    if (Buffer.byteLength(p.deliveryJson) > 4096) invalid()
    const frame = decodeBridgeFrame(Buffer.from(p.deliveryJson))
    if (frame.type !== 'adoption_request' || frame.body.proposalId !== p.proposalId || frame.body.proposalDigest !== p.digest
        || frame.body.connectionId !== p.connectionId || frame.body.connectionChallenge !== p.challenge
        || frame.body.observedSessionId !== p.observedSessionId || frame.body.acknowledgementNonce !== p.nonce
        || frame.body.processInstanceId !== p.incarnation.processInstanceId || frame.body.piSessionId !== p.incarnation.piSessionId
        || frame.body.extensionInstanceId !== p.incarnation.extensionInstanceId || frame.body.targetGoalId !== p.goalId
        || frame.body.targetRole !== p.role || frame.body.vacancyGeneration !== p.generation) invalid()
  }
  return p
}
export function pendingRow(row: Record<string, unknown>): PendingProposal {
  let incarnation: PiIncarnation
  try { incarnation = validateIncarnation(JSON.parse(String(row.incarnation_json))) }
  catch { return invalid() }
  const p: PendingProposal = { proposalId: String(row.proposal_id), runId: String(row.run_id), projectId: String(row.project_id), goalId: String(row.goal_id), role: String(row.role), observedSessionId: String(row.observed_session_id), incarnation, connectionId: String(row.connection_id), challenge: String(row.challenge), nonce: String(row.nonce), digest: String(row.digest), generation: Number(row.generation), predecessorRunId: row.predecessor_run_id === null ? null : String(row.predecessor_run_id), expiresAt: Number(row.expires_at), ackDeadline: row.ack_deadline === null ? null : Number(row.ack_deadline), state: String(row.state) as PendingProposal['state'], deliveryJson: row.delivery_json === null ? null : String(row.delivery_json), deliveryState: String(row.delivery_state) as PendingProposal['deliveryState'] }
  return validatePendingProposal(p)
}
