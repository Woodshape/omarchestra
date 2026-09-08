/** PROTOTYPE — NOT PRODUCTION. Executes isolated shell functions, never the launcher live path. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const launcher = new URL('../run-live-adoption-bridge.sh', import.meta.url)
const source = fs.readFileSync(launcher, 'utf8')
function fn(name) {
  const start = source.indexOf(`${name}() {`)
  assert.notEqual(start, -1)
  return source.slice(start, source.indexOf('\n}', start) + 2)
}
function shell(script) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH } })
}
for (const [gateway, cleanup, confirmed, expected] of [
  [0, 1, 0, 'ABORTED'], [0, 0, 0, 'FAIL'], [1, 1, 0, 'INCOMPLETE'],
  [1, 0, 1, 'FAIL'], [1, 1, 1, 'PASS'],
]) test(`verdict gateway=${gateway} cleanup=${cleanup} confirmation=${confirmed}`, () => {
  const result = shell(`${fn('adoption_verdict')}\nadoption_verdict ${gateway} ${cleanup} ${confirmed}`)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), expected)
})

test('non-TTY live invocation refuses before creating any state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'adoption-non-tty-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const result = spawnSync('bash',[launcher.pathname,'--live'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:dir,XDG_RUNTIME_DIR:dir,XDG_STATE_HOME:dir}})
  assert.notEqual(result.status,0)
  assert.match(result.stderr,/requires a TTY/)
  assert.deepEqual(fs.readdirSync(dir),[])
})

test('database cleanup rejects unrelated paths even with an exact inode', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-cleanup-'))
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }))
  const foreign = path.join(dir, 'foreign')
  fs.writeFileSync(foreign, 'keep')
  const stat = fs.statSync(foreign, { bigint:true })
  const result = shell(`${fn('reject_symlink_components')}\n${fn('remove_exact_database_file')}\n${fn('remove_exact_database')}\nDATABASE_PATH=${JSON.stringify(path.join(dir,'adoption.sqlite'))}\nDATABASE_IDENTITY=${JSON.stringify(`${foreign} ${stat.dev}:${stat.ino}`)}\nremove_exact_database`)
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(foreign,'utf8'), 'keep')
})

test('database cleanup rejects a replacement inode and symlink', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-cleanup-'))
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }))
  const file = path.join(dir, 'adoption.sqlite')
  fs.writeFileSync(file,'owned')
  const stat = fs.statSync(file,{bigint:true})
  fs.renameSync(file,file+'.original')
  fs.writeFileSync(file,'foreign')
  const script = `${fn('reject_symlink_components')}\n${fn('remove_exact_database_file')}\nremove_exact_database_file ${JSON.stringify(file)} ${stat.dev}:${stat.ino}`
  assert.notEqual(shell(script).status,0)
  assert.equal(fs.readFileSync(file,'utf8'),'foreign')
  fs.unlinkSync(file)
  fs.symlinkSync(file+'.original',file)
  assert.notEqual(shell(script).status,0)
  assert.equal(fs.readFileSync(file+'.original','utf8'),'owned')
})
