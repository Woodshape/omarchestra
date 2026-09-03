/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Manual-only Pi extension for the authorized local role-label gate. This is
 * loaded into each visible interactive Pi process. It never creates another
 * agent/session/process, writes PTY input, scrapes terminal output, or opens a
 * listener. Managed work enters this same visible host via sendUserMessage().
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { connectUnixSocket, FrameChannel } from '../src/transport.ts'
import { isBoundedId, ROLES, type Role } from '../src/protocol.ts'
import {
  LiveRoleLabelBridgeCore,
  ROLE_STATUS_KEY,
  type LiveBridgeIdentity,
} from './live-bridge-core.ts'

interface GateConfig extends LiveBridgeIdentity {
  socketPath: string
  terminalSessionRef: string
  shellRunId: string
  piSessionId: string
  statusFile: string
}

function requiredId(name: string): string {
  const value = process.env[name]
  if (value === undefined || !isBoundedId(value)) throw new Error(`${name} must be a bounded identifier`)
  return value
}

function loadConfig(): GateConfig {
  const roleValue = process.env.OMARCHESTRA_ROLE
  if (roleValue === undefined || !(ROLES as readonly string[]).includes(roleValue)) {
    throw new Error('OMARCHESTRA_ROLE must be coordinator, builder, or reviewer')
  }
  const socketPath = process.env.OMARCHESTRA_BRIDGE_SOCKET
  const statusFile = process.env.OMARCHESTRA_GATE_STATUS_FILE
  if (socketPath === undefined || !path.isAbsolute(socketPath)) {
    throw new Error('OMARCHESTRA_BRIDGE_SOCKET must be an absolute Unix-socket path')
  }
  if (statusFile === undefined || !path.isAbsolute(statusFile)) {
    throw new Error('OMARCHESTRA_GATE_STATUS_FILE must be an absolute path')
  }
  return {
    teamGoalId: requiredId('OMARCHESTRA_TEAM_GOAL_ID'),
    role: roleValue as Role,
    agentRunId: requiredId('OMARCHESTRA_AGENT_RUN_ID'),
    extensionInstanceId: requiredId('OMARCHESTRA_EXTENSION_INSTANCE_ID'),
    terminalSessionRef: requiredId('OMARCHESTRA_TERMINAL_SESSION_REF'),
    shellRunId: requiredId('OMARCHESTRA_SHELL_RUN_ID'),
    piSessionId: requiredId('OMARCHESTRA_PI_SESSION_ID'),
    socketPath,
    statusFile,
  }
}

function writePresentationStatus(
  config: GateConfig,
  update: { role: Role; nativeTerminalTitle: string; piStatus: string; eventCursor: number },
): void {
  const parent = path.dirname(config.statusFile)
  const parentStat = fs.lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('manual-gate status parent must be a real directory')
  }
  const temporary = `${config.statusFile}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify({
    pid: process.pid,
    role: update.role,
    nativeTerminalTitle: update.nativeTerminalTitle,
    piStatus: update.piStatus,
    eventCursor: update.eventCursor,
    observedAt: new Date().toISOString(),
  })}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, config.statusFile)
  fs.chmodSync(config.statusFile, 0o600)
}

export default function liveRoleLabelExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | null = null
  let channel: FrameChannel | null = null
  let core: LiveRoleLabelBridgeCore | null = null
  let messageCounter = 0

  pi.on('session_start', async (_event, ctx) => {
    context = ctx
    if (ctx.mode !== 'tui') {
      ctx.ui.notify('Omarchestra manual gate requires an interactive Pi TUI.', 'error')
      return
    }

    let config: GateConfig
    try {
      config = loadConfig()
      const actualSessionId = ctx.sessionManager.getSessionId()
      if (actualSessionId !== config.piSessionId) {
        throw new Error(`Pi session identity mismatch: expected ${config.piSessionId}, got ${actualSessionId}`)
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      return
    }

    const displayRole = config.role[0].toUpperCase() + config.role.slice(1)
    ctx.ui.setTitle(`Omarchestra — ${displayRole} — connecting`)
    ctx.ui.setStatus(ROLE_STATUS_KEY, `${displayRole} · connecting`)

    core = new LiveRoleLabelBridgeCore(config, {
      setTitle: (title) => ctx.ui.setTitle(title),
      setStatus: (key, value) => ctx.ui.setStatus(key, value),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendFrame: (type, body) => {
        if (channel === null) throw new Error('manual-gate bridge is disconnected')
        channel.send(type, `manual-${config.role}-${++messageCounter}`, body)
      },
      isIdle: () => context?.isIdle() ?? false,
      sendUserMessage: (prompt) => pi.sendUserMessage(prompt),
      onPresentationApplied: (update) => writePresentationStatus(config, update),
    })

    try {
      const socket = await connectUnixSocket(config.socketPath)
      channel = new FrameChannel(socket, {
        onFrame: (frame) => core?.handleFrame(frame),
        onClose: (error) => {
          channel = null
          if (error !== null) ctx.ui.notify(`Omarchestra bridge disconnected: ${error.message}`, 'error')
        },
      })
      channel.send('bridge.hello', `manual-${config.role}-${++messageCounter}`, {
        teamGoalId: config.teamGoalId,
        role: config.role,
        agentRunId: config.agentRunId,
        terminalSessionRef: config.terminalSessionRef,
        piSessionId: config.piSessionId,
        extensionInstanceId: config.extensionInstanceId,
        hostPid: process.pid,
        hostMode: 'tui',
        shellRunId: config.shellRunId,
      })
    } catch (error) {
      channel = null
      ctx.ui.notify(`Omarchestra bridge connection failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  })

  pi.registerCommand('omarchestra-start', {
    description: 'Start the queued Builder assignment for the authorized role-label gate',
    handler: async (_args, ctx) => {
      if (core === null) {
        ctx.ui.notify('Omarchestra bridge is not ready.', 'warning')
        return
      }
      core.startQueuedAssignment()
    },
  })

  pi.on('input', async (event) => {
    if (core === null) return
    const action = core.observeInput(event.text, event.source)
    if (action === 'handled') return { action: 'handled' as const }
    return { action: 'continue' as const }
  })

  pi.on('session_shutdown', async () => {
    channel?.close()
    channel = null
    core = null
    context = null
  })
}
