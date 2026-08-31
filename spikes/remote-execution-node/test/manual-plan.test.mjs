import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildPlan, parseManualArguments } from "../manual.mjs"
import { REMOTE_IDS } from "./remote-fixtures.mjs"
import { FileReceiptStore, recordRunner, recordWorkspace } from "../lib/receipt.mjs"

const base = {
  "node-alias": "remote-example",
  "expected-node-id": "20000000-0000-4000-8000-000000000002",
  "ssh-target": "spikeuser@example.test",
  "remote-repo": "/srv/example-repo",
  "receipt-id": REMOTE_IDS.receipt,
  "team-goal-id": REMOTE_IDS.teamGoal,
  "local-boomux": "/usr/local/bin/boomux",
  ssh: "/usr/bin/ssh",
  "remote-node": "/usr/bin/node",
  "remote-boomux": "/home/spikeuser/.local/bin/boomux",
  "remote-pi": "/home/spikeuser/.local/bin/pi",
  "remote-systemd-run": "/usr/bin/systemd-run",
  "remote-systemctl": "/usr/bin/systemctl",
  "remote-sudo": "/usr/bin/sudo",
  "remote-env": "/usr/bin/env",
  "remote-rm": "/usr/bin/rm",
  "runner-path": "/srv/example-repo/spikes/remote-execution-node/runner.mjs",
  "remote-helper-path": "/srv/example-repo/spikes/remote-execution-node/remote-helper.mjs",
  "bridge-path": "/srv/example-repo/spikes/remote-execution-node/bridge-extension.js",
  "socket-path": "/run/user/1001/omarchestra-remote-spike-10000000-0000-4000-8000-000000000001.sock",
  "state-path": "/srv/example-repo/spikes/remote-execution-node/evidence/local/omarchestra-remote-spike-10000000-0000-4000-8000-000000000001.state.json",
  unit: "omarchestra-remote-spike-10000000-0000-4000-8000-000000000001.service",
  "coordinator-agent-run-id": REMOTE_IDS.coordinator,
  "builder-agent-run-id": REMOTE_IDS.builder,
  "reviewer-agent-run-id": REMOTE_IDS.reviewer,
  "coordinator-shell-id": "shell-coordinator",
  "builder-shell-id": "shell-builder",
  "reviewer-shell-id": "shell-reviewer"
}

test("manual gate parser is explicit and plan-only", async () => {
  assert.equal(parseManualArguments(["--help"]).action, "help")
  assert.throws(() => parseManualArguments(["preflight", "--unknown", "x"]), error => error.code === "invalid_arguments")
  const preflight = await buildPlan("preflight", base)
  assert.ok(preflight.commands.some(command => command.label.includes("prerequisite")))
  assert.ok(preflight.commands.some(command => command.label.includes("sudo")))
  // Mutation/presentation plans are receipt-gated, never printable from free CLI IDs.
  await assert.rejects(() => buildPlan("runner-start", { ...base, "authorize-runner": true }),
    error => error.code === "receipt_missing" || error.code === "invalid_arguments")
})

function minimalPreflightFixture() {
  return {
    schema: "omarchestra.remote-execution-node.preflight/v1",
    receiptId: REMOTE_IDS.receipt,
    capturedAtMs: 1700000000000,
    path: "/tmp/private/preflight.json",
    sha256: "a".repeat(64),
    registration: {
      alias: "remote-example", nodeId: base["expected-node-id"], target: base["ssh-target"],
      revision: 7, tombstoneEpoch: 2
    },
    configuration: {
      localSha256: "b".repeat(64),
      localConfigPresent: true,
      localIntegrationSha256: "d".repeat(64)
    },
    baseline: { globalWorkspaceIds: [], qualifiedResourceIds: [] },
    execution: {
      uid: 1001, runtimeDirectory: "/run/user/1001",
      runtimeDirectorySource: "derived_linux_uid", runtimeMode: "0700",
      sudoExitCode: 1
    }
  }
}

async function seedWorkspaceAndRunner(directory, receiptStore) {
  const store = new FileReceiptStore(receiptStore)
  let receipt = await store.load()
  const nodeId = base["expected-node-id"]
  receipt = recordWorkspace(receipt, {
    globalId: "global-workspace-1",
    nodeId,
    ownerId: "owner-workspace-1",
    shells: ["coordinator", "builder", "reviewer"].map(role => ({
      role, id: `shell-${role}`, ownerId: "owner-workspace-1",
      cwd: base["remote-repo"], argv: [base["remote-pi"], "--no-extensions"], runId: null
    }))
  })
  receipt = recordRunner(receipt, {
    unit: base.unit, socketPath: base["socket-path"], statePath: base["state-path"], pid: 4242
  })
  await store.replace(receipt)
  void directory
}

async function bindReceiptFixture(directory, receiptStore) {
  const preflightFile = path.join(directory, "preflight.json")
  await writeFile(preflightFile, JSON.stringify(minimalPreflightFixture(), null, 2))
  await buildPlan("receipt-init", { ...base, "receipt-store": receiptStore })
  await buildPlan("preflight-bind", {
    ...base, "receipt-store": receiptStore, "preflight-file": preflightFile
  })
}

test("preflight holds local fingerprints; receipt-backed phases carry runtime-env remote reads", async () => {
  // Pre-bind preflight: local config/integration fingerprints only. Runtime-dependent
  // remote reads belong to receipt-backed post-bind phases (staged ordering).
  const preflightPlan = await buildPlan("preflight", base)
  assert.ok(preflightPlan.commands.some(item => item.binary === base["local-boomux"]
    && item.argv.includes("integration")), "preflight lacks local integration read")
  assert.ok(preflightPlan.commands.some(item => item.binary === base["local-boomux"]
    && item.argv.includes("validate")), "preflight lacks local config validation")
  assert.equal(preflightPlan.commands.some(item => item.binary === base.ssh
    && item.argv.includes(base["remote-boomux"])), false,
    "pre-bind preflight must not read the remote daemon before the runtime identity is bound")

  // Receipt-backed post-bind phase: remote reads through the bound runtime env.
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-plan-remote-"))
  try {
    const receiptStore = path.join(directory, "receipt.json")
    await bindReceiptFixture(directory, receiptStore)
    const remotePlan = await buildPlan("preflight-remote", {
      ...base, "receipt-store": receiptStore
    })
    const remoteReads = remotePlan.commands.filter(item => item.binary === base.ssh)
    for (const fragment of ["integration", "list", "config", "validate"]) {
      assert.ok(JSON.stringify(remoteReads.map(item => item.argv)).includes(`"${fragment}"`),
        `preflight-remote lacks ${fragment}`)
    }
    const receipts = remotePlan.commands.filter(item => item.binary === base.ssh)
    for (const entry of receipts) {
      assert.ok(entry.argv.includes("XDG_RUNTIME_DIR=/run/user/1001"),
        "remote reads must carry the receipt-bound runtime env")
      assert.ok(entry.argv.includes(base["remote-env"]))
    }
    await seedWorkspaceAndRunner(directory, receiptStore)
    const postflight = await buildPlan("postflight", { ...base, "receipt-store": receiptStore })
    if (process.env.DBG) for (const c of postflight.commands) console.error(JSON.stringify({ binary: c.binary, argv: c.argv }))
    assert.ok(postflight.commands.some(item => item.binary === base.ssh
      && item.argv.includes("XDG_RUNTIME_DIR=/run/user/1001")
      && item.argv.includes("integration")), "postflight lacks remote integration read")
    if (process.env.DBG) {
      console.error("base.ssh:", JSON.stringify(base.ssh), "count:", postflight.commands.length)
      const dbgMatches = postflight.commands.filter(item => item.binary === base.ssh)
      console.error("ssh:", dbgMatches.length, "validate:", dbgMatches.filter(i => i.argv.includes("validate")).length,
        "xdg:", dbgMatches.filter(i => i.argv.includes("XDG_RUNTIME_DIR=")).length,
        "typeofargv:", postflight.commands.map(i => typeof i.argv).join(","))
      for (const item of postflight.commands) {
        const xdg = item.argv.find(a => typeof a === "string" && a.startsWith("XDG"))
        console.error(JSON.stringify({ binary: item.binary, validate: item.argv.includes("validate"),
          xdg, xdgElement: xdg !== undefined }))
      }
    }
    assert.ok(postflight.commands.some(item => item.binary === base.ssh
      && item.argv.includes("validate")
      && item.argv.includes("XDG_RUNTIME_DIR=/run/user/1001")),
      "postflight lacks remote config validation")
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
})

test("process evidence runs on the remote Node through SSH stdio", async () => {
  const plan = await buildPlan("process-tree", {
    ...base,
    pid: "1234",
    ps: "/usr/bin/ps",
    pstree: "/usr/bin/pstree"
  })
  assert.equal(plan.commands.length, 2)
  assert.ok(plan.commands.every(command => command.binary === base.ssh))
  assert.ok(plan.commands[0].argv.includes("/usr/bin/ps"))
  assert.ok(plan.commands[1].argv.includes("/usr/bin/pstree"))
})

test("reconnect plan includes control reconnect and runtime-env Shell Run inspection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-plan-reconnect-"))
  try {
    const receiptStore = path.join(directory, "receipt.json")
    await bindReceiptFixture(directory, receiptStore)
    await seedWorkspaceAndRunner(directory, receiptStore)
    const plan = await buildPlan("reconnect", {
      ...base, "receipt-store": receiptStore,
      "control-client-id": "desktop-reconnect",
      "authorize-control": true
    })
    assert.equal(plan.commands.length, 4)
    assert.equal(plan.commands[0].label, "authenticated SSH stdio control proxy")
    assert.equal(plan.commands.filter(command => command.label.includes("reconnect")).length, 3)
    const inspections = plan.commands.filter(command => command.label.includes("inspection"))
    for (const entry of inspections) {
      assert.ok(entry.argv.includes("XDG_RUNTIME_DIR=/run/user/1001"),
        "shell inspections must carry the receipt-bound runtime env")
      assert.ok(entry.argv.includes(base["remote-env"]))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("sync-check plan stays a read-only remote checkout check", async () => {
  const plan = await buildPlan("sync-check", base)
  assert.equal(plan.commands.length, 1)
  assert.equal(plan.mutation ?? false, false)
  assert.ok(plan.commands.every(command => command.mutation !== true))
})

function shellFixtures() {
  return [
    shell({ role: "coordinator", id: IDS.coordinatorShell, runId: IDS.coordinatorRun }),
    shell({ role: "builder", id: IDS.builderShell, runId: IDS.builderRun }),
    shell({ role: "reviewer", id: IDS.reviewerShell, runId: IDS.reviewerRun })
  ]
}
