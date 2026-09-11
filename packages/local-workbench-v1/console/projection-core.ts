/**
 * Local Workbench v1 — Phase 1 pure projection state machine.
 *
 * Validates authoritative snapshots and ordered events, retains only plain
 * committed values, and never derives a label from other fields. The runner
 * remains the sole authority; this class only tracks presentation state.
 *
 * Rules (contract C4 / T7):
 *   - a new session begins with a full snapshot;
 *   - events must advance cursor by exactly one and match baseRevision/epoch;
 *   - exact duplicates are ignored; same cursor/ID with different payload
 *     rejects and forces a resnapshot (gap);
 *   - gaps, regression, epoch changes and publication failures latch stale
 *     until a fresh validated snapshot;
 *   - no merging of old identity into a new snapshot.
 */

import {
  validateEvent,
  validateSnapshot,
  type WorkbenchConnection,
  type WorkbenchEvent,
  type WorkbenchHandoff,
  type WorkbenchSnapshot,
} from './schema.ts'

export class ProjectionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionStateError'
  }
}

export class WorkbenchProjection {
  private current: WorkbenchHandoff | null = null
  private sessionId: string | null = null
  private runnerEpoch: number | null = null
  private eventIds = new Map<string, string>()
  private fault: string | null = null

  get handoff(): WorkbenchHandoff | null {
    return this.current === null ? null : cloneHandoff(this.current)
  }

  get lastFault(): string | null {
    return this.fault
  }

  /** Establish the authoritative baseline from a validated snapshot. */
  initialize(input: unknown): WorkbenchHandoff {
    if (this.current !== null) {
      throw new ProjectionStateError('projection already has an authoritative snapshot')
    }
    let value: WorkbenchSnapshot
    try {
      value = validateSnapshot(input)
    } catch (error) {
      throw new ProjectionStateError(error instanceof Error ? error.message : String(error))
    }
    this.sessionId = value.sessionId
    this.runnerEpoch = value.runnerEpoch
    this.eventIds.clear()
    this.fault = null
    this.current = handoffFrom(value, value.connection)
    return cloneHandoff(this.current)
  }

  /** Apply one ordered event; rejects gaps, regression, and epoch changes. */
  acceptEvent(input: unknown): WorkbenchHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before events')
    }
    if (this.current.connection === 'gap') throw new ProjectionStateError('gap requires fresh snapshot')
    let value: WorkbenchEvent
    try {
      value = validateEvent(input)
    } catch (error) {
      return this.fail(error)
    }
    if (value.sessionId !== this.sessionId) {
      return this.fail(new ProjectionStateError('event session does not match the projection session'))
    }
    if (value.runnerEpoch !== this.runnerEpoch) {
      return this.fail(new ProjectionStateError('event runner epoch does not match the projection epoch'))
    }
    if (value.cursor <= this.current.cursor) {
      // Exact duplicate: same cursor/ID/content is ignored.
      if (value.cursor === this.current.cursor && this.eventIds.get(value.eventId) === JSON.stringify(value)) {
        return cloneHandoff(this.current)
      }
      return this.fail(new ProjectionStateError(
        `duplicate or stale event sequence ${value.cursor}; current cursor is ${this.current.cursor}`,
      ))
    }
    if (value.cursor !== this.current.cursor + 1) {
      return this.fail(new ProjectionStateError(
        `event sequence gap: received ${value.cursor}, expected ${this.current.cursor + 1}`,
      ))
    }
    if (value.baseRevision !== this.current.revision) {
      return this.fail(new ProjectionStateError(
        `event baseRevision ${value.baseRevision} does not match current revision ${this.current.revision}`,
      ))
    }
    if (this.eventIds.has(value.eventId)) {
      return this.fail(new ProjectionStateError(`duplicate event identity ${value.eventId}`))
    }
    if (value.revision <= this.current.revision) return this.fail(new ProjectionStateError('event revision must advance'))
    this.eventIds.set(value.eventId, JSON.stringify(value))
    this.fault = null
    this.current = {
      connection: 'connected',
      revision: value.revision,
      cursor: value.cursor,
      snapshot: { ...this.current.snapshot, revision: value.revision, cursor: value.cursor },
      fault: null,
    }
    return cloneHandoff(this.current)
  }

  /** Latch stale/gap state until a fresh authoritative snapshot. */
  markGap(reason: string): WorkbenchHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before marking a gap')
    }
    const detail = String(reason).trim()
    this.fault = detail || 'projection history gap'
    this.current = {
      connection: 'gap',
      revision: this.current.revision,
      cursor: this.current.cursor,
      snapshot: this.current.snapshot,
      fault: this.fault,
    }
    return cloneHandoff(this.current)
  }

  /**
   * Atomically replace the projection with a fresh validated snapshot.
   * Allowed from any non-gap state (connected/stale/reconnecting). This is
   * the contract C4 "snapshot updates may replace full collections
   * atomically" path. A session/epoch change is a new authoritative
   * baseline; no old identity is merged in.
   */
  replace(input: unknown): WorkbenchHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative snapshot is required before replacement')
    }
    if (this.current.connection === 'gap') {
      throw new ProjectionStateError('gap state requires explicit fresh snapshot recovery')
    }
    let value: WorkbenchSnapshot
    try {
      value = validateSnapshot(input)
      if (value.sessionId === this.sessionId && value.runnerEpoch === this.runnerEpoch && (value.cursor < this.current.cursor || value.revision < this.current.revision)) {
        throw new ProjectionStateError(
          `replacement snapshot cursor ${value.cursor} is older than accepted cursor ${this.current.cursor}`,
        )
      }
    } catch (error) {
      return this.fail(error)
    }
    this.sessionId = value.sessionId
    this.runnerEpoch = value.runnerEpoch
    this.eventIds.clear()
    this.fault = null
    this.current = handoffFrom(value, value.connection)
    return cloneHandoff(this.current)
  }

  /** Recover from gap state with a fresh validated snapshot. */
  recover(input: unknown): WorkbenchHandoff {
    if (this.current === null) {
      throw new ProjectionStateError('an authoritative baseline is required before gap recovery')
    }
    if (this.current.connection !== 'gap') {
      throw new ProjectionStateError('fresh snapshot recovery is permitted only from gap state')
    }
    let value: WorkbenchSnapshot
    try {
      value = validateSnapshot(input)
      if (value.sessionId === this.sessionId && value.runnerEpoch === this.runnerEpoch && (value.cursor < this.current.cursor || value.revision < this.current.revision)) {
        throw new ProjectionStateError(
          `fresh snapshot cursor ${value.cursor} is older than accepted cursor ${this.current.cursor}`,
        )
      }
    } catch (error) {
      return this.fail(error)
    }
    this.sessionId = value.sessionId
    this.runnerEpoch = value.runnerEpoch
    this.eventIds.clear()
    this.fault = null
    this.current = handoffFrom(value, value.connection)
    return cloneHandoff(this.current)
  }

  /** Clear all ephemeral state so the next snapshot can initialize fresh. */
  clearState(): void {
    this.current = null
    this.sessionId = null
    this.runnerEpoch = null
    this.eventIds.clear()
    this.fault = null
  }

  private fail(error: unknown): never {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (this.current !== null) {
      this.fault = normalized.message
      this.current = {
        connection: 'gap',
        revision: this.current.revision,
        cursor: this.current.cursor,
        snapshot: this.current.snapshot,
        fault: this.fault,
      }
    }
    throw normalized
  }
}

function handoffFrom(value: WorkbenchSnapshot, connection: WorkbenchConnection): WorkbenchHandoff {
  return {
    connection,
    revision: value.revision,
    cursor: value.cursor,
    snapshot: value,
    fault: null,
  }
}

function cloneHandoff(value: WorkbenchHandoff): WorkbenchHandoff {
  return {
    connection: value.connection,
    revision: value.revision,
    cursor: value.cursor,
    snapshot: structuredClone(value.snapshot),
    fault: value.fault,
  }
}
