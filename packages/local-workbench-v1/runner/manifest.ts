/**
 * Local Workbench v1 Phase 2 — ownership manifest.
 *
 * The manifest records which resources this state root owns, the durable Node
 * identity, and the schema the root was created for. It is the evidence a
 * second runner and the recovery path check before opening history. A missing
 * manifest beside existing workbench resources is drift, never a fresh root.
 */

import { constants, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { workbenchError } from './errors.ts'
import { assertNodeId, type NodeIdentity } from './identity.ts'
import { OWNED_FILE_MODE, type WorkbenchRoots } from './paths.ts'

export const MANIFEST_KIND = 'omarchestra.workbench/ownership'
export const MANIFEST_SCHEMA_VERSION = 1

export const OWNED_RESOURCES = {
  database: 'workbench.sqlite',
  ownerDatabase: 'owner.sqlite',
  fenceDatabase: 'fences.sqlite',
  backups: 'backups',
} as const

export interface OwnershipManifest {
  kind: typeof MANIFEST_KIND
  schemaVersion: number
  ownerId: string
  nodeId: string
  createdAt: number
  resources: typeof OWNED_RESOURCES
}

export function validateManifest(value: unknown): OwnershipManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw workbenchError('manifest_drift', 'ownership manifest must be an object', 'restore the recorded ownership manifest; do not delete state')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['kind', 'schemaVersion', 'ownerId', 'nodeId', 'createdAt', 'resources'].includes(key)) {
      throw workbenchError('manifest_drift', `ownership manifest: unknown field ${key}`, 'restore the recorded ownership manifest; do not delete state')
    }
  }
  if (record.kind !== MANIFEST_KIND) {
    throw workbenchError('manifest_drift', `ownership manifest kind must be ${MANIFEST_KIND}`, 'restore the recorded ownership manifest; do not delete state')
  }
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw workbenchError(
      'unsupported_schema',
      `ownership manifest schema ${String(record.schemaVersion)} is not supported (expected ${MANIFEST_SCHEMA_VERSION})`,
      'use the workbench version that created this root; do not edit the manifest by hand',
    )
  }
  if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw workbenchError('manifest_drift', 'ownership manifest createdAt must be a nonnegative safe integer', 'restore the recorded ownership manifest; do not delete state')
  }
  const resources = record.resources
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
    throw workbenchError('manifest_drift', 'ownership manifest resources must be an object', 'restore the recorded ownership manifest; do not delete state')
  }
  const resourceRecord = resources as Record<string, unknown>
  if (Object.keys(resourceRecord).sort().join(',') !== Object.keys(OWNED_RESOURCES).sort().join(',')) {
    throw workbenchError('manifest_drift', 'unexpected ownership resource key', 'preserve the original manifest')
  }
  for (const [key, expected] of Object.entries(OWNED_RESOURCES)) {
    if (resourceRecord[key] !== expected) {
      throw workbenchError('manifest_drift', `ownership manifest resource ${key} must be ${expected}`, 'restore the recorded ownership manifest; do not delete state')
    }
  }
  return {
    kind: MANIFEST_KIND,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ownerId: assertNodeId(record.ownerId, 'manifest.ownerId'),
    nodeId: assertNodeId(record.nodeId, 'manifest.nodeId'),
    createdAt: record.createdAt,
    resources: OWNED_RESOURCES,
  }
}

export function readManifest(roots: WorkbenchRoots): OwnershipManifest {
  let text: string
  try {
    text = readFileSync(roots.manifestPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw workbenchError('manifest_missing', `no ownership manifest at ${roots.manifestPath}`, 'if this root already contains workbench data, restore its manifest; otherwise use a new empty root')
    }
    throw workbenchError('store_unavailable', `cannot read ${roots.manifestPath}`, 'verify the workbench root is readable by the current user')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw workbenchError('manifest_drift', `ownership manifest ${roots.manifestPath} is not valid JSON`, 'restore the recorded ownership manifest from backup; do not delete state')
  }
  return validateManifest(parsed)
}

/** Write the manifest atomically with owner-only permissions. */
export function writeManifest(roots: WorkbenchRoots, manifest: OwnershipManifest): void {
  const validated = validateManifest(manifest)
  const temporary = `${roots.manifestPath}.new`
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, OWNED_FILE_MODE)
    try { writeFileSync(fd, JSON.stringify(validated, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, roots.manifestPath)
    const directory = openSync(roots.stateDir, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch {
    // Preserve interrupted or foreign temp files; their names do not authorize deletion.
    throw workbenchError('store_unavailable', `cannot write ${roots.manifestPath}`, 'verify the workbench root is writable by the current user')
  }
}

export function createManifest(identity: NodeIdentity, ownerId: string): OwnershipManifest {
  return {
    kind: MANIFEST_KIND,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ownerId: assertNodeId(ownerId, 'manifest.ownerId'),
    nodeId: identity.nodeId,
    createdAt: identity.createdAt,
    resources: OWNED_RESOURCES,
  }
}
