import assert from "node:assert/strict"
import { test } from "node:test"

import { BoomuxRuntimeAdapter, normalizeSessionSpec } from "../lib/adapter.mjs"
import { commands } from "../lib/commands.mjs"
import { adapterError } from "../lib/errors.mjs"
import { MemoryReceiptStore, newReceipt } from "../lib/receipt.mjs"
import {
  FakeExecutor,
  IDS,
  PREFIX,
  event,
  eventData,
  failure,
  newRuntimeScenario,
  nodeSnapshot,
  runData,
  success,
  weak,
  workspaceInspectData
} from "./fixtures.mjs"

const cwd = "/tmp/omarchestra-boomux-spike"

function spec(role, sessionKey = role, argv = ["node", "probe-process.mjs", "--role", role]) {
  return { role, sessionKey, cwd, argv }
}

function adapterFrom(executor, { receiptStore = new MemoryReceiptStore(), allowGui = false } = {}) {
  return new BoomuxRuntimeAdapter({
    executor,
    receiptStore,
    prefix: PREFIX,
    teamGoalKey: "adapter-test",
    allowGui,
    pollAttempts: 3,
    pollIntervalMs: 0,
    sleepFn: async () => {}
  })
}

async function expectCode(action, code) {
  await assert.rejects(action, error => {
    assert.equal(error.code, code)
    return true
  })
}

async function createThree(adapter) {
  const references = {}
  for (const role of ["coordinator", "builder", "reviewer"]) {
    references[role] = await adapter.create(spec(role))
  }
  return references
}

function fixtureReceipt({ runId = null } = {}) {
  const receipt = newReceipt({ prefix: PREFIX, teamGoalKey: "adapter-test" })
  receipt.globalWorkspace = { id: IDS.coordinator, name: PREFIX, revision: 1 }
  receipt.placement = { nodeId: IDS.node, ownerWorkspaceId: IDS.owner, ownerRevision: 1 }
  receipt.sessions = {
    "tsr-coordinator": {
      reference: "tsr-coordinator",
      sessionKey: "coordinator",
      role: "coordinator",
      name: `${PREFIX}-coordinator`,
      requestedCwd: cwd,
      cwd,
      argv: ["node", "probe-process.mjs", "--role", "coordinator"],
      fingerprint: JSON.stringify({
        sessionKey: "coordinator", role: "coordinator", cwd,
        argv: ["node", "probe-process.mjs", "--role", "coordinator"]
      }),
      shellId: IDS.coordinatorShell,
      runId,
      runRef: runId === null ? null : "trr-coordinator",
      phase: "confirmed",
      closed: false
    }
  }
  return receipt
}

function eventAdapter(handler, receipt = fixtureReceipt()) {
  return adapterFrom(new FakeExecutor(handler), {
    receiptStore: new MemoryReceiptStore(receipt)
  })
}

test("create maps coordinator, owner, Shell, and Run IDs behind opaque references", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("coordinator"))
  const receipt = await adapter.receiptStore.load()
  const session = receipt.sessions[reference]

  assert.equal(typeof reference, "string")
  assert.notEqual(reference, IDS.coordinator)
  assert.notEqual(reference, IDS.coordinatorShell)
  assert.notEqual(reference, IDS.coordinatorRun)
  assert.equal(receipt.globalWorkspace.id, IDS.coordinator)
  assert.equal(receipt.placement.ownerWorkspaceId, IDS.owner)
  assert.equal(session.shellId, IDS.coordinatorShell)
  assert.equal(session.runId, null)
  assert.equal(reference.includes(IDS.coordinator), false)
  assert.equal(reference.includes(IDS.coordinatorShell), false)
  assert.equal(JSON.stringify({ reference }).includes(IDS.coordinator), false)

  const state = await adapter.inspect(reference)
  assert.deepEqual(state, {
    reference,
    state: "pending",
    attachment: "unavailable",
    run: null
  })
  await expectCode(() => adapter.inspect(IDS.coordinatorShell), "unknown_reference")
})

test("a pre-existing prefixed Workspace is never adopted or closed", async () => {
  const scenario = newRuntimeScenario()
  scenario.state.workspaceExists = true
  const adapter = adapterFrom(scenario.executor)
  await expectCode(() => adapter.create(spec("coordinator")), "ownership_conflict")
  assert.equal(scenario.executor.count(argv => argv[0] === "workspace" && argv[1] === "create"), 0)
  assert.equal(scenario.executor.count(argv => argv[0] === "workspace" && argv[1] === "close"), 0)
})

test("local Node eligibility is checked before Workspace mutation", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "node" && argv[1] === "snapshot") {
      return success("node.snapshot", { nodes: [], workspaces: [] })
    }
    return original(argv, options, executor)
  }
  const adapter = adapterFrom(scenario.executor)
  await expectCode(() => adapter.create(spec("coordinator")), "local_node_unavailable")
  assert.equal(scenario.executor.count(argv => argv[0] === "workspace" && argv[1] === "create"), 0)
})

test("three named Shells are created with exact argv and repeated create is idempotent", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  const references = await createThree(adapter)
  const receipt = await adapter.receiptStore.load()

  assert.deepEqual(Object.keys(references), ["coordinator", "builder", "reviewer"])
  assert.deepEqual(Object.values(receipt.sessions).map(session => session.name), [
    `${PREFIX}-coordinator`, `${PREFIX}-builder`, `${PREFIX}-reviewer`
  ])
  assert.deepEqual(scenario.executor.calls.filter(call => call.argv[0] === "shell" && call.argv[1] === "create")
    .map(call => call.argv.slice(0, 10)), [
      ["shell", "create", IDS.coordinator, "--node", IDS.node, "--name", `${PREFIX}-coordinator`,
        "--cwd", cwd, "--"],
      ["shell", "create", IDS.coordinator, "--node", IDS.node, "--name", `${PREFIX}-builder`,
        "--cwd", cwd, "--"],
      ["shell", "create", IDS.coordinator, "--node", IDS.node, "--name", `${PREFIX}-reviewer`,
        "--cwd", cwd, "--"]
    ])
  const before = scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "create")
  const same = await adapter.create(spec("builder"))
  assert.equal(same, references.builder)
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "create"), before)
  await expectCode(() => adapter.create(spec("builder", "builder", ["different", "argv"])),
    "idempotency_conflict")
})

test("pending, running, exited, and closed lifecycle states are normalized", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("builder"))
  const pending = await adapter.inspect(reference)
  assert.equal(pending.state, "pending")
  assert.equal(pending.run, null)

  const shell = scenario.state.shells.get(IDS.builderShell)
  shell.status = "running"
  shell.run = runData(IDS.builderRun, { outputRevision: 4 })
  const running = await adapter.inspect(reference)
  assert.equal(running.state, "running")
  assert.equal(running.run.reference, (await adapter.receiptStore.load()).sessions[reference].runRef)
  assert.notEqual(running.run.reference, IDS.builderRun)
  assert.equal(running.run.generation, 1)
  assert.equal(running.run.outputRevision, 4)

  shell.status = "exited"
  shell.run = runData(IDS.builderRun, {
    endedAtMs: 1_700_000_000_100, exitReason: "exited", exitCode: 0, outputRevision: 7
  })
  const exited = await adapter.inspect(reference)
  assert.equal(exited.state, "exited")
  assert.equal(exited.run.exitCode, 0)
  assert.equal(exited.run.endedAtMs, 1_700_000_000_100)

  const closed = await adapter.close(reference)
  assert.deepEqual(closed, { reference, state: "closed", changed: true })
  assert.deepEqual(await adapter.inspect(reference), {
    reference, state: "closed", attachment: "unavailable", run: null
  })
})

test("a changed Run is never silently substituted", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("reviewer"))
  const shell = scenario.state.shells.get(IDS.reviewerShell)
  shell.status = "running"
  shell.run = runData(IDS.reviewerRun, { outputRevision: 1 })
  await adapter.inspect(reference)

  shell.run = runData("run-reviewer-replacement", { generation: 2, outputRevision: 1 })
  await expectCode(() => adapter.inspect(reference), "run_changed")
  const receipt = await adapter.receiptStore.load()
  assert.equal(receipt.sessions[reference].runId, IDS.reviewerRun)
})

test("presentation requires a GUI gate and refuses exited-run restart", async t => {
  const scenario = newRuntimeScenario()
  const denied = adapterFrom(scenario.executor)
  const reference = await denied.create(spec("coordinator"))
  await expectCode(() => denied.present(reference), "gui_not_authorized")
  assert.equal(scenario.executor.count(argv => argv[0] === "open"), 0)

  await t.test("authorized presentation uses exact Shell and Workspace argv", async () => {
    const authorizedScenario = newRuntimeScenario()
    const adapter = adapterFrom(authorizedScenario.executor, { allowGui: true })
    const authorizedReference = await adapter.create(spec("coordinator"))
    const state = await adapter.present(authorizedReference)
    assert.equal(state.state, "running")
    assert.deepEqual(authorizedScenario.executor.calls.find(call => call.argv[0] === "open").argv, [
      "open", IDS.coordinatorShell, "--workspace", IDS.coordinator,
      "--title", `${PREFIX}-coordinator`, "--takeover"
    ])

    const shell = authorizedScenario.state.shells.get(IDS.coordinatorShell)
    shell.status = "exited"
    shell.run = runData(IDS.coordinatorRun, {
      endedAtMs: 1_700_000_000_100, exitReason: "exited", exitCode: 0
    })
    const before = authorizedScenario.executor.count(argv => argv[0] === "open")
    await expectCode(() => adapter.present(authorizedReference), "run_not_running")
    assert.equal(authorizedScenario.executor.count(argv => argv[0] === "open"), before)
  })
})

test("unconfirmed presentation is ambiguous and cannot be reopened automatically", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "open") return weak({ stdout: "presentation result unavailable" })
    return original(argv, options, executor)
  }
  const adapter = new BoomuxRuntimeAdapter({
    executor: scenario.executor,
    receiptStore: new MemoryReceiptStore(),
    prefix: PREFIX,
    teamGoalKey: "adapter-test",
    allowGui: true,
    pollAttempts: 1,
    pollIntervalMs: 0,
    sleepFn: async () => {}
  })
  const reference = await adapter.create(spec("coordinator"))
  await expectCode(() => adapter.present(reference), "presentation_unconfirmed")
  await expectCode(() => adapter.present(reference), "unknown_outcome")
  assert.equal(scenario.executor.count(argv => argv[0] === "open"), 1)
})

test("close is exact-ID idempotent and never accepts an unrecorded resource", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("coordinator"))
  const first = await adapter.close(reference)
  assert.deepEqual(first, { reference, state: "closed", changed: true })
  const closeCount = scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close")
  assert.deepEqual(await adapter.close(reference), { reference, state: "closed", changed: false })
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close"), closeCount)
  await expectCode(() => adapter.close(IDS.coordinatorShell), "unknown_reference")
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close"), closeCount)
})

test("cleanup closes only receipt-owned exact IDs and then the exact Workspace", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  await createThree(adapter)
  const receipt = await adapter.receiptStore.load()
  const result = await adapter.cleanup()
  assert.deepEqual(result, { state: "closed" })

  const shellCloseCalls = scenario.executor.calls.filter(call => {
    return call.argv[0] === "shell" && call.argv[1] === "close"
  })
  assert.deepEqual(shellCloseCalls.map(call => call.argv[2]), [
    IDS.coordinatorShell, IDS.builderShell, IDS.reviewerShell
  ])
  assert.deepEqual(shellCloseCalls.map(call => call.argv[4]), [IDS.owner, IDS.owner, IDS.owner])
  assert.deepEqual(scenario.executor.calls.filter(call => call.argv[0] === "workspace"
    && call.argv[1] === "close").map(call => call.argv), [
    ["workspace", "close", IDS.coordinator]
  ])
  assert.deepEqual(receipt.globalWorkspace, { id: IDS.coordinator, name: PREFIX, revision: 1 })
  const after = await adapter.receiptStore.load()
  assert.ok(after.cleanup)
})

test("cleanup refuses an unowned Shell, Launcher, or Agent before mutation", async t => {
  for (const [label, ownerChanges] of [
    ["Shell", { extraShell: true }],
    ["Launcher", { launchers: [{ id: "user-launcher" }] }],
    ["Agent", { agents: [{ id: "user-agent" }] }]
  ]) {
    await t.test(label, async () => {
      const scenario = newRuntimeScenario()
      const adapter = adapterFrom(scenario.executor)
      const reference = await adapter.create(spec("coordinator"))
      const original = scenario.executor.handler
      scenario.executor.handler = async (argv, options, executor) => {
        if (argv[0] === "node" && argv[1] === "snapshot") {
          const response = await original(argv, options, executor)
          const data = JSON.parse(response.stdout).data
          const owner = data.nodes[0].local_snapshot.workspaces[0]
          if (ownerChanges.extraShell) {
            owner.shells.push({
              id: { node_id: IDS.node, inner_id: "user-shell" },
              revision: 1,
              workspace_id: { node_id: IDS.node, inner_id: IDS.owner },
              name: "user-shell",
              cwd,
              command: ["user-shell"],
              status: "pending",
              run: null
            })
          }
          owner.launchers = ownerChanges.launchers ?? []
          owner.agents = ownerChanges.agents ?? []
          response.stdout = JSON.stringify({ ...JSON.parse(response.stdout), data })
          return response
        }
        return original(argv, options, executor)
      }
      await expectCode(() => adapter.cleanup(), "ownership_conflict")
      assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close"), 0)
      assert.equal(scenario.executor.count(argv => argv[0] === "workspace" && argv[1] === "close"), 0)
      assert.ok(reference)
    })
  }
})

test("cleanup rejects a receipt containing an unknown mutation outcome", async () => {
  const scenario = newRuntimeScenario()
  const adapter = adapterFrom(scenario.executor)
  await adapter.create(spec("coordinator"))
  await adapter.receiptStore.update(receipt => {
    receipt.operations.push({ kind: "shell_create_unknown", atMs: 1, details: {} })
  })
  await expectCode(() => adapter.cleanup(), "unknown_outcome")
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close"), 0)
})

test("weak command failure is typed unknown outcome and does not retry", async () => {
  let workspaceCreateCalls = 0
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "workspace" && argv[1] === "create") {
      workspaceCreateCalls++
      return weak({ exitCode: 1, stderr: "human command failed" })
    }
    return original(argv, options, executor)
  }
  const adapter = adapterFrom(scenario.executor)
  await expectCode(() => adapter.create(spec("coordinator")), "unknown_outcome")
  assert.equal(workspaceCreateCalls, 1)
  const receipt = await adapter.receiptStore.load()
  assert.ok(receipt.operations.some(operation => operation.kind === "workspace_create_unknown"))
})

test("an ambiguous Workspace mutation blocks later create calls without replay", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  let workspaceCreateCalls = 0
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "workspace" && argv[1] === "create") {
      workspaceCreateCalls++
      return weak({ exitCode: 1, stderr: "result unavailable" })
    }
    return original(argv, options, executor)
  }
  const adapter = adapterFrom(scenario.executor)
  await expectCode(() => adapter.create(spec("coordinator")), "unknown_outcome")
  await expectCode(() => adapter.create(spec("builder")), "unknown_outcome")
  assert.equal(workspaceCreateCalls, 1)
})

test("a weak command never treats deceptive human stdout as an identity source", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  scenario.executor.handler = async (argv, options, executor) => {
    const result = await original(argv, options, executor)
    if (argv[0] === "workspace" && argv[1] === "create") {
      result.stdout = "Created Workspace id=wrong-user-id"
    }
    return result
  }
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("coordinator"))
  const receipt = await adapter.receiptStore.load()
  assert.equal(receipt.globalWorkspace.id, IDS.coordinator)
  assert.notEqual(receipt.globalWorkspace.id, "wrong-user-id")
  assert.ok(reference)
})

test("a partial Shell create records an unknown outcome and blocks destructive cleanup", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "shell" && argv[1] === "create"
      && argv[argv.indexOf("--name") + 1] === `${PREFIX}-builder`) {
      const result = await original(argv, options, executor)
      result.exitCode = 1
      result.stderr = "human output is not a typed result"
      return result
    }
    return original(argv, options, executor)
  }
  const adapter = adapterFrom(scenario.executor)
  await adapter.create(spec("coordinator"))
  await expectCode(() => adapter.create(spec("builder")), "unknown_outcome")
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "create"
    && argv[argv.indexOf("--name") + 1] === `${PREFIX}-builder`), 1)
  await expectCode(() => adapter.cleanup(), "unknown_outcome")
  assert.equal(scenario.executor.count(argv => argv[0] === "shell" && argv[1] === "close"), 0)
})

test("an exact postcondition can reconcile a lost Workspace-create result without replay", async () => {
  const scenario = newRuntimeScenario()
  const original = scenario.executor.handler
  let workspaceCreateCalls = 0
  scenario.executor.handler = async (argv, options, executor) => {
    if (argv[0] === "workspace" && argv[1] === "create") {
      workspaceCreateCalls++
      const result = await original(argv, options, executor)
      result.exitCode = 1
      result.stderr = "result lost after commit"
      return result
    }
    return original(argv, options, executor)
  }
  const adapter = adapterFrom(scenario.executor)
  const reference = await adapter.create(spec("coordinator"))
  const receipt = await adapter.receiptStore.load()
  assert.ok(reference)
  assert.equal(workspaceCreateCalls, 1)
  assert.equal(receipt.globalWorkspace.id, IDS.coordinator)
})

test("hostile NUL argv values are rejected before any Boomux mutation", () => {
  assert.throws(() => normalizeSessionSpec({
    sessionKey: "nul", role: "builder", cwd, argv: ["node", "bad\u0000arg"]
  }), error => {
    assert.equal(error.code, "invalid_specification")
    return true
  })
})

test("event baseline maps only requested lifecycle events and returns its cursor", async () => {
  const baselineEvents = [
    event(11, "shell_created", {
      workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
      name: `${PREFIX}-coordinator`
    }, 100),
    event(15, "run_started", {
      workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
      run: runData(IDS.coordinatorRun, { outputRevision: 1 })
    }, 90)
  ]
  const adapter = eventAdapter(argv => {
    assert.deepEqual(argv, ["events", "--limit", "256", "--wait-ms", "0", "--json"])
    return success("events", eventData({
      streamId: "stream-001", cursor: "stream-001:15", snapshot: { workspaces: [] },
      events: baselineEvents
    }))
  })
  const result = await adapter.subscribe(["tsr-coordinator"], null, { waitMs: 0 })
  assert.equal(result.baseline, true)
  assert.equal(result.snapshotAvailable, true)
  assert.equal(result.cursor, "stream-001:15")
  assert.deepEqual(result.events.map(item => [item.id, item.type, item.lifecycle]), [
    [11, "shell_created", undefined], [15, "run_started", "running"]
  ])
})

test("a baseline without a snapshot is rejected instead of fabricating state", async () => {
  const adapter = eventAdapter(() => success("events", eventData({
    cursor: "stream-001:10", snapshot: null, events: []
  })))
  await expectCode(() => adapter.subscribe(["tsr-coordinator"], null, { waitMs: 0 }),
    "invalid_response")
})

test("event batches preserve event-ID order across pages and advance the cursor", async () => {
  const calls = []
  const batches = new Map([
    ["stream-001:10", eventData({
      cursor: "stream-001:14",
      events: [
        event(11, "shell_created", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
          name: `${PREFIX}-coordinator` }, 500),
        event(14, "output_changed", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
          run_id: IDS.coordinatorRun, output_revision: 4 }, 100)
      ]
    })],
    ["stream-001:14", eventData({
      cursor: "stream-001:19",
      events: [
        event(19, "run_exited", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
          run: runData(IDS.coordinatorRun, { endedAtMs: 1_700_000_000_100, exitCode: 0 }) }, 50)
      ]
    })]
  ])
  const adapter = eventAdapter(argv => {
    calls.push([...argv])
    const index = argv.indexOf("--after")
    const cursor = index < 0 ? null : argv[index + 1]
    return success("events", cursor === null
      ? eventData({ cursor: "stream-001:10", snapshot: { workspaces: [] } })
      : batches.get(cursor))
  })
  const first = await adapter.subscribe(["tsr-coordinator"], "stream-001:10", { waitMs: 0 })
  const second = await adapter.subscribe(["tsr-coordinator"], first.cursor, { waitMs: 0 })
  assert.deepEqual(first.events.map(item => item.id), [11, 14])
  assert.deepEqual(second.events.map(item => item.id), [19])
  assert.deepEqual(calls, [
    ["events", "--after", "stream-001:10", "--limit", "256", "--wait-ms", "0", "--json"],
    ["events", "--after", "stream-001:14", "--limit", "256", "--wait-ms", "0", "--json"]
  ])
})

test("filtered events preserve matching order while cursor advances over unrelated events", async () => {
  const unrelatedShell = "shell-user-001"
  const events = [
    event(20, "shell_created", { workspace_id: IDS.owner, shell_id: unrelatedShell, name: "user" }, 300),
    event(24, "run_started", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
      run: runData(IDS.coordinatorRun) }, 200),
    event(31, "output_changed", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
      run_id: "run-other", output_revision: 99 }, 100),
    event(40, "run_exited", { workspace_id: IDS.owner, shell_id: IDS.coordinatorShell,
      run: runData(IDS.coordinatorRun, { endedAtMs: 1_700_000_000_100, exitCode: 0 }) }, 50)
  ]
  const adapter = eventAdapter(argv => {
    assert.equal(argv[argv.indexOf("--after") + 1], "stream-001:10")
    return success("events", eventData({ cursor: "stream-001:40", events }))
  })
  const result = await adapter.subscribe(["tsr-coordinator"], "stream-001:10", { waitMs: 0 })
  assert.deepEqual(result.events.map(item => item.id), [24, 40])
  assert.equal(result.cursor, "stream-001:40")
})

test("cursor expiry does not replay the old cursor when baseline recovery fails", async () => {
  const calls = []
  const adapter = eventAdapter(argv => {
    calls.push([...argv])
    if (argv.includes("--after")) return failure("events", "cursor_expired", "cursor was evicted")
    return failure("events", "daemon_unavailable", "baseline unavailable")
  })
  await expectCode(() => adapter.subscribe(["tsr-coordinator"], "stream-old:99", { waitMs: 0 }),
    "daemon_unavailable")
  assert.deepEqual(calls, [
    ["events", "--after", "stream-old:99", "--limit", "256", "--wait-ms", "0", "--json"],
    ["events", "--limit", "256", "--wait-ms", "0", "--json"]
  ])
})

test("cursor expiry reseeds from a fresh baseline exactly once", async () => {
  const calls = []
  const adapter = eventAdapter(argv => {
    calls.push([...argv])
    if (argv.includes("--after")) return failure("events", "cursor_expired", "cursor was evicted")
    return success("events", eventData({
      streamId: "stream-new", cursor: "stream-new:4", snapshot: { workspaces: [] }, events: []
    }))
  })
  const result = await adapter.subscribe(["tsr-coordinator"], "stream-old:99", { waitMs: 0 })
  assert.equal(result.baseline, true)
  assert.equal(result.snapshotAvailable, true)
  assert.equal(result.cursor, "stream-new:4")
  assert.deepEqual(calls, [
    ["events", "--after", "stream-old:99", "--limit", "256", "--wait-ms", "0", "--json"],
    ["events", "--limit", "256", "--wait-ms", "0", "--json"]
  ])
})

test("stream event IDs are validated and duplicate or reverse order is rejected", async t => {
  for (const [label, events] of [
    ["duplicate", [event(12, "shell_created", { workspace_id: IDS.owner,
      shell_id: IDS.coordinatorShell, name: "a" }), event(12, "shell_closed", {
      workspace_id: IDS.owner, shell_id: IDS.coordinatorShell
    })]],
    ["reverse", [event(13, "shell_created", { workspace_id: IDS.owner,
      shell_id: IDS.coordinatorShell, name: "a" }), event(11, "shell_closed", {
      workspace_id: IDS.owner, shell_id: IDS.coordinatorShell
    })]]
  ]) {
    await t.test(label, async () => {
      const adapter = eventAdapter(() => success("events", eventData({ events })))
      await expectCode(() => adapter.subscribe(["tsr-coordinator"], "stream-001:10", { waitMs: 0 }),
        "event_order")
    })
  }
})

test("a first Run event persists an opaque exact-Run mapping", async () => {
  const receipt = fixtureReceipt()
  const adapter = eventAdapter(() => success("events", eventData({
    cursor: "stream-001:12",
    events: [event(12, "run_started", {
      workspace_id: IDS.owner,
      shell_id: IDS.coordinatorShell,
      run: runData(IDS.coordinatorRun)
    })]
  })), receipt)
  const result = await adapter.subscribe(["tsr-coordinator"], "stream-001:10", { waitMs: 0 })
  const updated = await adapter.receiptStore.load()
  const session = updated.sessions["tsr-coordinator"]
  assert.equal(session.runId, IDS.coordinatorRun)
  assert.equal(typeof session.runRef, "string")
  assert.notEqual(session.runRef, IDS.coordinatorRun)
  assert.deepEqual(result.events[0].run, { reference: session.runRef })
  assert.ok(updated.operations.some(operation => operation.kind === "run_observed_from_event"))
})

test("event payload with a different Run is reported as a Run change", async () => {
  const adapter = eventAdapter(() => success("events", eventData({ events: [
    event(25, "run_started", {
      workspace_id: IDS.owner,
      shell_id: IDS.coordinatorShell,
      run: runData("run-unexpected")
    })
  ] })), fixtureReceipt({ runId: IDS.coordinatorRun }))
  const result = await adapter.subscribe(["tsr-coordinator"], "stream-001:10", { waitMs: 0 })
  assert.deepEqual(result.events, [{
    id: 25,
    atMs: 25,
    type: "run_changed",
    reference: "tsr-coordinator",
    lifecycle: "unknown"
  }])
})

test("invalid subscription inputs fail before invoking the executor", async () => {
  const executor = new FakeExecutor(() => success("events", eventData()))
  const adapter = eventAdapter(executor.handler)
  await expectCode(() => adapter.subscribe([], null), "invalid_subscription")
  await expectCode(() => adapter.subscribe(["unknown-reference"], null), "unknown_reference")
  assert.equal(executor.calls.length, 0)
})

// Keep public fixture constructors exercised when this file is run in isolation.
assert.equal(typeof commands.workspaceInspect, "function")
assert.equal(typeof nodeSnapshot, "function")
assert.equal(typeof workspaceInspectData, "function")
