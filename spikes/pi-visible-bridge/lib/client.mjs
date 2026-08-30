import net from "node:net";
import {
  NdjsonDecoder,
  encodeMessage,
} from "./protocol.mjs";

export class ReconnectingBridgeClient {
  #net;
  #socket;
  #decoder;
  #timer;
  #closed = false;
  #connecting = false;
  #attempt = 0;
  #onMessage;
  #onState;

  constructor({ socketPath, makeHello, onMessage, onState = () => {}, netModule = net,
    minDelayMs = 100, maxDelayMs = 2_000 }) {
    if (!socketPath) throw new TypeError("socketPath is required");
    this.socketPath = socketPath;
    this.makeHello = makeHello;
    this.#onMessage = onMessage;
    this.#onState = onState;
    this.#net = netModule;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  start() {
    if (this.#closed) throw new Error("client is closed");
    this.#connect();
  }

  send(message) {
    if (!this.#socket || this.#socket.destroyed || !this.#socket.writable) return false;
    this.#socket.write(encodeMessage(message));
    return true;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && !socket.destroyed) {
      if (typeof socket.end === "function") socket.end();
      else socket.destroy();
    }
    this.#onState("closed");
  }

  #connect() {
    if (this.#closed || this.#connecting) return;
    this.#connecting = true;
    this.#decoder = new NdjsonDecoder();
    const socket = this.#net.createConnection(this.socketPath);
    this.#socket = socket;
    let acknowledged = false;
    const fail = () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#connecting = false;
      if (!this.#closed) {
        this.#onState("disconnected");
        this.#scheduleReconnect();
      }
    };
    socket.once("connect", () => {
      if (this.#closed) return;
      this.#attempt = 0;
      this.#onState("connecting");
      socket.write(encodeMessage(this.makeHello()));
    });
    socket.on("data", (chunk) => {
      let messages;
      try { messages = this.#decoder.push(chunk); } catch (error) {
        this.#onState("protocol_error", error);
        socket.destroy();
        return;
      }
      for (const message of messages) {
        if (message.type === "hello_ack") {
          if (!message.accepted) {
            this.#onState("rejected", message.reason);
            socket.destroy();
            return;
          }
          acknowledged = true;
          this.#connecting = false;
          this.#onState("connected", message);
        }
        this.#onMessage(message);
      }
    });
    socket.once("error", (error) => {
      if (!acknowledged) this.#onState("connect_error", error);
    });
    socket.once("close", fail);
  }

  #scheduleReconnect() {
    if (this.#timer || this.#closed) return;
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * (2 ** this.#attempt));
    this.#attempt += 1;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
  }
}
