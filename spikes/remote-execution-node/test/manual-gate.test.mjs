import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { buildPlan, parseManualArguments } from "../manual.mjs"
import { ManualGate } from "../lib/manual-gate.mjs"
import { FileReceiptStore } from "../lib/receipt.mjs"
import {
  AGENT_RUNS,
  IDS,
  INPUTS,
  PREFIX,
  capabilities,
  directOwnerSnapshot,
  preflight,
  qualified,
  shell
} from "./fixtures.mjs"

const SHELL_IDS = Object.freeze({
  coordinator: IDS.coordinatorShell,
  builder: IDS.builderShell,
  reviewer: IDS.reviewerShell
})

const base = {
  "node-alias": INPUTS.nodeAlias,
  "expected-node-id": IDS.node,
  "ssh-target": INPUTS.sshTarget,
  "remote-repo": INPUTS.remoteRepo,
  "receipt-id": IDS.receipt,
  "team-goal-id": IDS.team,
  "local-boomux": INPUTS.executables.localBoomux,
  ssh: INPUTS.executables.ssh,
  "remote-node": INPUTS.executables.remoteNode,
  "remote-boomux": INPUTS.executables.remoteBoomux,
  "remote-pi": INPUTS.executables.remotePi,
  "remote-systemd-run": INPUTS.executables.remoteSystemdRun,
  "remote-systemctl": INPUTS.executables.remoteSystemctl,
  "remote-sudo": INPUTS.executables.remoteSudo,
  "remote-env": INPUTS.executables.remoteEnv,
  "remote-rm": INPUTS.executables.remoteRm,
  "runner-path": `${INPUTS.remoteRepo}/spikes/remote-execution-node/runner.mjs`,
  "remote-helper-path": `${INPUTS.remoteRepo}/spikes/remote-execution-node/remote-helper.mjs`,
  "bridge-path": `${INPUTS.remoteRepo}/spikes/remote-execution-node/bridge-extension.js`,
  "socket-path": `/run/user/1001/${PREFIX}.sock`,
  "state-path": `${INPUTS.remoteRepo}/spikes/remote-execution-node/evidence/local/${PREFIX}.state.json`,
  unit: `${PREFIX}.service`,
  "coordinator-agent-run-id": AGENT_RUNS.coordinator,
  "builder-agent-run-id": AGENT_RUNS.builder,
  "reviewer-agent-run-id": AGENT_RUNS.reviewer,
  "coordinator-shell-id": IDS.coordinatorShell,
  "builder-shell-id": IDS.builderShell,
  "reviewer-shell-id": IDS.reviewerShell
}

function shellFixtures() {
  return [
    shell({ role: "coordinator", id: IDS.coordinatorShell, runId: IDS.coordinatorRun }),
    shell({ role: "builder", id: IDS.builderShell, runId: IDS.builderRun }),
    shell({ role: "reviewer", id: IDS.reviewerShell, runId: IDS.reviewerRun })
  ]
}

function ownerSnapshot(shells = shellFixtures()) {
  return directOwnerSnapshot({ shells })
}

function nodeIdentity() {
  return { alias: INPUTS.nodeAlias, nodeId: IDS.node, target: INPUTS.sshTarget }
}

function shellInspections(shells = shellFixtures()) {
  return Object.fromEntries(shells.map(value => [value.id.inner_id, { shell: value }]))
}

function coordinatorSnapshot() {
  return {
    workspaces: [{
      id: IDS.global,
      name: PREFIX,
      closing: false,
      placements: [{ node_id: IDS.node, workspace_id: IDS.owner, state: "active" }]
    }]
  }
}

async function writeEvidenceFile(directory, name, value) {
  const target = path.join(directory, name)
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`)
  return target
}

// Raw public JSON evidence for the empty Workspace creation readback: a before
// Workspace list without the spike prefix and an after list with exactly one new
// empty spike-named Workspace. An empty Workspace has zero placements, so no
// owner Workspace ID can exist in this evidence.
function workspaceCreationEvidence({ ambiguous = false } = {}) {
  const before = [{ id: "preexisting-global", name: "user-workspace", placements: [] }]
  const spike = { id: IDS.global, name: PREFIX, closing: false, placements: [] }
  const after = ambiguous
    ? [...before, spike, { ...spike, id: "second-new-workspace" }]
    : [...before, spike]
  return {
    beforeWorkspaceIds: before.map(workspace => workspace.id),
    afterWorkspaceList: { workspaces: after }
  }
}

// Raw public JSON evidence for one Shell creation readback: the owner Node
// snapshot plus the exact `boomux shell inspect SHELL --json` document.
function shellCreationEvidence(role, { intendedArgv, ownerId, shellId = SHELL_IDS[role],
  mutateCwd = false, mutateArgv = false } = {}) {
  const inspected = shell({
    role,
    id: shellId,
    status: "pending",
    runId: null,
    cwd: mutateCwd ? "/foreign/repo" : INPUTS.remoteRepo,
    argv: mutateArgv ? [INPUTS.executables.remotePi, "--no-extensions"] : intendedArgv[role]
  })
  inspected.workspace_id = qualified(ownerId ?? IDS.owner)
  const ownerWorkspaceId = qualified(ownerId ?? IDS.owner)
  return {
    ownerSnapshot: {
      nodes: [{
        node_id: IDS.node, alias: "local", local: true, current: true, stale: false, health: "online",
        local_snapshot: { workspaces: [{ id: ownerWorkspaceId, name: PREFIX,
          shells: [inspected], launchers: [], agents: [] }] },
        remote_projection: null
      }]
    },
    shellInspection: { shell: inspected }
  }
}

function remotePreflightEvidence() {
  return {
    capabilities: capabilities(),
    daemonStatus: { status: "running", protocol_version: 49 },
    remoteSha256: "c".repeat(64),
    remoteConfigPresent: true,
    remoteIntegrationSha256: "e".repeat(64)
  }
}

async function initReceipt(directory, { bind = true, remote = true } = {}) {
  const storePath = path.join(directory, "receipt.json")
  await buildPlan("receipt-init", { ...base, "receipt-store": storePath })
  if (bind) {
    const preflightFile = await writeEvidenceFile(directory, "preflight.json", preflight())
    await buildPlan("preflight-bind", { ...base, "receipt-store": storePath, "preflight-file": preflightFile })
    if (remote) {
      const evidenceFile = await writeEvidenceFile(directory, "remote-preflight.json", remotePreflightEvidence())
      await buildPlan("record-remote-preflight", {
        ...base, "receipt-store": storePath, "evidence-file": evidenceFile
      })
    }
  }
  return storePath
}

async function markAttempted(storePath, operationId) {
  await buildPlan("mark-attempted", { ...base, "receipt-store": storePath, "operation-id": operationId })
}

async function confirmWorkspaceCreation(directory, storePath) {
  await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
  await markAttempted(storePath, "workspace-create")
  const evidenceFile = await writeEvidenceFile(directory, "workspace-creation.json", workspaceCreationEvidence())
  await buildPlan("record-workspace-creation", {
    ...base, "receipt-store": storePath, "evidence-file": evidenceFile
  })
}

async function gateRemotePreflight(gate, directory) {
  const evidenceFile = await writeEvidenceFile(directory, "gate-remote-preflight.json", remotePreflightEvidence())
  await gate.recordRemotePreflight(evidenceFile)
  return evidenceFile
}

async function recordShellCreations(directory, storePath, { sabotage = null, ownerId = null,
  roles = ["coordinator", "builder", "reviewer"] } = {}) {
  const shellsPlan = await buildPlan("shells-create", {
    ...base, "receipt-store": storePath, "authorize-resources": true
  })
  const intendedArgv = {}
  for (const entry of shellsPlan.commands.filter(item => item.mutation === true)) {
    const role = ["coordinator", "builder", "reviewer"].find(role => entry.label.includes(role))
    if (!roles.includes(role)) continue
    intendedArgv[role] = entry.argv.slice(entry.argv.indexOf("--") + 1)
    const evidence = shellCreationEvidence(role, {
      intendedArgv,
      ownerId,
      mutateCwd: sabotage === `${role}-cwd`,
      mutateArgv: sabotage === `${role}-argv`
    })
    const evidenceFile = await writeEvidenceFile(directory, `${role}-shell-creation.json`, evidence)
    await markAttempted(storePath, `shell-create-${role}`)
    await buildPlan("record-shell-readback", {
      ...base, "receipt-store": storePath, role, "evidence-file": evidenceFile
    })
  }
  return intendedArgv
}

async function recordWorkspaceMapping(directory, storePath, { ownerId = IDS.owner } = {}) {
  const evidenceFile = await writeEvidenceFile(directory, "workspace-mapping.json", {
    workspaceInspection: {
      id: IDS.global,
      name: PREFIX,
      closing: false,
      placements: [{ node_id: IDS.node, workspace_id: ownerId, state: "active" }]
    }
  })
  await buildPlan("record-workspace-readback", {
    ...base, "receipt-store": storePath, "evidence-file": evidenceFile,
    "global-workspace-id": IDS.global, "owner-workspace-id": IDS.global
  })
}

function runnerReadbackEvidence({ activeState = "active", subState = "running", mainPid = "4242",
  socketKind = "socket", socketPath = `/run/user/1001/${PREFIX}.sock` } = {}) {
  return {
    unitShow: [
      `Id=${PREFIX}.service`,
      "LoadState=loaded",
      `ActiveState=${activeState}`,
      `SubState=${subState}`,
      `MainPID=${String(mainPid)}`
    ],
    fileStatus: {
      schema: "omarchestra.remote-execution-node.file-status/v1",
      socketPath: `${socketPath}`,
      statePath: base["state-path"],
      files: [
        { label: "socket", path: `${socketPath}`, status: "socket present",
          exists: true, kind: socketKind, mode: "0600", ownerUid: 1001 },
        { label: "state", path: base["state-path"], status: "file present",
          exists: true, kind: "file", mode: "0600", ownerUid: 1001 }
      ],
      spikePathsAbsent: false
    }
  }
}

async function recordRunnerMapping(directory, storePath) {
  await buildPlan("runner-start", { ...base, "receipt-store": storePath, "authorize-runner": true })
  await markAttempted(storePath, "runner-start")
  const runnerEvidence = await writeEvidenceFile(directory, "runner-readback.json", runnerReadbackEvidence())
  await buildPlan("record-runner-readback", {
    ...base, "receipt-store": storePath, "evidence-file": runnerEvidence
  })
}

function runInspectEvidence(role, runId) {
  return { shell: shell({ role, id: SHELL_IDS[role], runId }) }
}

async function recordRunReadbacks(directory, storePath) {
  for (const role of ["coordinator", "builder", "reviewer"]) {
    await markAttempted(storePath, `present-${role}`)
    const evidenceFile = await writeEvidenceFile(directory, `${role}-run-readback.json`,
      runInspectEvidence(role, IDS[`${role}Run`]))
    await buildPlan("record-shell-run-readback", {
      ...base, "receipt-store": storePath, role, "evidence-file": evidenceFile
    })
  }
}

test("gate parser accepts the explicit receipt actions and flags", () => {
  for (const action of ["receipt-init", "preflight-bind", "mark-attempted", "record-shell-readback",
    "record-workspace-readback", "record-workspace-creation", "record-runner-readback",
    "record-shell-run-readback", "mark-ambiguous"]) {
    assert.doesNotThrow(() => parseManualArguments([action, "--receipt-store", "/tmp/r.json"]))
  }
  assert.throws(() => parseManualArguments(["not-an-action"]), error => error.code === "invalid_arguments")
})

test("no mutation, presentation, or cleanup plan is authorized without a durable owner receipt", async () => {
  for (const [action, flags] of [
    ["workspace-create", { "authorize-resources": true }],
    ["shells-create", { "authorize-resources": true }],
    ["runner-start", { "authorize-runner": true }],
    ["present-all", { "authorize-gui": true }],
    ["cleanup", { "authorize-cleanup": true }]
  ]) {
    await assert.rejects(() => buildPlan(action, { ...base, ...flags }),
      error => error.code === "receipt_missing" || error.code === "invalid_arguments")
    await assert.rejects(() => buildPlan(action, {
      ...base, ...flags, "receipt-store": "/nonexistent/missing/gate.json"
    }), error => error.code === "receipt_missing")
  }
})

test("gated plans refuse any deviation from the immutable receipt inputs and identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-immutable-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    // The workspace-create intent exists for Node A; changed invocation inputs must be refused everywhere.
    for (const overrides of [
      { "node-alias": "other-alias" },
      { "expected-node-id": "70000000-0000-4000-8000-000000000007" },
      { "ssh-target": "other@example.test" },
      { "remote-repo": "/srv/other-repo" },
      { "local-boomux": "/other/path/boomux" },
      { "team-goal-id": "90000000-0000-4000-8000-000000000009" }
    ]) {
      await assert.rejects(() => buildPlan("workspace-create", {
        ...base, "receipt-store": storePath, "authorize-resources": true, ...overrides
      }), error => error.code === "identity_mismatch")
      await assert.rejects(() => buildPlan("record-workspace-creation", {
        ...base, "receipt-store": storePath, "evidence-file": path.join(directory, "absent.json"), ...overrides
      }), error => error.code === "identity_mismatch")
      // confirm-operation was removed: generic exact confirmation cannot bypass
      // the specialized evidence actions.
      assert.throws(() => parseManualArguments(["confirm-operation", "--receipt-store", "/tmp/r.json",
        "--operation-id", "workspace-create", "--result-file", "/tmp/x.json"]),
        error => error.code === "invalid_arguments")
      await assert.rejects(() => buildPlan("mark-ambiguous", {
        ...base, "receipt-store": storePath, "operation-id": "workspace-create", "reason": "x", ...overrides
      }), error => error.code === "identity_mismatch")
      void overrides
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("gated plans derive authority-bearing values from the receipt rather than CLI flags", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-authority-"))
  try {
    const storePath = await initReceipt(directory)
    const plan = await buildPlan("workspace-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    })
    assert.equal(plan.commands[0].label.startsWith("read exact global Workspace list before create"), true)
    assert.equal(plan.commands[1].binary, INPUTS.executables.localBoomux)
    assert.ok(plan.commands[1].argv.includes(PREFIX))
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.inputs.nodeAlias, INPUTS.nodeAlias)
    assert.equal(onDisk.inputs.executables.localBoomux, INPUTS.executables.localBoomux)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("operation replay requires exact intent equality", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-replay-"))
  try {
    const storePath = path.join(directory, "receipt.json")
    const gate = new ManualGate(new FileReceiptStore(storePath))
    await gate.initializeReceipt({
      receiptId: IDS.receipt, prefix: PREFIX, teamGoalId: IDS.team, agentRuns: AGENT_RUNS,
      inputs: {
        nodeAlias: INPUTS.nodeAlias, expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget,
        remoteRepo: INPUTS.remoteRepo, executables: { ...INPUTS.executables, remoteRm: INPUTS.executables.remoteRm }
      },
      createdAtMs: 1700000000000
    })
    const preflightFile = await writeEvidenceFile(directory, "preflight.json", preflight())
    await gate.bindPreflightEvidence(preflightFile)
    await gateRemotePreflight(gate, directory)
    await gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX })
    // Identical intent replay is safe and idempotent.
    await gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX })
    // Changed intent on the same operation ID is refused.
    await assert.rejects(() => gate.planWorkspaceCreate({ operationId: "workspace-create", name: "different-name" }),
      error => error.code === "intent_mismatch")
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.operations.filter(item => item.id === "workspace-create").length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("attempted operations refuse replay until explicit exact reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-attempted-"))
  try {
    const storePath = path.join(directory, "receipt.json")
    const gate = new ManualGate(new FileReceiptStore(storePath))
    await gate.initializeReceipt({
      receiptId: IDS.receipt, prefix: PREFIX, teamGoalId: IDS.team, agentRuns: AGENT_RUNS,
      inputs: {
        nodeAlias: INPUTS.nodeAlias, expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget,
        remoteRepo: INPUTS.remoteRepo, executables: { ...INPUTS.executables, remoteRm: INPUTS.executables.remoteRm }
      },
      createdAtMs: 1700000000000
    })
    const preflightFile = await writeEvidenceFile(directory, "preflight.json", preflight())
    await gate.bindPreflightEvidence(preflightFile)
    await gateRemotePreflight(gate, directory)
    await gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX })
    const { markAttempted } = await import("../lib/receipt.mjs")
    await gate.store.update(receipt => {
      const next = markAttempted(receipt, "workspace-create", 1700000000500)
      for (const key of Object.keys(receipt)) delete receipt[key]
      Object.assign(receipt, next)
    })
    await assert.rejects(() => gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX }),
      error => error.code === "operation_not_replayable")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("ambiguous operations cannot be reprinted even with identical intent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-ambiguous-"))
  try {
    const storePath = path.join(directory, "receipt.json")
    const gate = new ManualGate(new FileReceiptStore(storePath))
    await gate.initializeReceipt({
      receiptId: IDS.receipt, prefix: PREFIX, teamGoalId: IDS.team, agentRuns: AGENT_RUNS,
      inputs: {
        nodeAlias: INPUTS.nodeAlias, expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget,
        remoteRepo: INPUTS.remoteRepo, executables: { ...INPUTS.executables, remoteRm: INPUTS.executables.remoteRm }
      },
      createdAtMs: 1700000000000
    })
    const preflightFile = await writeEvidenceFile(directory, "preflight.json", preflight())
    await gate.bindPreflightEvidence(preflightFile)
    await gateRemotePreflight(gate, directory)
    await gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX })
    const { markAmbiguous } = await import("../lib/receipt.mjs")
    await gate.store.update(receipt => {
      const next = markAmbiguous(receipt, "workspace-create", "connection lost", 1700000000600)
      for (const key of Object.keys(receipt)) delete receipt[key]
      Object.assign(receipt, next)
    })
    await assert.rejects(() => gate.planWorkspaceCreate({ operationId: "workspace-create", name: PREFIX }),
      error => error.code === "receipt_blocked")
    // The block applies to every other operation too.
    await assert.rejects(() => gate.planOperation({
      id: "shell-create-coordinator", kind: "shell_create", intent: { role: "coordinator" }
    }), error => error.code === "receipt_blocked")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("mutation plans require the bound preflight and record durable intent before printing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-"))
  try {
    const storePath = await initReceipt(directory, { bind: false, remote: false })
    await assert.rejects(() => buildPlan("workspace-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    }), error => error.code === "preflight_required")
    const preflightFile = await writeEvidenceFile(directory, "preflight.json", preflight())
    await buildPlan("preflight-bind", { ...base, "receipt-store": storePath, "preflight-file": preflightFile })
    // The bound preflight alone is not enough: mutation plans need the recorded
    // runtime-dependent remote preflight evidence.
    await assert.rejects(() => buildPlan("workspace-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    }), error => error.code === "remote_preflight_required")
    const remoteEvidence = await writeEvidenceFile(directory, "remote-preflight.json", remotePreflightEvidence())
    await buildPlan("record-remote-preflight", {
      ...base, "receipt-store": storePath, "evidence-file": remoteEvidence
    })

    const plan = await buildPlan("workspace-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    })
    assert.equal(plan.planOnly, true)
    assert.equal(plan.commands.filter(item => item.mutation).length, 1)
    assert.equal(plan.commands[1].mutation, true)

    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.preflight.registration.nodeId, IDS.node)
    const operation = onDisk.operations.find(item => item.id === "workspace-create")
    assert.equal(operation.state, "intended")
    assert.equal(operation.kind, "workspace_create")
    assert.ok(operation.intendedAtMs > 0)

    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    const again = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(again.operations.filter(item => item.id === "workspace-create").length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("workspace creation readback resolves raw public before/after evidence and knows no owner ID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-ws-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })

    // Confirmation from a bare intended intent is refused: the human must mark the
    // operation attempted immediately before executing the printed command.
    await assert.rejects(() => buildPlan("record-workspace-creation", {
      ...base, "receipt-store": storePath, "evidence-file": path.join(directory, "absent.json")
    }), error => error.code === "operation_not_attempted")

    await markAttempted(storePath, "workspace-create")
    await assert.rejects(() => buildPlan("record-workspace-creation", {
      ...base, "receipt-store": storePath, "evidence-file": path.join(directory, "absent.json")
    }), error => error.code === "invalid_evidence")

    // Two new matching Workspaces in the after-list cannot be resolved to one identity.
    const ambiguousFile = await writeEvidenceFile(directory, "workspace-creation-ambiguous.json",
      workspaceCreationEvidence({ ambiguous: true }))
    await assert.rejects(() => buildPlan("record-workspace-creation", {
      ...base, "receipt-store": storePath, "evidence-file": ambiguousFile
    }), error => error.code === "outcome_unknown")

    const evidenceFile = await writeEvidenceFile(directory, "workspace-creation.json", workspaceCreationEvidence())
    await buildPlan("record-workspace-creation", {
      ...base, "receipt-store": storePath, "evidence-file": evidenceFile
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    const operation = onDisk.operations.find(item => item.id === "workspace-create")
    assert.equal(operation.state, "confirmed")
    assert.equal(operation.result.globalWorkspaceId, IDS.global)
    assert.equal(Object.hasOwn(operation.result, "ownerId"), false,
      "an empty Workspace creation readback cannot know the owner Workspace ID")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("shells-create requires the confirmed workspace creation and records exact intents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-shells-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await assert.rejects(() => buildPlan("shells-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    }), error => error.code === "operation_pending")
    await confirmWorkspaceCreation(directory, storePath)
    const plan = await buildPlan("shells-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true,
      "global-workspace-id": "foreign-global-workspace"
    })
    const mutations = plan.commands.filter(item => item.mutation === true)
    assert.equal(mutations.length, 3)
    for (const entry of mutations) {
      assert.equal(typeof entry.operationId, "string")
      assert.ok(entry.argv.includes(IDS.global), "plan must use the receipt-resolved global Workspace ID")
      assert.equal(entry.argv.includes("foreign-global-workspace"), false)
    }
    // Each create is interleaved with an owner snapshot readback (runtime-env SSH argv).
    for (const role of ["coordinator", "builder", "reviewer"]) {
      const createIndex = plan.commands.findIndex(item => item.operationId === `shell-create-${role}`)
      const snapshotIndex = plan.commands.findIndex(item =>
        item.label.includes(`read owner Node snapshot after exact ${role} create`))
      assert.ok(snapshotIndex === createIndex + 1)
      assert.ok(plan.commands[snapshotIndex].argv.includes("node", 0))
      assert.ok(plan.commands[snapshotIndex].argv.includes("XDG_RUNTIME_DIR=/run/user/1001"))
    }
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    for (const role of ["coordinator", "builder", "reviewer"]) {
      const operation = onDisk.operations.find(item => item.id === `shell-create-${role}`)
      assert.equal(operation.state, "intended")
      assert.equal(operation.kind, "shell_create")
      assert.equal(operation.result, undefined)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("shell creation readbacks resolve raw public snapshot and inspection JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-shellread-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    const shellsPlan = await buildPlan("shells-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    })
    const intendedArgv = {}
    for (const entry of shellsPlan.commands.filter(item => item.mutation === true)) {
      const role = ["coordinator", "builder", "reviewer"].find(role => entry.label.includes(role))
      intendedArgv[role] = entry.argv.slice(entry.argv.indexOf("--") + 1)
      await markAttempted(storePath, `shell-create-${role}`)
      for (const [label, sabotage] of [["cwd", { mutateCwd: true }], ["argv", { mutateArgv: true }]]) {
        const mismatched = await writeEvidenceFile(directory, `${role}-${label}-mismatch.json`,
          shellCreationEvidence(role, { intendedArgv, ...sabotage }))
        await assert.rejects(() => buildPlan("record-shell-readback", {
          ...base, "receipt-store": storePath, role, "evidence-file": mismatched
        }), error => error.code === "postcondition_failed")
      }
      const evidenceFile = await writeEvidenceFile(directory, `${role}-shell-creation.json`,
        shellCreationEvidence(role, { intendedArgv }))
      await buildPlan("record-shell-readback", {
        ...base, "receipt-store": storePath, role, "evidence-file": evidenceFile
      })
    }
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    for (const role of ["coordinator", "builder", "reviewer"]) {
      const operation = onDisk.operations.find(item => item.id === `shell-create-${role}`)
      assert.equal(operation.state, "confirmed")
      assert.equal(operation.result.shellId, SHELL_IDS[role])
      assert.equal(operation.result.ownerId, IDS.owner)
      assert.equal(operation.result.runId, null)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("workspace mapping derives the owner ID from the three Shell readbacks and rejects cross-owners", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-mapping-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await assert.rejects(() => recordWorkspaceMapping(directory, storePath),
      error => error.code === "operation_pending")
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.workspace.globalId, IDS.global)
    assert.equal(onDisk.workspace.ownerId, IDS.owner)
    assert.equal(onDisk.workspace.shells.length, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("workspace mapping refuses a cross-owner set of Shell readbacks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-crossowner-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    // Coordinator and Builder in the real owner Workspace, Reviewer elsewhere.
    await recordShellCreations(directory, storePath, { ownerId: IDS.owner,
      roles: ["coordinator", "builder"] })
    const reviewEvidence = shellCreationEvidence("reviewer", {
      intendedArgv: { coordinator: [], builder: [], reviewer: [
        INPUTS.executables.remoteEnv,
        `OMARCHESTRA_TEAM_GOAL_ID=${IDS.team}`,
        `OMARCHESTRA_AGENT_RUN_ID=${AGENT_RUNS.reviewer}`,
        "OMARCHESTRA_ROLE=reviewer",
        `OMARCHESTRA_BRIDGE_SOCKET=/run/user/1001/${PREFIX}.sock`,
        `OMARCHESTRA_EXTENSION_INSTANCE_ID=${PREFIX}-reviewer`,
        INPUTS.executables.remotePi, "--no-extensions", "-e",
        `${INPUTS.remoteRepo}/spikes/remote-execution-node/bridge-extension.js`
      ] },
      ownerId: "foreign-owner-workspace"
    })
    const reviewFile = await writeEvidenceFile(directory, "reviewer-shell-creation.json", reviewEvidence)
    await markAttempted(storePath, "shell-create-reviewer")
    await buildPlan("record-shell-readback", {
      ...base, "receipt-store": storePath, role: "reviewer", "evidence-file": reviewFile
    })
    await assert.rejects(() => recordWorkspaceMapping(directory, storePath),
      error => error.code === "identity_mismatch")
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.workspace, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("workspace mapping requires the single matching remote placement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-placement-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    // No placement recorded yet: mapping is impossible without it.
    const noPlacement = await writeEvidenceFile(directory, "mapping-no-placement.json", {
      workspaceInspection: { id: IDS.global, name: PREFIX, closing: false, placements: [] }
    })
    await assert.rejects(() => buildPlan("record-workspace-readback", {
      ...base, "receipt-store": storePath, "evidence-file": noPlacement
    }), error => error.code === "ownership_uncertain")
    // A placement naming a different owner Workspace contradicts the Shell readbacks.
    const wrongPlacement = await writeEvidenceFile(directory, "mapping-wrong-placement.json", {
      workspaceInspection: { id: IDS.global, name: PREFIX, closing: false,
        placements: [{ node_id: "70000000-0000-4000-8000-000000000007", workspace_id: IDS.owner, state: "active" }] }
    })
    await assert.rejects(() => buildPlan("record-workspace-readback", {
      ...base, "receipt-store": storePath, "evidence-file": wrongPlacement
    }), error => error.code === "identity_mismatch")
    await recordWorkspaceMapping(directory, storePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("runner, presentation, and run reconciliation keep the pending-Shell ordering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-flow-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)

    await assert.rejects(() => buildPlan("present-all", {
      ...base, "receipt-store": storePath, "authorize-gui": true
    }), error => error.code === "mapping_missing")

    const runnerPlan = await buildPlan("runner-start", {
      ...base, "receipt-store": storePath, "authorize-runner": true
    })
    assert.equal(runnerPlan.commands[0].mutation, true)
    assert.ok(runnerPlan.commands[0].argv.includes(`${PREFIX}.service`))
    await recordRunnerMapping(directory, storePath)

    const presentPlan = await buildPlan("present-all", {
      ...base, "receipt-store": storePath, "authorize-gui": true,
      "coordinator-shell-id": "foreign-shell", "builder-shell-id": "foreign-shell",
      "reviewer-shell-id": "foreign-shell"
    })
    assert.equal(presentPlan.commands.length, 9)
    const mutations = presentPlan.commands.filter(item => item.mutation === true)
    assert.equal(mutations.length, 3)
    for (const entry of mutations) {
      assert.equal(entry.gui, true)
      assert.equal([...Object.values(SHELL_IDS)].includes(entry.argv[1]), true)
      assert.equal(entry.argv.includes("foreign-shell"), false)
    }
    // Runtime-env shell inspections bracket each open (before, after).
    const roleShellIds = { coordinator: SHELL_IDS.coordinator,
      builder: SHELL_IDS.builder, reviewer: SHELL_IDS.reviewer }
    for (const role of ["coordinator", "builder", "reviewer"]) {
      const openIndex = presentPlan.commands.findIndex(item => item.operationId === `present-${role}`)
      assert.ok(openIndex > 0)
      const before = presentPlan.commands[openIndex - 1]
      const after = presentPlan.commands[openIndex + 1]
      for (const inspect of [before, after]) {
        assert.equal(inspect.mutation ?? false, false)
        assert.ok(inspect.argv.includes("shell") && inspect.argv.includes("inspect"))
        assert.ok(inspect.argv.includes(roleShellIds[role]))
        assert.ok(inspect.argv.includes("XDG_RUNTIME_DIR=/run/user/1001"))
      }
    }
    assert.ok(presentPlan.notes.some(note => note.includes("pending")))

    // A self-typed Run ID is not an accepted flag at all.
    assert.throws(() => parseManualArguments(["record-shell-run-readback", "--role", "coordinator",
      "--run-id", "run-typed-by-hand"]), error => error.code === "invalid_arguments")

    for (const role of ["coordinator", "builder", "reviewer"]) {
      await markAttempted(storePath, `present-${role}`)
      const evidenceFile = await writeEvidenceFile(directory, `${role}-run-readback.json`,
        runInspectEvidence(role, IDS[`${role}Run`]))
      await buildPlan("record-shell-run-readback", {
        ...base, "receipt-store": storePath, role, "evidence-file": evidenceFile
      })
      const replacementFile = await writeEvidenceFile(directory, `${role}-run-replacement.json`,
        runInspectEvidence(role, "run-replacement"))
      await assert.rejects(() => buildPlan("record-shell-run-readback", {
        ...base, "receipt-store": storePath, role, "evidence-file": replacementFile
      }), error => error.code === "run_changed")
    }
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.deepEqual(onDisk.workspace.shells.map(item => item.runId).sort(),
      [IDS.builderRun, IDS.coordinatorRun, IDS.reviewerRun])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cleanup consumes fresh exact evidence and never trusts CLI-supplied resource IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-cleanup-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })

    await assert.rejects(() => buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile,
      "global-workspace-id": "foreign-global", "owner-workspace-id": "foreign-owner"
    }), error => error.code === "ownership_uncertain")

    await recordRunnerMapping(directory, storePath)
    const cleanupPlan = await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile,
      "global-workspace-id": "foreign-global", "owner-workspace-id": "foreign-owner",
      "coordinator-shell-id": "foreign-shell", "builder-shell-id": "foreign-shell",
      "reviewer-shell-id": "foreign-shell"
    })
    const cleanupText = JSON.stringify(cleanupPlan.commands)
    assert.ok(cleanupPlan.commands.length >= 6)
    assert.ok(cleanupPlan.commands.some(item => item.argv.includes(`/run/user/1001/${PREFIX}.sock`)))
    assert.ok(cleanupPlan.commands.some(item => item.argv.includes(IDS.coordinatorShell)))
    assert.ok(cleanupPlan.commands.some(item => item.argv.includes(IDS.global)))
    assert.equal(cleanupText.includes("foreign-global"), false)
    assert.equal(cleanupText.includes("foreign-owner"), false)
    assert.equal(cleanupText.includes("foreign-shell"), false)

    const foreignEvidence = await writeEvidenceFile(directory, "cleanup-foreign.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot([...shellFixtures(),
        shell({ role: "builder", id: "foreign-shell-x", runId: "foreign-run" })]),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    await assert.rejects(() => buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": foreignEvidence
    }), error => error.code === "foreign_resource")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("receipt intents for cleanup are recorded before the cleanup plan prints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-cleanints-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    const kinds = onDisk.operations
      .filter(operation => operation.state === "intended")
      .map(operation => operation.kind).sort()
    assert.deepEqual(kinds, [
      "runner_file_remove", "shell_close", "shell_close", "shell_close",
      "unit_stop", "workspace_close"
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
test("mark-attempted advances intent and a crash after attempted blocks replay until exact reconciliation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-attempted-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await buildPlan("mark-attempted", {
      ...base, "receipt-store": storePath, "operation-id": "workspace-create"
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.operations.find(item => item.id === "workspace-create").state, "attempted")

    // Crash after attempted: a safe-looking identical replay must be blocked.
    await assert.rejects(() => buildPlan("workspace-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    }), error => error.code === "operation_not_replayable")

    // With proven exact evidence the specialized action reconciles the attempted op.
    const evidenceFile = await writeEvidenceFile(directory, "workspace-creation.json", workspaceCreationEvidence())
    await buildPlan("record-workspace-creation", {
      ...base, "receipt-store": storePath, "evidence-file": evidenceFile
    })
    const confirmed = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(confirmed.operations.find(item => item.id === "workspace-create").state, "confirmed")

  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("mark-attempted refuses unknown and already-attempted operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-att-"))
  try {
    const storePath = await initReceipt(directory)
    await assert.rejects(() => buildPlan("mark-attempted", {
      ...base, "receipt-store": storePath, "operation-id": "no-such-operation"
    }), error => error.code === "invalid_transition")
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await buildPlan("mark-attempted", { ...base, "receipt-store": storePath, "operation-id": "workspace-create" })
    await assert.rejects(() => buildPlan("mark-attempted", {
      ...base, "receipt-store": storePath, "operation-id": "workspace-create"
    }), error => error.code === "invalid_transition")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("runner readback validates parsed systemctl and owner-path evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-runner-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await buildPlan("runner-start", { ...base, "receipt-store": storePath, "authorize-runner": true })

    // Bare intended intent cannot be confirmed.
    const premature = await writeEvidenceFile(directory, "runner-premature.json", runnerReadbackEvidence())
    await assert.rejects(() => buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": premature
    }), error => error.code === "operation_not_attempted")

    await markAttempted(storePath, "runner-start")

    for (const [label, overrides, code] of [
      ["inactive unit", { activeState: "failed", subState: "failed" }, "postcondition_failed"],
      ["zero main PID", { mainPid: "0" }, "postcondition_failed"],
      ["socket kind", { socketKind: "file" }, "postcondition_failed"],
      ["wrong socket path", { socketPath: "/run/user/1001/foreign.sock" }, "invalid_evidence"]
    ]) {
      const bad = await writeEvidenceFile(directory, `runner-bad-${label.replace(/ /g, "-")}.json`,
        runnerReadbackEvidence(overrides))
      await assert.rejects(() => buildPlan("record-runner-readback", {
        ...base, "receipt-store": storePath, "evidence-file": bad
      }), error => error.code === code, `expected ${code} for ${label}`)
    }

    const good = await writeEvidenceFile(directory, "runner-readback.json", runnerReadbackEvidence())
    await buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": good
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.runner.unit, `${PREFIX}.service`)
    assert.equal(onDisk.runner.pid, 4242)
    assert.equal(onDisk.operations.find(item => item.id === "runner-start").state, "confirmed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("shell run readback validates receipt mapping and running state from raw inspect JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-runread-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    await buildPlan("present-all", { ...base, "receipt-store": storePath, "authorize-gui": true })

    // From a bare intended presentation, confirmation is refused.
    const pending = await writeEvidenceFile(directory, "coordinator-run-readback.json",
      runInspectEvidence("coordinator", IDS.coordinatorRun))
    await assert.rejects(() => buildPlan("record-shell-run-readback", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": pending
    }), error => error.code === "operation_not_attempted")
    await markAttempted(storePath, "present-coordinator")

    // A changed Shell mapping is refused.
    const foreign = await writeEvidenceFile(directory, "coordinator-foreign.json",
      runInspectEvidence("builder", IDS.builderRun))
    await assert.rejects(() => buildPlan("record-shell-run-readback", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": foreign
    }), error => error.code === "identity_mismatch")

    // A pending (non-running) Shell proves nothing.
    const pendingShell = await writeEvidenceFile(directory, "coordinator-pending.json",
      { shell: shell({ role: "coordinator", id: IDS.coordinatorShell, runId: null }) })
    await assert.rejects(() => buildPlan("record-shell-run-readback", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": pendingShell
    }), error => error.code === "postcondition_failed")

    const good = await writeEvidenceFile(directory, "coordinator-run.json",
      runInspectEvidence("coordinator", IDS.coordinatorRun))
    await buildPlan("record-shell-run-readback", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": good
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.workspace.shells.find(item => item.role === "coordinator").runId, IDS.coordinatorRun)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cleanup plans interleave exact readback commands after every destructive step", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-cleanrb-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    const plan = await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile
    })
    const labels = plan.commands.map(item => item.label)
    for (const expected of [
      "stop exact runner user unit",
      "read exact runner unit state after stop",
      "read exact spike file-status after removal",
      "read back exact Shell absence",
      "read back exact coordinated Workspace absence"
    ]) {
      assert.ok(plan.commands.some(item => item.label.includes(expected)),
        `cleanup plan lacks readback: ${expected}`)
    }
    // Each shell close must be followed by an inspect of the same exact Shell ID.
    for (const shellId of [IDS.coordinatorShell, IDS.builderShell, IDS.reviewerShell]) {
      const closeIndex = plan.commands.findIndex(item => item.label === `close exact Shell ${shellId}`)
      assert.ok(closeIndex !== -1, `missing close for ${shellId}`)
      const inspect = plan.commands[closeIndex + 1]
      assert.ok(inspect.argv.includes(shellId), "shell close must be followed by an inspect of the same Shell")
      assert.equal(inspect.mutation ?? false, false)
      assert.ok(inspect.label.includes("read back"), "shell close must be followed by a readback")
    }
    const closeCount = plan.commands.filter(item => item.label.startsWith("close exact")).length
    assert.equal(closeCount, 4) // three shells + one workspace
    const workspaceCloseIndex = plan.commands.findIndex(item =>
      item.label === "close exact coordinated Workspace")
    const workspaceInspect = plan.commands[workspaceCloseIndex + 1]
    assert.ok(workspaceInspect.argv.includes(IDS.global))
    void labels
    // Destructive intents stay exactly six; readback commands carry no intent.
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    const intended = onDisk.operations.filter(operation => operation.state === "intended").length
    assert.equal(intended, 6)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cleanup emits the exact removal command and every mutation carries its receipt operation ID", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-opids-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    const plan = await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile
    })

    // Every mutation must carry its exact receipt operation ID.
    const mutations = plan.commands.filter(item => item.mutation === true)
    for (const item of mutations) {
      assert.equal(typeof item.operationId, "string", `mutation ${item.label} lacks operationId`)
      assert.match(item.operationId, /^[a-z0-9][a-z0-9-]{0,127}$/)
    }
    assert.deepEqual(mutations.map(item => item.operationId), [
      "cleanup-unit-stop", "cleanup-remove-files",
      "cleanup-shell-close-coordinator", "cleanup-shell-close-builder", "cleanup-shell-close-reviewer",
      "cleanup-workspace-close"
    ])

    // The exact removal command: ssh -> <remote rm> -f -- <socket> <state>,
    // ordered after the stopped-unit readback and before the file-status readback.
    const remove = plan.commands.find(item => item.operationId === "cleanup-remove-files")
    assert.ok(remove, "the exact removal command is missing")
    assert.equal(remove.mutation, true)
    assert.equal(remove.binary, base.ssh)
    assert.ok(remove.argv.includes(base["remote-rm"]))
    assert.deepEqual(remove.argv.slice(remove.argv.indexOf("-f")),
      ["-f", "--", `/run/user/1001/${PREFIX}.sock`, base["state-path"]])
    const showIndex = plan.commands.findIndex(item => item.label.includes("read exact runner unit state after stop"))
    const removeIndex = plan.commands.indexOf(remove)
    const statusIndex = plan.commands.findIndex(item => item.label.includes("file-status"))
    assert.ok(showIndex !== -1 && showIndex < removeIndex, "stopped-unit readback must precede removal")
    assert.ok(removeIndex < statusIndex, "removal must precede the file-status readback")

    // Role pairings: each Shell close's operation ID names the role whose Shell ID
    // and exactCleanupPlan-owned Shell ID it carries.
    const roleMapping = new Map([["coordinator", IDS.coordinatorShell],
      ["builder", IDS.builderShell], ["reviewer", IDS.reviewerShell]])
    for (const item of mutations.filter(item => item.operationId.startsWith("cleanup-shell-close-"))) {
      const role = item.operationId.slice("cleanup-shell-close-".length)
      assert.equal(item.argv[item.argv.indexOf("--workspace") - 1], roleMapping.get(role),
        "shell close must pair its role operation with the exactCleanupPlan-owned Shell ID")
      assert.ok(item.argv.includes(roleMapping.get(role)))
    }

    // Full ordering: stop/readback/remove/readback/(close/readback) ×3/workspace/readback.
    const labels = plan.commands.map(item => item.label)
    const indexOfFragment = fragment => labels.findIndex(label => label.startsWith(fragment))
    assert.ok(indexOfFragment("stop exact runner") < indexOfFragment("read exact runner unit state"))
    assert.ok(indexOfFragment("read exact runner unit state") < removeIndex)
    assert.ok(removeIndex < statusIndex)
    let previousClose = statusIndex
    for (const role of ["coordinator", "builder", "reviewer"]) {
      const closeIndex = plan.commands.findIndex(item => item.operationId === `cleanup-shell-close-${role}`)
      assert.ok(closeIndex > previousClose)
      assert.equal(plan.commands[closeIndex + 1].label.startsWith("read back exact Shell absence"), true)
      previousClose = closeIndex + 1
    }
    const workspaceCloseIndex = plan.commands.findIndex(item => item.operationId === "cleanup-workspace-close")
    assert.ok(workspaceCloseIndex > previousClose)
    assert.equal(plan.commands[workspaceCloseIndex + 1].label.startsWith("read back exact coordinated Workspace"), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("runner, workspace, shell creation, and presentation mutations identify their receipt operations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-opids-flow-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    const ws = await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    assert.deepEqual(
      ws.commands.filter(item => item.mutation).map(item => item.operationId),
      ["workspace-create"])
    await markAttempted(storePath, "workspace-create")
    const wsEvidence = await writeEvidenceFile(directory, "workspace-creation.json", workspaceCreationEvidence())
    await buildPlan("record-workspace-creation", { ...base, "receipt-store": storePath, "evidence-file": wsEvidence })
    const shellsPlan = await buildPlan("shells-create", {
      ...base, "receipt-store": storePath, "authorize-resources": true
    })
    assert.deepEqual(
      shellsPlan.commands.filter(item => item.mutation).map(item => item.operationId),
      ["shell-create-coordinator", "shell-create-builder", "shell-create-reviewer"])
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await buildPlan("runner-start", {
      ...base, "receipt-store": storePath, "authorize-runner": true
    })
    await markAttempted(storePath, "runner-start")
    const runnerReadback = await writeEvidenceFile(directory, "runner-readback.json", runnerReadbackEvidence())
    await buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": runnerReadback
    })
    const present = await buildPlan("present-all", {
      ...base, "receipt-store": storePath, "authorize-gui": true
    })
    assert.deepEqual(
      present.commands.filter(item => item.mutation).map(item => item.operationId),
      ["present-coordinator", "present-builder", "present-reviewer"])
    // The exact runner mutation names its receipt operation and the file-status
    // evidence collection follows the stopped-unit readback in cleanup plans.
    const runnerPlan = await buildPlan("runner-start", {
      ...base, "receipt-store": storePath, "authorize-runner": true
    }).catch(() => null)
    void runnerPlan
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("cleanup confirmations parse raw readback evidence and enforce one attempted operation globally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-clnconfirm-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile
    })

    // Forged bare exactReadback cannot confirm anything.
    const forged = await writeEvidenceFile(directory, "forged.json", { exactReadback: true })
    await markAttempted(storePath, "cleanup-unit-stop")
    await assert.rejects(() => buildPlan("confirm-cleanup-unit-stop", {
      ...base, "receipt-store": storePath, "evidence-file": forged
    }), error => error.code === "invalid_evidence")

    // Wrong command/unit identity is refused.
    const wrongUnit = await writeEvidenceFile(directory, "unit-wrong.json", { unitShow: [
      "Id=foreign.service", "LoadState=loaded", "ActiveState=inactive", "SubState=dead", "MainPID=0"
    ] })
    await assert.rejects(() => buildPlan("confirm-cleanup-unit-stop", {
      ...base, "receipt-store": storePath, "evidence-file": wrongUnit
    }), error => error.code === "identity_mismatch")

    // Still-running unit is refused.
    const running = await writeEvidenceFile(directory, "unit-running.json", { unitShow: [
      `Id=${PREFIX}.service`, "LoadState=loaded", "ActiveState=active", "SubState=running", "MainPID=4242"
    ]})
    await assert.rejects(() => buildPlan("confirm-cleanup-unit-stop", {
      ...base, "receipt-store": storePath, "evidence-file": running
    }), error => error.code === "postcondition_failed")

    // Out-of-order next mark-attempted is refused while unit-stop is attempted.
    await assert.rejects(() => buildPlan("mark-attempted", {
      ...base, "receipt-store": storePath, "operation-id": "cleanup-remove-files"
    }), error => error.code === "attempt_in_progress")

    // Exact stopped-unit evidence confirms.
    const stopped = await writeEvidenceFile(directory, "unit-stopped.json", { unitShow: [
      `Id=${PREFIX}.service`, "LoadState=loaded", "ActiveState=inactive", "SubState=dead", "MainPID=0"
    ]})
    await buildPlan("confirm-cleanup-unit-stop", {
      ...base, "receipt-store": storePath, "evidence-file": stopped
    })

    // Then the next destructive op may be attempted; forged file-status is refused.
    await markAttempted(storePath, "cleanup-remove-files")
    await assert.rejects(() => buildPlan("confirm-cleanup-files", {
      ...base, "receipt-store": storePath, "evidence-file": forged
    }), error => error.code === "invalid_evidence")
    const wrongPaths = await writeEvidenceFile(directory, "files-wrong.json", {
      schema: "omarchestra.remote-execution-node.file-status/v1",
      socketPath: "/run/user/1001/foreign.sock", statePath: "/tmp/foreign.json",
      files: [
        { path: "/run/user/1001/foreign.sock", status: "missing", exists: false, kind: "missing" },
        { path: "/tmp/foreign.json", status: "missing", exists: false, kind: "missing" }
      ],
      spikePathsAbsent: true
    })
    await assert.rejects(() => buildPlan("confirm-cleanup-files", {
      ...base, "receipt-store": storePath, "evidence-file": wrongPaths
    }), error => error.code === "identity_mismatch")
    const filesGone = await writeEvidenceFile(directory, "files-gone.json", {
      schema: "omarchestra.remote-execution-node.file-status/v1",
      socketPath: `/run/user/1001/${PREFIX}.sock`, statePath: base["state-path"],
      files: [
        { label: "socket", path: `/run/user/1001/${PREFIX}.sock`, status: "missing", exists: false, kind: "missing" },
        { label: "state", path: base["state-path"], status: "missing", exists: false, kind: "missing" }
      ],
      spikePathsAbsent: true
    })
    await buildPlan("confirm-cleanup-files", {
      ...base, "receipt-store": storePath, "evidence-file": filesGone
    })

    // Shell close: a forged success envelope or wrong ID is refused; typed
    // not_found for the exact receipt Shell confirms.
    await markAttempted(storePath, "cleanup-shell-close-coordinator")
    const stillThere = await writeEvidenceFile(directory, "shell-open.json", {
      requested: { shellId: IDS.coordinatorShell, workspaceId: IDS.owner },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "shell.inspect",
        data: { id: IDS.coordinatorShell } })
    })
    await assert.rejects(() => buildPlan("confirm-shell-close", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": stillThere
    }), error => error.code === "unexpected_success_envelope")
    const wrongId = await writeEvidenceFile(directory, "shell-wrong.json", {
      requested: { shellId: IDS.builderShell, workspaceId: IDS.owner },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "shell.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await assert.rejects(() => buildPlan("confirm-shell-close", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": wrongId
    }), error => error.code === "identity_mismatch")
    const closed = await writeEvidenceFile(directory, "shell-gone.json", {
      requested: { shellId: IDS.coordinatorShell, workspaceId: IDS.owner },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "shell.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await buildPlan("confirm-shell-close", {
      ...base, "receipt-store": storePath, role: "coordinator", "evidence-file": closed
    })

    // Workspace close: typed not_found for the exact global ID confirms.
    await markAttempted(storePath, "cleanup-shell-close-builder")
    await buildPlan("confirm-shell-close", {
      ...base, "receipt-store": storePath, role: "builder", "evidence-file": (await writeEvidenceFile(directory,
        "shell-gone-builder.json", {
        requested: { shellId: IDS.builderShell, workspaceId: IDS.owner },
        stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "shell.inspect",
          error: { code: "not_found", message: "absent" } })
      }))
    })
    await markAttempted(storePath, "cleanup-shell-close-reviewer")
    await buildPlan("confirm-shell-close", {
      ...base, "receipt-store": storePath, role: "reviewer", "evidence-file": (await writeEvidenceFile(directory,
        "shell-gone-reviewer.json", {
        requested: { shellId: IDS.reviewerShell, workspaceId: IDS.owner },
        stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "shell.inspect",
          error: { code: "not_found", message: "absent" } })
      }))
    })
    await markAttempted(storePath, "cleanup-workspace-close")
    const wsOpen = await writeEvidenceFile(directory, "ws-open.json", {
      requested: { globalWorkspaceId: IDS.global },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "workspace.inspect",
        data: { id: IDS.global } })
    })
    await assert.rejects(() => buildPlan("confirm-workspace-close", {
      ...base, "receipt-store": storePath, "evidence-file": wsOpen
    }), error => error.code === "unexpected_success_envelope")
    const wsGone = await writeEvidenceFile(directory, "ws-gone.json", {
      requested: { globalWorkspaceId: IDS.global },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "workspace.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await buildPlan("confirm-workspace-close", {
      ...base, "receipt-store": storePath, "evidence-file": wsGone
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    for (const operationId of ["cleanup-unit-stop", "cleanup-remove-files", "cleanup-shell-close-coordinator",
      "cleanup-shell-close-builder", "cleanup-shell-close-reviewer", "cleanup-workspace-close"]) {
      assert.equal(onDisk.operations.find(item => item.id === operationId).state, "confirmed")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function systemShowEvidence(unitShow) {
  return {
    unitShow,
    fileStatus: {
      schema: "omarchestra.remote-execution-node.file-status/v1",
      socketPath: `/run/user/1001/${PREFIX}.sock`, statePath: base["state-path"],
      files: [
        { label: "socket", path: `/run/user/1001/${PREFIX}.sock`, status: "socket present",
          exists: true, kind: "socket", mode: "0600", ownerUid: 1001 },
        { label: "state", path: base["state-path"], status: "file present",
          exists: true, kind: "file", mode: "0600", ownerUid: 1001 }
      ],
      spikePathsAbsent: false
    }
  }
}

test("runner readback requires exactly the five systemctl keys once each, then consumes raw file status", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-runfs-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await buildPlan("runner-start", { ...base, "receipt-store": storePath, "authorize-runner": true })
    await markAttempted(storePath, "runner-start")

    const baseLines = [`Id=${PREFIX}.service`, "LoadState=loaded", "ActiveState=active",
      "SubState=running", "MainPID=4242"]
    for (const [label, lines] of [
      ["non-adjacent duplicate key", [...baseLines, `ActiveState=inactive`]],
      ["unknown key", [...baseLines, "MemoryCurrent=42"]],
      ["missing key", baseLines.slice(0, 4)]
    ]) {
      const bad = await writeEvidenceFile(directory, `unit-show-${label.replace(/ /g, "-")}.json`,
        systemShowEvidence(lines))
      await assert.rejects(() => buildPlan("record-runner-readback", {
        ...base, "receipt-store": storePath, "evidence-file": bad
      }), error => error.code === "invalid_evidence", `expected invalid_evidence for ${label}`)
    }

    const good = await writeEvidenceFile(directory, "runner-readback.json", systemShowEvidence(baseLines))
    await buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": good
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.runner.pid, 4242)
    assert.equal(onDisk.runner.socketPath, `/run/user/1001/${PREFIX}.sock`)
    assert.equal(onDisk.operations.find(item => item.id === "runner-start").state, "confirmed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})












test("runner readback consumes the remote-helper file-status raw schema with non-adjacent duplicate rejection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-runfs-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await buildPlan("runner-start", { ...base, "receipt-store": storePath, "authorize-runner": true })
    await markAttempted(storePath, "runner-start")

    const fileStatusDoc = {
      schema: "omarchestra.remote-execution-node.file-status/v1",
      socketPath: `/run/user/1001/${PREFIX}.sock`, statePath: base["state-path"],
      files: [
        { label: "socket", path: `/run/user/1001/${PREFIX}.sock`, status: "socket present",
          exists: true, kind: "socket", mode: "0600", ownerUid: 1001 },
        { label: "state", path: base["state-path"], status: "file present",
          exists: true, kind: "file", mode: "0600", ownerUid: 1001 }
      ],
      spikePathsAbsent: false
    }
    const good = await writeEvidenceFile(directory, "runner-readback.json",
      { unitShow: [`Id=${PREFIX}.service`, "LoadState=loaded", "ActiveState=active",
        "SubState=running", "MainPID=4242"], fileStatus: fileStatusDoc })
    await buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": good
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.runner.pid, 4242)
    assert.equal(onDisk.runner.socketPath, `/run/user/1001/${PREFIX}.sock`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("workspace close confirmation requires the receipt global ID in requested evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-wsclose-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    await recordRunnerMapping(directory, storePath)
    const evidenceFile = await writeEvidenceFile(directory, "cleanup-evidence.json", {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: ownerSnapshot(),
      shellInspections: shellInspections(),
      nodeIdentity: nodeIdentity()
    })
    await buildPlan("cleanup", {
      ...base, "receipt-store": storePath, "authorize-cleanup": true, "evidence-file": evidenceFile
    })
    await markAttempted(storePath, "cleanup-workspace-close")

    // A not_found envelope without the requested global Workspace ID proves nothing.
    const noRequested = await writeEvidenceFile(directory, "ws-no-requested.json", {
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "workspace.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await assert.rejects(() => buildPlan("confirm-workspace-close", {
      ...base, "receipt-store": storePath, "evidence-file": noRequested
    }), error => error.code === "invalid_evidence")

    // A typed not_found for a different Workspace is refused.
    const wrongRequested = await writeEvidenceFile(directory, "ws-wrong-requested.json", {
      requested: { globalWorkspaceId: "foreign-global-workspace" },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "workspace.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await assert.rejects(() => buildPlan("confirm-workspace-close", {
      ...base, "receipt-store": storePath, "evidence-file": wrongRequested
    }), error => error.code === "identity_mismatch")

    const rightRequested = await writeEvidenceFile(directory, "ws-right-requested.json", {
      requested: { globalWorkspaceId: IDS.global },
      stderr: JSON.stringify({ schema: "boomux.cli/v1", command: "workspace.inspect",
        error: { code: "not_found", message: "absent" } })
    })
    await buildPlan("confirm-workspace-close", {
      ...base, "receipt-store": storePath, "evidence-file": rightRequested
    })
    const onDisk = JSON.parse(await readFile(storePath, "utf8"))
    assert.equal(onDisk.operations.find(item => item.id === "cleanup-workspace-close").state, "confirmed")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("inspect-direct derives Shell authority from the receipt and refuses wrong CLI IDs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-inspect-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)

    // Receipt-derived inspection argv (runtime-env SSH with receipt Shell IDs).
    const plan = await buildPlan("inspect-direct", {
      ...base, "receipt-store": storePath
    })
    const inspections = plan.commands.filter(item => item.label.includes("inspection"))
    assert.equal(inspections.length, 3)
    for (const entry of inspections) {
      assert.ok([...Object.values(SHELL_IDS)].includes(entry.argv.find(arg =>
        Object.values(SHELL_IDS).includes(arg))))
      assert.ok(entry.argv.includes("XDG_RUNTIME_DIR=/run/user/1001"))
    }

    // A wrong CLI Shell ID is refused outright.
    await assert.rejects(() => buildPlan("inspect-direct", {
      ...base, "receipt-store": storePath,
      "coordinator-shell-id": "foreign-shell"
    }), error => error.code === "identity_mismatch")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("postflight prints exact runner absence readbacks from receipt ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-postflight-"))
  try {
    const storePath = await initReceipt(directory)
    await buildPlan("workspace-create", { ...base, "receipt-store": storePath, "authorize-resources": true })
    await confirmWorkspaceCreation(directory, storePath)
    await recordShellCreations(directory, storePath)
    await recordWorkspaceMapping(directory, storePath)
    // Before the runner ownership exists the postflight cannot claim an exact
    // runner-absence conclusion: fail closed.
    await assert.rejects(() => buildPlan("postflight", { ...base, "receipt-store": storePath }),
      error => error.code === "ownership_uncertain")

    await buildPlan("runner-start", { ...base, "receipt-store": storePath, "authorize-runner": true })
    await markAttempted(storePath, "runner-start")
    const runnerReadback = await writeEvidenceFile(directory, "runner-readback.json", runnerReadbackEvidence())
    await buildPlan("record-runner-readback", {
      ...base, "receipt-store": storePath, "evidence-file": runnerReadback
    })
    const withRunner = await buildPlan("postflight", { ...base, "receipt-store": storePath })
    const show = withRunner.commands.find(item =>
      item.label.startsWith("postflight exact runner unit absence"))
    assert.ok(show && show.mutation !== true)
    assert.ok(show.argv.includes(`${PREFIX}.service`))
    assert.ok(show.argv.includes("XDG_RUNTIME_DIR=/run/user/1001"))
    assert.ok(show.argv.includes(base["remote-systemctl"]))
    const status = withRunner.commands.find(item =>
      item.label.startsWith("postflight exact runner socket/state absence"))
    assert.ok(status && status.argv.includes(`/run/user/1001/${PREFIX}.sock`))
    assert.ok(status.argv.includes(base["state-path"]))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("preflight-remote does not duplicate the integration reads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manual-gate-pfr-"))
  try {
    const storePath = await initReceipt(directory)
    const plan = await buildPlan("preflight-remote", { ...base, "receipt-store": storePath })
    const integrationLists = plan.commands.filter(item =>
      item.argv.includes("integration") && item.argv.includes("list"))
    assert.equal(integrationLists.length, 1)
    const integrationStatus = plan.commands.filter(item =>
      item.argv.includes("integration") && item.argv.includes("status"))
    assert.equal(integrationStatus.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
