import { spawn } from "node:child_process"

import { adapterError } from "./errors.mjs"

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_OUTPUT_LIMIT = 1_048_576

function appendBounded(current, chunk, limit) {
  const next = Buffer.concat([current, chunk])
  if (next.length > limit) throw adapterError("output_limit", "Boomux output exceeded the adapter limit")
  return next
}

export class DirectArgvExecutor {
  constructor({ binary = "boomux", timeoutMs = DEFAULT_TIMEOUT_MS, outputLimit = DEFAULT_OUTPUT_LIMIT,
    environment = process.env } = {}) {
    this.binary = binary
    this.timeoutMs = timeoutMs
    this.outputLimit = outputLimit
    this.environment = environment
  }

  run(argv, { timeoutMs = this.timeoutMs } = {}) {
    if (!Array.isArray(argv) || argv.some(value => typeof value !== "string" || value.includes("\u0000"))) {
      return Promise.reject(adapterError("invalid_argv", "Boomux argv must be a NUL-free string array"))
    }
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(this.binary, argv, {
          shell: false,
          env: this.environment,
          stdio: ["ignore", "pipe", "pipe"]
        })
      } catch (cause) {
        reject(adapterError("binary_unavailable", `Could not start ${this.binary}`, { cause }))
        return
      }

      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      let settled = false
      let timedOut = false
      const finish = callback => value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const fail = finish(reject)
      const succeed = finish(resolve)
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, timeoutMs)

      child.once("error", cause => {
        const code = cause && cause.code === "ENOENT" ? "binary_unavailable" : "process_error"
        fail(adapterError(code, `Could not execute ${this.binary}`, { cause }))
      })
      child.stdout.on("data", chunk => {
        try {
          stdout = appendBounded(stdout, chunk, this.outputLimit)
        } catch (error) {
          child.kill("SIGTERM")
          fail(error)
        }
      })
      child.stderr.on("data", chunk => {
        try {
          stderr = appendBounded(stderr, chunk, this.outputLimit)
        } catch (error) {
          child.kill("SIGTERM")
          fail(error)
        }
      })
      child.once("close", (exitCode, signal) => {
        if (timedOut) {
          fail(adapterError("command_timeout", `Boomux command timed out after ${timeoutMs}ms`, {
            argv: [...argv], timeoutMs
          }))
          return
        }
        succeed({
          argv: [...argv],
          exitCode: exitCode ?? 1,
          signal: signal ?? null,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        })
      })
    })
  }
}
