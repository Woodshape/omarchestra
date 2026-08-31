import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import { ReconnectingBridgeClient } from "../lib/bridge-client.mjs"
import { createBridgeState, createHello, nextEvent } from "../lib/bridge-state.mjs"
import { makeHelloAck, makeRunnerSnapshot, NdjsonDecoder, encodeMessage } from "../lib/protocol.mjs"
import {
  boundedTextDeltaSummary,
  redactAttentionMetadata,
  redactMessageMetadata,
  redactToolMetadata
} from "../lib/telemetry.mjs"
import { REMOTE_IDS, bridgeHello } from "./remote-fixtures.mjs"

class FakeSocket extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.writes = []
    this.writable = true
    this.destroyed = false
  }

  write(value) {
    if (this.destroyed) return false
    this.writes.push(value)
    return true
  }

  end() {
    this.destroy()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.writable = false
    this.emit("close")
  }
}

class FakeNet {
  constructor() { this.sockets = [] }
  createConnection(options) {
    const socket = new FakeSocket(options)
    this.sockets.push(socket)
    queueMicrotask(() => socket.emit("connect"))
    return socket
  }
}

function decoded(socket) {
  const decoder = new NdjsonDecoder()
  return socket.writes.flatMap(write => decoder.push(write))
}

test("bridge client uses Unix path options, queues bounded events, and reconnects with the same hello", async () => {
  const net = new FakeNet()
  const states = []
  const messages = []
  const state = createBridgeState({
    teamGoalId: REMOTE_IDS.teamGoal,
    role: "builder",
    agentRunId: REMOTE_IDS.builder,
    shellId: "shell-builder",
    piSessionId: "pi-builder",
    extensionInstanceId: "extension-builder",
    pid: 102
  })
  const client = new ReconnectingBridgeClient({
    socketPath: "/tmp/remote-bridge.sock",
    netModule: net,
    minDelayMs: 1,
    maxDelayMs: 2,
    makeHello: () => createHello(state, { timestamp: 1 }),
    onState: (kind, detail) => states.push({ kind, detail }),
    onMessage: message => messages.push(message)
  })
  let eventState = nextEvent(state, "session_started", { mode: "tui" }).state
  const event = nextEvent(eventState, "agent_started", {}).event
  client.send(event)
  client.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(net.sockets.length, 1)
  assert.deepEqual(net.sockets[0].options, { path: "/tmp/remote-bridge.sock" })
  assert.equal(decoded(net.sockets[0])[0].type, "hello")
  net.sockets[0].emit("data", encodeMessage(makeHelloAck({
    connectionId: "bridge-builder-1", accepted: true, role: "builder", resumed: false,
    cursor: "runner-1:0", timestamp: 2
  })))
  net.sockets[0].emit("data", encodeMessage(makeRunnerSnapshot({
    teamGoalId: REMOTE_IDS.teamGoal,
    role: "builder",
    cursor: "runner-1:0",
    assignment: null,
    controlMode: "managed",
    timestamp: 2
  })))
  assert.deepEqual(messages.map(message => message.type), ["hello_ack", "runner_snapshot"])
  assert.ok(decoded(net.sockets[0]).some(message => message.type === "event"))
  net.sockets[0].destroy()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(net.sockets.length >= 2)
  net.sockets[1].emit("data", encodeMessage(makeHelloAck({
    connectionId: "bridge-builder-2", accepted: true, role: "builder", resumed: true,
    cursor: "runner-1:2", timestamp: 3
  })))
  assert.ok(states.some(item => item.kind === "connected"))
  assert.ok(states.some(item => item.kind === "disconnected"))
  client.close()
  assert.equal(states.at(-1).kind, "closed")
})

test("terminal runner rejection stops retry and does not permit a role takeover", async () => {
  const net = new FakeNet()
  const states = []
  const hello = bridgeHello("reviewer")
  const client = new ReconnectingBridgeClient({
    socketPath: "/tmp/rejection.sock",
    netModule: net,
    minDelayMs: 1,
    maxDelayMs: 2,
    makeHello: () => hello,
    onState: (kind, detail) => states.push({ kind, detail })
  })
  client.start()
  await new Promise(resolve => setImmediate(resolve))
  net.sockets[0].emit("data", encodeMessage(makeHelloAck({
    connectionId: "rejected-1", accepted: false, role: "reviewer", reason: "role_already_connected", timestamp: 1
  })))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(net.sockets.length, 1)
  assert.equal(states.at(-1).kind, "rejected")
  assert.ok(states.some(item => item.kind === "rejected"))
  client.close()
})


test("bridge telemetry is metadata-only, bounded, and coalesced", () => {
  const message = redactMessageMetadata({
    role: "toolResult",
    toolName: "read",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "private tool output" }
    ]
  })
  assert.equal(Object.hasOwn(message, "content"), false)
  assert.equal(Object.hasOwn(message, "thinking"), false)
  assert.deepEqual(message.blockTypes, ["text"])
  const tool = redactToolMetadata({ toolCallId: "tool-1", toolName: "read", result: { content: "secret" } })
  assert.deepEqual(tool, { toolCallId: "tool-1", toolName: "read" })
  const attention = redactAttentionMetadata({ kind: "confirm", reason: "sensitive prompt" })
  assert.deepEqual(attention, { owner: "agent", kind: "confirm", reason: "sensitive prompt" })
  assert.equal(boundedTextDeltaSummary(1000, 4000).deltaCount, 1000)
  assert.ok(JSON.stringify(message).length < 16_384)
})

test("bridge sources contain the visible sendUserMessage boundary and no process/session launcher", async () => {
  const source = await readFile(new URL("../bridge-extension.js", import.meta.url), "utf8")
  assert.match(source, /pi\.sendUserMessage\(assignment\.prompt\)/)
  assert.doesNotMatch(source, /node:child_process/)
  assert.doesNotMatch(source, /createAgentSession|runRpcMode|InteractiveMode/)
  assert.doesNotMatch(source, /writeToPty|injectPty|ptyInput|node-pty/)
})