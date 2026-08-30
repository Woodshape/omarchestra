import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReconnectingBridgeClient } from "../lib/client.mjs";
import { makeAssignment } from "../lib/protocol.mjs";
import {
  createBridgeState,
  createHello,
  createStateSnapshot,
  evaluateAssignment,
  markAssignmentStarted,
  markConnected,
  markDisconnected,
  nextEvent,
} from "../lib/state.mjs";
import { RunnerStub } from "../runner.mjs";

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for bridge condition"));
      setTimeout(check, 10);
    };
    check();
  });
}

function received(records, type) {
  return records.filter((record) => record.type === type).map((record) => record.message);
}

class BridgeHarness {
  constructor(socketPath) {
    this.state = createBridgeState({
      agentRunId: "agent-1",
      piSessionId: "session-1",
      extensionInstanceId: "extension-1",
    });
    this.connectionStates = [];
    this.client = new ReconnectingBridgeClient({
      socketPath,
      minDelayMs: 10,
      maxDelayMs: 20,
      makeHello: () => createHello(this.state),
      onState: (type) => this.#onState(type),
      onMessage: (message) => this.#onMessage(message),
    });
  }

  start() {
    this.client.start();
  }

  close() {
    this.client.close();
  }

  emit(eventType, data = {}) {
    const result = nextEvent(this.state, eventType, data);
    this.state = result.state;
    assert.equal(this.client.send(result.event), true);
  }

  #onState(type) {
    this.connectionStates.push(type);
    if (type === "disconnected") {
      this.state = markDisconnected(this.state).state;
      return;
    }
    if (type !== "connected") return;
    const result = markConnected(this.state);
    this.state = result.state;
    if (result.eventType) this.emit(result.eventType);
    assert.equal(this.client.send(createStateSnapshot(this.state)), true);
  }

  #onMessage(message) {
    if (message.type !== "assignment") return;
    const result = evaluateAssignment(this.state, message, { isIdle: true });
    this.state = result.state;
    assert.equal(this.client.send(result.acknowledgement), true);
    if (result.acknowledgement.status !== "accepted") return;
    this.state = markAssignmentStarted(this.state);
    this.emit("assignment_started", { promptCharacters: message.prompt.length });
  }
}

async function startRunner(socketPath, assignment) {
  const records = [];
  const runner = new RunnerStub({
    socketPath,
    assignment,
    capture: (record) => records.push(record),
  });
  await runner.start();
  return { runner, records };
}

test("bridge reconnect preserves assignment state and emits ordered events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omarchestra-integration-"));
  const socketPath = join(directory, "bridge.sock");
  const assignmentOne = { assignmentId: "assignment-1", prompt: "Implement the visible bridge spike" };
  const assignmentTwo = { assignmentId: "assignment-2", prompt: "This must wait" };
  let first;
  let second;
  let third;
  let bridge;

  try {
    first = await startRunner(socketPath, assignmentOne);
    bridge = new BridgeHarness(socketPath);
    bridge.start();

    await waitFor(() => first.runner.acknowledgements.length === 1);
    assert.equal(first.runner.acknowledgements[0].message.status, "accepted");
    assert.equal(received(first.records, "sent").filter((message) => message.type === "assignment").length, 1);
    const firstEvents = received(first.records, "event");
    assert.deepEqual(firstEvents.map((event) => event.eventType), ["bridge_connected", "assignment_started"]);
    assert.deepEqual(firstEvents.map((event) => event.sequence), [1, 2]);

    await first.runner.stop();
    second = await startRunner(socketPath, assignmentTwo);
    await waitFor(() => second.runner.acknowledgements.length === 1);
    assert.equal(second.runner.acknowledgements[0].message.status, "busy");
    const reconnectSnapshot = received(second.records, "state_snapshot").at(-1);
    assert.equal(reconnectSnapshot.connectionState, "connected");
    assert.deepEqual(reconnectSnapshot.assignment, { assignmentId: "assignment-1", state: "working" });
    assert.ok(received(second.records, "event").some((event) => event.eventType === "bridge_reconnected"));

    await second.runner.stop();
    third = await startRunner(socketPath, assignmentOne);
    await waitFor(() => third.runner.acknowledgements.length === 1);
    assert.equal(third.runner.acknowledgements[0].message.status, "duplicate");
    bridge.emit("agent_settled", { source: "integration-test" });
    await waitFor(() => received(third.records, "event").some((event) => event.eventType === "agent_settled"));

    const thirdEvents = received(third.records, "event");
    assert.deepEqual(thirdEvents.map((event) => event.sequence), [4, 5]);
    assert.deepEqual(thirdEvents.map((event) => event.eventType), ["bridge_reconnected", "agent_settled"]);
    assert.equal(bridge.connectionStates.filter((state) => state === "connected").length, 3);
  } finally {
    bridge?.close();
    await third?.runner.stop();
    await second?.runner.stop();
    await first?.runner.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("spike sources cannot create or spawn a hidden Pi/SDK/PTY agent", async () => {
  const sources = [
    "extension.ts",
    "runner.mjs",
    "lib/client.mjs",
    "lib/protocol.mjs",
    "lib/state.mjs",
  ];
  const prohibited = [
    /\bcreateAgentSession\b/,
    /\bInteractiveMode\b/,
    /\brunRpcMode\b/,
    /(?:from|require\()\s*["']node:child_process["']/,
    /\b(?:spawn|spawnSync|execFile|exec)\s*\(\s*["']pi(?:\.m?js)?["']/,
    /\bnode-pty\b/,
    /\b(?:writeToPty|injectPty|ptyInput)\b/,
  ];

  for (const relativePath of sources) {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    for (const pattern of prohibited) {
      assert.equal(pattern.test(source), false, `${relativePath} matches prohibited ${pattern}`);
    }
  }
});
