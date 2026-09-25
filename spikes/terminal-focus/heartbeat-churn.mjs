/** Characterize row lifetime across identical heartbeats and real data changes.
 * No installed desktop/Pi/configuration access; no production source edits.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function characterizeHeartbeat() {
const packageUrl = new URL('../../packages/local-workbench-v1/', import.meta.url)
const scratch = mkdtempSync(join(tmpdir(), 'wb-heartbeat-churn-'))
try {
  let source = readFileSync(new URL('test/rendered-layout.test.ts', packageUrl), 'utf8')
    .replace(/from '\.\.\/([^']+)'/g, (_, path) => `from '${new URL(path, packageUrl).href}'`)
    .replaceAll('../console/plugin/', new URL('console/plugin/', packageUrl).href)
  const anchor = '    function test_layout_data()'
  if (!source.includes(anchor)) throw Error('render harness changed')
  source = source.replace(anchor, `    function test_heartbeatDelegateLifetimeCharacterization() {
      var results = []
      for (var kind of ["identical-object", "identical-wire", "cursor-only", "observed-change", "managed-change"]) {
        openJourney()
        var before = visualNamed(surfaceRoot(), "workbench-observed-show-pane")
        verify(before !== null)
        var menu = visualNamed(surfaceRoot(), "workbench-agent-actions")
        verify(menu !== null)
        menu.parent.parent.actionsExpanded = true
        wait(20)
        verify(menu.parent.parent.actionsExpanded)
        var heartbeat = JSON.parse(JSON.stringify(host.snapshot))
        if (kind === "cursor-only") heartbeat.cursor += 1
        if (kind === "observed-change") heartbeat.observedSessions[0].activity = "busy"
        if (kind === "managed-change") heartbeat.managedAgents[0].lastEvent = "changed"
        verify(consoleView.applyProjection(kind === "identical-object" ? heartbeat : JSON.stringify(heartbeat))); wait(30)
        var after = visualNamed(surfaceRoot(), "workbench-observed-show-pane")
        var afterMenu = visualNamed(surfaceRoot(), "workbench-agent-actions")
        verify(after !== null); verify(afterMenu !== null)
        results.push({ kind: kind, agentButtonRecreated: before !== after,
            inlineAgentMenuCollapsed: !afterMenu.parent.parent.actionsExpanded })
      }
      console.log("HEARTBEAT_CHURN " + JSON.stringify(results))
    }

${anchor}`)
  source = source.replace('    assert.equal(result.error, undefined, log)',
    '    t.diagnostic(log.match(/^.*HEARTBEAT_CHURN.*$/m)?.[0] ?? "churn evidence missing")\n    assert.equal(result.error, undefined, log)')
  const file = join(scratch, 'heartbeat.test.ts')
  writeFileSync(file, source)
  const run = spawnSync(process.execPath, ['--test', file], { timeout: 40000, killSignal: 'SIGKILL', detached: true,
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  // Qt inherits this isolated test process group; reap exact descendants even
  // if the outer Node timeout fires before its own Qt cleanup can execute.
  if (run.pid) { try { process.kill(-run.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  process.stdout.write(run.stdout ?? '')
  process.stderr.write(run.stderr ?? '')
  if (run.error) throw run.error
  return run.status ?? 1
} finally { rmSync(scratch, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = characterizeHeartbeat()
}
