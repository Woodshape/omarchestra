import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, rm, chmod, writeFile, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  parseArguments,
  runControlProxy,
  runFileStatus,
  runForeground,
  runPrerequisiteCheck,
  runSyncCheck
} from "../remote-helper.mjs"
import {
  NdjsonDecoder,
  encodeMessage,
  makeControlAck,
  makeControlRequest,
  makeControlResponse
} from "../lib/protocol.mjs"
import { REMOTE_IDS } from "./remote-fixtures.mjs"

test("remote helper accepts the exact positional action used by SSH argv construction", () => {
  const options = parseArguments([
    "control-proxy",
    "--socket", "/run/user/1001/runner.sock",
    "--receipt-id", REMOTE_IDS.receipt,
    "--team-goal-id", REMOTE_IDS.teamGoal,
    "--control-client-id", "desktop-1"
  ])
  assert.equal(options.action, "control-proxy")
  assert.equal(options.socketPath, "/run/user/1001/runner.sock")
  assert.throws(() => parseArguments(["sync-check"]), error => error.code === "invalid_arguments")
  assert.throws(() => parseArguments(["control-proxy", "--socket", "/tmp/x.sock"]),
    error => error.code === "invalid_arguments")
})

class FakeReadable extends EventEmitter {}

class FakeWritable {
  constructor() { this.writes = [] }
  write(value) { this.writes.push(value); return true }
}

class FakeProxySocket extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.decoder = new NdjsonDecoder()
    this.writable = true
    this.destroyed = false
  }
  write(value) {
    for (const message of this.decoder.push(value)) {
      if (message.type === "control_hello") this.emit("data", encodeMessage(makeControlAck({
        connectionId: "control-1", accepted: true, timestamp: 2
      })))
      if (message.type === "control_request") this.emit("data", encodeMessage(makeControlResponse({
        requestId: message.requestId, status: "ok", data: { forwarded: true }, timestamp: 3
      })))
    }
    return true
  }
  end() { this.destroy() }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.writable = false
    this.emit("close")
  }
}

class FakeProxyNet {
  constructor() { this.socket = null }
  createConnection(options) {
    this.socket = new FakeProxySocket(options)
    queueMicrotask(() => this.socket.emit("connect"))
    return this.socket
  }
}

test("remote helper forwards only framed control messages over the Unix path", async () => {
  const net = new FakeProxyNet()
  const readable = new FakeReadable()
  const writable = new FakeWritable()
  const finished = runControlProxy({
    socketPath: "/tmp/remote-helper.sock",
    receiptId: REMOTE_IDS.receipt,
    teamGoalId: REMOTE_IDS.teamGoal,
    controlClientId: "desktop-test",
    readable,
    writable,
    netModule: net,
    now: () => 1
  })
  await new Promise(resolve => setImmediate(resolve))
  readable.emit("data", encodeMessage(makeControlRequest({
    requestId: "forwarded-request", operation: "ping", payload: {}, timestamp: 4
  })))
  readable.emit("end")
  await finished
  assert.deepEqual(net.socket.options, { path: "/tmp/remote-helper.sock" })
  const outputDecoder = new NdjsonDecoder()
  const output = writable.writes.flatMap(value => outputDecoder.push(value))
  assert.deepEqual(output.map(message => message.type), ["control_ack", "control_response"])
  assert.equal(output[1].requestId, "forwarded-request")
})

test("prerequisite check validates an owner-only runtime directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-helper-test-"))
  const runtime = path.join(root, "runtime")
  const repository = path.join(root, "repository")
  await mkdir(runtime, { mode: 0o700 })
  await mkdir(repository, { mode: 0o700 })
  await chmod(runtime, 0o700)
  try {
    const result = await runPrerequisiteCheck(repository, {
      uid: process.getuid(),
      environment: { XDG_RUNTIME_DIR: runtime }
    })
    assert.equal(result.runtimeMode, "0700")
    assert.equal(result.uid, process.getuid())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Linux prerequisite check derives /run/user/<uid> when verified SSH leaves XDG_RUNTIME_DIR unset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-helper-runtime-"))
  const runtime = path.join(root, "user", String(process.getuid()))
  const repository = path.join(root, "repository")
  await mkdir(runtime, { recursive: true, mode: 0o700 })
  await mkdir(repository, { recursive: true, mode: 0o700 })
  await chmod(runtime, 0o700)
  try {
    const derived = await runPrerequisiteCheck(repository, {
      uid: process.getuid(),
      environment: {},
      platform: "linux",
      runtimeBase: root
    })
    assert.equal(derived.runtimeDirectory, `${root}/user/${process.getuid()}`)
    assert.equal(derived.runtimeDirectorySource, "derived_linux_uid")
    assert.equal(derived.runtimeMode, "0700")
    assert.equal(derived.uid, process.getuid())
    await assert.rejects(() => runPrerequisiteCheck(repository, {
      uid: process.getuid(), environment: {}, platform: "linux", runtimeBase: path.join(root, "absent")
    }), error => error.code === "missing_runtime_directory")
    await assert.rejects(() => runPrerequisiteCheck(repository, {
      uid: 1001, environment: { XDG_RUNTIME_DIR: runtime }, platform: "darwin"
    }), error => error.code === "unsafe_runtime_directory")
    await assert.rejects(() => runPrerequisiteCheck(repository, {
      uid: 1001, environment: {}, platform: "darwin", runtimeBase: root
    }), error => error.code === "missing_runtime_directory")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("sync check resolves the spike tree beneath the repository root and rejects traversal", async () => {
  const repository = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "")
  const result = await runSyncCheck(repository)
  assert.equal(result.schema, "omarchestra.remote-execution-node.sync-check/v1")
  assert.equal(result.complete, true)
  assert.equal(result.spikeRoot, `${repository}/spikes/remote-execution-node`)
  assert.ok(result.files.length >= 7)
  for (const file of result.files) {
    assert.equal(file.status, "present")
    assert.match(file.sha256, /^[0-9a-f]{64}$/)
    assert.equal(Object.hasOwn(file, "contents"), false)
    assert.match(file.relative, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    assert.ok(file.relative.startsWith("spikes/remote-execution-node/"))
    assert.ok(!file.relative.split("/").includes(".."))
    assert.equal(file.path, `${repository}/${file.relative}`)
  }
})

test("sync check reports exact missing files and refuses symlinks and traversal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-helper-sync-"))
  const spike = path.join(root, "spikes", "remote-execution-node")
  await mkdir(path.join(spike, "lib"), { recursive: true, mode: 0o700 })
  try {
    await writeFile(path.join(spike, "runner.mjs"), "// spike fixture\n")
    await symlink("/etc/hostname", path.join(spike, "bridge-extension.js"))
    const result = await runSyncCheck(root)
    const runner = result.files.find(file => file.relative === "spikes/remote-execution-node/runner.mjs")
    const bridge = result.files.find(file => file.relative === "spikes/remote-execution-node/bridge-extension.js")
    assert.equal(runner.status, "present")
    assert.equal(bridge.status, "symlink")
    assert.equal(result.complete, false)
    // The repository root itself must be a real nonsymlink directory: a symlinked root is refused.
    await symlink("/etc", path.join(root, "escape"))
    await assert.rejects(() => runSyncCheck(path.join(root, "escape", "hostname")),
      error => "code" in error)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("remote helper file-status reports owner-path facts for the exact cleanup readback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-helper-filestatus-"))
  try {
    const statePath = path.join(root, "runner.state.json")
    const socketPath = path.join(root, "runner.sock")
    await writeFile(statePath, "{}\n", { mode: 0o600 })
    const symlinkedSocket = await symlink("/dev/null", socketPath)
    void symlinkedSocket
    const symlinkReport = await runFileStatus({ socketPath, statePath })
    assert.equal(symlinkReport.files.find(file => file.path === socketPath).kind, "symlink")
    assert.equal(symlinkReport.files.find(file => file.path === socketPath).status, "symlink",
      "symlinks must never be followed or reported as the expected kind")
    assert.equal(symlinkReport.spikePathsAbsent, false)
    await unlink(socketPath)
    const missing = await runFileStatus({ socketPath, statePath })
    assert.deepEqual(missing.files.map(file => file.status).sort(), ["file present", "missing"])
    const socketEntry = missing.files.find(file => file.path === socketPath)
    assert.equal(socketEntry.status, "missing")
    const stateEntry = missing.files.find(file => file.path === statePath)
    assert.equal(stateEntry.status, "file present")
    assert.equal(stateEntry.kind, "file")
    assert.equal(stateEntry.ownerUid, process.getuid())
    assert.match(stateEntry.mode, /^0600$/)
    void runFileStatus
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("remote helper file-status rejects missing options and non-absolute paths", () => {
  const missing = parseArgumentsSafe(["file-status", "--state", "/tmp/s.json"])
  assert.equal(missing.code, "invalid_arguments")
  assert.match(missing.message, /--socket/, "the missing-option error must name --socket")
  const invalidPaths = [
    { argv: ["file-status", "--socket", "relative.sock", "--state", "/tmp/s.json"], code: "invalid_path" },
    { argv: ["file-status", "--socket", "/run/x.sock", "--state", "relative.json"], code: "invalid_path" },
    { argv: ["file-status", "--socket", "/run/user/1001/short", "--state", "/tmp/s.json"], code: "invalid_socket_path" }
  ]
  for (const { argv, code } of invalidPaths) {
    assert.throws(() => parseArguments(argv), error => error.code === code,
      `expected ${code} for ${argv.join(" ")}`)
  }
})

function parseArgumentsSafe(argv) {
  try {
    parseArguments(argv)
    return { message: "" }
  } catch (error) {
    return error
  }
}

test("file-status parses the exact generated cleanup argv and foreground-dispatches without live action", async () => {
  // The cleanup plan generates: remote-helper.mjs file-status --socket S --state P
  // The parser must accept every option of that exact argv.
  const parsed = parseArguments(["file-status",
    "--socket", "/run/user/1001/spike.sock",
    "--state", "/srv/repo/spikes/remote-execution-node/evidence/local/spike.state.json"])
  assert.equal(parsed.action, "file-status")
  assert.equal(parsed.socketPath, "/run/user/1001/spike.sock")
  assert.equal(parsed.statePath, "/srv/repo/spikes/remote-execution-node/evidence/local/spike.state.json")

  const missingState = parseArgumentsSafe(["file-status", "--socket", "/run/user/1001/spike.sock"])
  assert.match(missingState.message, /--state/, "the missing-option error must name --state")

  // Foreground dispatch: file-status must be served by runFileStatus, not fall
  // through to the control proxy. exercised without any live process action.
  const root = await mkdtemp(path.join(tmpdir(), "remote-helper-fg-"))
  try {
    const statePath = path.join(root, "state.json")
    const socketPath = path.join(root, "socket.sock")
    await writeFile(statePath, "{}\n", { mode: 0o600 })
    const originalWrite = process.stdout.write.bind(process.stdout)
    const chunks = []
    process.stdout.write = value => { chunks.push(String(value)); return true }
    try {
      await runForeground(["file-status", "--socket", socketPath, "--state", statePath])
    } finally {
      process.stdout.write = originalWrite
    }
    assert.equal(chunks.length, 1)
    const report = JSON.parse(chunks[0])
    assert.equal(report.schema, "omarchestra.remote-execution-node.file-status/v1")
    assert.deepEqual(report.files.map(file => file.status).sort(), ["file present", "missing"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
