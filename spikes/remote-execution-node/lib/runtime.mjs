import { boomuxCommands } from "./commands.mjs"
import { resultFromExecution } from "./envelopes.mjs"
import { isSpikeError, requireCondition, spikeError } from "./errors.mjs"
import { ROLES, plainObject, validateNodeAlias, validateOpaqueId, validateUuid } from "./validation.mjs"

export const REQUIRED_CLI_VERSION = "1.8.0"
export const REQUIRED_PROTOCOL = 49
export const REQUIRED_JSON_COMMANDS = Object.freeze([
  "capabilities", "daemon.status", "node.list", "node.inspect", "node.snapshot",
  "workspace.list", "workspace.inspect", "shell.inspect", "events"
])
export const REQUIRED_FEATURES = Object.freeze([
  "typed_errors", "pinned_node_identity", "combined_node_snapshot", "node_projection_sync",
  "remote_pty_attachment", "owner_environment_attachment", "global_workspaces",
  "multi_node_workspace_placements", "shell_run_identity", "reconnectable_event_cursors", "protocol_49"
])
export const REQUIRED_ERRORS = Object.freeze([
  "not_found", "cursor_expired", "run_changed", "node_identity_changed", "unknown"
])

const array = (value, label) => {
  requireCondition(Array.isArray(value), "invalid_response", `${label} must be an array`)
  return value
}
const string = (value, label) => {
  requireCondition(typeof value === "string" && value.length > 0,
    "invalid_response", `${label} must be a nonempty string`)
  return value
}
const exactArray = (left, right) => Array.isArray(left) && left.length === right.length
  && left.every((value, index) => value === right[index])

export class PublicBoomuxClient {
  constructor(executor) {
    requireCondition(executor && typeof executor.run === "function",
      "invalid_executor", "Boomux client requires an argv executor")
    this.executor = executor
  }
  async json(argv, command) {
    return resultFromExecution(await this.executor.run(argv), command)
  }
  async weak(argv, label) {
    const result = await this.executor.run(argv)
    if (result.exitCode === 0) return result
    throw spikeError("outcome_unknown", `Weak Boomux ${label} did not confirm its outcome`, {
      label, exitCode: result.exitCode
    })
  }
}

export function validateCapabilities(data) {
  plainObject(data, "capabilities data")
  requireCondition(data.cli_version === REQUIRED_CLI_VERSION,
    "version_mismatch", `Boomux CLI must be ${REQUIRED_CLI_VERSION}`)
  requireCondition(data.daemon_protocol_version === REQUIRED_PROTOCOL,
    "protocol_mismatch", `Boomux protocol must be ${REQUIRED_PROTOCOL}`)
  requireCondition(array(data.json_schemas, "JSON schemas").includes("boomux.cli/v1"),
    "schema_mismatch", "Boomux does not advertise boomux.cli/v1")
  const commands = array(data.json_commands, "JSON commands")
  const features = array(data.features, "features")
  const errors = array(data.error_codes, "error codes")
  const missingCommands = REQUIRED_JSON_COMMANDS.filter(value => !commands.includes(value))
  const missingFeatures = REQUIRED_FEATURES.filter(value => !features.includes(value))
  const missingErrors = REQUIRED_ERRORS.filter(value => !errors.includes(value))
  requireCondition(missingCommands.length === 0 && missingFeatures.length === 0 && missingErrors.length === 0,
    "capability_unavailable", "Boomux public contract is incomplete", {
      missingCommands, missingFeatures, missingErrors
    })
  return data
}

export function reconcileNodeIdentity({ registrationData, snapshotData, alias, expectedNodeId, sshTarget }) {
  validateNodeAlias(alias)
  validateUuid(expectedNodeId, "expected Node ID")
  const registration = plainObject(registrationData.registration ?? registrationData,
    "Node registration")
  requireCondition(registration.alias === alias && registration.node_id === expectedNodeId
    && registration.target === sshTarget,
  "node_identity_changed", "Node registration no longer matches the pinned CLI inputs")
  requireCondition(Number.isSafeInteger(registration.revision) && registration.revision > 0,
    "invalid_response", "Node registration revision is invalid")
  const matches = array(snapshotData.nodes, "Node snapshot").filter(node =>
    node?.node_id === expectedNodeId && node.alias === alias && node.local === false)
  requireCondition(matches.length === 1, "node_identity_changed",
    "Combined snapshot did not return one exact registered remote Node")
  const node = matches[0]
  requireCondition(node.health === "online" && node.current === true && node.stale === false,
    "node_unavailable", "Pinned Node is not current and online")
  requireCondition(node.observed_protocol_version === REQUIRED_PROTOCOL,
    "protocol_mismatch", "Pinned Node did not advertise protocol 49")
  const capabilities = array(node.observed_capabilities, "observed Node capabilities")
  for (const capability of ["remote_pty_attachment", "owner_environment_attachment", "global_workspaces"]) {
    requireCondition(capabilities.includes(capability), "capability_unavailable",
      `Pinned Node lacks ${capability}`)
  }
  return {
    alias,
    nodeId: expectedNodeId,
    target: sshTarget,
    revision: registration.revision,
    tombstoneEpoch: registration.tombstone_epoch ?? null,
    observedAtMs: node.observed_at_ms,
    capabilities: [...capabilities]
  }
}

export class RemoteExecutionRuntime {
  constructor({ boomux }) {
    requireCondition(boomux && typeof boomux.json === "function" && typeof boomux.weak === "function",
      "invalid_runtime", "Runtime requires a public Boomux client")
    this.boomux = boomux
  }

  async capabilities() {
    const capabilities = validateCapabilities(await this.boomux.json(
      boomuxCommands.capabilities(), "capabilities"))
    const status = await this.boomux.json(boomuxCommands.daemonStatus(), "daemon.status")
    requireCondition(status.status === "running" && status.protocol_version === REQUIRED_PROTOCOL,
      "daemon_unavailable", "Local Boomux daemon must already be running at protocol 49")
    return { capabilities, status }
  }

  async reconcileNode(inputs) {
    const [registration, snapshot] = await Promise.all([
      this.boomux.json(boomuxCommands.nodeInspect(inputs.nodeAlias), "node.inspect"),
      this.boomux.json(boomuxCommands.nodeSnapshot(inputs.nodeAlias), "node.snapshot")
    ])
    return reconcileNodeIdentity({
      registrationData: registration,
      snapshotData: snapshot,
      alias: inputs.nodeAlias,
      expectedNodeId: inputs.expectedNodeId,
      sshTarget: inputs.sshTarget
    })
  }

  async preflight(inputs) {
    const [{ capabilities, status }, registration, snapshot, workspaces, events] = await Promise.all([
      this.capabilities(),
      this.boomux.json(boomuxCommands.nodeInspect(inputs.nodeAlias), "node.inspect"),
      this.boomux.json(boomuxCommands.nodeSnapshot(inputs.nodeAlias), "node.snapshot"),
      this.boomux.json(boomuxCommands.workspaceList(), "workspace.list"),
      this.boomux.json(boomuxCommands.events(), "events")
    ])
    const node = reconcileNodeIdentity({ registrationData: registration, snapshotData: snapshot,
      alias: inputs.nodeAlias, expectedNodeId: inputs.expectedNodeId, sshTarget: inputs.sshTarget })
    const page = normalizeEventPage(events, { baseline: true })
    return {
      capabilities,
      daemonStatus: status,
      registration: node,
      nodeSnapshot: snapshot,
      workspaceSnapshot: workspaces,
      eventBaseline: page,
      baseline: baselineIdentitySet(snapshot, workspaces)
    }
  }

  async events(cursor, { waitMs = 0 } = {}) {
    try {
      const data = await this.boomux.json(boomuxCommands.events({ after: cursor, waitMs }), "events")
      return normalizeEventPage(data, { baseline: cursor === null })
    } catch (error) {
      if (cursor === null || !isSpikeError(error, "cursor_expired")) throw error
      const data = await this.boomux.json(boomuxCommands.events({ waitMs }), "events")
      const page = normalizeEventPage(data, { baseline: true })
      return { ...page, gap: true, gapReason: "cursor_expired" }
    }
  }
}

export function normalizeEventPage(data, { baseline = false } = {}) {
  plainObject(data, "event page")
  const cursor = string(data.cursor, "event cursor")
  requireCondition(/^[A-Za-z0-9._-]+:[0-9]+$/.test(cursor),
    "invalid_response", "Boomux event cursor is invalid")
  const events = array(data.events, "events")
  let previous = 0
  for (const event of events) {
    plainObject(event, "event")
    requireCondition(Number.isSafeInteger(event.id) && event.id > previous,
      "event_order", "Boomux event IDs must increase strictly")
    previous = event.id
  }
  if (baseline) plainObject(data.snapshot, "event baseline snapshot")
  return {
    cursor,
    baseline,
    gap: false,
    snapshot: data.snapshot ?? null,
    events: structuredClone(events)
  }
}

export function classifyPresentation(beforeInput, afterInput) {
  const before = normalizeShell(beforeInput)
  const after = normalizeShell(afterInput)
  requireCondition(before.id === after.id && before.workspaceId === after.workspaceId,
    "identity_mismatch", "Presentation readback addressed a different Shell")
  if (before.status === "exited") {
    return { supported: false, classification: "refused_exited_run", atomicExpectedRunGuarantee: false }
  }
  if (after.status !== "running" || after.runId === null) {
    return { supported: false, classification: "presentation_unconfirmed", atomicExpectedRunGuarantee: false }
  }
  if (before.status === "pending") {
    return { supported: true, classification: "initial_run_started", runId: after.runId,
      atomicExpectedRunGuarantee: false }
  }
  if (before.runId === after.runId) {
    return { supported: true, classification: "same_run_observed", runId: after.runId,
      atomicExpectedRunGuarantee: false }
  }
  return {
    supported: false,
    classification: "run_replaced_during_generic_open",
    expectedRunId: before.runId,
    observedRunId: after.runId,
    atomicExpectedRunGuarantee: false,
    outcomeUncertain: true
  }
}

export function normalizeShell(shell) {
  plainObject(shell, "Shell")
  const id = innerId(shell.id ?? shell.shell_id, "Shell ID")
  const workspaceId = innerId(shell.workspace_id, "Shell Workspace ID")
  requireCondition(["pending", "running", "exited"].includes(shell.status),
    "invalid_response", "Shell status is invalid")
  const run = shell.run ?? null
  if (shell.status === "running" || shell.status === "exited") plainObject(run, "Shell Run")
  return {
    id,
    workspaceId,
    name: string(shell.name, "Shell name"),
    cwd: shell.cwd ?? null,
    argv: shell.command ?? null,
    status: shell.status,
    runId: run === null ? null : innerId(run.id, "Shell Run ID"),
    generation: run?.generation ?? null
  }
}

export function resolveWorkspaceCreation({ prefix, beforeWorkspaceIds, afterWorkspaceList }) {
  const before = new Set(array(beforeWorkspaceIds, "preflight Workspace IDs"))
  const workspaces = array(afterWorkspaceList.workspaces, "Workspace list")
  const candidates = workspaces.filter(workspace => workspace?.name === prefix && !before.has(workspace.id))
  requireCondition(candidates.length === 1, "outcome_unknown",
    "Workspace creation could not be resolved to one new JSON identity")
  const workspace = candidates[0]
  validateOpaqueId(workspace.id, "global Workspace ID")
  requireCondition(workspace.closing === false && array(workspace.placements ?? [], "Workspace placements").length === 0,
    "postcondition_failed", "New empty Workspace has an unexpected state")
  return { globalId: workspace.id, revision: workspace.revision, name: workspace.name }
}

export function resolveShellCreation({ role, name, expectedCwd, expectedArgv, expectedNodeId,
  expectedOwnerWorkspaceId = null, knownShellIds = [], ownerSnapshot, shellInspection }) {
  requireCondition(ROLES.includes(role), "invalid_role", "Role is invalid")
  const owner = selectOwnerWorkspace(ownerSnapshot, expectedNodeId, expectedOwnerWorkspaceId)
  const resources = ownerResources(owner, expectedNodeId)
  const known = new Set(knownShellIds)
  const candidates = resources.shells.filter(shell => shell.name === name && !known.has(shell.id))
  requireCondition(candidates.length === 1, "outcome_unknown",
    "Shell creation could not be resolved to one new JSON identity")
  const candidate = candidates[0]
  const inspected = normalizeShell(shellInspection.shell ?? shellInspection)
  requireCondition(inspected.id === candidate.id && inspected.workspaceId === owner.id
    && inspected.status === "pending" && inspected.runId === null
    && inspected.cwd === expectedCwd && exactArray(inspected.argv, expectedArgv),
  "postcondition_failed", "Created Shell does not match the intended exact specification")
  requireCondition(resources.shells.every(shell => shell.id === candidate.id || known.has(shell.id)),
    "foreign_resource", "Owner Workspace contains an unrecorded Shell")
  requireCondition(resources.launchers.length === 0 && resources.agents.length === 0,
    "foreign_resource", "Owner Workspace contains an unrecorded Launcher or Agent")
  return { role, id: candidate.id, ownerId: owner.id, cwd: expectedCwd, argv: [...expectedArgv], runId: null }
}

export function exactCleanupPlan(receipt, {
  coordinatorSnapshot, ownerSnapshot, shellInspections, nodeIdentity
}) {
  requireCondition(receipt.preflight !== null, "preflight_required", "Cleanup requires bound preflight evidence")
  requireCondition(receipt.blocked === null, "receipt_blocked", "Cleanup refuses an ambiguous receipt")
  requireCondition(receipt.workspace !== null && receipt.runner !== null,
    "ownership_uncertain", "Cleanup receipt lacks Workspace or runner ownership")
  requireCondition(nodeIdentity.nodeId === receipt.inputs.expectedNodeId
    && nodeIdentity.alias === receipt.inputs.nodeAlias
    && nodeIdentity.target === receipt.inputs.sshTarget,
  "node_identity_changed", "Cleanup Node identity differs from the receipt")
  const globalMatches = array(coordinatorSnapshot.workspaces, "coordinator Workspaces")
    .filter(workspace => workspace?.id === receipt.workspace.globalId)
  requireCondition(globalMatches.length === 1 && globalMatches[0].name === receipt.prefix
    && globalMatches[0].closing === false,
  "ownership_uncertain", "Cleanup global Workspace mapping changed or disappeared")
  const placements = array(globalMatches[0].placements, "global Workspace placements")
  requireCondition(placements.length === 1
    && placements[0].node_id === receipt.inputs.expectedNodeId
    && (placements[0].workspace_id ?? placements[0].owner_workspace_id) === receipt.workspace.ownerId
    && placements[0].state === "active",
  "foreign_resource", "Cleanup refuses a changed or additional Workspace placement")
  const owner = selectOwnerWorkspace(ownerSnapshot, receipt.inputs.expectedNodeId, receipt.workspace.ownerId)
  const resources = ownerResources(owner, receipt.inputs.expectedNodeId)
  const expectedShells = new Map(receipt.workspace.shells.map(shell => [shell.id, shell]))
  requireCondition(expectedShells.size === 3 && resources.shells.length === 3,
    "foreign_resource", "Cleanup requires exactly the three receipt-owned Shells")
  requireCondition(resources.launchers.length === 0 && resources.agents.length === 0,
    "foreign_resource", "Cleanup refuses foreign Launchers or Agents")
  for (const observed of resources.shells) {
    const expected = expectedShells.get(observed.id)
    requireCondition(expected, "foreign_resource", "Cleanup refuses an unrecorded Shell")
    const inspection = normalizeShell(shellInspections[observed.id]?.shell ?? shellInspections[observed.id])
    requireCondition(inspection.id === expected.id && inspection.workspaceId === receipt.workspace.ownerId,
      "ownership_uncertain", "Shell inspection does not match the receipt")
    if (expected.runId !== null) requireCondition(inspection.runId === expected.runId,
      "run_changed", "Cleanup refuses a changed Shell Run", {
        shellId: expected.id, expectedRunId: expected.runId, observedRunId: inspection.runId
      })
  }
  return {
    shellIds: receipt.workspace.shells.map(shell => shell.id),
    ownerWorkspaceId: receipt.workspace.ownerId,
    globalWorkspaceId: receipt.workspace.globalId,
    runner: structuredClone(receipt.runner),
    socketPath: receipt.runner.socketPath,
    statePath: receipt.runner.statePath
  }
}

export function verifyCleanupPostconditions(receipt, {
  workspaceList, nodeSnapshot, runner, remoteFiles, registration, configuration
}) {
  const baselineRegistration = receipt.preflight.registration
  requireCondition(registration.alias === baselineRegistration.alias
    && registration.nodeId === baselineRegistration.nodeId
    && registration.target === baselineRegistration.target
    && registration.revision === baselineRegistration.revision
    && registration.tombstoneEpoch === baselineRegistration.tombstoneEpoch,
  "identity_preservation_failed", "Node registration changed from the bound preflight")
  requireCondition(configuration.localSha256 === receipt.preflight.configuration.localSha256
    && configuration.localConfigPresent === receipt.preflight.configuration.localConfigPresent
    && configuration.localIntegrationSha256 === receipt.preflight.configuration.localIntegrationSha256,
  "identity_preservation_failed", "Boomux local configuration changed from the bound preflight")
  // Remote fingerprints are compared against the recorded remote preflight
  // evidence, their sole authority.
  const remotePreflight = receipt.remotePreflight
  requireCondition(remotePreflight !== null, "remote_preflight_required",
    "Postconditions require the recorded runtime-dependent remote preflight evidence")
  requireCondition(configuration.remoteSha256 === remotePreflight.remoteSha256
    && configuration.remoteConfigPresent === remotePreflight.remoteConfigPresent
    && configuration.remoteIntegrationSha256 === remotePreflight.remoteIntegrationSha256,
  "identity_preservation_failed", "Boomux remote configuration/integrations changed from the recorded remote preflight")
  requireCondition(!array(workspaceList.workspaces, "postflight Workspaces")
    .some(workspace => workspace.id === receipt.workspace.globalId),
  "cleanup_postcondition_failed", "Global Workspace remains after cleanup")
  const ids = collectQualifiedIds(nodeSnapshot)
  for (const shell of receipt.workspace.shells) {
    requireCondition(!ids.has(`${receipt.inputs.expectedNodeId}:${shell.id}`),
      "cleanup_postcondition_failed", "Receipt-owned Shell remains after cleanup")
  }
  requireCondition(runner.unitAbsent === true && runner.pidAbsent === true,
    "cleanup_postcondition_failed", "Runner unit or process remains after cleanup")
  requireCondition(remoteFiles.socketAbsent === true && remoteFiles.stateAbsent === true,
    "cleanup_postcondition_failed", "Runner socket or state remains after cleanup")
  const baseline = receipt.preflight.baseline
  const currentGlobal = new Set(array(workspaceList.workspaces, "postflight Workspaces").map(item => item.id))
  for (const id of baseline.globalWorkspaceIds) requireCondition(currentGlobal.has(id),
    "identity_preservation_failed", "A pre-existing global Workspace disappeared")
  for (const id of baseline.qualifiedResourceIds) requireCondition(ids.has(id),
    "identity_preservation_failed", "A pre-existing Node-qualified resource disappeared")
  return { cleaned: true, preserved: true }
}

export function baselineIdentitySet(nodeSnapshot, workspaceList) {
  return {
    globalWorkspaceIds: array(workspaceList.workspaces ?? [], "Workspaces").map(item => item.id).sort(),
    qualifiedResourceIds: [...collectQualifiedIds(nodeSnapshot)].sort()
  }
}

function collectQualifiedIds(snapshot) {
  const result = new Set()
  for (const node of array(snapshot.nodes ?? [], "Nodes")) {
    const nodeId = node.node_id
    if (typeof nodeId !== "string") continue
    const payload = node.local_snapshot ?? node.remote_projection
    for (const workspace of payload?.workspaces ?? []) {
      const workspaceId = innerId(workspace.id, "Workspace ID")
      result.add(`${nodeId}:${workspaceId}`)
      for (const collection of [workspace.shells ?? [], workspace.launchers ?? [], workspace.agents ?? []]) {
        for (const item of collection) result.add(`${nodeId}:${innerId(item.id, "resource ID")}`)
      }
    }
  }
  return result
}

function selectOwnerWorkspace(snapshot, expectedNodeId, expectedOwnerId) {
  const nodes = array(snapshot.nodes, "owner Node snapshot")
  const matches = nodes.filter(node => node?.node_id === expectedNodeId && node.local === true
    && node.current === true && node.stale === false && node.health === "online")
  requireCondition(matches.length === 1, "node_identity_changed",
    "Direct owner snapshot did not return the exact current Node")
  const workspaces = array(matches[0].local_snapshot?.workspaces, "owner Workspaces")
  const selected = expectedOwnerId === null
    ? workspaces
    : workspaces.filter(workspace => innerId(workspace.id, "owner Workspace ID") === expectedOwnerId)
  requireCondition(selected.length === 1, "ownership_uncertain",
    "Owner Workspace is absent or ambiguous")
  return { ...selected[0], id: innerId(selected[0].id, "owner Workspace ID") }
}

function ownerResources(owner, nodeId) {
  const shells = array(owner.shells ?? [], "owner Shells").map(shell => ({
    ...shell,
    id: qualifiedInner(shell.id, nodeId, "Shell ID"),
    name: string(shell.name, "Shell name")
  }))
  return {
    shells,
    launchers: array(owner.launchers ?? [], "owner Launchers"),
    agents: array(owner.agents ?? [], "owner Agents")
  }
}

function innerId(value, label) {
  if (typeof value === "string") return validateOpaqueId(value, label)
  plainObject(value, label)
  return validateOpaqueId(value.inner_id, label)
}

function qualifiedInner(value, nodeId, label) {
  if (typeof value === "string") return validateOpaqueId(value, label)
  plainObject(value, label)
  requireCondition(value.node_id === nodeId, "identity_mismatch", `${label} belongs to another Node`)
  return validateOpaqueId(value.inner_id, label)
}
