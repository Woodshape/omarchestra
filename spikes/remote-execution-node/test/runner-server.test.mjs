import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { once } from "node:events"
import { test } from "node:test"

import {
  encodeMessage,
  NdjsonDecoder,
  makeAssignmentAck,
  makeControlHello,
  makeControlRequest,
  makeEvent
} from "../lib/protocol.mjs"
import { MemoryDurableStore } from "../lib/durable-store.mjs"
import { RunnerCore } from "../lib/runner-core.mjs"
import { RunnerServer } from "../runner.mjs"
import { REMOTE_BINDINGS, REMOTE_IDS, bridgeHello } from "./remote-fixtures.mjs"

function connectClient(socketPath) {
  const socket = net.createConnection({ path: socketPath })
  const decoder = new NdjsonDecoder()
  const messages = []
  const waiters = []
  let failure = null
  const deliver = message => {
    const index = waiters.findIndex(waiter => waiter.type === undefined || waiter.type === message.type)
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message)
    else messages.push(message)
  }
  socket.on("data", chunk => {
    for (const message of decoder.push(chunk)) deliver(message)
  })
  socket.once("error", error => {
    failure = error
    while (waiters.length > 0) waiters.shift().reject(error)
  })
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve({
      socket,
      send: message => socket.write(encodeMessage(message)),
      wait: type => {
        const message = messages.find(item => type === undefined || item.type === type)
        if (message) {
          messages.splice(messages.indexOf(message), 1)
          return Promise.resolve(message)
        }
        if (failure) return Promise.reject(failure)
        return new Promise((resolveWait, rejectWait) => waiters.push({ type, resolve: resolveWait, reject: rejectWait }))
      }
    }))
    socket.once("error", reject)
  })
}

test("RunnerServer completes bridge and control handshakes over one Unix socket", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-runner-server-"))
  const socketPath = path.join(directory, "runner.sock")
  const core = new RunnerCore({
    store: new MemoryDurableStore(),
    receiptId: REMOTE_IDS.receipt,
    teamGoalId: REMOTE_IDS.teamGoal,
    bindings: REMOTE_BINDINGS
  })
  const server = new RunnerServer({ socketPath, core, uid: process.getuid() })
  let control
  let bridge
  try {
    await server.start()
    control = await connectClient(socketPath)
    control.send(makeControlHello({
      receiptId: REMOTE_IDS.receipt,
      teamGoalId: REMOTE_IDS.teamGoal,
      controlClientId: "integration-control",
      timestamp: 1
    }))
    assert.equal((await control.wait("control_ack")).accepted, true)

    bridge = await connectClient(socketPath)
    bridge.send(bridgeHello("builder"))
    assert.equal((await bridge.wait("hello_ack")).accepted, true)
    assert.equal((await bridge.wait("runner_snapshot")).role, "builder")

    control.send(makeControlRequest({
      requestId: "assign-request",
      operation: "assign",
      payload: { role: "builder", assignmentId: "server-assignment", prompt: "Run the server integration" },
      timestamp: 2
    }))
    assert.equal((await control.wait("control_response")).status, "ok")
    assert.equal((await bridge.wait("assignment")).assignmentId, "server-assignment")

    bridge.send(makeAssignmentAck({
      role: "builder", assignmentId: "server-assignment", status: "accepted", timestamp: 3
    }))
    bridge.send(makeEvent({
      role: "builder", eventId: "server-event-1", sequence: 1,
      eventType: "assignment_started", assignmentId: "server-assignment", timestamp: 4, data: {}
    }))
    control.send(makeControlRequest({
      requestId: "events-request", operation: "events", payload: { after: null, limit: 32 }, timestamp: 5
    }))
    const events = await control.wait("control_response")
    assert.equal(events.status, "ok")
    assert.ok(events.data.events.some(event => event.eventType === "assignment_started"))
  } finally {
    bridge?.socket.destroy()
    control?.socket.destroy()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})