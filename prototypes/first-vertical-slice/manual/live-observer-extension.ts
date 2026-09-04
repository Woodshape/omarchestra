/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Manual Pi entrypoint for ordinary-session observation. Importing this module
 * and constructing its factory perform no socket, filesystem, process, or UI
 * work. The observer adapter opens the owner-only Unix socket only after Pi
 * emits `session_start` for a visible TUI session.
 */

import path from 'node:path'

import {
  createObserverExtension,
  type HeartbeatCanceller,
  type HeartbeatScheduler,
  type PiExtensionAPI,
  type ReconnectCanceller,
  type ReconnectScheduler,
} from '../observer/extension-adapter.ts'
import { connectObserverSocket } from './live-observer-transport.ts'

export interface LiveObserverExtensionOptions {
  socketPath?: string
  observerVersion?: string
  processIncarnationId?: string
  processIncarnationIdFactory?: () => string
  extensionInstanceIdFactory?: () => string
  hostPid?: number
  hostPidFactory?: () => number
  scheduleHeartbeat?: HeartbeatScheduler
  cancelHeartbeat?: HeartbeatCanceller
  scheduleReconnect?: ReconnectScheduler
  cancelReconnect?: ReconnectCanceller
  maxReconnectAttempts?: number
  reconnectInitialDelayMs?: number
  reconnectMaxDelayMs?: number
  randomIdFactory?: (purpose: string) => string
}

/**
 * Build the manual observer extension without opening its socket. The path is
 * resolved inside the injected connect callback so importing or constructing
 * this factory remains side-effect free.
 */
export function createLiveObserverExtension(options: LiveObserverExtensionOptions = {}) {
  return createObserverExtension({
    observerVersion: options.observerVersion,
    processIncarnationId: options.processIncarnationId,
    processIncarnationIdFactory: options.processIncarnationIdFactory,
    extensionInstanceIdFactory: options.extensionInstanceIdFactory,
    hostPid: options.hostPid,
    hostPidFactory: options.hostPidFactory,
    scheduleHeartbeat: options.scheduleHeartbeat,
    cancelHeartbeat: options.cancelHeartbeat,
    scheduleReconnect: options.scheduleReconnect,
    cancelReconnect: options.cancelReconnect,
    maxReconnectAttempts: options.maxReconnectAttempts,
    reconnectInitialDelayMs: options.reconnectInitialDelayMs,
    reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    randomIdFactory: options.randomIdFactory,
    connect: (handler) => connectObserverSocket(resolveSocketPath(options.socketPath), handler),
  })
}

/** Pi loads this function in the ordinary visible process. */
export default function liveObserverExtension(pi: PiExtensionAPI): void {
  createLiveObserverExtension()(pi)
}

function resolveSocketPath(explicitPath: string | undefined): string {
  const socketPath = explicitPath ?? process.env.OMARCHESTRA_OBSERVER_SOCKET
  if (socketPath === undefined || !path.isAbsolute(socketPath)) {
    throw new Error('OMARCHESTRA_OBSERVER_SOCKET must be an absolute Unix-socket path')
  }
  return socketPath
}
