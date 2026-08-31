import net from "node:net"

import { encodeMessage, NdjsonDecoder, ProtocolError } from "./protocol.mjs"
import { requireCondition } from "./errors.mjs"
import { validateUnixSocketPath } from "./validation.mjs"

export class ReconnectingBridgeClient {
  constructor({
    socketPath,
    makeHello,
    onMessage = () => {},
    onState = () => {},
    netModule = net,
    minDelayMs = 100,
    maxDelayMs = 2_000,
    maxPending = 256
  }) {
    validateUnixSocketPath(socketPath)
    requireCondition(typeof makeHello === "function", "invalid_transport", "makeHello is required")
    requireCondition(typeof onMessage === "function" && typeof onState === "function",
      "invalid_transport", "Bridge callbacks must be functions")
    requireCondition(netModule && typeof netModule.createConnection === "function",
      "invalid_transport", "A Unix-socket network module is required")
    requireCondition(Number.isSafeInteger(minDelayMs) && minDelayMs > 0 && minDelayMs <= 60_000,
      "invalid_transport", "minDelayMs is invalid")
    requireCondition(Number.isSafeInteger(maxDelayMs) && maxDelayMs >= minDelayMs && maxDelayMs <= 300_000,
      "invalid_transport", "maxDelayMs is invalid")
    requireCondition(Number.isSafeInteger(maxPending) && maxPending > 0 && maxPending <= 1_024,
      "invalid_transport", "maxPending is invalid")
    this.socketPath = socketPath
    this.makeHello = makeHello
    this.onMessage = onMessage
    this.onState = onState
    this.net = netModule
    this.minDelayMs = minDelayMs
    this.maxDelayMs = maxDelayMs
    this.maxPending = maxPending
    this.socket = undefined
    this.timer = undefined
    this.closed = false
    this.connecting = false
    this.acknowledged = false
    this.terminalRejection = false
    this.attempt = 0
    this.pending = []
    this.connectionId = null
  }

  start() {
    requireCondition(!this.closed, "transport_closed", "Bridge client is closed")
    this.#connect()
  }

  send(message) {
    requireCondition(!this.closed, "transport_closed", "Bridge client is closed")
    const encoded = encodeMessage(message)
    if (this.pending.length >= this.maxPending) {
      this.onState("backpressure", { pending: this.pending.length })
      return false
    }
    this.pending.push(encoded)
    this.#flush()
    return true
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.terminalRejection = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    this.connecting = false
    this.acknowledged = false
    this.pending = []
    if (socket && !socket.destroyed) {
      if (typeof socket.end === "function") socket.end()
      else if (typeof socket.destroy === "function") socket.destroy()
    }
    this.onState("closed")
  }

  #connect() {
    if (this.closed || this.connecting || this.terminalRejection) return
    this.connecting = true
    this.acknowledged = false
    this.connectionId = null
    const decoder = new NdjsonDecoder()
    let socket
    try {
      socket = this.net.createConnection({ path: this.socketPath })
    } catch (error) {
      this.#failed(undefined, error)
      return
    }
    this.socket = socket
    let sawError = false
    const fail = (error = null) => {
      if (error) sawError = true
      if (this.socket !== socket) return
      this.socket = undefined
      this.connecting = false
      this.acknowledged = false
      this.connectionId = null
      if (!this.closed && !this.terminalRejection) {
        this.onState("disconnected", error)
        this.#scheduleReconnect()
      }
    }
    socket.once("connect", () => {
      if (this.closed || this.socket !== socket) return
      this.attempt = 0
      this.onState("connecting")
      try {
        socket.write(encodeMessage(this.makeHello()))
      } catch (error) {
        this.onState("protocol_error", error)
        if (typeof socket.destroy === "function") socket.destroy()
      }
    })
    socket.on("data", chunk => {
      let messages
      try {
        messages = decoder.push(chunk)
      } catch (error) {
        this.onState("protocol_error", error)
        if (typeof socket.destroy === "function") socket.destroy()
        return
      }
      for (const message of messages) {
        if (!this.acknowledged) {
          if (message.type !== "hello_ack") {
            const error = new ProtocolError("handshake_required", "hello_ack must be the first runner message")
            this.onState("protocol_error", error)
            if (typeof socket.destroy === "function") socket.destroy()
            return
          }
          if (!message.accepted) {
            this.terminalRejection = true
            this.onState("rejected", message)
            if (typeof socket.destroy === "function") socket.destroy()
            return
          }
          this.acknowledged = true
          this.connecting = false
          this.connectionId = message.connectionId
          this.onState("connected", message)
          this.onMessage(message)
          this.#flush()
          continue
        }
        if (message.type === "hello_ack") {
          const error = new ProtocolError("unexpected_message", "duplicate hello_ack")
          this.onState("protocol_error", error)
          if (typeof socket.destroy === "function") socket.destroy()
          return
        }
        this.onMessage(message)
      }
    })
    socket.once("error", error => {
      if (!sawError && !this.acknowledged) this.onState("connect_error", error)
      fail(error)
    })
    socket.once("close", () => fail())
  }

  #failed(socket, error) {
    if (socket && this.socket !== socket) return
    this.socket = undefined
    this.connecting = false
    this.acknowledged = false
    if (!this.closed && !this.terminalRejection) {
      this.onState("disconnected", error)
      this.#scheduleReconnect()
    }
  }

  #flush() {
    if (!this.socket || this.socket.destroyed || !this.socket.writable || !this.acknowledged) return
    while (this.pending.length > 0 && this.socket && !this.socket.destroyed && this.socket.writable) {
      const encoded = this.pending.shift()
      this.socket.write(encoded)
    }
  }

  #scheduleReconnect() {
    if (this.timer !== undefined || this.closed || this.terminalRejection) return
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * (2 ** this.attempt))
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.#connect()
    }, delay)
  }
}