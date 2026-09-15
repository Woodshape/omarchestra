/** Durable identity is not connection authority. Only the future challenged
 * bridge may establish these values; storing them does not prove a live Pi.
 */
import { createHash } from 'node:crypto'
import { workbenchError } from './errors.ts'
export interface PiIncarnation {
  executionNodeId: string
  processInstanceId: string
  piSessionId: string
  extensionInstanceId: string
}
export interface BindingIdentity {
  runId: string
  goalId: string
  incarnation: PiIncarnation
  incarnationKey: string
}
export function validateIncarnation(input: unknown): PiIncarnation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workbenchError('invalid_input', 'invalid Pi incarnation', 'supply the exact closed bridge identity')
  const record = input as Record<string, unknown>
  const keys = ['executionNodeId', 'processInstanceId', 'piSessionId', 'extensionInstanceId'] as const
  if (Object.keys(record).length !== keys.length || keys.some(k => !Object.hasOwn(record, k) || typeof record[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record[k] as string))) {
    throw workbenchError('invalid_input', 'incarnation must contain exactly four bounded identity fields', 'use identity from the exact challenged bridge; never infer it from PID/path/title')
  }
  return Object.fromEntries(keys.map(k => [k, record[k]])) as unknown as PiIncarnation
}
export function incarnationKey(value: PiIncarnation): string {
  const checked = validateIncarnation(value)
  return createHash('sha256').update(JSON.stringify(checked)).digest('hex')
}
