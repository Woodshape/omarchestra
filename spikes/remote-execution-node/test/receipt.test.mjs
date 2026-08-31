import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { capabilities } from "./fixtures.mjs"
import {
  FileReceiptStore,
  MemoryReceiptStore,
  bindPreflight,
  validatePreflight,
  markAmbiguous,
  markAttempted,
  markConfirmed,
  newReceipt,
  recordIntent,
  recordRemotePreflight,
  recordRunner,
  recordShellRun,
  recordWorkspace,
  validateReceipt
} from "../lib/receipt.mjs"
import {
  AGENT_RUNS,
  IDS,
  INPUTS,
  PREFIX,
  preflight,
  workspaceShellMappings
} from "./fixtures.mjs"

function freshReceipt() {
  return newReceipt({
    receiptId: IDS.receipt,
    prefix: PREFIX,
    teamGoalId: IDS.team,
    agentRuns: AGENT_RUNS,
    inputs: INPUTS,
    createdAtMs: 1700000000000
  })
}

function boundReceipt() {
  return bindPreflight(freshReceipt(), preflight())
}

test("receipt starts with exact intended Team Goal and three unique Agent Runs", () => {
  const receipt = freshReceipt()
  assert.equal(receipt.preflight, null)
  assert.deepEqual(Object.keys(receipt.agentRuns).sort(), ["builder", "coordinator", "reviewer"])
  assert.equal(new Set(Object.values(receipt.agentRuns).map(run => run.id)).size, 3)
  assert.equal(receipt.inputs.expectedNodeId, IDS.node)
  assert.throws(() => recordIntent(receipt, {
    id: "op-before-preflight", kind: "workspace_create", intent: { name: PREFIX }
  }), error => error.code === "preflight_required")
})

test("private preflight binds immutably to alias target and pinned Node", () => {
  const receipt = boundReceipt()
  assert.equal(receipt.preflight.registration.nodeId, IDS.node)
  assert.throws(() => bindPreflight(receipt, preflight()),
    error => error.code === "preflight_already_bound")
  assert.throws(() => bindPreflight(freshReceipt(), preflight({
    registration: { alias: INPUTS.nodeAlias, nodeId: IDS.node,
      target: "other@example.test", revision: 7, tombstoneEpoch: 2 }
  })), error => error.code === "preflight_mismatch")
})

test("intent is durable before attempt and ambiguous outcomes block all later intents", () => {
  let receipt = recordIntent(boundReceipt(), {
    id: "workspace-create-1",
    kind: "workspace_create",
    intent: { name: PREFIX },
    atMs: 1700000000100
  })
  assert.equal(receipt.operations[0].state, "intended")
  receipt = markAttempted(receipt, "workspace-create-1", 1700000000200)
  assert.equal(receipt.operations[0].state, "attempted")
  receipt = markAmbiguous(receipt, "workspace-create-1", "transport closed", 1700000000300)
  assert.equal(receipt.operations[0].state, "ambiguous")
  assert.equal(receipt.blocked.operationId, "workspace-create-1")
  assert.throws(() => recordIntent(receipt, {
    id: "shell-create-1", kind: "shell_create", intent: { role: "builder" }
  }), error => error.code === "receipt_blocked")
  assert.throws(() => markConfirmed(receipt, "workspace-create-1", {
    globalWorkspaceId: IDS.global
  }, 1700000000400), error => error.code === "exact_readback_required")
  receipt = markConfirmed(receipt, "workspace-create-1", {
    exactReadback: true, globalWorkspaceId: IDS.global
  }, 1700000000400)
  assert.equal(receipt.blocked, null)
  assert.equal(receipt.operations[0].state, "confirmed")
})

test("crash after intent remains distinguishable from confirmed mutation", () => {
  const receipt = recordIntent(boundReceipt(), {
    id: "runner-start-1", kind: "runner_start", intent: { unit: `${PREFIX}.service` }
  })
  const restored = validateReceipt(JSON.parse(JSON.stringify(receipt)))
  assert.equal(restored.operations[0].state, "intended")
  assert.equal(Object.hasOwn(restored.operations[0], "confirmedAtMs"), false)
})

test("receipt records exact Workspace placement Shell and Run mappings", () => {
  let receipt = boundReceipt()
  receipt = recordWorkspace(receipt, {
    globalId: IDS.global,
    nodeId: IDS.node,
    ownerId: IDS.owner,
    shells: workspaceShellMappings()
  })
  assert.equal(receipt.workspace.shells.length, 3)
  assert.equal(receipt.agentRuns.builder.shellId, IDS.builderShell)
  receipt = recordShellRun(receipt, "builder", IDS.builderRun)
  assert.equal(receipt.agentRuns.builder.shellRunId, IDS.builderRun)
  assert.throws(() => recordShellRun(receipt, "builder", "run-replacement"),
    error => error.code === "run_changed")
  receipt = recordRunner(receipt, {
    unit: `${PREFIX}.service`,
    socketPath: `/run/user/1001/${PREFIX}.sock`,
    statePath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/evidence/local/${PREFIX}.state.json`,
    pid: null
  })
  assert.equal(receipt.runner.unit, `${PREFIX}.service`)
})

test("file receipt storage uses owner-only durable files and enforces them on load", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-node-receipt-"))
  try {
    const target = path.join(directory, "receipt.json")
    const store = new FileReceiptStore(target)
    await store.initialize(freshReceipt())
    const metadata = await stat(target)
    assert.equal(metadata.mode & 0o777, 0o600)
    const next = bindPreflight(await store.load(), preflight())
    await store.replace(next)
    assert.equal((await store.load()).preflight.sha256, "a".repeat(64))
    await assert.rejects(() => store.initialize(freshReceipt()),
      error => error.code === "receipt_exists")

    // A relaxed mode must be refused on every load, not only on write.
    await chmod(target, 0o644)
    await assert.rejects(() => store.load(), error => error.code === "unsafe_receipt")
    await chmod(target, 0o600)

    // A receipt owned by another UID must be refused (deterministic injected UID).
    const foreignStore = new FileReceiptStore(target, { uid: process.getuid() + 137 })
    await assert.rejects(() => foreignStore.load(), error => error.code === "unsafe_receipt")
    const ownStore = new FileReceiptStore(target, { uid: process.getuid() })
    assert.equal((await ownStore.load()).receiptId, IDS.receipt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("memory store clones values and cannot mutate persisted receipt accidentally", async () => {
  const store = new MemoryReceiptStore(freshReceipt())
  const loaded = await store.load()
  loaded.inputs.nodeAlias = "changed"
  assert.equal((await store.load()).inputs.nodeAlias, INPUTS.nodeAlias)
})

test("preflight binds the strictly validated execution runtime identity", () => {
  const document = preflight()
  const bound = validatePreflight(document)
  assert.equal(bound.execution.uid, 1001)
  assert.equal(bound.execution.runtimeDirectory, "/run/user/1001")
  // Derived source must agree with the UID.
  assert.throws(() => validatePreflight({ ...document, execution: {
    uid: 1001, runtimeDirectory: "/run/user/2002", runtimeDirectorySource: "derived_linux_uid", runtimeMode: "0700"
  }}), error => error.code === "identity_mismatch")
  assert.throws(() => validatePreflight({ ...document, execution: {
    uid: 0, runtimeDirectory: "/run/user/0", runtimeDirectorySource: "xdg_runtime_dir", runtimeMode: "0700"
  }}), error => error.code === "unsafe_execution_identity")
  assert.throws(() => validatePreflight({ ...document, execution: {
    uid: 1001, runtimeDirectory: "/run/user/1001", runtimeDirectorySource: "xdg_runtime_dir", runtimeMode: "0755"
  }}), error => error.code === "unsafe_runtime_directory")
  assert.throws(() => validatePreflight({ ...document, execution: undefined }),
    error => error.code === "invalid_preflight")
})

test("persisted remote preflight evidence is strictly validated on receipt load", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remote-node-remotepreflight-"))
  const writeFile = (await import("node:fs/promises")).writeFile
  try {
    const target = path.join(directory, "receipt.json")
    const store = new FileReceiptStore(target)
    const bound = bindPreflight(freshReceipt(), preflight())
    await store.initialize(bound)
    await store.replace(recordRemotePreflight(await store.load(), {
      schema: "omarchestra.remote-execution-node.remote-preflight/v1",
      capturedAtMs: 1700000000001,
      uid: 1001, runtimeDirectory: "/run/user/1001",
      capabilities: capabilities(),
      remoteSha256: "c".repeat(64),
      remoteConfigPresent: true,
      remoteIntegrationSha256: "e".repeat(64)
    }))
    const healthy = JSON.parse(await (await import("node:fs/promises")).readFile(target, "utf8"))
    assert.equal((await store.load()).remotePreflight.uid, 1001)

    const corrupted = new FileReceiptStore(target)
    void corrupted

    // A mutated {} remote-preflight record must be refused on load and must not
    // unlock mutations.
    const tampered = JSON.parse(await (await import("node:fs/promises")).readFile(target, "utf8"))
    tampered.remotePreflight = {}
    await writeFile(target, JSON.stringify(tampered, null, 2), { mode: 0o600 })
    await assert.rejects(() => store.load(), error => error.code === "invalid_receipt")

    // Wrong captured timestamp type, mismatched UID/runtime, bad digest.
    for (const [label, remotePreflightPatch] of [
      ["timestamp", { capturedAtMs: -5 }],
      ["uid mismatch", { uid: 2002 }],
      ["runtime mismatch", { runtimeDirectory: "/run/user/2002" }],
      ["digest type", { remoteSha256: 42 }],
      ["config presence type", { remoteConfigPresent: "yes" }]
    ]) {
      const document = JSON.parse(JSON.stringify(healthy))
      Object.assign(document.remotePreflight, remotePreflightPatch)
      const tamperedStore = JSON.stringify(document)
      await writeFile(target, tamperedStore, { mode: 0o600 })
      await assert.rejects(() => store.load(),
        error => error.code === "invalid_receipt" || error.code === "invalid_preflight"
          || error.code === "identity_mismatch",
        `expected remote-preflight tampering refusal for ${label}`)
    }

    // capabilities are validated (incomplete remote capability set refused)
    const badCaps = JSON.parse(JSON.stringify(healthy))
    badCaps.remotePreflight.capabilities.cli_version = "9.9.9"
    await writeFile(target, JSON.stringify(badCaps, null, 2), { mode: 0o600 })
    await assert.rejects(() => store.load(), error => error.code === "version_mismatch")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("preflight execution binds the raw noninteractive sudo exit as a required nonzero field", () => {
  const document = preflight()
  const bound = validatePreflight(document)
  assert.equal(bound.execution.sudoExitCode, 1)
  // sudoExitCode 0 means sudo-capable: rejected.
  assert.throws(() => validatePreflight({ ...document, execution: {
    ...document.execution, sudoExitCode: 0
  }}), error => error.code === "sudo_capable")
  assert.throws(() => validatePreflight({ ...document, execution: {
    ...document.execution, sudoExitCode: "failed"
  }}), error => "code" in error)
  assert.throws(() => validatePreflight({ ...document, execution: {
    ...document.execution, sudoExitCode: undefined
  }}), error => error.code === "invalid_preflight")
})
