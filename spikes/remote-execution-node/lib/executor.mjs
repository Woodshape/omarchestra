import { spawn } from "node:child_process"

import { requireCondition, spikeError } from "./errors.mjs"
import { validateArgv, validateExecutablePath } from "./validation.mjs"

const DEFAULT_MAX_BYTES = 1_048_576
const DEFAULT_TIMEOUT_MS = 10_000

export class DirectArgvExecutor {
  constructor(binary, { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.binary = validateExecutablePath(binary, "executor binary")
    requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 16_777_216,
      "invalid_executor", "Executor output bound is invalid")
    requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
      "invalid_executor", "Executor timeout must be between 1 and 60000 milliseconds")
    this.maxBytes = maxBytes
    this.timeoutMs = timeoutMs
  }

  run(argv, { input = null, cwd = undefined, env = undefined, timeoutMs = this.timeoutMs } = {}) {
    const exactArgv = validateArgv(argv, "execution argv", { allowEmpty: true })
    if (cwd !== undefined) requireCondition(typeof cwd === "string", "invalid_executor", "cwd must be a string")
    requireCondition(input === null || typeof input === "string" || Buffer.isBuffer(input),
      "invalid_executor", "Executor input must be null, a string, or a Buffer")
    requireCondition(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000,
      "invalid_executor", "Execution timeout must be between 1 and 60000 milliseconds")

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, exactArgv, {
        cwd,
        env,
        shell: false,
        stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"]
      })
      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let exceeded = false
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeoutMs)

      const collect = (target, chunk, stream) => {
        const bytes = Buffer.from(chunk)
        if (stream === "stdout") stdoutBytes += bytes.length
        else stderrBytes += bytes.length
        if (stdoutBytes > this.maxBytes || stderrBytes > this.maxBytes) {
          exceeded = true
          child.kill("SIGKILL")
          return
        }
        target.push(bytes)
      }
      child.stdout.on("data", chunk => collect(stdout, chunk, "stdout"))
      child.stderr.on("data", chunk => collect(stderr, chunk, "stderr"))
      child.on("error", error => {
        clearTimeout(timer)
        reject(spikeError("execution_failed", `Failed to execute ${this.binary}`, { cause: error.message }))
      })
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer)
        if (timedOut) return reject(spikeError("execution_timeout", `Execution exceeded ${timeoutMs}ms`))
        if (exceeded) return reject(spikeError("execution_output_too_large",
          `Execution exceeded ${this.maxBytes} bytes on one output stream`))
        resolve({
          argv: exactArgv,
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        })
      })
      if (input !== null) child.stdin.end(input)
    })
  }
}
