import { adapterError } from "../lib/errors.mjs"

export const PREFIX = "omarchestra-boomux-spike-00000000-0000-4000-8000-000000000001"

export const IDS = Object.freeze({
  node: "local-001",
  coordinator: "coord-001",
  owner: "owner-001",
  coordinatorShell: "shell-coordinator-001",
  builderShell: "shell-builder-001",
  reviewerShell: "shell-reviewer-001",
  coordinatorRun: "run-coordinator-001",
  builderRun: "run-builder-001",
  reviewerRun: "run-reviewer-001"
})

export const REQUIRED_JSON_COMMANDS = Object.freeze([
  "capabilities", "daemon.status", "workspace.list", "workspace.inspect", "node.snapshot",
  "list", "shell.inspect", "agent.list", "integration.list", "integration.status", "events"
])

export const REQUIRED_FEATURES = Object.freeze([
  "typed_errors", "shell_run_identity", "daemon_events", "reconnectable_event_cursors",
  "global_workspaces", "multi_node_workspace_placements", "hyprland_special_workspaces",
  "coordinated_shell_desktop_placement", "protocol_49"
])

export const STABLE_ERROR_CODES = Object.freeze([
  "invalid_argument", "not_found", "already_exists", "busy", "daemon_stopping",
  "daemon_unavailable", "shell_start_failed", "persistence_failed", "timeout",
  "unsupported_version", "install_required", "upgrade_required",
  "bootstrap_authentication_failed", "bootstrap_transport_failed", "bootstrap_malformed_helper",
  "bootstrap_unsupported_platform", "bootstrap_install_failed", "bootstrap_commit_outcome_unknown",
  "bootstrap_runtime_unavailable", "node_identity_conflict", "cursor_expired", "run_changed",
  "revision_ahead", "idempotency_expired", "node_identity_unavailable",
  "node_registration_unavailable", "node_identity_changed", "revision_changed",
  "context_required", "ambiguous_target", "unsupported_integration", "internal", "unknown"
])

export function validCapabilities(overrides = {}) {
  return {
    cli_version: "1.8.0",
    daemon_protocol_version: 49,
    json_schemas: ["boomux.cli/v1"],
    json_commands: [...REQUIRED_JSON_COMMANDS],
    features: [...REQUIRED_FEATURES],
    error_codes: [...STABLE_ERROR_CODES],
    ...overrides
  }
}

export function success(command, data, { exitCode = 0, stdout = null, stderr = "" } = {}) {
  return {
    exitCode,
    signal: null,
    stdout: stdout ?? JSON.stringify({ schema: "boomux.cli/v1", command, data }),
    stderr
  }
}

export function failure(command, code, message = "human context", {
  exitCode = 1,
  stdout = "",
  stderr = null
} = {}) {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr: stderr ?? JSON.stringify({
      schema: "boomux.cli/v1",
      command,
      error: { code, message }
    })
  }
}

export function weak({ exitCode = 0, stdout = "", stderr = "" } = {}) {
  return { exitCode, signal: null, stdout, stderr }
}

export class FakeExecutor {
  constructor(handler = null) {
    this.handler = handler
    this.calls = []
  }

  async run(argv, options = {}) {
    const copy = [...argv]
    this.calls.push({ argv: copy, options: { ...options } })
    if (!this.handler) {
      throw adapterError("unexpected_fake_call", `Unexpected fake command: ${copy.join(" ")}`)
    }
    const result = await this.handler(copy, options, this)
    if (!result) throw adapterError("unexpected_fake_call", `No fake response: ${copy.join(" ")}`)
    return { argv: copy, signal: null, stdout: "", stderr: "", ...result }
  }

  count(predicate = () => true) {
    return this.calls.filter(call => predicate(call.argv, call.options)).length
  }

  last() {
    return this.calls[this.calls.length - 1]
  }
}

export function qualified(innerId, nodeId = IDS.node) {
  return { node_id: nodeId, inner_id: innerId }
}

export function runData(id, { generation = 1, endedAtMs = null, exitReason = null,
  exitCode = null, outputRevision = 0, environmentHasRunId = true } = {}) {
  return {
    id,
    generation,
    started_at_ms: 1_700_000_000_000,
    ended_at_ms: endedAtMs,
    exit_reason: exitReason,
    exit_code: exitCode,
    output_revision: outputRevision,
    environment_has_run_id: environmentHasRunId
  }
}

export function shellData(id, workspaceId, name, command, {
  status = "pending", run = null, cwd = "/tmp/boomux-spike", revision = 1
} = {}) {
  return {
    id,
    revision,
    workspace_id: workspaceId,
    workspace_name: "owner",
    name,
    cwd,
    command: [...command],
    status,
    exit_code: status === "exited" ? (run?.exit_code ?? null) : null,
    foreground_process: null,
    run
  }
}

export function ownerShellData(shell, nodeId = IDS.node) {
  return {
    id: qualified(shell.id, nodeId),
    revision: shell.revision ?? 1,
    workspace_id: qualified(shell.workspace_id, nodeId),
    name: shell.name,
    cwd: shell.cwd,
    command: [...(shell.command ?? [])],
    status: shell.status,
    run: shell.run ?? null
  }
}

export function ownerWorkspaceData(shells = [], {
  id = IDS.owner, nodeId = IDS.node, name = "owner", revision = 1,
  launchers = [], agents = []
} = {}) {
  return {
    id: qualified(id, nodeId),
    revision,
    name,
    default_cwd: "/tmp/boomux-spike",
    shells: shells.map(shell => ownerShellData(shell, nodeId)),
    launchers: [...launchers],
    agents: [...agents]
  }
}

export function globalWorkspaceData({ id = IDS.coordinator, name = PREFIX, revision = 1,
  closing = false, placements = [] } = {}) {
  return { id, revision, name, closing, placements: [...placements] }
}

export function placementData({ nodeId = IDS.node, ownerId = IDS.owner, ownerRevision = 1,
  state = "active", defaultCwd = "/tmp/boomux-spike" } = {}) {
  return {
    node_id: nodeId,
    workspace_id: ownerId,
    owner_revision: ownerRevision,
    state,
    default_cwd: defaultCwd
  }
}

export function nodeSnapshot({ globalWorkspace = null, ownerShells = [], owner = {},
  nodeId = IDS.node, nodes = null } = {}) {
  const node = {
    node_id: nodeId,
    alias: "local",
    local: true,
    current: true,
    stale: false,
    health: "online",
    observed_at_ms: 1_700_000_000_000,
    workspace_owner_eligible: true,
    workspace_owner_unavailable_reason: null,
    local_snapshot: {
      workspaces: [ownerWorkspaceData(ownerShells, { ...owner, id: owner.ownerId ?? IDS.owner, nodeId })]
    },
    remote_projection: null
  }
  return {
    nodes: nodes ?? [node],
    workspaces: globalWorkspace === null ? [] : [globalWorkspace]
  }
}

export function workspaceInspectData(workspace = {}) {
  return { workspace: globalWorkspaceData(workspace) }
}

export function shellInspectData(shell) {
  return { shell }
}

export function eventData({ streamId = "stream-001", cursor = `${streamId}:10`, snapshot = null,
  events = [] } = {}) {
  return { stream_id: streamId, cursor, snapshot, events: [...events] }
}

export function event(id, eventName, fields = {}, atMs = id) {
  return { id, at_ms: atMs, event: eventName, ...fields }
}

export function newRuntimeScenario({ prefix = PREFIX, eventBatches = new Map(),
  baselineEvents = [] } = {}) {
  const state = {
    prefix,
    workspaceExists: false,
    workspaceClosed: false,
    placement: null,
    shells: new Map(),
    eventBatches,
    baselineEvents,
    nextShellNumber: 1,
    nextRunNumber: 1
  }

  function currentGlobalWorkspace() {
    return globalWorkspaceData({
      id: IDS.coordinator,
      name: prefix,
      placements: state.placement ? [state.placement] : []
    })
  }

  function currentNodeSnapshot() {
    return nodeSnapshot({
      globalWorkspace: state.workspaceExists ? currentGlobalWorkspace() : null,
      ownerShells: [...state.shells.values()]
    })
  }

  function shellIdFor(name) {
    if (name.endsWith("-coordinator")) return IDS.coordinatorShell
    if (name.endsWith("-builder")) return IDS.builderShell
    if (name.endsWith("-reviewer")) return IDS.reviewerShell
    const id = `shell-generated-${String(state.nextShellNumber++).padStart(3, "0")}`
    return id
  }

  function runIdFor(shell) {
    if (shell.id === IDS.coordinatorShell) return IDS.coordinatorRun
    if (shell.id === IDS.builderShell) return IDS.builderRun
    if (shell.id === IDS.reviewerShell) return IDS.reviewerRun
    return `run-generated-${String(state.nextRunNumber++).padStart(3, "0")}`
  }

  async function handler(argv) {
    const key = argv.slice(0, 2).join(" ")
    if (argv[0] === "capabilities") return success("capabilities", validCapabilities())
    if (key === "daemon status") return success("daemon.status", {
      status: "running", protocol_version: 49, socket_path: "/run/user/1000/boomux.sock",
      pid: 4001, executable: "/home/user/.local/bin/boomux", socket_device: 1, socket_inode: 2
    })
    if (argv[0] === "events") {
      const afterIndex = argv.indexOf("--after")
      if (afterIndex < 0) {
        return success("events", eventData({
          cursor: "stream-001:10", snapshot: { workspaces: [] }, events: state.baselineEvents
        }))
      }
      const cursor = argv[afterIndex + 1]
      return success("events", state.eventBatches.get(cursor) ?? eventData({
        cursor, events: []
      }))
    }
    if (key === "workspace create") {
      state.workspaceExists = true
      state.workspaceClosed = false
      return weak({ stdout: `Created Workspace ${prefix}` })
    }
    if (key === "workspace inspect") {
      const target = argv[2]
      if (!state.workspaceExists || target !== prefix && target !== IDS.coordinator) {
        return failure("workspace.inspect", "not_found", "workspace is absent")
      }
      return success("workspace.inspect", workspaceInspectData({
        id: IDS.coordinator,
        name: prefix,
        placements: state.placement ? [state.placement] : []
      }))
    }
    if (key === "node snapshot") return success("node.snapshot", currentNodeSnapshot())
    if (key === "shell create") {
      const name = argv[argv.indexOf("--name") + 1]
      const cwd = argv[argv.indexOf("--cwd") + 1]
      const commandStart = argv.indexOf("--") + 1
      const command = argv.slice(commandStart)
      const shell = {
        id: shellIdFor(name),
        workspace_id: IDS.owner,
        name,
        cwd,
        command,
        status: "pending",
        run: null,
        revision: 1
      }
      state.shells.set(shell.id, shell)
      state.placement ??= placementData()
      return weak({ stdout: `Created pending shell ${name} (${shell.id})` })
    }
    if (key === "shell inspect") {
      const shell = state.shells.get(argv[2])
      if (!shell) return failure("shell.inspect", "not_found", "shell is absent")
      return success("shell.inspect", shellInspectData(shellData(shell.id, shell.workspace_id,
        shell.name, shell.command, {
          status: shell.status, run: shell.run, cwd: shell.cwd, revision: shell.revision
        })))
    }
    if (argv[0] === "open") {
      const shell = state.shells.get(argv[1])
      if (!shell) return weak({ exitCode: 1, stderr: "shell is absent" })
      shell.status = "running"
      shell.run = runData(runIdFor(shell), { outputRevision: 1 })
      return weak({ stdout: `Opened shell ${shell.id}` })
    }
    if (key === "shell close") {
      state.shells.delete(argv[2])
      return weak({ stdout: `Closed shell ${argv[2]}` })
    }
    if (key === "workspace close") {
      state.workspaceExists = false
      state.workspaceClosed = true
      state.placement = null
      state.shells.clear()
      return weak({ stdout: `Closed workspace ${argv[2]}` })
    }
    if (argv[0] === "list") return success("list", { shells: [] })
    if (key === "workspace list") return success("workspace.list", {
      workspaces: state.workspaceExists ? [currentGlobalWorkspace()] : [], external_workspaces: []
    })
    if (key === "agent list") return success("agent.list", { agents: [] })
    if (key === "integration list") return success("integration.list", { integrations: [] })
    if (key === "integration status") return success("integration.status", { integrations: [] })
    if (argv[0] === "config" && argv[1] === "path") return weak({ stdout: "/tmp/boomux-config" })
    if (argv[0] === "config" && argv[1] === "validate") return weak({ stdout: "configuration valid" })
    throw adapterError("unexpected_fake_call", `Unhandled scenario command: ${argv.join(" ")}`)
  }

  return { state, executor: new FakeExecutor(handler) }
}
