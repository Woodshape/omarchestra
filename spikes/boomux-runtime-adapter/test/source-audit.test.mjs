import assert from "node:assert/strict"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { commands } from "../lib/commands.mjs"
import { DirectArgvExecutor } from "../lib/executor.mjs"
import {
  FakeExecutor,
  IDS,
  PREFIX
} from "./fixtures.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const productionFiles = [
  "lib/adapter.mjs",
  "lib/commands.mjs",
  "lib/envelopes.mjs",
  "lib/errors.mjs",
  "lib/executor.mjs",
  "lib/receipt.mjs",
  "manual.mjs",
  "probe-process.mjs"
]

async function productionSource() {
  const libraryFiles = (await readdir(path.join(root, "lib")))
    .filter(name => name.endsWith(".mjs")).map(name => `lib/${name}`).sort()
  const rootFiles = (await readdir(root))
    .filter(name => name.endsWith(".mjs")).sort()
  assert.deepEqual(productionFiles.slice().sort(), [...libraryFiles, ...rootFiles].sort(),
    "source audit file inventory must include every production .mjs file")
  const entries = await Promise.all(productionFiles.map(async relative => {
    const file = path.join(root, relative)
    return [relative, await readFile(file, "utf8")]
  }))
  return entries
}

test("production source uses only the direct argv executor with shell execution disabled", async () => {
  const entries = await productionSource()
  const combined = entries.map(([, source]) => source).join("\n")
  const executorSource = Object.fromEntries(entries)["lib/executor.mjs"]

  assert.match(executorSource, /import\s+\{\s*spawn\s*\}\s+from\s+["']node:child_process["']/)
  assert.match(executorSource, /spawn\(this\.binary,\s*argv,\s*\{[\s\S]*shell:\s*false/)
  assert.doesNotMatch(combined, /\b(?:exec|execFile|fork)\s*\(/)
  assert.doesNotMatch(combined, /\bshell\s*:\s*true\b/)
  assert.doesNotMatch(combined, /(?:^|[\s"'])\/(?:bin\/)?(?:sh|bash|zsh)\s+-c(?:[\s"']|$)/)
  assert.doesNotMatch(combined, /\b(?:sh|bash|zsh)\s+-c\b/)
  assert.doesNotMatch(combined, /node:(?:net|sqlite|dgram)\b/)
  assert.doesNotMatch(combined, /(?:createConnection|createSocket|UnixSocket|SOCK_STREAM)/)
})

test("production source has no private Boomux state, Rust, or hidden attachment coupling", async () => {
  const entries = await productionSource()
  const combined = entries.map(([, source]) => source).join("\n")
  assert.doesNotMatch(combined,
    /\.local[\\/]state[\\/]boomux|XDG_(?:STATE|RUNTIME)_DIR|boomux[\\/](?:state|runtime)|boomux[.]sock/i)
  assert.doesNotMatch(combined,
    /(?:pi-boomux|Cargo\.toml|\.rs\b|serde|boomux[\\/]src|sqlite|qml|\.qml\b|omarchy)/i)
  assert.doesNotMatch(combined, /__attach|boomux\s+__\w+/)
  assert.doesNotMatch(combined, /process\.send|process\.disconnect/)
  assert.doesNotMatch(combined, /commands\.read|PROBE_MARKER|boomux\s+read/,
    "runtime code must not scrape rendered terminal output")
})

test("production source contains no forbidden operational command literals", async () => {
  const entries = await productionSource()
  const combined = entries.map(([, source]) => source).join("\n")
  for (const pattern of [
    /["'](?:daemon[.]start|daemon[.]stop|daemon[.]restart)["']/,
    /["'](?:desktop|setup|update|uninstall)["']/,
    /["'](?:integration[.](?:install|uninstall|setup))["']/,
    /["'](?:node[.](?:add|rename|retarget|forget|upgrade|uninstall|reauthenticate|rekey))["']/,
    /["'](?:workspace[.](?:open|adopt|link|retry))["']/,
    /["'](?:web[.](?:start|stop|status))["']/,
    /["']close --focused["']/,
    /["']--(?:all|focused|open)["']/,
    /["']daemon["']\s*,\s*["'](?:start|stop|restart)["']/,
    /["']node["']\s*,\s*["'](?:add|rename|retarget|forget|upgrade|uninstall|reauthenticate|rekey)["']/,
    /["']workspace["']\s*,\s*["'](?:open|adopt|link|retry)["']/
  ]) {
    assert.doesNotMatch(combined, pattern)
  }
})

test("all production command execution goes through command builders", async () => {
  const entries = await productionSource()
  const source = Object.fromEntries(entries)
  assert.doesNotMatch(source["lib/adapter.mjs"], /executor\.run\s*\(\s*\[/)
  assert.doesNotMatch(source["manual.mjs"], /executor\.run\s*\(\s*\[/)
  assert.deepEqual(Object.keys(commands).sort(), [
    "agentList", "capabilities", "configPath", "configValidate", "daemonStatus", "events",
    "integrationList", "integrationStatus", "list", "nodeSnapshot", "shellClose",
    "shellCreate", "shellInspect", "shellOpen", "workspaceClose", "workspaceCreate",
    "workspaceInspect", "workspaceList"
  ].sort())
})

test("production command builders stay inside the public spike allowlist", () => {
  const commandCases = [
    ["capabilities", commands.capabilities()],
    ["daemon.status", commands.daemonStatus()],
    ["workspace.list", commands.workspaceList()],
    ["workspace.inspect", commands.workspaceInspect(IDS.coordinator)],
    ["node.snapshot", commands.nodeSnapshot()],
    ["list", commands.list()],
    ["shell.inspect", commands.shellInspect(IDS.coordinatorShell)],
    ["agent.list", commands.agentList(IDS.owner)],
    ["integration.list", commands.integrationList()],
    ["integration.status", commands.integrationStatus()],
    ["events", commands.events({ after: "stream-001:10", limit: 256, waitMs: 0 })],
    ["config.path", commands.configPath()],
    ["config.validate", commands.configValidate()],
    ["workspace.create", commands.workspaceCreate(PREFIX)],
    ["shell.create", commands.shellCreate({
      globalWorkspaceId: IDS.coordinator, nodeId: IDS.node, name: `${PREFIX}-builder`,
      cwd: "/tmp/boomux-spike", argv: ["node", "probe-process.mjs"]
    })],
    ["open", commands.shellOpen({
      shellId: IDS.coordinatorShell, globalWorkspaceId: IDS.coordinator, title: `${PREFIX}-coordinator`
    })],
    ["shell.close", commands.shellClose({
      shellId: IDS.coordinatorShell, ownerWorkspaceId: IDS.owner
    })],
    ["workspace.close", commands.workspaceClose(IDS.coordinator)]
  ]
  const allowed = new Set([
    "capabilities", "daemon status", "workspace list", "workspace inspect", "node snapshot",
    "list", "shell inspect", "agent list", "integration list", "integration status", "events",
    "config path", "config validate",
    "workspace create", "shell create", "open", "shell close", "workspace close"
  ])
  for (const [label, argv] of commandCases) {
    assert.ok(argv.length > 0, `${label} must not be empty`)
    assert.ok(argv.every(value => typeof value === "string"), `${label} argv must be strings`)
    const commandKey = ["capabilities", "list", "events", "open"].includes(argv[0])
      ? argv[0] : argv.slice(0, 2).join(" ")
    assert.ok(allowed.has(commandKey),
      `${label} emitted an unapproved command: ${argv.join(" ")}`)
  }

  assert.equal(commands.shellOpen({
    shellId: IDS.coordinatorShell, globalWorkspaceId: IDS.coordinator, title: "title"
  }).at(-1), "--takeover")
  for (const argv of commandCases.map(([, value]) => value)) {
    assert.equal(argv.includes("__attach"), false)
    assert.equal(argv.includes("--focused"), false)
    assert.equal(argv.includes("--all"), false)
  }
})

test("fake executor cannot be bypassed into GUI or forbidden operational commands", async () => {
  const executor = new FakeExecutor(() => null)
  for (const argv of [
    ["open", IDS.coordinatorShell],
    ["desktop", "close"],
    ["daemon", "stop"],
    ["daemon", "restart"],
    ["setup"],
    ["update"],
    ["uninstall"],
    ["integration", "install", "pi"],
    ["node", "add", "host"]
  ]) {
    await assert.rejects(() => executor.run(argv), error => {
      assert.equal(error.code, "unexpected_fake_call")
      return true
    })
  }
  assert.equal(executor.calls.length, 9)
})

test("source audit does not instantiate a real process", () => {
  assert.equal(typeof DirectArgvExecutor, "function")
  assert.equal(typeof FakeExecutor, "function")
})
