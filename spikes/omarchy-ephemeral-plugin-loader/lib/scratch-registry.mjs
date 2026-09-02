// SPIKE — fake-only cleanup support. Not production code.
//
// scratch-registry.mjs — exact-identity scratch cleanup used by the spike's
// failure-cleanup seam and by the candidate-patch verifier for its own scratch
// state. Cleanup is authorized only by exact registered paths whose captured
// filesystem identity (device + inode equivalent) is unchanged and whose path
// has no symlink component at cleanup time. Refused registrations stay
// pending and are retried on the next cleanup; unrelated resources are never
// touched.
//
// Frozen surface:
//   createScratchRegistry({ fs, now }) -> registry
//     registerDirectory(path) -> { ok: true } | { ok: false, reason }
//     failNow()               -> marks the run failed (cleanup still required)
//     cleanup()               -> { removed: string[], refused: Array, clean: boolean }
//     registrations()         -> number of unresolved registrations

export function createScratchRegistry({ fs, now = () => 0 }) {
  /** @type {Array<{path, identity, refused, reason, done}>} */
  const registrations = []
  let forced = false

  function identityOf(path) {
    const stat = fs.lstat(path)
    if (!stat) return null
    return `${stat.dev}:${stat.ino}`
  }

  return {
    registerDirectory(path) {
      const target = String(path)
      if (!registrations.every((entry) => entry.path !== target)) {
        return { ok: false, reason: 'already_registered' }
      }
      const stat = fs.lstat(target)
      if (!stat) return { ok: false, reason: 'missing' }
      if (stat.symlink || fs.isSymlinkComponent(target)) {
        // No identity was captured, so cleanup may observe disappearance but
        // can never authorize deleting a later replacement at this path.
        registrations.push({ path: target, identity: null, refused: true, reason: 'symlink_component', done: false })
        return { ok: false, reason: 'symlink_component' }
      }
      if (stat.kind !== 'directory') return { ok: false, reason: 'not_directory' }
      registrations.push({
        path: target,
        identity: identityOf(target),
        refused: false,
        reason: null,
        done: false,
      })
      return { ok: true }
    },

    failNow() {
      forced = true
    },

    forced() {
      return forced
    },

    cleanup() {
      const removed = []
      const refused = []
      for (const registration of registrations) {
        if (registration.done) continue
        if (registration.refused) {
          // Registration never captured cleanup authority. Only disappearance
          // can complete it; a replacement at the same path is unrelated.
          const stat = fs.lstat(registration.path)
          if (!stat) {
            registration.done = true
            continue
          }
          refused.push({ path: registration.path, reason: registration.reason })
          continue
        }
        const stat = fs.lstat(registration.path)
        if (!stat) {
          // Already gone: exact removal achieved earlier (e.g. interruption retry).
          removed.push(registration.path)
          registration.done = true
          continue
        }
        if (stat.symlink || fs.isSymlinkComponent(registration.path)) {
          refused.push({ path: registration.path, reason: 'symlink_component' })
          continue
        }
        if (stat.kind !== 'directory') {
          refused.push({ path: registration.path, reason: 'not_directory' })
          continue
        }
        if (`${stat.dev}:${stat.ino}` !== registration.identity) {
          refused.push({ path: registration.path, reason: 'identity_changed' })
          continue
        }
        if (fs.remove(registration.path)) {
          removed.push(registration.path)
          registration.done = true
        } else {
          refused.push({ path: registration.path, reason: 'removal_failed' })
        }
      }
      // Drop completed registrations.
      for (let index = registrations.length - 1; index >= 0; index -= 1) {
        if (registrations[index].done) registrations.splice(index, 1)
      }
      return { removed, refused, clean: refused.length === 0 && registrations.every((entry) => entry.done) }
    },

    registrations() {
      return registrations.filter((entry) => !entry.done).length
    },

    now,
  }
}