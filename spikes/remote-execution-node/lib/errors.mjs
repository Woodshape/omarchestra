export class SpikeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "SpikeError"
    this.code = code
    this.details = details
  }
}

export function spikeError(code, message, details = {}) {
  return new SpikeError(code, message, details)
}

export function requireCondition(condition, code, message, details = {}) {
  if (!condition) throw spikeError(code, message, details)
}

export function isSpikeError(error, code = null) {
  return error instanceof SpikeError && (code === null || error.code === code)
}

export function errorReport(error) {
  if (error instanceof SpikeError) {
    return { error: error.code, message: error.message, details: error.details }
  }
  return { error: "internal", message: String(error?.message ?? error) }
}
