import { randomUUID } from "node:crypto"

import { commands } from "./commands.mjs"
import { boomuxError, parseErrorEnvelope, parseSuccessEnvelope } from "./envelopes.mjs"
import { adapterError, isAdapterError, requireCondition } from "./errors.mjs"
import { newReceipt, recordOperation } from "./receipt.mjs"

export const REQUIRED_CLI_VERSION = "1.8.0"
export const REQUIRED_PROTOCOL = 49
export const REQUIRED_JSON_COMMANDS = Object.freeze([
  "capabilities", "daemon.status", "workspace.list", "workspace.inspect", "node.snapshot",
  "list", "shell.inspect", "agent.list", "integration.list", "integration.status", "events"
])
export const REQUIRED_FEATURES = Object.freeze([
  "typed_errors", "shell_run_identity", "daemon_events", "reconnectable_event_cursors",
  "global_workspaces", "multi_node_workspace_placements", "hyprland_special_workspaces",
  "coordinated_shell_desktop_placement", "protocol_49"
])
export const REQUIRED_ERROR_CODES = Object.freeze([
  "not_found", "daemon_unavailable", "cursor_expired", "run_changed"
])

const ROLES = new Set(["coordinator", "builder", "reviewer"])
const SUPPORTED_EVENTS = new Set([
  "workspace_created", "workspace_closed", "shell_created", "shell_closed",
  "run_started", "run_exited", "output_changed", "handoff_completed"
])
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function string(value, field) {
  requireCondition(typeof value === "string" && value.length > 0, "invalid_response",
    `Boomux returned invalid ${field}`)
  return value
}

function positiveInteger(value, field) {
  requireCondition(Number.isSafeInteger(value) && value > 0, "invalid_response",
    `Boomux returned invalid ${field}`)
  return value
}

function object(value, field) {
  requireCondition(value && typeof value === "object" && !Array.isArray(value), "invalid_response",
    `Boomux returned invalid ${field}`)
  return value
}

function array(value, field) {
  requireCondition(Array.isArray(value), "invalid_response", `Boomux returned invalid ${field}`)
  return value
}

function exactArray(left, right) {
  return Array.isArray(left) && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function opaque(prefix) {
  return `${prefix}_${randomUUID()}`
}

export function makePrefix() {
  return `omarchestra-boomux-spike-${randomUUID()}`
}

function specFingerprint(spec) {
  return JSON.stringify({
    sessionKey: spec.sessionKey,
    role: spec.role,
    cwd: spec.cwd,
    argv: spec.argv
  })
}

export function normalizeSessionSpec(input) {
  const spec = object(input, "session specification")
  const sessionKey = string(spec.sessionKey, "session key")
  const role = string(spec.role, "role").toLowerCase()
  requireCondition(ROLES.has(role), "invalid_specification", "Role must be coordinator, builder, or reviewer")
  const cwd = string(spec.cwd, "cwd")
  requireCondition(cwd.startsWith("/"), "invalid_specification", "Session cwd must be absolute")
  const argv = array(spec.argv, "argv")
  requireCondition(argv.length > 0 && argv.every(value => typeof value === "string"),
    "invalid_specification", "Session argv must be a nonempty string array")
  requireCondition(!sessionKey.includes("\u0000") && !cwd.includes("\u0000")
    && argv.every(value => !value.includes("\u0000")), "invalid_specification",
  "Session specification cannot contain NUL bytes")
  return { sessionKey, role, cwd, argv: [...argv] }
}

export function normalizeShell(shell) {
  object(shell, "shell")
  const status = string(shell.status, "shell status")
  requireCondition(["pending", "running", "exited"].includes(status), "invalid_response",
    `Boomux returned unsupported shell status ${status}`)
  const run = shell.run === null || shell.run === undefined ? null : object(shell.run, "shell run")
  if (status === "running" || status === "exited") {
    requireCondition(run !== null, "invalid_response", `Boomux ${status} shell omitted its Run`)
  }
  if (run !== null) {
    string(run.id, "Run ID")
    positiveInteger(run.generation, "Run generation")
  }
  return {
    id: string(shell.id, "Shell ID"),
    workspaceId: string(shell.workspace_id, "Shell Workspace ID"),
    name: string(shell.name, "Shell name"),
    cwd: string(shell.cwd, "Shell cwd"),
    command: shell.command === undefined ? [] : array(shell.command, "Shell command"),
    status,
    run: run === null ? null : {
      id: run.id,
      generation: run.generation,
      startedAtMs: run.started_at_ms ?? null,
      endedAtMs: run.ended_at_ms ?? null,
      exitReason: run.exit_reason ?? null,
      exitCode: run.exit_code ?? null,
      outputRevision: run.output_revision ?? null,
      environmentHasRunId: run.environment_has_run_id ?? null
    }
  }
}

function qualifiedInnerId(value, nodeId, field) {
  const identity = object(value, field)
  requireCondition(identity.node_id === nodeId, "identity_mismatch",
    `Boomux ${field} belongs to a different Node`)
  return string(identity.inner_id, field)
}

function selectLocalNode(snapshot, expectedNodeId = null) {
  const matches = array(snapshot.nodes, "Node snapshot nodes").filter(node => {
    return node && node.local === true && node.current === true && node.stale === false
      && node.health === "online" && node.workspace_owner_eligible === true
      && (!expectedNodeId || node.node_id === expectedNodeId)
  })
  requireCondition(matches.length === 1, "local_node_unavailable",
    "Boomux did not return one current eligible local Node")
  return matches[0]
}

function globalWorkspace(snapshot, globalWorkspaceId) {
  const matches = array(snapshot.workspaces, "global Workspaces").filter(workspace => {
    return workspace && workspace.id === globalWorkspaceId
  })
  requireCondition(matches.length === 1, "ownership_conflict", "Recorded global Workspace is absent or ambiguous")
  const workspace = matches[0]
  requireCondition(workspace.closing === false, "ownership_conflict", "Recorded global Workspace is closing")
  return workspace
}

function placementFor(workspace, nodeId, expectedOwnerWorkspaceId = null) {
  const placements = array(workspace.placements, "Workspace placements")
  const matches = placements.filter(placement => placement && placement.node_id === nodeId
    && placement.state === "active"
    && (!expectedOwnerWorkspaceId || placement.workspace_id === expectedOwnerWorkspaceId))
  requireCondition(matches.length === 1, "ownership_conflict",
    "Recorded global Workspace does not have one active local placement")
  return matches[0]
}

function ownerWorkspace(localNode, ownerWorkspaceId) {
  const local = object(localNode.local_snapshot, "local Node snapshot")
  const matches = array(local.workspaces, "owner Workspaces").filter(workspace => {
    return workspace && qualifiedInnerId(workspace.id, localNode.node_id, "owner Workspace ID") === ownerWorkspaceId
  })
  requireCondition(matches.length === 1, "ownership_conflict", "Recorded owner Workspace is absent or ambiguous")
  return matches[0]
}

function ownerResources(owner, nodeId) {
  const shells = array(owner.shells ?? [], "owner Shells").map(shell => ({
    raw: shell,
    id: qualifiedInnerId(shell.id, nodeId, "Shell ID"),
    workspaceId: qualifiedInnerId(shell.workspace_id, nodeId, "Shell Workspace ID")
  }))
  const launchers = array(owner.launchers ?? [], "owner Launchers")
  const agents = array(owner.agents ?? [], "owner Agents")
  return { shells, launchers, agents }
}

function publicLifecycle(reference, shell, session) {
  return {
    reference,
    state: shell.status,
    attachment: "unavailable",
    run: shell.run === null ? null : {
      reference: session.runRef,
      generation: shell.run.generation,
      startedAtMs: shell.run.startedAtMs,
      endedAtMs: shell.run.endedAtMs,
      exitReason: shell.run.exitReason,
      exitCode: shell.run.exitCode,
      outputRevision: shell.run.outputRevision
    }
  }
}

export class BoomuxRuntimeAdapter {
  constructor({ executor, receiptStore, prefix = null, teamGoalKey = "manual", allowGui = false,
    pollAttempts = 20, pollIntervalMs = 250, sleepFn = sleep } = {}) {
    requireCondition(executor && typeof executor.run === "function", "invalid_executor",
      "Adapter requires an argv executor")
    requireCondition(receiptStore && typeof receiptStore.load === "function"
      && typeof receiptStore.initialize === "function" && typeof receiptStore.update === "function",
    "invalid_receipt_store", "Adapter requires a receipt store")
    this.executor = executor
    this.receiptStore = receiptStore
    this.prefix = prefix
    this.teamGoalKey = teamGoalKey
    this.allowGui = allowGui
    this.pollAttempts = pollAttempts
    this.pollIntervalMs = pollIntervalMs
    this.sleepFn = sleepFn
  }

  async capabilities() {
    const capabilityData = await this.#json(commands.capabilities(), "capabilities")
    this.#validateCapabilities(capabilityData)
    const status = await this.#json(commands.daemonStatus(), "daemon.status")
    requireCondition(status.status === "running", "daemon_unavailable", "Boomux daemon is not running")
    requireCondition(status.protocol_version === REQUIRED_PROTOCOL, "daemon_protocol_mismatch",
      `Expected running Boomux protocol ${REQUIRED_PROTOCOL}`)
    return {
      runtime: "boomux",
      version: capabilityData.cli_version,
      protocol: status.protocol_version,
      lifecycle: ["pending", "running", "exited", "closed"],
      attachment: "unavailable",
      presentation: "manual_gui_gate"
    }
  }

  async create(input) {
    await this.capabilities()
    const spec = normalizeSessionSpec(input)
    let receipt = await this.#ensureReceipt()
    this.#assertNoUnknownOutcome(receipt)
    if (!receipt.eventBaseline) {
      const baseline = await this.#json(commands.events({ waitMs: 0, limit: 256 }), "events")
      const cursor = string(baseline.cursor, "event cursor")
      object(baseline.snapshot, "event baseline snapshot")
      await this.receiptStore.update(next => {
        next.eventBaseline = { cursor, capturedAtMs: Date.now() }
        next.operations.push({ kind: "event_baseline_confirmed", atMs: Date.now(), details: {} })
      })
      receipt = await this.#receipt()
    }
    if (receipt.teamGoalKey !== this.teamGoalKey) {
      throw adapterError("team_goal_mismatch", "Receipt belongs to another Team Goal")
    }
    const existing = Object.entries(receipt.sessions).find(([, session]) => session.sessionKey === spec.sessionKey)
    if (existing) {
      const [reference, session] = existing
      if (session.fingerprint !== specFingerprint(spec)) {
        throw adapterError("idempotency_conflict", "Session key was reused with a different specification")
      }
      requireCondition(session.phase === "confirmed", "unknown_outcome",
        "Session creation was not confirmed and cannot be retried")
      return reference
    }

    const node = await this.#localNode(receipt)
    receipt = await this.#ensureWorkspace(receipt)
    const reference = opaque("tsr")
    const name = `${receipt.prefix}-${spec.role}`
    await this.receiptStore.update(next => {
      next.sessions[reference] = {
        reference,
        sessionKey: spec.sessionKey,
        role: spec.role,
        name,
        requestedCwd: spec.cwd,
        cwd: null,
        argv: [...spec.argv],
        fingerprint: specFingerprint(spec),
        shellId: null,
        runId: null,
        runRef: null,
        phase: "prepared",
        closed: false
      }
      next.operations.push({ kind: "shell_create_prepared", atMs: Date.now(), details: { reference, name } })
    })

    try {
      await this.#weak(commands.shellCreate({
        globalWorkspaceId: receipt.globalWorkspace.id,
        nodeId: node.node_id,
        name,
        cwd: spec.cwd,
        argv: spec.argv
      }), "shell create")
      await this.#confirmShell(reference)
      return reference
    } catch (error) {
      await this.#markUnknown("shell_create_unknown", { reference, name, error: error.code ?? "unknown" })
      throw error
    }
  }

  async inspect(reference) {
    const session = await this.#session(reference)
    if (session.closed) return { reference, state: "closed", attachment: "unavailable", run: null }
    const shell = await this.#inspectRawShell(session.shellId)
    requireCondition(shell.workspaceId === (await this.#receipt()).placement.ownerWorkspaceId,
      "ownership_conflict", "Shell moved to a different Workspace")
    await this.#recordObservedRun(reference, shell)
    return publicLifecycle(reference, shell, await this.#session(reference))
  }

  async present(reference) {
    requireCondition(this.allowGui, "gui_not_authorized",
      "Presentation requires explicit manual GUI authorization")
    const receipt = await this.#receipt()
    this.#assertNoUnknownOutcome(receipt)
    const before = await this.inspect(reference)
    requireCondition(before.state !== "exited", "run_not_running",
      "Refusing to open an exited Shell because Boomux would start a replacement Run")
    requireCondition(before.state !== "closed", "reference_closed", "Shell was already closed")
    const session = await this.#session(reference)
    await recordOperation(this.receiptStore, "presentation_prepared", { reference, shellId: session.shellId })
    try {
      await this.#weak(commands.shellOpen({
        shellId: session.shellId,
        globalWorkspaceId: receipt.globalWorkspace.id,
        title: session.name
      }), "open")
      for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
        const state = await this.inspect(reference)
        if (state.state === "running") {
          await recordOperation(this.receiptStore, "presentation_confirmed", { reference })
          return state
        }
        if (state.state === "exited") {
          throw adapterError("presentation_failed", "Shell exited while presentation was being confirmed")
        }
        await this.sleepFn(this.pollIntervalMs)
      }
      throw adapterError("presentation_unconfirmed", "Boomux did not report a running Shell before the deadline")
    } catch (error) {
      await this.#markUnknown("presentation_unknown", { reference, error: error.code ?? "unknown" })
      throw error
    }
  }

  async close(reference) {
    const session = await this.#session(reference)
    if (session.closed) return { reference, state: "closed", changed: false }
    const receipt = await this.#receipt()
    this.#assertNoUnknownOutcome(receipt)
    requireCondition(receipt.placement && session.shellId, "ownership_conflict",
      "Shell ownership receipt is incomplete")
    await recordOperation(this.receiptStore, "shell_close_prepared", { reference, shellId: session.shellId })
    try {
      await this.#weak(commands.shellClose({
        shellId: session.shellId,
        ownerWorkspaceId: receipt.placement.ownerWorkspaceId
      }), "shell close")
      await this.#expectShellAbsent(session.shellId)
    } catch (error) {
      await this.#markUnknown("shell_close_unknown", { reference, shellId: session.shellId, error: error.code ?? "unknown" })
      throw error
    }
    await this.receiptStore.update(next => {
      next.sessions[reference].closed = true
      next.operations.push({ kind: "shell_close_confirmed", atMs: Date.now(), details: { reference, shellId: session.shellId } })
    })
    return { reference, state: "closed", changed: true }
  }

  async subscribe(references, cursor = null, { waitMs = 5000 } = {}) {
    requireCondition(Array.isArray(references) && references.length > 0,
      "invalid_subscription", "Subscription requires one or more references")
    requireCondition(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 60_000,
      "invalid_subscription", "Subscription wait must be between 0 and 60000 milliseconds")
    const wanted = new Map()
    for (const reference of references) {
      const session = await this.#session(reference)
      wanted.set(session.shellId, {
        reference,
        runId: session.runId,
        runRef: session.runRef
      })
    }
    let baseline = cursor === null || cursor === undefined
    let data
    try {
      data = await this.#json(commands.events({ after: cursor, waitMs, limit: 256 }), "events")
    } catch (error) {
      if (baseline || !isAdapterError(error, "cursor_expired")) throw error
      data = await this.#json(commands.events({ waitMs, limit: 256 }), "events")
      baseline = true
    }
    const nextCursor = string(data.cursor, "event cursor")
    const events = array(data.events, "events")
    if (baseline) object(data.snapshot, "event baseline snapshot")
    else if (data.snapshot !== null && data.snapshot !== undefined) object(data.snapshot, "event baseline snapshot")
    let previous = 0
    const receipt = await this.#receipt()
    const mapped = []
    for (const event of events) {
      object(event, "event")
      const id = positiveInteger(event.id, "event ID")
      requireCondition(Number.isSafeInteger(event.at_ms) && event.at_ms >= 0, "invalid_response",
        "Boomux returned invalid event timestamp")
      requireCondition(id > previous, "event_order", "Boomux events were not strictly ordered")
      previous = id
      const match = await this.#mapEvent(event, wanted, receipt.placement?.ownerWorkspaceId)
      if (match) mapped.push(match)
    }
    return {
      cursor: nextCursor,
      baseline,
      snapshotAvailable: data.snapshot !== null && data.snapshot !== undefined,
      events: mapped
    }
  }

  async cleanup() {
    const receipt = await this.#receipt()
    requireCondition(receipt.globalWorkspace, "ownership_conflict", "No recorded Workspace exists")
    this.#assertNoUnknownOutcome(receipt)
    requireCondition(receipt.placement, "ownership_conflict", "No recorded Workspace placement exists")
    await this.#assertOwnedPlacement(receipt)
    for (const reference of Object.keys(receipt.sessions)) {
      const session = await this.#session(reference)
      if (!session.closed) await this.close(reference)
    }
    const afterShellClose = await this.#receipt()
    await this.#assertOwnedPlacement(afterShellClose)
    await recordOperation(this.receiptStore, "workspace_close_prepared", {
      workspaceId: afterShellClose.globalWorkspace.id
    })
    try {
      await this.#weak(commands.workspaceClose(afterShellClose.globalWorkspace.id), "workspace close")
      await this.#expectWorkspaceAbsent(afterShellClose.globalWorkspace.id)
    } catch (error) {
      await this.#markUnknown("workspace_close_unknown", {
        workspaceId: afterShellClose.globalWorkspace.id,
        error: error.code ?? "unknown"
      })
      throw error
    }
    await this.receiptStore.update(next => {
      next.cleanup = { confirmedAtMs: Date.now() }
      next.operations.push({ kind: "workspace_close_confirmed", atMs: Date.now(), details: {
        workspaceId: next.globalWorkspace.id
      } })
    })
    return { state: "closed" }
  }

  async preflightSnapshot() {
    const capabilities = await this.capabilities()
    const [workspaceList, shellList, nodeSnapshot, agentList, integrationList, integrationStatus, events,
      configPath, configValidate] = await Promise.all([
      this.#json(commands.workspaceList(), "workspace.list"),
      this.#json(commands.list(), "list"),
      this.#json(commands.nodeSnapshot(), "node.snapshot"),
      this.#json(commands.agentList(undefined), "agent.list"),
      this.#json(commands.integrationList(), "integration.list"),
      this.#json(commands.integrationStatus(), "integration.status"),
      this.#json(commands.events({ waitMs: 0, limit: 256 }), "events"),
      this.#readOnlyHuman(commands.configPath(), "config path"),
      this.#readOnlyHuman(commands.configValidate(), "config validate")
    ])
    const localNode = selectLocalNode(nodeSnapshot)
    return { capabilities, localNodeId: localNode.node_id, workspaceList, shellList, nodeSnapshot,
      agentList, integrationList, integrationStatus, events, configPath, configValidate }
  }

  async #ensureReceipt() {
    let receipt = await this.receiptStore.load()
    if (receipt !== null) {
      requireCondition(/^omarchestra-boomux-spike-[0-9a-f-]{36}$/.test(receipt.prefix), "invalid_receipt",
        "Receipt prefix is not a recognized spike prefix")
      return receipt
    }
    const prefix = this.prefix ?? makePrefix()
    requireCondition(/^omarchestra-boomux-spike-[0-9a-f-]{36}$/.test(prefix), "invalid_prefix",
      "Spike prefix must be collision-resistant and recognizable")
    receipt = newReceipt({ prefix, teamGoalKey: this.teamGoalKey })
    await this.receiptStore.initialize(receipt)
    return receipt
  }

  async #ensureWorkspace(receipt) {
    if (receipt.globalWorkspace) {
      const data = await this.#json(commands.workspaceInspect(receipt.globalWorkspace.id), "workspace.inspect")
      const workspace = object(data.workspace, "Workspace")
      requireCondition(workspace.id === receipt.globalWorkspace.id && workspace.name === receipt.prefix
        && workspace.closing === false, "ownership_conflict", "Recorded global Workspace changed")
      return receipt
    }
    try {
      await this.#json(commands.workspaceInspect(receipt.prefix), "workspace.inspect")
      throw adapterError("ownership_conflict",
        "A Workspace already uses the intended spike prefix; refusing to adopt it")
    } catch (error) {
      if (!isAdapterError(error, "not_found")) throw error
    }
    await recordOperation(this.receiptStore, "workspace_absence_confirmed", { name: receipt.prefix })
    await recordOperation(this.receiptStore, "workspace_create_prepared", { name: receipt.prefix })
    let weakFailure = null
    try {
      await this.#weak(commands.workspaceCreate(receipt.prefix), "workspace create")
    } catch (error) {
      weakFailure = error
    }
    try {
      const data = await this.#json(commands.workspaceInspect(receipt.prefix), "workspace.inspect")
      const workspace = object(data.workspace, "Workspace")
      requireCondition(workspace.name === receipt.prefix && workspace.closing === false,
        "postcondition_failed", "Created Workspace did not match the recorded prefix")
      string(workspace.id, "Workspace ID")
      positiveInteger(workspace.revision, "Workspace revision")
      requireCondition(array(workspace.placements, "Workspace placements").length === 0,
        "postcondition_failed", "Empty Workspace unexpectedly had a placement")
      await this.receiptStore.update(next => {
        next.globalWorkspace = { id: workspace.id, name: workspace.name, revision: workspace.revision }
        next.operations.push({ kind: "workspace_create_confirmed", atMs: Date.now(), details: {
          workspaceId: workspace.id, reconciled: weakFailure !== null
        } })
      })
      return this.#receipt()
    } catch (error) {
      await this.#markUnknown("workspace_create_unknown", {
        name: receipt.prefix,
        error: (weakFailure ?? error).code ?? "unknown"
      })
      throw weakFailure ?? error
    }
  }

  async #localNode(receipt) {
    const snapshot = await this.#json(commands.nodeSnapshot(), "node.snapshot")
    return selectLocalNode(snapshot,
      receipt.placement?.nodeId ?? receipt.preflight?.localNodeId ?? null)
  }

  async #confirmShell(reference) {
    const receipt = await this.#receipt()
    const session = receipt.sessions[reference]
    requireCondition(session && session.phase === "prepared", "ownership_conflict", "Session is not awaiting confirmation")
    const snapshot = await this.#json(commands.nodeSnapshot(), "node.snapshot")
    const node = selectLocalNode(snapshot, receipt.placement?.nodeId ?? null)
    const global = globalWorkspace(snapshot, receipt.globalWorkspace.id)
    requireCondition(global.name === receipt.prefix && array(global.placements, "Workspace placements").length === 1,
      "ownership_conflict", "Recorded global Workspace changed or gained another placement")
    const placement = placementFor(global, node.node_id, receipt.placement?.ownerWorkspaceId ?? null)
    const ownerId = string(placement.workspace_id, "owner Workspace ID")
    const owner = ownerWorkspace(node, ownerId)
    const resources = ownerResources(owner, node.node_id)
    requireCondition(resources.launchers.length === 0 && resources.agents.length === 0,
      "ownership_conflict", "Spike owner Workspace contains an unexpected Launcher or Agent")
    const confirmed = Object.values(receipt.sessions).filter(item => item.phase === "confirmed" && !item.closed)
    const expectedNames = new Set([...confirmed.map(item => item.name), session.name])
    requireCondition(resources.shells.length === expectedNames.size, "ownership_conflict",
      "Spike owner Workspace contains an unexpected Shell")
    const candidates = resources.shells.filter(item => item.raw.name === session.name)
    requireCondition(candidates.length === 1, "postcondition_failed",
      "Created Shell was not uniquely present in the owner Workspace")
    const candidate = candidates[0]
    requireCondition(candidate.workspaceId === ownerId, "identity_mismatch",
      "Created Shell did not belong to the recorded owner Workspace")
    const expectedKnown = new Set(confirmed.map(item => item.shellId))
    for (const resource of resources.shells) {
      requireCondition(resource.id === candidate.id || expectedKnown.has(resource.id), "ownership_conflict",
        "Spike owner Workspace contains an unrecorded Shell")
    }
    for (const known of confirmed) {
      const matching = resources.shells.filter(resource => resource.id === known.shellId)
      requireCondition(matching.length === 1 && matching[0].raw.name === known.name
        && exactArray(matching[0].raw.command ?? [], known.argv), "ownership_conflict",
      "A previously recorded Shell changed before this creation completed")
    }
    const inspected = await this.#inspectRawShell(candidate.id)
    requireCondition(inspected.workspaceId === ownerId && inspected.name === session.name
      && exactArray(inspected.command, session.argv) && inspected.status === "pending" && inspected.run === null,
    "postcondition_failed", "Created Shell did not match its requested pending specification")
    await this.receiptStore.update(next => {
      if (next.placement === null) {
        next.placement = {
          nodeId: node.node_id,
          ownerWorkspaceId: ownerId,
          ownerRevision: placement.owner_revision
        }
      } else {
        requireCondition(next.placement.nodeId === node.node_id && next.placement.ownerWorkspaceId === ownerId,
          "ownership_conflict", "Shell creation selected a different owner Workspace")
      }
      const target = next.sessions[reference]
      target.shellId = candidate.id
      target.cwd = inspected.cwd
      target.phase = "confirmed"
      next.operations.push({ kind: "shell_create_confirmed", atMs: Date.now(), details: {
        reference, shellId: candidate.id, ownerWorkspaceId: ownerId
      } })
    })
  }

  async #inspectRawShell(shellId) {
    const data = await this.#json(commands.shellInspect(shellId), "shell.inspect")
    return normalizeShell(data.shell)
  }

  async #recordObservedRun(reference, shell) {
    if (shell.run === null) return
    const receipt = await this.#receipt()
    const session = receipt.sessions[reference]
    if (session.runId !== null && session.runId !== shell.run.id) {
      throw adapterError("run_changed", "Boomux reported a different Run for the receipt-owned Shell", {
        reference,
        expectedRunRef: session.runRef
      })
    }
    if (session.runId === null) {
      await this.receiptStore.update(next => {
        const target = next.sessions[reference]
        target.runId = shell.run.id
        target.runRef = opaque("trr")
        next.operations.push({ kind: "run_observed", atMs: Date.now(), details: { reference } })
      })
    }
  }

  async #assertOwnedPlacement(receipt) {
    requireCondition(receipt.placement, "ownership_conflict", "No recorded Workspace placement exists")
    const snapshot = await this.#json(commands.nodeSnapshot(), "node.snapshot")
    const node = selectLocalNode(snapshot, receipt.placement?.nodeId ?? null)
    const global = globalWorkspace(snapshot, receipt.globalWorkspace.id)
    requireCondition(global.name === receipt.prefix, "ownership_conflict", "Recorded global Workspace changed")
    requireCondition(array(global.placements, "Workspace placements").length === 1,
      "ownership_conflict", "Spike Workspace has an unexpected additional placement")
    const placement = placementFor(global, node.node_id, receipt.placement.ownerWorkspaceId)
    const owner = ownerWorkspace(node, placement.workspace_id)
    const resources = ownerResources(owner, node.node_id)
    requireCondition(resources.launchers.length === 0 && resources.agents.length === 0,
      "ownership_conflict", "Spike Workspace contains an unrecorded Launcher or Agent")
    const expected = new Set(Object.values(receipt.sessions)
      .filter(session => !session.closed).map(session => session.shellId))
    requireCondition(resources.shells.length === expected.size, "ownership_conflict",
      "Spike Workspace contains an unrecorded Shell")
    for (const shell of resources.shells) {
      requireCondition(expected.has(shell.id), "ownership_conflict",
        "Spike Workspace contains an unrecorded Shell")
    }
  }

  async #expectShellAbsent(shellId) {
    try {
      await this.#inspectRawShell(shellId)
    } catch (error) {
      if (isAdapterError(error, "not_found")) return
      throw error
    }
    throw adapterError("postcondition_failed", "Boomux retained a Shell after close")
  }

  async #expectWorkspaceAbsent(workspaceId) {
    try {
      await this.#json(commands.workspaceInspect(workspaceId), "workspace.inspect")
    } catch (error) {
      if (isAdapterError(error, "not_found")) return
      throw error
    }
    throw adapterError("postcondition_failed", "Boomux retained a Workspace after close")
  }

  async #mapEvent(event, wanted, ownerWorkspaceId) {
    const eventName = string(event.event, "event name")
    if (!SUPPORTED_EVENTS.has(eventName)) return null
    const rawShellId = typeof event.shell_id === "string" ? event.shell_id : null
    const session = rawShellId === null ? null : wanted.get(rawShellId)
    const ownerMatch = typeof event.workspace_id === "string" && event.workspace_id === ownerWorkspaceId
    if (rawShellId !== null && !session) return null
    if (!session && !ownerMatch && eventName !== "handoff_completed") return null
    if (eventName === "output_changed") {
      if (!session) return null
      const rawRunId = string(event.run_id, "event Run ID")
      if (session.runId !== null && session.runId !== rawRunId) return null
    }
    const mapped = { id: event.id, atMs: event.at_ms, type: eventName }
    if (session) mapped.reference = session.reference
    if (eventName === "run_started" || eventName === "run_exited") {
      const rawRun = object(event.run, "event Run")
      string(rawRun.id, "event Run ID")
      mapped.lifecycle = eventName === "run_started" ? "running" : "exited"
      if (session && session.runId !== null && session.runId !== rawRun.id) {
        mapped.type = "run_changed"
        mapped.lifecycle = "unknown"
      } else if (session) {
        if (session.runId === null) {
          const runRef = opaque("trr")
          await this.receiptStore.update(next => {
            const target = next.sessions[session.reference]
            requireCondition(target && target.phase === "confirmed", "unknown_reference",
              "Event refers to an unknown terminal session")
            requireCondition(target.runId === null || target.runId === rawRun.id, "run_changed",
              "Boomux reported a different Run while recording an event")
            if (target.runId === null) {
              target.runId = rawRun.id
              target.runRef = runRef
              next.operations.push({ kind: "run_observed_from_event", atMs: Date.now(), details: {
                reference: session.reference
              } })
            }
            session.runId = target.runId
            session.runRef = target.runRef
          })
        }
        mapped.run = { reference: session.runRef }
      }
    }
    return mapped
  }

  async #session(reference) {
    const receipt = await this.#receipt()
    const session = receipt.sessions[reference]
    requireCondition(session && session.phase === "confirmed", "unknown_reference",
      "Reference is not a confirmed spike-owned terminal session")
    return session
  }

  async #receipt() {
    const receipt = await this.receiptStore.load()
    requireCondition(receipt !== null, "receipt_missing", "Receipt does not exist")
    return receipt
  }

  async #markUnknown(kind, details) {
    const receipt = await this.receiptStore.load()
    if (receipt !== null) await recordOperation(this.receiptStore, kind, details)
  }

  #assertNoUnknownOutcome(receipt) {
    const unknown = receipt.operations.find(operation => operation.kind.endsWith("_unknown"))
    requireCondition(!unknown, "unknown_outcome", "Operation refuses a receipt with an unknown mutation outcome")
  }

  #validateCapabilities(data) {
    requireCondition(data.cli_version === REQUIRED_CLI_VERSION, "version_mismatch",
      `Expected Boomux CLI ${REQUIRED_CLI_VERSION}`)
    requireCondition(data.daemon_protocol_version === REQUIRED_PROTOCOL, "protocol_mismatch",
      `Expected Boomux protocol ${REQUIRED_PROTOCOL}`)
    const schemas = array(data.json_schemas, "JSON schemas")
    requireCondition(schemas.includes("boomux.cli/v1"), "schema_mismatch",
      "Boomux does not advertise boomux.cli/v1")
    const advertisedCommands = array(data.json_commands, "JSON commands")
    const missingCommands = REQUIRED_JSON_COMMANDS.filter(command => !advertisedCommands.includes(command))
    requireCondition(missingCommands.length === 0, "capability_unavailable",
      `Boomux is missing JSON commands: ${missingCommands.join(", ")}`, { missingCommands })
    const features = array(data.features, "features")
    const missingFeatures = REQUIRED_FEATURES.filter(feature => !features.includes(feature))
    requireCondition(missingFeatures.length === 0, "capability_unavailable",
      `Boomux is missing features: ${missingFeatures.join(", ")}`, { missingFeatures })
    const errorCodes = array(data.error_codes, "error codes")
    const missingErrorCodes = REQUIRED_ERROR_CODES.filter(code => !errorCodes.includes(code))
    requireCondition(missingErrorCodes.length === 0, "capability_unavailable",
      `Boomux is missing stable error codes: ${missingErrorCodes.join(", ")}`, { missingErrorCodes })
  }

  async #json(argv, command) {
    const result = await this.executor.run(argv)
    if (result.exitCode === 0) return parseSuccessEnvelope(result.stdout, command)
    const candidate = result.stderr.trim() || result.stdout.trim()
    try {
      throw boomuxError(parseErrorEnvelope(candidate, command), command)
    } catch (error) {
      if (isAdapterError(error) && error.details?.kind === "boomux_error") throw error
      throw adapterError("json_command_failed", `Boomux ${command} failed without a valid JSON error envelope`, {
        command,
        exitCode: result.exitCode
      })
    }
  }

  async #weak(argv, label) {
    const result = await this.executor.run(argv)
    if (result.exitCode === 0) return result
    throw adapterError("unknown_outcome", `Weak Boomux ${label} command failed`, {
      label,
      exitCode: result.exitCode,
      argv: [...argv]
    })
  }

  async #readOnlyHuman(argv, label) {
    const result = await this.executor.run(argv)
    if (result.exitCode === 0) return { stdout: result.stdout, stderr: result.stderr }
    throw adapterError("read_only_command_failed", `Boomux ${label} failed`, {
      label,
      exitCode: result.exitCode
    })
  }
}
