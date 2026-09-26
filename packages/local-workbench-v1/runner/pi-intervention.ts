/** Same-process operator handoff/resume. No work before an exact managed request. */
import { canonicalJson, sha256 } from './canonical-hash.ts'
import type { BridgeFrame, BridgeType } from './bridge-protocol.ts'
import { validateHandoffContent } from './intervention-protocol.ts'
import type { PiTool } from './pi-bridge-extension.ts'

export class PiIntervention {
  private receipts = new Map<string, { digest: string; outcome: string }>()
  private request: Record<string, unknown> | null = null
  private pending = new Map<string, (outcome: string) => void>()
  private readonly port: {
    current(body: Record<string, unknown>): boolean
    idle(): boolean; pendingInput(): boolean; context(): string | null
    send(type: BridgeType, body: Record<string, unknown>): boolean
    message(text: string): unknown; resume(epoch: number): void
  }
  constructor(port: {
    current(body: Record<string, unknown>): boolean
    idle(): boolean; pendingInput(): boolean; context(): string | null
    send(type: BridgeType, body: Record<string, unknown>): boolean
    message(text: string): unknown; resume(epoch: number): void
  }) { this.port = port }
  invalidate(): void { this.request = null }
  close(): void {
    this.invalidate(); this.receipts.clear()
    for (const settle of this.pending.values()) settle('unknown')
    this.pending.clear()
  }
  receive(frame: BridgeFrame): boolean {
    const b = frame.body
    if (frame.type === 'handoff_receipt') {
      this.pending.get(`${b.requestId}:${b.payloadDigest}`)?.(String(b.outcome))
      return true
    }
    if (frame.type !== 'control_request') return false
    if (!this.port.current(b)) return true
    const reply = (outcome: string) => this.port.send('control_response', {
      requestId: b.requestId, runId: b.runId, bindingDigest: b.bindingDigest, controlEpoch: b.controlEpoch,
      operation: b.operation, outcome, activity: this.port.idle() ? 'idle' : 'busy',
      pendingInput: this.port.pendingInput(), executionContextDigest: this.port.context(),
    })
    if (b.operation === 'probe') { reply('accepted'); return true }
    const key = String(b.requestId), digest = sha256(b), prior = this.receipts.get(key)
    if (prior) { reply(prior.digest === digest ? prior.outcome : 'invalid'); return true }
    if (!this.port.idle() || this.port.pendingInput()) { reply('busy'); return true }
    if (this.receipts.size >= 64) { reply('invalid'); return true }
    const receipt = { digest, outcome: 'unknown' }
    this.receipts.set(key, receipt) // retain before any possibly successful API call
    if (b.operation === 'resume') {
      this.invalidate(); this.port.resume(Number(b.controlEpoch)); receipt.outcome = 'accepted'; reply('accepted'); return true
    }
    this.request = { ...b }
    try {
      const result = this.port.message('Omarchestra: the operator requested Return to team for this Pi. Do not start or continue implementation. Review your work and call omarchestra_submit_handoff with a concise summary, relative artifact references, claimedState (candidate, partial, or blocked), and outstandingEffects (none_reported, may_be_active, or unknown). Report possible running tools honestly. This handoff does not resume work or accept a result.')
      if (result && typeof (result as Promise<unknown>).then === 'function') void Promise.resolve(result).catch(() => {})
      else receipt.outcome = 'accepted'
    } catch { /* possibly delivered: never resend or invent not-sent */ }
    reply(receipt.outcome)
    return true
  }
  tool(): PiTool {
    return {
      name: 'omarchestra_submit_handoff', label: 'Return to team handoff',
      description: 'Respond only to the current explicit Omarchestra Return to team request. Report prior work and outstanding effects without doing further work. This neither accepts an Assignment nor resumes dispatch.',
      parameters: { type: 'object', additionalProperties: false, required: ['summary', 'artifactRefs', 'claimedState', 'outstandingEffects'], properties: {
        summary: { type: 'string', minLength: 1, maxLength: 8192 },
        claimedState: { type: 'string', enum: ['candidate', 'partial', 'blocked'] },
        outstandingEffects: { type: 'string', enum: ['none_reported', 'may_be_active', 'unknown'] },
        artifactRefs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['path', 'digest', 'length'], properties: {
          path: { type: 'string', minLength: 1, maxLength: 4096 }, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          length: { type: 'integer', minimum: 0, maximum: 16777216 },
        } } },
      } },
      execute: async (_id, parameters) => {
        let outcome = 'invalid'
        const request = this.request
        try {
          const content = validateHandoffContent(parameters)
          if (request && this.port.current(request) && !this.port.pendingInput()) {
            const payloadJson = canonicalJson(content), payloadDigest = sha256(payloadJson)
            const key = `${request.requestId}:${payloadDigest}`
            if (!this.pending.has(key)) outcome = await new Promise<string>(resolve => {
              const timer = setTimeout(() => settle('unknown'), 5000)
              const settle = (result: string) => { clearTimeout(timer); this.pending.delete(key); resolve(result) }
              this.pending.set(key, settle)
              if (!this.port.send('handoff_submission', { requestId: request.requestId, runId: request.runId,
                bindingDigest: request.bindingDigest, controlEpoch: request.controlEpoch, payloadJson, payloadDigest })) settle('unknown')
            })
          }
        } catch { outcome = 'invalid' }
        return { content: [{ type: 'text', text: JSON.stringify({ outcome }) }], details: { outcome } }
      },
    }
  }
}
