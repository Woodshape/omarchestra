/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * telemetry-policy.ts — the privacy allow-list for the observer/Adoption
 * milestone. This module converts allow-listed same-process lifecycle facts
 * into the authoritative observed record and the bounded Companion projection,
 * and rejects forbidden or unbounded fields BEFORE they cross the observer
 * seam. It performs no I/O and imports neither Adoption nor QML (it consumes
 * the pure observer protocol types in `contracts.ts`).
 *
 * The P0–P4 privacy classification is locked in docs/observer-adoption-v1.md.
 */

import {
  ObserverError,
  OBSERVER_ACTIVITY_VALUES,
  OBSERVER_AVAILABILITY_VALUES,
  OBSERVER_HEALTH_VALUES,
  OBSERVER_LIFECYCLE_VALUES,
  OBSERVER_PI_STATUS_LOCAL,
  type ObserverActivity,
  type ObserverAvailability,
  type ObserverHealth,
  type ObserverLifecycle,
} from './contracts.ts'

/** Fact keys the observer may legitimately carry into the observed record. */
export const OBSERVER_ALLOWED_FACT_KEYS = Object.freeze([
  'observedSessionId',
  'executionNodeId',
  'processIncarnationId',
  'piSessionId',
  'extensionInstanceId',
  'lifecycle',
  'activity',
  'availability',
  'health',
  'registryRevision',
] as const)

export const OBSERVER_PROJECTION_FIELDS = Object.freeze([
  'observerRevision',
  'observedSessionId',
  'piStatus',
  'lifecycle',
  'availability',
  'health',
  'choices',
] as const)

/** Any single allow-listed value may be at most this many UTF-8 bytes. */
export const OBSERVER_FACT_VALUE_BOUND = Object.freeze({ bytes: 512 })

const IDENTITY_KEYS = new Set(['observedSessionId', 'executionNodeId', 'processIncarnationId', 'piSessionId', 'extensionInstanceId'])

export interface ObservedRecord {
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  lifecycle: ObserverLifecycle
  activity: ObserverActivity
  availability: ObserverAvailability
  health: ObserverHealth
  registryRevision: number
  piStatus: typeof OBSERVER_PI_STATUS_LOCAL
}

export interface ObservedChoice {
  choiceId: string
  label: string
  enabled: boolean
}

export interface ObservedProjectionAgent {
  observedSessionId: string
  piStatus: typeof OBSERVER_PI_STATUS_LOCAL
  lifecycle: ObserverLifecycle
  availability: ObserverAvailability
  health: ObserverHealth
  choices: ObservedChoice[]
}

export interface ObservedProjection {
  observerRevision: number
  agents: ObservedProjectionAgent[]
}

/**
 * Structural privacy guard. Rejects any field that is not an allow-listed
 * fact (prompts, responses, thinking, tool arguments/results, terminal
 * output, repository content, credentials, cwd, titles, focus, recency,
 * display names, model/provider data, environment values, raw errors, and any
 * unknown key) and rejects unbounded values. Throws before the value can be
 * persisted, logged, emitted, or projected.
 */
export function assertPrivacySafe(facts: Record<string, unknown>): void {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)
    || (Object.getPrototypeOf(facts) !== Object.prototype && Object.getPrototypeOf(facts) !== null)) {
    throw new ObserverError('privacy_violation', 'telemetry facts must be a plain object')
  }
  for (const [key, value] of Object.entries(facts)) {
    if (!(OBSERVER_ALLOWED_FACT_KEYS as readonly string[]).includes(key)) {
      throw new ObserverError('privacy_violation', 'telemetry contains a non-allow-listed fact')
    }
    if (typeof value === 'string' && utf8Bytes(value) > OBSERVER_FACT_VALUE_BOUND.bytes) {
      throw new ObserverError('invalid_envelope', 'telemetry fact exceeds the bounded value size')
    }
    if (IDENTITY_KEYS.has(key)) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        throw new ObserverError('invalid_envelope', 'telemetry identity must be a bounded ASCII identity')
      }
      continue
    }
    switch (key) {
      case 'lifecycle': assertLifecycleValue(value); break
      case 'activity': assertActivityValue(value); break
      case 'availability': assertAvailabilityValue(value); break
      case 'health': assertHealthValue(value); break
      case 'registryRevision': assertRevision(value); break
    }
  }
}

function assertLifecycleValue(value: unknown): ObserverLifecycle {
  if (typeof value !== 'string' || !(OBSERVER_LIFECYCLE_VALUES as readonly string[]).includes(value)) {
    throw new ObserverError('invalid_envelope', `lifecycle must be one of ${OBSERVER_LIFECYCLE_VALUES.join(', ')}`)
  }
  return value as ObserverLifecycle
}

function assertActivityValue(value: unknown): ObserverActivity {
  if (typeof value !== 'string' || !(OBSERVER_ACTIVITY_VALUES as readonly string[]).includes(value)) {
    throw new ObserverError('invalid_envelope', `activity must be one of ${OBSERVER_ACTIVITY_VALUES.join(', ')}`)
  }
  return value as ObserverActivity
}

function assertAvailabilityValue(value: unknown): ObserverAvailability {
  if (typeof value !== 'string' || !(OBSERVER_AVAILABILITY_VALUES as readonly string[]).includes(value)) {
    throw new ObserverError('invalid_envelope', `availability must be one of ${OBSERVER_AVAILABILITY_VALUES.join(', ')}`)
  }
  return value as ObserverAvailability
}

function assertHealthValue(value: unknown): ObserverHealth {
  if (typeof value !== 'string' || !(OBSERVER_HEALTH_VALUES as readonly string[]).includes(value)) {
    throw new ObserverError('invalid_envelope', `health must be one of ${OBSERVER_HEALTH_VALUES.join(', ')}`)
  }
  return value as ObserverHealth
}

function assertRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new ObserverError('invalid_envelope', 'registryRevision must be a non-negative safe integer')
  }
  return value
}

/**
 * Build the authoritative observed record from exactly the allow-listed facts.
 * The record contains lifecycle, activity, availability, health, identity, and
 * revision only, with no management or authority field. `piStatus` is exactly
 * `Unassigned · observed`.
 */
export function buildObservedRecord(input: Record<string, unknown>): ObservedRecord {
  assertPrivacySafe(input)
  const actual = Object.keys(input).sort()
  const expected = [...OBSERVER_ALLOWED_FACT_KEYS].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new ObserverError('invalid_envelope', 'observed record input must contain exactly the allow-listed facts')
  }
  return {
    observedSessionId: input.observedSessionId as string,
    executionNodeId: input.executionNodeId as string,
    processIncarnationId: input.processIncarnationId as string,
    piSessionId: input.piSessionId as string,
    extensionInstanceId: input.extensionInstanceId as string,
    lifecycle: assertLifecycleValue(input.lifecycle),
    activity: assertActivityValue(input.activity),
    availability: assertAvailabilityValue(input.availability),
    health: assertHealthValue(input.health),
    registryRevision: assertRevision(input.registryRevision),
    piStatus: OBSERVER_PI_STATUS_LOCAL,
  }
}

/**
 * Project the bounded Companion-visible observer data. Only the minimum
 * current intent-correlation values enter the projection; process, Pi-session,
 * extension, connection, challenge, PID, and Node identity never do.
 */
export function projectObserved(record: ObservedRecord): ObservedProjection {
  const agent: ObservedProjectionAgent = {
    observedSessionId: record.observedSessionId,
    piStatus: record.piStatus,
    lifecycle: record.lifecycle,
    availability: record.availability,
    health: record.health,
    choices: [],
  }
  return {
    observerRevision: record.registryRevision,
    agents: [agent],
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
