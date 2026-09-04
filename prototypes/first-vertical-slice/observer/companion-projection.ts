/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * companion-projection.ts — the additive Companion observer projection
 * adapter. It combines the unchanged managed Agent Console handoff with a
 * bounded authoritative Unassigned Agents projection, and routes the
 * request-proposal and authorize-exact-proposal intents to the observer port.
 *
 * This module is separate from AgentConsoleHandoff, its three managed cards,
 * the Team Runner cursor, LiveProjectionAdapter, and present_agent. It
 * performs no I/O and imports neither QML nor installation modules. Eligibility,
 * expiry, identity checks, deduplication, and authority remain outside QML.
 */

import { isBoundedId } from '../src/protocol.ts'
import { CompanionError, type ProjectionSessionIdentity } from '../companion/contracts.ts'

export const OBSERVER_PROJECTION_MAX_AGENTS = 64
export const OBSERVER_PROJECTION_MAX_CHOICES = 16
export const OBSERVER_INTENT_REMAINING_MS_MAX = 30_000
export const OBSERVER_INTENT_DETAIL_MAX = 1024
export const OBSERVER_INTENT_LABEL_MAX = 512

export const EMPTY_OBSERVER_PROJECTION = Object.freeze({
  observerRevision: 0,
  agents: [],
})

export interface ObservedChoice {
  choiceId: string
  label: string
  enabled: boolean
}

export interface ObservedAgent {
  observedSessionId: string
  piStatus: string
  lifecycle: string
  availability: string
  health: string
  choices: ObservedChoice[]
}

export interface ObserverProjectionSnapshot {
  observerRevision: number
  agents: ObservedAgent[]
}

export interface ObserverIntentResult {
  session: ProjectionSessionIdentity
  intentId: string
  phase: string
  code: string
  detail: string
  proposalId: string
  proposalDigest: string
  remainingMs: number | null
  displayLabel: string
}

export interface ObserverPort {
  snapshot(): unknown
  subscribe(listener: (value: unknown) => void): () => void
  submitIntent(intent: Record<string, unknown>): unknown
}

export interface CompanionObserverProjectionAdapterOptions {
  session: ProjectionSessionIdentity
  observer: ObserverPort
  sink?: (value: unknown) => void
  resultSink?: (value: unknown) => void
}

const SESSION_FIELDS = ['sessionId', 'teamGoalId', 'clientId', 'sessionGeneration', 'pluginGeneration'] as const
const AGENT_FIELDS = ['observedSessionId', 'piStatus', 'lifecycle', 'availability', 'health', 'choices'] as const
const CHOICE_FIELDS = ['choiceId', 'label', 'enabled'] as const
const RESULT_FIELDS = [
  'session', 'intentId', 'phase', 'code', 'detail', 'proposalId', 'proposalDigest',
  'remainingMs', 'displayLabel',
] as const

export function validateObserverProjectionSnapshot(input: unknown): ObserverProjectionSnapshot {
  const value = plainObject(input, 'observer projection snapshot')
  exactKeys(value, ['observerRevision', 'agents'], 'observer projection snapshot')
  const observerRevision = requireNonNegativeInt(value.observerRevision, 'observerRevision')
  if (!Array.isArray(value.agents) || value.agents.length > OBSERVER_PROJECTION_MAX_AGENTS) {
    throw new CompanionError('invalid_envelope', `observer projection agents must be a bounded array of at most ${OBSERVER_PROJECTION_MAX_AGENTS}`)
  }
  const agents = value.agents.map((agentInput, index) => {
    const agent = plainObject(agentInput, `observer agent ${index}`)
    exactKeys(agent, AGENT_FIELDS, `observer agent ${index}`)
    const piStatus = requireBoundedText(agent.piStatus, `observer agent ${index} piStatus`, 512)
    if (piStatus !== 'Unassigned · observed') {
      throw new CompanionError('invalid_envelope', `observer agent ${index} piStatus must be exactly "Unassigned · observed"`)
    }
    const lifecycle = requireEnum(agent.lifecycle, ['running', 'exited'], `observer agent ${index} lifecycle`)
    const availability = requireEnum(agent.availability, ['available', 'unavailable'], `observer agent ${index} availability`)
    const health = requireEnum(agent.health, ['healthy', 'degraded'], `observer agent ${index} health`)
    if (!Array.isArray(agent.choices) || agent.choices.length > OBSERVER_PROJECTION_MAX_CHOICES) {
      throw new CompanionError('invalid_envelope', `observer agent ${index} choices must be a bounded array`)
    }
    const choices = agent.choices.map((choiceInput, choiceIndex) => {
      const choice = plainObject(choiceInput, `observer agent ${index} choice ${choiceIndex}`)
      exactKeys(choice, CHOICE_FIELDS, `observer agent ${index} choice ${choiceIndex}`)
      return {
        choiceId: requireId(choice.choiceId, `observer agent ${index} choice ${choiceIndex} choiceId`),
        label: requireBoundedText(choice.label, `observer agent ${index} choice ${choiceIndex} label`, 512),
        enabled: requireBoolean(choice.enabled, `observer agent ${index} choice ${choiceIndex} enabled`),
      }
    })
    return {
      observedSessionId: requireId(agent.observedSessionId, `observer agent ${index} observedSessionId`),
      piStatus,
      lifecycle,
      availability,
      health,
      choices,
    }
  })
  return { observerRevision, agents }
}

export function validateObserverIntentResult(input: unknown): ObserverIntentResult {
  const value = plainObject(input, 'observer intent result')
  exactKeys(value, RESULT_FIELDS, 'observer intent result')
  const session = validateSessionIdentity(value.session)
  const remainingMs = value.remainingMs === null
    ? null
    : requireNonNegativeInt(value.remainingMs, 'remainingMs')
  if (remainingMs !== null && remainingMs > OBSERVER_INTENT_REMAINING_MS_MAX) {
    throw new CompanionError('invalid_envelope', `observer intent remainingMs exceeds ${OBSERVER_INTENT_REMAINING_MS_MAX}`)
  }
  return {
    session,
    intentId: requireId(value.intentId, 'intentId'),
    phase: requireBoundedText(value.phase, 'phase', 64),
    code: requireBoundedText(value.code, 'code', 64),
    detail: requireBoundedText(value.detail, 'detail', OBSERVER_INTENT_DETAIL_MAX),
    proposalId: requireId(value.proposalId, 'proposalId'),
    proposalDigest: requireDigest(value.proposalDigest),
    remainingMs,
    displayLabel: requireBoundedText(value.displayLabel, 'displayLabel', OBSERVER_INTENT_LABEL_MAX),
  }
}

export function validateSessionIdentity(input: unknown): ProjectionSessionIdentity {
  const value = plainObject(input, 'Projection Session identity')
  exactKeys(value, SESSION_FIELDS, 'Projection Session identity')
  return {
    sessionId: requireId(value.sessionId, 'sessionId'),
    teamGoalId: requireId(value.teamGoalId, 'teamGoalId'),
    clientId: requireId(value.clientId, 'clientId'),
    sessionGeneration: requirePositiveInt(value.sessionGeneration, 'sessionGeneration'),
    pluginGeneration: requirePositiveInt(value.pluginGeneration, 'pluginGeneration'),
  }
}

/**
 * Additive Companion observer projection adapter. It owns only the bounded
 * Unassigned Agents projection and the request/authorize Adoption intents; it
 * never derives eligibility, expiry, identity, or authority.
 */
export class CompanionObserverProjectionAdapter {
  private readonly session: ProjectionSessionIdentity
  private readonly observer: ObserverPort
  private readonly sink: ((value: unknown) => void) | null
  private readonly resultSink: ((value: unknown) => void) | null
  private currentValue: ObserverProjectionSnapshot | null = null
  private unsubscribe: (() => void) | null = null

  constructor(options: CompanionObserverProjectionAdapterOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('Companion observer projection adapter options are required')
    }
    this.session = validateSessionIdentity(options.session)
    this.observer = requirePort(options.observer, 'observer')
    this.sink = options.sink ?? null
    this.resultSink = options.resultSink ?? null
  }

  get current(): ObserverProjectionSnapshot | null {
    return this.currentValue === null ? null : clone(this.currentValue)
  }

  async start(): Promise<void> {
    const snapshot = validateObserverProjectionSnapshot(this.observer.snapshot())
    this.currentValue = clone(snapshot)
    this.sink?.(clone(snapshot))
    this.unsubscribe = this.observer.subscribe((value) => {
      const validated = validateObserverProjectionSnapshot(value)
      if (this.currentValue !== null && validated.observerRevision <= this.currentValue.observerRevision) {
        return
      }
      this.currentValue = clone(validated)
      this.sink?.(clone(validated))
    })
  }

  acceptSnapshot(session: unknown, snapshot: unknown): void {
    this.assertSessionCurrent(session)
    const validated = validateObserverProjectionSnapshot(snapshot)
    if (this.currentValue !== null && validated.observerRevision <= this.currentValue.observerRevision) {
      throw new CompanionError('stale_projection_session', `observer revision ${validated.observerRevision} is not greater than the current revision ${this.currentValue.observerRevision}`)
    }
    this.currentValue = clone(validated)
    this.sink?.(clone(validated))
  }

  async submitIntent(session: unknown, intent: unknown): Promise<ObserverIntentResult> {
    this.assertSessionCurrent(session)
    const forwarded = validateObserverIntent(intent)
    const result = validateObserverIntentResult(this.observer.submitIntent(forwarded))
    this.resultSink?.(clone(result))
    return clone(result)
  }

  stop(): void {
    if (this.unsubscribe !== null) {
      const unsubscribe = this.unsubscribe
      this.unsubscribe = null
      unsubscribe()
    }
    this.currentValue = null
  }

  private assertSessionCurrent(session: unknown): void {
    const candidate = validateSessionIdentity(session)
    const expected = this.session
    if (candidate.sessionId !== expected.sessionId
        || candidate.teamGoalId !== expected.teamGoalId
        || candidate.clientId !== expected.clientId
        || candidate.sessionGeneration !== expected.sessionGeneration
        || candidate.pluginGeneration !== expected.pluginGeneration) {
      throw new CompanionError('stale_projection_session', 'the Projection Session identity is not current')
    }
  }
}

function validateObserverIntent(input: unknown): Record<string, unknown> {
  const value = plainObject(input, 'observer intent')
  const kind = value.kind
  if (kind === 'request_adoption') {
    exactKeys(value, ['intentId', 'kind', 'observedSessionId', 'choiceId'], 'request_adoption intent')
    return {
      intentId: requireId(value.intentId, 'intentId'),
      kind: 'request_adoption',
      observedSessionId: requireId(value.observedSessionId, 'observedSessionId'),
      choiceId: requireId(value.choiceId, 'choiceId'),
    }
  }
  if (kind === 'authorize_adoption') {
    exactKeys(value, ['intentId', 'kind', 'proposalId', 'proposalDigest'], 'authorize_adoption intent')
    return {
      intentId: requireId(value.intentId, 'intentId'),
      kind: 'authorize_adoption',
      proposalId: requireId(value.proposalId, 'proposalId'),
      proposalDigest: requireDigest(value.proposalDigest),
    }
  }
  throw new CompanionError('invalid_intent', `unsupported observer intent kind ${String(kind)}`)
}

function requirePort<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new TypeError(`${name} port is required`)
  }
  return value
}

function plainObject(input: unknown, where: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CompanionError('invalid_envelope', `${where} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CompanionError('invalid_envelope', `${where} must be a plain object`)
  }
  return input as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CompanionError('invalid_envelope', `${where} contains an unsupported field`)
  }
}

function requireId(input: unknown, where: string): string {
  if (!isBoundedId(input)) throw new CompanionError('invalid_envelope', `${where} is not a bounded identity`)
  return input
}

function requireDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) {
    throw new CompanionError('invalid_envelope', `${String(input)} is not a lowercase SHA-256 digest`)
  }
  return input
}

function requireBoundedText(input: unknown, where: string, maxCharacters: number): string {
  if (typeof input !== 'string' || input.length === 0 || [...input].length > maxCharacters) {
    throw new CompanionError('invalid_envelope', `${where} is not bounded text of at most ${maxCharacters} characters`)
  }
  return input
}

function requireNonNegativeInt(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0 || input > Number.MAX_SAFE_INTEGER) {
    throw new CompanionError('invalid_envelope', `${where} must be a non-negative safe integer`)
  }
  return input
}

function requirePositiveInt(input: unknown, where: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1 || input > Number.MAX_SAFE_INTEGER) {
    throw new CompanionError('invalid_envelope', `${where} must be a positive safe integer`)
  }
  return input
}

function requireBoolean(input: unknown, where: string): boolean {
  if (typeof input !== 'boolean') throw new CompanionError('invalid_envelope', `${where} must be a boolean`)
  return input
}

function requireEnum<T extends string>(input: unknown, choices: readonly T[], where: string): T {
  if (typeof input !== 'string' || !(choices as readonly string[]).includes(input)) {
    throw new CompanionError('invalid_envelope', `${where} must be one of ${choices.join(', ')}`)
  }
  return input as T
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    throw new CompanionError('invalid_envelope', 'observer projection data must be finite cloneable values')
  }
}
