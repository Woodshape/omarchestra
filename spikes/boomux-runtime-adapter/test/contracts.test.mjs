import assert from "node:assert/strict"
import { test } from "node:test"

import { BoomuxRuntimeAdapter } from "../lib/adapter.mjs"
import { commands } from "../lib/commands.mjs"
import { boomuxError, parseErrorEnvelope, parseSuccessEnvelope } from "../lib/envelopes.mjs"
import { adapterError } from "../lib/errors.mjs"
import { MemoryReceiptStore } from "../lib/receipt.mjs"
import {
  FakeExecutor,
  IDS,
  PREFIX,
  REQUIRED_FEATURES,
  REQUIRED_JSON_COMMANDS,
  STABLE_ERROR_CODES,
  failure,
  success,
  validCapabilities,
  weak
} from "./fixtures.mjs"

function adapterFromExecutor(executor) {
  return new BoomuxRuntimeAdapter({
    executor,
    receiptStore: new MemoryReceiptStore(),
    prefix: PREFIX,
    teamGoalKey: "contract-test"
  })
}

function adapterFor(handler) {
  return adapterFromExecutor(new FakeExecutor(handler))
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => {
    assert.equal(error.code, code)
    return true
  })
}

test("command builders use the documented argv contract", () => {
  assert.deepEqual(commands.capabilities(), ["capabilities", "--json"])
  assert.deepEqual(commands.daemonStatus(), ["daemon", "status", "--json"])
  assert.deepEqual(commands.workspaceList(), ["workspace", "list", "--json"])
  assert.deepEqual(commands.workspaceInspect(IDS.coordinator), [
    "workspace", "inspect", IDS.coordinator, "--json"
  ])
  assert.deepEqual(commands.nodeSnapshot(), ["node", "snapshot", "--json"])
  assert.deepEqual(commands.list(), ["list", "--json"])
  assert.deepEqual(commands.shellInspect(IDS.coordinatorShell), [
    "shell", "inspect", IDS.coordinatorShell, "--json"
  ])
  assert.deepEqual(commands.agentList(IDS.owner), [
    "agent", "list", "--workspace", IDS.owner, "--json"
  ])
  assert.deepEqual(commands.integrationList(), ["integration", "list", "--json"])
  assert.deepEqual(commands.integrationStatus(), ["integration", "status", "--json"])
  assert.deepEqual(commands.events({ after: "stream-001:10", limit: 256, waitMs: 125 }), [
    "events", "--after", "stream-001:10", "--limit", "256", "--wait-ms", "125", "--json"
  ])
  assert.deepEqual(commands.workspaceCreate(PREFIX), ["workspace", "create", PREFIX])
  assert.deepEqual(commands.shellClose({
    shellId: IDS.coordinatorShell, ownerWorkspaceId: IDS.owner
  }), ["shell", "close", IDS.coordinatorShell, "--workspace", IDS.owner])
  assert.deepEqual(commands.workspaceClose(IDS.coordinator), [
    "workspace", "close", IDS.coordinator
  ])
  assert.deepEqual(commands.shellOpen({
    shellId: IDS.coordinatorShell, globalWorkspaceId: IDS.coordinator, title: `${PREFIX}-coordinator`
  }), [
    "open", IDS.coordinatorShell, "--workspace", IDS.coordinator,
    "--title", `${PREFIX}-coordinator`, "--takeover"
  ])
})

test("command builders preserve hostile values as individual argv entries", () => {
  const hostileName = "role;$(touch /tmp/pwned)"
  const hostileCwd = "/tmp/a path/$(printf bad)"
  const hostileArgv = ["node", "probe-process.mjs", "--role", "builder;echo bad", "line\nvalue"]
  assert.deepEqual(commands.shellCreate({
    globalWorkspaceId: IDS.coordinator,
    nodeId: IDS.node,
    name: hostileName,
    cwd: hostileCwd,
    argv: hostileArgv
  }), [
    "shell", "create", IDS.coordinator, "--node", IDS.node, "--name", hostileName,
    "--cwd", hostileCwd, "--", ...hostileArgv
  ])
  assert.deepEqual(commands.shellOpen({
    shellId: "shell;$(touch /tmp/pwned)",
    globalWorkspaceId: "workspace with spaces",
    title: "title;echo bad"
  }), [
    "open", "shell;$(touch /tmp/pwned)", "--workspace", "workspace with spaces",
    "--title", "title;echo bad", "--takeover"
  ])
})

test("success and error envelopes enforce schema and command identity", () => {
  assert.deepEqual(parseSuccessEnvelope(JSON.stringify({
    schema: "boomux.cli/v1",
    command: "shell.inspect",
    data: { shell: { id: IDS.coordinatorShell } },
    future_field: true
  }), "shell.inspect"), { shell: { id: IDS.coordinatorShell } })

  const error = parseErrorEnvelope(JSON.stringify({
    schema: "boomux.cli/v1",
    command: "shell.inspect",
    error: { code: "not_found", message: "human context" }
  }), "shell.inspect")
  assert.deepEqual(error, { code: "not_found", message: "human context" })

  assert.throws(() => parseSuccessEnvelope("not-json", "shell.inspect"), error => {
    assert.equal(error.code, "malformed_json")
    return true
  })
  assert.throws(() => parseSuccessEnvelope(JSON.stringify({
    schema: "wrong/v1", command: "shell.inspect", data: {}
  }), "shell.inspect"), error => {
    assert.equal(error.code, "schema_mismatch")
    return true
  })
  assert.throws(() => parseSuccessEnvelope(JSON.stringify({
    schema: "boomux.cli/v1", command: "workspace.inspect", data: {}
  }), "shell.inspect"), error => {
    assert.equal(error.code, "command_mismatch")
    return true
  })
  assert.throws(() => parseSuccessEnvelope(JSON.stringify({
    schema: "boomux.cli/v1", command: "shell.inspect", data: null
  }), "shell.inspect"), error => {
    assert.equal(error.code, "invalid_envelope")
    return true
  })
  assert.throws(() => parseErrorEnvelope(JSON.stringify({
    schema: "boomux.cli/v1", command: "shell.inspect", data: {}
  }), "shell.inspect"), error => {
    assert.equal(error.code, "unexpected_success_envelope")
    return true
  })
})

test("all advertised stable error codes remain typed and message-independent", () => {
  for (const code of STABLE_ERROR_CODES) {
    const parsed = parseErrorEnvelope(JSON.stringify({
      schema: "boomux.cli/v1",
      command: "shell.inspect",
      error: { code, message: `message for ${code}` }
    }), "shell.inspect")
    const typed = boomuxError(parsed, "shell.inspect")
    assert.equal(typed.code, code)
    assert.equal(typed.details.boomuxCode, code)
  }
})

test("capability negotiation accepts the pinned public contract", async () => {
  const executor = new FakeExecutor((argv) => {
    if (argv[0] === "capabilities") return success("capabilities", validCapabilities())
    if (argv[0] === "daemon") return success("daemon.status", {
      status: "running", protocol_version: 49
    })
    throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
  })
  const adapter = new BoomuxRuntimeAdapter({
    executor,
    receiptStore: new MemoryReceiptStore(),
    prefix: PREFIX,
    teamGoalKey: "contract-test"
  })
  assert.deepEqual(await adapter.capabilities(), {
    runtime: "boomux",
    version: "1.8.0",
    protocol: 49,
    lifecycle: ["pending", "running", "exited", "closed"],
    attachment: "unavailable",
    presentation: "manual_gui_gate"
  })
  assert.deepEqual(executor.calls.map(call => call.argv), [
    ["capabilities", "--json"],
    ["daemon", "status", "--json"]
  ])
  assert.deepEqual(REQUIRED_JSON_COMMANDS, validCapabilities().json_commands)
  assert.deepEqual(REQUIRED_FEATURES, validCapabilities().features)
})

test("capability mismatches fail before daemon status or mutation", async t => {
  const cases = [
    ["wrong CLI version", { cli_version: "1.7.9" }, "version_mismatch"],
    ["wrong static protocol", { daemon_protocol_version: 48 }, "protocol_mismatch"],
    ["missing schema", { json_schemas: [] }, "schema_mismatch"],
    ["missing command", { json_commands: REQUIRED_JSON_COMMANDS.slice(1) }, "capability_unavailable"],
    ["missing feature", { features: REQUIRED_FEATURES.slice(1) }, "capability_unavailable"],
    ["missing stable error code", {
      error_codes: STABLE_ERROR_CODES.filter(code => code !== "not_found")
    }, "capability_unavailable"]
  ]
  for (const [name, override, expected] of cases) {
    await t.test(name, async () => {
      const executor = new FakeExecutor(argv => {
        if (argv[0] === "capabilities") return success("capabilities", validCapabilities(override))
        throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
      })
      const adapter = new BoomuxRuntimeAdapter({
        executor,
        receiptStore: new MemoryReceiptStore(),
        prefix: PREFIX,
        teamGoalKey: "contract-test"
      })
      await rejectsCode(() => adapter.capabilities(), expected)
      assert.deepEqual(executor.calls.map(call => call.argv), [["capabilities", "--json"]])
    })
  }
})

test("malformed capability JSON fails closed without contacting the daemon", async () => {
  const executor = new FakeExecutor(argv => {
    if (argv[0] === "capabilities") return weak({ stdout: "not-json" })
    throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
  })
  const adapter = new BoomuxRuntimeAdapter({
    executor,
    receiptStore: new MemoryReceiptStore(),
    prefix: PREFIX,
    teamGoalKey: "contract-test"
  })
  await rejectsCode(() => adapter.capabilities(), "malformed_json")
  assert.equal(executor.calls.length, 1)
})

test("missing Boomux executable is typed and never triggers daemon start", async () => {
  const executor = new FakeExecutor(() => {
    throw adapterError("binary_unavailable", "Could not start boomux")
  })
  const adapter = adapterFromExecutor(executor)
  await rejectsCode(() => adapter.capabilities(), "binary_unavailable")
  assert.equal(executor.calls.length, 1)
})

test("stopped or incompatible daemon is rejected without an implicit start", async t => {
  for (const [name, status, expected] of [
    ["stopped", { status: "stopped", protocol_version: null }, "daemon_unavailable"],
    ["old protocol", { status: "running", protocol_version: 48 }, "daemon_protocol_mismatch"]
  ]) {
    await t.test(name, async () => {
      const executor = new FakeExecutor(argv => {
        if (argv[0] === "capabilities") return success("capabilities", validCapabilities())
        if (argv[0] === "daemon") return success("daemon.status", status)
        throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
      })
      const adapter = new BoomuxRuntimeAdapter({
        executor,
        receiptStore: new MemoryReceiptStore(),
        prefix: PREFIX,
        teamGoalKey: "contract-test"
      })
      await rejectsCode(() => adapter.capabilities(), expected)
      assert.deepEqual(executor.calls.map(call => call.argv), [
        ["capabilities", "--json"],
        ["daemon", "status", "--json"]
      ])
      assert.equal(executor.count(argv => argv[0] === "daemon" && argv[1] !== "status"), 0)
    })
  }
})

test("stable JSON errors preserve Boomux code and do not parse message text", async () => {
  const executor = new FakeExecutor(argv => {
    if (argv[0] === "capabilities") return success("capabilities", validCapabilities())
    if (argv[0] === "daemon") return success("daemon.status", { status: "running", protocol_version: 49 })
    if (argv[0] === "workspace" && argv[1] === "list") {
      return failure("workspace.list", "not_found", "message changed to not_found-looking prose")
    }
    if (argv[0] === "workspace" && argv[1] === "inspect") {
      return success("workspace.inspect", { workspace: {} })
    }
    if (argv[0] === "node") return success("node.snapshot", { nodes: [] })
    if (argv[0] === "list") return success("list", { shells: [] })
    if (argv[0] === "agent") return success("agent.list", { agents: [] })
    if (argv[0] === "integration" && argv[1] === "list") {
      return success("integration.list", { integrations: [] })
    }
    if (argv[0] === "integration" && argv[1] === "status") {
      return success("integration.status", { integrations: [] })
    }
    if (argv[0] === "events") return success("events", {
      stream_id: "stream-001", cursor: "stream-001:1", snapshot: { workspaces: [] }, events: []
    })
    if (argv[0] === "config") return weak({ stdout: "read-only" })
    throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
  })
  const adapter = adapterFromExecutor(executor)
  await rejectsCode(() => adapter.preflightSnapshot(), "not_found")
  const failedCall = executor.calls.find(call => call.argv[0] === "workspace" && call.argv[1] === "list")
  assert.deepEqual(failedCall.argv, ["workspace", "list", "--json"])
})

test("nonzero JSON command without a valid error envelope is a typed weak contract failure", async () => {
  const executor = new FakeExecutor(argv => {
    if (argv[0] === "capabilities") return success("capabilities", validCapabilities())
    if (argv[0] === "daemon") return success("daemon.status", { status: "running", protocol_version: 49 })
    if (argv[0] === "workspace" && argv[1] === "list") return weak({
      exitCode: 1, stdout: "Created workspace according to a human message", stderr: "plain failure"
    })
    if (argv[0] === "workspace" && argv[1] === "inspect") {
      return success("workspace.inspect", { workspace: {} })
    }
    if (argv[0] === "node") return success("node.snapshot", { nodes: [] })
    if (argv[0] === "list") return success("list", { shells: [] })
    if (argv[0] === "agent") return success("agent.list", { agents: [] })
    if (argv[0] === "integration" && argv[1] === "list") {
      return success("integration.list", { integrations: [] })
    }
    if (argv[0] === "integration" && argv[1] === "status") {
      return success("integration.status", { integrations: [] })
    }
    if (argv[0] === "events") return success("events", {
      stream_id: "stream-001", cursor: "stream-001:1", snapshot: { workspaces: [] }, events: []
    })
    if (argv[0] === "config") return weak({ stdout: "read-only" })
    throw adapterError("unexpected_fake_call", `Unexpected call ${argv.join(" ")}`)
  })
  const adapter = adapterFromExecutor(executor)
  await rejectsCode(() => adapter.preflightSnapshot(), "json_command_failed")
})

test("the fake executor rejects accidental real GUI and unplanned commands", async () => {
  const executor = new FakeExecutor(() => {
    throw adapterError("unexpected_fake_call", "real or unplanned command")
  })
  await assert.rejects(() => executor.run(["open", IDS.coordinatorShell]), error => {
    assert.equal(error.code, "unexpected_fake_call")
    return true
  })
  await assert.rejects(() => executor.run(["daemon", "stop"]), error => {
    assert.equal(error.code, "unexpected_fake_call")
    return true
  })
})
