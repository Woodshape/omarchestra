import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NdjsonDecoder, encodeMessage, makeAssignmentAck, makeHello } from "../lib/protocol.mjs";
import { RunnerStub } from "../runner.mjs";

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omarchestra-runner-"));
  const records = [];
  const runner = new RunnerStub({
    socketPath: join(directory, "bridge.sock"),
    capture: (record) => records.push(record),
    ...options,
  });
  await runner.start();
  return {
    directory,
    records,
    runner,
    async cleanup() {
      await runner.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function hello(id = "agent-1") {
  return makeHello({
    agentRunId: id,
    piSessionId: "session-1",
    extensionInstanceId: "extension-1",
    pid: 123,
    mode: "tui",
    timestamp: 1,
  });
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readMessages(socket, count) {
  const decoder = new NdjsonDecoder();
  const messages = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${count} messages`)), 1_000);
    socket.on("data", (chunk) => {
      try {
        messages.push(...decoder.push(chunk));
        if (messages.length >= count) {
          clearTimeout(timeout);
          resolve(messages);
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function waitFor(predicate, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("timed out waiting for condition"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("accepts a fragmented hello frame and deterministically sends hello_ack then assignment", async () => {
  const context = await fixture({ assignment: { assignmentId: "assignment-1", prompt: "Inspect this spike" } });
  try {
    const socket = await connect(context.runner.socketPath);
    const received = readMessages(socket, 2);
    const frame = encodeMessage(hello());
    socket.write(frame.slice(0, 7));
    socket.write(frame.slice(7));
    const [acknowledgement, assignment] = await received;

    assert.equal(acknowledgement.type, "hello_ack");
    assert.equal(acknowledgement.accepted, true);
    assert.equal(assignment.type, "assignment");
    assert.equal(assignment.assignmentId, "assignment-1");
    assert.equal(assignment.prompt, "Inspect this spike");
    assert.deepEqual(context.records.map((record) => record.type).slice(0, 4), [
      "listening", "connection_opened", "hello", "sent",
    ]);
    socket.destroy();
  } finally {
    await context.cleanup();
  }
});

test("captures accepted, busy, and invalid assignment acknowledgements as structured stdout records", async () => {
  const context = await fixture({ assignment: { assignmentId: "assignment-2", prompt: "Work" } });
  try {
    const socket = await connect(context.runner.socketPath);
    const received = readMessages(socket, 2);
    socket.write(encodeMessage(hello()));
    await received;
    socket.write(encodeMessage(makeAssignmentAck({
      assignmentId: "assignment-2",
      status: "accepted",
      timestamp: 2,
    })));
    socket.write(encodeMessage(makeAssignmentAck({
      assignmentId: "assignment-3",
      status: "busy",
      reason: "visible session is busy",
      timestamp: 3,
    })));
    socket.write(encodeMessage(makeAssignmentAck({
      assignmentId: "assignment-4",
      status: "invalid",
      reason: "assignment violates bridge policy",
      timestamp: 4,
    })));
    await waitFor(() => context.runner.acknowledgements.length === 3);

    assert.deepEqual(
      context.runner.acknowledgements.map(({ message }) => message.status),
      ["accepted", "busy", "invalid"],
    );
    assert.equal(context.records.filter((record) => record.type === "assignment_ack").length, 3);
    socket.destroy();
  } finally {
    await context.cleanup();
  }
});

test("rejects malformed frames and records the protocol failure", async () => {
  const context = await fixture();
  try {
    const socket = await connect(context.runner.socketPath);
    socket.write("{not json}\n");
    await new Promise((resolve) => socket.once("close", resolve));
    const failure = context.records.find((record) => record.type === "protocol_error");
    assert.equal(failure.code, "invalid_json");
  } finally {
    await context.cleanup();
  }
});

test("requires hello before any bridge message", async () => {
  const context = await fixture();
  try {
    const socket = await connect(context.runner.socketPath);
    socket.write(encodeMessage(makeAssignmentAck({
      assignmentId: "assignment-4",
      status: "duplicate",
      reason: "already handled",
      timestamp: 1,
    })));
    await new Promise((resolve) => socket.once("close", resolve));
    const failure = context.records.find((record) => record.type === "protocol_error");
    assert.equal(failure.code, "handshake_required");
  } finally {
    await context.cleanup();
  }
});

test("runner stop removes its listener so a replacement accepts a fresh handshake", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omarchestra-runner-replace-"));
  const socketPath = join(directory, "bridge.sock");
  const firstRecords = [];
  const first = new RunnerStub({ socketPath, capture: (record) => firstRecords.push(record) });
  const replacementRecords = [];
  const replacement = new RunnerStub({ socketPath, capture: (record) => replacementRecords.push(record) });
  try {
    await first.start();
    await first.stop();
    await replacement.start();
    const socket = await connect(socketPath);
    const response = readMessages(socket, 1);
    socket.write(encodeMessage(hello("agent-reconnected")));
    const [acknowledgement] = await response;

    assert.equal(acknowledgement.type, "hello_ack");
    assert.equal(firstRecords.at(-1).type, "stopped");
    assert.ok(replacementRecords.some((record) => record.type === "hello"));
    socket.destroy();
  } finally {
    await first.stop();
    await replacement.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
