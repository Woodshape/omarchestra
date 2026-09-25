import test from 'node:test'
import assert from 'node:assert/strict'
import { probeCadence } from './probe.mjs'

test('real periodic Owner keeps QML fresh; an actual stall still expires and requires resnapshot', async t => {
  const result = await probeCadence({ stall: true })
  t.diagnostic(JSON.stringify(result))
  assert.equal(result.staleTransitions, 0, 'healthy periodic delivery must not flap connection state')
  assert.equal(result.resnapshots, 0, 'idle heartbeats must not trigger watchdog resnapshots')
  assert.ok(result.heartbeatGapsMs.length >= 9, 'exercise repeated real periodic heartbeats, not frozen-clock warm clicks')
  assert.ok(result.heartbeatGapsMs.every(gap => gap < 1800), 'cadence must leave margin before the unchanged 2000 ms deadline')
  assert.deepEqual(result.windows.map(value => value.opened), [true, false], 'one open and one final cleanup, not periodic remapping')
  assert.deepEqual(result.fault, { blockedMs: 2300, staleTransitions: 1, resnapshots: 1, recovered: true },
    'real source absence must still mark stale and require a full snapshot, not just a heartbeat')
})
