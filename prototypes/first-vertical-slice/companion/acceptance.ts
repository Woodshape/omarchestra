/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Standalone fake-only acceptance composition for one persistent Companion
 * Plugin installation and multiple ephemeral Projection Sessions. It performs
 * no real filesystem, configuration, shell IPC, GUI, process, terminal,
 * provider, Boomux, SSH, Hyprland, or systemd action.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  COMPANION_CAPABILITIES,
  COMPANION_PLUGIN_ID,
  COMPANION_PLUGIN_VERSION,
  COMPANION_PROTOCOL_ID,
  SUPPORTED_COMPATIBILITY,
  type Role,
  type SnapshotBody,
} from './contracts.ts'
import { FakeCompanionShell } from './fake-companion-shell.ts'
import { FakeOmarchy } from './fake-omarchy.ts'
import { CompanionInstallation } from './installation.ts'
import { ProjectionSessionManager } from './projection-session.ts'
import { COMPANION_RELEASE } from './releases.ts'
import type {
  ProjectionChannel,
  ProjectionConnector,
} from '../console/live-projection-adapter.ts'
import type { FrameHandler } from '../src/transport.ts'

interface FakeAgent {
  role: Role
  agentRunId: string
  terminalSessionRef: string
  shellRunId: string
  piSessionId: string
  extensionInstanceId: string
  processRunRef: string
  connectionId: string
  connected: boolean
  assignment: {
    assignmentId: string
    state: 'active' | 'waiting'
  }
  deliveredTurns: number
  interruptions: number
}

interface InstallationBytes {
  pluginTree: Array<Record<string, unknown>>
  receiptBytes: string
  shellJsonBytes: string
}

export interface CompanionAcceptanceResult {
  installationExecutions: number
  installationFingerprint: string
  teamGoalASessionGeneration: number
  teamGoalBSessionGeneration: number
  reconstructedSessionGeneration: number
  pluginGenerationBeforeReload: number
  pluginGenerationAfterReload: number
  staleSessionRejected: boolean
  reconstructedCardsIdentical: boolean
  agentsUnchanged: boolean
  runtimeMutationCount: number
  pluginEnabledCount: number
}

class FakeProjectionChannel implements ProjectionChannel {
  readonly sent: Array<{
    type: string
    messageId: string
    body: Record<string, unknown>
  }> = []
  closed = false
  private readonly handler: FrameHandler

  constructor(handler: FrameHandler) {
    this.handler = handler
  }

  send(type: string, messageId: string, body: Record<string, unknown>): void {
    this.sent.push({ type, messageId, body })
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, body: Record<string, unknown>): void {
    this.handler.onFrame({
      type,
      messageId: `companion-acceptance-${type}-${this.sent.length}`,
      body,
    })
  }
}

class FakeProjectionConnector implements ProjectionConnector {
  readonly channels: FakeProjectionChannel[] = []

  async connect(handler: FrameHandler): Promise<FakeProjectionChannel> {
    const channel = new FakeProjectionChannel(handler)
    this.channels.push(channel)
    return channel
  }
}

function fakeAgents(goal: 'a' | 'b'): FakeAgent[] {
  return (['coordinator', 'builder', 'reviewer'] as const).map((role, index) => ({
    role,
    agentRunId: `agent-run-${goal}-${role}`,
    terminalSessionRef: `terminal-${goal}-${role}`,
    shellRunId: `shell-${goal}-${role}`,
    piSessionId: `pi-${goal}-${role}`,
    extensionInstanceId: `bridge-${goal}-${role}`,
    processRunRef: `process-${goal}-${role}`,
    connectionId: `connection-${goal}-${role}`,
    connected: true,
    assignment: {
      assignmentId: role === 'builder' ? `assignment-${goal}-builder` : `waiting-${goal}-${role}`,
      state: role === 'builder' ? 'active' : 'waiting',
    },
    deliveredTurns: role === 'builder' ? 1 : 0,
    interruptions: 0,
  }))
}

const DISPLAY: Record<Role, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  reviewer: 'Reviewer',
}

function authoritativeSnapshot(
  teamGoalId: string,
  cursor: number,
  agents: readonly FakeAgent[],
): SnapshotBody {
  const roles = (['reviewer', 'coordinator', 'builder'] as const).map((role) => {
    const agent = agents.find((candidate) => candidate.role === role)
    assert.ok(agent, `missing fake ${role} agent`)
    const state = role === 'builder' ? 'managed' : 'waiting'
    return {
      role,
      agentRunId: agent.agentRunId,
      terminalSessionRef: agent.terminalSessionRef,
      shellRunId: agent.shellRunId,
      piSessionId: agent.piSessionId,
      extensionInstanceId: agent.extensionInstanceId,
      hostPid: 54001 + (role === 'coordinator' ? 0 : role === 'builder' ? 1 : 2),
      hostMode: 'tui' as const,
      controlMode: 'managed' as const,
      agentState: role === 'builder' ? 'working' as const : 'waiting' as const,
      assignmentState: role === 'builder' ? 'active' as const : null,
      nativeTerminalTitle: `Omarchestra — ${DISPLAY[role]} — ${state}`,
      piStatus: `${DISPLAY[role]} · ${state}`,
    }
  })
  const builder = agents.find((agent) => agent.role === 'builder')
  assert.ok(builder)
  return {
    cursor,
    teamGoal: {
      id: teamGoalId,
      goalText: `Fake-only persistent Companion acceptance for ${teamGoalId}.`,
      createdAt: '2026-09-03T00:00:00.000Z',
      eventCursor: cursor,
    },
    roles,
    assignment: {
      id: builder.assignment.assignmentId,
      role: 'builder',
      agentRunId: builder.agentRunId,
      state: 'active',
      lastAckStatus: 'accepted',
      prompt: `Fake bounded assignment for ${teamGoalId}.`,
      createdAt: '2026-09-03T00:00:01.000Z',
      updatedAt: '2026-09-03T00:00:02.000Z',
    },
    journal: { requested: 'default', effective: 'delete', sqliteVersion: '3.53.4' },
  }
}

function captureInstallationBytes(fake: FakeOmarchy): InstallationBytes {
  return {
    pluginTree: structuredClone(fake.filesystem.snapshot(fake.paths.pluginRoot)),
    receiptBytes: fake.filesystem.readBytes(fake.paths.receiptPath),
    shellJsonBytes: fake.configuration.shellJsonBytes(),
  }
}

function captureAgents(agents: readonly FakeAgent[]): string {
  return JSON.stringify(agents)
}

async function settle(rounds = 30): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function openFromAuthoritativeSnapshot(
  manager: ProjectionSessionManager,
  connector: FakeProjectionConnector,
  teamGoalId: string,
  snapshot: SnapshotBody,
): Promise<FakeProjectionChannel> {
  const opening = manager.open({ teamGoalId })
  await settle()
  const channel = connector.channels.at(-1)
  assert.ok(channel, 'capability discovery must precede a fake runner connection')
  channel.emit('hello_ack', { connectionKind: 'projection', teamGoalId, role: null })
  channel.emit('snapshot', snapshot as unknown as Record<string, unknown>)
  await opening
  return channel
}

function assertInstallationUnchanged(
  fake: FakeOmarchy,
  expected: InstallationBytes,
  where: string,
): void {
  assert.deepEqual(captureInstallationBytes(fake), expected, `${where}: installed assets, receipt, and shell.json changed`)
  assert.equal(fake.configuration.enabledPluginCount(COMPANION_PLUGIN_ID), 1, `${where}: plugin is not enabled exactly once`)
  assert.deepEqual(fake.mutationLog(), [], `${where}: routine work reached an installation mutation port`)
}

/** Run the complete in-memory acceptance scenario and return inspectable proof. */
export async function runCompanionAcceptance(): Promise<CompanionAcceptanceResult> {
  const fakeOmarchy = new FakeOmarchy({ compatibility: { ...SUPPORTED_COMPATIBILITY } })
  const installer = new CompanionInstallation(fakeOmarchy.ports())
  let installationExecutions = 0

  const installPlan = await installer.inspect({ operation: 'install', release: COMPANION_RELEASE })
  const installResult = await installer.execute(
    installPlan,
    fakeOmarchy.authorization.grant(installPlan),
  )
  installationExecutions += 1
  assert.equal(installResult.operation, 'install')
  assert.equal(installResult.pluginId, COMPANION_PLUGIN_ID)
  assert.equal(installResult.version, COMPANION_PLUGIN_VERSION)
  assert.equal(fakeOmarchy.installedRelease().version, COMPANION_PLUGIN_VERSION)
  assert.equal(fakeOmarchy.configuration.enabledPluginCount(COMPANION_PLUGIN_ID), 1)

  const installationBytes = captureInstallationBytes(fakeOmarchy)
  const installationFingerprint = fakeOmarchy.digest.stableDigest(installationBytes)
  const installationShellCalls = structuredClone(fakeOmarchy.shell.calls())
  assert.ok(fakeOmarchy.mutationLog().length > 0, 'the explicit install must be observable as installation mutations')
  fakeOmarchy.clearMutationLog()

  const installedRelease = fakeOmarchy.receipt().release
  const shell = new FakeCompanionShell({
    pluginId: installedRelease.pluginId,
    version: installedRelease.version,
    protocol: installedRelease.protocol,
    capabilities: [...COMPANION_CAPABILITIES],
  })
  const shellInstallationFingerprint = shell.installationFingerprint()
  const connector = new FakeProjectionConnector()
  const manager = new ProjectionSessionManager({
    pluginId: COMPANION_PLUGIN_ID,
    protocol: COMPANION_PROTOCOL_ID,
    shell,
    connector,
    clientId: 'standalone-companion-acceptance',
  })

  // Team Goal A gets session 1, then only its ephemeral projection is cleared.
  const agentsA = fakeAgents('a')
  const agentsABefore = captureAgents(agentsA)
  await openFromAuthoritativeSnapshot(
    manager,
    connector,
    'team-goal-a',
    authoritativeSnapshot('team-goal-a', 10, agentsA),
  )
  const teamGoalASessionGeneration = manager.sessionGeneration
  assert.equal(manager.handoff?.status, 'ready')
  assert.equal(manager.handoff?.cards.find((card) => card.role === 'builder')?.agentRunId, 'agent-run-a-builder')
  await manager.clear()
  assert.equal(manager.handoff, null)
  await manager.hide()
  assert.equal(captureAgents(agentsA), agentsABefore, 'Team Goal A cleanup changed a fake agent')
  assertInstallationUnchanged(fakeOmarchy, installationBytes, 'after Team Goal A cleanup')

  // Team Goal B reuses the same installation but receives another session.
  const agentsB = fakeAgents('b')
  const agentsBBefore = captureAgents(agentsB)
  await openFromAuthoritativeSnapshot(
    manager,
    connector,
    'team-goal-b',
    authoritativeSnapshot('team-goal-b', 20, agentsB),
  )
  const teamGoalBSessionGeneration = manager.sessionGeneration
  assert.notEqual(teamGoalBSessionGeneration, teamGoalASessionGeneration)
  const cardsBeforeReload = structuredClone(manager.handoff?.cards)
  const staleChannel = connector.channels.at(-1)
  assert.ok(staleChannel)
  const pluginGenerationBeforeReload = shell.currentGeneration()

  // Reload only the plugin. The agents remain connected with the same exact
  // process/bridge identities, assignment records, and delivered-turn counts.
  shell.reloadPlugin()
  const pluginGenerationAfterReload = shell.currentGeneration()
  assert.notEqual(pluginGenerationAfterReload, pluginGenerationBeforeReload)
  staleChannel.emit('event', {
    sequence: 21,
    eventId: 'event-after-fake-plugin-reload',
    eventType: 'runner_restarted',
    role: null,
    payload: { runnerPid: 99999 },
    createdAt: '2026-09-03T00:00:21.000Z',
  })
  await settle()
  assert.equal(staleChannel.closed, true, 'the stale Projection Session connection must close')
  assert.match(String(manager.lastError), /stale|generation|reload|plugin/i)
  assert.equal(captureAgents(agentsB), agentsBBefore, 'plugin reload changed active fake agents')

  let staleSessionRejected = false
  try {
    await manager.sendIntent({
      intentId: 'intent-from-stale-projection-session',
      kind: 'present_agent',
      role: 'builder',
    })
  } catch (error) {
    staleSessionRejected = /stale|session|generation|ready|active/i.test(String(error))
  }
  assert.equal(staleSessionRejected, true, 'a stale Projection Session intent must fail closed')

  // Reopen against the new plugin generation and reconstruct from a fresh
  // authoritative snapshot, never from QML or stale session state.
  await openFromAuthoritativeSnapshot(
    manager,
    connector,
    'team-goal-b',
    authoritativeSnapshot('team-goal-b', 20, agentsB),
  )
  const reconstructedSessionGeneration = manager.sessionGeneration
  assert.notEqual(reconstructedSessionGeneration, teamGoalBSessionGeneration)
  assert.deepEqual(manager.handoff?.cards, cardsBeforeReload)
  const reconstructedCardsIdentical = JSON.stringify(manager.handoff?.cards) === JSON.stringify(cardsBeforeReload)
  const agentsUnchanged = captureAgents(agentsB) === agentsBBefore
  assert.equal(reconstructedCardsIdentical, true)
  assert.equal(agentsUnchanged, true)
  assert.equal(agentsB.every((agent) => agent.connected && agent.interruptions === 0), true)

  await manager.clear()
  await manager.hide()
  await manager.hide()
  assert.equal(manager.handoff, null)
  assert.equal(shell.panel.visible, false)
  assert.equal(shell.installationFingerprint(), shellInstallationFingerprint)
  assert.deepEqual(shell.mutationLog(), [])
  assert.deepEqual(fakeOmarchy.shell.calls(), installationShellCalls)
  assert.equal(installationExecutions, 1)
  assertInstallationUnchanged(fakeOmarchy, installationBytes, 'after final runtime cleanup')

  const runtimeOperations = shell.calls().map((call) => call.operation)
  for (const required of ['capabilities', 'summon', 'call', 'hide']) {
    assert.equal(runtimeOperations.includes(required as typeof runtimeOperations[number]), true, `runtime operation ${required} was not exercised`)
  }
  for (const forbidden of [
    'install', 'update', 'rollback', 'uninstall', 'enable', 'disable',
    'unload', 'rescan', 'writeShellJson', 'rewriteQml', 'registerTemporaryPlugin',
  ]) {
    assert.equal(runtimeOperations.includes(forbidden as typeof runtimeOperations[number]), false, `routine lifecycle called ${forbidden}`)
  }

  return {
    installationExecutions,
    installationFingerprint,
    teamGoalASessionGeneration,
    teamGoalBSessionGeneration,
    reconstructedSessionGeneration,
    pluginGenerationBeforeReload,
    pluginGenerationAfterReload,
    staleSessionRejected,
    reconstructedCardsIdentical,
    agentsUnchanged,
    runtimeMutationCount: fakeOmarchy.mutationLog().length + shell.mutationLog().length,
    pluginEnabledCount: fakeOmarchy.configuration.enabledPluginCount(COMPANION_PLUGIN_ID),
  }
}

async function main(): Promise<void> {
  console.log('OMARCHESTRA COMPANION ACCEPTANCE — PROTOTYPE, FAKE-ONLY')
  const result = await runCompanionAcceptance()
  console.log(`INSTALL persistent plugin executions=${result.installationExecutions} enabled=${result.pluginEnabledCount}`)
  console.log(
    `SESSIONS team-goal-a=${result.teamGoalASessionGeneration} ` +
    `team-goal-b=${result.teamGoalBSessionGeneration} reconstructed=${result.reconstructedSessionGeneration}`,
  )
  console.log(
    `RELOAD plugin-generation=${result.pluginGenerationBeforeReload}->${result.pluginGenerationAfterReload} ` +
    `stale-rejected=${result.staleSessionRejected}`,
  )
  console.log(
    `CONTINUITY cards-identical=${result.reconstructedCardsIdentical} ` +
    `agents-identities-connections-assignments-turns-unchanged=${result.agentsUnchanged}`,
  )
  console.log(
    `CLEANUP runtime-mutations=${result.runtimeMutationCount} installation-fingerprint=${result.installationFingerprint}`,
  )
  console.log('VERDICT PASS — one persistent installation, ephemeral sessions, authoritative reload recovery, byte-identical cleanup')
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(path.resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
