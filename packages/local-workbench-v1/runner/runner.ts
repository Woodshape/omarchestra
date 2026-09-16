/**
 * Local Workbench v1 Phase 2 — the one foreground runner composition (C1/C3).
 *
 * Exactly one runner owns the registry, store, management authority and
 * projection. Startup order is fixed and recoverable:
 *
 *   resolve owned roots -> verify manifest/identity -> acquire lifetime owner
 *   lock -> open store (durable epoch increment) -> open retained fence ledger
 *   -> recover fences and writer uncertainty -> ready
 *
 * Shutdown reverses it and releases the owner lock last. Clean shutdown closes
 * connections without deleting history. Nothing here dispatches work, runs a
 * validator, or spawns a process; those remain Phase 3/4.
 */

import { existsSync } from 'node:fs'
import { createOwnedReceipt, verifyOwnedReceipt, guardOwned } from './owned-resources.ts'
import { createBackup, describeBackupSupport, type BackupMetadata, type BackupSupport } from './backup.ts'
import { workbenchError } from './errors.ts'
import { prepareManagementOperation, completeManagementOperation, type ManagementCommandInput, type ManagementCommandResult, type ManagementCommandPhase } from './management-operations.ts'
import { incarnationKey, type PiIncarnation } from './binding-identity.ts'
import { openFenceLedger, type BindingFence, type FenceLedger, type RecordRetirementInput } from './fences.ts'
import { createNodeIdentity, defaultNewId, type NodeIdentityOptions } from './identity.ts'
import { createManifest, readManifest, writeManifest, type OwnershipManifest } from './manifest.ts'
import { acquireOwnerLock, type OwnerLock } from './owner-lock.ts'
import { resolveRoots, type WorkbenchRoots, type WorkbenchRootsInput } from './paths.ts'
import { recoverRunnerState, type RecoveryReport } from './recovery.ts'
import { openWorkbenchStore, type BindingRecord, type WorkbenchStore } from './store.ts'

export interface WorkbenchRunnerOptions extends NodeIdentityOptions {
  roots: WorkbenchRootsInput
  /** Injected crash-boundary observer for disposable persistence tests only. */
  failurePoint?: (phase: 'retirement_ledger' | 'retirement_store' | 'purge_intent' | 'purge_store' | 'purge_fence' | ManagementCommandPhase) => void
}

export interface RetireBindingInput extends Omit<RecordRetirementInput, 'predecessorRunId' | 'goalId' | 'incarnationKey'> {
  predecessorRunId?: string | null
}

export interface WorkbenchRunner {
  readonly roots: WorkbenchRoots
  readonly manifest: OwnershipManifest
  readonly nodeId: string
  readonly epoch: number
  readonly store: WorkbenchStore
  readonly fences: FenceLedger
  readonly recovery: RecoveryReport
  readonly ownershipHeld: true
  /** Persistence checks only; callers still require challenged bridge proof. */
  bindIdentity(runId: string, goalId: string, incarnation: PiIncarnation): void
  commitMembership(runId: string): void
  /** Record the fence first, then mark the binding retired; fence wins on crash. */
  retireBinding(input: RetireBindingInput): BindingFence
  /** Leaf-only purge; requires an independently retained fence and terminal state. */
  purgeBinding(runId: string): BindingFence | null
  executeManagementCommand(input: ManagementCommandInput): ManagementCommandResult
  backup(): BackupMetadata
  describe(): Record<string, unknown>
  close(): void
}

function resourcePresence(roots: WorkbenchRoots) {
  return {
    manifest: existsSync(roots.manifestPath),
    tornManifest: existsSync(`${roots.manifestPath}.new`),
    database: existsSync(roots.databasePath),
    owner: existsSync(roots.ownerDatabasePath),
    fences: existsSync(roots.fenceDatabasePath),
  }
}

export function openWorkbenchRunner(options: WorkbenchRunnerOptions): WorkbenchRunner {
  const clock = options.clock ?? (() => Date.now())
  const roots = resolveRoots(options.roots)
  const presence = resourcePresence(roots)
  if (presence.tornManifest) {
    throw workbenchError(
      'manifest_drift',
      `an interrupted manifest write left ${roots.manifestPath}.new`,
      `verify ${roots.manifestPath} is the intended manifest, then remove the .new file by hand; automated startup never repairs it`,
    )
  }
  const hasHistoryEvidence = presence.database || presence.owner || presence.fences
  if (!presence.manifest && hasHistoryEvidence) {
    throw workbenchError(
      'manifest_missing',
      `workbench resources exist at ${roots.stateDir} without an ownership manifest`,
      'restore the ownership manifest from the same backup as the store; do not delete unknown state or start a second root',
    )
  }
  const existingManifest = presence.manifest ? readManifest(roots) : null
  if (existingManifest !== null && (!presence.database || !presence.fences || !presence.owner)) {
    throw workbenchError(
      'missing_resource',
      `owned root ${roots.stateDir} is missing its store or fence ledger`,
      'restore the missing resource from the same retained backup; never recreate a store beside a fence ledger',
    )
  }

  // Verify before opening SQLite: opening a missing lock would create a new
  // inode and allow another owner while the old owner still holds its inode.
  let checkOwned = existingManifest === null ? null : verifyOwnedReceipt(roots)
  let lock: OwnerLock | null = null
  let store: WorkbenchStore | null = null
  let fences: FenceLedger | null = null
  try {
    // The owner lock is acquired before identity creation or manifest writes,
    // so two first-runs cannot race into two manifests. The lock file itself
    // carries no durable history.
    lock = acquireOwnerLock({ path: roots.ownerDatabasePath, clock })
    checkOwned?.()
    if (existingManifest === null && existsSync(roots.manifestPath)) {
      throw workbenchError('manifest_drift', 'another bootstrap completed while acquiring ownership', 'retry startup against the existing manifest; never overwrite it')
    }
    let manifest: OwnershipManifest
    let create = false
    if (existingManifest !== null) {
      manifest = existingManifest
    } else {
      create = true
      const identity = createNodeIdentity({ newId: options.newId ?? defaultNewId, clock })
      manifest = createManifest(identity, identity.nodeId)
      writeManifest(roots, manifest)
    }
    store = openWorkbenchStore({ path: roots.databasePath, nodeId: manifest.nodeId, create, clock })
    fences = openFenceLedger({ path: roots.fenceDatabasePath, create, clock })
    const integrity = fences.integrityCheck()
    if (integrity.toLowerCase() !== 'ok') {
      throw workbenchError('integrity_failure', `fence ledger integrity_check reported ${integrity}`, 'restore the independently retained fence ledger; revoked bindings must never be revived')
    }
    checkOwned ??= createOwnedReceipt(roots)
    checkOwned()
    let operationFault = false
    const assertOperational = () => {
      checkOwned!()
      if (operationFault) throw workbenchError('store_unavailable', 'interrupted cross-ledger operation; admission is fenced', 'close and reopen this exact owned root to reconcile durable operation intent')
    }
    store = guardOwned(store, assertOperational)
    fences = guardOwned(fences, assertOperational)
    const recovery = recoverRunnerState({ store, fences, clock })
    const closed = { value: false }
    const handle: WorkbenchRunner = {
      roots,
      manifest,
      nodeId: manifest.nodeId,
      epoch: store.epoch,
      store,
      fences,
      recovery,
      ownershipHeld: true,
      bindIdentity(runId, goalId, incarnation) {
        if (fences!.isFenced(runId) || fences!.isIncarnationFenced(incarnationKey(incarnation))) throw workbenchError('fence_conflict', 'retired incarnation cannot acquire a new binding', 'restart/resume never restores retired authority')
        store!.putBindingIdentity(runId, goalId, incarnation)
      },
      commitMembership(runId) {
        const identity = store!.getBindingIdentity(runId)
        if (!identity || fences!.isFenced(runId) || fences!.isIncarnationFenced(identity.incarnationKey)) throw workbenchError('fence_conflict', 'membership has no eligible exact identity', 'fresh acknowledgement and unfenced incarnation are required')
        store!.commitMembership(runId)
      },
      retireBinding(input) {
        const existing = store!.getBinding(input.runId)
        const identity = store!.getBindingIdentity(input.runId)
        if (!existing) throw workbenchError('missing_resource', 'retirement requires retained Run history', 'a minimal fence cannot be expanded back into an Agent Run')
        const predecessorRunId = existing.predecessorRunId
        if (existing.projectId !== input.projectId || existing.role !== input.role || existing.bindingDigest !== input.bindingDigest
            || (input.predecessorRunId !== undefined && input.predecessorRunId !== predecessorRunId)) {
          throw workbenchError('identity_drift', 'retirement target differs from retained binding', 'confirm the original exact target')
        }
        // The ledger's durable intent wins after any interruption. No success
        // is returned before the store transition is also committed.
        try {
          const fence = fences!.recordRetirement({ ...input, predecessorRunId,
            goalId: identity?.goalId ?? null, incarnationKey: identity?.incarnationKey ?? null })
          options.failurePoint?.('retirement_ledger')
          const binding: BindingRecord = { ...existing, state: 'retired', writerState: 'uncertain', generation: fence.generation, updatedAt: clock() }
          store!.transaction(() => {
            store!.putBinding(binding)
            store!.releaseMembership(binding.runId)
          })
          options.failurePoint?.('retirement_store')
          return fence
        } catch (error) { operationFault = true; throw error }
      },
      purgeBinding(runId) {
        if (fences!.isPurged(runId)) return null
        const fence = fences!.assertFence(runId)
        const binding = store!.getBinding(runId)
        if (binding === null) {
          throw workbenchError('missing_resource', `binding ${runId} does not exist`, 'nothing to purge; verify the retained fence ledger if you expected history')
        }
        if (binding.state !== 'retired' && binding.state !== 'purged') {
          throw workbenchError('invalid_input', `binding ${runId} is ${binding.state}, not a terminal retired leaf`, 'retire the binding and confirm the successor state before purge; purge never removes active work')
        }
        // Purge is strictly newest-first: any successor that is still retained
        // (not itself purged) references this Run, so this Run is not a leaf.
        const successor = store!.listBindings().find(entry => entry.predecessorRunId === runId && entry.state !== 'purged')
        if (successor) {
          throw workbenchError('invalid_input', `binding ${runId} has a retained successor ${successor.runId}`, 'purge the newest retained Run first; purge is leaf-only and never deletes external work')
        }
        const purgedAt = clock()
        try {
          fences!.markPurged(runId, purgedAt)
          options.failurePoint?.('purge_intent')
          store!.purgeRetiredHistory(runId, purgedAt)
          options.failurePoint?.('purge_store')
          fences!.completePurge(runId)
          options.failurePoint?.('purge_fence')
          return fence
        } catch (error) { operationFault = true; throw error }
      },
      executeManagementCommand(input) {
        // Validate before durable preparation. After preparation, failure is
        // pending reconciliation, never a final rejected command receipt.
        const operation = prepareManagementOperation(handle, input, clock())
        try {
          store!.transaction(() => store!.putManagementOperation(operation))
          options.failurePoint?.('command_prepared')
          return completeManagementOperation(handle, operation, { clock, newId: options.newId ?? defaultNewId, failurePoint: options.failurePoint })
        } catch (error) { operationFault = true; throw error }
      },
      backup() {
        return createBackup({ store: store!, roots, ownershipHeld: true, clock })
      },
      describe() {
        return describeRunner(handle)
      },
      close() {
        if (closed.value) return
        closed.value = true
        // Store and ledger close before the owner lock is released.
        try { store!.close() } finally {
          try { fences!.close() } finally { lock!.release() }
        }
      },
    }
    // No authority or presentation can attach before retained command
    // authorizations are reconciled with the independent revocation ledger.
    for (const operation of store.listManagementOperations()) {
      completeManagementOperation(handle, operation, { clock, newId: options.newId ?? defaultNewId })
    }
    return handle
  } catch (error) {
    try { store?.close() } catch { /* already failing */ }
    try { fences?.close() } catch { /* already failing */ }
    try { lock?.release() } catch { /* already failing */ }
    throw error
  }
}

export function describeRunner(runner: Pick<WorkbenchRunner, 'roots' | 'nodeId' | 'epoch' | 'store' | 'fences' | 'recovery' | 'ownershipHeld'>): Record<string, unknown> {
  const support: BackupSupport = describeBackupSupport()
  return {
    stateDir: runner.roots.stateDir,
    databasePath: runner.roots.databasePath,
    fenceDatabasePath: runner.roots.fenceDatabasePath,
    ownerDatabasePath: runner.roots.ownerDatabasePath,
    backupDir: runner.roots.backupDir,
    nodeId: runner.nodeId,
    epoch: runner.epoch,
    ownershipHeld: runner.ownershipHeld,
    storeNodeId: runner.store.nodeId,
    storeEpoch: runner.store.epoch,
    bindings: runner.store.listBindings().length,
    fences: runner.fences.listFences().length,
    recovery: runner.recovery,
    backup: support,
  }
}
