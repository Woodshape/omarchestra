#!/usr/bin/env node
// SPIKE — unattended fake-only check runner. Not production code.
//
// Default scope: the fake-model and cleanup seams owned by task 3.a
// (link check + seams 1, 2, 3, 4, 5, 7). Seam 6 (candidate patch verifier)
// and seam 8 (recipe audit) belong to later tasks and are included only
// with --all, which is how the justfile recipe runs the complete graph.
//
// This runner spawns only `node --test` on local test files. It never
// contacts a shell, GUI, user configuration, provider, remote transport,
// process supervisor, or service manager, and never launches a UI.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const spikeRoot = path.resolve(here, '..')
const includeAll = process.argv.includes('--all')

const modelFiles = [
  'test/link-check.test.mjs',
  'test/s1-capability.test.mjs',
  'test/s2-registration.test.mjs',
  'test/s3-lifecycle.test.mjs',
  'test/s4-identity-restart.test.mjs',
  'test/s5-persistence-isolation.test.mjs',
  'test/s7-failure-cleanup.test.mjs',
]
const laterLaneFiles = [
  'test/s6-patch-verification.test.mjs',
  'test/s8-source-audit.test.mjs',
]
const selected = includeAll ? [...modelFiles, ...laterLaneFiles] : modelFiles

const result = spawnSync(process.execPath, ['--test', ...selected], {
  cwd: spikeRoot,
  encoding: 'utf8',
  timeout: 55000,
})
const output = `${result.stdout || ''}\n${result.stderr || ''}`

const header = [
  '# Fake-only model and cleanup green evidence (task 3.a lane)',
  `# command: node --test ${selected.join(' ')}`,
  `# scope: ${includeAll ? 'all seams (incl. patch lane and recipe audit)' : 'model + cleanup seams; seam 6 (patch) and seam 8 (recipe audit) are owned by tasks 3.b/4.b'}`,
  `# exit: ${result.status ?? 'signal'}`,
  '',
].join('\n')

const evidenceDir = path.join(spikeRoot, 'evidence', 'green')
fs.mkdirSync(evidenceDir, { recursive: true })
fs.writeFileSync(path.join(evidenceDir, 'model-and-cleanup.txt'), `${header}${output}\n`)

process.stdout.write(output)
process.exit(result.status ?? 1)