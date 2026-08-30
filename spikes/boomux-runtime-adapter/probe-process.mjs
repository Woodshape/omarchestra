import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const localEvidence = path.join(here, "evidence", "local")

function valueFor(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const role = valueFor("--role")
const prefix = valueFor("--prefix")
const evidenceValue = valueFor("--evidence")
const evidencePath = evidenceValue === null ? null : path.resolve(evidenceValue)
const validEvidencePath = evidencePath !== null
  && evidencePath.startsWith(`${localEvidence}${path.sep}`)

if (!role || !prefix || !validEvidencePath) {
  console.error("probe-process requires --role, --prefix, and private --evidence")
  process.exitCode = 2
} else {
  const evidence = {
    schema: "omarchestra.boomux-probe/v1",
    role,
    prefix,
    pid: process.pid,
    shellId: process.env.BOOMUX_SHELL_ID ?? null,
    runId: process.env.BOOMUX_RUN_ID ?? null
  }
  await mkdir(localEvidence, { recursive: true, mode: 0o700 })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  })
  console.log(`Omarchestra Boomux probe: role=${role} pid=${process.pid}`)
  console.log(`Shell=${evidence.shellId ?? "unavailable"} Run=${evidence.runId ?? "unavailable"}`)
  setInterval(() => {}, 1_000)
}
