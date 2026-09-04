import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { COMPANION_RELEASE } from '../releases.ts'

/**
 * Integrated Companion acceptance seam — tests precede implementation.
 *
 * This suite composes the public installation and Projection Session seams.
 * It is fake-only: no user configuration, shell IPC, GUI, Pi, provider,
 * Boomux, SSH, Hyprland, systemd, or live installation is contacted.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROTOTYPE_ROOT = path.resolve(TEST_DIR, '..', '..')
const COMPANION_ROOT = path.join(PROTOTYPE_ROOT, 'companion')
const CONSOLE_ROOT = path.join(PROTOTYPE_ROOT, 'console')
const PLUGIN_ROOT = path.join(CONSOLE_ROOT, 'plugin')

const PLUGIN_ID = 'omarchestra.agent-console'
const PLUGIN_VERSION = '0.2.0'
const COMPANION_PROTOCOL = 'omarchestra.companion/v1'
const COMPATIBILITY = { omarchy: '4.0.2-1', quickshell: '0.3.1-1' }
const REQUIRED_CAPABILITIES = [
  'session.open',
  'session.update',
  'session.intent',
  'session.hide',
  'session.clear',
  'session.resnapshot',
]

type Role = 'coordinator' | 'builder' | 'reviewer'
type CompanionModules = Record<string, any>

let modulesPromise: Promise<CompanionModules> | undefined

async function modules(): Promise<CompanionModules> {
  modulesPromise ??= Promise.all([
    import('../contracts.ts'),
    import('../installation.ts'),
    import('../fake-omarchy.ts'),
    import('../projection-session.ts'),
    import('../fake-companion-shell.ts'),
  ]).then(([contracts, installation, omarchy, session, shell]) => ({
    ...contracts,
    ...installation,
    ...omarchy,
    ...session,
    ...shell,
  }))
  return modulesPromise
}

function companionRelease(): Record<string, unknown> {
  return COMPANION_RELEASE
}

interface FakeHandler {
  onFrame(frame: { type: string; messageId: string; body: Record<string, unknown> }): void
  onClose(error: Error | null): void
}

class FakeChannel {
  readonly sent: Array<{ type: string; messageId: string; body: Record<string, unknown> }> = []
  closed = false
  private readonly handler: FakeHandler

  constructor(handler: FakeHandler) {
    this.handler = handler
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.sent.push({ type, messageId, body })
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, body: Record<string, unknown>): void {
    this.handler.onFrame({ type, messageId: `acceptance-${type}-${this.sent.length}`, body })
  }
}

class FakeConnector {
  readonly channels: FakeChannel[] = []

  async connect(handler: FakeHandler): Promise<FakeChannel> {
    const channel = new FakeChannel(handler)
    this.channels.push(channel)
    return channel
  }
}

interface AgentSentinel {
  role: Role
  agentRunId: string
  bridgeInstanceId: string
  processRunRef: string
  connected: boolean
  deliveredTurns: number
  interruptions: number
}

function agentsFor(goal: 'a' | 'b'): AgentSentinel[] {
  return (['coordinator', 'builder', 'reviewer'] as const).map((role, index) => ({
    role,
    agentRunId: `agent-run-${goal}-${role}`,
    bridgeInstanceId: `bridge-${goal}-${role}`,
    processRunRef: `process-run-${goal}-${role}`,
    connected: true,
    deliveredTurns: role === 'builder' ? 1 : 0,
    interruptions: 0,
  }))
}

const DISPLAY: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  reviewer: 'Reviewer',
}

function snapshot(teamGoalId: string, cursor: number, agents: readonly AgentSentinel[]): Record<string, unknown> {
  const roles = (['reviewer', 'coordinator', 'builder'] as const).map((role) => {
    const agent = agents.find((candidate) => candidate.role === role)
    if (agent === undefined) throw new Error(`missing fake agent ${role}`)
    const state = role === 'builder' ? 'managed' : 'waiting'
    return {
      role,
      agentRunId: agent.agentRunId,
      terminalSessionRef: `terminal-${teamGoalId}-${role}`,
      shellRunId: `shell-${teamGoalId}-${role}`,
      piSessionId: `pi-${teamGoalId}-${role}`,
      extensionInstanceId: agent.bridgeInstanceId,
      hostPid: 53001 + (role === 'coordinator' ? 0 : role === 'builder' ? 1 : 2),
      hostMode: 'tui',
      controlMode: 'managed',
      agentState: role === 'builder' ? 'working' : 'waiting',
      assignmentState: role === 'builder' ? 'active' : null,
      nativeTerminalTitle: `Omarchestra — ${DISPLAY[role]} — ${state}`,
      piStatus: `${DISPLAY[role]} · ${state}`,
    }
  })
  return {
    cursor,
    teamGoal: {
      id: teamGoalId,
      goalText: `Integrated fake Companion acceptance for ${teamGoalId}.`,
      createdAt: '2026-09-02T00:00:00.000Z',
      eventCursor: cursor,
    },
    roles,
    assignment: null,
    journal: { requested: 'default', effective: 'delete', sqliteVersion: '3.53.4' },
  }
}

async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function openWithSnapshot(
  manager: any,
  connector: FakeConnector,
  teamGoalId: string,
  value: Record<string, unknown>,
): Promise<FakeChannel> {
  const opening = manager.open({ teamGoalId })
  await settle()
  const channel = connector.channels.at(-1)
  assert.ok(channel, 'capability discovery must be followed by a fake projection connection')
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId, role: null })
  channel.emit('snapshot', value)
  await opening
  return channel
}

function installationState(fake: any): Record<string, unknown> {
  return {
    pluginTreeAndReceipt: structuredClone(fake.installationFingerprint()),
    shellJsonBytes: fake.configuration.shellJsonBytes(),
  }
}

async function installedHarness(): Promise<{
  fakeOmarchy: any
  installer: any
  shell: any
  manager: any
  connector: FakeConnector
  installedState: Record<string, unknown>
  installResult: any
}> {
  const {
    CompanionInstallation,
    FakeOmarchy,
    FakeCompanionShell,
    ProjectionSessionManager,
  } = await modules()
  const fakeOmarchy = new FakeOmarchy({ compatibility: { ...COMPATIBILITY } })
  const installer = new CompanionInstallation(fakeOmarchy.ports())
  const release = companionRelease()
  const plan = await installer.inspect({ operation: 'install', release })
  const installResult = await installer.execute(plan, fakeOmarchy.authorization.grant(plan))

  assert.equal(installResult.operation, 'install')
  assert.equal(installResult.pluginId, PLUGIN_ID)
  assert.equal(installResult.version, PLUGIN_VERSION)
  assert.equal(fakeOmarchy.configuration.enabledPluginCount(PLUGIN_ID), 1)

  const installedState = installationState(fakeOmarchy)
  fakeOmarchy.clearMutationLog()
  const connector = new FakeConnector()
  const shell = new FakeCompanionShell({
    pluginId: PLUGIN_ID,
    version: PLUGIN_VERSION,
    protocol: COMPANION_PROTOCOL,
    capabilities: [...REQUIRED_CAPABILITIES],
  })
  const manager = new ProjectionSessionManager({
    pluginId: PLUGIN_ID,
    protocol: COMPANION_PROTOCOL,
    shell,
    connector,
    clientId: 'integrated-companion-acceptance',
    sink: () => {},
  })
  return { fakeOmarchy, installer, shell, manager, connector, installedState, installResult }
}

function requireSessionIdentity(manager: any): number {
  const identity = manager.sessionGeneration
  assert.equal(Number.isInteger(identity), true, 'every open must expose a Projection Session generation')
  assert.ok(identity > 0, 'Projection Session generation must be positive')
  return identity
}

test('one installed Companion persists across two Team Goals while each goal receives a distinct ephemeral Projection Session', async () => {
  const { fakeOmarchy, shell, manager, connector, installedState, installResult } = await installedHarness()
  const agentsA = agentsFor('a')
  const agentsB = agentsFor('b')

  await openWithSnapshot(manager, connector, 'team-goal-a', snapshot('team-goal-a', 10, agentsA))
  const sessionA = requireSessionIdentity(manager)
  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(manager.handoff?.cards[1]?.agentRunId, 'agent-run-a-builder')

  await manager.clear()
  assert.equal(manager.handoff, null, 'Team Goal A clear removes only ephemeral projection state')
  await manager.hide()

  await openWithSnapshot(manager, connector, 'team-goal-b', snapshot('team-goal-b', 20, agentsB))
  const sessionB = requireSessionIdentity(manager)
  assert.notEqual(sessionB, sessionA, 'Projection Session identities must never be reused across Team Goals')
  assert.equal(manager.handoff?.cards[1]?.agentRunId, 'agent-run-b-builder')

  assert.equal(installResult.operation, 'install', 'the only product-management operation was the initial install')
  assert.equal(fakeOmarchy.configuration.enabledPluginCount(PLUGIN_ID), 1)
  assert.deepEqual(fakeOmarchy.mutationLog(), [], 'neither Team Goal may mutate installation state')
  assert.deepEqual(installationState(fakeOmarchy), installedState)
  assert.deepEqual(shell.mutationLog(), [])
})

test('plugin reload rejects the stale session and reconstructs the authoritative projection without interrupting agents', async () => {
  const { fakeOmarchy, shell, manager, connector, installedState } = await installedHarness()
  const agents = agentsFor('b')
  const agentsBefore = structuredClone(agents)
  await openWithSnapshot(manager, connector, 'team-goal-b', snapshot('team-goal-b', 30, agents))

  const staleSessionId = requireSessionIdentity(manager)
  const cardsBefore = structuredClone(manager.handoff?.cards)
  const staleChannel = connector.channels.at(-1)!
  const oldPluginGeneration = shell.currentGeneration()
  shell.reloadPlugin()
  assert.notEqual(shell.currentGeneration(), oldPluginGeneration)

  staleChannel.emit('event', {
    sequence: 31,
    eventId: 'event-after-plugin-reload',
    eventType: 'runner_restarted',
    role: null,
    payload: { runnerPid: 99999 },
    createdAt: '2026-09-02T00:00:31.000Z',
  })
  await settle()
  assert.match(String(manager.lastError ?? ''), /stale|generation|reload|plugin/i)
  assert.equal(staleChannel.closed, true, 'stale plugin generation closes only the projection connection')

  await assert.rejects(
    () => manager.sendIntent({
      intentId: 'intent-from-stale-session',
      kind: 'present_agent',
      role: 'builder',
    }),
    /stale|session|generation|ready|active/i,
  )

  const reopening = manager.open({ teamGoalId: 'team-goal-b' })
  await settle()
  const freshChannel = connector.channels.at(-1)!
  freshChannel.emit('hello_ack', { connectionKind: 'projection', teamGoalId: 'team-goal-b', role: null })
  freshChannel.emit('snapshot', snapshot('team-goal-b', 30, agents))
  await reopening

  const freshSessionId = requireSessionIdentity(manager)
  assert.notEqual(freshSessionId, staleSessionId, 'plugin reload reconstruction creates a fresh Projection Session')
  assert.deepEqual(manager.handoff?.cards, cardsBefore, 'fresh authoritative snapshot reconstructs identical cards')
  assert.deepEqual(agents, agentsBefore, 'reload cannot alter fake agent identity, connection, or turn counts')
  assert.equal(agents.every((agent) => agent.connected && agent.interruptions === 0), true)
  assert.deepEqual(fakeOmarchy.mutationLog(), [])
  assert.deepEqual(installationState(fakeOmarchy), installedState)
  assert.deepEqual(shell.mutationLog(), [])
})

test('runtime hide, clear, and cleanup leave the plugin tree and shell.json byte-identical', async () => {
  const { fakeOmarchy, shell, manager, connector, installedState } = await installedHarness()
  const installationShellCallsBefore = structuredClone(fakeOmarchy.shell.calls())
  const agents = agentsFor('b')

  await openWithSnapshot(manager, connector, 'team-goal-b', snapshot('team-goal-b', 40, agents))
  await manager.clear()
  await manager.hide()
  await manager.hide()

  assert.equal(manager.handoff, null)
  assert.equal(shell.panel.visible, false)
  assert.equal(fakeOmarchy.configuration.enabledPluginCount(PLUGIN_ID), 1, 'runtime cleanup leaves the plugin enabled')
  assert.deepEqual(fakeOmarchy.shell.calls(), installationShellCallsBefore, 'runtime cleanup performs no setup shell action')
  assert.deepEqual(fakeOmarchy.mutationLog(), [])
  assert.deepEqual(shell.mutationLog(), [])
  assert.deepEqual(installationState(fakeOmarchy), installedState)

  const runtimeOperations = shell.calls().map((call: any) => call.operation)
  assert.ok(runtimeOperations.includes('capabilities'))
  assert.ok(runtimeOperations.includes('summon'))
  assert.ok(runtimeOperations.includes('call'))
  assert.ok(runtimeOperations.includes('hide'))
  for (const forbidden of [
    'install', 'update', 'rollback', 'uninstall', 'enable', 'disable',
    'unload', 'rescan', 'writeShellJson', 'rewriteQml', 'registerTemporaryPlugin',
  ]) {
    assert.equal(runtimeOperations.includes(forbidden), false, `routine lifecycle must never call ${forbidden}`)
  }
})

test('routine projection imports cannot reach installation, configuration mutation, or QML rewrite modules', () => {
  const entry = path.join(COMPANION_ROOT, 'projection-session.ts')
  assert.equal(fs.existsSync(entry), true, 'projection-session.ts must exist before this boundary can pass')
  const graph = collectRelativeTypeScriptGraph(entry)
  const relativeGraph = [...graph].map((file) => path.relative(PROTOTYPE_ROOT, file)).sort()

  assert.ok(relativeGraph.includes('companion/projection-session.ts'))
  assert.ok(relativeGraph.includes('console/projection-core.ts'), 'the existing projection core must be reused')
  assert.ok(relativeGraph.includes('console/live-projection-adapter.ts'), 'the existing live adapter must be reused')
  for (const forbiddenPath of [
    'companion/installation.ts',
    'companion/fake-omarchy.ts',
    'companion/releases.ts',
    'manual/live-companion-omarchy.ts',
  ]) {
    assert.equal(relativeGraph.includes(forbiddenPath), false, `routine import graph must exclude ${forbiddenPath}`)
  }

  const routineSource = [...graph]
    .map((file) => stripCommentsAndStrings(fs.readFileSync(file, 'utf8')))
    .join('\n')
  for (const forbidden of [
    /\bCompanionInstallation\b/,
    /\bwriteShellJson\b/,
    /\bsetPluginEnabled\b/,
    /\bregisterTemporaryPlugin\b/,
    /\brewriteQml\b/,
  ]) {
    assert.doesNotMatch(routineSource, forbidden)
  }
})

test('the integrated acceptance seam itself remains fake-only and preserves the presentation-only QML boundary', () => {
  const testSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const executableTestSource = stripCommentsAndStrings(testSource)
  const processLaunchPattern = new RegExp([
    'node:' + 'child_process',
    '\\b(?:sp' + 'awn|spawn' + 'Sync|exec' + 'File|execFile' + 'Sync|fo' + 'rk)\\s*\\(',
  ].join('|'))
  assert.doesNotMatch(
    executableTestSource,
    processLaunchPattern,
    'the integrated acceptance test must never launch a live process',
  )

  const qml = [
    fs.readFileSync(path.join(PLUGIN_ROOT, 'AgentConsole.qml'), 'utf8'),
    fs.readFileSync(path.join(PLUGIN_ROOT, 'AgentConsoleCards.qml'), 'utf8'),
  ].map(stripCommentsAndStrings).join('\n')
  assert.doesNotMatch(qml, /shell\.json|LocalStorage|SQLite|QSql|FileView|QProcess|\bProcess\s*\{/i)
  assert.doesNotMatch(qml, /registerTemporaryPlugin|installPlugin|updatePlugin|unloadPlugin|rewriteQml/i)
})

function collectRelativeTypeScriptGraph(entry: string): Set<string> {
  const visited = new Set<string>()
  const visit = (file: string): void => {
    const resolvedFile = path.resolve(file)
    if (visited.has(resolvedFile) || !fs.existsSync(resolvedFile)) return
    visited.add(resolvedFile)
    const source = fs.readFileSync(resolvedFile, 'utf8')
    const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]
      if (!specifier.startsWith('.')) continue
      const target = path.resolve(path.dirname(resolvedFile), specifier)
      if (target.endsWith('.ts')) visit(target)
    }
  }
  visit(entry)
  return visited
}

function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/gs, '``')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}
