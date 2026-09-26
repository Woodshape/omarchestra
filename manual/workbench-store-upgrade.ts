// Explicit offline upgrade only. Never imported by service startup or bar click.
// Inspect an empty, private evidence directory first; --apply requires the exact
// displayed plan digest. No receipt migration, service start or Pi action.
import { inspectStoreUpgrade, applyStoreUpgrade } from '../packages/local-workbench-v1/runner/store-migration.ts'

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!['--plan', '--apply'].includes(action) || args.length % 2 !== 0) throw Error('use --plan|--apply --state-dir PATH --runtime-dir PATH --evidence-dir PATH [--authorize DIGEST]')
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!['--state-dir', '--runtime-dir', '--evidence-dir', '--authorize'].includes(key) || values.has(key) || !value) throw Error('unknown, repeated or missing upgrade argument')
    values.set(key, value)
  }
  for (const key of ['--state-dir', '--runtime-dir', '--evidence-dir']) if (!values.has(key)) throw Error(`required: ${key}`)
  if (action === '--plan' && values.has('--authorize')) throw Error('--plan accepts no authorization')
  if (action === '--apply' && !/^[a-f0-9]{64}$/.test(values.get('--authorize') ?? '')) throw Error('--apply requires the exact inspected plan digest')
  const roots = { stateDir: values.get('--state-dir')!, runtimeDir: values.get('--runtime-dir')! }
  const plan = inspectStoreUpgrade(roots, values.get('--evidence-dir')!)
  if (action === '--plan') { console.log(JSON.stringify(plan)); return }
  if (plan.digest !== values.get('--authorize')) throw Error('stale upgrade authorization; inspect again without changing state')
  console.log(JSON.stringify({ kind: 'store_upgraded', ...applyStoreUpgrade(roots, plan), serviceStarted: false }))
}
try { main() } catch (error) {
  const value = error as { code?: string; message?: string; recovery?: string }
  console.error(JSON.stringify({ kind: 'error', code: value.code ?? 'invalid_input', message: value.message, recovery: value.recovery ?? null }))
  process.exitCode = 1
}
