/** Pi-facing lifecycle adapter: only public, allow-listed source facts cross the wire. */
import { connect as netConnect, type Socket } from 'node:net'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { join } from 'node:path'
import { attachBridgeStream } from './bridge-channel.ts'
import { projectExecutionContextDigest, sha256, canonicalJson } from './canonical-hash.ts'
import { BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, PANE_NAVIGATION_CAPABILITY, PROJECT_CONTEXT_CAPABILITY, ASSIGNMENT_DELIVERY_CAPABILITY, CANDIDATE_SUBMISSION_CAPABILITY, QUIESCENCE_CAPABILITY, bridgeId, type BridgeFrame } from './bridge-protocol.ts'
import { validateCandidateSubmission, type CandidateSubmission } from './candidate.ts'

import { showLocalTerminalPane } from './local-pane-navigation.ts'
import type { NavigationResult } from './pane-navigation.ts'

type Context = { mode: string; cwd?: string; sessionManager: { getSessionId(): string | undefined }; isIdle(): boolean; hasPendingMessages?(): boolean; ui: { setStatus(key: string, text: string | undefined): void } }
export interface CandidateTool {
  name: string; label: string; description: string; parameters: Record<string, unknown>
  execute(toolCallId: string, parameters: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; details: CandidateSubmitOutcome }>
}
type PiAPI = { on(name: string, handler: (event: unknown, ctx: Context) => void): void; sendUserMessage?: (text: string) => unknown; registerTool?: (tool: CandidateTool) => void }
type Client = { sendFrame(type: 'register' | 'heartbeat' | 'input_observed' | 'close' | 'adoption_ack' | 'binding_receipt' | 'recovery_proof' | 'focus_result' | 'assignment_ack' | 'assignment_receipt' | 'candidate_submission' | 'quiescence_report', id: string, body: Record<string, unknown>): void; close(): void }
/** One bounded C6 Candidate submission outcome, settled by an exact receipt. */
export interface CandidateSubmitOutcome { outcome: 'accepted' | 'duplicate' | 'invalid' | 'unknown'; candidateId: string | null; digest: string | null; reason: string | null }
/** Install in Pi, but also expose the dedicated Candidate submission port. */
export interface PiBridgeExtension { (pi: PiAPI): void; submitCandidate(payload: unknown): Promise<CandidateSubmitOutcome> }
const CANDIDATE_RECEIPT_DEADLINE_MS = 5_000
export function connectLocalPiBridge(path: string, onFrame: (frame: BridgeFrame) => void, onClose: () => void): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket: Socket = netConnect(path)
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('bridge_timeout')) }, 1000)
    timer.unref()
    const fail = () => { clearTimeout(timer); socket.destroy(); reject(new Error('bridge_unavailable')) }
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer); socket.off('error', fail)
      resolve(attachBridgeStream(socket, { onFrame: (_peer, frame) => onFrame(frame), onClose }))
    })
  })
}
/** Injectable fake Pi host and paired-channel connector; no work in the factory. */
export function createPiBridgeExtension(options: { socketPath?: string; connect?: (onFrame: (frame: BridgeFrame) => void, onClose: () => void) => Promise<Client>; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void; newId?: (prefix: string) => string; navigate?: ((isCurrent: () => boolean) => Promise<NavigationResult>) | null } = {}): PiBridgeExtension {
  const issue = options.newId ?? bridgeId
  const navigate = options.navigate === undefined ? showLocalTerminalPane : options.navigate
  const processInstanceId = issue('process')
  const extensionInstanceId = issue('extension')
  const connect = options.connect ?? ((onFrame, onClose) => connectLocalPiBridge(options.socketPath ?? join(process.env.XDG_RUNTIME_DIR ?? '/nonexistent', 'omarchestra-bridge.sock'), onFrame, onClose))
  const schedule = options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref(); return timer })
  const cancel = options.cancel ?? clearTimeout
  const install = ((pi: PiAPI) => {
    let ctx: Context | null = null, client: Client | null = null
    let sessionId: string | null = null, observedSessionId: string | null = null, connectionId: string | null = null, challenge: string | null = null
    let sessionCode: string | null = null
    let focusSequence = 0, activeFocus: object | null = null
    let attempt = 0, sequence = 0, connecting = false, stopped = true, retryMs = 500, mode: 'observed' | 'committed' = 'observed'
    let acknowledged: string | null = null
    let committed: { runId: string; digest: string; goalId: string; role: string; state: 'connecting' | 'ready' | 'manual_takeover' } | null = null
    // Extension-owned dedup evidence for one stable delivery identity. It lives
    // only for this Pi session and never inherits across reload, restart or reboot.
    let assignmentReceipts = new Map<string, { assignmentId: string; attemptId: string; runId: string; payloadDigest: string; outcome: 'accepted' | 'unknown' }>()
    // One in-flight C6 submission per stable submission id, settled only by the
    // exact receipt from the owner on this connection. Never retained across stop.
    let pendingSubmissions = new Map<string, (outcome: CandidateSubmitOutcome) => void>()
    let currentAssignment: { assignmentId: string; attemptId: string; agentRunId: string; controlEpoch: number; deliveryId: string } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null, generation = 0, pendingInput: string | null = null, handshakeTicks = 0
    const status = () => { try {
      const state = mode === 'observed' ? acknowledged ? 'Unassigned · adoption pending' : 'Unassigned · observed'
        : committed ? `${committed.role} · ${committed.state === 'manual_takeover' ? 'manual takeover' : committed.state}` : 'reconciling'
      ctx?.ui.setStatus('omarchestra-observer-status', client && connectionId
        ? `${sessionCode ? `Pi ${sessionCode}` : 'Session code unavailable'} · ${state}` : undefined)
    } catch { /* never disrupt Pi or replace other extensions' status slots */ } }
    const activity = () => { try { return ctx && ctx.isIdle() && !ctx.hasPendingMessages?.() ? 'idle' : 'busy' } catch { return 'unknown' } }
    // `cwd` is a same-process execution-context fact, never Adoption identity.
    // Resolve it locally and send only a domain-separated digest to the owner.
    const executionContextDigest = () => {
      const cwd = ctx?.cwd
      if (typeof cwd !== 'string' || !cwd.isWellFormed() || !isAbsolute(cwd) || Buffer.byteLength(cwd) > 4096) return null
      try {
        const canonical = realpathSync.native(cwd)
        if (!isAbsolute(canonical) || !statSync(canonical).isDirectory()) return null
        return projectExecutionContextDigest(canonical)
      } catch { return null }
    }
    const clearTimer = () => { if (timer) cancel(timer); timer = null }
    const send = (type: 'heartbeat' | 'input_observed' | 'close' | 'adoption_ack' | 'binding_receipt' | 'recovery_proof' | 'focus_result' | 'assignment_ack' | 'assignment_receipt' | 'candidate_submission' | 'quiescence_report', extra: Record<string, unknown> = {}) => {
      if (!client || !connectionId || !challenge) return false
      sequence += 1
      try { client.sendFrame(type, issue('message'), { connectionId, connectionChallenge: challenge, sourceSequence: sequence, ...extra }); return true }
      catch { client.close(); return false }
    }
    const heartbeat = () => {
      timer = null
      if (stopped) return
      if (client && connectionId) send('heartbeat', { lifecycle: 'running', activity: activity(), health: 'healthy', executionContextDigest: executionContextDigest() })
      else if (client && ++handshakeTicks > 2) client.close()
      else if (!client) void open()
      timer = schedule(heartbeat, client && connectionId ? 5000 : retryMs)
    }
    const open = async () => {
      if (connecting || stopped || !ctx || !sessionId) return
      connecting = true
      const current = generation
      try {
        const channel = await connect(frame => {
          if (current !== generation || !client) return
          if (frame.type === 'focus_request' && navigate && connectionId && challenge) {
            const b = frame.body
            if (stopped || !ctx || ctx.mode !== 'tui' || ctx.sessionManager.getSessionId() !== sessionId
                || b.processInstanceId !== processInstanceId || b.piSessionId !== sessionId || b.extensionInstanceId !== extensionInstanceId
                || b.connectionId !== connectionId || b.connectionChallenge !== challenge || b.observedSessionId !== observedSessionId
                || (b.requestSequence as number) <= focusSequence) return
            focusSequence = b.requestSequence as number
            if (activeFocus) { send('focus_result', { requestId: b.requestId, status: 'unknown' }); return }
            const operation = {}, source = client, connection = connectionId, expires = performance.now() + (b.remainingMs as number)
            activeFocus = operation
            const isCurrent = () => {
              try { return activeFocus === operation && current === generation && !stopped && client === source
                && connectionId === connection && performance.now() < expires && ctx?.sessionManager.getSessionId() === sessionId }
              catch { return false } // a host-context failure must never reject an unobserved promise
            }
            void Promise.resolve().then(() => isCurrent() ? navigate(isCurrent) : 'unavailable' as const)
              .then(result => { if (isCurrent()) send('focus_result', { requestId: b.requestId, status: result }) })
              .catch(() => { if (isCurrent()) send('focus_result', { requestId: b.requestId, status: 'unknown' }) })
              .finally(() => { if (activeFocus === operation) activeFocus = null })
            return
          }
          if (frame.type === 'input_received' && connectionId && challenge
              && frame.body.connectionId === connectionId && frame.body.connectionChallenge === challenge
              && frame.body.eventId === pendingInput) { pendingInput = null; return }
          if (frame.type === 'adoption_cancelled' && connectionId && challenge && !committed
              && frame.body.connectionId === connectionId && frame.body.connectionChallenge === challenge
              && frame.body.proposalDigest === acknowledged) {
            acknowledged = null; status(); return
          }
          if (frame.type === 'adoption_request' && connectionId && challenge) {
            const b = frame.body
            if (stopped || !ctx || ctx.mode !== 'tui' || ctx.sessionManager.getSessionId() !== sessionId
                || b.processInstanceId !== processInstanceId || b.piSessionId !== sessionId
                || b.extensionInstanceId !== extensionInstanceId || b.connectionId !== connectionId
                || b.connectionChallenge !== challenge || b.observedSessionId !== observedSessionId
                || b.remainingMs === 0 || mode !== 'observed') return
            const currentActivity = activity()
            const allowed = currentActivity === 'idle' && !pendingInput && !acknowledged
            if (allowed) acknowledged = b.proposalDigest as string // retain across uncertain socket write
            send('adoption_ack', { proposalId: b.proposalId, proposalDigest: b.proposalDigest,
              acknowledgementNonce: b.acknowledgementNonce, observedSessionId: b.observedSessionId,
              processInstanceId, piSessionId: sessionId, extensionInstanceId,
              decision: allowed ? 'acknowledged' : 'refused', activity: currentActivity })
            status()
            return
          }
          if (frame.type === 'recovery_request' && connectionId && challenge && mode === 'committed') {
            const b = frame.body
            if (b.processInstanceId !== processInstanceId || b.piSessionId !== sessionId || b.extensionInstanceId !== extensionInstanceId
                || b.connectionId !== connectionId || b.connectionChallenge !== challenge
                || (committed?.digest ?? acknowledged) !== b.bindingDigest || (committed && committed.runId !== b.runId)) return
            send('recovery_proof', { runId: b.runId, bindingDigest: b.bindingDigest, processInstanceId, piSessionId: sessionId,
              extensionInstanceId, pendingInput: pendingInput !== null })
            return
          }
          if (frame.type === 'managed_status' && connectionId && challenge && committed
              && frame.body.connectionId === connectionId && frame.body.connectionChallenge === challenge
              && frame.body.runId === committed.runId && frame.body.bindingDigest === committed.digest) {
            committed.state = frame.body.state as 'ready' | 'manual_takeover'; status(); return
          }
          if (frame.type === 'quiescence_request' && connectionId && challenge) {
            const b = frame.body
            if (b.connectionId !== connectionId || b.connectionChallenge !== challenge || mode !== 'committed'
                || b.runId !== committed?.runId || b.attemptId !== currentAssignment?.attemptId
                || b.controlEpoch !== currentAssignment?.controlEpoch) return
            send('quiescence_report', { requestId: b.requestId, runId: b.runId, attemptId: b.attemptId, controlEpoch: b.controlEpoch,
              activity: committed.state === 'ready' ? activity() : 'unknown', pendingInput: pendingInput !== null,
              executionContextDigest: executionContextDigest() })
            return
          }
          if (frame.type === 'assignment_delivery' && connectionId && challenge) {
            const b = frame.body
            if (stopped || !ctx || ctx.mode !== 'tui' || ctx.sessionManager.getSessionId() !== sessionId
                || mode !== 'committed' || !committed
                || b.connectionId !== connectionId || b.connectionChallenge !== challenge || b.runId !== committed.runId) return
            const ack = (outcome: 'accepted' | 'busy' | 'duplicate' | 'invalid' | 'unknown', storedOutcome: 'accepted' | 'unknown' | null, reason: string | null) =>
              send('assignment_ack', { deliveryId: b.deliveryId, assignmentId: b.assignmentId, attemptId: b.attemptId,
                runId: b.runId, payloadDigest: b.payloadDigest, outcome, storedOutcome, reason })
            // The payload must be the exact admitted Assignment frame it claims.
            let payload: Record<string, unknown> | null = null
            try {
              const parsed: unknown = JSON.parse(b.payloadJson as string)
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
            } catch { payload = null }
            const exact = payload !== null && payload.protocol === 'omarchestra.assignment/v1' && payload.kind === 'assignment_delivery'
              && payload.deliveryId === b.deliveryId && payload.assignmentId === b.assignmentId
              && payload.attemptId === b.attemptId && payload.runId === b.runId && sha256(b.payloadJson as string) === b.payloadDigest
            if (!exact) { ack('invalid', null, 'payload_mismatch'); return }
            const prior = assignmentReceipts.get(b.deliveryId as string)
            if (prior) {
              // A duplicate must prove the exact stored identity; a conflicting
              // reuse of one delivery id never creates a second turn.
              if (prior.assignmentId === b.assignmentId && prior.attemptId === b.attemptId && prior.runId === b.runId && prior.payloadDigest === b.payloadDigest) ack('duplicate', prior.outcome, null)
              else ack('invalid', null, 'delivery_conflict')
              return
            }
            if (committed.state !== 'ready' || activity() !== 'idle' || pendingInput) { ack('busy', null, 'not_idle'); return }
            const binding = payload.runBinding as Record<string, unknown> | undefined
            const context = payload.context as Record<string, unknown> | undefined
            if (!binding || binding.connectionId !== connectionId || binding.connectionChallenge !== challenge
                || binding.processInstanceId !== processInstanceId || binding.piSessionId !== sessionId
                || binding.extensionInstanceId !== extensionInstanceId || binding.bindingDigest !== committed.digest
                || !Number.isSafeInteger(payload.controlEpoch) || Number(payload.controlEpoch) < 0
                || typeof context?.canonicalPath !== 'string'
                || executionContextDigest() !== projectExecutionContextDigest(context.canonicalPath)) { ack('invalid', null, 'context_changed'); return }
            const taskText = typeof payload.taskText === 'string' ? payload.taskText : null
            if (taskText === null || taskText.length === 0) { ack('invalid', null, 'payload_mismatch'); return }
            if (typeof pi.sendUserMessage !== 'function') { ack('invalid', null, 'unsupported'); return }
            if (assignmentReceipts.size >= 64) { ack('invalid', null, 'receipt_capacity'); return }
            // Write-ahead receipt: a throwing/async API may already have accepted
            // input. Never classify that interval as not-sent or invoke it again.
            const receipt = { assignmentId: b.assignmentId as string, attemptId: b.attemptId as string, runId: b.runId as string, payloadDigest: b.payloadDigest as string, outcome: 'unknown' as 'accepted' | 'unknown' }
            assignmentReceipts.set(b.deliveryId as string, receipt)
            try {
              const returned = pi.sendUserMessage(taskText)
              if (returned && typeof (returned as Promise<unknown>).then === 'function') {
                void Promise.resolve(returned).catch(() => {})
                ack('unknown', null, 'send_unproven'); return
              }
            } catch { ack('unknown', null, 'send_unproven'); return }
            // Retain evidence before the ACK so a lost ACK stays reconcilable.
            receipt.outcome = 'accepted'
            currentAssignment = { assignmentId: b.assignmentId as string, attemptId: b.attemptId as string,
              agentRunId: b.runId as string, controlEpoch: payload.controlEpoch as number, deliveryId: b.deliveryId as string }
            ack('accepted', null, null)
            return
          }
          if (frame.type === 'assignment_receipt_request' && connectionId && challenge) {
            const b = frame.body
            if (b.connectionId !== connectionId || b.connectionChallenge !== challenge || mode !== 'committed') return
            const prior = assignmentReceipts.get(b.deliveryId as string)
            const matches = !!prior && prior.assignmentId === b.assignmentId && prior.attemptId === b.attemptId
              && prior.runId === b.runId && prior.payloadDigest === b.payloadDigest
            send('assignment_receipt', { requestId: b.requestId, deliveryId: b.deliveryId, assignmentId: b.assignmentId,
              attemptId: b.attemptId, runId: b.runId, payloadDigest: b.payloadDigest, known: matches, outcome: matches ? prior!.outcome : null })
            return
          }
          if (frame.type === 'candidate_receipt' && connectionId && challenge) {
            const b = frame.body
            if (b.connectionId !== connectionId || b.connectionChallenge !== challenge || b.runId !== committed?.runId) return
            settleSubmission(b.submissionId as string, { outcome: b.outcome as CandidateSubmitOutcome['outcome'],
              candidateId: (b.candidateId as string | null) ?? null, digest: (b.digest as string | null) ?? null, reason: (b.reason as string | null) ?? null })
            return
          }
          if (frame.type === 'adoption_committed' && connectionId && challenge) {
            const b = frame.body
            if (b.processInstanceId !== processInstanceId || b.piSessionId !== sessionId || b.extensionInstanceId !== extensionInstanceId
                || b.connectionId !== connectionId || b.connectionChallenge !== challenge
                || (committed?.digest ?? acknowledged) !== b.bindingDigest || (committed && committed.runId !== b.runId)) return
            committed = { runId: b.runId as string, digest: b.bindingDigest as string, goalId: b.goalId as string,
              role: b.role as string, state: 'connecting' }
            mode = 'committed'; status()
            send('binding_receipt', { runId: committed.runId, bindingDigest: committed.digest, activity: activity(), pendingInput: pendingInput !== null })
            if (pendingInput) send('input_observed', { eventId: pendingInput })
            return
          }
          if (frame.type !== 'registered' || connectionId) return
          const b = frame.body
          if (b.acceptedRegistrationAttempt !== attempt || b.acceptedSourceSequence !== sequence) { client.close(); return }
          observedSessionId = b.observedSessionId as string
          sessionCode = typeof b.sessionCode === 'string' ? b.sessionCode : null
          focusSequence = 0; activeFocus = null
          connectionId = b.connectionId as string; challenge = b.connectionChallenge as string
          handshakeTicks = 0; retryMs = 500; mode = b.mode as 'observed' | 'committed'
          if (committed && mode !== 'committed') { client.close(); return }
          if (mode === 'observed') acknowledged = null // previous connection's authorization was abandoned
          status()
          if (mode === 'committed') {
            if (committed) send('recovery_proof', { runId: committed.runId, bindingDigest: committed.digest,
              processInstanceId, piSessionId: sessionId, extensionInstanceId, pendingInput: pendingInput !== null })
            // Source-only pending input is conservative even when a previously
            // sent commitment was lost and the extension lacks its Run ID.
            if (pendingInput) send('input_observed', { eventId: pendingInput })
          }
        }, () => {
          if (current !== generation) return
          client = null; observedSessionId = null; sessionCode = null; connectionId = null; challenge = null; retryMs = Math.min(5000, retryMs * 2); status()
        })
        if (current !== generation || stopped) { channel.close(); return }
        client = channel; handshakeTicks = 0; attempt += 1; sequence += 1
        channel.sendFrame('register', issue('message'), { processInstanceId, piSessionId: sessionId, extensionInstanceId, hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, SESSION_CODE_CAPABILITY, ...(navigate ? [PANE_NAVIGATION_CAPABILITY] : []), PROJECT_CONTEXT_CAPABILITY, ASSIGNMENT_DELIVERY_CAPABILITY, CANDIDATE_SUBMISSION_CAPABILITY, ...(pi.registerTool && pi.sendUserMessage ? [QUIESCENCE_CAPABILITY] : [])], registrationAttempt: attempt, sourceSequence: sequence, lifecycle: 'running', activity: activity(), health: 'healthy' })
      } catch { retryMs = Math.min(5000, retryMs * 2) /* fail open; scheduled retry */ }
      finally { connecting = false }
    }
    const stop = (reason: string) => {
      generation += 1; stopped = true; activeFocus = null; clearTimer()
      if (client) { send('close', { reason }); client.close() }
      client = null; observedSessionId = null; sessionCode = null; connectionId = null; challenge = null; status(); ctx = null; sessionId = null
      assignmentReceipts = new Map()
      currentAssignment = null
      for (const settle of pendingSubmissions.values()) settle({ outcome: 'unknown', candidateId: null, digest: null, reason: 'session_stopped' })
      pendingSubmissions = new Map()
    }
    const settleSubmission = (submissionId: string, outcome: CandidateSubmitOutcome) => {
      const settle = pendingSubmissions.get(submissionId)
      if (!settle) return
      pendingSubmissions.delete(submissionId)
      settle(outcome)
    }
    // Dedicated structured C6 submission port. It never inspects a chat turn:
    // the exact bounded payload is framed, then settled only by the exact
    // candidate_receipt (or a bounded unknown on timeout/stop).
    const submitCandidate = async (payload: unknown): Promise<CandidateSubmitOutcome> => {
      let submission: CandidateSubmission
      try { submission = validateCandidateSubmission(payload) }
      catch { return { outcome: 'invalid', candidateId: null, digest: null, reason: 'invalid_submission' } }
      if (stopped || mode !== 'committed' || !committed || !client || !connectionId || !challenge) {
        return { outcome: 'invalid', candidateId: null, digest: null, reason: 'not_committed' }
      }
      if (submission.agentRunId !== committed.runId) {
        return { outcome: 'invalid', candidateId: null, digest: null, reason: 'run_mismatch' }
      }
      const payloadJson = canonicalJson(submission), payloadDigest = sha256(payloadJson)
      const submissionId = issue('candidate')
      const result = new Promise<CandidateSubmitOutcome>(resolve => {
        const timer = schedule(() => settleSubmission(submissionId, { outcome: 'unknown', candidateId: null, digest: null, reason: 'receipt_timeout' }), CANDIDATE_RECEIPT_DEADLINE_MS)
        pendingSubmissions.set(submissionId, outcome => { cancel(timer); resolve(outcome) })
      })
      if (!send('candidate_submission', { runId: committed.runId, submissionId, payloadDigest, payloadJson })) {
        settleSubmission(submissionId, { outcome: 'unknown', candidateId: null, digest: null, reason: 'transport_unavailable' })
      }
      return result
    }
    // Pi's model-callable tool is the production entry. JSON Schema is the
    // serializable TypeBox schema format; core validation additionally enforces
    // byte bounds and the closed payload. Never accept caller-authored identity.
    pi.registerTool?.({
      name: 'omarchestra_submit_candidate', label: 'Submit Assignment Candidate',
      description: 'Submit the current Omarchestra Assignment result for its configured acceptance check. Supply an explicit summary and relative artifact references (SHA-256 hex and byte length). This does not accept the work or grant write authority. Available only after this Pi received an Assignment.',
      parameters: { type: 'object', additionalProperties: false, required: ['summary', 'artifactRefs'], properties: {
        summary: { type: 'string', minLength: 1, maxLength: 8192 },
        artifactRefs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['path', 'digest', 'length'], properties: {
          path: { type: 'string', minLength: 1, maxLength: 4096 }, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          length: { type: 'integer', minimum: 0, maximum: 16777216 },
        } } },
      } },
      async execute(_toolCallId, parameters) {
        let result: CandidateSubmitOutcome = { outcome: 'invalid', candidateId: null, digest: null, reason: 'no_current_assignment' }
        if (currentAssignment && committed?.state === 'ready' && !pendingInput
            && assignmentReceipts.get(currentAssignment.deliveryId)?.outcome === 'accepted') {
          if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
              || Object.keys(parameters).sort().join(',') !== 'artifactRefs,summary') {
            result = { ...result, reason: 'invalid_submission' }
          } else {
            const { deliveryId: _deliveryId, ...identity } = currentAssignment
            result = await submitCandidate({ ...parameters, ...identity })
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
      },
    })
    pi.on('session_start', (_event, context) => {
      stop('new')
      if (context.mode !== 'tui') return
      const id = context.sessionManager.getSessionId()
      if (!id) return
      ctx = context; sessionId = id; stopped = false; retryMs = 500; mode = 'observed'; pendingInput = null; acknowledged = null; committed = null
      void open(); timer = schedule(heartbeat, 500)
    })
    pi.on('session_switch', (_event, context) => { stop('resume'); acknowledged = null; committed = null; pendingInput = null; mode = 'observed'; if (context.mode === 'tui') { const id = context.sessionManager.getSessionId(); if (id) { ctx = context; sessionId = id; stopped = false; void open(); timer = schedule(heartbeat, 500) } } })
    pi.on('input', (event) => {
      // Never inspect text, length, metadata, or editor. Interactive submission only.
      if (event && typeof event === 'object' && (event as { source?: unknown }).source === 'interactive' && (mode === 'committed' || acknowledged)) {
        pendingInput ??= issue('input')
        if (mode === 'committed') send('input_observed', { eventId: pendingInput })
      }
    })
    pi.on('session_shutdown', () => stop('quit'))
    install.submitCandidate = submitCandidate
  }) as PiBridgeExtension
  return install
}
