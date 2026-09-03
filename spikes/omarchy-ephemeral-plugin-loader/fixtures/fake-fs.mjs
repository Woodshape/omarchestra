// SPIKE — fake-only fixture. Not production code and never a real filesystem.
//
// fake-fs.mjs — the injected filesystem port consumed by the temporary-panel
// host through the frozen `temporary-panel-v1` contract. Everything is an
// in-memory map, so tests stay deterministic and no real path is touched.
//
// Frozen port surface for task 3.a:
//   lstat(path)      -> { type: 'directory'|'file'|'symlink'|'missing', size, uid, mode }   (never follows symlinks)
//   readFile(path, maxBytes) -> { ok: true, content } | { ok: false, reason: 'too_large'|'io_error' }
//   realpath(path)   -> { ok: true, canonical } | { ok: false, reason: 'missing' }
//                        (lexical normalization only; symlink components are
//                         rejected from lstat data before loading, and the
//                         host must treat canonical != requested as invalid)
//   write(path, data) -> records into `writes`; the host must never call this.
//   writes           -> array of every write attempt (persistence-isolation seam)

export function createFakeFsPort(options = {}) {
  const uid = options.uid ?? 1000
  const nodes = new Map()
  const knownDirs = new Set(['/'])

  function ensureAncestors(path, ownerUid) {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (let i = 0; i < parts.length - 1; i += 1) {
      current += `/${parts[i]}`
      knownDirs.add(current)
      if (!nodes.has(current)) {
        nodes.set(current, { type: 'directory', uid: ownerUid, mode: 0o755, content: null, target: null })
      }
    }
  }

  function normalize(path) {
    const parts = []
    for (const part of String(path).split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') { parts.pop(); continue }
      parts.push(part)
    }
    return `/${parts.join('/')}`
  }

  function nodeSize(node) {
    return node.content === null ? 0 : Buffer.byteLength(node.content, 'utf8')
  }

  const fs = {
    writes: [],

    addDirectory(path, { ownerUid = uid, mode = 0o750 } = {}) {
      ensureAncestors(path, ownerUid)
      nodes.set(path, { type: 'directory', uid: ownerUid, mode, content: null, target: null })
      knownDirs.add(path)
    },

    addFile(path, content, { ownerUid = uid, mode = 0o640 } = {}) {
      ensureAncestors(path, ownerUid)
      nodes.set(path, { type: 'file', uid: ownerUid, mode, content: String(content), target: null })
    },

    addSymlink(path, target, { ownerUid = uid } = {}) {
      ensureAncestors(path, ownerUid)
      nodes.set(path, { type: 'symlink', uid: ownerUid, mode: 0o777, content: null, target: String(target) })
    },

    removeNode(path) {
      nodes.delete(path)
    },

    /** Replace one node's owner/mode in place (fixture control). */
    setAttributes(path, { ownerUid, mode } = {}) {
      const node = nodes.get(path)
      if (!node) throw new Error(`fixture: unknown node ${path}`)
      if (ownerUid !== undefined) node.uid = ownerUid
      if (mode !== undefined) node.mode = mode
    },

    lstat(path) {
      const node = nodes.get(path)
      if (!node) return { type: 'missing', size: 0, uid: -1, mode: 0 }
      return { type: node.type, size: nodeSize(node), uid: node.uid, mode: node.mode }
    },

    readFile(path, maxBytes) {
      const node = nodes.get(path)
      if (!node || node.type !== 'file') return { ok: false, reason: 'io_error' }
      const size = nodeSize(node)
      if (size > maxBytes) return { ok: false, reason: 'too_large' }
      return { ok: true, content: node.content }
    },

    realpath(path) {
      const canonical = normalize(path)
      if (knownDirs.has(canonical) || nodes.has(canonical)) return { ok: true, canonical }
      return { ok: false, reason: 'missing' }
    },

    write(path, data) {
      // Observability only: a correct host never calls this.
      fs.writes.push({ path: String(path), bytes: data === undefined ? 0 : String(data).length })
      nodes.set(path, { type: 'file', uid, mode: 0o600, content: String(data), target: null })
      knownDirs.add(normalize(path).replace(/\/[^/]+$/, '') || '/')
    },
  }

  return fs
}