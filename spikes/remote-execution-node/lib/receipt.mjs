import { mkdir, lstat, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

import { validateCapabilities } from "./runtime.mjs"

import { requireCondition, spikeError } from "./errors.mjs"
import {
  ROLES,
  plainObject,
  validateAbsolutePath,
  validateExecutablePath,
  validateNodeAlias,
  validateOpaqueId,
  validateRole,
  validateSshTarget,
  validateUnitName,
  validateUuid
} from "./validation.mjs"

export const RECEIPT_SCHEMA = "omarchestra.remote-execution-node.receipt/v1"
export const PREFLIGHT_SCHEMA = "omarchestra.remote-execution-node.preflight/v1"

const EXECUTABLE_KEYS = Object.freeze([
  "localBoomux", "ssh", "remoteNode", "remoteBoomux", "remotePi", "remoteSystemdRun",
  "remoteSystemctl", "remoteSudo", "remoteEnv", "remoteRm"
])
const OPERATION_STATES = new Set(["intended", "attempted", "confirmed", "ambiguous"])
const clone = value => structuredClone(value)

export function validateInputs(value) {
  plainObject(value, "receipt inputs")
  const expected = ["executables", "expectedNodeId", "nodeAlias", "remoteRepo", "sshTarget"].sort()
  requireCondition(Object.keys(value).sort().join(",") === expected.join(","),
    "invalid_receipt", "Receipt inputs contain missing or unknown fields")
  plainObject(value.executables, "receipt executable paths")
  requireCondition(Object.keys(value.executables).sort().join(",") === [...EXECUTABLE_KEYS].sort().join(","),
    "invalid_receipt", "Receipt executable paths are incomplete")
  const executables = {}
  for (const key of EXECUTABLE_KEYS) executables[key] = validateExecutablePath(value.executables[key], key)
  return {
    nodeAlias: validateNodeAlias(value.nodeAlias),
    expectedNodeId: validateUuid(value.expectedNodeId, "expected Node ID"),
    sshTarget: validateSshTarget(value.sshTarget),
    remoteRepo: validateAbsolutePath(value.remoteRepo, "remote repository"),
    executables
  }
}

export function newReceipt({ receiptId, prefix, teamGoalId, agentRuns, inputs, createdAtMs = Date.now() }) {
  validateUuid(receiptId, "receipt ID")
  validateUuid(teamGoalId, "Team Goal ID")
  requireCondition(prefix === `omarchestra-remote-spike-${receiptId}`,
    "invalid_receipt", "Receipt prefix must derive exactly from the receipt ID")
  plainObject(agentRuns, "Agent Runs")
  requireCondition(Object.keys(agentRuns).sort().join(",") === [...ROLES].sort().join(","),
    "invalid_receipt", "Receipt must intend exactly three Agent Runs")
  const normalizedAgentRuns = {}
  for (const role of ROLES) {
    normalizedAgentRuns[role] = {
      role,
      id: validateUuid(agentRuns[role], `${role} Agent Run ID`),
      shellId: null,
      shellRunId: null,
      piSessionId: null,
      extensionInstanceId: null,
      pid: null
    }
  }
  requireCondition(Number.isSafeInteger(createdAtMs) && createdAtMs > 0,
    "invalid_receipt", "Receipt creation time is invalid")
  return validateReceipt({
    schema: RECEIPT_SCHEMA,
    receiptId,
    prefix,
    createdAtMs,
    inputs: validateInputs(inputs),
    preflight: null,
    teamGoal: { id: teamGoalId },
    agentRuns: normalizedAgentRuns,
    workspace: null,
    runner: null,
    remotePreflight: null,
    artifacts: [],
    operations: [],
    blocked: null,
    cleanup: null
  })
}

export function validatePreflight(value) {
  plainObject(value, "preflight")
  requireCondition(value.schema === PREFLIGHT_SCHEMA, "invalid_preflight", "Preflight schema is invalid")
  validateUuid(value.receiptId, "preflight receipt ID")
  requireCondition(Number.isSafeInteger(value.capturedAtMs) && value.capturedAtMs > 0,
    "invalid_preflight", "Preflight timestamp is invalid")
  validateAbsolutePath(value.path, "preflight evidence path")
  requireCondition(typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256),
    "invalid_preflight", "Preflight digest is invalid")
  plainObject(value.registration, "preflight registration")
  plainObject(value.baseline, "preflight baseline")
  validateNodeAlias(value.registration.alias)
  validateUuid(value.registration.nodeId, "preflight Node ID")
  validateSshTarget(value.registration.target)
  requireCondition(Number.isSafeInteger(value.registration.revision) && value.registration.revision > 0,
    "invalid_preflight", "Preflight registration revision is invalid")
  requireCondition(value.registration.tombstoneEpoch === null
    || Number.isSafeInteger(value.registration.tombstoneEpoch) && value.registration.tombstoneEpoch >= 0,
  "invalid_preflight", "Preflight registration tombstone epoch is invalid")
  plainObject(value.configuration, "preflight configuration fingerprints")
  // Local fingerprints only: runtime-dependent remote fingerprints are recorded
  // later by record-remote-preflight as their first authority.
  for (const key of ["localSha256", "localIntegrationSha256"]) {
    requireCondition(value.configuration[key] === null
      || typeof value.configuration[key] === "string" && /^[0-9a-f]{64}$/.test(value.configuration[key]),
    "invalid_preflight", `Preflight ${key} is invalid`)
  }
  requireCondition(typeof value.configuration.localConfigPresent === "boolean",
    "invalid_preflight", "Preflight localConfigPresent is invalid")
  requireCondition(Object.keys(value.configuration).sort().join(",")
    === ["localSha256", "localConfigPresent", "localIntegrationSha256"].sort().join(","),
  "invalid_preflight", "Preflight configuration must contain exactly the local fingerprint fields")
  requireCondition(Array.isArray(value.baseline.globalWorkspaceIds)
    && Array.isArray(value.baseline.qualifiedResourceIds),
  "invalid_preflight", "Preflight identity baseline is invalid")
  // Strictly validated execution identity from the raw prerequisite evidence.
  requireCondition(value.execution !== undefined && value.execution !== null, "invalid_preflight",
    "Preflight must bind the execution runtime identity from prerequisite evidence")
  const execution = plainObject(value.execution, "preflight execution")
  requireCondition(Number.isSafeInteger(execution.uid) && execution.uid > 0,
    "unsafe_execution_identity", "Preflight execution UID must be an unprivileged non-root UID")
  validateAbsolutePath(execution.runtimeDirectory, "runtime directory")
  requireCondition(execution.runtimeDirectorySource === "xdg_runtime_dir"
    || execution.runtimeDirectorySource === "derived_linux_uid",
  "invalid_preflight", "Preflight execution runtime directory source is invalid")
  if (execution.runtimeDirectorySource === "derived_linux_uid") {
    requireCondition(execution.runtimeDirectory === `/run/user/${execution.uid}`,
      "identity_mismatch", "A derived Linux runtime directory must equal /run/user/<uid>")
  }
  requireCondition(execution.runtimeMode === "0700", "unsafe_runtime_directory",
    "Preflight execution runtime directory must be mode 0700")
  // The raw noninteractive sudo probe result is bound: 0 would mean a
  // sudo-capable execution identity and must never be accepted.
  requireCondition(execution.sudoExitCode !== undefined, "invalid_preflight",
    "Preflight must bind the raw noninteractive sudo probe exit")
  requireCondition(Number.isSafeInteger(execution.sudoExitCode) && execution.sudoExitCode > 0,
    "sudo_capable", "Preflight execution must record a nonzero sudo -n failure exit")
  return value
}

export function validateReceipt(value) {
  plainObject(value, "receipt")
  requireCondition(value.schema === RECEIPT_SCHEMA, "invalid_receipt", "Receipt schema is invalid")
  validateUuid(value.receiptId, "receipt ID")
  requireCondition(value.prefix === `omarchestra-remote-spike-${value.receiptId}`,
    "invalid_receipt", "Receipt prefix is invalid")
  validateInputs(value.inputs)
  validateUuid(value.teamGoal?.id, "Team Goal ID")
  plainObject(value.agentRuns, "Agent Runs")
  requireCondition(Object.keys(value.agentRuns).sort().join(",") === [...ROLES].sort().join(","),
    "invalid_receipt", "Receipt must contain exactly three roles")
  for (const role of ROLES) {
    const run = plainObject(value.agentRuns[role], `${role} Agent Run`)
    requireCondition(run.role === role, "invalid_receipt", "Agent Run role mismatch")
    validateUuid(run.id, `${role} Agent Run ID`)
    for (const field of ["shellId", "shellRunId", "piSessionId", "extensionInstanceId"]) {
      if (run[field] !== null) validateOpaqueId(run[field], `${role} ${field}`)
    }
    requireCondition(run.pid === null || Number.isSafeInteger(run.pid) && run.pid > 0,
      "invalid_receipt", `${role} PID is invalid`)
  }
  if (value.preflight !== null) validatePreflight(value.preflight)
  requireCondition(value.remotePreflight === null || plainObject(value.remotePreflight, "remote preflight"),
    "invalid_receipt", "Remote preflight record is invalid")
  if (value.remotePreflight !== null) {
    validateRemotePreflight(value.remotePreflight, value.preflight)
  }
  if (value.workspace !== null) validateWorkspace(value.workspace, value.inputs.expectedNodeId)
  if (value.runner !== null) validateRunner(value.runner)
  requireCondition(Array.isArray(value.artifacts) && Array.isArray(value.operations),
    "invalid_receipt", "Receipt collections are invalid")
  for (const operation of value.operations) validateOperation(operation)
  if (value.blocked !== null) {
    plainObject(value.blocked, "receipt block")
    validateOpaqueId(value.blocked.operationId, "blocked operation ID")
  }
  return value
}

function validateWorkspace(workspace, expectedNodeId) {
  plainObject(workspace, "Workspace mapping")
  validateOpaqueId(workspace.globalId, "global Workspace ID")
  requireCondition(workspace.nodeId === expectedNodeId, "invalid_receipt", "Workspace Node changed")
  validateUuid(workspace.nodeId, "Workspace Node ID")
  validateOpaqueId(workspace.ownerId, "owner Workspace ID")
  requireCondition(Array.isArray(workspace.shells), "invalid_receipt", "Workspace Shell mappings are invalid")
  const roles = workspace.shells.map(shell => shell.role).sort()
  requireCondition(roles.join(",") === [...ROLES].sort().join(","),
    "invalid_receipt", "Workspace must map exactly three role Shells")
  const runIds = new Set()
  for (const shell of workspace.shells) {
    validateRole(shell.role)
    validateOpaqueId(shell.id, "Shell ID")
    validateAbsolutePath(shell.cwd, "Shell cwd")
    requireCondition(Array.isArray(shell.argv) && shell.argv.length > 0,
      "invalid_receipt", "Shell argv is missing")
    if (shell.runId !== null) {
      validateOpaqueId(shell.runId, "Shell Run ID")
      requireCondition(!runIds.has(shell.runId), "invalid_receipt", "Shell Run IDs must be unique")
      runIds.add(shell.runId)
    }
  }
}

function validateRunner(runner) {
  plainObject(runner, "runner mapping")
  validateUnitName(runner.unit)
  validateAbsolutePath(runner.socketPath, "runner socket path")
  validateAbsolutePath(runner.statePath, "runner state path")
  requireCondition(runner.pid === null || Number.isSafeInteger(runner.pid) && runner.pid > 0,
    "invalid_receipt", "Runner PID is invalid")
}

function validateOperation(operation) {
  plainObject(operation, "receipt operation")
  validateOpaqueId(operation.id, "operation ID")
  requireCondition(typeof operation.kind === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(operation.kind),
    "invalid_receipt", "Operation kind is invalid")
  requireCondition(OPERATION_STATES.has(operation.state), "invalid_receipt", "Operation state is invalid")
  requireCondition(Number.isSafeInteger(operation.intendedAtMs) && operation.intendedAtMs > 0,
    "invalid_receipt", "Operation intent timestamp is invalid")
  plainObject(operation.intent, "operation intent")
}

export const REMOTE_PREFLIGHT_SCHEMA = "omarchestra.remote-execution-node.remote-preflight/v1"

// Load-time validation of the persisted runtime-dependent remote preflight
// record: schema/keys/types, capability identity, fingerprint types, and exact
// execution equality with the bound preflight.
export function validateRemotePreflight(remotePreflight, preflight) {
  plainObject(remotePreflight, "remote preflight")
  requireCondition(preflight !== null && preflight.execution !== undefined,
    "invalid_receipt", "Remote preflight evidence requires the bound preflight execution identity")
  requireCondition(remotePreflight.schema === REMOTE_PREFLIGHT_SCHEMA, "invalid_receipt",
    "Remote preflight schema is invalid")
  requireCondition(Number.isSafeInteger(remotePreflight.capturedAtMs) && remotePreflight.capturedAtMs > 0,
    "invalid_receipt", "Remote preflight capture time is invalid")
  requireCondition(remotePreflight.uid === preflight.execution.uid, "identity_mismatch",
    "Remote preflight execution UID differs from the bound preflight")
  requireCondition(remotePreflight.runtimeDirectory === preflight.execution.runtimeDirectory,
    "identity_mismatch", "Remote preflight runtime directory differs from the bound preflight")
  validateCapabilities(remotePreflight.capabilities ?? null)
  for (const key of ["remoteSha256", "remoteIntegrationSha256"]) {
    requireCondition(remotePreflight[key] === null
      || typeof remotePreflight[key] === "string" && /^[0-9a-f]{64}$/.test(remotePreflight[key]),
    "invalid_receipt", `Remote preflight ${key} is invalid`)
  }
  requireCondition(typeof remotePreflight.remoteConfigPresent === "boolean",
    "invalid_receipt", "Remote preflight remoteConfigPresent is invalid")
  requireCondition(Object.keys(remotePreflight).sort().join(",")
    === ["schema", "capturedAtMs", "uid", "runtimeDirectory", "capabilities", "remoteSha256",
      "remoteConfigPresent", "remoteIntegrationSha256"].sort().join(","),
  "invalid_receipt", "Remote preflight record contains unexpected fields")
  return remotePreflight
}

export function bindPreflight(receipt, preflight) {
  validateReceipt(receipt)
  validatePreflight(preflight)
  requireCondition(receipt.preflight === null, "preflight_already_bound", "Receipt already has a preflight")
  requireCondition(preflight.receiptId === receipt.receiptId,
    "preflight_mismatch", "Preflight belongs to another receipt")
  requireCondition(preflight.registration.alias === receipt.inputs.nodeAlias
    && preflight.registration.nodeId === receipt.inputs.expectedNodeId
    && preflight.registration.target === receipt.inputs.sshTarget,
  "preflight_mismatch", "Preflight registration does not match the immutable inputs")
  const next = clone(receipt)
  next.preflight = clone(preflight)
  return validateReceipt(next)
}

export function recordRemotePreflight(receipt, evidence) {
  validateReceipt(receipt)
  plainObject(evidence, "remote preflight evidence")
  requireCondition(receipt.preflight !== null, "preflight_required",
    "Remote preflight evidence requires the bound preflight and its derived runtime identity")
  requireCondition(receipt.remotePreflight === null, "mapping_exists",
    "Remote preflight evidence is already recorded")
  requireCondition(Number.isSafeInteger(evidence.capturedAtMs) && evidence.capturedAtMs > 0,
    "invalid_evidence", "Remote preflight capture time is invalid")
  const next = clone(receipt)
  next.remotePreflight = clone(plainObject(evidence, "remote preflight evidence"))
  return validateReceipt(next)
}

export function recordIntent(receipt, { id, kind, intent, atMs = Date.now() }) {
  validateReceipt(receipt)
  requireCondition(receipt.preflight !== null, "preflight_required", "Mutation intent requires bound preflight evidence")
  requireCondition(receipt.blocked === null, "receipt_blocked", "Receipt is blocked by an ambiguous outcome")
  validateOpaqueId(id, "operation ID")
  requireCondition(!receipt.operations.some(operation => operation.id === id),
    "operation_exists", "Operation ID already exists")
  const next = clone(receipt)
  next.operations.push({ id, kind, state: "intended", intendedAtMs: atMs, intent: clone(plainObject(intent, "intent")) })
  return validateReceipt(next)
}

export function markAttempted(receipt, operationId, atMs = Date.now()) {
  return transition(receipt, operationId, "intended", "attempted", { attemptedAtMs: atMs })
}

export function markConfirmed(receipt, operationId, result, atMs = Date.now()) {
  validateReceipt(receipt)
  plainObject(result, "operation result")
  const operation = receipt.operations.find(item => item.id === operationId)
  requireCondition(operation && ["intended", "attempted", "ambiguous"].includes(operation.state),
    "invalid_transition", "Only an intended, attempted, or exactly reconciled ambiguous operation can be confirmed")
  requireCondition(operation.state !== "ambiguous" || result.exactReadback === true,
    "exact_readback_required", "An ambiguous operation requires explicit exact readback evidence")
  const next = clone(receipt)
  const target = next.operations.find(item => item.id === operationId)
  target.state = "confirmed"
  target.confirmedAtMs = atMs
  target.result = clone(plainObject(result, "operation result"))
  if (next.blocked?.operationId === operationId) next.blocked = null
  return validateReceipt(next)
}

export function markAmbiguous(receipt, operationId, reason, atMs = Date.now()) {
  validateReceipt(receipt)
  const operation = receipt.operations.find(item => item.id === operationId)
  requireCondition(operation && ["intended", "attempted"].includes(operation.state),
    "invalid_transition", "Only an intended or attempted operation can become ambiguous")
  const next = clone(receipt)
  const target = next.operations.find(item => item.id === operationId)
  target.state = "ambiguous"
  target.ambiguousAtMs = atMs
  target.reason = String(reason)
  next.blocked = { operationId, reason: String(reason), atMs }
  return validateReceipt(next)
}

function transition(receipt, operationId, from, to, fields) {
  validateReceipt(receipt)
  const operation = receipt.operations.find(item => item.id === operationId)
  requireCondition(operation?.state === from, "invalid_transition", `Operation must be ${from}`)
  const next = clone(receipt)
  Object.assign(next.operations.find(item => item.id === operationId), { state: to, ...fields })
  return validateReceipt(next)
}

export function recordWorkspace(receipt, { globalId, nodeId, ownerId, shells }) {
  validateReceipt(receipt)
  requireCondition(receipt.workspace === null, "mapping_exists", "Workspace mapping already exists")
  const next = clone(receipt)
  next.workspace = { globalId, nodeId, ownerId, shells: clone(shells) }
  for (const shell of shells) next.agentRuns[shell.role].shellId = shell.id
  return validateReceipt(next)
}

export function recordShellRun(receipt, role, runId) {
  validateReceipt(receipt)
  validateRole(role)
  validateOpaqueId(runId, "Shell Run ID")
  const next = clone(receipt)
  const shell = next.workspace?.shells.find(item => item.role === role)
  requireCondition(shell, "mapping_missing", "Role Shell mapping is missing")
  const prior = shell.runId
  requireCondition(prior === null || prior === runId, "run_changed",
    "Shell Run changed from the receipt-owned Run", { role, expectedRunId: prior, observedRunId: runId })
  shell.runId = runId
  next.agentRuns[role].shellRunId = runId
  return validateReceipt(next)
}

export function recordRunner(receipt, runner) {
  validateReceipt(receipt)
  requireCondition(receipt.runner === null, "mapping_exists", "Runner mapping already exists")
  const next = clone(receipt)
  next.runner = clone(runner)
  return validateReceipt(next)
}

export class MemoryReceiptStore {
  constructor(initial = null) {
    this.value = initial === null ? null : clone(validateReceipt(initial))
  }
  async load() { return this.value === null ? null : clone(this.value) }
  async initialize(value) {
    requireCondition(this.value === null, "receipt_exists", "Receipt already exists")
    this.value = clone(validateReceipt(value))
    return this.load()
  }
  async replace(value) {
    requireCondition(this.value !== null, "receipt_missing", "Receipt does not exist")
    this.value = clone(validateReceipt(value))
    return this.load()
  }
  async update(mutator) {
    const current = await this.load()
    requireCondition(current !== null, "receipt_missing", "Receipt does not exist")
    const next = clone(current)
    await mutator(next)
    return this.replace(next)
  }
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null
}

export class FileReceiptStore {
  constructor(filePath, { uid = currentUid() } = {}) {
    this.filePath = path.resolve(filePath)
    this.uid = uid
  }
  async load() {
    try {
      const metadata = await lstat(this.filePath)
      requireCondition(metadata.isFile() && !metadata.isSymbolicLink(),
        "unsafe_receipt", "Receipt path is not a regular nonsymlink file")
      if (metadata.uid !== undefined && Number.isSafeInteger(this.uid)) {
        requireCondition(metadata.uid === this.uid,
          "unsafe_receipt", "Receipt file is not owned by the current UID")
      }
      requireCondition((metadata.mode & 0o777) === 0o600,
        "unsafe_receipt", "Receipt file must be mode 0600")
      return validateReceipt(JSON.parse(await readFile(this.filePath, "utf8")))
    } catch (error) {
      if (error?.code === "ENOENT") return null
      if (error instanceof SyntaxError) throw spikeError("invalid_receipt", "Receipt JSON is malformed")
      throw error
    }
  }
  async initialize(value) {
    requireCondition(await this.load() === null, "receipt_exists", "Receipt already exists")
    await this.#write(validateReceipt(value), true)
    return this.load()
  }
  async replace(value) {
    requireCondition(await this.load() !== null, "receipt_missing", "Receipt does not exist")
    await this.#write(validateReceipt(value), false)
    return this.load()
  }
  async update(mutator) {
    const current = await this.load()
    requireCondition(current !== null, "receipt_missing", "Receipt does not exist")
    await mutator(current)
    return this.replace(current)
  }
  async #write(value, exclusive) {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (exclusive) {
      const handle = await open(this.filePath, "wx", 0o600)
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
      finally { await handle.close() }
      const directoryHandle = await open(directory, "r")
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      return
    }
    const temporary = `${this.filePath}.${process.pid}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
    finally { await handle.close() }
    try { await rename(temporary, this.filePath) }
    catch (error) { await rm(temporary, { force: true }); throw error }
    const directoryHandle = await open(directory, "r")
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  }
}
