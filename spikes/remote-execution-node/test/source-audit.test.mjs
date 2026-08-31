import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"

const SPIKE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

// Dynamic inventory: every executable spike source and test file is audited,
// including files added later. File-appropriate guards are applied per group.
async function inventoryDir(relativeDirectory, extensions) {
  const directory = path.join(SPIKE_ROOT, relativeDirectory)
  const names = (await readdir(directory))
    .filter(name => extensions.some(extension => name.endsWith(extension)))
    .sort()
  const files = []
  for (const name of names) {
    const relative = relativeDirectory === "." ? name : `${relativeDirectory}/${name}`
    files.push({ relative, source: await readFile(path.join(directory, name), "utf8") })
  }
  return files
}

const SOURCE_FILES = [
  ...(await inventoryDir(".", [".mjs", ".js"])),
  ...(await inventoryDir("lib", [".mjs"]))
]
const TEST_FILES = await inventoryDir("test", [".mjs"])
// The audit test itself contains the guard-pattern tables as literal text; it is
// the auditor, not an audited behavior source, and is excluded from self-scanning.
const AUDITED_TEST_FILES = TEST_FILES.filter(file => file.relative !== "test/source-audit.test.mjs")
const EVIDENCE_AUTOMATED = await readFile(path.join(SPIKE_ROOT, "evidence", "automated.txt"), "utf8")

// Values verified in the assignment are setup facts, never harness constants.
const VERIFIED_TARGET_PATTERNS = [
  /hostinger/i,
  /2292a057/i,
  /srv1327543/i,
  /hstgr\.cloud/i,
  /\/srv\/omarchestra/,
  /omarchestra@[a-z0-9.-]+\.[a-z]/i
]

const UNIVERSAL_PROHIBITED = [
  { pattern: /shell:\s*true/, label: "shell:true execution" },
  { pattern: /(?:^|[^-\w])pkill(?:[^-\w]|$)|killall|\bkill\s+-9\b/, label: "broad process kill" },
  { pattern: /terminal\s+scrap|ansi\s+scrap|\bboomux\s+read\b/, label: "PTY/terminal scraping" },
  { pattern: /node-pty|\bptyInput\b|\binjectPty\b|\bwriteToPty\b|\bpty\.write\b/i, label: "PTY injection" },
  { pattern: /createAgentSession|\bInteractiveMode\b|\brunRpcMode\b|\bpi\.exec\b|\brpc-mode\b/, label: "hidden Pi SDK/RPC/child workers" },
  { pattern: /\bnode\s+(?:add|rename|retarget|forget|rekey|upgrade|uninstall)\b/, label: "Node registration mutation" },
  { pattern: /\bdaemon\s+(?:start|restart|stop)\b|daemon-reload|daemon-reexec/, label: "daemon lifecycle mutation" },
  { pattern: /\bboomux\s+(?:read|bootstrap\s+commit|system\s+reinstall)\b/, label: "private/unstable Boomux coupling" },
  { pattern: /(?:^|[^A-Za-z])\*\.(?:sock|service)/, label: "wildcard exact-cleanup bypass" }
]

function assertClean(file, prohibitions) {
  const scanned = stripGuardText(file.source)
  for (const { pattern, label } of prohibitions) {
    assert.doesNotMatch(scanned, pattern, `${file.relative}: ${label} matched ${pattern}`)
  }
}

// Negative test assertions and guard pattern tables contain the banned tokens as
// literal guard text. They are declarations of absence, so they are stripped
// before scanning; real usage lines remain.
function stripGuardText(source) {
  return source.split("\n")
    .filter(line => !/^\s*\/[^\n]*\/[a-z]*,?\s*$/.test(line))
    .filter(line => !/doesNotMatch|doesNotThrow|assert\.ok\(!/.test(line))
    .filter(line => !/pattern:/i.test(line))
    .join("\n")
}

test("source audit inventories every executable spike source file", () => {
  const relatives = SOURCE_FILES.map(file => file.relative)
  for (const expected of [
    "bridge-extension.js", "manual.mjs", "remote-helper.mjs", "runner.mjs",
    "lib/commands.mjs", "lib/executor.mjs", "lib/manual-gate.mjs", "lib/receipt.mjs",
    "lib/runtime.mjs", "lib/runner-core.mjs", "lib/protocol.mjs"
  ]) {
    assert.ok(relatives.includes(expected), `source audit missed ${expected}`)
  }
  for (const file of SOURCE_FILES) {
    assert.ok(file.source.length > 0, `${file.relative} is empty`)
  }
})

test("all spike source and test files are free of verified target hardcoding", () => {
  for (const file of [...SOURCE_FILES, ...AUDITED_TEST_FILES]) {
    assertClean(file, VERIFIED_TARGET_PATTERNS.map(pattern => ({ pattern, label: "hardcoded verified target value" })))
  }
})

test("all spike source and test files reject shell execution and broad cleanup coupling", () => {
  for (const file of [...SOURCE_FILES, ...AUDITED_TEST_FILES]) {
    assertClean(file, UNIVERSAL_PROHIBITED)
  }
})

test("node:child_process appears only in the generic direct-argv executor", () => {
  for (const file of SOURCE_FILES) {
    if (file.relative === "lib/executor.mjs") {
      assert.match(file.source, /node:child_process/)
      assert.match(file.source, /shell:\s*false/)
    } else {
      const scanned = stripGuardText(file.source)
      assert.doesNotMatch(scanned, /child_process/, `${file.relative}: unexpected child_process usage`)
      assert.doesNotMatch(scanned, /\bspawn\s*\(/, `${file.relative}: unexpected process spawning`)
    }
  }
  for (const file of AUDITED_TEST_FILES) {
    const scanned = stripGuardText(file.source)
    assert.doesNotMatch(scanned, /child_process/, `${file.relative}: tests must not spawn`)
    assert.doesNotMatch(scanned, /\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(/,
      `${file.relative}: tests must not execute processes`)
    assert.doesNotMatch(scanned, /\bDISPLAY\b|hyprctl|xdg-open|systemd-run\s+--unit/,
      `${file.relative}: tests must not perform hidden live or GUI actions`)
  }
})

test("the only Pi-facing execution API in visible sources is sendUserMessage on the host session", async () => {
  const bridge = SOURCE_FILES.find(file => file.relative === "bridge-extension.js")
  assert.ok(bridge)
  assert.match(bridge.source, /pi\.sendUserMessage\(?/)
  assert.doesNotMatch(bridge.source, /child_process|createAgentSession|runRpcMode|spawn\s*\(|exec\s*\(/)
})

test("automated evidence is fake-only and matches the documented automated commands", () => {
  const automatedPath = path.join(SPIKE_ROOT, "evidence", "automated.txt")
  assert.ok(automatedPath)
  // Starting Pi is forbidden in automated validation, including the retired
  // extension-loader smoke test; the evidence must not claim it.
  assert.doesNotMatch(EVIDENCE_AUTOMATED, /(?:^|\n)\s*.*\bpi\s+--offline\b/, "automated evidence invokes Pi")
  assert.doesNotMatch(EVIDENCE_AUTOMATED, /Pi offline extension-loader smoke test/, "automated evidence claims a retired Pi command")
  assert.doesNotMatch(EVIDENCE_AUTOMATED, /\bssh\s+-T\b/, "automated evidence must contain no live SSH command")
  assert.doesNotMatch(EVIDENCE_AUTOMATED, /\bboomux\s+(open|create|close)\b/, "automated evidence must contain no live Boomux mutation")
  for (const required of [
    "node --test spikes/remote-execution-node/test/*.test.mjs",
    "node spikes/remote-execution-node/test/link-check.mjs",
    "git diff --check"
  ]) {
    assert.ok(EVIDENCE_AUTOMATED.includes(required), `automated evidence lacks the command: ${required}`)
  }
})