/** PROTOTYPE — NOT PRODUCTION. Actual asynchronous Companion Adoption session. No I/O except injected ports. */
import { randomBytes } from 'node:crypto'
import { LiveAdoptionCompanion } from './live-adoption-companion.ts'
import type { LiveAdoptionRunner } from './live-adoption-runner.ts'
import { validateObserverProjectionSnapshot } from './companion-projection.ts'

export interface AdoptionPresentationShell {
  call(method: string, payload: string): Promise<string>
  fingerprint(): Promise<string>
}
const METHODS = ['adoptionOpen','adoptionApply','adoptionTakeIntent','adoptionIntentResult','adoptionClear']
export class LiveAdoptionPresentation {
  private readonly shell: AdoptionPresentationShell
  private readonly runner: LiveAdoptionRunner
  private readonly companion: LiveAdoptionCompanion
  private session: Record<string, unknown> | null = null
  private fingerprint = ''
  private readonly seen = new Map<string, { bytes: string; result: unknown }>()
  private tail: Promise<unknown> = Promise.resolve()
  private failure: unknown = null
  constructor(options: { shell: AdoptionPresentationShell; runner: LiveAdoptionRunner; executionNodeId: string; teamGoalId: string; roles: ('builder'|'coordinator'|'reviewer')[] }) {
    this.shell = options.shell
    this.runner = options.runner
    this.companion = new LiveAdoptionCompanion(options)
  }
  private async capabilities() {
    const raw = await this.shell.call('adoptionCapabilities','{}')
    if (raw.length > 4096) throw new Error('oversized Adoption capabilities')
    const caps = JSON.parse(raw)
    if (caps.version !== '0.4.0' || !Number.isSafeInteger(caps.pluginGeneration)
        || JSON.stringify(caps.methods) !== JSON.stringify(METHODS)) throw new Error('incompatible loaded Adoption method surface')
    return caps
  }
  private async verify() {
    const caps = await this.capabilities()
    if (!this.session || caps.pluginGeneration !== this.session.pluginGeneration
        || await this.shell.fingerprint() !== this.fingerprint) throw new Error('Adoption presentation generation or installation changed')
  }
  private snapshot() {
    const observed = validateObserverProjectionSnapshot(this.runner.snapshot())
    return { session:this.session, revision:observed.observerRevision,
      observerProjection: observed,
      managedCards: this.runner.managedSnapshot().managedCards,
      retiredCards: this.runner.retiredSnapshot().retiredCards }
  }
  private async call(method: string, value: unknown) {
    const result = await this.shell.call(method,JSON.stringify(value))
    if (result !== 'true') throw new Error('Adoption presentation update rejected')
  }
  async open() {
    if (this.session !== null) throw new Error('Adoption presentation is already open')
    const caps = await this.capabilities()
    this.fingerprint = await this.shell.fingerprint()
    this.session = { sessionId: `adoption-${randomBytes(16).toString('hex')}`, pluginGeneration:caps.pluginGeneration }
    await this.verify()
    await this.call('adoptionOpen',this.snapshot())
  }
  poll(): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.failure !== null) throw this.failure
      await this.verify()
      const raw = await this.shell.call('adoptionTakeIntent',JSON.stringify({session:this.session}))
      if (raw !== '') {
        if (raw.length > 8192) throw new Error('oversized Adoption intent')
        const envelope = JSON.parse(raw)
        if (JSON.stringify(envelope.session) !== JSON.stringify(this.session)) throw new Error('stale Adoption session')
        const intent = envelope.intent
        if (!intent || typeof intent.intentId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(intent.intentId)) throw new Error('invalid Adoption intent')
        const keys = Object.keys(intent).sort().join(',')
        if (intent.kind === 'request_adoption' ? keys !== 'choiceId,intentId,kind,observedSessionId'
          : intent.kind === 'authorize_adoption' ? keys !== 'intentId,kind,proposalDigest,proposalId' : true) throw new Error('invalid Adoption intent fields')
        const bytes = JSON.stringify(intent)
        let prior = this.seen.get(intent.intentId)
        if (prior && prior.bytes !== bytes) throw new Error('conflicting Adoption intent replay')
        if (!prior) {
          if (this.seen.size >= 128) throw new Error('Adoption intent session exhausted')
          const controllerResult = intent.kind === 'request_adoption'
            ? await this.companion.requestAdoption(intent) : await this.companion.authorizeAdoption(intent)
          // Only this live adapter's random session is an IPC identity. Do not
          // publish the controller's legacy test-facing session placeholder.
          const { session: _legacySession, ...result } = controllerResult
          prior = {bytes,result}
          this.seen.set(intent.intentId,prior)
        }
        await this.call('adoptionIntentResult',{session:this.session,result:prior.result})
      }
      await this.call('adoptionApply',this.snapshot())
    })
    this.tail = operation.catch(error => { this.failure = error })
    return operation
  }
  async close() {
    await this.tail
    if (!this.session) return
    await this.verify()
    await this.call('adoptionClear',{session:this.session})
    this.session = null
    this.seen.clear()
  }
}
