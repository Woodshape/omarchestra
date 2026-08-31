import { mkdir, lstat, open, readFile, rename, unlink } from "node:fs/promises"
import path from "node:path"

import { requireCondition, spikeError } from "./errors.mjs"
import {
  ASSIGNMENT_ACK_STATUSES,
  ASSIGNMENT_STATES,
  CONTROL_MODES,
  EVENT_TYPES,
  ROLES,
  assertProtocolId,
  assertProtocolUuid,
  validateTelemetry
} from "./protocol.mjs"
import { validateAbsolutePath, validateOpaqueId, validateRole } from "./validation.mjs"

export const RUNNER_STATE_SCHEMA = "omarchestra.remote-execution-node.runner-state/v1"
export const ARTIFACT_SCHEMA = "omarchestra.remote-execution-node.artifact/v1"

const ROLE_SET = new Set(ROLES)
const ASSIGNMENT_STATE_SET = new Set(ASSIGNMENT_STATES)
const CONTROL_MODE_SET = new Set(CONTROL_MODES)
const EVENT_TYPE_SET = new Set(EVENT_TYPES)
const ACK_STATUS_SET = new Set(ASSIGNMENT_ACK_STATUSES)
const clone = value => structuredClone(value)

function exactKeys(value, expected, optionalOrLabel = [], maybeLabel = undefined) {
  const optional = typeof optionalOrLabel === "string" ? [] : optionalOrLabel
  const label = typeof optionalOrLabel === "string" ? optionalOrLabel : maybeLabel
  const allowed = new Set([...expected, ...optional])
  requireCondition(Object.keys(value).every(key => allowed.has(key))
    && expected.every(key => Object.hasOwn(value, key)),
  "invalid_runner_state", `${label ?? "value"} contains missing or unknown fields`)
}

function plainObject(value, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_runner_state", `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  requireCondition(prototype === Object.prototype || prototype === null,
    "invalid_runner_state", `${label} must be a plain object`)
  return value
}

function timestamp(value, label) {
  requireCondition(Number.isSafeInteger(value) && value >= 0,
    "invalid_runner_state", `${label} must be a non-negative safe integer`)
}

function nullableId(value, label) {
  if (value !== null) assertProtocolId(value, label)
}

function nullablePositiveInteger(value, label) {
  requireCondition(value === null || Number.isSafeInteger(value) && value > 0,
    "invalid_runner_state", `${label} is invalid`)
}

function validateBinding(value, role) {
  plainObject(value, `${role} binding`)
  exactKeys(value, ["role", "agentRunId", "shellId", "shellRunId"], `${role} binding`)
  requireCondition(value.role === role, "invalid_runner_state", `${role} binding role does not match`)
  validateRole(role)
  assertProtocolUuid(value.agentRunId, `${role} Agent Run ID`)
  validateOpaqueId(value.shellId, `${role} Shell ID`)
  nullableId(value.shellRunId, `${role} Shell Run ID`)
}

function validateBridge(value, role) {
  plainObject(value, `${role} bridge`)
  exactKeys(value, [
    "role", "agentRunId", "shellId", "connectionState", "connectionId", "piSessionId",
    "extensionInstanceId", "pid", "controlMode", "assignmentId", "lastBridgeSequence",
    "lastEventId", "connectionCount", "connectedAtMs", "disconnectedAtMs"
  ], `${role} bridge`)
  requireCondition(value.role === role, "invalid_runner_state", `${role} bridge role does not match`)
  assertProtocolUuid(value.agentRunId, `${role} bridge Agent Run ID`)
  validateOpaqueId(value.shellId, `${role} bridge Shell ID`)
  requireCondition(value.connectionState === "connected" || value.connectionState === "disconnected",
    "invalid_runner_state", `${role} bridge connection state is invalid`)
  nullableId(value.connectionId, `${role} connection ID`)
  nullableId(value.piSessionId, `${role} Pi session ID`)
  nullableId(value.extensionInstanceId, `${role} extension instance ID`)
  nullablePositiveInteger(value.pid, `${role} bridge PID`)
  requireCondition(CONTROL_MODE_SET.has(value.controlMode),
    "invalid_runner_state", `${role} control mode is invalid`)
  nullableId(value.assignmentId, `${role} bridge assignment ID`)
  requireCondition(Number.isSafeInteger(value.lastBridgeSequence) && value.lastBridgeSequence >= 0,
    "invalid_runner_state", `${role} last bridge sequence is invalid`)
  nullableId(value.lastEventId, `${role} last bridge event ID`)
  requireCondition(Number.isSafeInteger(value.connectionCount) && value.connectionCount >= 0,
    "invalid_runner_state", `${role} connection count is invalid`)
  for (const [field, item] of [["connectedAtMs", value.connectedAtMs], ["disconnectedAtMs", value.disconnectedAtMs]]) {
    if (item !== null) timestamp(item, `${role} ${field}`)
  }
}

function validateAck(value, label) {
  if (value === null) return
  plainObject(value, label)
  exactKeys(value, ["status", "timestamp"], ["reason"], label)
  requireCondition(ACK_STATUS_SET.has(value.status), "invalid_runner_state", `${label} status is invalid`)
  timestamp(value.timestamp, `${label} timestamp`)
  if (Object.hasOwn(value, "reason")) {
    requireCondition(typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 1_024,
      "invalid_runner_state", `${label} reason is invalid`)
  }
}

function validateAssignment(value) {
  plainObject(value, "assignment")
  exactKeys(value, [
    "assignmentId", "role", "prompt", "state", "issuedAtMs", "updatedAtMs", "lastAck", "deliveryCount"
  ], "assignment")
  assertProtocolId(value.assignmentId, "assignment ID")
  requireCondition(ROLE_SET.has(value.role), "invalid_runner_state", "assignment role is invalid")
  requireCondition(typeof value.prompt === "string" && value.prompt.length > 0 && value.prompt.length <= 16_384
    && !/[\0\r\n]/.test(value.prompt), "invalid_runner_state", "assignment prompt is invalid")
  requireCondition(ASSIGNMENT_STATE_SET.has(value.state), "invalid_runner_state", "assignment state is invalid")
  timestamp(value.issuedAtMs, "assignment issuedAtMs")
  timestamp(value.updatedAtMs, "assignment updatedAtMs")
  validateAck(value.lastAck, "assignment acknowledgement")
  requireCondition(Number.isSafeInteger(value.deliveryCount) && value.deliveryCount >= 0,
    "invalid_runner_state", "assignment deliveryCount is invalid")
}

function validateEvent(value) {
  plainObject(value, "runner event")
  exactKeys(value, [
    "sequence", "cursor", "role", "eventId", "sourceEventId", "sourceSequence", "eventType",
    "assignmentId", "timestamp", "data", "gapBefore"
  ], "runner event")
  assertProtocolId(value.cursor, "event cursor")
  requireCondition(Number.isSafeInteger(value.sequence) && value.sequence > 0,
    "invalid_runner_state", "event sequence is invalid")
  requireCondition(ROLE_SET.has(value.role) || value.role === "runner",
    "invalid_runner_state", "event role is invalid")
  assertProtocolId(value.eventId, "event ID")
  nullableId(value.sourceEventId, "source event ID")
  requireCondition(value.sourceSequence === null || Number.isSafeInteger(value.sourceSequence) && value.sourceSequence > 0,
    "invalid_runner_state", "source event sequence is invalid")
  requireCondition(EVENT_TYPE_SET.has(value.eventType), "invalid_runner_state", "event type is invalid")
  nullableId(value.assignmentId, "event assignment ID")
  timestamp(value.timestamp, "event timestamp")
  validateTelemetry(value.data)
  requireCondition(typeof value.gapBefore === "boolean", "invalid_runner_state", "event gapBefore is invalid")
}

function validateArtifact(value) {
  plainObject(value, "artifact")
  exactKeys(value, ["artifactId", "role", "kind", "schema", "createdAtMs", "result"], "artifact")
  assertProtocolId(value.artifactId, "artifact ID")
  requireCondition(value.role === null || ROLE_SET.has(value.role), "invalid_runner_state", "artifact role is invalid")
  requireCondition(typeof value.kind === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.kind),
    "invalid_runner_state", "artifact kind is invalid")
  requireCondition(value.schema === ARTIFACT_SCHEMA, "invalid_runner_state", "artifact schema is invalid")
  timestamp(value.createdAtMs, "artifact createdAtMs")
  validateTelemetry(value.result)
}

export function validateRunnerState(value, { maxEvents = 256, maxArtifacts = 128 } = {}) {
  plainObject(value, "runner state")
  exactKeys(value, [
    "schema", "receiptId", "teamGoalId", "bindings", "bridges", "assignments", "sequence",
    "firstSequence", "events", "seenEventIds", "artifacts", "createdAtMs", "updatedAtMs"
  ], "runner state")
  requireCondition(value.schema === RUNNER_STATE_SCHEMA, "invalid_runner_state", "runner state schema is invalid")
  assertProtocolUuid(value.receiptId, "receipt ID")
  assertProtocolUuid(value.teamGoalId, "Team Goal ID")
  plainObject(value.bindings, "runner bindings")
  exactKeys(value.bindings, ROLES, "runner bindings")
  const agentIds = new Set()
  const shellIds = new Set()
  const shellRunIds = new Set()
  for (const role of ROLES) {
    validateBinding(value.bindings[role], role)
    requireCondition(!agentIds.has(value.bindings[role].agentRunId), "invalid_runner_state", "Agent Run IDs must be unique")
    requireCondition(!shellIds.has(value.bindings[role].shellId), "invalid_runner_state", "Shell IDs must be unique")
    const shellRunId = value.bindings[role].shellRunId
    if (shellRunId !== null) {
      requireCondition(!shellRunIds.has(shellRunId), "invalid_runner_state", "Shell Run IDs must be unique")
      shellRunIds.add(shellRunId)
    }
    agentIds.add(value.bindings[role].agentRunId)
    shellIds.add(value.bindings[role].shellId)
  }
  plainObject(value.bridges, "runner bridges")
  exactKeys(value.bridges, ROLES, "runner bridges")
  for (const role of ROLES) {
    validateBridge(value.bridges[role], role)
    requireCondition(value.bridges[role].agentRunId === value.bindings[role].agentRunId
      && value.bridges[role].shellId === value.bindings[role].shellId,
    "invalid_runner_state", `${role} bridge binding differs from runner binding`)
  }
  requireCondition(Array.isArray(value.assignments) && value.assignments.length <= 256,
    "invalid_runner_state", "assignments collection is invalid")
  const assignmentIds = new Set()
  for (const assignment of value.assignments) {
    validateAssignment(assignment)
    requireCondition(!assignmentIds.has(assignment.assignmentId), "invalid_runner_state", "assignment IDs must be unique")
    assignmentIds.add(assignment.assignmentId)
  }
  requireCondition(Number.isSafeInteger(value.sequence) && value.sequence >= 0,
    "invalid_runner_state", "runner event sequence is invalid")
  requireCondition(Number.isSafeInteger(value.firstSequence) && value.firstSequence >= 1,
    "invalid_runner_state", "runner first sequence is invalid")
  requireCondition(Array.isArray(value.events) && value.events.length <= maxEvents,
    "invalid_runner_state", "events collection is invalid")
  requireCondition(Array.isArray(value.seenEventIds) && value.seenEventIds.length <= 2_048,
    "invalid_runner_state", "seen event ID collection is invalid")
  const seenEventIds = new Set()
  for (const eventId of value.seenEventIds) {
    assertProtocolId(eventId, "seen event ID")
    requireCondition(!seenEventIds.has(eventId), "invalid_runner_state", "seen event IDs must be unique")
    seenEventIds.add(eventId)
  }
  let previousSequence = value.firstSequence - 1
  const eventIds = new Set()
  for (const event of value.events) {
    validateEvent(event)
    requireCondition(event.sequence > previousSequence && event.sequence <= value.sequence,
      "invalid_runner_state", "runner events are not ordered")
    requireCondition(!eventIds.has(event.eventId), "invalid_runner_state", "runner event IDs must be unique")
    previousSequence = event.sequence
    eventIds.add(event.eventId)
  }
  if (value.events.length > 0) {
    requireCondition(value.events[0].sequence === value.firstSequence,
      "invalid_runner_state", "firstSequence does not match retained events")
    requireCondition(value.events.at(-1).sequence === value.sequence,
      "invalid_runner_state", "runner sequence does not match retained events")
  } else {
    requireCondition(value.firstSequence === value.sequence + 1,
      "invalid_runner_state", "empty event retention boundary is invalid")
  }
  requireCondition(Array.isArray(value.artifacts) && value.artifacts.length <= maxArtifacts,
    "invalid_runner_state", "artifacts collection is invalid")
  const artifactIds = new Set()
  for (const artifact of value.artifacts) {
    validateArtifact(artifact)
    requireCondition(!artifactIds.has(artifact.artifactId), "invalid_runner_state", "artifact IDs must be unique")
    artifactIds.add(artifact.artifactId)
  }
  timestamp(value.createdAtMs, "runner createdAtMs")
  timestamp(value.updatedAtMs, "runner updatedAtMs")
  requireCondition(value.updatedAtMs >= value.createdAtMs, "invalid_runner_state", "runner timestamps are inverted")
  return value
}

export function createRunnerState({ receiptId, teamGoalId, bindings, now = Date.now }) {
  assertProtocolUuid(receiptId, "receipt ID")
  assertProtocolUuid(teamGoalId, "Team Goal ID")
  plainObject(bindings, "runner bindings")
  exactKeys(bindings, ROLES, "runner bindings")
  const normalizedBindings = {}
  const normalizedBridges = {}
  for (const role of ROLES) {
    const binding = plainObject(bindings[role], `${role} binding`)
    exactKeys(binding, ["agentRunId", "shellId"], ["shellRunId"], `${role} binding`)
    normalizedBindings[role] = {
      role,
      agentRunId: binding.agentRunId,
      shellId: binding.shellId,
      shellRunId: binding.shellRunId ?? null
    }
    normalizedBridges[role] = {
      role,
      agentRunId: binding.agentRunId,
      shellId: binding.shellId,
      connectionState: "disconnected",
      connectionId: null,
      piSessionId: null,
      extensionInstanceId: null,
      pid: null,
      controlMode: "managed",
      assignmentId: null,
      lastBridgeSequence: 0,
      lastEventId: null,
      connectionCount: 0,
      connectedAtMs: null,
      disconnectedAtMs: null
    }
  }
  const createdAtMs = now()
  const value = {
    schema: RUNNER_STATE_SCHEMA,
    receiptId,
    teamGoalId,
    bindings: normalizedBindings,
    bridges: normalizedBridges,
    assignments: [],
    sequence: 0,
    firstSequence: 1,
    events: [],
    seenEventIds: [],
    artifacts: [],
    createdAtMs,
    updatedAtMs: createdAtMs
  }
  return validateRunnerState(value)
}

export class MemoryDurableStore {
  constructor(initial = null, options = {}) {
    this.options = options
    this.value = initial === null ? null : clone(validateRunnerState(initial, options))
    this.queue = Promise.resolve()
  }

  async load() {
    return this.value === null ? null : clone(this.value)
  }

  async initialize(value) {
    return this.#enqueue(async () => {
      requireCondition(this.value === null, "state_exists", "Runner state already exists")
      this.value = clone(validateRunnerState(value, this.options))
      return this.load()
    })
  }

  async replace(value) {
    return this.#enqueue(async () => {
      requireCondition(this.value !== null, "state_missing", "Runner state does not exist")
      this.value = clone(validateRunnerState(value, this.options))
      return this.load()
    })
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      requireCondition(this.value !== null, "state_missing", "Runner state does not exist")
      const next = clone(this.value)
      await mutator(next)
      this.value = clone(validateRunnerState(next, this.options))
      return this.load()
    })
  }

  #enqueue(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => {})
    return result
  }
}

export class DurableStateStore {
  constructor(filePath, { maxBytes = 4 * 1024 * 1024, maxEvents = 256, maxArtifacts = 128 } = {}) {
    this.filePath = path.resolve(filePath)
    validateAbsolutePath(this.filePath, "runner state path")
    requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16 * 1024 * 1024,
      "invalid_state_store", "state size limit is invalid")
    this.maxBytes = maxBytes
    this.maxEvents = maxEvents
    this.maxArtifacts = maxArtifacts
    this.queue = Promise.resolve()
    this.writeCounter = 0
  }

  async load() {
    try {
      const metadata = await lstat(this.filePath)
      requireCondition(metadata.isFile() && !metadata.isSymbolicLink(),
        "unsafe_state", "runner state path must be a regular nonsymlink file")
      requireCondition(metadata.uid === undefined || metadata.uid === process.getuid?.(),
        "unsafe_state", "runner state file is not owned by the execution identity")
      const text = await readFile(this.filePath, "utf8")
      requireCondition(Buffer.byteLength(text) <= this.maxBytes,
        "state_too_large", "runner state exceeds its size limit")
      let value
      try { value = JSON.parse(text) }
      catch (error) { throw spikeError("invalid_runner_state", "runner state JSON is malformed", { cause: error.message }) }
      return clone(validateRunnerState(value, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts }))
    } catch (error) {
      if (error?.code === "ENOENT") return null
      throw error
    }
  }

  async initialize(value) {
    return this.#enqueue(async () => {
      requireCondition(await this.load() === null, "state_exists", "Runner state already exists")
      await this.#write(validateRunnerState(value, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts }), true)
      return this.load()
    })
  }

  async replace(value) {
    return this.#enqueue(async () => {
      requireCondition(await this.load() !== null, "state_missing", "Runner state does not exist")
      await this.#write(validateRunnerState(value, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts }), false)
      return this.load()
    })
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      const current = await this.load()
      requireCondition(current !== null, "state_missing", "Runner state does not exist")
      await mutator(current)
      await this.#write(validateRunnerState(current, { maxEvents: this.maxEvents, maxArtifacts: this.maxArtifacts }), false)
      return this.load()
    })
  }

  #enqueue(operation) {
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => {})
    return result
  }

  async #ensureParent() {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const metadata = await lstat(directory)
    requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink(),
      "unsafe_state", "runner state parent must be a directory")
    if (metadata.uid !== undefined) requireCondition(metadata.uid === process.getuid?.(),
      "unsafe_state", "runner state parent is not owned by the execution identity")
    await import("node:fs/promises").then(({ chmod }) => chmod(directory, 0o700))
    return directory
  }

  async #write(value, exclusive) {
    const directory = await this.#ensureParent()
    const encoded = `${JSON.stringify(value, null, 2)}\n`
    requireCondition(Buffer.byteLength(encoded) <= this.maxBytes,
      "state_too_large", "runner state exceeds its size limit")
    if (exclusive) {
      const handle = await open(this.filePath, "wx", 0o600)
      try {
        await handle.writeFile(encoded)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return
    }
    let current = null
    try { current = await lstat(this.filePath) } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    requireCondition(current === null || current.isFile() && !current.isSymbolicLink(),
      "unsafe_state", "runner state target is not a regular file")
    if (current?.uid !== undefined) requireCondition(current.uid === process.getuid?.(),
      "unsafe_state", "runner state target is not owned by the execution identity")
    const temporary = `${this.filePath}.${process.pid}.${++this.writeCounter}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(encoded)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.filePath)
    } catch (error) {
      try { await unlink(temporary) } catch {}
      throw error
    }
    const directoryHandle = await open(directory, "r")
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  }
}