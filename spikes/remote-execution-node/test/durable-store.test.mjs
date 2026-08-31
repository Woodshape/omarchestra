import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { makeValidationArtifact, validateValidationArtifact } from "../lib/artifacts.mjs"
import { DurableStateStore, MemoryDurableStore, createRunnerState } from "../lib/durable-store.mjs"
import { REMOTE_BINDINGS, REMOTE_IDS, fakeClock } from "./remote-fixtures.mjs"

function initialState() {
  return createRunnerState({
    receiptId: REMOTE_IDS.receipt,
    teamGoalId: REMOTE_IDS.teamGoal,
    bindings: REMOTE_BINDINGS,
    now: fakeClock(10)
  })
}

test("durable runner state uses owner-only atomic JSON storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-runner-state-"))
  try {
    const statePath = join(directory, "runner-state.json")
    const store = new DurableStateStore(statePath)
    await store.initialize(initialState())
    assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    const loaded = await store.load()
    loaded.bindings.builder.shellId = "changed-only-in-memory"
    assert.equal((await store.load()).bindings.builder.shellId, REMOTE_BINDINGS.builder.shellId)
    const text = await readFile(statePath, "utf8")
    assert.match(text, /runner-state\/v1/)
    await assert.rejects(() => store.initialize(initialState()), error => error.code === "state_exists")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("durable state refuses symlink substitution and preserves exact identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-runner-symlink-"))
  try {
    const target = join(directory, "target.json")
    const link = join(directory, "runner-state.json")
    const targetStore = new DurableStateStore(target)
    await targetStore.initialize(initialState())
    await symlink(target, link)
    const linkStore = new DurableStateStore(link)
    await assert.rejects(() => linkStore.load(), error => error.code === "unsafe_state")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("memory durable store serializes updates and rejects malformed state", async () => {
  const store = new MemoryDurableStore(initialState())
  await Promise.all([
    store.update(state => { state.updatedAtMs = 20 }),
    store.update(state => { state.updatedAtMs = 21 })
  ])
  assert.equal((await store.load()).updatedAtMs, 21)
  const invalid = initialState()
  invalid.bindings.builder.agentRunId = invalid.bindings.coordinator.agentRunId
  assert.throws(() => new MemoryDurableStore(invalid), error => error.code === "invalid_runner_state")
})

test("validation artifacts persist structured pass/fail metadata without output bodies", () => {
  const artifact = makeValidationArtifact({
    artifactId: "validation-1",
    command: ["/usr/bin/node", "-e", "process.stdout.write('ok')"],
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    result: { check: "harmless", status: "passed" },
    capturedAtMs: 20
  })
  assert.equal(validateValidationArtifact(artifact), artifact)
  assert.equal(artifact.result.passed, true)
  assert.equal(Object.hasOwn(artifact.result, "stdout"), true)
  assert.equal(typeof artifact.result.stdout.sha256, "string")
  assert.equal(Object.hasOwn(artifact.result, "stdoutText"), false)
  const failed = makeValidationArtifact({
    artifactId: "validation-2",
    command: ["/usr/bin/node", "-e", "process.exit(3)"],
    exitCode: 3,
    stdout: "",
    stderr: "failed",
    capturedAtMs: 21
  })
  assert.equal(failed.result.passed, false)
})