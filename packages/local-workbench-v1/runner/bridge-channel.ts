import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { BridgeDecoder, encodeBridgeFrame, type BridgeFrame, type BridgeType } from './bridge-protocol.ts'
import { BridgeRegistry, type BridgePeer } from './bridge-registry.ts'

/** Socket/paired-stream transport. No text decoding before bounded byte framing. */
export function attachBridgeStream(stream: Pick<Socket, 'on' | 'write' | 'destroy'>, handlers: { onFrame: (peer: BridgePeer, frame: BridgeFrame) => void; onClose?: (peer: BridgePeer) => void }): BridgePeer & { sendFrame(type: BridgeType, id: string, body: Record<string, unknown>): void } {
  const decoder = new BridgeDecoder()
  let closed = false
  const peer = {
    send(bytes: Buffer) { if (closed) throw new Error('bridge_closed'); stream.write(bytes) },
    sendFrame(type: BridgeType, id: string, body: Record<string, unknown>) { peer.send(encodeBridgeFrame(type, id, body)) },
    close() { if (!closed) { closed = true; stream.destroy(); handlers.onClose?.(peer) } },
  }
  stream.on('data', (chunk: Buffer) => {
    try { for (const frame of decoder.push(chunk)) { if (closed) break; handlers.onFrame(peer, frame) } }
    catch { peer.close() } // No raw Pi data or submitted bytes in diagnostics.
  })
  stream.on('error', () => peer.close())
  stream.on('close', () => peer.close())
  return peer
}

/** The owner has already acquired its lifetime lock; runtime directory must be private. */
export async function listenForPiBridge(path: string, registry: BridgeRegistry): Promise<{ server: Server; close(): Promise<void> }> {
  const parent = lstatSync(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error('bridge_runtime_not_private')
  // Never unlink a stale or foreign socket: a second owner must fail closed.
  const sockets = new Set<Socket>()
  let closed = false
  const server = createServer(socket => {
    if (closed) { socket.destroy(); return }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    attachBridgeStream(socket, { onFrame: (peer, frame) => registry.receive(peer, frame), onClose: peer => registry.disconnect(peer) })
  })
  server.maxConnections = 80
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve() }) })
    chmodSync(path, 0o600)
    const { dev, ino } = lstatSync(path)
    const sweep = setInterval(() => registry.expire(), 1000)
    sweep.unref()
    let closing: Promise<void> | null = null
    return { server, close() {
      closing ??= (async () => {
        clearInterval(sweep)
        closed = true
        registry.close()
        for (const socket of sockets) socket.destroy()
        // Node's net.Server.close() unlinks Unix paths by NAME, without an
        // inode check. On drift, do not call it: detach the listener until
        // owner-process exit rather than deleting a replacement resource.
        let current: ReturnType<typeof lstatSync> | null = null
        try { current = lstatSync(path) } catch { /* path removed */ }
        if (!current || current.dev !== dev || current.ino !== ino) {
          server.unref()
          throw new Error('bridge_socket_identity_changed')
        }
        // The runtime directory is private to this UID. The inode check above
        // detects drift; concurrent same-UID attacks are outside this boundary.
        await new Promise<void>(resolve => server.close(() => resolve()))
      })()
      return closing
    } }
  } catch (error) { server.close(); throw error }
}
