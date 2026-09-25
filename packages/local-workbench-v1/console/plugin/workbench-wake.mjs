/** Bounded notification of an already-running local Owner. No action payload,
 * spawning, retries, installation, or authority. Importing performs no I/O. */
import { createConnection } from 'node:net'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export async function wakeOwner(input) {
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  if (!input || Object.keys(input).sort().join(',') !== 'pluginGeneration,sessionId,socketPath'
      || !id(input.sessionId) || !Number.isSafeInteger(input.pluginGeneration) || input.pluginGeneration <= 0
      || typeof input.socketPath !== 'string' || input.socketPath.length > 1024 || !isAbsolute(input.socketPath)) throw Error('invalid_wake')
  const parent = lstatSync(dirname(input.socketPath)), file = lstatSync(input.socketPath)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()
      || (parent.mode & 0o077) !== 0 || !file.isSocket() || file.uid !== process.getuid()
      || (file.mode & 0o077) !== 0) throw Error('owner_endpoint_not_private')
  const requestId = `wake-${randomUUID()}`
  await new Promise((resolve, reject) => {
    const socket = createConnection(input.socketPath)
    let done = false, buffer = Buffer.alloc(0)
    const finish = error => {
      if (done) return
      done = true; clearTimeout(timer); socket.destroy()
      if (error) reject(error); else resolve()
    }
    const timer = setTimeout(() => finish(Error('wake_timed_out')), 1500)
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 'omarchestra.owner/v1',
      requestId, type: 'wake', sessionId: input.sessionId, pluginGeneration: input.pluginGeneration }) + '\n'))
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 4096) return finish(Error('invalid_wake_reply'))
      const end = buffer.indexOf(10)
      if (end < 0) return
      try {
        if (end !== buffer.length - 1) throw Error('invalid_wake_reply')
        const reply = JSON.parse(buffer.toString('utf8', 0, end))
        if (Object.keys(reply).sort().join(',') !== 'kind,requestId,result'
            || reply.kind !== 'result' || reply.requestId !== requestId || reply.result?.status !== 'woken') throw Error('wake_unavailable')
        finish()
      } catch (error) { finish(error) }
    })
    socket.on('error', finish)
    socket.on('close', () => { if (!done) finish(Error('wake_disconnected')) })
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 4096) throw Error('invalid_wake')
    await wakeOwner(JSON.parse(process.argv[2]))
  } catch { process.exitCode = 1 } // The normal liveness tick remains a recovery path.
}
