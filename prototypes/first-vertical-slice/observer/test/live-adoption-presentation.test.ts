/** PROTOTYPE — NOT PRODUCTION. QML functions execute in an isolated JS context; no desktop. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ADOPTION_COMPANION_RELEASE, OBSERVER_COMPANION_RELEASE, COMPANION_RELEASE } from '../../companion/releases.ts'
import { ADOPTION_PANEL_QML } from '../../console/adoption-panel-source.ts'
import { LiveAdoptionPresentation } from '../live-adoption-presentation.ts'
import { LiveAdoptionRunner } from '../live-adoption-runner.ts'
import { createInMemoryAdoptionStore } from '../live-adoption-store.ts'

function qml() {
  const context = vm.createContext({ adoptionState:null, intents:[], pluginGeneration:7, fresh:false,
    freshness:{ restart() {}, stop() {} },
    agents:{ clearIntentState() {}, applyIntentResult() { return true } } })
  for (const match of ADOPTION_PANEL_QML.matchAll(/function (\w+)\([^)]*\) \{/g)) {
    let depth = 1, end = match.index! + match[0].length
    while (depth && end < ADOPTION_PANEL_QML.length) {
      if (ADOPTION_PANEL_QML[end] === '{') depth++
      if (ADOPTION_PANEL_QML[end] === '}') depth--
      end++
    }
    vm.runInContext(ADOPTION_PANEL_QML.slice(match.index, end), context)
  }
  return context
}

test('actual QML session functions apply combined empty/managed snapshots and reject stale cleanup', () => {
  const view = qml()
  const state = {revision:0,session:{sessionId:'one',pluginGeneration:7},observerProjection:{observerRevision:0,agents:[]},managedCards:[]}
  assert.equal(view.apply(state,true),true)
  view.submit({intentId:'request',kind:'request_adoption'})
  assert.equal(JSON.parse(view.take({session:state.session})).intent.intentId,'request')
  assert.equal(view.clear({session:{sessionId:'other',pluginGeneration:7}}),false)
  assert.equal(view.apply({...state,managedCards:[{agentRunId:'committed',piStatus:'Builder · managed'}]},false),true)
  assert.equal(view.adoptionState.managedCards.length,1)
  assert.equal(view.clear({session:state.session}),true)
  assert.equal(view.adoptionState,null)
})

test('presentation verifies loaded method surface, fingerprint and plugin generation', async () => {
  const view = qml()
  let generation = 7, fingerprint = 'original'
  const config = {executionNodeId:'local',teamGoalId:'goal',roles:['builder'] as const}
  const runner = new LiveAdoptionRunner({...config,roles:['builder'],store:createInMemoryAdoptionStore({...config,roles:['builder']})})
  const shell = {
    async fingerprint() { return fingerprint },
    async call(method: string, raw: string) {
      if (method === 'adoptionCapabilities') return JSON.stringify({version:'0.4.0',pluginGeneration:generation,
        methods:['adoptionOpen','adoptionApply','adoptionTakeIntent','adoptionIntentResult','adoptionClear']})
      const value = JSON.parse(raw)
      if (method === 'adoptionOpen') return String(view.apply(value,true))
      if (method === 'adoptionApply') return String(view.apply(value,false))
      if (method === 'adoptionTakeIntent') return view.take(value)
      if (method === 'adoptionClear') return String(view.clear(value))
      return String(view.result(value))
    },
  }
  const presentation = new LiveAdoptionPresentation({...config,roles:['builder'],runner,shell})
  await presentation.open(); await presentation.poll()
  fingerprint = 'changed'
  await assert.rejects(presentation.poll(), /changed/)
  fingerprint = 'original'; generation = 8
  await assert.rejects(presentation.poll(), /changed/)
  generation = 7
  await presentation.close()
  assert.equal(view.adoptionState,null)
})

test('0.4.0 is additive; packaged QML lints without launching a desktop', t => {
  assert.equal(COMPANION_RELEASE.version,'0.2.0')
  assert.equal(OBSERVER_COMPANION_RELEASE.version,'0.3.0')
  assert.equal(ADOPTION_COMPANION_RELEASE.assets['UnassignedAgents.qml'],OBSERVER_COMPANION_RELEASE.assets['UnassignedAgents.qml'])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'adoption-qml-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  for (const [name,content] of Object.entries(ADOPTION_COMPANION_RELEASE.assets)) fs.writeFileSync(path.join(dir,name),content)
  const result = spawnSync(process.env.QMLLINT_BIN || '/usr/lib/qt6/bin/qmllint', ['-I','/usr/share/omarchy/shell',
    ...Object.keys(ADOPTION_COMPANION_RELEASE.assets).filter(name => name.endsWith('.qml')).map(name => path.join(dir,name))], {encoding:'utf8',timeout:10000})
  assert.equal(result.status,0,result.stderr + result.stdout)
})
