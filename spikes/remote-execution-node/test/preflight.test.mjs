import assert from "node:assert/strict"
import { test } from "node:test"

import {
  RemoteExecutionRuntime,
  reconcileNodeIdentity,
  validateCapabilities
} from "../lib/runtime.mjs"
import { validateRuntimeIdentity } from "../lib/validation.mjs"
import {
  FakeBoomux,
  IDS,
  INPUTS,
  capabilities,
  combinedSnapshot,
  qualified,
  registration,
  remoteProjectionNode
} from "./fixtures.mjs"

test("remote identity preflight rejects UID 0 and sudo-capable identities", () => {
  assert.deepEqual(validateRuntimeIdentity({
    uid: 1001,
    sudoExitCode: 1,
    runtimeDirectory: "/run/user/1001",
    runtimeOwnerUid: 1001,
    runtimeMode: "0700"
  }), { uid: 1001, runtimeDirectory: "/run/user/1001", runtimeMode: "0700" })
  assert.throws(() => validateRuntimeIdentity({
    uid: 0, sudoExitCode: 1, runtimeDirectory: "/run/user/0", runtimeOwnerUid: 0, runtimeMode: "0700"
  }), error => error.code === "unsafe_execution_identity")
  assert.throws(() => validateRuntimeIdentity({
    uid: 1001, sudoExitCode: 0, runtimeDirectory: "/run/user/1001", runtimeOwnerUid: 1001, runtimeMode: "0700"
  }), error => error.code === "sudo_capable")
  assert.throws(() => validateRuntimeIdentity({
    uid: 1001, sudoExitCode: 1, runtimeDirectory: "/run/user/1001", runtimeOwnerUid: 0, runtimeMode: "0755"
  }), error => error.code === "unsafe_runtime_directory")
})

test("capability negotiation requires the pinned public remote contract", () => {
  assert.equal(validateCapabilities(capabilities()).cli_version, "1.8.0")
  assert.throws(() => validateCapabilities(capabilities({ cli_version: "1.9.0" })),
    error => error.code === "version_mismatch")
  assert.throws(() => validateCapabilities(capabilities({ features: ["protocol_49"] })),
    error => error.code === "capability_unavailable" && error.details.missingFeatures.length > 0)
})

test("Node reconciliation binds alias target and expected Node ID to one current projection", () => {
  const result = reconcileNodeIdentity({
    registrationData: registration(),
    snapshotData: combinedSnapshot(),
    alias: INPUTS.nodeAlias,
    expectedNodeId: IDS.node,
    sshTarget: INPUTS.sshTarget
  })
  assert.equal(result.nodeId, IDS.node)
  assert.equal(result.revision, 7)
  assert.throws(() => reconcileNodeIdentity({
    registrationData: registration({ node_id: "70000000-0000-4000-8000-000000000007" }),
    snapshotData: combinedSnapshot(), alias: INPUTS.nodeAlias,
    expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget
  }), error => error.code === "node_identity_changed")
  assert.throws(() => reconcileNodeIdentity({
    registrationData: registration(),
    snapshotData: combinedSnapshot({ node: remoteProjectionNode({ stale: true, current: false, health: "stale" }) }),
    alias: INPUTS.nodeAlias, expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget
  }), error => error.code === "node_unavailable")
})

test("read-only preflight captures public snapshots and an atomic event baseline", async () => {
  const boomux = new FakeBoomux(({ command }) => {
    if (command === "capabilities") return capabilities()
    if (command === "daemon.status") return { status: "running", protocol_version: 49 }
    if (command === "node.inspect") return registration()
    if (command === "node.snapshot") return combinedSnapshot()
    if (command === "workspace.list") return {
      workspaces: [{ id: "preexisting-global", name: "user-workspace", placements: [] }],
      external_workspaces: []
    }
    if (command === "events") return {
      cursor: "stream-a:4", snapshot: { workspaces: [] }, events: []
    }
    throw new Error(`unexpected ${command}`)
  })
  const runtime = new RemoteExecutionRuntime({ boomux })
  const result = await runtime.preflight(INPUTS)
  assert.equal(result.registration.nodeId, IDS.node)
  assert.equal(result.eventBaseline.baseline, true)
  assert.deepEqual(result.baseline.globalWorkspaceIds, ["preexisting-global"])
  assert.ok(result.baseline.qualifiedResourceIds.includes(`${IDS.node}:${IDS.owner}`))
  assert.equal(boomux.calls.some(call => call.type === "weak"), false)
})

test("every explicit phase reconciliation performs fresh inspect and snapshot reads", async () => {
  const boomux = new FakeBoomux(({ command }) => {
    if (command === "node.inspect") return registration()
    if (command === "node.snapshot") return combinedSnapshot()
    throw new Error(`unexpected ${command}`)
  })
  const runtime = new RemoteExecutionRuntime({ boomux })
  await runtime.reconcileNode(INPUTS)
  await runtime.reconcileNode(INPUTS)
  assert.deepEqual(boomux.calls.map(call => call.command),
    ["node.inspect", "node.snapshot", "node.inspect", "node.snapshot"])
})

test("baseline identity collection retains structurally qualified IDs", () => {
  const snapshot = combinedSnapshot({ node: remoteProjectionNode({ shells: [{
    id: qualified("preexisting-shell"),
    workspace_id: qualified(IDS.owner),
    name: "user-shell",
    status: "pending",
    run: null
  }] }) })
  const result = reconcileNodeIdentity({ registrationData: registration(), snapshotData: snapshot,
    alias: INPUTS.nodeAlias, expectedNodeId: IDS.node, sshTarget: INPUTS.sshTarget })
  assert.equal(result.nodeId, IDS.node)
})
