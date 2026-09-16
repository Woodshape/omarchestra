/** Management-only delivery intent. A local write is not a Pi acknowledgement. */
import type { WorkbenchFrame } from './transport.ts'
import { workbenchError } from './errors.ts'
export type DeliveryState = 'queued' | 'attempting' | 'written' | 'not_sent' | 'unknown'
export interface BridgeDelivery {
  frameId: string
  runId: string
  kind: 'adopt' | 'committed'
  frameJson: string
  connectionId: string
  deadline: number
  state: DeliveryState
  reasonCode: string | null
  createdAt: number
}
const ID = /^[A-Za-z0-9_-]{1,128}$/
const id = (v: unknown) => typeof v === 'string' && ID.test(v)
function invalid(): never { throw workbenchError('invalid_input', 'invalid durable bridge delivery', 'preserve the record; management frames carry only closed identity metadata') }
export function validateDelivery(record: BridgeDelivery): WorkbenchFrame {
  if (!id(record.frameId) || !id(record.runId) || !id(record.connectionId)
      || !Number.isSafeInteger(record.deadline) || record.deadline < 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
      || !['queued', 'attempting', 'written', 'not_sent', 'unknown'].includes(record.state)
      || ![null, 'connection_lost', 'expired', 'revoked', 'transport_error', 'owner_restarted'].includes(record.reasonCode)
      || typeof record.frameJson !== 'string' || Buffer.byteLength(record.frameJson) > 4096) invalid()
  if (['queued', 'attempting', 'written'].includes(record.state) && record.reasonCode !== null) invalid()
  if (record.state === 'not_sent' && !['connection_lost', 'expired', 'revoked', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
  if (record.state === 'unknown' && !['transport_error', 'owner_restarted'].includes(record.reasonCode ?? '')) invalid()
  let frame: WorkbenchFrame
  try { frame = JSON.parse(record.frameJson) } catch { return invalid() }
  if (!frame || Object.keys(frame).sort().join(',') !== 'bindingDigest,frameId,kind,nonce,payload,runId'
      || frame.frameId !== record.frameId || frame.runId !== record.runId || frame.kind !== record.kind
      || typeof frame.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(frame.bindingDigest) || !id(frame.nonce)
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) invalid()
  const payload = frame.payload
  if (record.kind === 'adopt') {
    if (Object.keys(payload).sort().join(',') !== 'executionNodeId,predecessorRunId,vacancyGeneration'
        || !id(payload.executionNodeId) || (payload.predecessorRunId !== null && !id(payload.predecessorRunId))
        || !Number.isSafeInteger(payload.vacancyGeneration) || Number(payload.vacancyGeneration) < 1) invalid()
  } else if (record.kind === 'committed') {
    if (Object.keys(payload).sort().join(',') !== 'generation,projectId,role' || !id(payload.projectId) || !id(payload.role)
        || !Number.isSafeInteger(payload.generation) || Number(payload.generation) < 1) invalid()
  } else invalid()
  return frame
}
