import { LIMITS, validateTelemetry } from "./protocol.mjs"

export function boundedLabel(value, maximum = LIMITS.metadataStringCharacters) {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/[\0\r\n]/g, " ")
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}

export function redactMessageMetadata(message) {
  if (!message || typeof message !== "object") return { role: "unknown" }
  const customType = boundedLabel(message.customType, 64)
  const toolName = boundedLabel(message.toolName, 128)
  const metadata = {
    role: boundedLabel(message.role, 32) ?? "unknown",
    ...(customType === undefined ? {} : { customType }),
    ...(toolName === undefined ? {} : { toolName })
  }
  if (Array.isArray(message.content)) {
    const blockTypes = []
    let textCharacters = 0
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue
      const type = boundedLabel(block.type, 32) ?? "unknown"
      if (type === "thinking") continue
      blockTypes.push(type)
      if (type === "text" && typeof block.text === "string") textCharacters += block.text.length
    }
    metadata.blockTypes = blockTypes.slice(0, 32)
    metadata.blockCount = message.content.length
    metadata.textCharacters = textCharacters
  } else if (typeof message.content === "string") {
    metadata.blockTypes = ["text"]
    metadata.blockCount = 1
    metadata.textCharacters = message.content.length
  }
  validateTelemetry(metadata)
  return metadata
}

export function redactToolMetadata(event) {
  const toolCallId = boundedLabel(event?.toolCallId, 128) ?? "unknown"
  const toolName = boundedLabel(event?.toolName, 128) ?? "unknown"
  const result = { toolCallId, toolName }
  validateTelemetry(result)
  return result
}

export function redactAttentionMetadata(event) {
  const result = {
    owner: "agent",
    kind: boundedLabel(event?.kind, 64) ?? "unknown",
    reason: boundedLabel(event?.reason, 128) ?? "ui_prompt"
  }
  validateTelemetry(result)
  return result
}

export function boundedTextDeltaSummary(count, characters) {
  const result = {
    updateType: "text_delta_summary",
    deltaCount: Number.isSafeInteger(count) && count >= 0 ? count : 0,
    deltaCharacters: Number.isSafeInteger(characters) && characters >= 0 ? characters : 0
  }
  validateTelemetry(result)
  return result
}