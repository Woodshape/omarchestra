import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  NdjsonDecoder,
  encodeMessage,
  makeAssignment,
  makeHelloAck,
} from "../lib/protocol.mjs";
import {
  createBridgeState,
  evaluateAssignment,
  markAssignmentStarted,
  markAssignmentSettled,
  observeSubmittedInput,
} from "../lib/state.mjs";
import { ReconnectingBridgeClient } from "../lib/client.mjs";

function state() {
  return createBridgeState({ agentRunId: "agent", piSessionId: "session", extensionInstanceId: "instance" });
}

class FakeSocket extends EventEmitter {
  writable = true;
  destroyed = false;
  writes = [];
  write(value) { this.writes.push(value); return true; }
  destroy() { this.destroyed = true; this.writable = false; this.emit("close"); }
}

class FakeNet {
  sockets = [];
  createConnection() {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  }
}

function decodeWrites(socket) {
  const decoder = new NdjsonDecoder();
  return socket.writes.flatMap((write) => decoder.push(write));
}

test("state projection accepts idle assignment, deduplicates, and settles", () => {
  let current = state();
  const assignment = makeAssignment({ assignmentId: "a1", prompt: "do it", timestamp: 1 });
  let result = evaluateAssignment(current, assignment, { isIdle: true, timestamp: 2 });
  assert.equal(result.acknowledgement.status, "accepted");
  current = result.state;
  current = markAssignmentStarted(current);
  result = evaluateAssignment(current, assignment, { isIdle: true, timestamp: 3 });
  assert.equal(result.acknowledgement.status, "duplicate");
  current = markAssignmentSettled(current);
  assert.equal(current.assignment.state, "settled");
});

test("source classification rule only treats interactive as human", () => {
  const current = state();
  assert.equal(observeSubmittedInput(current, "extension").takeover, false);
  assert.equal(observeSubmittedInput(current, "rpc").takeover, false);
  const result = observeSubmittedInput(current, "interactive");
  assert.equal(result.takeover, true);
  assert.equal(result.state.controlMode, "manual_takeover");
});

test("serialization is one bounded NDJSON frame", () => {
  const message = makeHelloAck({ connectionId: "runner-1", accepted: true, timestamp: 1 });
  assert.equal(encodeMessage(message).split("\n").length, 2);
  assert.deepEqual(JSON.parse(encodeMessage(message)), message);
});

test("client handshakes, receives messages, and reconnects with bounded retry", async () => {
  const net = new FakeNet();
  const states = [];
  const messages = [];
  const client = new ReconnectingBridgeClient({
    socketPath: "/tmp/bridge.sock",
    netModule: net,
    minDelayMs: 1,
    maxDelayMs: 2,
    makeHello: () => ({ type: "hello", protocolVersion: 1, agentRunId: "agent", piSessionId: "session", extensionInstanceId: "instance", pid: 1, mode: "tui", timestamp: 1 }),
    onState: (kind) => states.push(kind),
    onMessage: (message) => messages.push(message),
  });
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(net.sockets.length, 1);
  assert.equal(decodeWrites(net.sockets[0])[0].type, "hello");
  net.sockets[0].emit("data", encodeMessage(makeHelloAck({ connectionId: "runner-1", accepted: true, timestamp: 1 })));
  net.sockets[0].emit("data", encodeMessage(makeAssignment({ assignmentId: "a1", prompt: "hello", timestamp: 1 })));
  assert.deepEqual(messages.map((message) => message.type), ["hello_ack", "assignment"]);
  net.sockets[0].destroy();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(net.sockets.length >= 2);
  client.close();
  assert.equal(states.at(-1), "closed");
});
