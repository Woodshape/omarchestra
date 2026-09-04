/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Deterministic in-memory seams for the observer/Adoption prototype. These
 * fakes provide monotonic time, decoded observer-frame transport, and
 * reconstructable transactional state without opening files, sockets,
 * processes, desktop resources, or databases.
 */

import {
  OBSERVER_LIMITS,
  encodeFrame,
  isObserverRunnerFrameType,
  validateObserverBodyForType,
  type ObserverFrame,
} from './contracts.ts'

const DEFAULT_LOG_ENTRIES = 256
const DEFAULT_CONNECTIONS = 64
const MAX_FAILURE_DETAIL = 256

function clone<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    throw new Error('fake state must be finite, acyclic cloneable data')
  }
}

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('fake state must be JSON serializable')
  return new TextEncoder().encode(encoded).byteLength
}

function boundedDetail(value: string): string {
  return value.length > MAX_FAILURE_DETAIL ? value.slice(0, MAX_FAILURE_DETAIL) : value
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function requireBoundedLimit(value: number | undefined, name: string, fallback: number): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return limit
}

// ---------------------------------------------------------------------------
// Deterministic failures
// ---------------------------------------------------------------------------

export class FakeFailureError extends Error {
  readonly operation: string

  constructor(operation: string, detail = `injected fake failure at ${operation}`) {
    super(`fake failure [${operation}]: ${boundedDetail(detail)}`)
    this.name = 'FakeFailureError'
    this.operation = boundedDetail(operation)
  }
}

interface FailurePlan {
  remaining: number | null
  detail: string
}

/**
 * One-shot or persistent deterministic failure injection. Fakes expose this
 * controller through `failAt`, `failAlways`, and `clearFailures`; production
 * code never receives this seam.
 */
export class FakeFailureController {
  private readonly plans = new Map<string, FailurePlan>()

  failAt(operation: string, count = 1, detail?: string): void {
    if (typeof operation !== 'string' || operation.length === 0) {
      throw new TypeError('failure operation must be a non-empty string')
    }
    requirePositiveSafeInteger(count, 'failure count')
    this.plans.set(operation, {
      remaining: count,
      detail: boundedDetail(detail ?? `injected fake failure at ${operation}`),
    })
  }

  failAlways(operation: string, detail?: string): void {
    if (typeof operation !== 'string' || operation.length === 0) {
      throw new TypeError('failure operation must be a non-empty string')
    }
    this.plans.set(operation, {
      remaining: null,
      detail: boundedDetail(detail ?? `injected fake failure at ${operation}`),
    })
  }

  /** Alias used by tests that describe the next failing operation. */
  failNext(operation: string, detail?: string): void {
    this.failAt(operation, 1, detail)
  }

  check(operation: string): void {
    const exact = this.plans.get(operation)
    const matchedKey = exact === undefined ? '*' : operation
    const plan = exact ?? this.plans.get('*')
    if (plan === undefined) return
    if (plan.remaining !== null) {
      plan.remaining -= 1
      if (plan.remaining <= 0) this.plans.delete(matchedKey)
    }
    throw new FakeFailureError(operation, plan.detail)
  }

  configured(operation: string): boolean {
    return this.plans.has(operation) || this.plans.has('*')
  }

  clear(operation?: string): void {
    if (operation === undefined) this.plans.clear()
    else this.plans.delete(operation)
  }

  clearFailures(): void {
    this.clear()
  }
}

// ---------------------------------------------------------------------------
// Deterministic capability issuance and monotonic clock
// ---------------------------------------------------------------------------

/**
 * Deterministic test double for a trusted issuer of 128-bit random opaque
 * capabilities. The production boundary must supply unpredictable values;
 * this fake supplies unique 32-hex-character values for reproducible tests.
 */
export class FakeCapabilityIssuer {
  private counter = 0

  issue(purpose: string): string {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(purpose)) {
      throw new TypeError('capability purpose must be a bounded identifier')
    }
    if (this.counter >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('fake capability counter exhausted')
    }
    this.counter += 1
    return `${purpose}-${this.counter.toString(16).padStart(32, '0')}`
  }
}

export interface MonotonicClock {
  now(): number
}

/** A manually advanced monotonic clock. It never schedules a real timer. */
export class FakeMonotonicClock implements MonotonicClock {
  private value: number

  constructor(initialMs = 0) {
    this.value = requireNonNegativeSafeInteger(initialMs, 'initial monotonic time')
  }

  now(): number {
    return this.value
  }

  current(): number {
    return this.now()
  }

  advance(deltaMs: number): number {
    requireNonNegativeSafeInteger(deltaMs, 'clock advance')
    if (deltaMs > Number.MAX_SAFE_INTEGER - this.value) {
      throw new RangeError('monotonic clock would exceed the safe integer bound')
    }
    this.value += deltaMs
    return this.value
  }

  tick(deltaMs: number): number {
    return this.advance(deltaMs)
  }

  set(value: number): number {
    requireNonNegativeSafeInteger(value, 'monotonic time')
    if (value < this.value) throw new RangeError('monotonic time cannot move backwards')
    this.value = value
    return this.value
  }
}

// ---------------------------------------------------------------------------
// In-memory observer transport
// ---------------------------------------------------------------------------

export interface FakeObserverFrameHandler {
  onFrame(frame: ObserverFrame): void
  onClose?(error: Error | null): void
}

export type FakeObserverFrameListener = (frame: ObserverFrame) => void

export interface FakeObserverTransportOptions {
  maxConnections?: number
  maxLogEntries?: number
  connectionPrefix?: string
  failures?: FakeFailureController
  onClientFrame?: (connection: FakeObserverConnection, frame: ObserverFrame) => void
  onConnectionClosed?: (connection: FakeObserverConnection, error: Error | null) => void
}

export interface FakeObserverFrameLog {
  sequence: number
  direction: 'client_to_registry' | 'registry_to_client'
  transportId: string
  type: string
  messageId: string
  body: Record<string, unknown>
  frame: ObserverFrame
}

/**
 * One in-memory connection. `send` models the observer extension sending to
 * the registry. The transport's `inject`/`deliver` methods model a registry
 * frame arriving from the other side.
 */
export class FakeObserverConnection {
  readonly id: string

  private readonly owner: FakeObserverTransport
  private handler: FakeObserverFrameHandler | null = null
  private closedValue = false

  constructor(owner: FakeObserverTransport, id: string) {
    this.owner = owner
    this.id = id
  }

  get closed(): boolean {
    return this.closedValue
  }

  get isClosed(): boolean {
    return this.closedValue
  }

  get sent(): FakeObserverFrameLog[] {
    return this.owner.frames().filter((entry) => entry.transportId === this.id && entry.direction === 'client_to_registry')
  }

  get received(): FakeObserverFrameLog[] {
    return this.owner.frames().filter((entry) => entry.transportId === this.id && entry.direction === 'registry_to_client')
  }

  /** Match the public FrameChannel send shape without using a real channel. */
  send(type: string, messageId: string, body: Record<string, unknown>): void {
    if (this.closedValue) throw new Error('fake observer connection is closed')
    this.owner.sendFromClient(this, type, messageId, body)
  }

  sendFrame(type: string, messageId: string, body: Record<string, unknown>): void {
    this.send(type, messageId, body)
  }

  onFrame(handler: FakeObserverFrameHandler | FakeObserverFrameListener): () => void {
    this.handler = normalizeFrameHandler(handler)
    return () => {
      if (this.handler === null) return
      this.handler = null
    }
  }

  setHandler(handler: FakeObserverFrameHandler | FakeObserverFrameListener): void {
    this.handler = normalizeFrameHandler(handler)
  }

  bind(handler: FakeObserverFrameHandler | FakeObserverFrameListener): void {
    this.setHandler(handler)
  }

  last(type: string): FakeObserverFrameLog | undefined {
    return [...this.sent].reverse().find((entry) => entry.frame.type === type)
  }

  onClose(handler: (error: Error | null) => void): () => void {
    const current = this.handler
    if (current === null) {
      this.handler = { onFrame: () => {}, onClose: handler }
    } else {
      this.handler = { onFrame: current.onFrame, onClose: handler }
    }
    return () => {
      if (this.handler === null) return
      this.handler = { onFrame: this.handler.onFrame }
    }
  }

  /** Inject one validated registry-to-observer frame into this connection. */
  receive(type: string, messageId: string, body: Record<string, unknown>): void {
    this.owner.inject(this, type, messageId, body)
  }

  deliver(type: string, body: Record<string, unknown>, messageId?: string): void {
    this.owner.inject(this, type, messageId ?? this.owner.nextInboundMessageId(), body)
  }

  close(): void {
    this.owner.close(this, null)
  }

  /** Test-only disconnect path with an explicit deterministic error. */
  disconnect(error: Error = new Error('fake observer connection disconnected')): void {
    this.owner.close(this, error)
  }

  /** Internal delivery hook used by FakeObserverTransport. */
  dispatch(frame: ObserverFrame): void {
    this.handler?.onFrame(frame)
  }

  /** Internal close hook used by FakeObserverTransport. */
  dispatchClose(error: Error | null): void {
    this.handler?.onClose?.(error)
  }

  /** Internal state transition used by FakeObserverTransport. */
  markClosed(): void {
    this.closedValue = true
  }
}

function normalizeFrameHandler(
  handler: FakeObserverFrameHandler | FakeObserverFrameListener,
): FakeObserverFrameHandler {
  return typeof handler === 'function' ? { onFrame: handler } : handler
}

/**
 * Bounded, decoded observer transport. It is intentionally not a stream,
 * socket, or network adapter. The registry/extension tests can inspect the
 * frame log and inject failures at connect, send, receive, or close.
 */
export class FakeObserverTransport {
  readonly failures: FakeFailureController

  private readonly maxConnections: number
  private readonly maxLogEntries: number
  private readonly connectionPrefix: string
  private readonly clientFrameHandlers: Array<(connection: FakeObserverConnection, frame: ObserverFrame) => void> = []
  private readonly connectionClosedHandler: ((connection: FakeObserverConnection, error: Error | null) => void) | null
  private readonly connectionList: FakeObserverConnection[] = []
  private readonly frameLog: FakeObserverFrameLog[] = []
  private sequence = 0
  private connectionCounter = 0
  private inboundMessageCounter = 0

  constructor(options: FakeObserverTransportOptions = {}) {
    this.failures = options.failures ?? new FakeFailureController()
    this.maxConnections = requireBoundedLimit(options.maxConnections, 'max connections', DEFAULT_CONNECTIONS)
    this.maxLogEntries = requireBoundedLimit(options.maxLogEntries, 'max transport log entries', DEFAULT_LOG_ENTRIES)
    this.connectionPrefix = options.connectionPrefix ?? 'transport'
    if (options.onClientFrame !== undefined) this.clientFrameHandlers.push(options.onClientFrame)
    this.connectionClosedHandler = options.onConnectionClosed ?? null
  }

  connect(handler?: FakeObserverFrameHandler | FakeObserverFrameListener): FakeObserverConnection {
    this.failures.check('connect')
    if (this.connectionList.length >= this.maxConnections) {
      throw new Error('fake observer transport connection limit reached')
    }
    const connection = new FakeObserverConnection(
      this,
      `${this.connectionPrefix}-${++this.connectionCounter}`,
    )
    if (handler !== undefined) connection.setHandler(handler)
    this.connectionList.push(connection)
    return connection
  }

  open(handler?: FakeObserverFrameHandler | FakeObserverFrameListener): FakeObserverConnection {
    return this.connect(handler)
  }

  createConnection(handler?: FakeObserverFrameHandler | FakeObserverFrameListener): FakeObserverConnection {
    return this.connect(handler)
  }

  connections(): FakeObserverConnection[] {
    return this.connectionList.map((connection) => connection)
  }

  activeConnections(): FakeObserverConnection[] {
    return this.connectionList.filter((connection) => !connection.closed)
  }

  frames(): FakeObserverFrameLog[] {
    return this.frameLog.map((entry) => ({
      ...entry,
      body: clone(entry.body),
      frame: clone(entry.frame),
    }))
  }

  log(): FakeObserverFrameLog[] {
    return this.frames()
  }

  sentFrames(): FakeObserverFrameLog[] {
    return this.frames().filter((entry) => entry.direction === 'client_to_registry')
  }

  receivedFrames(): FakeObserverFrameLog[] {
    return this.frames().filter((entry) => entry.direction === 'registry_to_client')
  }

  clearLog(): void {
    this.frameLog.length = 0
  }

  onClientFrame(handler: (connection: FakeObserverConnection, frame: ObserverFrame) => void): () => void {
    this.clientFrameHandlers.push(handler)
    return () => {
      const index = this.clientFrameHandlers.indexOf(handler)
      if (index >= 0) this.clientFrameHandlers.splice(index, 1)
    }
  }

  onFrame(handler: (connection: FakeObserverConnection, frame: ObserverFrame) => void): () => void {
    return this.onClientFrame(handler)
  }

  failAt(operation: string, count = 1, detail?: string): void {
    this.failures.failAt(operation, count, detail)
  }

  failAlways(operation: string, detail?: string): void {
    this.failures.failAlways(operation, detail)
  }

  failNext(operation: string, detail?: string): void {
    this.failures.failNext(operation, detail)
  }

  clearFailures(): void {
    this.failures.clearFailures()
  }

  /** Inject a decoded registry-to-observer frame. */
  inject(
    connectionOrId: FakeObserverConnection | string,
    type: string,
    messageId: string,
    body: Record<string, unknown>,
  ): void {
    const connection = this.resolveConnection(connectionOrId)
    if (connection.closed) throw new Error('cannot inject into a closed fake observer connection')
    this.failures.check('receive')
    if (!isObserverRunnerFrameType(type)) {
      throw new Error(`fake observer transport cannot inject client frame ${type}`)
    }
    const frame = frameFrom(type, messageId, body)
    this.record('registry_to_client', connection, frame)
    try {
      connection.dispatch(frame)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      this.close(connection, normalized)
      throw normalized
    }
  }

  deliver(
    connectionOrId: FakeObserverConnection | string,
    type: string,
    body: Record<string, unknown>,
    messageId?: string,
  ): void {
    this.inject(connectionOrId, type, messageId ?? this.nextInboundMessageId(), body)
  }

  receive(
    connectionOrId: FakeObserverConnection | string,
    type: string,
    body: Record<string, unknown>,
    messageId?: string,
  ): void {
    this.deliver(connectionOrId, type, body, messageId)
  }

  close(connectionOrId: FakeObserverConnection | string, error: Error | null = null): void {
    const connection = this.resolveConnection(connectionOrId)
    if (connection.closed) return
    this.failures.check('close')
    connection.markClosed()
    connection.dispatchClose(error)
    this.connectionClosedHandler?.(connection, error)
  }

  closeAll(error: Error | null = null): void {
    for (const connection of this.connectionList) {
      if (!connection.closed) this.close(connection, error)
    }
  }

  send(
    connectionOrId: FakeObserverConnection | string,
    type: string,
    messageId: string,
    body: Record<string, unknown>,
  ): void {
    this.resolveConnection(connectionOrId).send(type, messageId, body)
  }

  /** Internal outbound path used by FakeObserverConnection.send. */
  sendFromClient(
    connection: FakeObserverConnection,
    type: string,
    messageId: string,
    body: Record<string, unknown>,
  ): void {
    this.failures.check('send')
    if (!this.connectionList.includes(connection) || connection.closed) {
      throw new Error('fake observer connection is not current')
    }
    const frame = frameFrom(type, messageId, body)
    this.record('client_to_registry', connection, frame)
    for (const handler of [...this.clientFrameHandlers]) handler(connection, clone(frame))
  }

  nextInboundMessageId(): string {
    return `fake-registry-${++this.inboundMessageCounter}`
  }

  private resolveConnection(connectionOrId: FakeObserverConnection | string): FakeObserverConnection {
    if (connectionOrId instanceof FakeObserverConnection) {
      if (!this.connectionList.includes(connectionOrId)) throw new Error('unknown fake observer connection')
      return connectionOrId
    }
    const connection = this.connectionList.find((candidate) => candidate.id === connectionOrId)
    if (connection === undefined) throw new Error(`unknown fake observer connection ${connectionOrId}`)
    return connection
  }

  private record(
    direction: FakeObserverFrameLog['direction'],
    connection: FakeObserverConnection,
    frame: ObserverFrame,
  ): void {
    if (this.frameLog.length >= this.maxLogEntries) this.frameLog.shift()
    this.frameLog.push({
      sequence: ++this.sequence,
      direction,
      transportId: connection.id,
      type: frame.type,
      messageId: frame.messageId,
      body: clone(frame.body),
      frame: clone(frame),
    })
  }
}

function frameFrom(type: string, messageId: string, body: Record<string, unknown>): ObserverFrame {
  // encodeFrame performs the exact protocol validation and size bound. Parse
  // its result back into the decoded fake representation without any stream.
  const line = encodeFrame(type, messageId, body).trimEnd()
  const parsed = JSON.parse(line) as { protocol: string; type: string; messageId: string; body: Record<string, unknown> }
  return {
    protocol: parsed.protocol as ObserverFrame['protocol'],
    type: parsed.type,
    messageId: parsed.messageId,
    body: validateObserverBodyForType(parsed.type, parsed.body),
  }
}

// ---------------------------------------------------------------------------
// Reconstructable in-memory persistence
// ---------------------------------------------------------------------------

export interface FakePersistenceLogEntry {
  sequence: number
  operation: 'load' | 'save' | 'begin' | 'commit' | 'rollback' | 'clear'
  stateBytes: number
}

export interface FakeTransactionalTeamRunnerState {
  registry?: {
    replace?(record: Record<string, unknown> | null): void
    managed?: Record<string, unknown> | null
    record?: Record<string, unknown> | null
  }
}

export interface FakeTransactionalTeamRunnerOptions {
  agentRunId?: string
  agentRunIdFactory?: () => string
  maxLogEntries?: number
  failures?: FakeFailureController
  registry?: FakeTransactionalTeamRunnerState['registry']
  state?: FakeTransactionalTeamRunnerState
}

export interface FakeTeamRunnerCommit {
  proposalId: string
  proposalDigest: string
  observedSessionId: string
  executionNodeId: string
  processIncarnationId: string
  piSessionId: string
  extensionInstanceId: string
  agentRunId: string
  targetTeamGoalId: string
  targetRole: string
  controlMode: 'managed'
  piStatus: string
  terminalTitleMetadata: string
  runtimeBinding: null
  runtimeBindingGuarantee: 'unavailable'
}

/**
 * In-memory Team Runner transaction owner for Adoption tests. It records the
 * transaction attempt, changes observed/managed state only after the commit
 * boundary, and never dispatches an assignment or prompt.
 */
export class FakeTransactionalTeamRunner {
  readonly failures: FakeFailureController
  readonly transactionAttempts: Array<Record<string, unknown>> = []
  readonly durableCommits: FakeTeamRunnerCommit[] = []
  private readonly logLimit: number
  private readonly fixedAgentRunId: string | null
  private readonly agentRunIdFactory: (() => string) | null
  private readonly registryState: FakeTransactionalTeamRunnerState['registry'] | undefined
  private readonly managedState: FakeTeamRunnerCommit[] = []
  private attemptSequence = 0
  private totalCommitCount = 0

  failBeforeCommit = false

  constructor(options: FakeTransactionalTeamRunnerOptions = {}) {
    this.failures = options.failures ?? new FakeFailureController()
    this.logLimit = requireBoundedLimit(options.maxLogEntries, 'max team runner log entries', DEFAULT_LOG_ENTRIES)
    this.fixedAgentRunId = options.agentRunId ?? null
    this.agentRunIdFactory = options.agentRunIdFactory ?? null
    this.registryState = options.registry ?? options.state?.registry
  }

  get managed(): FakeTeamRunnerCommit | null {
    const current = this.managedState.at(-1)
    return current === undefined ? null : clone(current)
  }

  get commitCount(): number {
    return this.totalCommitCount
  }

  commitAdoption(input: Record<string, unknown>): Record<string, unknown> {
    const attempt = cloneRecord(input)
    this.appendBounded(this.transactionAttempts, {
      sequence: ++this.attemptSequence,
      proposal: attempt.proposal,
      authorization: attempt.authorization,
      acknowledgement: attempt.acknowledgement,
      reconciliation: attempt.reconciliation,
    })
    if (this.failBeforeCommit) throw new FakeFailureError('team_runner.commit', 'Team Runner commit was configured to fail')
    this.failures.check('team_runner.commit')
    this.failures.check('commit')
    this.failures.check('transaction')

    const proposal = requirePlainRecord(attempt.proposal, 'Adoption proposal')
    const agentRunId = this.issueAgentRunId()
    const role = requirePlainText(proposal.targetRole, 'target Role')
    const roleLabel = role.slice(0, 1).toUpperCase() + role.slice(1)
    const committed: FakeTeamRunnerCommit = {
      proposalId: requirePlainText(proposal.proposalId, 'proposal ID'),
      proposalDigest: requirePlainText(proposal.proposalDigest, 'proposal digest'),
      observedSessionId: requirePlainText(proposal.observedSessionId, 'observed session ID'),
      executionNodeId: requirePlainText(proposal.executionNodeId, 'Execution Node ID'),
      processIncarnationId: requirePlainText(proposal.processIncarnationId, 'process incarnation ID'),
      piSessionId: requirePlainText(proposal.piSessionId, 'Pi session ID'),
      extensionInstanceId: requirePlainText(proposal.extensionInstanceId, 'extension instance ID'),
      agentRunId,
      targetTeamGoalId: requirePlainText(proposal.targetTeamGoalId, 'Team Goal ID'),
      targetRole: role,
      controlMode: 'managed',
      piStatus: `${roleLabel} · managed`,
      terminalTitleMetadata: `Omarchestra — ${roleLabel} — managed`,
      runtimeBinding: null,
      runtimeBindingGuarantee: 'unavailable',
    }
    const previousRecord = this.registryState?.record
    const previousManaged = this.registryState?.managed
    try {
      if (this.registryState !== undefined) {
        this.registryState.managed = clone(committed)
        this.registryState.replace?.(null)
      }
    } catch (error) {
      if (this.registryState !== undefined) {
        this.registryState.managed = previousManaged ?? null
        try {
          this.registryState.replace?.(previousRecord ?? null)
        } catch {
          // The fake registry controls its own injected failure surface. The
          // attempted restore is best-effort while the commit remains absent.
        }
      }
      throw error
    }
    this.totalCommitCount += 1
    this.appendBounded(this.durableCommits, committed)
    this.managedState.length = 0
    this.managedState.push(clone(committed))
    return clone(committed)
  }

  /** Alias for ports named transaction or commit. */
  commit(input: Record<string, unknown>): Record<string, unknown> {
    return this.commitAdoption(input)
  }

  failAt(operation: string, count = 1, detail?: string): void {
    this.failures.failAt(operation, count, detail)
  }

  failAlways(operation: string, detail?: string): void {
    this.failures.failAlways(operation, detail)
  }

  clearFailures(): void {
    this.failures.clearFailures()
  }

  private issueAgentRunId(): string {
    const value = this.agentRunIdFactory?.() ?? this.fixedAgentRunId ?? `agent-run-${(this.totalCommitCount + 1).toString(16).padStart(32, '0')}`
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new FakeFailureError('team_runner.commit', 'Team Runner returned an invalid Agent Run identity')
    }
    return value
  }

  private appendBounded<T>(entries: T[], value: T): void {
    if (entries.length >= this.logLimit) entries.shift()
    entries.push(clone(value))
  }
}

function cloneRecord<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    throw new Error('fake Team Runner values must be finite cloneable data')
  }
}

function requirePlainRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`fake Team Runner ${where} must be an object`)
  }
  return value as Record<string, unknown>
}

function requirePlainText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`fake Team Runner ${where} must be bounded text`)
  }
  return value
}

export interface PersistenceBacking {
  state: unknown | null
  revision: number
}

export interface FakeObserverPersistenceOptions {
  initialState?: unknown | null
  maxLogEntries?: number
  backing?: PersistenceBacking
  failures?: FakeFailureController
}

/** A bounded transaction object used by FakeObserverPersistence. */
export class FakeObserverTransaction {
  private readonly owner: FakeObserverPersistence
  private working: unknown | null
  private activeValue = true

  constructor(owner: FakeObserverPersistence, initial: unknown | null) {
    this.owner = owner
    this.working = clone(initial)
  }

  get active(): boolean {
    return this.activeValue
  }

  read<T = unknown>(): T | null {
    this.assertActive()
    return clone(this.working) as T | null
  }

  value<T = unknown>(): T | null {
    return this.read<T>()
  }

  write(value: unknown | null): void {
    this.assertActive()
    this.working = clone(value)
  }

  replace(value: unknown | null): void {
    this.write(value)
  }

  commit(): void {
    this.assertActive()
    this.owner.commitTransaction(this)
  }

  rollback(): void {
    this.assertActive()
    this.owner.rollbackTransaction(this)
  }

  /** Internal transaction state access. */
  takeWorking(): unknown | null {
    this.assertActive()
    return clone(this.working)
  }

  /** Internal state transition used by the owner after commit/rollback. */
  finish(): void {
    this.activeValue = false
    this.working = null
  }

  private assertActive(): void {
    if (!this.activeValue) throw new Error('fake persistence transaction is no longer active')
  }
}

/**
 * Reconstructable in-memory persistence with atomic commit/rollback. The
 * backing object may be shared by a fresh instance to model a restart, while
 * every returned value and log record is cloned.
 */
export class FakeObserverPersistence {
  readonly failures: FakeFailureController

  private readonly backing: PersistenceBacking
  private readonly logLimit: number
  private readonly logEntries: FakePersistenceLogEntry[] = []
  private logSequence = 0
  private activeTransaction: FakeObserverTransaction | null = null

  constructor(initialOrOptions: unknown | FakeObserverPersistenceOptions | FakeObserverPersistence = null) {
    if (initialOrOptions instanceof FakeObserverPersistence) {
      this.failures = new FakeFailureController()
      this.backing = initialOrOptions.sharedBacking()
      this.logLimit = initialOrOptions.maxLogEntries
      return
    }

    const options = isPersistenceOptions(initialOrOptions) ? initialOrOptions : null
    this.failures = options?.failures ?? new FakeFailureController()
    this.backing = options?.backing ?? {
      state: options === null ? clone(initialOrOptions) : clone(options.initialState ?? null),
      revision: 0,
    }
    this.logLimit = requireBoundedLimit(options?.maxLogEntries, 'max persistence log entries', DEFAULT_LOG_ENTRIES)
  }

  get revision(): number {
    return this.backing.revision
  }

  get maxLogEntries(): number {
    return this.logLimit
  }

  get inTransaction(): boolean {
    return this.activeTransaction !== null
  }

  get state(): unknown | null {
    return this.snapshot()
  }

  load<T = unknown>(): T | null {
    this.failures.check('load')
    this.appendLog('load', this.backing.state)
    return clone(this.backing.state) as T | null
  }

  read<T = unknown>(): T | null {
    return this.load<T>()
  }

  reconstruct<T = unknown>(): T | null {
    return this.load<T>()
  }

  save(value: unknown | null): void {
    this.failures.check('save')
    if (this.activeTransaction !== null) throw new Error('fake persistence save cannot run inside a transaction')
    const next = clone(value)
    this.appendLog('save', next)
    this.backing.state = next
    this.backing.revision += 1
  }

  write(value: unknown | null): void {
    this.save(value)
  }

  saveSnapshot(value: unknown | null): void {
    this.save(value)
  }

  snapshot<T = unknown>(): T | null {
    return clone(this.backing.state) as T | null
  }

  clear(): void {
    this.failures.check('clear')
    if (this.activeTransaction !== null) throw new Error('fake persistence clear cannot run inside a transaction')
    this.appendLog('clear', null)
    this.backing.state = null
    this.backing.revision += 1
  }

  beginTransaction(): FakeObserverTransaction {
    this.failures.check('begin')
    if (this.activeTransaction !== null) throw new Error('nested fake persistence transactions are not permitted')
    const transaction = new FakeObserverTransaction(this, this.backing.state)
    try {
      this.appendLog('begin', this.backing.state)
    } catch (error) {
      transaction.finish()
      throw error
    }
    this.activeTransaction = transaction
    return transaction
  }

  begin(): FakeObserverTransaction {
    return this.beginTransaction()
  }

  withTransaction<T>(fn: (transaction: FakeObserverTransaction) => T): T {
    const transaction = this.beginTransaction()
    try {
      const result = fn(transaction)
      if (transaction.active) transaction.commit()
      return result
    } catch (error) {
      if (transaction.active) {
        try {
          transaction.rollback()
        } catch {
          // The in-memory state was never swapped, so it is still durable.
          // Clear the abandoned transaction even when rollback itself fails.
          this.activeTransaction = null
          transaction.finish()
        }
      }
      throw error
    }
  }

  transaction<T>(fn: (transaction: FakeObserverTransaction) => T): T {
    return this.withTransaction(fn)
  }

  runTransaction<T>(fn: (transaction: FakeObserverTransaction) => T): T {
    return this.withTransaction(fn)
  }

  commit(): void {
    if (this.activeTransaction === null) throw new Error('fake persistence has no active transaction')
    this.activeTransaction.commit()
  }

  rollback(): void {
    if (this.activeTransaction === null) throw new Error('fake persistence has no active transaction')
    this.activeTransaction.rollback()
  }

  withImmediateTransaction<T>(fn: (transaction: FakeObserverTransaction) => T): T {
    return this.withTransaction(fn)
  }

  logs(): FakePersistenceLogEntry[] {
    return this.logEntries.map((entry) => ({ ...entry }))
  }

  log(): FakePersistenceLogEntry[] {
    return this.logs()
  }

  clearLog(): void {
    this.logEntries.length = 0
  }

  failAt(operation: string, count = 1, detail?: string): void {
    this.failures.failAt(operation, count, detail)
  }

  failAlways(operation: string, detail?: string): void {
    this.failures.failAlways(operation, detail)
  }

  failNext(operation: string, detail?: string): void {
    this.failures.failNext(operation, detail)
  }

  clearFailures(): void {
    this.failures.clearFailures()
  }

  /** Create a fresh persistence facade over the same fake durable backing. */
  restart(): FakeObserverPersistence {
    return new FakeObserverPersistence({
      backing: this.sharedBacking(),
      maxLogEntries: this.logLimit,
    })
  }

  /** Internal transaction commit called by FakeObserverTransaction. */
  commitTransaction(transaction: FakeObserverTransaction): void {
    if (this.activeTransaction !== transaction) throw new Error('fake persistence transaction is not current')
    this.failures.check('commit')
    const next = transaction.takeWorking()
    this.appendLog('commit', next)
    this.backing.state = next
    this.backing.revision += 1
    this.activeTransaction = null
    transaction.finish()
  }

  /** Internal transaction rollback called by FakeObserverTransaction. */
  rollbackTransaction(transaction: FakeObserverTransaction): void {
    if (this.activeTransaction !== transaction) throw new Error('fake persistence transaction is not current')
    this.failures.check('rollback')
    this.appendLog('rollback', this.backing.state)
    this.activeTransaction = null
    transaction.finish()
  }

  private sharedBacking(): PersistenceBacking {
    return this.backing
  }

  private appendLog(operation: FakePersistenceLogEntry['operation'], state: unknown | null): void {
    if (this.logEntries.length >= this.logLimit) this.logEntries.shift()
    this.logEntries.push({
      sequence: ++this.logSequence,
      operation,
      stateBytes: Math.min(jsonBytes(state), OBSERVER_LIMITS.envelopeBytes),
    })
  }
}

function isPersistenceOptions(value: unknown): value is FakeObserverPersistenceOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.hasOwn(value, 'initialState')
    || Object.hasOwn(value, 'maxLogEntries')
    || Object.hasOwn(value, 'backing')
    || Object.hasOwn(value, 'failures')
}

export { FakeTransactionalTeamRunner as FakeTeamRunner }
