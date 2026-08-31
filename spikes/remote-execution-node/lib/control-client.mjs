import { encodeMessage, makeControlHello, makeControlRequest, NdjsonDecoder } from "./protocol.mjs"
import { requireCondition, spikeError } from "./errors.mjs"
import { validateOpaqueId, validateUuid } from "./validation.mjs"

export class ReconnectingControlClient {
  constructor({
    receiptId,
    teamGoalId,
    controlClientId,
    transportFactory,
    onState = () => {},
    onSnapshot = () => {},
    now = () => Date.now(),
    minDelayMs = 100,
    maxDelayMs = 2_000
  }) {
    validateUuid(receiptId, "receipt ID")
    validateUuid(teamGoalId, "Team Goal ID")
    validateOpaqueId(controlClientId, "control client ID")
    requireCondition(typeof transportFactory === "function", "invalid_transport", "transportFactory is required")
    requireCondition(typeof onState === "function" && typeof onSnapshot === "function",
      "invalid_transport", "Control callbacks must be functions")
    requireCondition(Number.isSafeInteger(minDelayMs) && minDelayMs > 0 && minDelayMs <= 60_000,
      "invalid_transport", "minDelayMs is invalid")
    requireCondition(Number.isSafeInteger(maxDelayMs) && maxDelayMs >= minDelayMs && maxDelayMs <= 300_000,
      "invalid_transport", "maxDelayMs is invalid")
    this.receiptId = receiptId
    this.teamGoalId = teamGoalId
    this.controlClientId = controlClientId
    this.transportFactory = transportFactory
    this.onState = onState
    this.onSnapshot = onSnapshot
    this.now = now
    this.minDelayMs = minDelayMs
    this.maxDelayMs = maxDelayMs
    this.transport = null
    this.decoder = null
    this.timer = undefined
    this.connecting = false
    this.connected = false
    this.closed = false
    this.reconnecting = false
    this.attempt = 0
    this.requestNumber = 0
    this.pending = new Map()
    this.queued = []
    this.lastCursor = null
  }

  start() {
    requireCondition(!this.closed, "transport_closed", "Control client is closed")
    this.#connect()
  }

  request(operation, payload = {}) {
    requireCondition(!this.closed, "transport_closed", "Control client is closed")
    const requestId = `control-request-${++this.requestNumber}`
    const request = makeControlRequest({
      requestId,
      operation,
      payload,
      timestamp: this.now()
    })
    return new Promise((resolve, reject) => {
      const item = { request, resolve, reject, sent: false, internal: false }
      this.pending.set(requestId, item)
      if (this.connected) this.#sendRequest(item)
      else this.queued.push(item)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const item of this.pending.values()) item.reject(spikeError("control_closed", "Control client is closed"))
    this.pending.clear()
    this.queued = []
    const transport = this.transport
    this.transport = null
    this.connected = false
    this.connecting = false
    if (transport?.writable?.end) transport.writable.end()
    else if (transport?.destroy) transport.destroy()
    this.onState("closed")
  }

  #connect() {
    if (this.closed || this.connecting) return
    this.connecting = true
    this.decoder = new NdjsonDecoder()
    let transport
    try { transport = this.transportFactory() }
    catch (error) {
      this.connecting = false
      this.#failed(error)
      return
    }
    Promise.resolve(transport).then(value => {
      if (this.closed) {
        value?.destroy?.()
        return
      }
      requireCondition(value && value.readable && value.writable,
        "invalid_transport", "transportFactory must return readable and writable streams")
      this.transport = value
      this.#attach(value)
      this.#write(makeControlHello({
        receiptId: this.receiptId,
        teamGoalId: this.teamGoalId,
        controlClientId: this.controlClientId,
        timestamp: this.now()
      }))
    }).catch(error => {
      this.connecting = false
      this.#failed(error)
    })
  }

  #attach(transport) {
    transport.readable.on("data", chunk => {
      try {
        for (const message of this.decoder.push(chunk)) this.#receive(message)
      } catch (error) {
        this.onState("protocol_error", error)
        transport.destroy?.()
      }
    })
    transport.readable.once("end", () => this.#disconnected())
    transport.readable.once("close", () => this.#disconnected())
    transport.readable.once("error", error => this.#disconnected(error))
    if (typeof transport.on === "function") transport.on("error", error => this.#disconnected(error))
  }

  #receive(message) {
    if (message.type === "control_ack") {
      if (!message.accepted) {
        this.onState("rejected", message)
        for (const item of this.pending.values()) item.reject(spikeError("control_rejected", message.reason))
        this.pending.clear()
        this.queued = []
        this.transport?.destroy?.()
        this.closed = true
        return
      }
      this.connecting = false
      this.connected = true
      this.attempt = 0
      const wasReconnect = this.reconnecting
      this.reconnecting = false
      this.onState(wasReconnect ? "reconnected" : "connected", message)
      this.#flush()
      if (wasReconnect) this.#queueRefresh()
      return
    }
    if (message.type === "control_response") {
      const item = this.pending.get(message.requestId)
      if (!item) return
      this.pending.delete(message.requestId)
      if (message.status === "error") {
        item.reject(spikeError(message.error.code, message.error.message, message.error.details ?? {}))
        return
      }
      if (item.request.operation === "snapshot") {
        this.lastCursor = message.data.cursor
        this.onSnapshot(message.data, { source: item.internal ? "reconnect" : "request" })
      } else if (item.request.operation === "events") {
        this.lastCursor = message.data.cursor
      }
      item.resolve(message.data)
      return
    }
    if (message.type === "protocol_error") this.onState("protocol_error", message)
  }

  #queueRefresh() {
    const snapshotId = `control-refresh-snapshot-${++this.requestNumber}`
    const snapshotRequest = makeControlRequest({
      requestId: snapshotId,
      operation: "snapshot",
      payload: {},
      timestamp: this.now()
    })
    const snapshotItem = { request: snapshotRequest, resolve: () => {}, reject: () => {}, sent: false, internal: true }
    this.pending.set(snapshotId, snapshotItem)
    this.queued.push(snapshotItem)
  }

  #sendRequest(item) {
    if (item.sent || !this.connected) return
    item.sent = true
    this.#write(item.request)
  }

  #flush() {
    while (this.connected && this.queued.length > 0) this.#sendRequest(this.queued.shift())
  }

  #write(message) {
    if (!this.transport?.writable || typeof this.transport.writable.write !== "function") return false
    this.transport.writable.write(encodeMessage(message))
    return true
  }

  #disconnected(error = null) {
    if (this.closed || (!this.connected && !this.connecting)) return
    this.transport = null
    this.connected = false
    this.connecting = false
    for (const [id, item] of this.pending) {
      if (item.sent && !item.internal) {
        this.pending.delete(id)
        item.reject(spikeError("control_disconnected", "Control transport disconnected before the response"))
      } else if (item.sent) {
        item.sent = false
        this.queued.push(item)
      }
    }
    this.onState("disconnected", error)
    this.reconnecting = true
    this.#schedule()
  }

  #failed(error) {
    if (this.closed) return
    this.onState("disconnected", error)
    this.reconnecting = true
    this.#schedule()
  }

  #schedule() {
    if (this.timer !== undefined || this.closed) return
    const delay = Math.min(this.maxDelayMs, this.minDelayMs * (2 ** this.attempt))
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.#connect()
    }, delay)
  }
}