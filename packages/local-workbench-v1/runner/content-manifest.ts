/** C9: bounded, content-only checkout fingerprinting; never copies file bodies. */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalJson, sha256 } from './canonical-hash.ts'
import { defaultGitRunner, GIT_MAX_OUTPUT_BYTES, inspectProjectPath, type GitRunner } from './git-context.ts'
import { workbenchError } from './errors.ts'
import type { ProjectRecord } from './store.ts'

export const MAX_MANIFEST_FILE_BYTES = 64 * 1024 * 1024
export const MAX_MANIFEST_FILES = 100_000
export const MAX_MANIFEST_WALK_ENTRIES = 200_000
export const MAX_MANIFEST_TOTAL_BYTES = 1024 * 1024 * 1024
export const MAX_MANIFEST_PATH_BYTES = 4096
/** Bounds retained path metadata while keeping the 100,000-file ceiling practical. */
export const MAX_MANIFEST_PATH_METADATA_BYTES = 64 * 1024 * 1024
export const MAX_STABLE_BASELINE_MS = 60_000
const READ_CHUNK_BYTES = 64 * 1024
const CANDIDATE_DOMAIN = 'omarchestra.candidate/v1'
const BASELINE_DOMAIN = 'omarchestra.execution-context/v1'

type Entry = [path: string, type: 'file' | 'symlink', mode: number, length: number, digest: string]
type FileSnapshot = { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
type WalkDirectory = { relative: string; snapshot: FileSnapshot }

export interface ProjectBaseline {
  projectId: string
  executionNodeId: string
  canonicalPath: string
  gitCommonDir: string
  repositoryIdentity: string
  headOid: string
  dirty: boolean
  headDigest: string
  headMode: number
  headLength: number
  indexDigest: string
  indexMode: number
  indexLength: number
  configDigest: string
  configFileDigest: string
  configMode: number
  configLength: number
  manifestDigest: string
  baselineDigest: string
  fileCount: number
  directoryCount: number
  hashedBytes: number
}

interface Budget {
  now: () => number
  deadline: number
  hashedBytes: number
  totalHashMeter: { bytes: number }
  walkEntries: number
  pathBytes: number
}

function unavailable(reason: string): never {
  throw workbenchError('invalid_input', `Project baseline unavailable: ${reason}`,
    'keep the checkout unchanged and resolve the reported repository or fingerprint limitation before reviewing start')
}

function checkBudget(budget: Budget): void {
  if (budget.now() >= budget.deadline) unavailable('the complete stable scan exceeded its 60-second deadline')
}

function snapshot(stat: { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): FileSnapshot {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

function lstat(path: string): FileSnapshot {
  try { return snapshot(lstatSync(path, { bigint: true })) }
  catch { return unavailable('a repository path became unreadable') }
}

function notePath(path: string, budget: Budget): void {
  if (!path || !path.isWellFormed() || Buffer.byteLength(path) > MAX_MANIFEST_PATH_BYTES) unavailable('a relative path is invalid or exceeds 4096 bytes')
  budget.pathBytes += Buffer.byteLength(path)
  if (budget.pathBytes > MAX_MANIFEST_PATH_METADATA_BYTES) unavailable('aggregate path metadata exceeds 64 MiB')
  budget.walkEntries++
  if (budget.walkEntries > MAX_MANIFEST_WALK_ENTRIES) unavailable('the repository exceeds the bounded walk-entry count')
}

function addHashedBytes(length: number, budget: Budget): void {
  if (!Number.isSafeInteger(length) || length < 0 || budget.totalHashMeter.bytes + length > MAX_MANIFEST_TOTAL_BYTES) {
    unavailable('the complete double scan exceeds 1 GiB of content hashing')
  }
  budget.hashedBytes += length
  budget.totalHashMeter.bytes += length
}

function checkedGitRunner(git: GitRunner, budget: Budget): GitRunner {
  return (argv, cwd) => {
    checkBudget(budget)
    const result = git(argv, cwd)
    checkBudget(budget)
    return result
  }
}

function effectiveLocalConfigDigest(git: GitRunner, cwd: string, budget: Budget): string {
  let result
  try { result = git(['config', '--local', '--includes', '--null', '--show-origin', '--list'], cwd) }
  catch { checkBudget(budget); return unavailable('effective local Git configuration could not be inspected') }
  checkBudget(budget)
  if (!result || result.status !== 0 || result.error !== undefined || (result.signal !== undefined && result.signal !== null)
      || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
      || !result.stdout.isWellFormed() || !result.stderr.isWellFormed()
      || Buffer.byteLength(result.stdout) > GIT_MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr) > GIT_MAX_OUTPUT_BYTES) {
    return unavailable('effective local Git configuration is incomplete or exceeds its bound')
  }
  addHashedBytes(Buffer.byteLength(result.stdout), budget)
  return sha256(`omarchestra.local-git-config/v1\0${result.stdout}`)
}

function readStableFile(path: string, budget: Budget): { digest: string; length: number; mode: number } {
  checkBudget(budget)
  const beforePath = lstat(path)
  if (!((beforePath.mode & BigInt(constants.S_IFMT)) === BigInt(constants.S_IFREG))) unavailable('a Git metadata file is not a regular file')
  if (beforePath.size < 0n || beforePath.size > BigInt(MAX_MANIFEST_FILE_BYTES)) unavailable('a Git metadata file exceeds 64 MiB')
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CLOEXEC) }
  catch { return unavailable('a Git metadata file is missing, inaccessible, or a symlink') }
  try {
    const before = snapshot(fstatSync(fd, { bigint: true }))
    if (!sameSnapshot(beforePath, before)) unavailable('a Git metadata file changed before hashing')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let length = 0
    for (;;) {
      checkBudget(budget)
      let count: number
      try { count = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_MANIFEST_FILE_BYTES + 1 - length), null) }
      catch { return unavailable('a Git metadata file could not be read') }
      if (count === 0) break
      length += count
      if (length > MAX_MANIFEST_FILE_BYTES) unavailable('a Git metadata file exceeds 64 MiB')
      addHashedBytes(count, budget)
      hash.update(buffer.subarray(0, count))
    }
    const afterFd = snapshot(fstatSync(fd, { bigint: true })), afterPath = lstat(path)
    if (!sameSnapshot(before, afterFd) || !sameSnapshot(afterFd, afterPath) || BigInt(length) !== afterFd.size) {
      unavailable('a Git metadata file changed while hashing')
    }
    return { digest: hash.digest('hex'), length, mode: Number(afterFd.mode & 0o7777n) }
  } finally { closeSync(fd) }
}

function hashRegularFile(path: string, relativePath: string, budget: Budget, beforePath: FileSnapshot): Entry {
  if (beforePath.size < 0n || beforePath.size > BigInt(MAX_MANIFEST_FILE_BYTES)) unavailable('a working-tree file exceeds 64 MiB')
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CLOEXEC) }
  catch { return unavailable('a working-tree file is missing, inaccessible, or a symlink') }
  try {
    const before = snapshot(fstatSync(fd, { bigint: true }))
    if (!sameSnapshot(beforePath, before)) unavailable('a working-tree file changed before hashing')
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let length = 0
    for (;;) {
      checkBudget(budget)
      let count: number
      try { count = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_MANIFEST_FILE_BYTES + 1 - length), null) }
      catch { return unavailable('a working-tree file could not be read') }
      if (count === 0) break
      length += count
      if (length > MAX_MANIFEST_FILE_BYTES) unavailable('a working-tree file exceeds 64 MiB')
      addHashedBytes(count, budget)
      hash.update(buffer.subarray(0, count))
    }
    const afterFd = snapshot(fstatSync(fd, { bigint: true })), afterPath = lstat(path)
    if (!sameSnapshot(before, afterFd) || !sameSnapshot(afterFd, afterPath) || BigInt(length) !== afterFd.size) {
      unavailable('a working-tree file changed while hashing')
    }
    return [relativePath, 'file', Number(afterFd.mode & 0o7777n), length, hash.digest('hex')]
  } finally { closeSync(fd) }
}

function decodeName(name: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(name)
    if (!decoded || decoded.includes('/') || decoded.includes('\0')) return unavailable('a repository entry name is invalid')
    return decoded
  } catch { return unavailable('a repository entry name is not valid UTF-8') }
}

function entriesDigest(entries: Entry[]): string {
  entries.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))
  const hash = createHash('sha256')
  hash.update(CANDIDATE_DOMAIN)
  hash.update('[')
  for (let i = 0; i < entries.length; i++) {
    if (i !== 0) hash.update(',')
    hash.update(canonicalJson(entries[i]))
  }
  hash.update(']')
  return hash.digest('hex')
}

function scanOnce(project: ProjectRecord, git: GitRunner, budget: Budget): ProjectBaseline {
  checkBudget(budget)
  const boundedGit = checkedGitRunner(git, budget)
  const initial = inspectProjectPath(project.canonicalPath, boundedGit)
  checkBudget(budget)
  if (!initial.supported || !initial.executionReady || initial.headOid === null || initial.dirty === null
      || initial.canonicalPath !== project.canonicalPath || initial.gitCommonDir !== project.gitCommonDir
      || initial.repositoryIdentity === null || initial.repositoryIdentity !== project.contextDigest
      || initial.gitDir !== initial.gitCommonDir) unavailable('registered Node/Project/Git identity or HEAD is unavailable or changed')
  const root = resolve(project.canonicalPath), common = resolve(project.gitCommonDir)
  const commonRelative = relative(root, common)
  if (!commonRelative || commonRelative === '..' || commonRelative.startsWith(`..${sep}`) || isAbsolute(commonRelative)) {
    unavailable('Git administrative storage is outside the registered Project or uses an unsupported worktree layout')
  }
  const commonStat = lstat(common)
  if ((commonStat.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFDIR)) unavailable('Git common storage is not a real directory')

  // Hash these three administrative facts separately; the rest of Git storage
  // is excluded from the checkout walk and never copied into the workbench.
  const head = readStableFile(join(common, 'HEAD'), budget)
  const index = readStableFile(join(common, 'index'), budget)
  const config = readStableFile(join(common, 'config'), budget)
  const effectiveConfigDigest = effectiveLocalConfigDigest(boundedGit, project.canonicalPath, budget)
  const entries: Entry[] = []
  const directories: WalkDirectory[] = []
  const stack: string[] = ['']
  let files = 0

  while (stack.length > 0) {
    checkBudget(budget)
    const currentRelative = stack.pop()!
    const currentAbsolute = currentRelative ? resolve(root, currentRelative) : root
    const beforeDirectory = lstat(currentAbsolute)
    if ((beforeDirectory.mode & BigInt(constants.S_IFMT)) !== BigInt(constants.S_IFDIR)) unavailable('a working-tree directory was replaced or is not a directory')
    const names = (() => {
      try { return readdirSync(currentAbsolute, { encoding: 'buffer' }) as Buffer[] }
      catch { return unavailable('a working-tree directory could not be enumerated') }
    })()
    names.sort(Buffer.compare)
    directories.push({ relative: currentRelative, snapshot: beforeDirectory })
    notePath(currentRelative || '.', budget)

    // Push children in reverse so the traversal itself is deterministic. A
    // final bytewise path sort defines the canonical manifest order.
    const children: string[] = []
    for (const rawName of names) {
      checkBudget(budget)
      const name = decodeName(rawName)
      const rel = currentRelative ? `${currentRelative}/${name}` : name
      const absolute = resolve(currentAbsolute, name)
      if (absolute === common) continue // exact canonical Git admin directory only
      if (name === '.git') unavailable('nested Git/worktree storage is unsupported in the candidate scope')
      notePath(rel, budget)
      const info = lstat(absolute)
      const kind = info.mode & BigInt(constants.S_IFMT)
      if (kind === BigInt(constants.S_IFDIR)) {
        children.push(rel)
      } else if (kind === BigInt(constants.S_IFLNK)) {
        if (++files > MAX_MANIFEST_FILES) unavailable('the checkout exceeds 100,000 files')
        const target = (() => {
          try { return readlinkSync(absolute, { encoding: 'buffer' }) as Buffer }
          catch { return unavailable('a symlink changed or became unreadable') }
        })()
        addHashedBytes(target.length, budget)
        const after = lstat(absolute)
        if (!sameSnapshot(info, after)) unavailable('a symlink changed while hashing')
        entries.push([rel, 'symlink', Number(after.mode & 0o7777n), target.length,
          createHash('sha256').update(target).digest('hex')])
      } else if (kind === BigInt(constants.S_IFREG)) {
        if (++files > MAX_MANIFEST_FILES) unavailable('the checkout exceeds 100,000 files')
        entries.push(hashRegularFile(absolute, rel, budget, info))
      } else {
        unavailable('special files are unsupported in the candidate scope')
      }
      if (budget.walkEntries > MAX_MANIFEST_WALK_ENTRIES) unavailable('the repository exceeds the bounded walk-entry count')
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }

  // Directory metadata detects observed additions/removals/replacements during
  // the walk. It is not a filesystem lock or adversarial-writer isolation.
  for (const directory of directories) {
    checkBudget(budget)
    const absolute = directory.relative ? resolve(root, directory.relative) : root
    if (!sameSnapshot(directory.snapshot, lstat(absolute))) unavailable('a working-tree directory changed during hashing')
  }
  const headAfter = readStableFile(join(common, 'HEAD'), budget)
  const indexAfter = readStableFile(join(common, 'index'), budget)
  const configAfter = readStableFile(join(common, 'config'), budget)
  const effectiveConfigAfter = effectiveLocalConfigDigest(boundedGit, project.canonicalPath, budget)
  if (head.digest !== headAfter.digest || head.mode !== headAfter.mode || head.length !== headAfter.length
      || index.digest !== indexAfter.digest || index.mode !== indexAfter.mode || index.length !== indexAfter.length
      || config.digest !== configAfter.digest || config.mode !== configAfter.mode || config.length !== configAfter.length
      || effectiveConfigDigest !== effectiveConfigAfter) {
    unavailable('HEAD, index, or repository config changed during hashing')
  }
  const final = inspectProjectPath(project.canonicalPath, boundedGit)
  checkBudget(budget)
  if (!final.supported || !final.executionReady || final.canonicalPath !== initial.canonicalPath
      || final.gitCommonDir !== initial.gitCommonDir || final.repositoryIdentity !== initial.repositoryIdentity
      || final.headOid !== initial.headOid || final.dirty !== initial.dirty) {
    unavailable('Git identity, HEAD, or status changed during hashing')
  }
  checkBudget(budget)
  const manifestDigest = entriesDigest(entries)
  const baselineFacts = {
    projectId: project.projectId,
    executionNodeId: project.executionNodeId,
    canonicalPath: project.canonicalPath,
    gitCommonDir: project.gitCommonDir,
    repositoryIdentity: initial.repositoryIdentity,
    headOid: initial.headOid,
    dirty: initial.dirty,
    headDigest: head.digest,
    headMode: head.mode,
    headLength: head.length,
    indexDigest: index.digest,
    indexMode: index.mode,
    indexLength: index.length,
    configDigest: effectiveConfigDigest,
    configFileDigest: config.digest,
    configMode: config.mode,
    configLength: config.length,
    manifestDigest,
  }
  const baselineDigest = sha256(`${BASELINE_DOMAIN}${canonicalJson(baselineFacts)}`)
  return {
    ...baselineFacts,
    baselineDigest,
    fileCount: files,
    directoryCount: directories.length,
    hashedBytes: budget.hashedBytes,
  }
}

/**
 * Capture a stable baseline with two complete scans. Git's root/common-dir,
 * HEAD and status, the index/config, and every in-scope file must agree. No
 * repository content or path list is retained by the returned record.
 */
export function captureStableProjectBaseline(
  project: ProjectRecord,
  options: { git?: GitRunner; now?: () => number } = {},
): ProjectBaseline {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + MAX_STABLE_BASELINE_MS
  const git = options.git ?? defaultGitRunner
  const totalHashMeter = { bytes: 0 }
  const first = scanOnce(project, git, { now, deadline, hashedBytes: 0, totalHashMeter, walkEntries: 0, pathBytes: 0 })
  const second = scanOnce(project, git, { now, deadline, hashedBytes: 0, totalHashMeter, walkEntries: 0, pathBytes: 0 })
  if (first.baselineDigest !== second.baselineDigest || first.manifestDigest !== second.manifestDigest
      || first.headOid !== second.headOid || first.dirty !== second.dirty) {
    unavailable('the two complete checkout scans did not agree')
  }
  return { ...second, hashedBytes: totalHashMeter.bytes }
}
