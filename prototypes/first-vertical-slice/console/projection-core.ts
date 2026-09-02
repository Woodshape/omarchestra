/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Pure Agent Console projection state. The Team Runner remains authoritative:
 * this class validates its snapshot and event bodies, retains only plain card
 * values, and never derives a label from other runner or presentation fields.
 */

import {
  ROLES,
  validateEventBody,
  validateSnapshotBody,
  type EventRecord,
  type Role,
  type SnapshotBody,
} from '../src/protocol.ts'

export const PROJECTION_STATUSES = ['ready', 'reconnecting', 'gap'] as const
export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number]

export interface AgentConsoleCard {
  role: Role
  agentRunId: string
  piStatus: string
}

export interface AgentConsoleHandoff {
  status: ProjectionStatus
  cursor: number
  cards: AgentConsoleCard[]
}

export class ProjectionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionStateError'
  }
}

export class AgentConsoleProjection {
  private current: AgentConsoleHandoff | null = null
  private teamGoalId: string | null = null
  private identities = new Map<Role, string>()
  private eventIds = new Set<string>()
  private fault: string | null = null

  get handoff(): AgentConsoleHandoff | null {
    return this.current === null ? null : cloneHandoff(this.current)
  }

  get lastFault(): string | null {
    return this.fault
  }

  initialize(input: unknown): AgentConsoleHandoff {
    if (this.current !== null) {
      throw new ProjectionStateError('projection already has an authoritative snapshot')
    }
    const value = validateSnapshotBody(input)
    this.teamGoalId = value.teamGoal.id
    this.identities = identitiesFrom(value)
    this.eventIds.clear()
    this.fault = null
    this.current = handoffFrom(value, 'ready')
    return cloneHandoff(this.current)
  }

  acceptEvent(input: unknown): AgentConsoleHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before events')
    }

    let value: EventRecord
    try {
      value = validateEventBody(input)
    } catch (error) {
      return this.fail(error)
    }

    if (value.sequence <= this.current.cursor) {
      return this.fail(new ProjectionStateError(
        `duplicate or stale event sequence ${value.sequence}; current cursor is ${this.current.cursor}`,
      ))
    }
    if (value.sequence !== this.current.cursor + 1) {
      return this.fail(new ProjectionStateError(
        `event sequence gap: received ${value.sequence}, expected ${this.current.cursor + 1}`,
      ))
    }
    if (this.eventIds.has(value.eventId)) {
      return this.fail(new ProjectionStateError(`duplicate event identity ${value.eventId}`))
    }

    this.eventIds.add(value.eventId)
    this.fault = null
    this.current = {
      status: 'reconnecting',
      cursor: value.sequence,
      cards: cloneCards(this.current.cards),
    }
    return cloneHandoff(this.current)
  }

  resnapshot(input: unknown): AgentConsoleHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before resnapshot')
    }
    if (this.current.status === 'gap') {
      throw new ProjectionStateError('gap state requires explicit fresh snapshot recovery')
    }
    if (this.current.status !== 'reconnecting') {
      throw new ProjectionStateError('resnapshot requires one or more accepted ordered events')
    }

    let value: SnapshotBody
    try {
      value = validateSnapshotBody(input)
      this.assertIdentityBaseline(value)
      if (value.cursor !== this.current.cursor) {
        throw new ProjectionStateError(
          `resnapshot cursor ${value.cursor} does not equal accepted event cursor ${this.current.cursor}`,
        )
      }
    } catch (error) {
      return this.fail(error)
    }

    this.fault = null
    this.current = handoffFrom(value, 'ready')
    return cloneHandoff(this.current)
  }

  markGap(reason: string): AgentConsoleHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before marking a gap')
    }
    const detail = String(reason).trim()
    this.fault = detail || 'projection history gap'
    this.current = {
      status: 'gap',
      cursor: this.current.cursor,
      cards: cloneCards(this.current.cards),
    }
    return cloneHandoff(this.current)
  }

  recover(input: unknown): AgentConsoleHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative baseline is required before gap recovery')
    }
    if (this.current.status !== 'gap') {
      throw new ProjectionStateError('fresh snapshot recovery is permitted only from gap state')
    }

    let value: SnapshotBody
    try {
      value = validateSnapshotBody(input)
      this.assertIdentityBaseline(value)
      if (value.cursor < this.current.cursor) {
        throw new ProjectionStateError(
          `fresh snapshot cursor ${value.cursor} is older than accepted cursor ${this.current.cursor}`,
        )
      }
    } catch (error) {
      return this.fail(error)
    }

    this.eventIds.clear()
    this.fault = null
    this.current = handoffFrom(value, 'ready')
    return cloneHandoff(this.current)
  }

  private assertIdentityBaseline(value: SnapshotBody): void {
    if (value.teamGoal.id !== this.teamGoalId) {
      throw new ProjectionStateError(
        `snapshot Team Goal identity ${value.teamGoal.id} does not match ${String(this.teamGoalId)}`,
      )
    }
    for (const role of ROLES) {
      const candidate = value.roles.find((entry) => entry.role === role)
      const expected = this.identities.get(role)
      if (candidate === undefined || expected === undefined || candidate.agentRunId !== expected) {
        throw new ProjectionStateError(`stale role/Agent Run identity for ${role}`)
      }
    }
  }

  private fail(error: unknown): never {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (this.current !== null) {
      this.fault = normalized.message
      this.current = {
        status: 'gap',
        cursor: this.current.cursor,
        cards: cloneCards(this.current.cards),
      }
    }
    throw normalized
  }
}

function identitiesFrom(value: SnapshotBody): Map<Role, string> {
  return new Map(value.roles.map((entry) => [entry.role, entry.agentRunId]))
}

function handoffFrom(value: SnapshotBody, status: ProjectionStatus): AgentConsoleHandoff {
  const cards = ROLES.map((role) => {
    const entry = value.roles.find((candidate) => candidate.role === role)
    if (entry === undefined) {
      throw new ProjectionStateError(`validated snapshot is missing role ${role}`)
    }
    return {
      role: entry.role,
      agentRunId: entry.agentRunId,
      piStatus: entry.piStatus,
    }
  })
  return { status, cursor: value.cursor, cards }
}

function cloneCards(cards: readonly AgentConsoleCard[]): AgentConsoleCard[] {
  return cards.map((card) => ({ ...card }))
}

function cloneHandoff(value: AgentConsoleHandoff): AgentConsoleHandoff {
  return {
    status: value.status,
    cursor: value.cursor,
    cards: cloneCards(value.cards),
  }
}
