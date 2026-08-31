import net from "node:net"
import { chmod, lstat, mkdir, unlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import {
  NdjsonDecoder,
  ProtocolError,
  encodeMessage,
  makeControlAck,
  makeHelloAck,
  makeProtocolError,
  validateMessage
} from "./lib/protocol.mjs"
import { errorReport, requireCondition, spikeError } from "./lib/errors.mjs"
import { DurableStateStore } from "./lib/durable-store.mjs"
import { RunnerCore } from "./lib/runner-core.mjs"
import {
  plainObject,
  validateAbsolutePath,
  validateExecutablePath,
  validateUnixSocketPath,
  validateUuid
} from "./lib/validation.mjs"
import { ROLES } from "./lib/protocol.mjs"

const clone = value => structuredClone(value)

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null
}

function requireOwner(uid, metadata, label) {
  if (uid !== null && metadata.uid !== undefined) {
    requireCondition(metadata.uid === uid, "unsafe_socket", `${label} is not owned by the execution identity`)
  }
}

function privateMode(metadata, label) {
  requireCondition((metadata.mode & 0o777) === 0o600 || (metadata.mode & 0o777) === 0,
    "unsafe_socket", `${label} must be owner-only`)
}

async function verifySocketPath(socketPath, uid, { allowMissing = true } = {}) {
  validateUnixSocketPath(socketPath)
  try {
    const metadata = await lstat(socketPath)
    requireCondition(metadata.isSocket() && !metadata.isSymbolicLink(),
      "unsafe_socket", "Existing runner socket is not an owned Unix socket")
    requireOwner(uid, metadata, "Runner socket")
    requireCondition((metadata.mode & 0o077) === 0, "unsafe_socket", "Runner socket is group/world accessible")
    return metadata
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) return null
    throw error
  }
}

async function ensureSocketParent(socketPath, uid) {
  const parent = socketPath.slice(0, socketPath.lastIndexOf("/")) || "/"
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const metadata = await lstat(parent)
  requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink(),
    "unsafe_socket", "Runner socket parent must be a real directory")
  requireOwner(uid, metadata, "Runner socket parent")
  requireCondition((metadata.mode & 0o077) === 0, "unsafe_socket", "Runner socket parent is group/world accessible")
  return parent
}

function errorDetails(error) {
  return errorReport(error)
}

export function parseBindings(encoded) {
  requireCondition(typeof encoded === "string" && encoded.length > 0,
    "invalid_bindings", "Runner bindings are required")
  const parts = encoded.split(",")
  requireCondition(parts.length === ROLES.length, "invalid_bindings", "Runner bindings must contain three roles")
  const bindings = {}
  const agentIds = new Set()
  const shellIds = new Set()
  for (const part of parts) {
    const first = part.indexOf(":")
    const second = part.indexOf(":", first + 1)
    requireCondition(first > 0 && second > first + 1 && second < part.length - 1,
      "invalid_bindings", "Runner binding encoding is invalid")
    const role = part.slice(0, first)
    const agentRunId = part.slice(first + 1, second)
    const shellId = part.slice(second + 1)
    requireCondition(ROLES.includes(role) && !Object.hasOwn(bindings, role),
      "invalid_bindings", "Runner binding role is invalid or duplicated")
    validateUuid(agentRunId, `${role} Agent Run ID`)
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(shellId),
      "invalid_bindings", `${role} Shell ID is invalid`)
    requireCondition(!agentIds.has(agentRunId) && !shellIds.has(shellId),
      "invalid_bindings", "Runner binding identities must be unique")
    agentIds.add(agentRunId)
    shellIds.add(shellId)
    bindings[role] = { agentRunId, shellId, shellRunId: null }
  }
  for (const role of ROLES) requireCondition(Object.hasOwn(bindings, role),
    "invalid_bindings", `Missing ${role} binding`)
  return bindings
}

export function parseRunnerArguments(argv) {
  requireCondition(Array.isArray(argv), "invalid_arguments", "Runner arguments must be an array")
  const values = {}
  const allowed = new Set([
    "socket", "state", "receipt-id", "team-goal-id", "bindings", "max-events", "max-artifacts", "help"
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    requireCondition(typeof argument === "string" && argument.startsWith("--") && argument.length > 2,
      "invalid_arguments", `Unexpected runner argument: ${String(argument)}`)
    const key = argument.slice(2)
    requireCondition(allowed.has(key), "invalid_arguments", `Unknown runner option --${key}`)
    requireCondition(!Object.hasOwn(values, key), "invalid_arguments", `Duplicate runner option --${key}`)
    if (key === "help") {
      values[key] = true
      continue
    }
    const value = argv[++index]
    requireCondition(typeof value === "string" && value.length > 0 && !value.startsWith("--"),
      "invalid_arguments", `Runner option --${key} requires a value`)
    values[key] = value
  }
  if (values.help) return { help: true }
  for (const key of ["socket", "state", "receipt-id", "team-goal-id", "bindings"]) {
    requireCondition(Object.hasOwn(values, key), "invalid_arguments", `Missing required option --${key}`)
  }
  const maxEvents = values["max-events"] === undefined ? 256 : Number(values["max-events"])
  const maxArtifacts = values["max-artifacts"] === undefined ? 128 : Number(values["max-artifacts"])
  requireCondition(Number.isSafeInteger(maxEvents) && maxEvents > 0 && maxEvents <= 256,
    "invalid_arguments", "--max-events must be between 1 and 256")
  requireCondition(Number.isSafeInteger(maxArtifacts) && maxArtifacts > 0 && maxArtifacts <= 128,
    "invalid_arguments", "--max-artifacts is invalid")
  return {
    socketPath: validateUnixSocketPath(values.socket),
    statePath: validateAbsolutePath(values.state, "runner state path"),
    receiptId: validateUuid(values["receipt-id"], "receipt ID"),
    teamGoalId: validateUuid(values["team-goal-id"], "Team Goal ID"),
    bindings: parseBindings(values.bindings),
    maxEvents,
    maxArtifacts
  }
}

export class RunnerServer {
  constructor({ socketPath, core, netModule = net, uid = currentUid(), capture = null }) {
    if (process.platform === "win32") throw spikeError("unsupported_platform", "Runner requires Unix-domain sockets")
    this.socketPath = validateUnixSocketPath(socketPath)
    requireCondition(core && typeof core.initialize === "function" && typeof core.acceptBridge === "function",
      "invalid_runner", "RunnerServer requires a RunnerCore")
    requireCondition(netModule && typeof netModule.createServer === "function",
      "invalid_runner", "RunnerServer requires a Unix network module")
    this.core = core
    this.net = netModule
    this.uid = uid
    this.capture = capture
    this.server = undefined
    this.sockets = new Set()
    this.connections = new Map()
    this.closing = false
    this.recorded = []
  }

  async start() {
    requireCondition(this.server === undefined, "runner_started", "RunnerServer is already running")
    requireCondition(this.uid === null || this.uid > 0, "unsafe_execution_identity", "Runner cannot run as UID 0")
    await ensureSocketParent(this.socketPath, this.uid)
    const existing = await verifySocketPath(this.socketPath, this.uid)
    requireCondition(existing === null, "socket_exists", "Runner socket already exists; refuse ambiguous replacement")
    await this.core.initialize()
    this.closing = false
    this.server = this.net.createServer(socket => this.#accept(socket))
    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server?.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        this.server?.off("error", onError)
        resolve()
      }
      this.server.once("error", onError)
      this.server.once("listening", onListening)
      this.server.listen(this.socketPath)
    })
    await chmod(this.socketPath, 0o600)
    const metadata = await verifySocketPath(this.socketPath, this.uid, { allowMissing: false })
    privateMode(metadata, "Runner socket")
    this.#record("listening", { socketPath: this.socketPath, mode: "0600" })
    return this
  }

  async stop() {
    if (this.server === undefined) return
    this.closing = true
    for (const socket of this.sockets) {
      if (!socket.destroyed && typeof socket.destroy === "function") socket.destroy()
    }
    for (const [connectionId, kind] of this.connections) {
      if (kind === "bridge") await this.core.disconnect(connectionId, "runner stopping")
      else if (kind === "control" && typeof this.core.disconnectControl === "function") {
        await this.core.disconnectControl(connectionId)
      }
    }
    this.connections.clear()
    const server = this.server
    this.server = undefined
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    const metadata = await verifySocketPath(this.socketPath, this.uid, { allowMissing: true })
    if (metadata !== null) {
      requireOwner(this.uid, metadata, "Runner socket")
      requireCondition((metadata.mode & 0o077) === 0, "unsafe_socket", "Refusing to remove an accessible socket")
      await unlink(this.socketPath)
    }
    this.#record("stopped", { socketPath: this.socketPath })
  }

  #record(type, data = {}) {
    const record = { type, ...clone(data) }
    this.recorded.push(record)
    if (typeof this.capture === "function") this.capture(record)
    return record
  }

  #send(socket, message) {
    const encoded = encodeMessage(message)
    if (socket.destroyed || socket.writable === false) return false
    socket.write(encoded)
    return true
  }

  #protocolFailure(socket, connectionId, error) {
    const details = errorDetails(error)
    const code = error?.code ?? details.error ?? details.code ?? "protocol_error"
    this.#record("protocol_error", {
      ...(connectionId === null ? {} : { connectionId }),
      code,
      message: details.message
    })
    try {
      if (!socket.destroyed) this.#send(socket, makeProtocolError({
        ...(connectionId === null ? {} : { connectionId }),
        code,
        message: details.message,
        timestamp: Date.now()
      }))
    } catch {}
    if (!socket.destroyed && typeof socket.destroy === "function") socket.destroy()
  }

  #accept(socket) {
    this.sockets.add(socket)
    const decoder = new NdjsonDecoder()
    const connection = { mode: null, connectionId: null }
    let work = Promise.resolve()
    this.#record("connection_opened", {})
    const close = () => {
      this.sockets.delete(socket)
      if (connection.connectionId !== null) {
        if (connection.mode === "bridge") void this.core.disconnect(connection.connectionId, "socket closed")
        if (connection.mode === "control") void this.core.disconnectControl(connection.connectionId)
        this.connections.delete(connection.connectionId)
      }
      this.#record("connection_closed", { connectionId: connection.connectionId })
    }
    socket.on("data", chunk => {
      let messages
      try { messages = decoder.push(chunk) }
      catch (error) {
        this.#protocolFailure(socket, connection.connectionId, error)
        return
      }
      for (const message of messages) {
        work = work.then(() => this.#handleMessage(socket, message, connection)).catch(error => {
          this.#protocolFailure(socket, connection.connectionId, error)
        })
      }
    })
    socket.on("error", error => {
      if (!this.closing) this.#record("socket_error", { connectionId: connection.connectionId, message: error.message })
    })
    socket.once("close", close)
  }

  async #handleMessage(socket, message, connection) {
    validateMessage(message)
    if (connection.mode === null) {
      if (message.type === "hello") {
        const result = await this.core.acceptBridge(message, value => this.#send(socket, value))
        if (socket.destroyed) {
          if (result.accepted) await this.core.disconnect(result.connectionId, "socket closed during handshake")
          return
        }
        if (!result.accepted) {
          this.#send(socket, result.acknowledgement)
          this.#record("bridge_rejected", { role: message.role, reason: result.acknowledgement.reason })
          if (!socket.destroyed && typeof socket.destroy === "function") socket.destroy()
          return
        }
        connection.mode = "bridge"
        connection.connectionId = result.connectionId
        this.connections.set(result.connectionId, "bridge")
        this.#record("bridge_accepted", { role: result.role, connectionId: result.connectionId, resumed: result.resumed })
        this.#send(socket, result.acknowledgement)
        for (const outgoing of result.messages) this.#send(socket, outgoing)
        return
      }
      if (message.type === "control_hello") {
        const result = await this.core.acceptControl(message, value => this.#send(socket, value))
        if (socket.destroyed) {
          if (result.accepted && typeof this.core.disconnectControl === "function") {
            await this.core.disconnectControl(result.connectionId)
          }
          return
        }
        if (!result.accepted) {
          this.#send(socket, result.acknowledgement)
          this.#record("control_rejected", { reason: result.acknowledgement.reason })
          if (!socket.destroyed && typeof socket.destroy === "function") socket.destroy()
          return
        }
        connection.mode = "control"
        connection.connectionId = result.connectionId
        this.connections.set(result.connectionId, "control")
        this.#record("control_accepted", { connectionId: result.connectionId })
        this.#send(socket, result.acknowledgement)
        return
      }
      throw spikeError("handshake_required", "Connection handshake is required")
    }
    if (connection.mode === "bridge") {
      requireCondition(message.type === "assignment_ack" || message.type === "event"
        || message.type === "state_snapshot", "unexpected_message", "Bridge message type is not accepted")
      const result = await this.core.handleBridgeMessage(connection.connectionId, message)
      this.#record("bridge_message", {
        connectionId: connection.connectionId,
        type: message.type,
        recorded: result.recorded,
        duplicate: result.duplicate ?? false,
        gap: result.gap ?? false
      })
      return
    }
    if (connection.mode === "control") {
      requireCondition(message.type === "control_request", "unexpected_message", "Control message type is not accepted")
      const response = await this.core.handleControlMessage(connection.connectionId, message)
      this.#send(socket, response)
      this.#record("control_response", { connectionId: connection.connectionId, requestId: message.requestId, status: response.status })
      return
    }
    throw spikeError("unexpected_message", "Connection mode is invalid")
  }
}

export async function runForeground(argv = process.argv.slice(2)) {
  const options = parseRunnerArguments(argv)
  if (options.help) {
    process.stdout.write("Usage: node runner.mjs --socket PATH --state PATH --receipt-id UUID --team-goal-id UUID --bindings ROLE:AGENT:SHELL,...\n")
    return
  }
  const uid = currentUid()
  requireCondition(uid === null || uid > 0, "unsafe_execution_identity", "Runner must run as an unprivileged identity")
  const store = new DurableStateStore(options.statePath, {
    maxEvents: options.maxEvents,
    maxArtifacts: options.maxArtifacts
  })
  const core = new RunnerCore({
    store,
    receiptId: options.receiptId,
    teamGoalId: options.teamGoalId,
    bindings: options.bindings,
    maxEvents: options.maxEvents,
    maxArtifacts: options.maxArtifacts
  })
  const runner = new RunnerServer({
    socketPath: options.socketPath,
    core,
    uid,
    capture: record => process.stdout.write(`${JSON.stringify(record)}\n`)
  })
  await runner.start()
  await new Promise(resolve => {
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      runner.stop().then(resolve, error => {
        process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`)
        process.exitCode = 1
        resolve()
      })
    }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedAsScript) {
  runForeground().catch(error => {
    process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`)
    process.exitCode = 1
  })
}