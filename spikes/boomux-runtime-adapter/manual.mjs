#!/usr/bin/env node
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { BoomuxRuntimeAdapter, makePrefix } from "./lib/adapter.mjs"
import { DirectArgvExecutor } from "./lib/executor.mjs"
import { AdapterError, adapterError, requireCondition } from "./lib/errors.mjs"
import { FileReceiptStore, newReceipt } from "./lib/receipt.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const localEvidence = path.join(here, "evidence", "local")
const probePath = path.join(here, "probe-process.mjs")
const roles = ["coordinator", "builder", "reviewer"]
const PREFLIGHT_SCHEMA = "omarchestra.boomux-runtime-adapter.preflight/v1"
const PROBE_SCHEMA = "omarchestra.boomux-probe/v1"
const MAX_CONFIG_BYTES = 1_048_576

function usage() {
  return [
    "usage:",
    "  manual.mjs preflight",
    "  manual.mjs create --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json --preflight spikes/boomux-runtime-adapter/evidence/local/PREFLIGHT.json --cwd ABSOLUTE --allow-live-mutations [--prefix PREFIX]",
    "  manual.mjs inspect --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json",
    "  manual.mjs subscribe --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json [--cursor CURSOR]",
    "  manual.mjs probe --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json --role ROLE",
    "  manual.mjs present --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json --role ROLE --allow-gui",
    "  manual.mjs present-all --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json --allow-gui",
    "  manual.mjs cleanup --receipt spikes/boomux-runtime-adapter/evidence/local/RECEIPT.json --allow-live-mutations"
  ].join("\n")
}

function parseArguments(values) {
  const [action, ...rest] = values
  if (!action) throw adapterError("invalid_arguments", usage())
  const flags = {}
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]
    requireCondition(item.startsWith("--"), "invalid_arguments", usage())
    const key = item.slice(2)
    requireCondition(!(key in flags), "invalid_arguments", `Duplicate option --${key}`)
    if (["allow-live-mutations", "allow-gui"].includes(key)) {
      flags[key] = true
      continue
    }
    const value = rest[++index]
    requireCondition(value !== undefined && !value.startsWith("--"), "invalid_arguments",
      `Option --${key} requires a value`)
    flags[key] = value
  }
  return { action, flags }
}

function privateEvidencePath(value, label) {
  requireCondition(typeof value === "string" && value.length > 0, "invalid_arguments",
    `${label} path under spikes/boomux-runtime-adapter/evidence/local is required`)
  const resolved = path.resolve(value)
  const prefix = `${localEvidence}${path.sep}`
  requireCondition(resolved.startsWith(prefix), `unsafe_${label}`,
    `${label} path must remain under spikes/boomux-runtime-adapter/evidence/local`)
  return resolved
}

const receiptPath = value => privateEvidencePath(value, "receipt")
const preflightPath = value => privateEvidencePath(value, "preflight")
const probeEvidencePath = (prefix, role) => path.join(localEvidence, `${prefix}-${role}.probe.json`)

function requireControlTerminal(action) {
  requireCondition(!process.env.BOOMUX_SHELL_ID, "unsafe_context",
    `${action} must run from an unmanaged control terminal`)
}

async function writePrivateEvidence(name, value) {
  await mkdir(localEvidence, { recursive: true, mode: 0o700 })
  const target = path.join(localEvidence, name)
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  })
  return target
}

async function adapterFor(flags, { allowGui = false } = {}) {
  const receipt = new FileReceiptStore(receiptPath(flags.receipt))
  return new BoomuxRuntimeAdapter({
    executor: new DirectArgvExecutor(),
    receiptStore: receipt,
    prefix: flags.prefix ?? null,
    teamGoalKey: "manual-spike",
    allowGui
  })
}

async function configurationSnapshot(configPathResult) {
  const value = String(configPathResult?.stdout ?? "").trim()
  requireCondition(path.isAbsolute(value) && !value.includes("\u0000") && !value.includes("\n"),
    "invalid_config_path", "Boomux config path was not one absolute path")
  try {
    const metadata = await lstat(value)
    requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), "unsafe_config_path",
      "Boomux config path is not a regular file")
    requireCondition(metadata.size <= MAX_CONFIG_BYTES, "config_too_large",
      `Boomux config exceeds ${MAX_CONFIG_BYTES} bytes`)
    const bytes = await readFile(value)
    return {
      path: value,
      state: "present",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64")
    }
  } catch (error) {
    if (error && error.code === "ENOENT") return { path: value, state: "absent" }
    throw error
  }
}

async function loadPreflight(value) {
  const target = preflightPath(value)
  const metadata = await lstat(target)
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), "unsafe_preflight",
    "Preflight evidence is not a regular file")
  let parsed
  try {
    parsed = JSON.parse(await readFile(target, "utf8"))
  } catch (cause) {
    throw adapterError("invalid_preflight", "Preflight evidence is not valid JSON", { cause })
  }
  requireCondition(parsed && parsed.schema === PREFLIGHT_SCHEMA, "invalid_preflight",
    "Preflight evidence schema is invalid")
  requireCondition(Number.isSafeInteger(parsed.capturedAtMs) && parsed.capturedAtMs > 0
    && parsed.capturedAtMs <= Date.now(), "invalid_preflight", "Preflight timestamp is invalid")
  requireCondition(typeof parsed.localNodeId === "string" && parsed.localNodeId.length > 0,
    "invalid_preflight", "Preflight local Node ID is invalid")
  requireCondition(parsed.snapshot && typeof parsed.snapshot === "object"
    && parsed.configuration && ["present", "absent"].includes(parsed.configuration.state),
  "invalid_preflight", "Preflight snapshot is incomplete")
  return { target, parsed }
}

async function bindReceiptToPreflight(store, prefix, evidence) {
  const current = await store.load()
  const binding = {
    path: evidence.target,
    capturedAtMs: evidence.parsed.capturedAtMs,
    localNodeId: evidence.parsed.localNodeId
  }
  if (current === null) {
    const receipt = newReceipt({ prefix, teamGoalKey: "manual-spike" })
    receipt.preflight = binding
    await store.initialize(receipt)
    return
  }
  requireCondition(current.prefix === prefix && current.teamGoalKey === "manual-spike",
    "receipt_mismatch", "Receipt prefix or Team Goal does not match")
  requireCondition(current.preflight && current.preflight.path === binding.path
    && current.preflight.capturedAtMs === binding.capturedAtMs
    && current.preflight.localNodeId === binding.localNodeId,
  "preflight_mismatch", "Receipt is not bound to this preflight snapshot")
}

async function referencesByRole(adapter) {
  const receipt = await adapter.receiptStore.load()
  requireCondition(receipt !== null, "receipt_missing", "Receipt does not exist")
  const result = {}
  for (const [reference, session] of Object.entries(receipt.sessions)) result[session.role] = reference
  return result
}

async function preflight() {
  const adapter = new BoomuxRuntimeAdapter({
    executor: new DirectArgvExecutor(),
    receiptStore: new FileReceiptStore(path.join(localEvidence, "unused-preflight-receipt.json"))
  })
  const snapshot = await adapter.preflightSnapshot()
  const capturedAtMs = Date.now()
  const evidence = {
    schema: PREFLIGHT_SCHEMA,
    capturedAtMs,
    localNodeId: snapshot.localNodeId,
    configuration: await configurationSnapshot(snapshot.configPath),
    snapshot
  }
  const target = await writePrivateEvidence(`preflight-${capturedAtMs}.json`, evidence)
  console.log(JSON.stringify({
    status: "captured",
    privateEvidence: target,
    baselineCursor: snapshot.events.cursor,
    localNodeId: snapshot.localNodeId,
    configurationState: evidence.configuration.state,
    configurationSha256: evidence.configuration.sha256 ?? null
  }, null, 2))
}

async function create(flags) {
  requireCondition(flags["allow-live-mutations"] === true, "mutation_not_authorized",
    "create requires --allow-live-mutations")
  requireControlTerminal("create")
  const requestedCwd = String(flags.cwd ?? "")
  requireCondition(path.isAbsolute(requestedCwd), "invalid_arguments", "create requires --cwd ABSOLUTE")
  const cwd = path.resolve(requestedCwd)
  const preflight = await loadPreflight(flags.preflight)
  const store = new FileReceiptStore(receiptPath(flags.receipt))
  const existingReceipt = await store.load()
  const prefix = flags.prefix ?? existingReceipt?.prefix ?? makePrefix()
  await bindReceiptToPreflight(store, prefix, preflight)
  const adapter = await adapterFor({ ...flags, prefix })
  await adapter.capabilities()
  const references = {}
  for (const role of roles) {
    references[role] = await adapter.create({
      sessionKey: role,
      role,
      cwd,
      argv: [process.execPath, probePath, "--role", role, "--prefix", prefix,
        "--evidence", probeEvidencePath(prefix, role)]
    })
  }
  console.log(JSON.stringify({ status: "created_pending", references }, null, 2))
}

async function inspect(flags) {
  const adapter = await adapterFor(flags)
  await adapter.capabilities()
  const references = await referencesByRole(adapter)
  const states = {}
  for (const role of roles) states[role] = await adapter.inspect(references[role])
  console.log(JSON.stringify({ states }, null, 2))
}

async function subscribe(flags) {
  const adapter = await adapterFor(flags)
  await adapter.capabilities()
  const references = await referencesByRole(adapter)
  const receipt = await adapter.receiptStore.load()
  const cursor = flags.cursor ?? receipt?.eventBaseline?.cursor ?? null
  const result = await adapter.subscribe(Object.values(references), cursor, { waitMs: 5000 })
  console.log(JSON.stringify(result, null, 2))
}

async function probe(flags) {
  const role = String(flags.role ?? "")
  requireCondition(roles.includes(role), "invalid_arguments", "probe requires --role coordinator|builder|reviewer")
  const adapter = await adapterFor(flags)
  await adapter.capabilities()
  const references = await referencesByRole(adapter)
  const receipt = await adapter.receiptStore.load()
  const reference = references[role]
  const session = receipt.sessions[reference]
  const state = await adapter.inspect(reference)
  requireCondition(state.state === "running" && state.run, "run_not_running",
    "Probe requires a running Shell Run")
  let evidence
  try {
    evidence = JSON.parse(await readFile(probeEvidencePath(receipt.prefix, role), "utf8"))
  } catch (cause) {
    throw adapterError("probe_invalid", "Probe evidence is unavailable or invalid", { cause })
  }
  requireCondition(evidence && evidence.schema === PROBE_SCHEMA && evidence.role === role
    && evidence.prefix === receipt.prefix && evidence.shellId === session.shellId
    && evidence.runId === session.runId && Number.isSafeInteger(evidence.pid) && evidence.pid > 0,
  "probe_identity_mismatch", "Probe evidence does not match the receipt-owned process")
  await adapter.receiptStore.update(next => {
    next.sessions[reference].probe = {
      pid: evidence.pid,
      runId: session.runId,
      evidencePath: probeEvidencePath(receipt.prefix, role),
      observedAtMs: Date.now()
    }
  })
  console.log(JSON.stringify({ reference, pid: evidence.pid, run: state.run }, null, 2))
}

async function present(flags, all) {
  requireCondition(flags["allow-gui"] === true, "gui_not_authorized",
    "presentation requires --allow-gui")
  requireControlTerminal("presentation")
  const adapter = await adapterFor(flags, { allowGui: true })
  await adapter.capabilities()
  const references = await referencesByRole(adapter)
  const selected = all ? roles : [String(flags.role ?? "")]
  requireCondition(selected.every(role => roles.includes(role)), "invalid_arguments",
    "present requires --role coordinator|builder|reviewer")
  const states = {}
  for (const role of selected) states[role] = await adapter.present(references[role])
  console.log(JSON.stringify({ states }, null, 2))
}

async function cleanup(flags) {
  requireCondition(flags["allow-live-mutations"] === true, "mutation_not_authorized",
    "cleanup requires --allow-live-mutations")
  requireControlTerminal("cleanup")
  const adapter = await adapterFor(flags)
  await adapter.capabilities()
  console.log(JSON.stringify(await adapter.cleanup(), null, 2))
}

async function main() {
  const { action, flags } = parseArguments(process.argv.slice(2))
  if (action === "preflight") return preflight()
  if (action === "create") return create(flags)
  if (action === "inspect") return inspect(flags)
  if (action === "subscribe") return subscribe(flags)
  if (action === "probe") return probe(flags)
  if (action === "present") return present(flags, false)
  if (action === "present-all") return present(flags, true)
  if (action === "cleanup") return cleanup(flags)
  throw adapterError("invalid_arguments", usage())
}

main().catch(error => {
  const report = error instanceof AdapterError
    ? { error: error.code, message: error.message, details: error.details }
    : { error: "internal", message: error.message }
  console.error(JSON.stringify(report, null, 2))
  process.exitCode = 1
})
