/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * live-adoption-companion.ts — the async Companion request/confirmation
 * controller. It consumes `request_adoption` and `authorize_adoption`, routes
 * them to the runner, and returns bounded `observedIntentResult` values. It
 * publishes the observer projection (managed cards are separate) from the same
 * runner snapshot.
 *
 * It performs no I/O and imports neither QML nor SQLite. Eligibility, identity,
 * expiry, and transactions remain outside QML.
 */

import { ObserverError } from './contracts.ts'
import { createInMemoryAdoptionStore } from './live-adoption-store.ts'
import {
  LiveAdoptionRunner,
  type ObservedRecord,
} from './live-adoption-runner.ts'
import { ROLES, type Role } from '../src/protocol.ts'

export interface LiveAdoptionCompanionOptions {
  executionNodeId: string
  teamGoalId: string
  roles: Role[]
  runner?: LiveAdoptionRunner
  proposalIdFactory?: () => string
  acknowledgementNonceFactory?: () => string
}

export interface ObserverIntentResult {
  session: {
    sessionId: string
    teamGoalId: string
    clientId: string
    sessionGeneration: number
    pluginGeneration: number
  }
  intentId: string
  phase: string
  code: string
  detail: string
  proposalId: string | null
  proposalDigest: string | null
  remainingMs: number | null
  displayLabel: string | null
}

const DETAIL_MAX = 1024

/**
 * Async Companion Adoption controller. It returns bounded results and never
 * lets a coordinator rejection escape as an unhandled intent.
 */
export class LiveAdoptionCompanion {
  private readonly runner: LiveAdoptionRunner
  private readonly session: ObserverIntentResult['session']

  constructor(options: LiveAdoptionCompanionOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('LiveAdoptionCompanion options are required')
    }
    const roles = requireRoles(options.roles)
    this.runner = options.runner ?? new LiveAdoptionRunner({
      store: createInMemoryAdoptionStore({
        executionNodeId: options.executionNodeId,
        teamGoalId: options.teamGoalId,
        roles,
      }),
      executionNodeId: options.executionNodeId,
      teamGoalId: options.teamGoalId,
      roles,
      proposalIdFactory: options.proposalIdFactory,
      acknowledgementNonceFactory: options.acknowledgementNonceFactory,
    })
    this.session = {
      sessionId: `companion-session-${options.teamGoalId}`,
      teamGoalId: options.teamGoalId,
      clientId: 'observer-console-client',
      sessionGeneration: 1,
      pluginGeneration: 3,
    }
  }

  /** Register a current observed session on the underlying runner. */
  registerObserved(record: ObservedRecord): void {
    this.runner.registerObserved(record)
  }

  /** Consume a Companion request_adoption intent and return a bounded result. */
  async requestAdoption(intent: {
    intentId: string
    observedSessionId: string
    choiceId: string
  }): Promise<ObserverIntentResult> {
    const intentId = requireId(intent.intentId, 'intentId')
    const observedSessionId = requireId(intent.observedSessionId, 'observedSessionId')
    const choiceId = requireId(intent.choiceId, 'choiceId')
    try {
      const proposal = await this.runner.requestAdoption(observedSessionId, choiceId)
      return {
        session: clone(this.session),
        intentId,
        phase: 'proposal',
        code: 'proposal_ready',
        detail: 'Confirm this exact current proposal.',
        proposalId: String(proposal.proposalId),
        proposalDigest: String(proposal.proposalDigest),
        remainingMs: null,
        displayLabel: `Adopt ${String(proposal.targetRole)}`,
      }
    } catch (error) {
      return failureResult(this.session, intentId, error)
    }
  }

  /** Consume a Companion authorize_adoption intent and return a bounded result. */
  async authorizeAdoption(intent: {
    intentId: string
    proposalId: string
    proposalDigest: string
  }): Promise<ObserverIntentResult> {
    const intentId = requireId(intent.intentId, 'intentId')
    const proposalId = requireId(intent.proposalId, 'proposalId')
    const proposalDigest = requireDigest(intent.proposalDigest)
    try {
      const requestAck = await this.runner.authorizeAdoption(proposalId, proposalDigest)
      return {
        session: clone(this.session),
        intentId,
        phase: 'authorized',
        code: 'ok',
        detail: 'Adoption authorized',
        proposalId,
        proposalDigest,
        remainingMs: typeof requestAck.acknowledgementRemainingMs === 'number'
          ? requestAck.acknowledgementRemainingMs
          : null,
        displayLabel: 'Awaiting same-process acknowledgement',
      }
    } catch (error) {
      return failureResult(this.session, intentId, error)
    }
  }

  /** Observer projection from the runner snapshot. */
  snapshot(): { observerRevision: number; agents: unknown[] } {
    return this.runner.snapshot()
  }

  /** Managed cards from the runner, separate from the observer projection. */
  managedSnapshot(): { managedCards: unknown[] } {
    return this.runner.managedSnapshot()
  }
}

function failureResult(
  session: ObserverIntentResult['session'],
  intentId: string,
  error: unknown,
): ObserverIntentResult {
  const code = error instanceof ObserverError ? error.code : 'invalid_envelope'
  const detail = boundedDetail(error instanceof Error ? error.message : String(error))
  return {
    session: clone(session),
    intentId,
    phase: 'failed',
    code,
    detail,
    proposalId: null,
    proposalDigest: null,
    remainingMs: null,
    displayLabel: null,
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requireRoles(input: unknown): Role[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 3) {
    throw new TypeError('roles must be a bounded non-empty array')
  }
  for (const role of input) {
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      throw new TypeError('roles must contain only allowed Roles')
    }
  }
  return [...input] as Role[]
}

function requireId(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)) {
    throw new TypeError(`${where} must be a bounded identity`)
  }
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new TypeError('proposalDigest must be exactly 64 lowercase hexadecimal characters')
  }
  return input
}

function boundedDetail(value: string): string {
  return value.length > DETAIL_MAX ? value.slice(0, DETAIL_MAX) : value
}
