import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { adapterError, requireCondition } from "./errors.mjs"

export const RECEIPT_SCHEMA = "omarchestra.boomux-runtime-adapter.receipt/v1"

function clone(value) {
  return structuredClone(value)
}

function validateReceipt(value) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value),
    "invalid_receipt", "Receipt must be an object")
  requireCondition(value.schema === RECEIPT_SCHEMA, "invalid_receipt", "Receipt schema is invalid")
  requireCondition(typeof value.prefix === "string" && value.prefix.length > 0,
    "invalid_receipt", "Receipt prefix is invalid")
  requireCondition(value.sessions && typeof value.sessions === "object" && !Array.isArray(value.sessions),
    "invalid_receipt", "Receipt sessions are invalid")
  requireCondition(Array.isArray(value.operations), "invalid_receipt", "Receipt operations are invalid")
  if (value.preflight !== null && value.preflight !== undefined) {
    requireCondition(value.preflight && typeof value.preflight === "object"
      && !Array.isArray(value.preflight), "invalid_receipt", "Receipt preflight is invalid")
    requireCondition(typeof value.preflight.path === "string" && value.preflight.path.length > 0,
      "invalid_receipt", "Receipt preflight path is invalid")
    requireCondition(Number.isSafeInteger(value.preflight.capturedAtMs)
      && value.preflight.capturedAtMs > 0, "invalid_receipt", "Receipt preflight time is invalid")
    requireCondition(typeof value.preflight.localNodeId === "string"
      && value.preflight.localNodeId.length > 0,
    "invalid_receipt", "Receipt preflight Node is invalid")
  }
  return value
}

export function newReceipt({ prefix, teamGoalKey }) {
  return {
    schema: RECEIPT_SCHEMA,
    prefix,
    teamGoalKey,
    preflight: null,
    globalWorkspace: null,
    placement: null,
    sessions: {},
    operations: [],
    cleanup: null
  }
}

export class MemoryReceiptStore {
  constructor(initial = null) {
    this.value = initial === null ? null : validateReceipt(clone(initial))
  }

  async load() {
    return this.value === null ? null : clone(this.value)
  }

  async initialize(receipt) {
    if (this.value !== null) throw adapterError("receipt_exists", "Receipt already exists")
    this.value = validateReceipt(clone(receipt))
    return clone(this.value)
  }

  async update(mutator) {
    if (this.value === null) throw adapterError("receipt_missing", "Receipt does not exist")
    const next = clone(this.value)
    const result = await mutator(next)
    this.value = validateReceipt(next)
    return { receipt: clone(this.value), result }
  }
}

export class FileReceiptStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath)
  }

  async load() {
    try {
      const source = await readFile(this.filePath, "utf8")
      return validateReceipt(JSON.parse(source))
    } catch (cause) {
      if (cause && cause.code === "ENOENT") return null
      if (cause instanceof SyntaxError) {
        throw adapterError("invalid_receipt", `Receipt JSON is invalid: ${this.filePath}`, { cause })
      }
      throw cause
    }
  }

  async initialize(receipt) {
    const current = await this.load()
    if (current !== null) throw adapterError("receipt_exists", "Receipt already exists")
    await this.#write(validateReceipt(clone(receipt)), true)
    return clone(receipt)
  }

  async update(mutator) {
    const current = await this.load()
    if (current === null) throw adapterError("receipt_missing", "Receipt does not exist")
    const next = clone(current)
    const result = await mutator(next)
    validateReceipt(next)
    await this.#write(next, false)
    return { receipt: clone(next), result }
  }

  async #write(receipt, exclusive) {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (exclusive) {
      let handle
      try {
        handle = await open(this.filePath, "wx", 0o600)
        await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle?.close()
      }
      return
    }
    try {
      const existing = await stat(this.filePath)
      if (!existing.isFile()) throw adapterError("unsafe_receipt", "Receipt path is not a regular file")
    } catch (cause) {
      if (cause && cause.code === "ENOENT") throw adapterError("receipt_missing", "Receipt disappeared")
      throw cause
    }
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(temporary, this.filePath)
  }
}

export async function recordOperation(store, kind, details = {}) {
  return store.update(receipt => {
    receipt.operations.push({
      kind,
      atMs: Date.now(),
      details: clone(details)
    })
  })
}
