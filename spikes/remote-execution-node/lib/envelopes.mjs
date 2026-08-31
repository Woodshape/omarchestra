import { isSpikeError, requireCondition, spikeError } from "./errors.mjs"
import { plainObject } from "./validation.mjs"

export const BOOMUX_SCHEMA = "boomux.cli/v1"

function parseSingleJson(text, source) {
  requireCondition(typeof text === "string" && text.trim().length > 0,
    "malformed_json", `${source} did not contain a JSON document`)
  let value
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw spikeError("malformed_json", `${source} contained invalid JSON`, { cause: cause.message })
  }
  return value
}

function validateBase(value, expectedCommand) {
  plainObject(value, "Boomux envelope")
  requireCondition(value.schema === BOOMUX_SCHEMA, "schema_mismatch",
    `Expected ${BOOMUX_SCHEMA}`)
  requireCondition(value.command === expectedCommand, "command_mismatch",
    `Expected Boomux command ${expectedCommand}`)
  const hasData = Object.hasOwn(value, "data")
  const hasError = Object.hasOwn(value, "error")
  requireCondition(hasData !== hasError, "invalid_envelope",
    "Boomux envelope must contain exactly one of data or error")
  const allowed = hasData ? ["schema", "command", "data"] : ["schema", "command", "error"]
  requireCondition(Object.keys(value).every(key => allowed.includes(key)), "invalid_envelope",
    "Boomux envelope contains an unknown top-level field")
  return { hasData, hasError }
}

export function parseSuccessEnvelope(text, expectedCommand) {
  const value = parseSingleJson(text, "Boomux stdout")
  const { hasData } = validateBase(value, expectedCommand)
  requireCondition(hasData, "unexpected_error_envelope",
    `Boomux ${expectedCommand} returned an error envelope on stdout`)
  plainObject(value.data, `Boomux ${expectedCommand} data`)
  return value.data
}

export function parseErrorEnvelope(text, expectedCommand) {
  const value = parseSingleJson(text, "Boomux stderr")
  const { hasError } = validateBase(value, expectedCommand)
  requireCondition(hasError, "unexpected_success_envelope",
    `Boomux ${expectedCommand} returned a success envelope on stderr`)
  plainObject(value.error, `Boomux ${expectedCommand} error`)
  requireCondition(Object.keys(value.error).every(key => ["code", "message"].includes(key))
    && typeof value.error.code === "string" && value.error.code.length > 0
    && typeof value.error.message === "string",
  "invalid_envelope", `Boomux ${expectedCommand} error is invalid`)
  return value.error
}

export function resultFromExecution(result, expectedCommand) {
  plainObject(result, "execution result")
  if (result.exitCode === 0) return parseSuccessEnvelope(result.stdout, expectedCommand)
  const candidate = String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()
  try {
    const remote = parseErrorEnvelope(candidate, expectedCommand)
    throw spikeError(remote.code, `Boomux ${expectedCommand} failed`, {
      kind: "boomux_error",
      boomuxCode: remote.code,
      humanMessage: remote.message,
      exitCode: result.exitCode
    })
  } catch (error) {
    if (isSpikeError(error) && error.details?.kind === "boomux_error") throw error
    throw spikeError("invalid_error_envelope",
      `Boomux ${expectedCommand} failed without a valid JSON error envelope`, {
        exitCode: result.exitCode,
        cause: error.code ?? "unknown"
      })
  }
}
