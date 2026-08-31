import path from "node:path"

import { requireCondition, spikeError } from "./errors.mjs"

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const NODE_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const UNIT_PATTERN = /^omarchestra-remote-spike-[0-9a-f]{8}-[0-9a-f-]{27}\.service$/
export const ROLES = Object.freeze(["coordinator", "builder", "reviewer"])

const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._+\/-]+$/
const SAFE_REMOTE_ACTION_PATTERN = /^[a-z][a-z0-9-]{0,47}$/
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/
const SSH_HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])$/

export function plainObject(value, label = "value") {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_type", `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  requireCondition(prototype === Object.prototype || prototype === null,
    "invalid_type", `${label} must be a plain object`)
  return value
}

export function nonemptyString(value, label, maximum = 4096) {
  requireCondition(typeof value === "string" && value.length > 0 && value.length <= maximum,
    "invalid_string", `${label} must contain 1-${maximum} characters`)
  requireCondition(!/[\0\r\n]/.test(value), "invalid_string", `${label} contains a forbidden character`)
  return value
}

export function validateUuid(value, label = "ID") {
  requireCondition(typeof value === "string" && UUID_PATTERN.test(value),
    "invalid_id", `${label} must be a canonical UUID`)
  return value
}

export function validateOpaqueId(value, label = "ID") {
  requireCondition(typeof value === "string" && OPAQUE_ID_PATTERN.test(value),
    "invalid_id", `${label} is invalid`)
  return value
}

export function validateNodeAlias(value) {
  requireCondition(typeof value === "string" && NODE_ALIAS_PATTERN.test(value) && !UUID_PATTERN.test(value),
    "invalid_node_alias", "Node alias must be an exact non-UUID alias")
  return value
}

export function validateRole(value) {
  requireCondition(ROLES.includes(value), "invalid_role",
    "Role must be coordinator, builder, or reviewer")
  return value
}

export function validateSshTarget(value) {
  nonemptyString(value, "SSH target", 320)
  requireCondition(!value.startsWith("-") && !/\s/.test(value),
    "invalid_ssh_target", "SSH target cannot begin with '-' or contain whitespace")
  const separator = value.indexOf("@")
  requireCondition(separator > 0 && separator === value.lastIndexOf("@"),
    "invalid_ssh_target", "SSH target must be one explicit user@host route")
  const user = value.slice(0, separator)
  const host = value.slice(separator + 1)
  requireCondition(SSH_USER_PATTERN.test(user) && SSH_HOST_PATTERN.test(host),
    "invalid_ssh_target", "SSH target contains an unsupported user or host")
  return value
}

export function validateAbsolutePath(value, label = "path", { executable = false } = {}) {
  nonemptyString(value, label, 4096)
  requireCondition(SAFE_PATH_PATTERN.test(value) && path.posix.isAbsolute(value),
    "invalid_path", `${label} must be a safe absolute POSIX path`)
  requireCondition(path.posix.normalize(value) === value && !value.split("/").includes(".."),
    "invalid_path", `${label} must be normalized and cannot contain '..'`)
  requireCondition(value === "/" || !value.endsWith("/"), "invalid_path", `${label} cannot end with '/'`)
  if (executable) requireCondition(value !== "/", "invalid_path", `${label} must name an executable`)
  return value
}

export function validateExecutablePath(value, label = "executable path") {
  return validateAbsolutePath(value, label, { executable: true })
}

export function validateUnixSocketPath(value, label = "Unix socket path") {
  validateAbsolutePath(value, label, { executable: true })
  requireCondition(value.length <= 107 && /\.sock$/.test(path.posix.basename(value)),
    "invalid_socket_path", `${label} must be a short absolute .sock path`)
  return value
}

export const validateOwnerSocketPath = validateUnixSocketPath

export function validateUnitName(value) {
  requireCondition(typeof value === "string" && UNIT_PATTERN.test(value),
    "invalid_unit", "Runner unit name is not a recognized exact spike service")
  return value
}

export function validateRemoteAction(value) {
  requireCondition(typeof value === "string" && SAFE_REMOTE_ACTION_PATTERN.test(value),
    "invalid_action", "Remote helper action is invalid")
  return value
}

export function validateArgv(value, label = "argv", { allowEmpty = false } = {}) {
  requireCondition(Array.isArray(value) && (allowEmpty || value.length > 0),
    "invalid_argv", `${label} must be ${allowEmpty ? "an" : "a nonempty"} array`)
  requireCondition(value.every(item => typeof item === "string" && !/[\0\r\n]/.test(item)),
    "invalid_argv", `${label} must contain only strings without NUL or newlines`)
  return [...value]
}

export function validateRemoteCommandArgv(value, label = "remote command argv") {
  const argv = validateArgv(value, label, { allowEmpty: true })
  requireCondition(argv.every(item => /^[A-Za-z0-9._+:=\/,\-]+$/.test(item)),
    "invalid_argv", `${label} contains a token unsafe for the OpenSSH remote command boundary`)
  return argv
}

export function validateQualifiedIdentity(value, label = "qualified identity") {
  plainObject(value, label)
  const keys = Object.keys(value).sort()
  requireCondition(keys.length === 2 && keys[0] === "innerId" && keys[1] === "nodeId",
    "invalid_identity", `${label} must contain exactly nodeId and innerId`)
  return {
    nodeId: validateUuid(value.nodeId, `${label} Node ID`),
    innerId: validateOpaqueId(value.innerId, `${label} inner ID`)
  }
}

export function validateRuntimeIdentity({ uid, sudoExitCode, runtimeDirectory, runtimeOwnerUid, runtimeMode }) {
  requireCondition(Number.isSafeInteger(uid) && uid > 0, "unsafe_execution_identity",
    "Remote execution identity must be an unprivileged non-root UID")
  requireCondition(Number.isSafeInteger(sudoExitCode) && sudoExitCode !== 0,
    "sudo_capable", "Remote execution identity has noninteractive sudo capability")
  validateAbsolutePath(runtimeDirectory, "runtime directory")
  requireCondition(runtimeOwnerUid === uid, "unsafe_runtime_directory",
    "Runtime directory is not owned by the execution UID")
  const normalizedMode = typeof runtimeMode === "string" ? runtimeMode : runtimeMode?.toString(8)
  requireCondition(normalizedMode === "700" || normalizedMode === "0700",
    "unsafe_runtime_directory", "Runtime directory mode must be 0700")
  return { uid, runtimeDirectory, runtimeMode: "0700" }
}

export function parseOptions(values, specification) {
  requireCondition(Array.isArray(values), "invalid_arguments", "Arguments must be an array")
  plainObject(specification, "option specification")
  const result = {}
  for (let index = 0; index < values.length; index++) {
    const item = values[index]
    requireCondition(typeof item === "string" && item.startsWith("--") && item.length > 2,
      "invalid_arguments", `Unexpected argument: ${String(item)}`)
    const key = item.slice(2)
    const rule = specification[key]
    requireCondition(rule, "invalid_arguments", `Unknown option --${key}`)
    requireCondition(!Object.hasOwn(result, key), "invalid_arguments", `Duplicate option --${key}`)
    if (rule.boolean === true) {
      result[key] = true
      continue
    }
    const value = values[++index]
    requireCondition(value !== undefined && !value.startsWith("--"),
      "invalid_arguments", `Option --${key} requires a value`)
    result[key] = rule.validate ? rule.validate(value) : value
  }
  for (const [key, rule] of Object.entries(specification)) {
    if (rule.required && !Object.hasOwn(result, key)) {
      throw spikeError("invalid_arguments", `Missing required option --${key}`)
    }
    if (!Object.hasOwn(result, key) && Object.hasOwn(rule, "default")) result[key] = rule.default
  }
  return result
}
