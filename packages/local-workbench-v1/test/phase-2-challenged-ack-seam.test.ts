import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { attachBridgeStream } from '../runner/bridge-channel.ts'
import { BridgeRegistry } from '../runner/bridge-registry.ts'
import { encodeBridgeFrame, type BridgeFrame } from '../runner/bridge-protocol.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
class Stream extends EventEmitter {
  other!: Stream; dead = false
  write(bytes: Buffer) { if (this.dead) throw Error('closed'); this.other.emit('data', bytes); return true }
  destroy() { if (this.dead) return; this.dead = true; this.emit('close'); if (!this.other.dead) this.other.destroy() }
}
function pair() { const a = new Stream(), b = new Stream(); a.other = b; b.other = a; return { a, b } }
const processId = 'process-' + 'a'.repeat(32), extensionId = 'extension-' + 'b'.repeat(32)
test('same-process fake Pi replies on exact challenged channel, refusing busy and wrong incarnation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wb-ack-seam-'))
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state') } })
  t.after(() => { runner.close(); rmSync(root, { recursive: true, force: true }) })
  const received: BridgeFrame[] = []
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences, onAdoptionAck: e => received.push(e.frame) })
  const hooks = new Map<string, (e: unknown, ctx: unknown) => void>()
  let idle = true, currentSession = 'pi-session'
  let registered: BridgeFrame | null = null
  const context = { mode: 'tui', sessionManager: { getSessionId: () => currentSession }, isIdle: () => idle, ui: { setStatus() {} } }
  let n = 0
  createPiBridgeExtension({ newId: prefix => prefix === 'process' ? processId : prefix === 'extension' ? extensionId : `${prefix}-${(++n).toString(16).padStart(32, '0')}`,
    schedule: () => 0 as unknown as ReturnType<typeof setTimeout>,
    connect: async (onFrame, onClose) => {
      const { a, b } = pair()
      attachBridgeStream(a, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
      return attachBridgeStream(b, { onFrame: (_peer, frame) => { if (frame.type === 'registered') registered = frame; onFrame(frame) }, onClose })
    },
  })({ on(name, fn) { hooks.set(name, fn as (e: unknown, ctx: unknown) => void) } })
  hooks.get('session_start')!(null, context)
  await new Promise(resolve => setImmediate(resolve))
  const session = registry.list()[0]
  assert.equal(session?.mode, 'observed')
  assert.ok(registered)
  const b = registered.body
  const peer = registry.currentPeer(session.observedSessionId, b.connectionId as string, b.connectionChallenge as string)
  assert.ok(peer)
  const request = { proposalId: 'proposal-1', proposalDigest: 'f'.repeat(64), acknowledgementNonce: 'nonce-' + 'd'.repeat(32),
    observedSessionId: session.observedSessionId, processInstanceId: processId, piSessionId: 'pi-session', extensionInstanceId: extensionId,
    connectionId: b.connectionId, connectionChallenge: b.connectionChallenge, targetGoalId: 'goal-1', targetRole: 'implementer', vacancyGeneration: 1, remainingMs: 5000 }
  peer.send(encodeBridgeFrame('adoption_request', 'request-wrong', { ...request, processInstanceId: 'process-' + 'e'.repeat(32) }))
  peer.send(encodeBridgeFrame('adoption_request', 'request-wrong-observed', { ...request, observedSessionId: 'observed-foreign' }))
  peer.send(encodeBridgeFrame('adoption_request', 'request-wrong-challenge', { ...request, connectionChallenge: 'challenge-' + 'e'.repeat(32) }))
  currentSession = 'new-session'
  peer.send(encodeBridgeFrame('adoption_request', 'request-switched-session', request))
  assert.equal(received.length, 0)
  currentSession = 'pi-session'
  idle = false
  peer.send(encodeBridgeFrame('adoption_request', 'request-busy', request))
  assert.equal(received[0]?.body.decision, 'refused')
  idle = true
  peer.send(encodeBridgeFrame('adoption_request', 'request-idle', request))
  assert.equal(received[1]?.body.decision, 'acknowledged')
  assert.equal(received[1]?.body.sourceSequence, 3)
  assert.equal(registry.currentPeer(session.observedSessionId, b.connectionId as string, 'challenge-' + 'e'.repeat(32)), null)
  assert.equal(runner.store.listBindings().length, 0, 'ACK alone has no management effect')
  hooks.get('session_shutdown')!(null, context)
  assert.equal(runner.store.listBindings().length, 0)
})
