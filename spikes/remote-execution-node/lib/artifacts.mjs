import { createHash } from "node:crypto"

import { requireCondition } from "./errors.mjs"
import { ARTIFACT_SCHEMA } from "./durable-store.mjs"
import { LIMITS, ROLES } from "./protocol.mjs"
import { validateArgv, validateOpaqueId, validateRole, plainObject } from "./validation.mjs"

const ROLE_SET = new Set(ROLES)

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "utf8")
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}

function outputMetadata(value, label) {
  requireCondition(typeof value === "string" || Buffer.isBuffer(value), "invalid_artifact", `${label} must be text or bytes`)
  const metadata = digest(value)
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value
  metadata.characters = text.length
  metadata.lines = text.length === 0 ? 0 : text.split("\n").length
  return metadata
}

function suppliedOutputMetadata(value, label) {
  plainObject(value, `${label} metadata`)
  requireCondition(Object.keys(value).sort().join(",") === "bytes,characters,lines,sha256",
    "invalid_artifact", `${label} metadata fields are invalid`)
  requireCondition(typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256),
    "invalid_artifact", `${label} metadata digest is invalid`)
  for (const key of ["bytes", "characters", "lines"]) {
    requireCondition(Number.isSafeInteger(value[key]) && value[key] >= 0,
      "invalid_artifact", `${label} metadata ${key} is invalid`)
  }
  return { sha256: value.sha256, bytes: value.bytes, characters: value.characters, lines: value.lines }
}

export function makeValidationArtifact({
  artifactId,
  command,
  exitCode,
  signal = null,
  stdout = "",
  stderr = "",
  stdoutMetadata = null,
  stderrMetadata = null,
  result = null,
  capturedAtMs = Date.now(),
  role = null
}) {
  validateOpaqueId(artifactId, "validation artifact ID")
  validateArgv(command, "validation command")
  requireCondition(Number.isSafeInteger(exitCode) && exitCode >= 0,
    "invalid_artifact", "validation exitCode must be a non-negative integer")
  requireCondition(signal === null || typeof signal === "string" && signal.length > 0 && signal.length <= 32,
    "invalid_artifact", "validation signal is invalid")
  requireCondition(role === null || ROLE_SET.has(role), "invalid_artifact", "validation role is invalid")
  requireCondition(Number.isSafeInteger(capturedAtMs) && capturedAtMs >= 0,
    "invalid_artifact", "validation timestamp is invalid")
  if (result !== null) {
    plainObject(result, "validation structured result")
    requireCondition(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.telemetryBytes,
      "invalid_artifact", "validation structured result is too large")
  }
  requireCondition(stdoutMetadata === null || stdout === "", "invalid_artifact",
    "validation stdout body and metadata are mutually exclusive")
  requireCondition(stderrMetadata === null || stderr === "", "invalid_artifact",
    "validation stderr body and metadata are mutually exclusive")
  const normalizedStdout = stdoutMetadata === null
    ? outputMetadata(stdout, "validation stdout")
    : suppliedOutputMetadata(stdoutMetadata, "validation stdout")
  const normalizedStderr = stderrMetadata === null
    ? outputMetadata(stderr, "validation stderr")
    : suppliedOutputMetadata(stderrMetadata, "validation stderr")
  return {
    artifactId,
    role,
    kind: "validation",
    schema: ARTIFACT_SCHEMA,
    createdAtMs: capturedAtMs,
    result: {
      command: [...command],
      exitCode,
      signal,
      passed: exitCode === 0 && signal === null,
      stdout: normalizedStdout,
      stderr: normalizedStderr,
      structured: result
    }
  }
}

export function validateValidationArtifact(artifact) {
  plainObject(artifact, "validation artifact")
  requireCondition(artifact.kind === "validation" && artifact.schema === ARTIFACT_SCHEMA,
    "invalid_artifact", "artifact is not a validation artifact")
  validateOpaqueId(artifact.artifactId, "validation artifact ID")
  requireCondition(artifact.role === null || ROLE_SET.has(artifact.role), "invalid_artifact", "validation role is invalid")
  requireCondition(Number.isSafeInteger(artifact.createdAtMs) && artifact.createdAtMs >= 0,
    "invalid_artifact", "validation timestamp is invalid")
  plainObject(artifact.result, "validation result")
  const expected = ["command", "exitCode", "signal", "passed", "stdout", "stderr", "structured"]
  requireCondition(Object.keys(artifact.result).sort().join(",") === expected.sort().join(","),
    "invalid_artifact", "validation result fields are invalid")
  validateArgv(artifact.result.command, "validation command")
  requireCondition(Number.isSafeInteger(artifact.result.exitCode) && artifact.result.exitCode >= 0,
    "invalid_artifact", "validation exitCode is invalid")
  requireCondition(artifact.result.signal === null || typeof artifact.result.signal === "string",
    "invalid_artifact", "validation signal is invalid")
  requireCondition(typeof artifact.result.passed === "boolean"
    && artifact.result.passed === (artifact.result.exitCode === 0 && artifact.result.signal === null),
  "invalid_artifact", "validation passed flag is invalid")
  for (const stream of ["stdout", "stderr"]) {
    plainObject(artifact.result[stream], `validation ${stream} metadata`)
    const keys = Object.keys(artifact.result[stream]).sort().join(",")
    requireCondition(keys === "bytes,characters,lines,sha256", "invalid_artifact", `validation ${stream} metadata is invalid`)
    requireCondition(Number.isSafeInteger(artifact.result[stream].bytes) && artifact.result[stream].bytes >= 0,
      "invalid_artifact", `validation ${stream} byte count is invalid`)
    requireCondition(Number.isSafeInteger(artifact.result[stream].characters) && artifact.result[stream].characters >= 0,
      "invalid_artifact", `validation ${stream} character count is invalid`)
    requireCondition(Number.isSafeInteger(artifact.result[stream].lines) && artifact.result[stream].lines >= 0,
      "invalid_artifact", `validation ${stream} line count is invalid`)
    requireCondition(/^[0-9a-f]{64}$/.test(artifact.result[stream].sha256),
      "invalid_artifact", `validation ${stream} digest is invalid`)
  }
  if (artifact.result.structured !== null) plainObject(artifact.result.structured, "validation structured result")
  return artifact
}