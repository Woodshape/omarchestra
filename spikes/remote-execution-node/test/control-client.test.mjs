import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"

import { ReconnectingControlClient } from "../lib/control-client.mjs"
import { NdjsonDecoder, encodeMessage, makeControlAck, makeControlResponse } from "../lib/protocol.mjs"
import { REMOTE_IDS } from "./remote-fixtures.mjs"

class FakeReadable extends EventEmitter {}

class FakeTransport {
  constructor(number) {
    this.number = number
    this.readable = new FakeReadable()
    this.writes = []
    this.decoder = new NdjsonDecoder()
    this.writable = {
      write: encoded => {
        this.writes.push(encoded)
        for (const message of this.decoder.push(encoded)) this.#respond(message)
        return true
      },
      end: () => this.close()
    }
  }

  #respond(message) {
    if (message.type === "control_hello") {
      queueMicrotask(() => this.readable.emit("data", encodeMessage(makeControlAck({
        connectionId: `control-${this.number}`,
        accepted: true,
        timestamp: 2
      }))))
      return
    }
    if (message.type !== "control_request") return
    const data = message.operation === "events"
      ? { cursor: `runner-${REMOTE_IDS.receipt}:4`, firstCursor: `runner-${REMOTE_IDS.receipt}:1`, baseline: false, gap: false, snapshot: null, events: [] }
      : { cursor: `runner-${REMOTE_IDS.receipt}:4`, sequence: 4 }
    queueMicrotask(() => this.readable.emit("data", encodeMessage(makeControlResponse({
      requestId: message.requestId,
      status: "ok",
      data,
      timestamp: 3
    }))))
  }

  close() {
    this.readable.emit("close")
  }
}

function wait(ms = 5) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test("control client reconnects an SSH-stdio-shaped transport and requests a fresh snapshot", async () => {
  const transports = []
  const states = []
  const snapshots = []
  const client = new ReconnectingControlClient({
    receiptId: REMOTE_IDS.receipt,
    teamGoalId: REMOTE_IDS.teamGoal,
    controlClientId: "desktop-control",
    transportFactory: () => {
      const transport = new FakeTransport(transports.length + 1)
      transports.push(transport)
      return transport
    },
    minDelayMs: 1,
    maxDelayMs: 2,
    onState: kind => states.push(kind),
    onSnapshot: snapshot => snapshots.push(snapshot)
  })
  const queued = client.request("snapshot")
  client.start()
  assert.equal((await queued).sequence, 4)
  assert.equal(transports.length, 1)
  transports[0].close()
  await wait(6)
  assert.ok(transports.length >= 2)
  assert.ok(states.includes("disconnected"))
  assert.ok(states.includes("reconnected"))
  await wait()
  assert.ok(snapshots.length >= 1)
  const page = await client.request("events", { after: `runner-${REMOTE_IDS.receipt}:1`, limit: 10 })
  assert.equal(page.gap, false)
  client.close()
  assert.equal(states.at(-1), "closed")
})