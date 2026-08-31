import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  boomuxCommands,
  sshRemoteEnvInvocation,
  sshRemoteHelperInvocation,
  sudoProbeInvocation,
  systemctlShowInvocation,
  systemctlStopInvocation,
  systemdRunInvocation
} from "../lib/commands.mjs"
import { parseErrorEnvelope, parseSuccessEnvelope, resultFromExecution } from "../lib/envelopes.mjs"
import { DirectArgvExecutor } from "../lib/executor.mjs"
import {
  parseOptions,
  validateAbsolutePath,
  validateNodeAlias,
  validateSshTarget,
  validateUuid
} from "../lib/validation.mjs"
import { AGENT_RUNS, IDS, INPUTS, PREFIX } from "./fixtures.mjs"

const unit = `${PREFIX}.service`
const bindings = {
  coordinator: { agentRunId: AGENT_RUNS.coordinator, shellId: IDS.coordinatorShell },
  builder: { agentRunId: AGENT_RUNS.builder, shellId: IDS.builderShell },
  reviewer: { agentRunId: AGENT_RUNS.reviewer, shellId: IDS.reviewerShell }
}

test("strict validators accept exact configured forms and reject option injection", () => {
  assert.equal(validateNodeAlias(INPUTS.nodeAlias), INPUTS.nodeAlias)
  assert.equal(validateUuid(IDS.node), IDS.node)
  assert.equal(validateSshTarget(INPUTS.sshTarget), INPUTS.sshTarget)
  assert.equal(validateAbsolutePath(INPUTS.remoteRepo), INPUTS.remoteRepo)
  for (const value of ["-host", "user@host -oProxyCommand=x", "user@@host", "root@host\ncmd"]) {
    assert.throws(() => validateSshTarget(value))
  }
  for (const value of ["../repo", "/srv/../root", "/srv/repo;id", "/srv/repo path", "/srv/repo/"]) {
    assert.throws(() => validateAbsolutePath(value))
  }
  for (const value of ["-alias", IDS.node, "alias/name", "alias space"]) {
    assert.throws(() => validateNodeAlias(value))
  }
})

test("CLI option parser rejects missing unknown and duplicate inputs", () => {
  const specification = {
    alias: { required: true, validate: validateNodeAlias },
    authorize: { boolean: true }
  }
  assert.deepEqual(parseOptions(["--alias", "node-a", "--authorize"], specification), {
    alias: "node-a", authorize: true
  })
  assert.throws(() => parseOptions([], specification), error => error.code === "invalid_arguments")
  assert.throws(() => parseOptions(["--unknown", "x"], specification))
  assert.throws(() => parseOptions(["--alias", "a", "--alias", "b"], specification))
})

test("Boomux builders emit the exact documented public argv", () => {
  assert.deepEqual(boomuxCommands.capabilities(), ["capabilities", "--json"])
  assert.deepEqual(boomuxCommands.nodeInspect(INPUTS.nodeAlias),
    ["node", "inspect", INPUTS.nodeAlias, "--json"])
  assert.deepEqual(boomuxCommands.nodeSnapshot(IDS.node),
    ["node", "snapshot", IDS.node, "--json"])
  assert.deepEqual(boomuxCommands.workspaceCreateEmpty(PREFIX),
    ["workspace", "create", PREFIX])
  assert.deepEqual(boomuxCommands.shellCreate({
    globalWorkspaceId: IDS.global,
    nodeSelector: IDS.node,
    name: `${PREFIX}-builder`,
    cwd: INPUTS.remoteRepo,
    argv: [INPUTS.executables.remoteEnv, "ROLE=builder", INPUTS.executables.remotePi,
      "--no-extensions", "-e", `${INPUTS.remoteRepo}/spikes/remote-execution-node/bridge-extension.js`]
  }), [
    "shell", "create", IDS.global, "--node", IDS.node,
    "--name", `${PREFIX}-builder`, "--cwd", INPUTS.remoteRepo, "--",
    INPUTS.executables.remoteEnv, "ROLE=builder", INPUTS.executables.remotePi,
    "--no-extensions", "-e", `${INPUTS.remoteRepo}/spikes/remote-execution-node/bridge-extension.js`
  ])
  assert.deepEqual(boomuxCommands.openRemote({
    shellId: IDS.builderShell, nodeSelector: IDS.node,
    globalWorkspaceId: IDS.global, title: `${PREFIX}-builder`
  }), [
    "open", IDS.builderShell, "--node", IDS.node, "--workspace", IDS.global,
    "--title", `${PREFIX}-builder`, "--takeover"
  ])
  assert.deepEqual(boomuxCommands.shellClose({ shellId: IDS.builderShell, workspaceId: IDS.global }),
    ["shell", "close", IDS.builderShell, "--workspace", IDS.global])
  assert.deepEqual(boomuxCommands.events({ after: "stream-a:12", limit: 10, waitMs: 50 }),
    ["events", "--after", "stream-a:12", "--limit", "10", "--wait-ms", "50", "--json"])
})

test("config and integration preservation builders emit the documented public read-only argv", () => {
  assert.deepEqual(boomuxCommands.integrationList(), ["integration", "list", "--json"])
  assert.deepEqual(boomuxCommands.integrationStatus(), ["integration", "status", "--json"])
  assert.deepEqual(boomuxCommands.configPath(), ["config", "path"])
  assert.deepEqual(boomuxCommands.configValidate(), ["config", "validate"])
})

test("SSH and systemd builders retain exact executable and argument boundaries", () => {
  assert.deepEqual(sshRemoteHelperInvocation({
    sshPath: INPUTS.executables.ssh,
    target: INPUTS.sshTarget,
    remoteNodePath: INPUTS.executables.remoteNode,
    remoteHelperPath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/remote-helper.mjs`,
    action: "control-proxy",
    args: ["--receipt-id", IDS.receipt]
  }), {
    binary: INPUTS.executables.ssh,
    argv: ["-T", "-o", "BatchMode=yes", "--", INPUTS.sshTarget,
      INPUTS.executables.remoteNode,
      `${INPUTS.remoteRepo}/spikes/remote-execution-node/remote-helper.mjs`,
      "control-proxy", "--receipt-id", IDS.receipt]
  })
  assert.throws(() => sshRemoteHelperInvocation({
    sshPath: INPUTS.executables.ssh,
    target: INPUTS.sshTarget,
    remoteNodePath: INPUTS.executables.remoteNode,
    remoteHelperPath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/remote-helper.mjs`,
    action: "control-proxy",
    args: ["value;touch", "/tmp/unsafe"]
  }), error => error.code === "invalid_argv")
  assert.deepEqual(sudoProbeInvocation(INPUTS.executables.remoteSudo), {
    binary: INPUTS.executables.remoteSudo, argv: ["-n", "--", "true"]
  })
  const start = systemdRunInvocation({
    systemdRunPath: INPUTS.executables.remoteSystemdRun,
    unit,
    nodePath: INPUTS.executables.remoteNode,
    runnerPath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/runner.mjs`,
    socketPath: `/run/user/1001/${PREFIX}.sock`,
    statePath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/evidence/local/${PREFIX}.state.json`,
    teamGoalId: IDS.team,
    receiptId: IDS.receipt,
    bindings
  })
  assert.equal(start.binary, INPUTS.executables.remoteSystemdRun)
  assert.deepEqual(start.argv.slice(0, 7),
    ["--user", "--unit", unit, "--service-type=exec", "--quiet", "--", INPUTS.executables.remoteNode])
  assert.ok(start.argv.includes("--bindings"))
  assert.deepEqual(systemctlShowInvocation({ systemctlPath: INPUTS.executables.remoteSystemctl, unit }).argv,
    ["--user", "show", unit, "--property=Id,LoadState,ActiveState,SubState,MainPID", "--no-pager"])
  assert.deepEqual(systemctlStopInvocation({ systemctlPath: INPUTS.executables.remoteSystemctl, unit }).argv,
    ["--user", "stop", unit])
})

test("boomux.cli/v1 envelopes are strict and preserve typed failures", () => {
  const success = JSON.stringify({ schema: "boomux.cli/v1", command: "node.inspect", data: { ok: true } })
  assert.deepEqual(parseSuccessEnvelope(success, "node.inspect"), { ok: true })
  const failure = JSON.stringify({ schema: "boomux.cli/v1", command: "node.inspect",
    error: { code: "node_identity_changed", message: "human context" } })
  assert.deepEqual(parseErrorEnvelope(failure, "node.inspect"),
    { code: "node_identity_changed", message: "human context" })
  assert.throws(() => resultFromExecution({ exitCode: 1, stdout: "", stderr: failure }, "node.inspect"),
    error => error.code === "node_identity_changed" && error.details.boomuxCode === "node_identity_changed")
  assert.throws(() => parseSuccessEnvelope(`${success}\n${success}`, "node.inspect"))
  assert.throws(() => parseSuccessEnvelope(JSON.stringify({ schema: "wrong", command: "node.inspect", data: {} }),
    "node.inspect"))
  assert.throws(() => parseSuccessEnvelope(JSON.stringify({ schema: "boomux.cli/v1", command: "node.inspect",
    data: {}, error: {} }), "node.inspect"))
})

test("direct executor source fixes shell execution off and callers must supply exact argv", async () => {
  assert.equal(typeof DirectArgvExecutor, "function")
  const source = await readFile(new URL("../lib/executor.mjs", import.meta.url), "utf8")
  assert.match(source, /spawn\(this\.binary, exactArgv/)
  assert.match(source, /shell:\s*false/)
  assert.doesNotMatch(source, /\bexec\s*\(/)
  assert.doesNotMatch(source, /shell:\s*true/)
})

test("runtime-dependent SSH invocations carry the receipt-bound runtime directory", () => {
  const invocation = sshRemoteEnvInvocation({
    sshPath: INPUTS.executables.ssh,
    target: INPUTS.sshTarget,
    remoteEnv: INPUTS.executables.remoteEnv,
    runtimeDirectory: "/run/user/1001",
    remoteExecutable: INPUTS.executables.remoteBoomux,
    args: ["capabilities", "--json"]
  })
  assert.deepEqual(invocation, {
    binary: INPUTS.executables.ssh,
    argv: ["-T", "-o", "BatchMode=yes", "--", INPUTS.sshTarget,
      INPUTS.executables.remoteEnv, "XDG_RUNTIME_DIR=/run/user/1001",
      INPUTS.executables.remoteBoomux, "capabilities", "--json"]
  })
  assert.throws(() => sshRemoteEnvInvocation({
    sshPath: INPUTS.executables.ssh, target: INPUTS.sshTarget,
    remoteEnv: INPUTS.executables.remoteEnv, runtimeDirectory: "relative/xdg",
    remoteExecutable: INPUTS.executables.remoteBoomux, args: []
  }), error => error.code === "invalid_path")
})
