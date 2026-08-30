import net from "node:net";
import { access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  NdjsonDecoder,
  ProtocolError,
  encodeMessage,
  makeAssignment,
  makeHelloAck,
} from "./lib/protocol.mjs";

function socketExists(path) {
  return access(path).then(() => true, () => false);
}

function defaultCapture(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    code: error instanceof ProtocolError ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Throwaway local runner for the visible-Pi bridge spike. It owns removal of
 * its Unix socket path and accepts one bridge connection at a time.
 */
export class RunnerStub {
  #server;
  #connections = new Set();
  #connectionNumber = 0;
  #stopping = false;

  constructor({ socketPath, assignment = null, capture = defaultCapture, now = () => Date.now() }) {
    if (process.platform === "win32") {
      throw new Error("RunnerStub requires a Unix-domain socket");
    }
    if (typeof socketPath !== "string" || socketPath.length === 0) {
      throw new TypeError("socketPath is required");
    }
    if (assignment !== null && (
      typeof assignment !== "object" ||
      typeof assignment.assignmentId !== "string" ||
      typeof assignment.prompt !== "string"
    )) {
      throw new TypeError("assignment must be null or contain assignmentId and prompt");
    }

    this.socketPath = socketPath;
    this.assignment = assignment === null ? null : { ...assignment };
    this.capture = capture;
    this.now = now;
    this.records = [];
    this.acknowledgements = [];
  }

  async start() {
    if (this.#server) throw new Error("runner is already listening");
    this.#stopping = false;
    // Only the runner ever removes this path. This is intentionally done
    // before listen so a restarted runner can replace a dead listener.
    if (await socketExists(this.socketPath)) await rm(this.socketPath, { force: true });

    this.#server = net.createServer((socket) => this.#accept(socket));
    this.#server.on("error", (error) => this.#record("listener_error", errorDetails(error)));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.#server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server?.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.socketPath);
    });
    this.#record("listening", { socketPath: this.socketPath });
    return this;
  }

  async stop() {
    if (!this.#server) return;
    this.#stopping = true;
    for (const socket of this.#connections) socket.end();
    await Promise.all([...this.#connections].map((socket) => new Promise((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    })));

    const server = this.#server;
    this.#server = undefined;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(this.socketPath, { force: true });
    this.#record("stopped", { socketPath: this.socketPath });
  }

  #record(type, data = {}) {
    const record = { type, timestamp: this.now(), ...data };
    this.records.push(record);
    this.capture(record);
    return record;
  }

  #send(socket, message) {
    socket.write(encodeMessage(message));
    this.#record("sent", { message });
  }

  #accept(socket) {
    const connectionId = `runner-${++this.#connectionNumber}`;
    const decoder = new NdjsonDecoder();
    let helloReceived = false;
    this.#connections.add(socket);
    this.#record("connection_opened", { connectionId });

    const reject = (code, message) => {
      this.#record("protocol_error", { connectionId, code, message });
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        const details = errorDetails(error);
        reject(details.code ?? "decode_error", details.message);
        return;
      }
      for (const message of messages) {
        if (!helloReceived) {
          if (message.type !== "hello") {
            reject("handshake_required", "hello must be the first message");
            return;
          }
          helloReceived = true;
          this.#record("hello", { connectionId, message });
          const acknowledgement = makeHelloAck({
            connectionId,
            accepted: true,
            timestamp: this.now(),
          });
          this.#send(socket, acknowledgement);
          if (this.assignment) {
            const assignment = makeAssignment({
              ...this.assignment,
              timestamp: this.now(),
            });
            this.#send(socket, assignment);
          }
          continue;
        }

        if (message.type === "hello" || message.type === "hello_ack" || message.type === "assignment") {
          reject("unexpected_message", `${message.type} is not accepted from a bridge`);
          return;
        }
        if (message.type === "assignment_ack") {
          this.acknowledgements.push({ connectionId, message });
          this.#record("assignment_ack", { connectionId, message });
        } else {
          this.#record(message.type, { connectionId, message });
        }
      }
    });

    socket.on("error", (error) => {
      if (!this.#stopping) this.#record("connection_error", { connectionId, ...errorDetails(error) });
    });
    socket.on("close", () => {
      this.#connections.delete(socket);
      this.#record("connection_closed", { connectionId });
    });
  }
}

function parseArguments(argv) {
  const options = { socketPath: undefined, assignmentId: undefined, prompt: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--socket" || argument === "--assignment-id" || argument === "--prompt") {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--socket") options.socketPath = value;
      if (argument === "--assignment-id") options.assignmentId = value;
      if (argument === "--prompt") options.prompt = value;
    } else if (argument === "--help") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.socketPath) throw new Error("--socket is required");
  if ((options.assignmentId === undefined) !== (options.prompt === undefined)) {
    throw new Error("--assignment-id and --prompt must be supplied together");
  }
  return options;
}

export async function runForeground(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write("Usage: node runner.mjs --socket PATH [--assignment-id ID --prompt TEXT]\n");
    return;
  }
  const runner = new RunnerStub({
    socketPath: options.socketPath,
    assignment: options.assignmentId === undefined
      ? null
      : { assignmentId: options.assignmentId, prompt: options.prompt },
  });
  await runner.start();
  await new Promise((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      runner.stop().then(resolve, (error) => {
        defaultCapture({ type: "shutdown_error", timestamp: Date.now(), ...errorDetails(error) });
        process.exitCode = 1;
        resolve();
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  runForeground().catch((error) => {
    defaultCapture({ type: "startup_error", timestamp: Date.now(), ...errorDetails(error) });
    process.exitCode = 1;
  });
}
