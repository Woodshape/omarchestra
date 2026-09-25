import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { diagnoseCandidate, focusSchemaFacts, paneFacts, processInfo, windowFacts } from './probe.mjs'

const chain = [
  { pid: 100, ppid: 90, startTicks: '1000', tty: 34818, name: 'pi' },
  { pid: 90, ppid: 80, startTicks: '900', tty: 34818, name: 'bash' },
  { pid: 80, ppid: 70, startTicks: '800', tty: 0, name: 'herdr' },
  { pid: 70, ppid: 1, startTicks: '700', tty: 0, name: 'foot' },
]
const panes = [{ paneId: 'w1:p1', terminalId: 'term_one', pids: [100] }]
const windows = [{ address: '0x1234', pid: 70, mapped: true, hidden: false }]

test('read-only diagnostic distinguishes panes sharing one desktop window; no candidate grants focus', () => {
  const first = diagnoseCandidate(chain, structuredClone(chain), panes, windows)
  const secondChain = structuredClone(chain); secondChain[0].pid = 101
  const second = diagnoseCandidate(secondChain, secondChain, [{ paneId: 'w1:p2', terminalId: 'term_two', pids: [101] }], windows)
  assert.equal(first.kind, 'diagnostic_candidate')
  assert.equal(second.kind, 'diagnostic_candidate')
  assert.notEqual(first.paneId, second.paneId)
  assert.equal(first.windowAddress, second.windowAddress)
  assert.equal(first.focusAllowed, false)
})

for (const change of ['pid', 'ppid', 'startTicks', 'tty', 'name']) test(`rejects stale ${change} rather than substituting a terminal`, () => {
  const changed = structuredClone(chain)
  changed[0][change] = change === 'startTicks' ? '2000' : change === 'name' ? 'replacement' : 222
  assert.equal(diagnoseCandidate(chain, changed, panes, windows).reason, 'process_chain_changed')
})

test('missing, hidden, multiple-window and ambiguous-pane mappings remain unavailable', () => {
  assert.equal(diagnoseCandidate(chain, chain, panes, []).reason, 'no_window_candidate')
  assert.equal(diagnoseCandidate(chain, chain, panes, [{ ...windows[0], hidden: true }]).reason, 'no_window_candidate')
  assert.equal(diagnoseCandidate(chain, chain, panes, [...windows, { ...windows[0], address: '0x5678' }]).reason, 'ambiguous_window')
  assert.equal(diagnoseCandidate(chain, chain, [...panes, { ...panes[0], paneId: 'w1:p2' }], windows).reason, 'ambiguous_pane')
  assert.equal(diagnoseCandidate(chain, chain, [], windows).reason, 'unresolved_multiplexer_pane')
})

test('allowlists never read title, cwd, argv, agent messages or terminal content', () => {
  const forbidden = { get title() { throw Error('private') }, get cwd() { throw Error('private') },
    get argv() { throw Error('private') }, get cmdline() { throw Error('private') }, get agent_session() { throw Error('private') } }
  const raw = Object.assign(Object.create(forbidden), { pane_id: 'w1:p1', terminal_id: 'term_one' })
  const p = paneFacts({ result: { panes: [raw] } })[0]
  assert.deepEqual(p, { paneId: 'w1:p1', terminalId: 'term_one' })
  const proc = Object.assign(Object.create(forbidden), { pid: 100 })
  assert.deepEqual(processInfo({ result: { process_info: { pane_id: 'w1:p1', foreground_processes: [proc] } } }, p), panes[0])
  const w = Object.assign(Object.create(forbidden), windows[0])
  assert.deepEqual(windowFacts([w]), windows)
  assert.throws(() => processInfo({ result: { process_info: { pane_id: 'w1:p2', foreground_processes: [proc] } } }, p))
})

test('captured public focus schema has only location targets, not expected occupants or clients', () => {
  const schema = JSON.parse(readFileSync(new URL('./evidence/public-focus-schema.json', import.meta.url), 'utf8'))
  const facts = focusSchemaFacts(schema)
  assert.equal(facts.protocol, 22)
  assert.deepEqual(facts.methods, { 'pane.focus': ['pane_id'], 'agent.focus': ['target'] })
  assert.ok(!facts.snapshotFields.includes('clients'))
})

test('a check-then-focus model cannot prevent an occupant replacement in the unguarded interval', () => {
  // Contract counterexample, NOT a live Herdr mutation/reproduction.
  let occupant = 'old-pi'
  const checked = occupant
  assert.equal(checked, 'old-pi')
  const request = { method: 'pane.focus', params: { pane_id: 'w1:p1' } }
  occupant = 'replacement-pi'
  const focused = { pane: request.params.pane_id, occupant }
  assert.notEqual(focused.occupant, checked)
  assert.deepEqual(Object.keys(request.params), ['pane_id'])
})

test('imported probe has no runtime side effects; only explicit read commands are reachable from inspect', () => {
  const source = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8')
  assert.match(source, /process\.argv\[1\] === fileURLToPath/)
  assert.match(source, /timeout: 3000, killSignal: 'SIGKILL'/)
  assert.doesNotMatch(source, /\['dispatch'|\['agent', 'focus'|\['pane', 'focus'|send-text|send-keys|writeFile|createConnection|\.sock/)
  assert.doesNotMatch(source, /['"](?:read|snapshot)['"]\]/, 'no terminal output or full session snapshot commands')
})
