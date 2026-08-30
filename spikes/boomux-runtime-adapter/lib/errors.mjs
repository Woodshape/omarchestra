export class AdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "AdapterError"
    this.code = code
    this.details = details
  }
}

export function adapterError(code, message, details) {
  return new AdapterError(code, message, details)
}

export function isAdapterError(error, code) {
  return error instanceof AdapterError && (code === undefined || error.code === code)
}

export function requireCondition(condition, code, message, details) {
  if (!condition) throw adapterError(code, message, details)
}
