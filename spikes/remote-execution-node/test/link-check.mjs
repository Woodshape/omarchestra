import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const documents = [
  path.resolve(here, "../README.md"),
  path.resolve(here, "../evidence/public-contract-audit.md"),
  path.resolve(here, "../evidence/manual-observations.md")
]
let checked = 0
let failures = 0

for (const document of documents) {
  const source = await readFile(document, "utf8")
  const links = [...source.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1])
  for (const link of links) {
    if (/^(?:[a-z]+:|#|data:)/i.test(link)) continue
    const target = path.resolve(path.dirname(document), link.split("#", 1)[0])
    checked += 1
    try {
      const metadata = await lstat(target)
      if (!metadata.isFile() && !metadata.isDirectory()) throw new Error("not a file or directory")
    } catch (error) {
      failures += 1
      process.stderr.write(`${path.relative(process.cwd(), document)} -> ${link}: ${error.message}\n`)
    }
  }
}

if (failures > 0) process.exitCode = 1
else process.stdout.write(`link-check: ${checked} relative links passed\n`)