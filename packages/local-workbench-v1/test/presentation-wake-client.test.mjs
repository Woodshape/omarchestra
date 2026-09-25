import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wakeOwner } from '../console/plugin/workbench-wake.mjs'

async function fixture(t, reply) {
  const root = mkdtempSync(join(tmpdir(), 'w-')), path = join(root, 'w.sock'), peers = new Set(), requests = []
  const server = createServer(socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket))
    socket.on('error', () => socket.destroy())
    let data = ''
    socket.on('data', chunk => {
      data += chunk
      if (!data.endsWith('\n')) return
      const request = JSON.parse(data); requests.push(request)
      reply(socket, request)
    })
  })
  t.after(async () => {
    for (const peer of peers) peer.destroy()
    await new Promise(resolve => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  chmodSync(path, 0o600)
  return { input: { socketPath: path, sessionId: 'current-session', pluginGeneration: 7 }, root, requests }
}

test('wake is a bounded notification only and rejects extra authority fields before connecting', async t => {
  const f = await fixture(t, (peer, request) => peer.end(JSON.stringify({ kind: 'result', requestId: request.requestId, result: { status: 'woken' } }) + '\n'))
  await assert.rejects(wakeOwner({ ...f.input, payload: { kind: 'adopt' } }), /invalid_wake/)
  await assert.rejects(wakeOwner({ ...f.input, sessionId: '' }), /invalid_wake/)
  assert.equal(f.requests.length, 0)
  await wakeOwner(f.input)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(Object.keys(f.requests[0]).sort(), ['pluginGeneration', 'protocol', 'requestId', 'sessionId', 'type'])
  assert.equal(f.requests[0].type, 'wake')
  chmodSync(f.input.socketPath, 0o666)
  await assert.rejects(wakeOwner(f.input), /not_private/)
  chmodSync(f.input.socketPath, 0o600)
  chmodSync(f.root, 0o755)
  await assert.rejects(wakeOwner(f.input), /not_private/)
  chmodSync(f.root, 0o700)
  assert.equal(f.requests.length, 1)
})

for (const [name, reply] of [
  ['wrong request', (peer, request) => peer.end(JSON.stringify({ kind: 'result', requestId: request.requestId + 'x', result: { status: 'woken' } }) + '\n')],
  ['unavailable owner', (peer, request) => peer.end(JSON.stringify({ kind: 'result', requestId: request.requestId, result: { status: 'unavailable' } }) + '\n')],
  ['oversized reply', peer => peer.end('x'.repeat(4097))],
  ['trailing frame', (peer, request) => peer.end(JSON.stringify({ kind: 'result', requestId: request.requestId, result: { status: 'woken' } }) + '\n{}\n')],
  ['disconnect', peer => peer.destroy()],
  ['stalled peer', () => {}],
]) test(`wake fails closed without retry on ${name}`, { timeout: 4000 }, async t => {
  const f = await fixture(t, reply)
  await assert.rejects(wakeOwner(f.input), /wake/)
  assert.equal(f.requests.length, 1)
})
