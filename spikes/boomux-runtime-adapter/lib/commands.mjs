const json = command => [...command, "--json"]

export const commands = Object.freeze({
  capabilities: () => json(["capabilities"]),
  daemonStatus: () => json(["daemon", "status"]),
  workspaceList: () => json(["workspace", "list"]),
  workspaceInspect: workspaceId => json(["workspace", "inspect", String(workspaceId)]),
  nodeSnapshot: () => json(["node", "snapshot"]),
  list: () => json(["list"]),
  shellInspect: shellId => json(["shell", "inspect", String(shellId)]),
  agentList: ownerWorkspaceId => ownerWorkspaceId === undefined
    ? json(["agent", "list"])
    : json(["agent", "list", "--workspace", String(ownerWorkspaceId)]),
  integrationList: () => json(["integration", "list"]),
  integrationStatus: () => json(["integration", "status"]),
  events: ({ after, waitMs = 0, limit = 256 } = {}) => {
    const argv = ["events"]
    if (after !== undefined && after !== null) argv.push("--after", String(after))
    argv.push("--limit", String(limit), "--wait-ms", String(waitMs), "--json")
    return argv
  },
  configPath: () => ["config", "path"],
  configValidate: () => ["config", "validate"],
  workspaceCreate: name => ["workspace", "create", String(name)],
  shellCreate: ({ globalWorkspaceId, nodeId, name, cwd, argv }) => [
    "shell", "create", String(globalWorkspaceId), "--node", String(nodeId),
    "--name", String(name), "--cwd", String(cwd), "--", ...argv.map(String)
  ],
  shellOpen: ({ shellId, globalWorkspaceId, title }) => [
    "open", String(shellId), "--workspace", String(globalWorkspaceId),
    "--title", String(title), "--takeover"
  ],
  shellClose: ({ shellId, ownerWorkspaceId }) => [
    "shell", "close", String(shellId), "--workspace", String(ownerWorkspaceId)
  ],
  workspaceClose: globalWorkspaceId => ["workspace", "close", String(globalWorkspaceId)]
})

export function commandName(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return "cli"
  if (argv[0] === "daemon" && argv[1] === "status") return "daemon.status"
  if (argv[0] === "workspace" && argv[1] === "list") return "workspace.list"
  if (argv[0] === "workspace" && argv[1] === "inspect") return "workspace.inspect"
  if (argv[0] === "node" && argv[1] === "snapshot") return "node.snapshot"
  if (argv[0] === "shell" && argv[1] === "inspect") return "shell.inspect"
  if (argv[0] === "agent" && argv[1] === "list") return "agent.list"
  if (argv[0] === "integration" && argv[1] === "list") return "integration.list"
  if (argv[0] === "integration" && argv[1] === "status") return "integration.status"
  return argv[0]
}
