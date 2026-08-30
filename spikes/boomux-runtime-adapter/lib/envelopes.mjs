import { adapterError, requireCondition } from "./errors.mjs"

export const CLI_SCHEMA = "boomux.cli/v1"

function parseJson(text, source) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw adapterError("malformed_json", `Boomux returned invalid JSON on ${source}`, { cause })
  }
}

function validateBase(value, command) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value),
    "invalid_envelope", "Boomux envelope must be an object")
  requireCondition(value.schema === CLI_SCHEMA, "schema_mismatch",
    `Expected ${CLI_SCHEMA}, received ${String(value.schema)}`)
  requireCondition(value.command === command, "command_mismatch",
    `Expected Boomux command ${command}, received ${String(value.command)}`)
  const hasData = Object.prototype.hasOwnProperty.call(value, "data")
  const hasError = Object.prototype.hasOwnProperty.call(value, "error")
  requireCondition(hasData !== hasError, "invalid_envelope",
    "Boomux envelope must contain exactly one of data or error")
  return { hasData, hasError }
}

export function parseSuccessEnvelope(text, command) {
  const value = parseJson(text, "stdout")
  const { hasData } = validateBase(value, command)
  requireCondition(hasData, "unexpected_error_envelope",
    `Boomux ${command} returned an error envelope on stdout`)
  requireCondition(value.data && typeof value.data === "object" && !Array.isArray(value.data),
    "invalid_envelope", `Boomux ${command} data must be an object`)
  return value.data
}

export function parseErrorEnvelope(text, command) {
  const value = parseJson(text, "stderr")
  const { hasError } = validateBase(value, command)
  requireCondition(hasError, "unexpected_success_envelope",
    `Boomux ${command} returned a success envelope on stderr`)
  const error = value.error
  requireCondition(error && typeof error === "object" && !Array.isArray(error),
    "invalid_envelope", `Boomux ${command} error must be an object`)
  requireCondition(typeof error.code === "string" && error.code.length > 0,
    "invalid_envelope", `Boomux ${command} error code is invalid`)
  requireCondition(typeof error.message === "string",
    "invalid_envelope", `Boomux ${command} error message is invalid`)
  return error
}

export function boomuxError(error, command) {
  return adapterError(error.code, `Boomux ${command} failed: ${error.message}`, {
    kind: "boomux_error",
    command,
    boomuxCode: error.code
  })
}
