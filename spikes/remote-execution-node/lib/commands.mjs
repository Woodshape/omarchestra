import { requireCondition } from "./errors.mjs"
import {
  nonemptyString,
  plainObject,
  validateAbsolutePath,
  validateArgv,
  validateExecutablePath,
  validateNodeAlias,
  validateUnixSocketPath,
  validateOpaqueId,
  validateRemoteAction,
  validateRemoteCommandArgv,
  validateRole,
  validateSshTarget,
  validateUnitName,
  validateUuid
} from "./validation.mjs"

const json = argv => [...argv, "--json"]
const safeName = (value, label = "name") => {
  nonemptyString(value, label, 256)
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value),
    "invalid_name", `${label} contains unsupported characters`)
  return value
}

export const boomuxCommands = Object.freeze({
  capabilities: () => json(["capabilities"]),
  daemonStatus: () => json(["daemon", "status"]),
  nodeList: () => json(["node", "list"]),
  nodeInspect: selector => json(["node", "inspect", validateNodeAlias(selector)]),
  nodeSnapshot: selector => selector === undefined
    ? json(["node", "snapshot"])
    : json(["node", "snapshot", UUID_OR_ALIAS(selector)]),
  workspaceList: () => json(["workspace", "list"]),
  workspaceInspect: workspaceId => json(["workspace", "inspect", validateOpaqueId(workspaceId, "Workspace ID")]),
  workspaceInspectByName: name => json(["workspace", "inspect", safeName(name, "Workspace name")]),
  workspaceCreateEmpty: name => ["workspace", "create", safeName(name, "Workspace name")],
  shellCreate: ({ globalWorkspaceId, nodeSelector, name, cwd, argv }) => [
    "shell", "create", validateOpaqueId(globalWorkspaceId, "global Workspace ID"),
    "--node", UUID_OR_ALIAS(nodeSelector), "--name", safeName(name, "Shell name"),
    "--cwd", validateAbsolutePath(cwd, "remote Shell cwd"), "--",
    ...validateArgv(argv, "Shell command")
  ],
  shellInspect: shellId => json(["shell", "inspect", validateOpaqueId(shellId, "Shell ID")]),
  shellClose: ({ shellId, workspaceId }) => [
    "shell", "close", validateOpaqueId(shellId, "Shell ID"),
    "--workspace", validateOpaqueId(workspaceId, "Workspace ID")
  ],
  workspaceClose: workspaceId => ["workspace", "close", validateOpaqueId(workspaceId, "global Workspace ID")],
  integrationList: () => json(["integration", "list"]),
  integrationStatus: () => json(["integration", "status"]),
  configPath: () => ["config", "path"],
  configValidate: () => ["config", "validate"],
  openRemote: ({ shellId, nodeSelector, globalWorkspaceId, title }) => [
    "open", validateOpaqueId(shellId, "Shell ID"), "--node", UUID_OR_ALIAS(nodeSelector),
    "--workspace", validateOpaqueId(globalWorkspaceId, "global Workspace ID"),
    "--title", safeName(title, "terminal title"), "--takeover"
  ],
  events: ({ after = null, limit = 256, waitMs = 0 } = {}) => {
    requireCondition(Number.isSafeInteger(limit) && limit > 0 && limit <= 256,
      "invalid_events", "Event limit must be between 1 and 256")
    requireCondition(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 60_000,
      "invalid_events", "Event wait must be between 0 and 60000 milliseconds")
    const argv = ["events"]
    if (after !== null && after !== undefined) argv.push("--after", validateCursor(after))
    argv.push("--limit", String(limit), "--wait-ms", String(waitMs), "--json")
    return argv
  }
})

function UUID_OR_ALIAS(value) {
  if (typeof value === "string" && /^[0-9a-f]{8}-/.test(value)) return validateUuid(value, "Node selector")
  return validateNodeAlias(value)
}

function validateCursor(value) {
  nonemptyString(value, "event cursor", 256)
  requireCondition(/^[A-Za-z0-9._-]+:[0-9]+$/.test(value), "invalid_cursor", "Event cursor is invalid")
  return value
}

export function executableInvocation(binary, argv) {
  return {
    binary: validateExecutablePath(binary, "executable"),
    argv: validateArgv(argv, "invocation argv", { allowEmpty: true })
  }
}

export function boomuxInvocation(binary, argv) {
  return executableInvocation(binary, argv)
}

export function sshRemoteHelperInvocation({ sshPath, target, remoteNodePath, remoteHelperPath, action, args = [] }) {
  return executableInvocation(sshPath, [
    "-T", "-o", "BatchMode=yes", "--", validateSshTarget(target),
    validateExecutablePath(remoteNodePath, "remote Node executable"),
    validateAbsolutePath(remoteHelperPath, "remote helper path"),
    validateRemoteAction(action),
    ...validateRemoteCommandArgv(args, "remote helper arguments")
  ])
}

export function sshRemoteCommandInvocation({ sshPath, target, remoteExecutable, args = [] }) {
  return executableInvocation(sshPath, [
    "-T", "-o", "BatchMode=yes", "--", validateSshTarget(target),
    validateExecutablePath(remoteExecutable, "remote executable"),
    ...validateRemoteCommandArgv(args, "remote command arguments")
  ])
}

// Runtime-dependent remote invocations run through the receipt-bound execution
// identity: exact `remoteEnv XDG_RUNTIME_DIR=<receipt-bound-dir> <binary> ...`
// over SSH, so verified SSH sessions with XDG_RUNTIME_DIR unset reach the
// systemd user manager and the Boomux daemon without self-typed values.
export function sshRemoteEnvInvocation({ sshPath, target, remoteEnv, runtimeDirectory,
  remoteExecutable, args = [] }) {
  return executableInvocation(sshPath, [
    "-T", "-o", "BatchMode=yes", "--", validateSshTarget(target),
    validateExecutablePath(remoteEnv, "remote env"),
    `XDG_RUNTIME_DIR=${validateAbsolutePath(runtimeDirectory, "runtime directory")}`,
    validateExecutablePath(remoteExecutable, "remote executable"),
    ...validateRemoteCommandArgv(args, "remote command arguments")
  ])
}

export function sudoProbeInvocation(sudoPath) {
  return executableInvocation(sudoPath, ["-n", "--", "true"])
}

export function systemdRunInvocation({ systemdRunPath, unit, nodePath, runnerPath, socketPath,
  statePath, teamGoalId, receiptId, bindings }) {
  validateBindings(bindings)
  return executableInvocation(systemdRunPath, [
    "--user", "--unit", validateUnitName(unit), "--service-type=exec", "--quiet", "--",
    validateExecutablePath(nodePath, "remote Node executable"),
    validateAbsolutePath(runnerPath, "runner path"),
    "--socket", validateUnixSocketPath(socketPath, "runner socket path"),
    "--state", validateAbsolutePath(statePath, "runner state path"),
    "--team-goal-id", validateUuid(teamGoalId, "Team Goal ID"),
    "--receipt-id", validateUuid(receiptId, "receipt ID"),
    "--bindings", encodeBindings(bindings)
  ])
}

export function systemctlShowInvocation({ systemctlPath, unit }) {
  return executableInvocation(systemctlPath, [
    "--user", "show", validateUnitName(unit),
    "--property=Id,LoadState,ActiveState,SubState,MainPID", "--no-pager"
  ])
}

export function systemctlStopInvocation({ systemctlPath, unit }) {
  return executableInvocation(systemctlPath, ["--user", "stop", validateUnitName(unit)])
}

export function remoteBoomuxInvocation(binary, argv) {
  return executableInvocation(binary, argv)
}

function validateBindings(value) {
  plainObject(value, "runner bindings")
  requireCondition(Object.keys(value).sort().join(",") === [...["builder", "coordinator", "reviewer"]].sort().join(","),
    "invalid_bindings", "Runner bindings must contain exactly three roles")
  for (const role of ["coordinator", "builder", "reviewer"]) {
    const binding = plainObject(value[role], `${role} binding`)
    validateRole(role)
    requireCondition(Object.keys(binding).sort().join(",") === "agentRunId,shellId",
      "invalid_bindings", `${role} binding must contain exactly Agent Run and Shell IDs`)
    validateUuid(binding.agentRunId, `${role} Agent Run ID`)
    validateOpaqueId(binding.shellId, `${role} Shell ID`)
  }
  return value
}

function encodeBindings(bindings) {
  validateBindings(bindings)
  return ["coordinator", "builder", "reviewer"].map(role => {
    const binding = bindings[role]
    return `${role}:${binding.agentRunId}:${binding.shellId}`
  }).join(",")
}
