import net from "node:net"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  NdjsonDecoder,
  encodeMessage,
  makeControlHello
} from "./lib/protocol.mjs"
import { errorReport, requireCondition, spikeError } from "./lib/errors.mjs"
import { validateAbsolutePath, validateUnixSocketPath, validateUuid, validateOpaqueId } from "./lib/validation.mjs"

export function parseArguments(argv) {
  const values = {}
  const allowed = new Set(["action", "socket", "state", "receipt-id", "team-goal-id", "control-client-id", "repo", "help"])
  let start = 0
  if (typeof argv[0] === "string" && !argv[0].startsWith("--")) {
    values.action = argv[0]
    start = 1
  }
  for (let index = start; index < argv.length; index += 1) {
    const item = argv[index]
    requireCondition(typeof item === "string" && item.startsWith("--"),
      "invalid_arguments", "Remote helper arguments must be named options")
    const key = item.slice(2)
    requireCondition(allowed.has(key), "invalid_arguments", `Unknown remote helper option --${key}`)
    requireCondition(!Object.hasOwn(values, key), "invalid_arguments", `Duplicate remote helper option --${key}`)
    if (key === "help") {
      values[key] = true
      continue
    }
    const value = argv[++index]
    requireCondition(typeof value === "string" && value.length > 0 && !value.startsWith("--"),
      "invalid_arguments", `Remote helper option --${key} requires a value`)
    values[key] = value
  }
  if (values.help) return { help: true }
  if (values.action === "sync-check" || values.action === "prerequisites") {
    requireCondition(Object.hasOwn(values, "repo"), "invalid_arguments", "Missing required option --repo")
    return { action: values.action, repoPath: validateAbsolutePath(values.repo, "remote repository") }
  }
  if (values.action === "file-status") {
    for (const key of ["socket", "state"]) {
      requireCondition(Object.hasOwn(values, key), "invalid_arguments", `Missing required option --${key}`)
    }
    return {
      action: values.action,
      socketPath: validateUnixSocketPath(values.socket),
      statePath: validateAbsolutePath(values.state, "runner state path")
    }
  }
  requireCondition(values.action === "control-proxy" || values.action === "runner-control",
    "invalid_action", "Remote helper action must be control-proxy, prerequisites, or sync-check")
  for (const key of ["socket", "receipt-id", "team-goal-id"]) {
    requireCondition(Object.hasOwn(values, key), "invalid_arguments", `Missing required option --${key}`)
  }
  return {
    action: values.action,
    socketPath: validateUnixSocketPath(values.socket),
    receiptId: validateUuid(values["receipt-id"], "receipt ID"),
    teamGoalId: validateUuid(values["team-goal-id"], "Team Goal ID"),
    controlClientId: values["control-client-id"] === undefined
      ? `ssh-control-${process.pid}`
      : validateOpaqueId(values["control-client-id"], "control client ID")
  }
}

const SPIKE_DIRECTORY = "spikes/remote-execution-node"

// Resolved beneath the explicit repository root, never at the repository top level.
const REQUIRED_SPIKE_FILES = Object.freeze([
  "runner.mjs",
  "remote-helper.mjs",
  "bridge-extension.js",
  "lib/protocol.mjs",
  "lib/errors.mjs",
  "lib/validation.mjs",
  "lib/durable-store.mjs",
  "lib/runner-core.mjs",
  "lib/artifacts.mjs",
  "lib/bridge-client.mjs",
  "lib/bridge-state.mjs",
  "lib/telemetry.mjs"
].map(relative => `${SPIKE_DIRECTORY}/${relative}`))

export async function runPrerequisiteCheck(repoPath, {
  environment = process.env,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  runtimeBase = "/run"
} = {}) {
  validateAbsolutePath(repoPath, "remote repository")
  requireCondition(Number.isSafeInteger(uid) && uid > 0,
    "unsafe_execution_identity", "Remote prerequisite identity must be an unprivileged non-root UID")
  let runtimeDirectory = environment?.XDG_RUNTIME_DIR
  let runtimeDirectorySource = "xdg_runtime_dir"
  if (typeof runtimeDirectory !== "string") {
    // Verified SSH sessions can leave XDG_RUNTIME_DIR unset even for an active lingering
    // user manager. On Linux the standard location /run/user/<uid> is derived instead and
    // the same nonsymlink/owner/0700 validation is applied.
    requireCondition(platform === "linux", "missing_runtime_directory",
      "XDG_RUNTIME_DIR is required, and /run/user/<uid> derivation is Linux-only")
    runtimeDirectory = `${validateRuntimeBase(runtimeBase)}/user/${uid}`
    runtimeDirectorySource = "derived_linux_uid"
  }
  validateAbsolutePath(runtimeDirectory, "runtime directory")
  let runtime
  try { runtime = await lstat(runtimeDirectory) }
  catch (error) {
    if (error?.code === "ENOENT") throw spikeError("missing_runtime_directory", "Remote runtime directory does not exist")
    throw error
  }
  requireCondition(runtime.isDirectory() && !runtime.isSymbolicLink(),
    "unsafe_runtime_directory", "Remote runtime directory is not a real directory")
  if (runtime.uid !== undefined) requireCondition(runtime.uid === uid,
    "unsafe_runtime_directory", "Remote runtime directory is not owned by the execution UID")
  requireCondition((runtime.mode & 0o777) === 0o700,
    "unsafe_runtime_directory", "Remote runtime directory must be mode 0700")
  let repository
  try { repository = await lstat(repoPath) }
  catch (error) {
    if (error?.code === "ENOENT") throw spikeError("repository_missing", "Remote repository does not exist")
    throw error
  }
  requireCondition(repository.isDirectory() && !repository.isSymbolicLink(),
    "unsafe_repository", "Remote repository is not a real directory")
  if (repository.uid !== undefined) requireCondition(repository.uid === uid,
    "unsafe_repository", "Remote repository is not owned by the execution UID")
  return {
    schema: "omarchestra.remote-execution-node.prerequisites/v1",
    uid,
    runtimeDirectory,
    runtimeDirectorySource,
    runtimeMode: "0700",
    repository: repoPath
  }
}

function validateRuntimeBase(value) {
  requireCondition(typeof value === "string" && value.startsWith("/") && !value.endsWith("/"),
    "invalid_runtime_base", "Runtime base must be an absolute directory without a trailing slash")
  requireCondition(!value.includes("//") && !value.split("/").includes(".."),
    "invalid_runtime_base", "Runtime base must not contain traversal segments")
  return value
}

export async function runSyncCheck(repoPath) {
  validateAbsolutePath(repoPath, "remote repository")
  const root = await lstat(repoPath)
  requireCondition(root.isDirectory() && !root.isSymbolicLink(), "unsafe_repository", "Remote repository is not a real directory")
  const spikeRoot = path.join(repoPath, SPIKE_DIRECTORY)
  const files = []
  for (const relative of REQUIRED_SPIKE_FILES) {
    requireCondition(!relative.split("/").includes(".."),
      "unsafe_repository", "Required spike file paths must not traverse upward")
    const inner = relative.slice(SPIKE_DIRECTORY.length + 1)
    const target = path.join(spikeRoot, inner)
    requireCondition(path.relative(spikeRoot, target) === inner,
      "unsafe_repository", "Required spike file resolution stayed outside the spike directory")
    let status = "present"
    let size = 0
    let sha256 = null
    try {
      const metadata = await lstat(target)
      if (metadata.isSymbolicLink()) status = "symlink"
      else if (!metadata.isFile()) status = "irregular"
      else {
        requireCondition(metadata.size <= 1_048_576, "repository_file_too_large", `${relative} exceeds the sync-check bound`)
        const bytes = await readFile(target)
        size = bytes.length
        sha256 = createHash("sha256").update(bytes).digest("hex")
      }
    } catch (error) {
      if (error?.code === "ENOENT") status = "missing"
      else throw error
    }
    files.push({ relative, path: target, status, size, sha256 })
  }
  return {
    schema: "omarchestra.remote-execution-node.sync-check/v1",
    repository: repoPath,
    spikeRoot,
    files,
    complete: files.every(file => file.status === "present")
  }
}

// Read-only owner-path status for the exact cleanup readback. It reports each
// exact path's existence, kind, mode, and owner UID, without deleting, listing,
// or following symlinks (lstat only). Expected outcome after cleanup: missing.
export async function runFileStatus({ socketPath, statePath }) {
  validateUnixSocketPath(socketPath)
  validateAbsolutePath(statePath, "runner state path")
  const files = []
  for (const [label, target, expectedKind] of [
    ["socket", socketPath, "socket"],
    ["state", statePath, "file"]
  ]) {
    let metadata = null
    try {
      metadata = await lstat(target)
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    if (metadata === null) {
      files.push({ label, path: target, status: "missing", exists: false, kind: "missing" })
      continue
    }
    // One lstat snapshot only: symlinks are reported as symlink and never followed.
    const kind = metadata.isSymbolicLink() ? "symlink"
      : metadata.isSocket() && expectedKind === "socket" ? "socket"
      : metadata.isFile() && expectedKind === "file" ? "file"
      : "other"
    const present = kind === expectedKind
    files.push({
      label,
      path: target,
      status: present ? `${expectedKind} present` : kind,
      exists: present,
      kind,
      mode: (metadata.mode & 0o777).toString(8).padStart(4, "0"),
      ownerUid: metadata.uid ?? null
    })
  }
  return {
    schema: "omarchestra.remote-execution-node.file-status/v1",
    socketPath,
    statePath,
    files,
    spikePathsAbsent: files.every(file => file.status === "missing")
  }
}

export function runControlProxy({
  socketPath,
  receiptId,
  teamGoalId,
  controlClientId,
  readable = process.stdin,
  writable = process.stdout,
  netModule = net,
  now = () => Date.now()
}) {
  validateUnixSocketPath(socketPath)
  validateUuid(receiptId, "receipt ID")
  validateUuid(teamGoalId, "Team Goal ID")
  validateOpaqueId(controlClientId, "control client ID")
  return new Promise((resolve, reject) => {
    const socket = netModule.createConnection({ path: socketPath })
    const inputDecoder = new NdjsonDecoder()
    const outputDecoder = new NdjsonDecoder()
    const pending = []
    let connected = false
    let settled = false
    let inputEnded = false
    const finish = (error = null) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
    }
    const send = message => {
      const encoded = encodeMessage(message)
      if (!connected) pending.push(encoded)
      else socket.write(encoded)
    }
    const flush = () => {
      while (connected && pending.length > 0) socket.write(pending.shift())
      if (inputEnded && connected && pending.length === 0) socket.end()
    }
    socket.once("connect", () => {
      connected = true
      send(makeControlHello({
        receiptId,
        teamGoalId,
        controlClientId,
        timestamp: now()
      }))
      flush()
    })
    socket.on("data", chunk => {
      try {
        const messages = outputDecoder.push(chunk)
        for (const message of messages) writable.write(encodeMessage(message))
      } catch (error) {
        if (typeof socket.destroy === "function") socket.destroy()
        finish(error)
      }
    })
    socket.once("error", error => finish(spikeError("control_transport_failed", error.message)))
    socket.once("close", () => finish())
    readable.on("data", chunk => {
      try {
        const messages = inputDecoder.push(chunk)
        for (const message of messages) {
          requireCondition(message.type === "control_request", "invalid_control_message",
            "SSH control stdin accepts only control_request messages")
          send(message)
        }
        flush()
      } catch (error) {
        if (typeof socket.destroy === "function") socket.destroy()
        finish(error)
      }
    })
    readable.once("end", () => {
      try {
        for (const message of inputDecoder.finish()) {
          requireCondition(message.type === "control_request", "invalid_control_message",
            "SSH control stdin accepts only control_request messages")
          send(message)
        }
        inputEnded = true
        flush()
      } catch (error) {
        if (typeof socket.destroy === "function") socket.destroy()
        finish(error)
      }
    })
  })
}

export async function runForeground(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stdout.write("Usage: node remote-helper.mjs ACTION [--repo PATH] | node remote-helper.mjs control-proxy --socket PATH --receipt-id UUID --team-goal-id UUID [--control-client-id ID]\n")
    return
  }
  if (options.action === "prerequisites") {
    process.stdout.write(`${JSON.stringify(await runPrerequisiteCheck(options.repoPath), null, 2)}\n`)
    return
  }
  if (options.action === "sync-check") {
    process.stdout.write(`${JSON.stringify(await runSyncCheck(options.repoPath), null, 2)}\n`)
    return
  }
  if (options.action === "file-status") {
    process.stdout.write(`${JSON.stringify(await runFileStatus(options), null, 2)}\n`)
    return
  }
  await runControlProxy(options)
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedAsScript) {
  runForeground().catch(error => {
    process.stderr.write(`${JSON.stringify(errorReport(error))}\n`)
    process.exitCode = 1
  })
}