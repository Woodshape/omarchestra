import assert from "node:assert/strict"
import { test } from "node:test"

import {
  RemoteExecutionRuntime,
  classifyPresentation,
  normalizeEventPage,
  resolveShellCreation,
  resolveWorkspaceCreation
} from "../lib/runtime.mjs"
import { spikeError } from "../lib/errors.mjs"
import {
  FakeBoomux,
  IDS,
  INPUTS,
  PREFIX,
  directOwnerSnapshot,
  qualified,
  shell
} from "./fixtures.mjs"

test("empty Workspace creation resolves only one new JSON identity", () => {
  const result = resolveWorkspaceCreation({
    prefix: PREFIX,
    beforeWorkspaceIds: ["user-global"],
    afterWorkspaceList: {
      workspaces: [
        { id: "user-global", name: "user", closing: false, placements: [] },
        { id: IDS.global, name: PREFIX, revision: 1, closing: false, placements: [] }
      ]
    }
  })
  assert.deepEqual(result, { globalId: IDS.global, revision: 1, name: PREFIX })
  assert.throws(() => resolveWorkspaceCreation({
    prefix: PREFIX,
    beforeWorkspaceIds: [],
    afterWorkspaceList: { workspaces: [] }
  }), error => error.code === "outcome_unknown")
  assert.throws(() => resolveWorkspaceCreation({
    prefix: PREFIX,
    beforeWorkspaceIds: [],
    afterWorkspaceList: { workspaces: [
      { id: IDS.global, name: PREFIX, closing: false, placements: [] },
      { id: "global-duplicate", name: PREFIX, closing: false, placements: [] }
    ] }
  }), error => error.code === "outcome_unknown")
})

test("Shell creation uses owner JSON identity and exact specification readback", () => {
  const argv = [INPUTS.executables.remotePi, "--no-extensions"]
  const candidate = shell({ role: "builder", id: IDS.builderShell, argv })
  const result = resolveShellCreation({
    role: "builder",
    name: `${PREFIX}-builder`,
    expectedCwd: INPUTS.remoteRepo,
    expectedArgv: argv,
    expectedNodeId: IDS.node,
    knownShellIds: [],
    ownerSnapshot: directOwnerSnapshot({ shells: [candidate] }),
    shellInspection: { shell: candidate }
  })
  assert.deepEqual(result, {
    role: "builder", id: IDS.builderShell, ownerId: IDS.owner,
    cwd: INPUTS.remoteRepo, argv, runId: null
  })
  assert.throws(() => resolveShellCreation({
    role: "builder", name: `${PREFIX}-builder`, expectedCwd: INPUTS.remoteRepo,
    expectedArgv: argv, expectedNodeId: IDS.node, knownShellIds: [],
    ownerSnapshot: directOwnerSnapshot({ shells: [candidate], launchers: [{ id: qualified("foreign-launcher") }] }),
    shellInspection: { shell: candidate }
  }), error => error.code === "foreign_resource")
})

test("sibling isolation rejects unrecorded Shells during each creation readback", () => {
  const argv = [INPUTS.executables.remotePi, "--no-extensions"]
  const builder = shell({ role: "builder", id: IDS.builderShell, argv })
  const foreign = shell({ role: "reviewer", id: "foreign-shell", argv })
  assert.throws(() => resolveShellCreation({
    role: "builder", name: `${PREFIX}-builder`, expectedCwd: INPUTS.remoteRepo,
    expectedArgv: argv, expectedNodeId: IDS.node, knownShellIds: [],
    ownerSnapshot: directOwnerSnapshot({ shells: [builder, foreign] }),
    shellInspection: { shell: builder }
  }), error => error.code === "foreign_resource")
})

test("generic open reports initial start, same Run, and non-atomic replacement honestly", () => {
  const pending = shell({ role: "builder", id: IDS.builderShell })
  const running = shell({ role: "builder", id: IDS.builderShell, runId: IDS.builderRun })
  assert.deepEqual(classifyPresentation(pending, running), {
    supported: true,
    classification: "initial_run_started",
    runId: IDS.builderRun,
    atomicExpectedRunGuarantee: false
  })
  assert.equal(classifyPresentation(running, running).classification, "same_run_observed")
  const replaced = shell({ role: "builder", id: IDS.builderShell, runId: "replacement-run" })
  const race = classifyPresentation(running, replaced)
  assert.equal(race.supported, false)
  assert.equal(race.classification, "run_replaced_during_generic_open")
  assert.equal(race.atomicExpectedRunGuarantee, false)
  assert.equal(race.outcomeUncertain, true)
  const exited = shell({ role: "builder", id: IDS.builderShell, runId: IDS.builderRun, status: "exited" })
  assert.equal(classifyPresentation(exited, exited).classification, "refused_exited_run")
})

test("event pages require ordered events and a snapshot at baselines", () => {
  const page = normalizeEventPage({
    cursor: "stream-a:4",
    snapshot: { workspaces: [] },
    events: [{ id: 3, event: "shell_created" }, { id: 4, event: "run_started" }]
  }, { baseline: true })
  assert.equal(page.baseline, true)
  assert.throws(() => normalizeEventPage({
    cursor: "stream-a:4", snapshot: {}, events: [{ id: 4 }, { id: 4 }]
  }, { baseline: true }), error => error.code === "event_order")
  assert.throws(() => normalizeEventPage({ cursor: "stream-a:4", events: [] }, { baseline: true }))
})

test("cursor expiry returns an explicit gap and fresh baseline", async () => {
  let calls = 0
  const boomux = new FakeBoomux(({ command }) => {
    assert.equal(command, "events")
    calls += 1
    if (calls === 1) throw spikeError("cursor_expired", "expired")
    return { cursor: "stream-b:9", snapshot: { workspaces: [] }, events: [] }
  })
  const runtime = new RemoteExecutionRuntime({ boomux })
  const result = await runtime.events("stream-a:4")
  assert.equal(result.baseline, true)
  assert.equal(result.gap, true)
  assert.equal(result.gapReason, "cursor_expired")
  assert.equal(result.cursor, "stream-b:9")
})
