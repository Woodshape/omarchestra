/**
 * Local Workbench v1 Phase 2 — durable local Node identity.
 *
 * The identity is a random opaque value bound to one workbench state root. It
 * is not derived from a path, hostname, PID, or clock, so a moved checkout or
 * restarted process cannot inherit ownership or fences by accident.
 */

import { randomUUID } from 'node:crypto'
import { workbenchError } from './errors.ts'

export const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface NodeIdentity {
  nodeId: string
  createdAt: number
}

export interface NodeIdentityOptions {
  /** Injected ID source for deterministic tests. */
  newId?: (prefix: string) => string
  clock?: () => number
}

export function defaultNewId(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, '')}`
}

export function assertNodeId(value: unknown, where = 'nodeId'): string {
  if (typeof value !== 'string' || !NODE_ID_PATTERN.test(value)) {
    throw workbenchError('invalid_input', `${where} must be 1-128 ASCII letters/digits/underscore/hyphen`, 'pass a durable identity value')
  }
  return value
}

export function createNodeIdentity(options: NodeIdentityOptions = {}): NodeIdentity {
  const newId = options.newId ?? defaultNewId
  const clock = options.clock ?? (() => Date.now())
  return { nodeId: assertNodeId(newId('node-')), createdAt: clock() }
}

export function validateNodeIdentity(value: unknown, where = 'node identity'): NodeIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw workbenchError('manifest_drift', `${where} must be an object`, 'restore the recorded ownership manifest; do not delete state')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  for (const key of keys) {
    if (!['nodeId', 'createdAt'].includes(key)) {
      throw workbenchError('manifest_drift', `${where}: unknown field ${key}`, 'restore the recorded ownership manifest; do not delete state')
    }
  }
  if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw workbenchError('manifest_drift', `${where}.createdAt must be a nonnegative safe integer`, 'restore the recorded ownership manifest; do not delete state')
  }
  return { nodeId: assertNodeId(record.nodeId, `${where}.nodeId`), createdAt: record.createdAt }
}
