import assert from "node:assert/strict"
import { test } from "node:test"

import {
  exactCleanupPlan,
  verifyCleanupPostconditions
} from "../lib/runtime.mjs"
import { capabilities } from "./fixtures.mjs"
import {
  bindPreflight,
  markAmbiguous,
  newReceipt,
  recordIntent,
  recordRemotePreflight,
  recordRunner,
  recordWorkspace
} from "../lib/receipt.mjs"
import {
  AGENT_RUNS,
  IDS,
  INPUTS,
  PREFIX,
  directOwnerSnapshot,
  preflight,
  qualified,
  shell,
  workspaceShellMappings
} from "./fixtures.mjs"

function ownedReceipt({ ambiguous = false } = {}) {
  let receipt = bindPreflight(newReceipt({
    receiptId: IDS.receipt,
    prefix: PREFIX,
    teamGoalId: IDS.team,
    agentRuns: AGENT_RUNS,
    inputs: INPUTS,
    createdAtMs: 1700000000000
  }), preflight())
  receipt = recordWorkspace(receipt, {
    globalId: IDS.global,
    nodeId: IDS.node,
    ownerId: IDS.owner,
    shells: workspaceShellMappings({ withRuns: true })
  })
  receipt = recordRemotePreflight(receipt, {
    schema: "omarchestra.remote-execution-node.remote-preflight/v1",
    capturedAtMs: 1700000001000,
    uid: 1001, runtimeDirectory: "/run/user/1001", capabilities: capabilities(),
    remoteSha256: "c".repeat(64), remoteConfigPresent: true, remoteIntegrationSha256: "e".repeat(64)
  })
  receipt = recordRunner(receipt, {
    unit: `${PREFIX}.service`,
    socketPath: `/run/user/1001/${PREFIX}.sock`,
    statePath: `${INPUTS.remoteRepo}/spikes/remote-execution-node/evidence/local/${PREFIX}.state.json`,
    pid: 9001
  })
  if (ambiguous) {
    receipt = recordIntent(receipt, {
      id: "uncertain-open", kind: "presentation", intent: { shellId: IDS.builderShell }
    })
    receipt = markAmbiguous(receipt, "uncertain-open", "connection lost")
  }
  return receipt
}

function runningShells() {
  return [
    shell({ role: "coordinator", id: IDS.coordinatorShell, runId: IDS.coordinatorRun }),
    shell({ role: "builder", id: IDS.builderShell, runId: IDS.builderRun }),
    shell({ role: "reviewer", id: IDS.reviewerShell, runId: IDS.reviewerRun })
  ]
}

function inspections(shells = runningShells()) {
  return Object.fromEntries(shells.map(value => [value.id.inner_id, { shell: value }]))
}

const nodeIdentity = {
  alias: INPUTS.nodeAlias,
  nodeId: IDS.node,
  target: INPUTS.sshTarget
}

const coordinatorSnapshot = () => ({
  workspaces: [{
    id: IDS.global,
    name: PREFIX,
    closing: false,
    placements: [{
      node_id: IDS.node,
      workspace_id: IDS.owner,
      state: "active"
    }]
  }]
})

test("cleanup plan contains only exact receipt-owned resources", () => {
  const receipt = ownedReceipt()
  const shells = runningShells()
  const plan = exactCleanupPlan(receipt, {
    coordinatorSnapshot: coordinatorSnapshot(),
    ownerSnapshot: directOwnerSnapshot({ shells }),
    shellInspections: inspections(shells),
    nodeIdentity
  })
  assert.deepEqual(plan.shellIds,
    [IDS.coordinatorShell, IDS.builderShell, IDS.reviewerShell])
  assert.equal(plan.globalWorkspaceId, IDS.global)
  assert.equal(plan.ownerWorkspaceId, IDS.owner)
  assert.equal(plan.runner.unit, `${PREFIX}.service`)
  assert.equal(Object.values(plan).some(value => value === "*"), false)
})

test("cleanup refuses missing evidence ambiguity changed Node and changed Run", () => {
  const shells = runningShells()
  const noPreflight = newReceipt({ receiptId: IDS.receipt, prefix: PREFIX, teamGoalId: IDS.team,
    agentRuns: AGENT_RUNS, inputs: INPUTS })
  assert.throws(() => exactCleanupPlan(noPreflight, {
    coordinatorSnapshot: coordinatorSnapshot(),
    ownerSnapshot: directOwnerSnapshot({ shells }), shellInspections: inspections(shells), nodeIdentity
  }), error => error.code === "preflight_required")
  assert.throws(() => exactCleanupPlan(ownedReceipt({ ambiguous: true }), {
    coordinatorSnapshot: coordinatorSnapshot(),
    ownerSnapshot: directOwnerSnapshot({ shells }), shellInspections: inspections(shells), nodeIdentity
  }), error => error.code === "receipt_blocked")
  assert.throws(() => exactCleanupPlan(ownedReceipt(), {
    coordinatorSnapshot: coordinatorSnapshot(),
    ownerSnapshot: directOwnerSnapshot({ shells }), shellInspections: inspections(shells),
    nodeIdentity: { ...nodeIdentity, nodeId: "70000000-0000-4000-8000-000000000007" }
  }), error => error.code === "node_identity_changed")
  const changed = runningShells()
  changed[1] = shell({ role: "builder", id: IDS.builderShell, runId: "foreign-run" })
  assert.throws(() => exactCleanupPlan(ownedReceipt(), {
    coordinatorSnapshot: coordinatorSnapshot(),
    ownerSnapshot: directOwnerSnapshot({ shells: changed }), shellInspections: inspections(changed), nodeIdentity
  }), error => error.code === "run_changed")
})

test("cleanup refuses a changed or additional placement", () => {
  const receipt = ownedReceipt()
  const shells = runningShells()
  const changed = coordinatorSnapshot()
  changed.workspaces[0].placements.push({
    node_id: "70000000-0000-4000-8000-000000000007",
    workspace_id: "foreign-owner",
    state: "active"
  })
  assert.throws(() => exactCleanupPlan(receipt, {
    coordinatorSnapshot: changed,
    ownerSnapshot: directOwnerSnapshot({ shells }),
    shellInspections: inspections(shells),
    nodeIdentity
  }), error => error.code === "foreign_resource")
})

test("cleanup refuses every foreign Shell Launcher or Agent", () => {
  const receipt = ownedReceipt()
  const shells = runningShells()
  const foreignShell = shell({ role: "builder", id: "foreign-shell", runId: "foreign-run" })
  for (const additions of [
    { shells: [...shells, foreignShell] },
    { shells, launchers: [{ id: qualified("foreign-launcher") }] },
    { shells, agents: [{ id: qualified("foreign-agent") }] }
  ]) {
    assert.throws(() => exactCleanupPlan(receipt, {
      coordinatorSnapshot: coordinatorSnapshot(),
      ownerSnapshot: directOwnerSnapshot(additions),
      shellInspections: inspections([...shells, foreignShell]),
      nodeIdentity
    }), error => error.code === "foreign_resource")
  }
})

test("cleanup postconditions prove absence and preserve preflight identities", () => {
  const receipt = ownedReceipt()
  const postflightNodeSnapshot = {
    nodes: [{
      node_id: IDS.node,
      alias: "local",
      local: true,
      current: true,
      stale: false,
      health: "online",
      local_snapshot: {
        workspaces: [{
          id: qualified("preexisting-owner"),
          name: "user-owner",
          shells: [], launchers: [], agents: []
        }]
      },
      remote_projection: null
    }]
  }
  assert.deepEqual(verifyCleanupPostconditions(receipt, {
    workspaceList: { workspaces: [{ id: "preexisting-global", name: "user" }] },
    nodeSnapshot: postflightNodeSnapshot,
    runner: { unitAbsent: true, pidAbsent: true },
    remoteFiles: { socketAbsent: true, stateAbsent: true },
    registration: {
      alias: INPUTS.nodeAlias, nodeId: IDS.node, target: INPUTS.sshTarget,
      revision: 7, tombstoneEpoch: 2
    },
    configuration: { localSha256: "b".repeat(64), remoteSha256: "c".repeat(64),
      localConfigPresent: true, remoteConfigPresent: true,
      localIntegrationSha256: "d".repeat(64), remoteIntegrationSha256: "e".repeat(64) }
  }), { cleaned: true, preserved: true })
})

test("postcondition readback also proves integration fingerprints are unchanged", () => {
  const receipt = ownedReceipt()
  const base = {
    workspaceList: { workspaces: [{ id: "preexisting-global" }] },
    nodeSnapshot: { nodes: [{ node_id: IDS.node, local_snapshot: { workspaces: [{
      id: qualified("preexisting-owner"), shells: [], launchers: [], agents: []
    }] } }] },
    runner: { unitAbsent: true, pidAbsent: true },
    remoteFiles: { socketAbsent: true, stateAbsent: true },
    registration: { alias: INPUTS.nodeAlias, nodeId: IDS.node, target: INPUTS.sshTarget,
      revision: 7, tombstoneEpoch: 2 },
    configuration: { localSha256: "b".repeat(64), remoteSha256: "c".repeat(64),
      localIntegrationSha256: "d".repeat(64), remoteIntegrationSha256: "e".repeat(64),
      localConfigPresent: true, remoteConfigPresent: true }
  }
  assert.deepEqual(verifyCleanupPostconditions(receipt, base), { cleaned: true, preserved: true })
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, configuration: { ...base.configuration, localIntegrationSha256: "f".repeat(64) }
  }), error => error.code === "identity_preservation_failed")
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, configuration: { ...base.configuration, remoteIntegrationSha256: null }
  }), error => error.code === "identity_preservation_failed")
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, configuration: { ...base.configuration, remoteConfigPresent: false }
  }), error => error.code === "identity_preservation_failed")
})

test("postcondition readback fails if resource process file registration or baseline changes", () => {
  const receipt = ownedReceipt()
  const base = {
    workspaceList: { workspaces: [{ id: "preexisting-global" }] },
    nodeSnapshot: { nodes: [{ node_id: IDS.node, local_snapshot: { workspaces: [{
      id: qualified("preexisting-owner"), shells: [], launchers: [], agents: []
    }] } }] },
    runner: { unitAbsent: true, pidAbsent: true },
    remoteFiles: { socketAbsent: true, stateAbsent: true },
    registration: { alias: INPUTS.nodeAlias, nodeId: IDS.node, target: INPUTS.sshTarget,
      revision: 7, tombstoneEpoch: 2 },
    configuration: { localSha256: "b".repeat(64), remoteSha256: "c".repeat(64),
      localConfigPresent: true, remoteConfigPresent: true,
      localIntegrationSha256: "d".repeat(64), remoteIntegrationSha256: "e".repeat(64) }
  }
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, runner: { unitAbsent: false, pidAbsent: true }
  }), error => error.code === "cleanup_postcondition_failed")
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, registration: { ...base.registration, revision: 8 }
  }), error => error.code === "identity_preservation_failed")
  assert.throws(() => verifyCleanupPostconditions(receipt, {
    ...base, workspaceList: { workspaces: [] }
  }), error => error.code === "identity_preservation_failed")
})
