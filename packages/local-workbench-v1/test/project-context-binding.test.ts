import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeRegistry, BRIDGE_LEASE_MS, BRIDGE_HEARTBEAT_MS, type BridgePeer } from '../runner/bridge-registry.ts'
import { BRIDGE_CAPABILITIES, PROJECT_CONTEXT_CAPABILITY, encodeBridgeFrame, decodeBridgeFrame, type BridgeFrame } from '../runner/bridge-protocol.ts'
import { projectExecutionContextDigest } from '../runner/canonical-hash.ts'
import { openWorkbenchRunner } from '../runner/runner.ts'
import { WorkbenchAuthority } from '../runner/authority.ts'
import { buildSnapshot } from '../runner/projection.ts'
import { validateSnapshot } from '../console/schema.ts'
import { createPiBridgeExtension } from '../runner/pi-bridge-extension.ts'

const processId = `process-${'a'.repeat(32)}`
const extensionId = `extension-${'b'.repeat(32)}`
const sessionId = 'pi-session-1'

function fakeGit(argv: readonly string[], cwd: string) {
  if (argv[0] === 'config') return { status: 1, stdout: '', stderr: '' }
  if (argv[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' }
  const answers: Record<string, string> = {
    'rev-parse --is-inside-work-tree': 'true',
    'rev-parse --is-bare-repository': 'false',
    'rev-parse --git-common-dir': '.git',
    'rev-parse --git-dir': '.git',
    'rev-parse --show-superproject-working-tree': '',
    'rev-parse --verify HEAD^{commit}': 'a'.repeat(40),
    'rev-parse --show-toplevel': cwd,
    'status --porcelain': '',
  }
  const answer = answers[argv.join(' ')]
  return answer === undefined
    ? { status: 128, stdout: '', stderr: 'unavailable' }
    : { status: 0, stdout: argv.join(' ') === 'status --porcelain' && answer === '' ? '' : `${answer}\n`, stderr: '' }
}

class Peer implements BridgePeer {
  readonly frames: BridgeFrame[] = []
  closed = false
  send(bytes: Buffer): void { this.frames.push(decodeBridgeFrame(bytes.subarray(0, -1))) }
  close(): void { this.closed = true }
}

function setup(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'lw-project-context-'))
  const projectPath = join(root, 'project')
  mkdirSync(join(root, 'state'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'runtime'), { recursive: true, mode: 0o700 })
  mkdirSync(join(projectPath, '.git'), { recursive: true })
  let monotonic = 100
  let serial = 0
  const runner = openWorkbenchRunner({ roots: { stateDir: join(root, 'state'), runtimeDir: join(root, 'runtime') } })
  const registry = new BridgeRegistry({ nodeId: runner.nodeId, store: runner.store, fences: runner.fences,
    now: () => monotonic, issue: prefix => `${prefix}-${(++serial).toString(16).padStart(32, '0')}` })
  const authority = new WorkbenchAuthority({ runner, sessionId: 'workbench-session', pluginGeneration: 1,
    git: fakeGit, registry })
  const registration = authority.inspect(projectPath)
  const project = authority.confirmRegistration(registration.inspectionId)
  const goal = authority.createGoal(project.projectId, 'Change the parser safely')
  const identity = { executionNodeId: runner.nodeId, processInstanceId: processId, piSessionId: sessionId, extensionInstanceId: extensionId }
  runner.store.transaction(() => {
    runner.store.putBinding({ runId: 'run-1', projectId: project.projectId, role: 'implementer', state: 'committed',
      bindingDigest: 'c'.repeat(64), controlEpoch: 1, writerState: 'none', predecessorRunId: null, generation: 1, updatedAt: Date.now() })
    runner.bindIdentity('run-1', goal.goalId, identity)
    runner.commitMembership('run-1')
    runner.store.setBindingState('run-1', 'ready', Date.now())
  })
  const digest = projectExecutionContextDigest(projectPath)
  const peer = new Peer()
  const body = { processInstanceId: processId, piSessionId: sessionId, extensionInstanceId: extensionId,
    hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES, PROJECT_CONTEXT_CAPABILITY],
    registrationAttempt: 1, sourceSequence: 1, lifecycle: 'running', activity: 'idle', health: 'healthy' }
  assert.throws(() => encodeBridgeFrame('register', 'register-unchallenged', { ...body, executionContextDigest: digest }), /invalid_bridge_envelope/)
  registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('register', 'register-1', body).subarray(0, -1)))
  t.after(() => { registry.close(); runner.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, projectPath, runner, registry, authority, project, goal, digest, peer,
    advance(ms: number) { monotonic += ms; return monotonic } }
}

test('Project context match requires the exact committed Goal Run and a fresh challenged digest', t => {
  const s = setup(t)
  const snapshot = () => validateSnapshot(buildSnapshot({ authority: s.authority, adoption: s.authority.adoption, connection: 'connected' }))
  assert.equal(snapshot().selectedProject?.contextMatch, false)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), false,
    'register establishes transport identity but cannot attest context before the connection challenge')

  const registered = s.peer.frames.find(frame => frame.type === 'registered')!.body
  const report = (executionContextDigest: string | null, sequence: number) => s.registry.receive(s.peer,
    decodeBridgeFrame(encodeBridgeFrame('heartbeat', `heartbeat-${sequence}`, {
      connectionId: registered.connectionId, connectionChallenge: registered.connectionChallenge, sourceSequence: sequence,
      lifecycle: 'running', activity: 'idle', health: 'healthy', executionContextDigest,
    }).subarray(0, -1)))
  report(s.digest, 2)
  assert.equal(snapshot().selectedProject?.contextMatch, true)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), true)

  s.advance(BRIDGE_HEARTBEAT_MS + 1000)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), true, 'the configured six-second freshness bound is inclusive')
  s.advance(1)
  assert.equal(s.registry.list()[0].available, true, 'the bridge lease is still current')
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), false, 'an otherwise-live connection cannot reuse an old cwd report')
  assert.equal(snapshot().selectedProject?.contextMatch, false)

  report(s.digest, 3)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), true)
  report('d'.repeat(64), 4)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), false, 'a fresh but mismatching context blocks the match')
  report(s.digest, 5)
  assert.equal(s.registry.projectContextMatches('run-1', join(s.root, 'different-project')), false, 'a Run cannot be matched to a path outside its committed Project')
  s.registry.disconnect(s.peer)
  assert.equal(s.registry.projectContextMatches('run-1', s.projectPath), false, 'a disconnected bridge cannot attest current context')
})

test('a context digest cannot be sent by a peer that did not negotiate the capability', t => {
  const s = setup(t)
  const peer = new Peer()
  s.registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('register', 'legacy-register', {
    processInstanceId: `process-${'1'.repeat(32)}`, piSessionId: 'legacy-session', extensionInstanceId: `extension-${'2'.repeat(32)}`,
    hostMode: 'tui', capabilities: [...BRIDGE_CAPABILITIES], registrationAttempt: 1, sourceSequence: 1,
    lifecycle: 'running', activity: 'idle', health: 'healthy',
  }).subarray(0, -1)))
  const registered = peer.frames.find(frame => frame.type === 'registered')!.body
  assert.throws(() => s.registry.receive(peer, decodeBridgeFrame(encodeBridgeFrame('heartbeat', 'legacy-context-report', {
    connectionId: registered.connectionId, connectionChallenge: registered.connectionChallenge, sourceSequence: 2,
    lifecycle: 'running', activity: 'idle', health: 'healthy', executionContextDigest: s.digest,
  }).subarray(0, -1))), /invalid_bridge_envelope/)
  assert.equal(s.registry.current(registered.observedSessionId as string)?.executionContextDigest, null)
})

test('same-process Pi extension sends only a digest of the canonical cwd, including through a symlink', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lw-pi-context-'))
  const project = join(root, 'project'), alias = join(root, 'alias')
  mkdirSync(project, { recursive: true })
  symlinkSync(project, alias)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sent: Array<{ type: string; body: Record<string, unknown> }> = []
  const scheduled: Array<() => void> = []
  let message = 0
  const hooks = new Map<string, (event: unknown, context: unknown) => void>()
  const extension = createPiBridgeExtension({
    navigate: null,
    newId: prefix => `${prefix}-${(++message).toString(16).padStart(32, '0')}`,
    schedule: callback => { scheduled.push(callback); return 0 as unknown as ReturnType<typeof setTimeout> },
    cancel: () => {},
    connect: async onFrame => ({
      sendFrame(type, _id, body) {
        sent.push({ type, body })
        if (type === 'register') onFrame({ protocol: 'omarchestra.bridge/v1', type: 'registered', messageId: 'registered-1', body: {
          observedSessionId: 'observed-1', executionNodeId: 'node-1', connectionId: `connection-${'e'.repeat(32)}`,
          connectionChallenge: `challenge-${'f'.repeat(32)}`, acceptedRegistrationAttempt: body.registrationAttempt,
          acceptedSourceSequence: body.sourceSequence, leaseDurationMs: BRIDGE_LEASE_MS, heartbeatIntervalMs: BRIDGE_HEARTBEAT_MS, mode: 'observed',
        } })
      },
      close() {},
    }),
  })
  extension({ on(name, handler) { hooks.set(name, handler as (event: unknown, context: unknown) => void) } })
  const context = { mode: 'tui', cwd: alias, sessionManager: { getSessionId: () => sessionId }, isIdle: () => true, ui: { setStatus() {} } }
  hooks.get('session_start')!(null, context)
  await new Promise(resolve => setImmediate(resolve))
  const registration = sent.find(frame => frame.type === 'register')!
  assert.equal(registration.body.executionContextDigest, undefined, 'an unchallenged register cannot attest the current context')
  assert.ok((registration.body.capabilities as string[]).includes(PROJECT_CONTEXT_CAPABILITY))
  assert.equal(JSON.stringify(registration).includes(project), false, 'the raw Project path never crosses the Pi bridge')
  assert.equal(JSON.stringify(registration).includes(alias), false, 'the raw symlink alias never crosses the Pi bridge')
  scheduled.shift()?.()
  const heartbeat = sent.find(frame => frame.type === 'heartbeat')!
  assert.equal(heartbeat.body.executionContextDigest, projectExecutionContextDigest(project))
  assert.equal(JSON.stringify(heartbeat).includes(project), false)
  context.cwd = 'relative-path'
  scheduled.shift()?.()
  const unavailableHeartbeat = sent.filter(frame => frame.type === 'heartbeat').at(-1)!
  assert.equal(unavailableHeartbeat.body.executionContextDigest, null, 'an unavailable/non-absolute cwd fails closed')
  assert.equal(JSON.stringify(unavailableHeartbeat).includes('relative-path'), false, 'invalid raw paths never cross the bridge')
  hooks.get('session_shutdown')!(null, context)
})
