import { realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

/** Local directory identity, not a content fingerprint or filesystem lock. */
export interface ProjectDirectoryIdentity {
  path: string
  device: string
  inode: string
  owner: string
  birthTimeNs: string
}

export function canonicalDirectory(path: string): ProjectDirectoryIdentity | null {
  try {
    const canonical = new TextDecoder('utf-8', { fatal: true }).decode(realpathSync(path, { encoding: 'buffer' }))
    const stat = statSync(canonical, { bigint: true })
    if (!stat.isDirectory()) return null
    return {
      path: canonical,
      device: String(stat.dev), inode: String(stat.ino), owner: String(stat.uid),
      birthTimeNs: String(stat.birthtimeNs),
    }
  } catch { return null }
}

export function pathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const prefix = parent.endsWith('/') ? parent : `${parent}/`
    return child === parent || child.startsWith(prefix)
  }
  return contains(left, right) || contains(right, left)
}

export function sameDirectory(left: ProjectDirectoryIdentity | null, right: ProjectDirectoryIdentity | null): boolean {
  return left !== null && right !== null
    && left.path === right.path && left.device === right.device
    && left.inode === right.inode && left.owner === right.owner
    && left.birthTimeNs === right.birthTimeNs
}

/** Stored in projects.context_digest. HEAD and dirty state are separate facts:
 * normal commits and edits do not change which repository was registered.
 */
export function repositoryIdentityDigest(root: ProjectDirectoryIdentity, common: ProjectDirectoryIdentity, git: ProjectDirectoryIdentity): string {
  const bytes = JSON.stringify([root, common, git])
  return `repo-v1:${createHash('sha256').update(bytes).digest('hex')}`
}
