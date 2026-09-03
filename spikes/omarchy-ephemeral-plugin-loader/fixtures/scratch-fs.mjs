// SPIKE — fake-only fixture. Not production code.
//
// scratch-fs.mjs — the injected scratch-resource port for the failure-cleanup
// seam, plus a bounded real-filesystem helper used once to prove that the
// cleanup registry actually deletes directories it owns.
//
// Frozen port surface for task 3.a (lib/index.mjs must re-export
// `createScratchRegistry`):
//
//   createScratchRegistry({ fs, now }) -> registry
//     registerDirectory(path) -> { ok: true, ref } | { ok: false, reason }
//        - captures exact filesystem identity (device + inode equivalent)
//        - refuses paths with a symlink component (refusal stays pending)
//     failNow()               -> marks the run failed; cleanup still works
//     cleanup()               -> { removed, refused, clean }
//        - removes exactly registered identities only
//        - unrelated resources are never touched
//        - clean stays false while any registration remains
//     registrations()         -> number of unresolved registrations
//
// The real-fs port wraps node:fs for the one bounded real-removal case.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** Injected filesystem port for createScratchRegistry tests (fake nodes). */
export function createScratchFsPort() {
  const nodes = new Map()
  let device = 1
  let inode = 1
  return {
    nodes,
    removed: [],
    lstat(p) { return nodes.get(p) ?? null },
    identity(p) {
      const node = nodes.get(p)
      return node ? `${node.dev}:${node.ino}` : null
    },
    isSymlinkComponent(p) {
      const parts = String(p).split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += `/${part}`
        const node = nodes.get(current)
        if (node && node.symlink) return true
      }
      return false
    },
    remove(p) {
      if (!nodes.has(p)) return false
      nodes.delete(p)
      this.removed.push(p)
      return true
    },
    addNode(p, { symlink = false, kind = 'directory' } = {}) {
      inode += 1
      nodes.set(p, { dev: device, ino: inode, kind, symlink: symlink === undefined ? false : symlink })
    },
    addSymlink(p, target) {
      inode += 1
      nodes.set(p, { dev: device, ino: inode, kind: 'symlink', symlink: true, target })
    },
  }
}

/** Real filesystem port for the single bounded real-removal proof. */
export function createRealScratchFs() {
  return {
    removed: [],
    lstat(p) {
      try {
        const st = fs.lstatSync(p)
        return {
          dev: st.dev,
          ino: st.ino,
          symlink: st.isSymbolicLink(),
          kind: st.isDirectory() ? 'directory' : 'other',
        }
      } catch {
        return null
      }
    },
    isSymlinkComponent(p) {
      const parts = String(p).split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += `/${part}`
        try {
          if (fs.lstatSync(current).isSymbolicLink()) return true
        } catch {
          return false
        }
      }
      return false
    },
    remove(p) {
      try {
        fs.rmSync(p, { recursive: true, force: false })
        this.removed.push(p)
        return true
      } catch {
        return false
      }
    },
  }
}

/** Create one owner-only temp directory; returns { path, dispose }. */
export function withRealTempDir(prefix, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix), { mode: 0o700 })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    fs.rmSync(root, { recursive: true, force: true })
  }
  try {
    return { result: fn(root), dispose }
  } catch (error) {
    dispose()
    throw error
  }
}

/** Stable per-test scratch prefix so residue checks can find leftovers. */
export function scratchPrefix(testName) {
  const safe = String(testName).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)
  return `omarchestra-spike-ephemeral-${safe}-`
}

export function randomScratchSuffix() {
  return crypto.randomBytes(6).toString('hex')
}