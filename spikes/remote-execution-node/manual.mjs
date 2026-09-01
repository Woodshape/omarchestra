#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  boomuxCommands,
  sshRemoteCommandInvocation,
  sshRemoteEnvInvocation,
  sshRemoteHelperInvocation,
  sudoProbeInvocation,
  systemdRunInvocation,
  systemctlShowInvocation,
  systemctlStopInvocation
} from "./lib/commands.mjs"
import { makeControlRequest } from "./lib/protocol.mjs"
import { ManualGate } from "./lib/manual-gate.mjs"
import { requireCondition, spikeError } from "./lib/errors.mjs"
import { exactCleanupPlan } from "./lib/runtime.mjs"
import { FileReceiptStore, validateInputs } from "./lib/receipt.mjs"
import { readFile } from "node:fs/promises"
import {
  ROLES,
  parseOptions,
  validateAbsolutePath,
  validateExecutablePath,
  validateNodeAlias,
  validateOpaqueId,
  validateUnixSocketPath,
  validateUnitName,
  validateUuid
} from "./lib/validation.mjs"

const ACTIONS = new Set([
  "receipt-init", "preflight-bind", "preflight", "preflight-remote", "sync-check", "workspace-create",
  "shells-create", "runner-start", "present-all", "represent-all", "control", "process-tree", "disconnect",
  "inspect-direct", "reconnect", "validate", "events", "cleanup", "postflight", "mark-attempted",
  "record-remote-preflight", "record-shell-readback", "record-workspace-readback", "record-runner-readback",
  "record-shell-run-readback", "record-represent-run-readback", "record-workspace-creation",
  "confirm-cleanup-unit-stop", "confirm-cleanup-files", "confirm-shell-close", "confirm-workspace-close",
  "mark-ambiguous"
])

// Actions that emit a live mutation/presentation/cleanup command plan. Each one is
// gated by the durable owner receipt and records its operation intent first.
const RECEIPT_PLAN_ACTIONS = new Set([
  "workspace-create", "shells-create", "runner-start", "present-all", "represent-all", "cleanup"
])

// Receipt-backed read-only phases: runtime-dependent remote reads plus the
// post-flight comparison. They verify the immutable receipt identity and derive
// the runtime directory from the bound preflight execution evidence.
const RECEIPT_READONLY_ACTIONS = new Set([
  "preflight-remote", "inspect-direct", "reconnect", "postflight"
])

// Explicit staged receipt steps required by the human procedure.
const RECEIPT_RECORD_ACTIONS = new Set([
  "receipt-init", "preflight-bind", "mark-attempted", "record-remote-preflight", "record-shell-readback",
  "record-workspace-readback", "record-runner-readback", "record-shell-run-readback",
  "record-represent-run-readback", "record-workspace-creation", "confirm-cleanup-unit-stop",
  "confirm-cleanup-files", "confirm-shell-close", "confirm-workspace-close", "mark-ambiguous"
])

const usage = () => [
  "Plan-only remote execution Node gate. This file never executes a command.",
  "Usage: manual.mjs ACTION --node-alias ALIAS --expected-node-id UUID --ssh-target USER@HOST ...",
  `Actions: ${[...ACTIONS].join(", ")}`,
  "Required executable flags: --local-boomux --ssh --remote-node --remote-boomux --remote-pi",
  "  --remote-systemd-run --remote-systemctl --remote-sudo --remote-env --remote-rm",
  "Required identity flags: --receipt-id UUID --team-goal-id UUID",
  "Runner flags: --runner-path PATH --remote-helper-path PATH --bridge-path PATH",
  "  --socket-path PATH --state-path PATH --unit UNIT",
  "Process evidence flags: --ps PATH --pstree PATH",
  "Role flags: --<role>-agent-run-id UUID --<role>-shell-id ID",
  "Receipt flags: --receipt-store PATH --preflight-file PATH --evidence-file PATH",
  "  --operation-id ID --role ROLE --reason TEXT",
  "Authorization flags: --authorize-runner --authorize-resources --authorize-gui --authorize-control --authorize-cleanup"
].join("\n")

const pathFlag = (flags, name, label = name) => validateAbsolutePath(requireFlag(flags, name), label)
const executableFlag = (flags, name, label = name) => validateExecutablePath(requireFlag(flags, name), label)

function requireFlag(flags, name) {
  requireCondition(Object.hasOwn(flags, name), "invalid_arguments", `Missing required option --${name}`)
  return flags[name]
}

export function parseManualArguments(argv) {
  requireCondition(Array.isArray(argv) && argv.length > 0, "invalid_arguments", usage())
  if (argv.length === 1 && argv[0] === "--help") return { action: "help", flags: { help: true } }
  const action = argv[0]
  requireCondition(ACTIONS.has(action), "invalid_arguments", `Unknown action ${action}\n${usage()}`)
  const specification = {}
  for (const name of [
    "node-alias", "expected-node-id", "ssh-target", "remote-repo", "receipt-id", "team-goal-id",
    "local-boomux", "ssh", "remote-node", "remote-boomux", "remote-pi", "remote-systemd-run",
    "remote-systemctl", "remote-sudo", "remote-env", "remote-rm", "runner-path", "remote-helper-path", "bridge-path",
    "socket-path", "state-path", "unit", "control-client-id", "validation-artifact-id", "pid", "ps", "pstree",
    "global-workspace-id", "owner-workspace-id", "receipt-store", "preflight-file", "evidence-file",
    "operation-id", "reason", "role"
  ]) specification[name] = { required: false }
  for (const role of ROLES) {
    specification[`${role}-agent-run-id`] = { required: false }
    specification[`${role}-shell-id`] = { required: false }
  }
  for (const name of ["authorize-runner", "authorize-resources", "authorize-gui", "authorize-control", "authorize-cleanup", "help"]) {
    specification[name] = { boolean: true }
  }
  return { action, flags: parseOptions(argv.slice(1), specification) }
}

function baseInputs(flags) {
  const inputs = {
    nodeAlias: validateNodeAlias(requireFlag(flags, "node-alias")),
    expectedNodeId: validateUuid(requireFlag(flags, "expected-node-id"), "expected Node ID"),
    sshTarget: requireFlag(flags, "ssh-target"),
    remoteRepo: validateAbsolutePath(requireFlag(flags, "remote-repo"), "remote repository"),
    executables: {
      localBoomux: executableFlag(flags, "local-boomux", "local Boomux"),
      ssh: executableFlag(flags, "ssh", "SSH"),
      remoteNode: executableFlag(flags, "remote-node", "remote Node executable"),
      remoteBoomux: executableFlag(flags, "remote-boomux", "remote Boomux"),
      remotePi: executableFlag(flags, "remote-pi", "remote Pi"),
      remoteSystemdRun: executableFlag(flags, "remote-systemd-run", "remote systemd-run"),
      remoteSystemctl: executableFlag(flags, "remote-systemctl", "remote systemctl"),
      remoteSudo: executableFlag(flags, "remote-sudo", "remote sudo"),
      remoteEnv: executableFlag(flags, "remote-env", "remote env"),
      remoteRm: executableFlag(flags, "remote-rm", "remote rm")
    }
  }
  validateInputs(inputs)
  return inputs
}

function manualGate(flags, pathLabel = "receipt-store") {
  const storePath = validateAbsolutePath(requireFlag(flags, "receipt-store"), pathLabel)
  return new ManualGate(new FileReceiptStore(storePath))
}

function basePlan(action, inputs, receiptId, teamGoalId, remote) {
  const resourcePrefix = remote.unit.replace(/\.service$/, "")
  return { planOnly: true, action, inputs: { ...inputs, receiptId, teamGoalId }, remote, resourcePrefix,
    commands: [], notes: [] }
}

function commonRemote(flags) {
  return {
    runnerPath: pathFlag(flags, "runner-path", "runner path"),
    remoteHelperPath: pathFlag(flags, "remote-helper-path", "remote helper path"),
    bridgePath: pathFlag(flags, "bridge-path", "bridge extension path"),
    socketPath: validateUnixSocketPath(requireFlag(flags, "socket-path")),
    statePath: pathFlag(flags, "state-path", "runner state path"),
    unit: validateUnitName(requireFlag(flags, "unit"))
  }
}

function command(binary, argv, label, { gui = false, mutation = false, ...rest } = {}) {
  if (mutation) {
    // Every mutating command must name the exact receipt operation the human must
    // mark attempted before executing it, so plans and receipt states stay paired.
    requireCondition(typeof rest.operationId === "string"
      && /^[a-z0-9][a-z0-9-]{0,127}$/.test(rest.operationId),
    "invalid_arguments", `Mutating command ${label ?? ""} must carry its exact receipt operationId`)
  }
  return { label, binary, argv: [...argv], gui, mutation, ...(mutation ? { operationId: rest.operationId } : {}) }
}

function requireAuthorization(flags, name, message) {
  requireCondition(flags[name] === true, "authorization_required", `${message} requires --${name}`)
}

function configurationCommandsLocal(inputs) {
  const local = inputs.executables.localBoomux
  return [
    command(local, boomuxCommands.configPath(), "local Boomux configuration path"),
    command(local, boomuxCommands.configValidate(), "local Boomux configuration validation"),
    command(local, boomuxCommands.integrationList(), "local integration list fingerprint"),
    command(local, boomuxCommands.integrationStatus(), "local integration status fingerprint")
  ]
}

// Runtime-dependent remote invocations go through the receipt-bound execution
// identity: exact `remoteEnv XDG_RUNTIME_DIR=<bound dir> <binary> ...` over SSH,
// derived from the strictly validated preflight execution evidence.
function sshEnv(receipt, inputs, remoteExecutable, args) {
  const execution = receipt?.preflight?.execution
  requireCondition(execution !== undefined && execution !== null, "preflight_required",
    "Runtime-dependent remote commands require the bound preflight execution identity")
  return sshRemoteEnvInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteEnv: inputs.executables.remoteEnv,
    runtimeDirectory: execution.runtimeDirectory,
    remoteExecutable,
    args
  })
}

function configurationCommandsRemote(receipt, remote) {
  const inputs = receiptInputs(receipt)
  const remoteRead = args => command(...Object.values(sshEnv(receipt, inputs,
    inputs.executables.remoteBoomux, args)),
  `remote (receipt-bound runtime env) Boomux ${args[0]} ${args[1] ?? ""}`.trim())
  return [
    remoteRead(boomuxCommands.configPath()),
    remoteRead(boomuxCommands.configValidate()),
    remoteRead(boomuxCommands.integrationList()),
    remoteRead(boomuxCommands.integrationStatus())
  ]
}

// Pre-bind preflight: identity, local reads, and runtime-independent remote
// facts only. The prerequisite check runs first and derives the execution
// identity; runtime-dependent remote Boomux reads belong to the receipt-backed
// post-bind `preflight-remote` phase and may not run untyped beforehand.
function preflightPlan(inputs, remote) {
  const local = inputs.executables.localBoomux
  const commands = [
    command(local, boomuxCommands.capabilities(), "local capabilities"),
    command(local, boomuxCommands.daemonStatus(), "local daemon status"),
    command(local, boomuxCommands.nodeInspect(inputs.nodeAlias), "registered Node inspection"),
    command(local, boomuxCommands.nodeSnapshot(inputs.nodeAlias), "combined Node snapshot"),
    command(local, boomuxCommands.workspaceList(), "global Workspace baseline"),
    command(local, boomuxCommands.events(), "Boomux event baseline"),
    command(...Object.values(sshRemoteHelperInvocation({
      sshPath: inputs.executables.ssh,
      target: inputs.sshTarget,
      remoteNodePath: inputs.executables.remoteNode,
      remoteHelperPath: remote.remoteHelperPath,
      action: "prerequisites",
      args: ["--repo", inputs.remoteRepo]
    })), "remote identity and runtime prerequisite check (derives the execution identity)"),
    command(...Object.values(sshRemoteCommandInvocation({
      sshPath: inputs.executables.ssh,
      target: inputs.sshTarget,
      remoteExecutable: inputs.executables.remoteSudo,
      args: sudoProbeInvocation(inputs.executables.remoteSudo).argv
    })), "remote noninteractive sudo refusal probe"),
    ...configurationCommandsLocal(inputs)
  ]
  return { commands, notes: [
    "Run the prerequisite check first: its captured output derives the execution identity that the receipt binds.",
    "Capture all JSON responses privately before any mutation.",
    "Runtime-dependent remote Boomux reads (capabilities, daemon status, remote config/integration fingerprints)",
    "belong to the receipt-backed post-bind preflight-remote phase.",
    "Require UID > 0, sudo -n failure, runtime directory owner match, and mode 0700.",
    "Record the absent-configuration fingerprint as null where a config path does not exist.",
    "Bind the exact registration, local configuration/integration fingerprints, Node snapshot, Workspace IDs, and event cursor into the receipt.",
    "Bind the captured execution identity (UID, runtime directory, derived source, 0700 mode) with preflight-bind."
  ], remote }
}

// Receipt-backed post-bind read-only phase: runtime-dependent remote Boomux
// reads through the derived runtime directory. Their evidence is recorded with
// record-remote-preflight before any mutation plan is printable.
function preflightRemotePlan(receipt, remote) {
  const inputs = receiptInputs(receipt)
  const remoteRead = (args, label) => command(...Object.values(sshEnv(receipt, inputs,
    inputs.executables.remoteBoomux, args)), label)
  return { commands: [
    remoteRead(boomuxCommands.capabilities(), "remote Boomux capabilities (receipt-bound runtime env)"),
    remoteRead(boomuxCommands.daemonStatus(), "remote daemon status (receipt-bound runtime env)"),
    ...configurationCommandsRemote(receipt, remote)
  ], notes: [
    "These reads require the receipt-bound derived runtime directory; verified SSH may leave XDG_RUNTIME_DIR unset.",
    "Record the raw capability/daemon JSON plus the remote config/integration fingerprints with record-remote-preflight;",
    "the remote fingerprints recorded here are their first authority (the bound preflight keeps local fingerprints only).",
    "No mutation plan is printable before that record."
  ] }
}

function syncPlan(inputs, remote) {
  const invocation = sshRemoteHelperInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteNodePath: inputs.executables.remoteNode,
    remoteHelperPath: remote.remoteHelperPath,
    action: "sync-check",
    args: ["--repo", inputs.remoteRepo]
  })
  return { commands: [command(invocation.binary, invocation.argv, "read-only remote checkout sync check")], notes: [
    "This only checks the remote checkout. It does not copy files or credentials."
  ]}
}

async function runnerPlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-runner", "runner start")
  const gate = manualGate(flags)
  const inputs = receiptInputs(receipt)
  requireCondition(receipt.workspace !== null && receipt.workspace.shells.length === 3,
    "mapping_missing", "Runner start requires the exact three recorded role Shell mappings")
  const bindings = Object.fromEntries(ROLES.map(role => [role, {
    agentRunId: receipt.agentRuns[role].id,
    shellId: receipt.workspace.shells.find(shell => shell.role === role).id
  }]))
  await gate.planRunnerStart({
    unit: remote.unit, socketPath: remote.socketPath, statePath: remote.statePath
  }, invocationOf(receipt))
  const invocation = systemdRunInvocation({
    systemdRunPath: inputs.executables.remoteSystemdRun,
    unit: remote.unit,
    nodePath: inputs.executables.remoteNode,
    runnerPath: remote.runnerPath,
    socketPath: remote.socketPath,
    statePath: remote.statePath,
    teamGoalId: receipt.teamGoal.id,
    receiptId: receipt.receiptId,
    bindings
  })
  const startRemote = sshEnv(receipt, inputs, invocation.binary, invocation.argv)
  const show = systemctlShowInvocation({ systemctlPath: inputs.executables.remoteSystemctl, unit: remote.unit })
  const showRemote = sshEnv(receipt, inputs, show.binary, show.argv)
  const fileStatus = sshRemoteHelperInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteNodePath: inputs.executables.remoteNode,
    remoteHelperPath: remote.remoteHelperPath,
    action: "file-status",
    args: ["--socket", remote.socketPath, "--state", remote.statePath]
  })
  return { commands: [
    command(startRemote.binary, startRemote.argv, "exact owner-local systemd runner (receipt-bound runtime env)",
      { mutation: true, operationId: "runner-start" }),
    command(showRemote.binary, showRemote.argv,
      "read exact runner unit and PID (receipt-bound runtime env)"),
    command(fileStatus.binary, fileStatus.argv,
      "read exact runner socket and state facts (remote-helper file-status)")
  ], notes: [
    "Start only this exact user unit after the three Shell IDs have been recorded as pending.",
    "The runtime-dependent commands carry the receipt-bound XDG_RUNTIME_DIR prefix from the preflight execution identity.",
    "New Shells are pending until the first open: start the runner before presenting so bridges connect on first open.",
    "The unit owns the runner socket and state path. No daemon or existing Node registration is changed.",
    "Record the exact readback with record-runner-readback (raw unitShow lines + remote-helper file-status JSON)."
  ]}
}

// Shell argv is derived entirely from the receipt: Team Goal, Agent Run, roles,
// socket, extension instance, and executable paths come from durable state.
function shellArgv(receipt, remote, role) {
  return [
    receipt.inputs.executables.remoteEnv,
    `OMARCHESTRA_TEAM_GOAL_ID=${receipt.teamGoal.id}`,
    `OMARCHESTRA_AGENT_RUN_ID=${receipt.agentRuns[role].id}`,
    `OMARCHESTRA_ROLE=${role}`,
    `OMARCHESTRA_BRIDGE_SOCKET=${remote.socketPath}`,
    `OMARCHESTRA_EXTENSION_INSTANCE_ID=${receipt.prefix}-${role}`,
    receipt.inputs.executables.remotePi,
    "--no-extensions",
    "-e",
    remote.bridgePath
  ]
}

function receiptInputs(receipt) {
  return { ...receipt.inputs }
}

function invocationOf(receipt) {
  return { receiptId: receipt.receiptId, teamGoalId: receipt.teamGoal.id, inputs: receipt.inputs }
}

// Workspace creation interleaves its exact public readbacks: the empty list
// before, the create, and the after list that resolves the one new identity.
async function workspacePlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-resources", "Workspace creation")
  const gate = manualGate(flags)
  await gate.planWorkspaceCreate({
    operationId: "workspace-create", name: receipt.prefix
  }, invocationOf(receipt))
  const inputs = receiptInputs(receipt)
  return { commands: [
    command(inputs.executables.localBoomux, boomuxCommands.workspaceList(),
      "read exact global Workspace list before create"),
    command(inputs.executables.localBoomux,
      boomuxCommands.workspaceCreateEmpty(receipt.prefix),
      "create exact empty coordinated Workspace", { mutation: true, operationId: "workspace-create" }),
    command(inputs.executables.localBoomux, boomuxCommands.workspaceList(),
      "read exact global Workspace list after create")
  ], notes: [
    "Resolve the new global Workspace ID from the before/after list difference through record-workspace-creation.",
    "An empty Workspace has zero placements: record the global ID only; the owner Workspace ID comes later.",
    "If a weak command outcome is ambiguous, record it with mark-ambiguous and do not retry by name."
  ] }
}

async function shellsPlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-resources", "Shell creation")
  const gate = manualGate(flags)
  const inputs = receiptInputs(receipt)
  const shellSpecifications = ROLES.map(role => ({
    role,
    name: `${receipt.prefix}-${role}`,
    cwd: inputs.remoteRepo,
    argv: shellArgv(receipt, remote, role)
  }))
  const { globalWorkspaceId } = await gate.planShellCreates(shellSpecifications, invocationOf(receipt))
  const commands = []
  for (const specification of shellSpecifications) {
    commands.push(command(inputs.executables.localBoomux,
      boomuxCommands.shellCreate({
        globalWorkspaceId,
        nodeSelector: inputs.expectedNodeId,
        name: specification.name,
        cwd: specification.cwd,
        argv: specification.argv
      }), `create exact ${specification.role} interactive Pi Shell`,
      { mutation: true, operationId: `shell-create-${specification.role}` }))
    // Exact Shell IDs are generated by creation, so the owner snapshot follows
    // each create; the per-Shell exact `shell inspect --json` documents are
    // captured at the recorded IDs and consumed as raw evidence by
    // record-shell-readback (resolveShellCreation).
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.nodeSnapshot(inputs.expectedNodeId))),
      `read owner Node snapshot after exact ${specification.role} create (receipt-bound runtime env)`))
  }
  return { commands, notes: [
    "One-attempt-at-a-time: after each create run mark-attempted --operation-id shell-create-<role>, execute the",
    "create, capture the owner snapshot plus exact shell inspect JSON at the new ID, and confirm through",
    "record-shell-readback before marking the next create attempted.",
    "New Shells are pending until their first open; no running Run exists yet.",
    "Boomux supplies BOOMUX_SHELL_ID to the visible Pi host. Confirm it equals the receipt mapping in the bridge hello."
  ] }
}

async function presentPlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-gui", "native presentation")
  const gate = manualGate(flags)
  const { receipt: presentReceipt, shells } = await gate.planPresentAll(invocationOf(receipt))
  const inputs = receiptInputs(presentReceipt)
  const commands = []
  for (const shellMapping of shells) {
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellInspect(shellMapping.id))),
      `read exact ${shellMapping.role} Shell before open (receipt-bound runtime env)`))
    commands.push(command(inputs.executables.localBoomux,
      boomuxCommands.openRemote({
        shellId: shellMapping.id,
        nodeSelector: inputs.expectedNodeId,
        globalWorkspaceId: presentReceipt.workspace.globalId,
        title: `${receipt.prefix}-${shellMapping.role}`
      }), `present ${shellMapping.role} exact remote PTY`,
      { gui: true, mutation: true, operationId: `present-${shellMapping.role}` }))
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellInspect(shellMapping.id))),
      `read exact ${shellMapping.role} Shell after open (receipt-bound runtime env)`))
  }
  return { commands, notes: [
    "All three Shells are pending at this point; no running Run is required or expected before the first open.",
    "One-attempt-at-a-time: run mark-attempted --operation-id present-<role> immediately before each open, then",
    "confirm through record-shell-run-readback from the raw after-open inspect before the next role.",
    "Pre/post inspection preserves the documented non-atomic race classification: a Run replacement is an",
    "unsupported uncertain outcome, not success."
  ] }
}

// Re-presentation after reconnect uses distinct receipt operations so neither
// operation IDs nor confirmations collide with the first presentation.
async function representPlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-gui", "native re-presentation")
  const gate = manualGate(flags)
  const { receipt: representedReceipt, shells } = await gate.planRepresentAll(invocationOf(receipt))
  const inputs = receiptInputs(representedReceipt)
  const commands = []
  for (const shellMapping of shells) {
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellInspect(shellMapping.id))),
      `read exact ${shellMapping.role} Shell before re-open (receipt-bound runtime env)`))
    commands.push(command(inputs.executables.localBoomux,
      boomuxCommands.openRemote({
        shellId: shellMapping.id,
        nodeSelector: inputs.expectedNodeId,
        globalWorkspaceId: representedReceipt.workspace.globalId,
        title: `${receipt.prefix}-${shellMapping.role}`
      }), `re-present ${shellMapping.role} exact remote PTY`,
      { gui: true, mutation: true, operationId: `represent-${shellMapping.role}` }))
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellInspect(shellMapping.id))),
      `read exact ${shellMapping.role} Shell after re-open (receipt-bound runtime env)`))
  }
  return { commands, notes: [
    "Re-presentation requires the reconciled initial Run IDs; each after-open inspect must observe the exact",
    "same receipt-owned Run through record-represent-run-readback. A changed Run is the documented",
    "unsupported, uncertain outcome of generic open."
  ] }
}

async function cleanupPlan(receipt, flags, remote) {
  requireAuthorization(flags, "authorize-cleanup", "destructive cleanup")
  const gate = manualGate(flags)
  await gate.receiptForInvocation(invocationOf(receipt))
  const inputs = receiptInputs(receipt)
  const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "cleanup evidence file")
  const evidence = JSON.parse(await readFile(evidenceFile, "utf8"))
  const exact = exactCleanupPlan(receipt, evidence)
  await gate.planOperation({ id: "cleanup-unit-stop", kind: "unit_stop", intent: { unit: exact.runner.unit } })
  await gate.planOperation({
    id: "cleanup-remove-files",
    kind: "runner_file_remove",
    intent: { socketPath: exact.socketPath, statePath: exact.statePath }
  })
  for (const role of ROLES) {
    await gate.planOperation({
      id: `cleanup-shell-close-${role}`,
      kind: "shell_close",
      intent: {
        shellId: receipt.workspace.shells.find(shell => shell.role === role).id,
        workspaceId: exact.ownerWorkspaceId
      }
    })
  }
  await gate.planOperation({
    id: "cleanup-workspace-close",
    kind: "workspace_close",
    intent: { globalWorkspaceId: exact.globalWorkspaceId }
  })
  const commands = []
  const stop = systemctlStopInvocation({ systemctlPath: inputs.executables.remoteSystemctl, unit: exact.runner.unit })
  const stopRemote = sshEnv(receipt, inputs, stop.binary, stop.argv)
  commands.push(command(stopRemote.binary, stopRemote.argv,
    "stop exact runner user unit (receipt-bound runtime env)",
    { mutation: true, operationId: "cleanup-unit-stop" }))
  const show = systemctlShowInvocation({ systemctlPath: inputs.executables.remoteSystemctl, unit: exact.runner.unit })
  const showRemote = sshEnv(receipt, inputs, show.binary, show.argv)
  commands.push(command(showRemote.binary, showRemote.argv,
    "read exact runner unit state after stop (requires ActiveState=inactive and MainPID=0)"))
  const removeFiles = sshRemoteCommandInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteExecutable: inputs.executables.remoteRm,
    args: ["-f", "--", exact.socketPath, exact.statePath]
  })
  commands.push(command(removeFiles.binary, removeFiles.argv,
    "remove exact runner socket and state paths (exact direct argv; no runtime directory required)",
    { mutation: true, operationId: "cleanup-remove-files" }))
  const fileStatus = sshRemoteHelperInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteNodePath: inputs.executables.remoteNode,
    remoteHelperPath: remote.remoteHelperPath,
    action: "file-status",
    args: ["--socket", exact.socketPath, "--state", exact.statePath]
  })
  commands.push(command(fileStatus.binary, fileStatus.argv,
    "read exact spike file-status after removal (requires both exact paths absent)"))
  for (const shellMapping of receipt.workspace.shells) {
    requireCondition(exact.shellIds.includes(shellMapping.id), "ownership_uncertain",
      `Cleanup plan lacks the receipt-owned ${shellMapping.role} Shell`)
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellClose({ shellId: shellMapping.id, workspaceId: exact.ownerWorkspaceId }))),
      `close exact Shell ${shellMapping.id} on its owner Node (receipt-bound runtime env)`,
      { mutation: true, operationId: `cleanup-shell-close-${shellMapping.role}` }))
    commands.push(command(...Object.values(sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      boomuxCommands.shellInspectInWorkspace({
        shellId: shellMapping.id, workspaceId: exact.ownerWorkspaceId
      }))),
      `read back exact Shell absence ${shellMapping.id} on its owner Node (requires the typed not_found error)`))
  }
  commands.push(command(inputs.executables.localBoomux, boomuxCommands.workspaceClose(exact.globalWorkspaceId),
    "close exact coordinated Workspace", { mutation: true, operationId: "cleanup-workspace-close" }))
  commands.push(command(inputs.executables.localBoomux, boomuxCommands.workspaceInspect(exact.globalWorkspaceId),
    "read back exact coordinated Workspace absence (requires the typed not_found error)"))
  return { commands, notes: [
    "Before every command, reconcile the pinned Node identity and exact receipt ownership.",
    "Run mark-attempted --operation-id <id> immediately before executing each printed mutating command; every",
    "command object names its exact receipt operationId and only one operation may be attempted at a time.",
    "After each destructive step, confirm its exact readback (confirm-cleanup-unit-stop, confirm-cleanup-files,",
    "confirm-shell-close --role <role>, confirm-workspace-close) before marking the next operation attempted.",
    "Stop on the first unproven or ambiguous outcome; if an executed outcome cannot be proven exactly, record it",
    "with mark-ambiguous — the receipt then blocks all later plans until exactly reconciled.",
    "Cleanup resource IDs come from receipt-backed exactCleanupPlan of fresh evidence only; CLI resource IDs are ignored.",
    "The unit stop/readback carry the receipt-bound XDG_RUNTIME_DIR prefix; the exact rm argv needs none.",
    "Never use names, prefixes, focus, wildcards, broad process-name kills, global close, daemon lifecycle",
    "actions, or Node registration operations as cleanup authority."
  ] }
}

function controlPlan(inputs, flags, remote) {
  requireAuthorization(flags, "authorize-control", "control transport")
  const invocation = sshRemoteHelperInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteNodePath: inputs.executables.remoteNode,
    remoteHelperPath: remote.remoteHelperPath,
    action: "control-proxy",
    args: [
      "--socket", remote.socketPath,
      "--receipt-id", validateUuid(requireFlag(flags, "receipt-id"), "receipt ID"),
      "--team-goal-id", validateUuid(requireFlag(flags, "team-goal-id"), "Team Goal ID"),
      "--control-client-id", validateOpaqueId(requireFlag(flags, "control-client-id"), "control client ID")
    ]
  })
  return { commands: [command(invocation.binary, invocation.argv, "authenticated SSH stdio control proxy")], notes: [
    "Send only framed control_request messages on stdin. The remote helper connects to the owner-only Unix socket.",
    "Closing this SSH process must not stop the remote runner or visible Pi processes."
  ]}
}

function processPlan(inputs, flags, remote) {
  const pid = Number(requireFlag(flags, "pid"))
  requireCondition(Number.isSafeInteger(pid) && pid > 0, "invalid_arguments", "--pid must be a positive integer")
  const ps = executableFlag(flags, "ps", "ps")
  const pstree = executableFlag(flags, "pstree", "pstree")
  const psInvocation = sshRemoteCommandInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteExecutable: ps,
    args: ["-o", "pid", "-o", "ppid", "-o", "sid", "-o", "stat", "-o", "args", "-p", String(pid)]
  })
  const pstreeInvocation = sshRemoteCommandInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteExecutable: pstree,
    args: ["-ap", String(pid)]
  })
  return { commands: [
    command(psInvocation.binary, psInvocation.argv, "visible Pi process identity"),
    command(pstreeInvocation.binary, pstreeInvocation.argv, "visible Pi descendant tree")
  ], notes: [
    "The tree must show exactly the three visible Pi host processes and no hidden Pi child."
  ]}
}

// Inspection runs on the owning Node through the receipt-bound runtime env.
// Inspection authority derives from the receipt Shell mappings. Compatibility
// CLI Shell IDs are accepted only when they exactly match the receipt.
function inspectPlan(receipt, flags, remote, { reconnect = false } = {}) {
  requireCondition(receipt.workspace !== null, "mapping_missing",
    "Shells inspection requires the recorded Workspace mapping")
  const inputs = receiptInputs(receipt)
  const commands = []
  for (const shellMapping of receipt.workspace.shells) {
    const compatibilityFlag = Object.hasOwn(flags, `${shellMapping.role}-shell-id`)
      ? flags[`${shellMapping.role}-shell-id`] : undefined
    if (compatibilityFlag !== undefined && compatibilityFlag !== null) {
      requireCondition(typeof compatibilityFlag === "string"
        && internalIdFromFlag(compatibilityFlag) === shellMapping.id,
      "identity_mismatch", `The ${shellMapping.role}-shell-id flag differs from the receipt Shell mapping`)
    }
    const invocation = sshEnv(receipt, inputs, inputs.executables.remoteBoomux,
      ["shell", "inspect", shellMapping.id, "--json"])
    commands.push(command(invocation.binary, invocation.argv,
      `${reconnect ? "reconnect " : ""}${shellMapping.role} exact Shell Run inspection`))
  }
  return { commands, notes: [
    "Shell IDs are receipt-owned; compare the public Shell Run IDs and private process identities with the",
    "receipt, not with names or terminal output."
  ]}
}

function internalIdFromFlag(value) {
  return value
}

function validationPlan(inputs, flags, remote) {
  const artifactId = validateOpaqueId(requireFlag(flags, "validation-artifact-id"), "validation artifact ID")
  const invocation = sshRemoteCommandInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteExecutable: inputs.executables.remoteNode,
    args: ["-p", "2"]
  })
  const requestTemplate = makeControlRequest({
    requestId: `record-${artifactId}`,
    operation: "record_validation",
    payload: { artifactId, command: [inputs.executables.remoteNode, "-p", "2"] },
    timestamp: Date.now()
  })
  return { commands: [command(invocation.binary, invocation.argv, "harmless remote validation command")],
    controlFrameTemplate: requestTemplate, notes: [
    "Capture the exact exit status and compute bounded byte/character/line counts plus SHA-256 for each stream.",
    "Submit only that metadata through record_validation; output bodies are forbidden on the control protocol.",
    "This artifact never substitutes for Coordinator, Builder, or Reviewer evidence."
  ]}
}

function eventsPlan(inputs, flags, remote) {
  return controlPlan(inputs, flags, remote)
}

async function reconnectPlan(receipt, flags, remote) {
  const control = controlPlan(receiptInputs(receipt), flags, remote)
  const inspections = inspectPlan(receipt, flags, remote, { reconnect: true })
  return {
    commands: [...control.commands, ...inspections.commands],
    notes: [
      "Start a new authenticated SSH stdio control client, request a fresh runner snapshot, then inspect every exact Shell Run.",
      ...inspections.notes
    ]
  }
}

function postflightPlan(receipt, flags, remote) {
  const inputs = receiptInputs(receipt)
  requireCondition(receipt.runner !== null, "ownership_uncertain",
    "Postflight cannot prove exact runner absence without the recorded runner ownership")
  const show = systemctlShowInvocation({ systemctlPath: inputs.executables.remoteSystemctl,
    unit: receipt.runner.unit })
  const showRemote = sshEnv(receipt, inputs, show.binary, show.argv)
  const fileStatus = sshRemoteHelperInvocation({
    sshPath: inputs.executables.ssh,
    target: inputs.sshTarget,
    remoteNodePath: inputs.executables.remoteNode,
    remoteHelperPath: remote.remoteHelperPath,
    action: "file-status",
    args: ["--socket", receipt.runner.socketPath, "--state", receipt.runner.statePath]
  })
  return {
    commands: [
      command(inputs.executables.localBoomux, boomuxCommands.nodeInspect(inputs.nodeAlias), "postflight Node registration"),
      command(inputs.executables.localBoomux, boomuxCommands.nodeSnapshot(inputs.nodeAlias), "postflight Node snapshot"),
      command(inputs.executables.localBoomux, boomuxCommands.workspaceList(), "postflight Workspaces"),
      command(inputs.executables.localBoomux, boomuxCommands.events(), "postflight event baseline"),
      ...configurationCommandsLocal(inputs),
      ...configurationCommandsRemote(receipt, remote),
      command(showRemote.binary, showRemote.argv,
        `postflight exact runner unit absence ${receipt.runner.unit} (requires ActiveState=inactive/absent and MainPID=0)`),
      command(fileStatus.binary, fileStatus.argv,
        `postflight exact runner socket/state absence ${receipt.runner.socketPath} ${receipt.runner.statePath} (requires both absent)`)
    ],
    notes: ["Compare every result with the bound preflight and recorded remote preflight, including configuration/integration fingerprints and explicit absent config. The exact unit-readback must show the receipt unit inactive/absent with MainPID=0 and the file-status report must show both exact paths absent, proving spike-resource absence fail-closed."]
  }
}
export async function buildPlan(action, flags) {
  const inputs = baseInputs(flags)
  const receiptId = validateUuid(requireFlag(flags, "receipt-id"), "receipt ID")
  const teamGoalId = validateUuid(requireFlag(flags, "team-goal-id"), "Team Goal ID")
  const remote = commonRemote(flags)
  const resourcePrefix = `omarchestra-remote-spike-${receiptId}`
  requireCondition(remote.unit === `${resourcePrefix}.service`,
    "invalid_unit", "Runner unit must derive exactly from the receipt ID")
  requireCondition(remote.socketPath.endsWith(`${resourcePrefix}.sock`),
    "invalid_socket_path", "Runner socket path must end with the receipt-derived name")
  requireCondition(path.posix.basename(remote.statePath).startsWith(`${resourcePrefix}.`),
    "invalid_state_path", "Runner state path must use the receipt-derived name")
  remote.resourcePrefix = resourcePrefix
  if (RECEIPT_PLAN_ACTIONS.has(action)) {
    const plan = { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [] }
    const gate = manualGate(flags)
    // Every receipt-backed action verifies the full immutable input set and
    // identity before recording intent or printing, then derives all
    // authority-bearing values from the returned receipt instead of the flags.
    const receipt = await gate.receiptForInvocation({ receiptId, teamGoalId, inputs })
    if (action === "runner-start") Object.assign(plan, await runnerPlan(receipt, flags, remote))
    else if (action === "workspace-create") Object.assign(plan, await workspacePlan(receipt, flags, remote))
    else if (action === "shells-create") Object.assign(plan, await shellsPlan(receipt, flags, remote))
    else if (action === "present-all") Object.assign(plan, await presentPlan(receipt, flags, remote))
    else if (action === "represent-all") Object.assign(plan, await representPlan(receipt, flags, remote))
    else if (action === "cleanup") Object.assign(plan, await cleanupPlan(receipt, flags, remote))
    return plan
  }
  if (RECEIPT_READONLY_ACTIONS.has(action)) {
    const gate = manualGate(flags)
    const receipt = await gate.receiptForInvocation({ receiptId, teamGoalId, inputs })
    const plan = { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [] }
    if (action === "preflight-remote") Object.assign(plan, preflightRemotePlan(receipt, remote))
    else if (action === "inspect-direct") Object.assign(plan, inspectPlan(receipt, flags, remote))
    else if (action === "reconnect") Object.assign(plan, await reconnectPlan(receipt, flags, remote))
    else if (action === "postflight") Object.assign(plan, postflightPlan(receipt, flags, remote))
    return plan
  }
  if (RECEIPT_RECORD_ACTIONS.has(action)) {
    return receiptStepPlan(action, flags, inputs, receiptId, teamGoalId, remote)
  }
  const plan = { planOnly: true, action, inputs: { ...inputs, receiptId, teamGoalId }, remote,
    resourcePrefix, commands: [], notes: [] }
  if (action === "preflight") Object.assign(plan, preflightPlan(inputs, remote))
  else if (action === "sync-check") Object.assign(plan, syncPlan(inputs, remote))
  else if (action === "control") Object.assign(plan, controlPlan(inputs, flags, remote))
  else if (action === "process-tree") Object.assign(plan, processPlan(inputs, flags, remote))
  else if (action === "validate") Object.assign(plan, validationPlan(inputs, flags, remote))
  else if (action === "events") Object.assign(plan, eventsPlan(inputs, flags, remote))
  else if (action === "disconnect") plan.notes = [
    "Human action only: close the local control SSH and all native terminal windows. Do not stop the remote unit or use a broad process action.",
    "Then use inspect-direct to prove the same remote PIDs and Shell Runs remain."
  ]
  return plan
}

// Staged, explicit receipt procedures. These steps mutate only the owner-only
// receipt file to record initialize/preflight/attempt/mapping/readback/transition
// state; they never execute one of the printed live commands.
async function receiptStepPlan(action, flags, inputs, receiptId, teamGoalId, remote) {
  const gate = manualGate(flags)
  const prefix = `omarchestra-remote-spike-${receiptId}`
  if (action === "receipt-init") {
    const agentRuns = Object.fromEntries(ROLES.map(role => [role,
      validateUuid(requireFlag(flags, `${role}-agent-run-id`), `${role} Agent Run ID`)]))
    await gate.initializeReceipt({
      receiptId,
      prefix,
      teamGoalId,
      agentRuns,
      inputs
    })
    return { planOnly: true, action, inputs: { ...inputs, receiptId, teamGoalId }, remote,
      commands: [], notes: [
      "The owner-only receipt is initialized in the receipt store; keep the store in the ignored private evidence area.",
      "Continue with the read-only preflight, then bind its exact private snapshot with preflight-bind."
    ] }
  }
  // Every remaining receipt step verifies the full immutable input set and
  // identity against the durable receipt before recording anything.
  const receipt = await gate.receiptForInvocation({ receiptId, teamGoalId, inputs })
  const resourcePrefix = receipt.prefix
  if (action === "preflight-bind") {
    const preflightPath = validateAbsolutePath(requireFlag(flags, "preflight-file"), "preflight file")
    const bound = await gate.bindPreflightEvidence(preflightPath)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The private preflight snapshot is immutably bound to alias, target, pinned Node ID, and the",
      "strictly validated execution identity (UID, runtime directory, derived source, 0700 mode).",
      "Continue with the receipt-backed preflight-remote phase, then record-remote-preflight before mutations."
    ], preflightBound: true, preflightRegistration: bound.preflight.registration }
  }
  if (action === "record-remote-preflight") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "remote preflight evidence file")
    const updated = await gate.recordRemotePreflight(evidenceFile)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The runtime-dependent remote preflight evidence is recorded; mutation plans now record durable intent",
      "before printing, and mutations require this record before they are printable."
    ], remotePreflightRecorded: true,
      runtimeDirectory: updated.remotePreflight.runtimeDirectory }
  }
  if (action === "record-workspace-creation") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "workspace creation evidence file")
    const updated = await gate.recordWorkspaceCreation(evidenceFile)
    const operation = findReceiptOperation(updated, "workspace-create")
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw before/after `boomux workspace list --json` data resolved by resolveWorkspaceCreation().",
      "An empty Workspace has no placement, so the owner Workspace ID is still unknown at this point.",
      "Proceed to shells-create, then record each Shell creation from raw public evidence."
    ], workspaceCreationRecorded: true,
      globalWorkspaceId: operation?.result?.globalWorkspaceId ?? null }
  }
  if (action === "mark-attempted") {
    const operationId = requireFlag(flags, "operation-id")
    await gate.markAttemptedOutcome(operationId)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The durable intent is now attempted. If execution crashes here, replay stays blocked until exact",
      "reconciliation through the specialized evidence action, or mark-ambiguous if the outcome cannot be proven."
    ], operationAttempted: operationId }
  }
  if (action === "record-shell-readback") {
    const role = requireFlag(flags, "role")
    const evidenceFile = requireFlag(flags, "evidence-file")
    const updated = await gate.recordShellCreation({
      role,
      evidenceSource: validateAbsolutePath(evidenceFile, "shell creation evidence file"),
      expected: {
        name: `${receipt.prefix}-${role}`,
        cwd: receipt.inputs.remoteRepo,
        argv: shellArgv(receipt, remote, role)
      }
    })
    const operation = findReceiptOperation(updated, `shell-create-${role}`)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw owner Node snapshot plus the exact shell inspect JSON resolved by resolveShellCreation().",
      "Record this readback for every role, then record-workspace-readback; the owner ID is derived from all three."
    ], shellReadbackRecorded: role,
      shellId: operation.result.shellId, ownerWorkspaceId: operation.result.ownerId }
  }
  if (action === "record-workspace-readback") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "workspace mapping evidence file")
    const updated = await gate.recordWorkspaceReadback(evidenceFile)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The owner Workspace ID came from the three agreeing Shell readbacks and the single active remote placement.",
      "All three role Shells are recorded as pending. Proceed to runner-start, then present-all; no running Run is required first."
    ], workspaceRecorded: true,
      globalWorkspaceId: updated.workspace.globalId,
      ownerWorkspaceId: updated.workspace.ownerId,
      shells: updated.workspace.shells.map(shell => ({ role: shell.role, id: shell.id, runId: shell.runId })) }
  }
  if (action === "record-runner-readback") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "runner readback evidence file")
    const updated = await gate.recordRunnerReadback({
      evidenceSource: evidenceFile,
      expected: { unit: remote.unit, socketPath: remote.socketPath, statePath: remote.statePath }
    })
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw systemctl show lines plus the remote-helper file-status document, parsed and",
      "validated by the gate. Proceed to present-all; the Shells are pending and their first open starts the initial Runs."
    ], runnerRecorded: true, runner: updated.runner }
  }
  if (action === "record-shell-run-readback") {
    const role = requireFlag(flags, "role")
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "shell run readback evidence file")
    const updated = await gate.recordShellRunReadback({ role, evidenceSource: evidenceFile })
    const shellRun = updated.workspace.shells.find(item => item.role === role)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw public shell inspect JSON; the Run ID was extracted by the strict normalizer,",
      "never typed. Record every role's initial running Run ID after the first presentation before proceeding."
    ], shellRunRecorded: role, runId: shellRun.runId }
  }
  if (action === "record-represent-run-readback") {
    const role = requireFlag(flags, "role")
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "re-presented run readback evidence file")
    const updated = await gate.recordRepresentRunReadback({ role, evidenceSource: evidenceFile })
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The re-presented Run matched the receipt-owned Run exactly; a changed Run would have been refused."
    ], representRunRecorded: role }
  }
  if (action === "confirm-cleanup-unit-stop") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "stopped-unit evidence file")
    await gate.confirmCleanupUnitStop(evidenceFile, { unit: remote.unit })
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw systemctl show lines parsed strictly (exact unit, inactive, MainPID=0)."
    ], cleanupStepConfirmed: "cleanup-unit-stop" }
  }
  if (action === "confirm-cleanup-files") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "file-status evidence file")
    await gate.confirmCleanupFilesRemoved(evidenceFile, {
      socketPath: receipt.runner.socketPath, statePath: receipt.runner.statePath
    })
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw remote-helper file-status document covering exactly the two receipt-owned paths, both absent."
    ], cleanupStepConfirmed: "cleanup-remove-files" }
  }
  if (action === "confirm-shell-close") {
    const role = requireFlag(flags, "role")
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "shell close evidence file")
    await gate.confirmCleanupShellClose({ role, evidenceSource: evidenceFile })
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw Boomux stderr envelope for the exact receipt Shell; only the typed not_found error proves absence."
    ], cleanupStepConfirmed: `cleanup-shell-close-${role}` }
  }
  if (action === "confirm-workspace-close") {
    const evidenceFile = validateAbsolutePath(requireFlag(flags, "evidence-file"), "workspace close evidence file")
    await gate.confirmCleanupWorkspaceClose(evidenceFile)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "Evidence was the raw Boomux stderr envelope for the exact receipt Workspace; only the typed not_found error proves absence."
    ], cleanupStepConfirmed: "cleanup-workspace-close" }
  }
  if (action === "mark-ambiguous") {
    const operationId = requireFlag(flags, "operation-id")
    const reason = requireFlag(flags, "reason")
    await gate.markAmbiguousOutcome(operationId, reason)
    return { planOnly: true, action, remote, resourcePrefix, commands: [], notes: [
      "The receipt is blocked: every later mutation, presentation, and cleanup plan is refused",
      "until the ambiguous operation is exactly reconciled."
    ], operationAmbiguous: operationId }
  }
  throw spikeError("invalid_action", `Unhandled receipt action ${action}`)
}

function findReceiptOperation(receipt, operationId) {
  return receipt?.operations?.find?.(item => item.id === operationId) ?? null
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { action, flags } = parseManualArguments(argv)
    if (action === "help" || flags.help) return process.stdout.write(`${usage()}\n`)
    process.stdout.write(`${JSON.stringify(await buildPlan(action, flags), null, 2)}\n`)
  } catch (error) {
    const report = error instanceof Error
      ? { error: error.code ?? "internal", message: error.message, details: error.details ?? {} }
      : { error: "internal", message: String(error) }
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = 1
  }
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedAsScript) main()
