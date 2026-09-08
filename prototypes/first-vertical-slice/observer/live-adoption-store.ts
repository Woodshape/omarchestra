/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-adoption-store.ts — the injected transactional state contract for the
 * live Adoption slice. It owns the durable observed-to-managed transition,
 * Role occupancy, committed Agent Run, control state, presentation, proposal
 * result mapping, event, and cursor. It performs no I/O and imports neither
 * QML nor SQLite; the durable adapter is injected (see manual/).
 *
 * This module is part of the bounded integration contract
 * (docs/live-adoption-integration-contract.md). The durable adapter is
 * implemented in a later task; this module defines the shapes and validation.
 */

import { randomBytes } from 'node:crypto'

import { ROLES, isBoundedId, type Role } from '../src/protocol.ts'

export const ADOPTION_STORE_MAX_RUNS = 64
export const ADOPTION_STORE_MAX_EVENTS = 256

export interface CommittedIdentity {
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
}

/**
 * The durable binding identity. `observedSessionId` is historical
 * correlation data only; it is never part of uniqueness or recovery lookup.
 * A fresh observed ID for the same process/session/extension binding must not
 * evade the committed tombstone.
 */
export interface BindingIdentity {
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
}

export interface CommittedAdoption {
  proposalId: string
  proposalDigest: string
  agentRunId: string
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  targetTeamGoalId: string
  targetRole: Role
  controlMode: 'managed'
  piStatus: string
  terminalTitleMetadata: string
  runtimeBinding: null
  runtimeBindingGuarantee: 'unavailable'
  committedAt: number
}

export interface CommitAdoptionInput {
  proposal: Record<string, unknown>
  authorization: Record<string, unknown>
  acknowledgement: Record<string, unknown>
  observed: Record<string, unknown>
  reconciliation: Record<string, unknown>
}

export interface AdoptionEvent {
  sequence: number
  type: 'adopted'
  proposalId: string
  observedSessionId: string
  agentRunId: string
  targetTeamGoalId: string
  targetRole: Role
}

export interface DurableAdoptionState {
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  committedRuns: CommittedAdoption[]
  cursor: number
  events: AdoptionEvent[]
}

export interface AdoptionTransaction {
  committedByIdentity(identity: CommittedIdentity): CommittedAdoption | null
  committedByProposal(proposalId: string): CommittedAdoption | null
  committedByBinding(binding: BindingIdentity): CommittedAdoption | null
  isRoleOccupied(teamGoalId: string, role: Role): boolean
  isIdentityCommitted(identity: CommittedIdentity): boolean
  isBindingCommitted(binding: BindingIdentity): boolean
  currentCursor(): number
  eventsAfter(cursor: number): AdoptionEvent[]
  commitAdoption(input: CommitAdoptionInput): CommittedAdoption
}

export interface AdoptionStore {
  transaction<T>(operation: (tx: AdoptionTransaction) => T): T
  snapshot(): DurableAdoptionState
  close(): void
}

export function validateDurableAdoptionState(input: unknown): DurableAdoptionState {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('durable Adoption state must be a plain object')
  }
  const value = input as Record<string, unknown>
  const executionNodeId = requireId(value.executionNodeId, 'executionNodeId')
  const teamGoalId = requireId(value.teamGoalId, 'teamGoalId')
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > 3) {
    throw new TypeError('durable Adoption roles must be a bounded non-empty array')
  }
  const roles = value.roles.map((role, index) => requireRole(role, `roles[${index}]`))
  if (!Array.isArray(value.committedRuns) || value.committedRuns.length > ADOPTION_STORE_MAX_RUNS) {
    throw new TypeError('durable Adoption committedRuns must be a bounded array')
  }
  const committedRuns = value.committedRuns.map((run, index) => validateCommittedAdoption(run, `committedRuns[${index}]`))
  const cursor = requireNonNegativeInt(value.cursor, 'cursor')
  if (!Array.isArray(value.events) || value.events.length > ADOPTION_STORE_MAX_EVENTS) {
    throw new TypeError('durable Adoption events must be a bounded array')
  }
  const events = value.events.map((event, index) => validateAdoptionEvent(event, `events[${index}]`))
  return { executionNodeId, teamGoalId, roles, committedRuns, cursor, events }
}

export function validateCommittedAdoption(input: unknown, where = 'committed Adoption'): CommittedAdoption {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const value = input as Record<string, unknown>
  const targetRole = requireRole(value.targetRole, `${where} targetRole`)
  if (value.controlMode !== 'managed') {
    throw new TypeError(`${where} controlMode must be exactly "managed"`)
  }
  if (value.runtimeBinding !== null) {
    throw new TypeError(`${where} runtimeBinding must be null`)
  }
  if (value.runtimeBindingGuarantee !== 'unavailable') {
    throw new TypeError(`${where} runtimeBindingGuarantee must be exactly "unavailable"`)
  }
  return {
    proposalId: requireId(value.proposalId, `${where} proposalId`),
    proposalDigest: requireDigest(value.proposalDigest),
    agentRunId: requireId(value.agentRunId, `${where} agentRunId`),
    observedSessionId: requireId(value.observedSessionId, `${where} observedSessionId`),
    executionNodeId: requireId(value.executionNodeId, `${where} executionNodeId`),
    processIncarnationId: requireId(value.processIncarnationId, `${where} processIncarnationId`),
    piSessionId: requireId(value.piSessionId, `${where} piSessionId`),
    extensionInstanceId: requireId(value.extensionInstanceId, `${where} extensionInstanceId`),
    targetTeamGoalId: requireId(value.targetTeamGoalId, `${where} targetTeamGoalId`),
    targetRole,
    controlMode: 'managed',
    piStatus: requireBoundedText(value.piStatus, `${where} piStatus`, 512),
    terminalTitleMetadata: requireBoundedText(value.terminalTitleMetadata, `${where} terminalTitleMetadata`, 512),
    runtimeBinding: null,
    runtimeBindingGuarantee: 'unavailable',
    committedAt: requireNonNegativeInt(value.committedAt, `${where} committedAt`),
  }
}

export function validateAdoptionEvent(input: unknown, where = 'Adoption event'): AdoptionEvent {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  const value = input as Record<string, unknown>
  if (value.type !== 'adopted') {
    throw new TypeError(`${where} type must be exactly "adopted"`)
  }
  return {
    sequence: requireNonNegativeInt(value.sequence, `${where} sequence`),
    type: 'adopted',
    proposalId: requireId(value.proposalId, `${where} proposalId`),
    observedSessionId: requireId(value.observedSessionId, `${where} observedSessionId`),
    agentRunId: requireId(value.agentRunId, `${where} agentRunId`),
    targetTeamGoalId: requireId(value.targetTeamGoalId, `${where} targetTeamGoalId`),
    targetRole: requireRole(value.targetRole, `${where} targetRole`),
  }
}

export function committedIdentityOf(committed: CommittedAdoption): CommittedIdentity {
  return {
    observedSessionId: committed.observedSessionId,
    executionNodeId: committed.executionNodeId,
    processIncarnationId: committed.processIncarnationId,
    piSessionId: committed.piSessionId,
    extensionInstanceId: committed.extensionInstanceId,
  }
}

export function bindingOf(identity: CommittedIdentity): BindingIdentity {
  return {
    executionNodeId: identity.executionNodeId,
    processIncarnationId: identity.processIncarnationId,
    piSessionId: identity.piSessionId,
    extensionInstanceId: identity.extensionInstanceId,
  }
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) throw new TypeError(`${where} must be a bounded identity`)
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new TypeError('proposal digest must be exactly 64 lowercase hexadecimal characters')
  }
  return input
}

function requireRole(input: unknown, where: string): Role {
  if (typeof input !== 'string' || !(ROLES as readonly string[]).includes(input)) {
    throw new TypeError(`${where} must be an allowed Role`)
  }
  return input as Role
}

function requireNonNegativeInt(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new TypeError(`${where} must be a non-negative safe integer`)
  }
  return input
}

function requireBoundedText(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > maxCharacters) {
    throw new TypeError(`${where} must be bounded text`)
  }
  return input
}

/**
 * Disposable in-memory AdoptionStore for fake-only tests. It enforces
 * uniqueness of the binding identity and (teamGoalId, role) inside the
 * synchronous transaction and persists the observed-to-managed transition,
 * Role occupancy, Agent Run, control state, presentation, result mapping,
 * event, and cursor. It performs no I/O.
 */
export function createInMemoryAdoptionStore(options: {
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  agentRunIdFactory?: () => string
}): AdoptionStore {
  let committed: CommittedAdoption[] = []
  let cursor = 0
  let events: AdoptionEvent[] = []
  const agentRunIdFactory = options.agentRunIdFactory
    ?? (() => `agent-run-${randomBytes(16).toString('hex')}`)

  const tx: AdoptionTransaction = {
    committedByIdentity: (identity) => committed.find((run) => sameIdentity(run, identity)) ?? null,
    committedByProposal: (proposalId) => committed.find((run) => run.proposalId === proposalId) ?? null,
    committedByBinding: (binding) => committed.find((run) => sameBinding(run, binding)) ?? null,
    isRoleOccupied: (teamGoalId, role) => committed.some(
      (run) => run.targetTeamGoalId === teamGoalId && run.targetRole === role,
    ),
    isIdentityCommitted: (identity) => committed.some((run) => sameIdentity(run, identity)),
    isBindingCommitted: (binding) => committed.some((run) => sameBinding(run, binding)),
    currentCursor: () => cursor,
    eventsAfter: (after) => events.filter((event) => event.sequence > after),
    commitAdoption: (input) => {
      const proposal = requirePlainRecord(input.proposal, 'Adoption proposal')
      const role = requireRole(proposal.targetRole, 'targetRole')
      const teamGoalId = requireId(proposal.targetTeamGoalId, 'targetTeamGoalId')
      const identity: CommittedIdentity = {
        observedSessionId: requireId(proposal.observedSessionId, 'observedSessionId'),
        executionNodeId: requireId(proposal.executionNodeId, 'executionNodeId'),
        processIncarnationId: requireId(proposal.processIncarnationId, 'processIncarnationId'),
        piSessionId: requireId(proposal.piSessionId, 'piSessionId'),
        extensionInstanceId: requireId(proposal.extensionInstanceId, 'extensionInstanceId'),
      }
      if (committed.some((run) => run.targetTeamGoalId === teamGoalId && run.targetRole === role)) {
        throw new Error('role_occupied')
      }
      if (committed.some((run) => sameIdentity(run, identity))) {
        throw new Error('already_managed')
      }
      const roleLabel = role.slice(0, 1).toUpperCase() + role.slice(1)
      const run: CommittedAdoption = {
        proposalId: requireId(proposal.proposalId, 'proposalId'),
        proposalDigest: requireDigest(proposal.proposalDigest),
        agentRunId: agentRunIdFactory(),
        observedSessionId: identity.observedSessionId,
        executionNodeId: identity.executionNodeId,
        processIncarnationId: identity.processIncarnationId,
        piSessionId: identity.piSessionId,
        extensionInstanceId: identity.extensionInstanceId,
        targetTeamGoalId: teamGoalId,
        targetRole: role,
        controlMode: 'managed',
        piStatus: `${roleLabel} · managed`,
        terminalTitleMetadata: `Omarchestra — ${roleLabel} — managed`,
        runtimeBinding: null,
        runtimeBindingGuarantee: 'unavailable',
        committedAt: 0,
      }
      committed.push(run)
      cursor += 1
      events.push({
        sequence: cursor,
        type: 'adopted',
        proposalId: run.proposalId,
        observedSessionId: run.observedSessionId,
        agentRunId: run.agentRunId,
        targetTeamGoalId: run.targetTeamGoalId,
        targetRole: run.targetRole,
      })
      return run
    },
  }

  return {
    transaction: (operation) => {
      const committedSnapshot = committed.map((run) => ({ ...run }))
      const cursorSnapshot = cursor
      const eventsSnapshot = events.map((event) => ({ ...event }))
      try {
        const result = operation(tx)
        if (result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
          committed = committedSnapshot
          cursor = cursorSnapshot
          events = eventsSnapshot
          throw new TypeError('Adoption transaction callbacks must be synchronous')
        }
        return result
      } catch (error) {
        committed = committedSnapshot
        cursor = cursorSnapshot
        events = eventsSnapshot
        throw error
      }
    },
    snapshot: () => ({
      executionNodeId: options.executionNodeId,
      teamGoalId: options.teamGoalId,
      roles: [...options.roles],
      committedRuns: committed.map((run) => ({ ...run })),
      cursor,
      events: events.map((event) => ({ ...event })),
    }),
    close: () => {
      committed = []
      events = []
      cursor = 0
    },
  }
}

function sameIdentity(run: CommittedAdoption, identity: CommittedIdentity): boolean {
  return sameBinding(run, bindingOf(identity))
}

function sameBinding(run: CommittedAdoption, binding: BindingIdentity): boolean {
  return run.executionNodeId === binding.executionNodeId
    && run.processIncarnationId === binding.processIncarnationId
    && run.piSessionId === binding.piSessionId
    && run.extensionInstanceId === binding.extensionInstanceId
}

function requirePlainRecord(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}
