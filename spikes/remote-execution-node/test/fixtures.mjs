import { REQUIRED_ERRORS, REQUIRED_FEATURES, REQUIRED_JSON_COMMANDS } from "../lib/runtime.mjs"

export const IDS = Object.freeze({
  receipt: "10000000-0000-4000-8000-000000000001",
  node: "20000000-0000-4000-8000-000000000002",
  team: "30000000-0000-4000-8000-000000000003",
  coordinatorAgent: "40000000-0000-4000-8000-000000000004",
  builderAgent: "50000000-0000-4000-8000-000000000005",
  reviewerAgent: "60000000-0000-4000-8000-000000000006",
  global: "global-workspace-1",
  owner: "owner-workspace-1",
  coordinatorShell: "shell-coordinator-1",
  builderShell: "shell-builder-1",
  reviewerShell: "shell-reviewer-1",
  coordinatorRun: "run-coordinator-1",
  builderRun: "run-builder-1",
  reviewerRun: "run-reviewer-1"
})

export const PREFIX = `omarchestra-remote-spike-${IDS.receipt}`
export const INPUTS = Object.freeze({
  nodeAlias: "remote-example",
  expectedNodeId: IDS.node,
  sshTarget: "spikeuser@example.test",
  remoteRepo: "/srv/example-repo",
  executables: {
    localBoomux: "/home/local/.local/bin/boomux",
    ssh: "/usr/bin/ssh",
    remoteNode: "/usr/bin/node",
    remoteBoomux: "/home/spikeuser/.local/bin/boomux",
    remotePi: "/home/spikeuser/.local/bin/pi",
    remoteSystemdRun: "/usr/bin/systemd-run",
    remoteSystemctl: "/usr/bin/systemctl",
    remoteSudo: "/usr/bin/sudo",
    remoteEnv: "/usr/bin/env",
    remoteRm: "/usr/bin/rm"
  }
})

export const AGENT_RUNS = Object.freeze({
  coordinator: IDS.coordinatorAgent,
  builder: IDS.builderAgent,
  reviewer: IDS.reviewerAgent
})

export function capabilities(overrides = {}) {
  return {
    cli_version: "1.8.0",
    daemon_protocol_version: 49,
    json_schemas: ["boomux.cli/v1"],
    json_commands: [...REQUIRED_JSON_COMMANDS],
    features: [...REQUIRED_FEATURES],
    error_codes: [...REQUIRED_ERRORS],
    ...overrides
  }
}

export function registration(overrides = {}) {
  return {
    registration: {
      alias: INPUTS.nodeAlias,
      target: INPUTS.sshTarget,
      node_id: IDS.node,
      revision: 7,
      tombstone_epoch: 2,
      ...overrides
    }
  }
}

export function qualified(innerId, nodeId = IDS.node) {
  return { node_id: nodeId, inner_id: innerId }
}

export function shell({ role, id, runId = null, status = runId === null ? "pending" : "running",
  cwd = INPUTS.remoteRepo, argv = [INPUTS.executables.remotePi, "--no-extensions"] }) {
  return {
    id: qualified(id),
    workspace_id: qualified(IDS.owner),
    name: `${PREFIX}-${role}`,
    cwd,
    command: [...argv],
    status,
    run: runId === null ? null : { id: runId, generation: 1 }
  }
}

export function remoteProjectionNode({ shells = [], launchers = [], agents = [], current = true,
  stale = false, health = "online" } = {}) {
  return {
    node_id: IDS.node,
    alias: INPUTS.nodeAlias,
    local: false,
    route: INPUTS.sshTarget,
    current,
    stale,
    health,
    observed_at_ms: 1234,
    observed_protocol_version: 49,
    observed_capabilities: [...REQUIRED_FEATURES],
    local_snapshot: null,
    remote_projection: {
      workspaces: [{
        id: qualified(IDS.owner),
        name: PREFIX,
        shells,
        launchers,
        agents
      }]
    }
  }
}

export function combinedSnapshot({ shells = [], workspaces = [], node = null } = {}) {
  return {
    nodes: [node ?? remoteProjectionNode({ shells })],
    workspaces
  }
}

export function directOwnerSnapshot({ shells = [], launchers = [], agents = [], extraWorkspaces = [] } = {}) {
  return {
    nodes: [{
      node_id: IDS.node,
      alias: "local",
      local: true,
      current: true,
      stale: false,
      health: "online",
      local_snapshot: {
        workspaces: [{
          id: qualified(IDS.owner),
          name: PREFIX,
          shells,
          launchers,
          agents
        }, ...extraWorkspaces]
      },
      remote_projection: null
    }]
  }
}

export function preflight(overrides = {}) {
  return {
    schema: "omarchestra.remote-execution-node.preflight/v1",
    receiptId: IDS.receipt,
    capturedAtMs: 1700000000000,
    path: "/tmp/private/preflight.json",
    sha256: "a".repeat(64),
    registration: {
      alias: INPUTS.nodeAlias,
      nodeId: IDS.node,
      target: INPUTS.sshTarget,
      revision: 7,
      tombstoneEpoch: 2
    },
    configuration: {
      localSha256: "b".repeat(64),
      localConfigPresent: true,
      localIntegrationSha256: "d".repeat(64)
    },
    baseline: {
      globalWorkspaceIds: ["preexisting-global"],
      qualifiedResourceIds: [`${IDS.node}:preexisting-owner`]
    },
    execution: {
      uid: 1001,
      runtimeDirectory: "/run/user/1001",
      runtimeDirectorySource: "derived_linux_uid",
      runtimeMode: "0700",
      sudoExitCode: 1
    },
    ...overrides
  }
}

export function workspaceShellMappings({ withRuns = false } = {}) {
  return [
    { role: "coordinator", id: IDS.coordinatorShell, cwd: INPUTS.remoteRepo,
      argv: [INPUTS.executables.remotePi, "--no-extensions"], runId: withRuns ? IDS.coordinatorRun : null },
    { role: "builder", id: IDS.builderShell, cwd: INPUTS.remoteRepo,
      argv: [INPUTS.executables.remotePi, "--no-extensions"], runId: withRuns ? IDS.builderRun : null },
    { role: "reviewer", id: IDS.reviewerShell, cwd: INPUTS.remoteRepo,
      argv: [INPUTS.executables.remotePi, "--no-extensions"], runId: withRuns ? IDS.reviewerRun : null }
  ]
}

export class FakeExecutor {
  constructor(handler) { this.handler = handler; this.calls = [] }
  async run(argv, options = {}) {
    this.calls.push({ argv: [...argv], options: structuredClone(options) })
    return this.handler([...argv], options)
  }
}

export class FakeBoomux {
  constructor(handler) { this.handler = handler; this.calls = [] }
  async json(argv, command) {
    this.calls.push({ type: "json", argv: [...argv], command })
    return this.handler({ type: "json", argv, command })
  }
  async weak(argv, label) {
    this.calls.push({ type: "weak", argv: [...argv], label })
    return this.handler({ type: "weak", argv, label })
  }
}
