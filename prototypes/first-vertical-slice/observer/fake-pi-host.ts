/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * In-memory Pi host surface for observer adapter tests. It models only the
 * documented lifecycle, session identity, idle state, and UI status/title
 * methods used by the adapter. It never starts Pi or a provider and never
 * owns a terminal or process resource.
 */

import type {
  PiExtensionAPI,
  PiExtensionContext,
} from './extension-adapter.ts'

export type FakePiMode = 'tui' | 'rpc' | 'json' | 'print' | string
export type FakePiActivity = 'idle' | 'busy' | 'waiting_for_user' | 'unknown'

export interface FakePiHostOptions {
  sessionId?: string
  mode?: FakePiMode
  hasUI?: boolean
  title?: string
  statuses?: Record<string, string>
}

export interface FakePiSessionEvent {
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork' | string
  previousSessionFile?: string
}

export interface FakePiHostEventRecord {
  event: 'session_start' | 'session_shutdown'
  reason: string
  sessionId: string
}

export interface FakePiHostApi extends PiExtensionAPI {}

type Handler = (payload: unknown, context: PiExtensionContext) => unknown | Promise<unknown>

/**
 * Deterministic fake host. `api` is passed to an extension factory and
 * lifecycle methods are driven directly by tests.
 */
export class FakePiHost {
  readonly api: FakePiHostApi
  readonly sentUserMessages: string[] = []
  readonly processActions: string[] = []
  readonly statusWrites: Array<{ key: string; value: string | undefined }> = []
  readonly titleWrites: string[] = []
  readonly managedBridgeWrites: Array<Record<string, unknown>> = []
  readonly sessionEvents: FakePiHostEventRecord[] = []

  private readonly handlers = new Map<string, Handler[]>()
  private readonly statuses = new Map<string, string>()
  private sessionIdValue: string
  private modeValue: FakePiMode
  private hasUIValue: boolean
  private titleValue: string
  private activityValue: FakePiActivity = 'idle'
  private sessionRunning = false
  private managedBridgeValue = false
  private lastCommittedValue: Record<string, unknown> | null = null

  private readonly context: PiExtensionContext

  constructor(options: FakePiHostOptions = {}) {
    this.sessionIdValue = options.sessionId ?? 'fake-pi-session'
    this.modeValue = options.mode ?? 'tui'
    this.hasUIValue = options.hasUI ?? true
    this.titleValue = options.title ?? 'Pi'
    for (const [key, value] of Object.entries(options.statuses ?? {})) {
      this.statuses.set(key, value)
    }

    const thisHost = this
    this.context = {
      get mode() {
        return thisHost.modeValue
      },
      get hasUI() {
        return thisHost.hasUIValue
      },
      isIdle: () => this.activityValue === 'idle',
      hasPendingMessages: () => this.activityValue === 'busy' || this.activityValue === 'waiting_for_user',
      sessionManager: {
        getSessionId: () => this.sessionIdValue,
      },
      ui: {
        setStatus: (key, value) => this.setStatus(key, value),
        setTitle: (title) => this.setTitle(title),
      },
      enableManagedBridge: (committed) => this.enableManagedBridge(committed),
      disableManagedBridge: () => this.disableManagedBridge(),
    }
    // The context getters above intentionally refer to the fully constructed
    // host so mode/UI changes remain visible to an already-bound extension.
    this.api = {
      on: (event, handler) => this.registerHandler(event, handler),
    }
  }

  get title(): string {
    return this.titleValue
  }

  get mode(): FakePiMode {
    return this.modeValue
  }

  get hasUI(): boolean {
    return this.hasUIValue
  }

  get managedBridgeEnabled(): boolean {
    return this.managedBridgeValue
  }

  get isSessionRunning(): boolean {
    return this.sessionRunning
  }

  get lastCommitted(): Record<string, unknown> | null {
    return this.lastCommittedValue === null ? null : structuredClone(this.lastCommittedValue)
  }

  get hiddenAgentCount(): number {
    return 0
  }

  get terminalActionCount(): number {
    return 0
  }

  get ptyActionCount(): number {
    return 0
  }

  registeredEvents(): string[] {
    return [...this.handlers.keys()].sort()
  }

  status(key: string): string | undefined {
    return this.statuses.get(key)
  }

  setStatus(key: string, value: string | undefined): void {
    if (value === undefined) this.statuses.delete(key)
    else this.statuses.set(key, value)
    this.statusWrites.push({ key, value })
  }

  setTitle(title: string): void {
    this.titleValue = title
    this.titleWrites.push(title)
  }

  setSessionId(sessionId: string): void {
    this.sessionIdValue = sessionId
  }

  setMode(mode: FakePiMode): void {
    this.modeValue = mode
  }

  setHasUI(hasUI: boolean): void {
    this.hasUIValue = hasUI
  }

  setActivity(activity: FakePiActivity): void {
    if (activity !== 'idle'
        && activity !== 'busy'
        && activity !== 'waiting_for_user'
        && activity !== 'unknown') {
      throw new TypeError('fake Pi activity is not recognized')
    }
    this.activityValue = activity
  }

  get activity(): FakePiActivity {
    return this.activityValue
  }

  async startSession(event: FakePiSessionEvent = { reason: 'startup' }): Promise<void> {
    this.sessionRunning = true
    this.activityValue = 'idle'
    this.sessionEvents.push({
      event: 'session_start',
      reason: event.reason,
      sessionId: this.sessionIdValue,
    })
    await this.emit('session_start', event)
  }

  async shutdownSession(event: FakePiSessionEvent = { reason: 'quit' }): Promise<void> {
    this.sessionEvents.push({
      event: 'session_shutdown',
      reason: event.reason,
      sessionId: this.sessionIdValue,
    })
    await this.emit('session_shutdown', event)
    this.sessionRunning = false
  }

  async startAgent(): Promise<void> {
    this.activityValue = 'busy'
    await this.emit('agent_start', {})
  }

  async settleAgent(): Promise<void> {
    this.activityValue = 'idle'
    await this.emit('agent_settled', {})
  }

  async startUiPrompt(kind: string = 'confirm'): Promise<void> {
    this.activityValue = 'waiting_for_user'
    await this.emit('ui_prompt_start', { reason: 'ui_prompt', kind })
  }

  async endUiPrompt(kind: string = 'confirm'): Promise<void> {
    this.activityValue = 'idle'
    await this.emit('ui_prompt_end', { reason: 'ui_prompt', kind })
  }

  /** Model normal user input without exposing its contents to the adapter. */
  async submitInput(_text: string, _source: string = 'interactive'): Promise<'continue'> {
    return 'continue'
  }

  /** Test-only seam used to assert that no adapter path injects a message. */
  sendUserMessage(content: string): void {
    this.sentUserMessages.push(content)
  }

  /** Test-only seam used to assert that no adapter path controls a process. */
  performProcessAction(action: string): void {
    this.processActions.push(action)
  }

  enableManagedBridge(committed: Record<string, unknown>): void {
    this.managedBridgeValue = true
    this.lastCommittedValue = structuredClone(committed)
    this.managedBridgeWrites.push(structuredClone(committed))
  }

  disableManagedBridge(): void {
    this.managedBridgeValue = false
  }

  private registerHandler(
    event: string,
    handler: (payload: unknown, context: PiExtensionContext) => unknown | Promise<unknown>,
  ): () => void {
    if (typeof event !== 'string' || event.length === 0 || typeof handler !== 'function') {
      throw new TypeError('fake Pi event registration is invalid')
    }
    const handlers = this.handlers.get(event) ?? []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return () => {
      const current = this.handlers.get(event)
      if (current === undefined) return
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) this.handlers.delete(event)
    }
  }

  private async emit(event: string, payload: unknown): Promise<void> {
    const handlers = [...(this.handlers.get(event) ?? [])]
    for (const handler of handlers) await handler(payload, this.context)
  }
}
