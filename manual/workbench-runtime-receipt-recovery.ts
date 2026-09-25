// One-time explicit recovery of the historical receipt that pinned /run inodes.
// No service, Pi or Omarchy process is started by this command.
import { join } from 'node:path'
import readline from 'node:readline/promises'
import { applyRuntimeMigration, inspectRuntimeMigration } from '../packages/local-workbench-v1/runner/runtime-migration.ts'

const stateDir = join(process.env.HOME ?? '', '.local/state/omarchestra/workbench-phase2-live')
const runtimeDir = join(process.env.XDG_RUNTIME_DIR ?? '', 'omarchestra-workbench-phase2-live')
const evidenceDir = join(process.env.HOME ?? '', '.local/state/omarchestra/manual-gates')
async function main() {
  if (!process.env.HOME || !process.env.XDG_RUNTIME_DIR) throw Error('explicit user home and XDG runtime root are required')
  const action = process.argv[2]
  if (!['--plan', '--apply'].includes(action) || process.argv.length !== 3) throw Error('use --plan (read-only) or --apply (interactive owner-only migration)')
  const roots = { stateDir, runtimeDir }
  const plan = inspectRuntimeMigration(roots)
  console.log(`Exact runtime ownership migration plan (${action === '--plan' ? 'read-only' : 'no mutation yet'}):`)
  console.log(JSON.stringify(plan, null, 2))
  if (action === '--plan') return
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('migration requires an interactive operator TTY')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Convert only the checked v1 receipt ${plan.receiptHash.slice(0, 12)}? [y/N] `)
    if (!/^(?:y|yes)$/i.test(answer.trim())) throw Error('migration declined; no resource changed')
  } finally { prompt.close() }
  const result = applyRuntimeMigration(roots, plan, evidenceDir)
  console.log(JSON.stringify({ kind: 'migrated', backup: result.backup, receiptHash: result.receiptHash }))
  console.log('No service was started. Verify the receipt and then reset the failed service before starting it.')
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
