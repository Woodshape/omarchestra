import { readFile } from "node:fs/promises"

import { requireCondition, spikeError } from "./errors.mjs"
import {
  bindPreflight,
  markAmbiguous,
  markAttempted,
  markConfirmed,
  newReceipt,
  recordIntent,
  recordRemotePreflight,
  recordRunner,
  recordShellRun,
  recordWorkspace,
  validatePreflight
} from "./receipt.mjs"
import {
  normalizeShell,
  validateCapabilities,
  resolveShellCreation,
  resolveWorkspaceCreation
} from "./runtime.mjs"
import { parseErrorEnvelope } from "./envelopes.mjs"
import {
  ROLES,
  plainObject,
  validateAbsolutePath,
  validateOpaqueId,
  validateUnitName,
  validateUnixSocketPath
} from "./validation.mjs"

// ManualGate is the receipt-backed manual gate boundary. No mutation, presentation,
// or cleanup plan is authorized unless an owner-only durable receipt exists, its
// immutable inputs are satisfied (verified against the current invocation), its
// preflight is bound, and every required prior exact mapping or confirmed
// operation is present. Operation intent is persisted before any live command
// plan is emitted, identical-intent replay is idempotent, changed-intent replay
// is refused, attempted/ambiguous operations must be explicitly reconciled, and
// an ambiguous outcome blocks all later plans for the lifetime of the receipt.
export class ManualGate {
  constructor(store) {
    requireCondition(store && typeof store.load === "function" && typeof store.initialize === "function"
      && typeof store.replace === "function" && typeof store.update === "function",
    "invalid_gateway", "Manual gate requires a durable receipt store")
    this.store = store
  }

  async receipt() {
    const receipt = await this.store.load()
    requireCondition(receipt !== null, "receipt_missing",
      "Owner receipt must be initialized before this manual gate step")
    return receipt
  }

  // Compares the full immutable receipt input set plus receipt/team identity with
  // the current invocation before any receipt-backed action records intent or
  // prints a plan. Authority-bearing values are read from the returned receipt.
  async receiptForInvocation({ receiptId, teamGoalId, inputs } = {}) {
    const receipt = await this.receipt()
    if (receiptId !== undefined && receiptId !== null) {
      requireCondition(receipt.receiptId === receiptId, "identity_mismatch",
        "The invocation receipt ID differs from the durable receipt")
    }
    if (teamGoalId !== undefined && teamGoalId !== null) {
      requireCondition(receipt.teamGoal.id === teamGoalId, "identity_mismatch",
        "The invocation Team Goal ID differs from the durable receipt")
    }
    if (inputs !== undefined && inputs !== null) {
      const stored = receipt.inputs
      plainObject(inputs, "invocation inputs")
      for (const key of ["nodeAlias", "expectedNodeId", "sshTarget", "remoteRepo"]) {
        requireCondition(inputs[key] === stored[key], "identity_mismatch",
          `Invocation ${key} differs from the immutable receipt inputs`)
      }
      plainObject(inputs.executables ?? {}, "invocation executables")
      for (const key of Object.keys(stored.executables)) {
        requireCondition(inputs.executables?.[key] === stored.executables[key], "identity_mismatch",
          `Invocation executable ${key} differs from the immutable receipt inputs`)
      }
    }
    return receipt
  }

  async initializeReceipt({ receiptId, prefix, teamGoalId, agentRuns, inputs, createdAtMs }) {
    requireCondition(await this.store.load() === null, "receipt_exists",
      "Owner receipt already exists; refuse to reinitialize")
    await this.store.initialize(newReceipt({ receiptId, prefix, teamGoalId, agentRuns, inputs, createdAtMs }))
    return this.store.load()
  }

  async bindPreflightEvidence(evidenceFilePath) {
    const document = readEvidenceDocument(await readEvidenceFile(evidenceFilePath), "preflight evidence path")
    const preflight = validatePreflight(document)
    await this.receipt()
    return this.#mutate(receipt => bindPreflight(receipt, preflight))
  }

  // Records the post-bind, runtime-dependent remote Boomux preflight evidence
  // (raw capability/daemon JSON parsed and validated here, plus the remote
  // config/integration fingerprints that must agree with the bound preflight).
  // Every mutation stays unprintable until this is recorded.
  async recordRemotePreflight(evidenceSource) {
    const receipt = await this.receipt()
    requireCondition(receipt.preflight !== null, "preflight_required",
      "Remote preflight evidence requires the bound preflight and its derived runtime identity")
    requireCondition(receipt.remotePreflight === null, "mapping_exists",
      "Remote preflight evidence is already recorded")
    const document = plainObject(
      readEvidenceDocument(await readEvidenceFile(evidenceSource), "remote preflight evidence path"),
      "remote preflight evidence")
    const capabilities = validateCapabilities(plainObject(document.capabilities ?? null, "remote capabilities data")
      ? document.capabilities : null)
    const daemonStatus = plainObject(document.daemonStatus ?? null, "remote daemon status")
    requireCondition(daemonStatus.status === "running" && daemonStatus.protocol_version === 49,
      "capability_unavailable", "The remote Boomux daemon must be running at protocol 49")
    // The remote config/integration fingerprints recorded here are their first
    // authority: the bound preflight deliberately keeps only local fingerprints.
    for (const key of ["remoteSha256", "remoteIntegrationSha256"]) {
      requireCondition(document[key] === null
        || typeof document[key] === "string" && /^[0-9a-f]{64}$/.test(document[key]),
      "invalid_evidence", `Remote preflight ${key} is invalid`)
    }
    requireCondition(typeof document.remoteConfigPresent === "boolean",
      "invalid_evidence", "Remote preflight remoteConfigPresent is invalid")
    const bound = receipt.preflight.execution
    return this.#mutate(current => recordRemotePreflight(current, {
      schema: "omarchestra.remote-execution-node.remote-preflight/v1",
      capturedAtMs: Date.now(),
      uid: bound.uid,
      runtimeDirectory: bound.runtimeDirectory,
      capabilities: JSON.parse(JSON.stringify(capabilities)),
      remoteSha256: document.remoteSha256,
      remoteConfigPresent: document.remoteConfigPresent,
      remoteIntegrationSha256: document.remoteIntegrationSha256
    }))
  }

  // Records one mutation intent before the caller may print a live command plan.
  // Intent equality makes idempotent replay safe; anything else is refused.
  async planOperation(operation, invocation) {
    validateOperationDescription(operation)
    await this.receiptForInvocation(invocation)
    return this.#mutate(receipt => this.#appendIntent(receipt, operation))
  }

  async planWorkspaceCreate({ operationId, name }, invocation) {
    return this.planOperation({ id: operationId, kind: "workspace_create", intent: { name } }, invocation)
  }

  // Resolves the global Workspace ID only from the confirmed exact readback in the
  // receipt; CLI-supplied resource IDs are never trusted.
  async planShellCreates(shellSpecifications, invocation) {
    plainObjectSpecification(shellSpecifications)
    const receipt = await this.receiptForInvocation(invocation)
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    requireCondition(receipt.preflight !== null, "preflight_required",
      "Shell creation requires the bound preflight evidence")
    const workspaceReadback = findOperation(receipt, "workspace-create")
    requireCondition(workspaceReadback?.state === "confirmed"
      && typeof workspaceReadback.result?.globalWorkspaceId === "string",
    "operation_pending", "Confirm the exact Workspace readback before creating Shells")
    const globalWorkspaceId = validateOpaqueId(workspaceReadback.result.globalWorkspaceId, "global Workspace ID")
    requireCondition(receipt.workspace === null, "mapping_exists",
      "Workspace mapping is already recorded")
    await this.#mutate(current => {
      let next = current
      for (const specification of shellSpecifications) {
        next = this.#appendIntent(next, {
          id: `shell-create-${specification.role}`,
          kind: "shell_create",
          intent: { role: specification.role, name: specification.name, cwd: specification.cwd,
            argv: [...specification.argv] }
        })
      }
      return next
    })
    return { receipt: await this.receipt(), globalWorkspaceId }
  }

  // Records one Shell creation readback from raw public JSON evidence (the owner
  // Node snapshot and the exact `boomux shell inspect` document) through the
  // shared strict resolver. A self-asserted normalized ID is not accepted.
  async recordShellCreation({ role, evidenceSource, expected }) {
    validateRole(role)
    const receipt = await this.receipt()
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    const operation = findOperation(receipt, `shell-create-${role}`)
    requireCondition(operation !== null, "operation_missing",
      `The ${role} Shell creation readback requires its durable creation intent`)
    requireAttempted(operation, `shell-create-${role}`)
    const evidence = plainObject(await this.#readEvidence(evidenceSource, "shell creation evidence path"),
      "shell creation evidence")
    requireCondition(plainObject(evidence.ownerSnapshot ?? null) && plainObject(evidence.shellInspection ?? null),
      "invalid_evidence",
      "Shell creation evidence must carry the raw owner Node snapshot and the exact Shell inspection JSON")
    const knownShellIds = ROLES
      .filter(other => other !== role)
      .map(other => findOperation(receipt, `shell-create-${other}`))
      .filter(item => item?.state === "confirmed")
      .map(item => item.result.shellId)
    const resolution = resolveShellCreation({
      role,
      name: expected.name,
      expectedCwd: expected.cwd,
      expectedArgv: expected.argv,
      expectedNodeId: receipt.inputs.expectedNodeId,
      knownShellIds,
      ownerSnapshot: evidence.ownerSnapshot,
      shellInspection: evidence.shellInspection
    })
    const result = {
      exactReadback: true,
      shellId: resolution.id,
      ownerId: resolution.ownerId,
      cwd: resolution.cwd,
      argv: resolution.argv,
      runId: null,
      resolvedFrom: "boomux.node.snapshot+shell.inspect"
    }
    return this.#mutate(receipt => markConfirmed(receipt, `shell-create-${role}`, result))
  }

  // An empty created Workspace has zero placements, so its exact readback proves
  // only the global Workspace ID. The owner Workspace ID is established later,
  // from the three Shell creation readbacks and the single remote placement.
  async recordWorkspaceCreation(evidenceSource) {
    const receipt = await this.receipt()
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    const operation = findOperation(receipt, "workspace-create")
    requireCondition(operation !== null, "operation_missing",
      "The Workspace creation readback requires its durable creation intent")
    requireAttempted(operation, "workspace-create")
    const evidence = plainObject(await this.#readEvidence(evidenceSource, "workspace creation evidence path"),
      "workspace creation evidence")
    requireCondition(Array.isArray(evidence.beforeWorkspaceIds) && plainObject(evidence.afterWorkspaceList ?? null),
      "invalid_evidence",
      "Workspace creation evidence must carry the raw before Workspace IDs and after Workspace list JSON")
    const resolution = resolveWorkspaceCreation({
      prefix: receipt.prefix,
      beforeWorkspaceIds: evidence.beforeWorkspaceIds,
      afterWorkspaceList: evidence.afterWorkspaceList
    })
    const result = {
      exactReadback: true,
      globalWorkspaceId: resolution.globalId,
      resolvedName: resolution.name,
      resolvedFrom: "boomux.workspace.list.before_after"
    }
    return this.#mutate(receipt => markConfirmed(receipt, "workspace-create", result))
  }

  // Records the complete Workspace mapping. The owner Workspace ID is derived
  // from the three confirmed Shell creation readbacks (all must agree) and must
  // match the single remote placement in the captured Workspace inspection.
  async recordWorkspaceReadback(evidenceSource) {
    const receipt = await this.receipt()
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    requireCondition(receipt.workspace === null, "mapping_exists", "Workspace mapping is already recorded")
    const workspaceReadback = findOperation(receipt, "workspace-create")
    requireCondition(workspaceReadback?.state === "confirmed"
      && typeof workspaceReadback.result?.globalWorkspaceId === "string",
    "operation_pending", "Confirm the empty Workspace creation readback before recording the mapping")
    const globalId = validateOpaqueId(workspaceReadback.result.globalWorkspaceId, "global Workspace ID")
    const shells = ROLES.map(role => {
      const operation = findOperation(receipt, `shell-create-${role}`)
      requireCondition(operation?.state === "confirmed" && operation.result?.exactReadback === true,
        "operation_pending", `Record the exact ${role} Shell creation readback before the Workspace mapping`)
      return {
        role,
        id: validateOpaqueId(operation.result.shellId, `${role} Shell ID`),
        ownerId: validateOpaqueId(operation.result.ownerId, `${role} owner Workspace ID`),
        cwd: operation.result.cwd,
        argv: operation.result.argv,
        runId: null
      }
    })
    const ownerIds = new Set(shells.map(item => item.ownerId))
    requireCondition(ownerIds.size === 1, "identity_mismatch",
      "The three Shell creation readbacks report inconsistent owner Workspaces")
    const ownerId = [...ownerIds][0]
    const evidence = plainObject(await this.#readEvidence(evidenceSource, "workspace mapping evidence path"),
      "workspace mapping evidence")
    const inspection = plainObject(evidence.workspaceInspection ?? null, "workspace inspection")
    const workspaces = Array.isArray(inspection.workspaces) ? inspection.workspaces : [inspection]
    const nodeId = receipt.inputs.expectedNodeId
    const matches = workspaces.filter(workspace => workspace !== null && typeof workspace === "object"
      && internalId(workspace.id) === globalId)
    requireCondition(matches.length === 1, "ownership_uncertain",
      "Workspace mapping evidence must contain exactly the receipt-owned global Workspace")
    requireCondition(matches[0].name === receipt.prefix,
      "identity_mismatch", "The inspected global Workspace name no longer matches the receipt prefix")
    const placements = Array.isArray(matches[0].placements) ? matches[0].placements : []
    requireCondition(placements.length === 1, "ownership_uncertain",
      "Recording the complete mapping requires exactly one remote placement")
    const placement = plainObject(placements[0], "remote placement")
    requireCondition(placement.node_id === nodeId, "identity_mismatch",
      "The remote placement does not belong to the pinned Node")
    requireCondition((placement.workspace_id ?? placement.owner_workspace_id) === ownerId,
      "identity_mismatch", "The remote placement does not match the Shell-readback owner consensus")
    requireCondition(placement.state === "active", "ownership_uncertain",
      "The remote placement is not active")
    return this.#mutate(current => recordWorkspace(current,
      { globalId, nodeId, ownerId, shells }))
  }

  async planRunnerStart({ unit, socketPath, statePath }, invocation) {
    const receipt = await this.receiptForInvocation(invocation)
    requireCondition(receipt.workspace !== null && receipt.workspace.shells.length === 3,
      "mapping_missing", "Runner start requires the exact three recorded role Shell mappings")
    await this.planOperation({
      id: "runner-start",
      kind: "runner_start",
      intent: { unit, socketPath, statePath }
    })
    return { receipt: await this.store.load() }
  }

  // Accepts structured raw evidence from the exact `systemctl --user show` result
  // plus owner-only socket/state path metadata, and parses it here. A self-
  // asserted normalized object (for example one containing only exactReadback)
  // is never trusted. Evidence shape (all fields required):
  // {
  //   unitShow: ["Id=<unit>", "LoadState=loaded", "ActiveState=active",
  //              "SubState=running", "MainPID=<positive integer>"],
  //   socket: { path, exists: true, kind: "socket", ownerUid: <positive int>, mode: "0600" },
  //   state:  { path, exists: true, kind: "file",   ownerUid: <positive int>, mode: "0600" }
  // }
  async recordRunnerReadback({ evidenceSource, expected }) {
    const evidence = plainObject(await this.#readEvidence(evidenceSource, "runner readback evidence path"),
      "runner readback")
    requireCondition(Array.isArray(evidence.unitShow ?? null), "invalid_evidence",
      "Runner readback evidence must carry the raw systemctl show lines in unitShow")
    const unitShow = parseUnitShow(evidence.unitShow)
    requireCondition(unitShow.Id === expected.unit, "invalid_runner_mapping",
      "The observed user unit differs from the receipt-derived exact unit")
    requireCondition(unitShow.LoadState === "loaded", "postcondition_failed",
      "The runner unit is not loaded")
    requireCondition(unitShow.ActiveState === "active" && unitShow.SubState === "running",
      "postcondition_failed", "The runner user unit is not active/running")
    const mainPid = requirePositiveInteger(unitShow.MainPID, "unit MainPID")
    // Socket/state facts come from the remote-helper file-status raw document,
    // never from an operator-transformed assertion.
    const socket = readPathFacts(evidence.fileStatus, expected.socketPath, "socket", "runner socket")
    const state = readPathFacts(evidence.fileStatus, expected.statePath, "file", "runner state")
    requireCondition(Number.isSafeInteger(socket.ownerUid) && socket.ownerUid > 0
      && socket.ownerUid === state.ownerUid, "postcondition_failed",
      "Runner socket and state paths must be owned by the same non-root unprivileged UID")
    const operation = findOperation(await this.receipt(), "runner-start")
    requireCondition(operation !== null, "operation_missing",
      "The runner readback requires its durable start intent")
    requireAttempted(operation, "runner-start")
    const result = {
      exactReadback: true,
      unit: validateUnitName(unitShow.Id),
      socketPath: socket.path,
      statePath: state.path,
      pid: mainPid,
      activeState: unitShow.ActiveState,
      subState: unitShow.SubState,
      resolvedFrom: "systemctl.user.show+remote-helper.file-status"
    }
    return this.#mutate(receipt => {
      let next = recordRunner(receipt, {
        unit: result.unit,
        socketPath: result.socketPath,
        statePath: result.statePath,
        pid: result.pid
      })
      next = markConfirmed(next, "runner-start", result)
      return next
    })
  }

  // Presentations plan from the receipt Shell IDs only. New Shells are pending at
  // this point; no running Run is required before the first presentation.
  async planPresentAll(invocation) {
    const receipt = await this.receiptForInvocation(invocation)
    requireCondition(receipt.workspace !== null, "mapping_missing",
      "Presentation requires the exact recorded Workspace and role Shell mappings")
    requireCondition(receipt.runner !== null, "mapping_missing",
      "Presentation requires the exact recorded runner mapping so bridges connect on first open")
    await this.#mutate(current => {
      let next = current
      for (const role of ROLES) {
        next = this.#appendIntent(next, {
          id: `present-${role}`,
          kind: "presentation",
          intent: { role, shellId: receipt.workspace.shells.find(shell => shell.role === role).id }
        })
      }
      return next
    })
    return { receipt: await this.receipt(), shells: receipt.workspace.shells }
  }

  // Reconciles the initial running Run ID observed around the first presentation.
  // The Run ID is never typed by the operator: it is extracted from the raw public
  // `boomux shell inspect SHELL --json` document through the shared strict
  // normalizer after validating the exact receipt Shell/owner mapping and the
  // running status. A repeat readback must observe the same Run.
  async recordShellRunReadback({ role, evidenceSource }) {
    validateRole(role)
    const receipt = await this.receipt()
    const operation = findOperation(receipt, `present-${role}`)
    requireCondition(operation !== null, "operation_missing",
      `Run readback requires the recorded ${role} presentation intent`)
    if (operation.state !== "confirmed") {
      // An already-attempted intent must be marked attempted before confirmation.
      requireAttempted(operation, `present-${role}`)
    }
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    requireCondition(receipt.workspace !== null, "mapping_missing",
      "Run readback requires the recorded Workspace mapping")
    const evidence = await this.#readEvidence(evidenceSource, "shell run readback evidence path")
    const inspected = normalizeShell(evidence.shell ?? evidence)
    const shellMapping = receipt.workspace.shells.find(item => item.role === role)
    requireCondition(inspected.id === shellMapping.id, "identity_mismatch",
      `The inspected Shell differs from the receipt-owned ${role} Shell`)
    requireCondition(inspected.workspaceId === receipt.workspace.ownerId, "identity_mismatch",
      "The inspected Shell belongs to a different owner Workspace than the receipt")
    requireCondition(inspected.status === "running" && inspected.runId !== null,
      "postcondition_failed", "Run readback requires the receipt-owned Shell to be running")
    const runId = validateOpaqueId(inspected.runId, `${role} Shell Run ID`)
    return this.#mutate(current => {
      let next = current
      if (operation.state !== "confirmed") {
        next = markConfirmed(next, `present-${role}`, {
          exactReadback: true, runId, resolvedFrom: "boomux.shell.inspect"
        })
      }
      next = recordShellRun(next, role, runId)
      return next
    })
  }

  // Transitions a durable intent to attempted. The human must run this receipt
  // step immediately before executing each printed mutating command, so that a
  // crash afterwards can never be confused with an untouched intent.
  async markAttemptedOutcome(operationId) {
    await this.receipt()
    return this.#mutate(receipt => {
      // Stop-on-first-unproven, in code: while one mutation is attempted (executed
      // but not yet exactly reconciled), no other mutation may be marked attempted.
      requireCondition(receipt.blocked === null, "receipt_blocked",
        "The receipt is blocked by an ambiguous outcome")
      const unresolved = receipt.operations.find(operation =>
        operation.id !== operationId && operation.state === "attempted")
      requireCondition(unresolved === undefined, "attempt_in_progress",
        `Operation ${unresolved === undefined ? "" : unresolved.id} is still attempted;`
          + " exactly confirm or mark ambiguous the prior mutation first")
      return markAttempted(receipt, operationId)
    })
  }

  async markAmbiguousOutcome(operationId, reason) {
    await this.receipt()
    return this.#mutate(receipt => markAmbiguous(receipt, operationId, reason))
  }

  // Exact intent equality makes idempotent replay safe; anything else is refused.
  // This includes a globally blocked receipt and attempted/ambiguous operations.
  // Specialized cleanup confirmations from the exact interleaved readbacks.
  // Generic exact confirmation was removed: these are the only paths that can
  // confirm or reconcile a cleanup operation, and each consumes raw evidence.
  async confirmCleanupUnitStop(evidenceSource, expected) {
    const receipt = await this.receipt()
    const operation = findOperation(receipt, "cleanup-unit-stop")
    requireCondition(operation !== null, "operation_missing",
      "The stopped-unit readback requires its durable cleanup intent")
    requireCleanupAttempted(operation, "cleanup-unit-stop")
    const evidence = plainObject(await this.#readEvidence(evidenceSource, "stopped-unit evidence path"),
      "stopped-unit evidence")
    requireCondition(Array.isArray(evidence.unitShow ?? null), "invalid_evidence",
      "Stopped-unit evidence must carry the raw systemctl show lines in unitShow")
    const unitShow = parseUnitShow(evidence.unitShow)
    requireCondition(unitShow.Id === expected.unit, "identity_mismatch",
      "The observed user unit differs from the receipt-derived exact unit")
    requireCondition(unitShow.ActiveState === "inactive", "postcondition_failed",
      "The runner user unit is not inactive after the stop")
    requireCondition(unitShow.MainPID === "0", "postcondition_failed",
      "The runner main PID is not 0 after the stop")
    return this.#mutate(receipt => markConfirmed(receipt, "cleanup-unit-stop", {
      exactReadback: true, unit: validateUnitName(unitShow.Id),
      activeState: unitShow.ActiveState, subState: unitShow.SubState, mainPid: unitShow.MainPID
    }))
  }

  async confirmCleanupFilesRemoved(evidenceSource, expected) {
    const receipt = await this.receipt()
    const operation = findOperation(receipt, "cleanup-remove-files")
    requireCondition(operation !== null, "operation_missing",
      "The file-removal readback requires its durable cleanup intent")
    requireCleanupAttempted(operation, "cleanup-remove-files")
    const facts = plainObject(await this.#readEvidence(evidenceSource, "file-status evidence path"),
      "file-status evidence")
    requireCondition(facts.schema === FILE_STATUS_SCHEMA, "invalid_evidence",
      "File-removal evidence must be the raw remote-helper file-status document")
    for (const [label, expectedPath] of [
      ["socket", expected.socketPath], ["state", expected.statePath]
    ]) {
      const entries = Array.isArray(facts.files ?? null) ? facts.files.filter(entry =>
        entry !== null && typeof entry === "object" && entry.path === expectedPath) : []
      requireCondition(entries.length === 1, "identity_mismatch",
        `The ${label} path in the readback differs from the receipt-derived exact path`)
      requireCondition(entries[0].status === "missing" && entries[0].exists === false,
        "postcondition_failed", `The exact ${label} path remains after removal`)
    }
    requireCondition(Array.isArray(facts.files ?? null) && facts.files.length === 2,
      "invalid_evidence", "File-removal evidence must cover exactly the two receipt-owned paths")
    requireCondition(facts.spikePathsAbsent === true, "postcondition_failed",
      "The file-status readback does not prove both spike paths absent")
    return this.#mutate(receipt => markConfirmed(receipt, "cleanup-remove-files", {
      exactReadback: true, socketPath: validateUnixSocketPath(expected.socketPath, "runner socket path"),
      statePath: validateAbsolutePath(expected.statePath, "runner state path"), absent: true
    }))
  }

  async confirmCleanupShellClose({ role, evidenceSource }) {
    validateRole(role)
    const receipt = await this.receipt()
    requireCondition(receipt.workspace !== null, "mapping_missing",
      "Shell-close confirmation requires the recorded Workspace mapping")
    const operation = findOperation(receipt, `cleanup-shell-close-${role}`)
    requireCondition(operation !== null, "operation_missing",
      `The ${role} Shell-close readback requires its durable cleanup intent`)
    requireCleanupAttempted(operation, `cleanup-shell-close-${role}`)
    const document = plainObject(await this.#readEvidence(evidenceSource, "shell close evidence path"),
      "shell close evidence")
    const mapping = receipt.workspace.shells.find(item => item.role === role)
    requireCondition(plainObject(document.requested ?? null, "requested Shell") !== null
      && internalId(document.requested.shellId) === mapping.id
      && internalId(document.requested.workspaceId) === receipt.workspace.ownerId,
    "identity_mismatch", "The inspected Shell or Workspace differs from the receipt")
    requireCondition(typeof document.stderr === "string" && document.stderr.length > 0,
      "invalid_evidence", "Shell-close evidence must carry the raw Boomux stderr document")
    const error = parseErrorEnvelope(document.stderr, "shell.inspect")
    requireCondition(error.code === "not_found", "postcondition_failed",
      `The exact ${role} Shell was not proven absent (typed ${error.code})`)
    return this.#mutate(receipt => markConfirmed(receipt, `cleanup-shell-close-${role}`, {
      exactReadback: true, shellId: mapping.id, absent: true, typedError: error.code
    }))
  }

  async confirmCleanupWorkspaceClose(evidenceSource) {
    const receipt = await this.receipt()
    requireCondition(receipt.workspace !== null, "mapping_missing",
      "Workspace-close confirmation requires the recorded Workspace mapping")
    const operation = findOperation(receipt, "cleanup-workspace-close")
    requireCondition(operation !== null, "operation_missing",
      "The Workspace-close readback requires its durable cleanup intent")
    requireCleanupAttempted(operation, "cleanup-workspace-close")
    const document = plainObject(await this.#readEvidence(evidenceSource, "workspace close evidence path"),
      "workspace close evidence")
    requireCondition(document.requested !== undefined && document.requested !== null, "invalid_evidence",
      "Workspace-close evidence must name the requested global Workspace ID")
    const requested = plainObject(document.requested, "workspace close request")
    requireCondition(internalId(requested.globalWorkspaceId) === receipt.workspace.globalId,
      "identity_mismatch", "The workspace-close readback requested a different Workspace than the receipt")
    requireCondition(typeof document.stderr === "string" && document.stderr.length > 0,
      "invalid_evidence", "Workspace-close evidence must carry the raw Boomux stderr document")
    const error = parseErrorEnvelope(document.stderr, "workspace.inspect")
    requireCondition(error.code === "not_found", "postcondition_failed",
      `The exact coordinated Workspace was not proven absent (typed ${error.code})`)
    return this.#mutate(receipt => markConfirmed(receipt, "cleanup-workspace-close", {
      exactReadback: true, globalWorkspaceId: receipt.workspace.globalId, typedError: error.code
    }))
  }

  // Re-presentation after reconnect: distinct receipt operations so neither the
  // first presentation ID reuse nor the confirmations collide.
  async planRepresentAll(invocation) {
    const receipt = await this.receiptForInvocation(invocation)
    requireCondition(receipt.workspace !== null, "mapping_missing",
      "Re-presentation requires the exact recorded Workspace and role Shell mappings")
    requireCondition(receipt.runner !== null, "mapping_missing",
      "Re-presentation requires the exact recorded runner mapping so bridges reconnect on reopen")
    requireCondition(receipt.workspace.shells.every(item => item.runId !== null), "mapping_missing",
      "Re-presentation requires the reconciled initial running Run IDs")
    await this.#mutate(current => {
      let next = current
      for (const role of ROLES) {
        next = this.#appendIntent(next, {
          id: `represent-${role}`,
          kind: "representation",
          intent: { role, shellId: receipt.workspace.shells.find(shell => shell.role === role).id }
        })
      }
      return next
    })
    return { receipt: await this.receipt(), shells: receipt.workspace.shells }
  }

  // Reconciles a re-presented Shell Run: same Run is required, a change is
  // rejected as an unsupported uncertain outcome.
  async recordRepresentRunReadback({ role, evidenceSource }) {
    validateRole(role)
    const receipt = await this.receipt()
    const operation = findOperation(receipt, `represent-${role}`)
    requireCondition(operation !== null, "operation_missing",
      `Re-presentation readback requires the recorded ${role} re-presentation intent`)
    if (operation.state !== "confirmed") {
      requireAttempted(operation, `represent-${role}`)
    }
    const evidence = await this.#readEvidence(evidenceSource, "shell run readback evidence path")
    const inspected = normalizeShell(evidence.shell ?? evidence)
    const shellMapping = receipt.workspace.shells.find(item => item.role === role)
    requireCondition(inspected.id === shellMapping.id, "identity_mismatch",
      `The inspected Shell differs from the receipt-owned ${role} Shell`)
    requireCondition(inspected.workspaceId === receipt.workspace.ownerId, "identity_mismatch",
      "The inspected Shell belongs to a different owner Workspace than the receipt")
    requireCondition(inspected.status === "running" && inspected.runId !== null,
      "postcondition_failed", "Re-presentation readback requires the receipt-owned Shell to be running")
    // A re-presented Shell Run must be the receipt-owned Run; a change is the
    // documented unsupported uncertain outcome of generic open.
    requireCondition(inspected.runId === shellMapping.runId, "run_changed",
      "The re-presented Shell Run differs from the receipt-owned Run", {
        shellId: shellMapping.id, expectedRunId: shellMapping.runId, observedRunId: inspected.runId
      })
    return this.#mutate(receipt => markConfirmed(receipt, `represent-${role}`, {
      exactReadback: true, runId: validateOpaqueId(inspected.runId, `${role} Shell Run ID`),
      resolvedFrom: "boomux.shell.inspect"
    }))
  }

  #appendIntent(receipt, operation) {
    requireCondition(receipt.blocked === null, "receipt_blocked",
      "The receipt is blocked by an ambiguous outcome")
    requireCondition(receipt.preflight !== null, "preflight_required",
      "Mutation intent requires bound preflight evidence")
    requireCondition(receipt.remotePreflight !== null, "remote_preflight_required",
      "Mutation intent requires the recorded runtime-dependent remote preflight evidence")
    const existing = findOperation(receipt, operation.id)
    if (existing === null) return recordIntent(receipt, operation)
    if (existing.state === "confirmed") {
      throw spikeError("operation_confirmed",
        `Operation ${operation.id} is already confirmed and cannot be re-planned`)
    }
    if (existing.state === "attempted" || existing.state === "ambiguous") {
      throw spikeError("operation_not_replayable",
        `Operation ${operation.id} is ${existing.state}; it must be explicitly reconciled before any replay`)
    }
    if (existing.kind !== operation.kind
      || JSON.stringify(existing.intent) !== JSON.stringify(operation.intent)) {
      throw spikeError("intent_mismatch",
        `Operation ${operation.id} exists with a different kind or intent; replay is refused`)
    }
    return receipt
  }

  async #readEvidence(value, label) {
    if (typeof value === "string") {
      return readEvidenceDocument(await readEvidenceFile(value), label)
    }
    return plainObject(value, label)
  }

  async #mutate(transform) {
    await this.store.update(receipt => {
      const next = transform(structuredClone(receipt))
      for (const key of Object.keys(receipt)) delete receipt[key]
      Object.assign(receipt, next)
    })
    return this.store.load()
  }
}

function requireCleanupAttempted(operation, operationId) {
  requireCondition(operation.state === "attempted" || operation.state === "ambiguous",
    "operation_not_attempted",
    `Operation ${operationId} must be marked attempted (mark-attempted) immediately before its exact readback`)
  return operation
}

function requireAttempted(operation, operationId) {
  requireCondition(operation.state === "attempted" || operation.state === "ambiguous",
    "operation_not_attempted",
    `Operation ${operationId} must be marked attempted (mark-attempted) immediately before its confirmation`)
  return operation
}

function requirePositiveInteger(value, label) {
  const parsed = typeof value === "number" ? value : Number(value)
  requireCondition(Number.isSafeInteger(parsed) && parsed > 0, "postcondition_failed",
    `${label} must be a positive integer`)
  return parsed
}

// Exactly the five requested keys, each exactly once — non-adjacent duplicates
// overwrite silently otherwise, and unknown keys are not part of the contract.
const UNIT_SHOW_KEYS = Object.freeze(["Id", "LoadState", "ActiveState", "SubState", "MainPID"])

function parseUnitShow(lines) {
  const entries = {}
  for (const line of lines) {
    requireCondition(typeof line === "string", "invalid_evidence",
      "systemctl show lines must be strings")
    const separator = line.indexOf("=")
    requireCondition(separator > 0, "invalid_evidence", "systemctl show lines are key=value pairs")
    const key = line.slice(0, separator)
    requireCondition(!Object.hasOwn(entries, key), "invalid_evidence",
      `systemctl show evidence contains a duplicate key: ${key}`)
    entries[key] = line.slice(separator + 1)
  }
  for (const key of UNIT_SHOW_KEYS) {
    requireCondition(Object.hasOwn(entries, key) && entries[key].length > 0, "invalid_evidence",
      `systemctl show evidence lacks ${key}`)
  }
  for (const key of Object.keys(entries)) {
    requireCondition(UNIT_SHOW_KEYS.includes(key), "invalid_evidence",
      `systemctl show evidence contains an unexpected key: ${key}`)
  }
  return entries
}

const FILE_STATUS_SCHEMA = "omarchestra.remote-execution-node.file-status/v1"

// Extracts one exact path's facts from the raw remote-helper file-status
// document (the helper's own schema, files array), never from an operator
// transformed assertion.
function readPathFacts(fileStatusDocument, expectedPath, expectedKind, label) {
  const facts = plainObject(fileStatusDocument ?? null, "file-status evidence")
  requireCondition(facts.schema === FILE_STATUS_SCHEMA, "invalid_evidence",
    "Runner readback fileStatus evidence must be the raw remote-helper file-status document")
  const entries = Array.isArray(facts.files ?? null) ? facts.files : []
  const matches = entries.filter(entry => entry !== null && typeof entry === "object"
    && entry.path === expectedPath)
  requireCondition(matches.length === 1, "invalid_evidence",
    `${label} path is missing from the exact file-status evidence`)
  const entry = plainObject(matches[0], `${label} path facts`)
  requireCondition(entry.exists === true && entry.kind === expectedKind, "postcondition_failed",
    `${label} is a ${entry.kind ?? "unknown"} instead of a present ${expectedKind}`)
  requireCondition(entry.mode === "0600", "postcondition_failed", `${label} must be mode 0600`)
  const ownerUid = requirePositiveInteger(entry.ownerUid, `${label} owner UID`)
  void ownerUid
  return { path: validateAbsolutePath(entry.path, `${label} path`), ownerUid: entry.ownerUid }
}

function internalId(value) {
  if (value !== null && typeof value === "object") return validateOpaqueId(value.inner_id, "Workspace ID")
  return validateOpaqueId(value, "Workspace ID")
}

function readEvidenceFile(filePath) {
  const validated = validateAbsolutePath(filePath, "receipt evidence file")
  return readFile(validated, "utf8").catch(error => {
    if (error?.code === "ENOENT") {
      throw spikeError("invalid_evidence", `Receipt evidence file does not exist: ${validated}`)
    }
    throw error
  })
}

function readEvidenceDocument(content, label) {
  try {
    return JSON.parse(content)
  } catch {
    throw spikeError("invalid_evidence", `${label} is not valid JSON`)
  }
}

function validateOperationDescription(operation) {
  plainObject(operation, "operation description")
  requireCondition(typeof operation.id === "string" && operation.id.length > 0
    && /^[a-z0-9][a-z0-9-]{0,127}$/.test(operation.id),
  "invalid_arguments", "Operation ID is invalid")
  requireCondition(typeof operation.kind === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(operation.kind),
    "invalid_arguments", "Operation kind is invalid")
  plainObject(operation.intent, "operation intent")
  return operation
}

function plainObjectSpecification(value) {
  requireCondition(Array.isArray(value) && value.length > 0, "invalid_arguments", "Shell specifications are invalid")
  for (const specification of value) {
    plainObject(specification, "shell specification")
    requireCondition(ROLES.includes(specification.role), "invalid_role", "Shell specification role is invalid")
    requireCondition(typeof specification.name === "string" && specification.name.length > 0,
      "invalid_arguments", "Shell specification name is invalid")
  }
  return value
}

function validateRole(role) {
  requireCondition(ROLES.includes(role), "invalid_role", "Role is invalid")
  return role
}

function findOperation(receipt, operationId) {
  return receipt.operations.find(operation => operation.id === operationId) ?? null
}