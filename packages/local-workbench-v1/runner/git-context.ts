/**
 * Local Workbench v1 Phase 2 — bounded Git context inspection.
 *
 * The only module in the package allowed to spawn a subprocess. Every command
 * is a fixed argv array for the Git binary, executed with `shell: false`, a
 * bounded timeout and a bounded output buffer; no command string is composed
 * from worker or operator text: `rev-parse` and `status` are passed as literal
 * array elements only. Nothing here mutates a repository: only read-only
 * plumbing runs, and only in a Project the operator asked to inspect.
 *
 * Resolution facts are runner-computed. The presentation payload never carries
 * caller-resolved Git facts, and a path is only registrable as a canonical
 * top-level non-bare Git worktree.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import { workbenchError } from './errors.ts'

export const GIT_COMMAND_TIMEOUT_MS = 5_000
export const GIT_MAX_OUTPUT_BYTES = 1 << 20

export interface GitCommandResult {
  status: number
  stdout: string
  stderr: string
}

export type GitRunner = (argv: readonly string[], cwd: string) => GitCommandResult

/** Fixed-argv read-only runner. Never a shell, never interpolated text. */
export const defaultGitRunner: GitRunner = (argv, cwd) =>
  spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', ...argv], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_COMMAND_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    },
  }) as GitCommandResult

export interface GitInspection {
  requestedPath: string
  canonicalPath: string
  worktreeRoot: string | null
  gitCommonDir: string | null
  /** The working tree's own `.git` directory. Differs from the common dir in a
   *  linked worktree, which shares storage with another checkout. */
  gitDir: string | null
  headOid: string | null
  dirty: boolean
  bare: boolean
  isRepository: boolean
  nested: boolean
  /** False when registration must be refused, with exact reasons. */
  supported: boolean
  reasons: string[]
  /** True when the Project may later start work (a HEAD exists). */
  executionReady: boolean
  readinessReasons: string[]
}

function line(result: GitCommandResult): string | null {
  if (result.status !== 0) return null
  const text = result.stdout.trim()
  return text.length === 0 ? null : text
}

function canonicalize(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Inspect one absolute local path. Returns resolved facts plus the exact
 * reasons registration would be refused or the Project is not execution-ready.
 */
export function inspectProjectPath(requestedPath: unknown, runner: GitRunner = defaultGitRunner): GitInspection {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || !isAbsolute(requestedPath)) {
    throw workbenchError('invalid_input', 'project path must be an absolute path', 'enter the absolute path of a local Git worktree')
  }
  const requested = normalize(resolve(requestedPath))
  const canonical = canonicalize(requested)
  if (canonical === null || !existsSync(canonical) || !statSync(canonical).isDirectory()) {
    throw workbenchError('invalid_input', `${requested} is not an existing directory`, 'enter the absolute path of an existing local directory')
  }

  const isRepo = line(runner(['rev-parse', '--is-inside-work-tree'], canonical)) === 'true'
  const bare = line(runner(['rev-parse', '--is-bare-repository'], canonical)) === 'true'
  const worktreeRoot = isRepo ? line(runner(['rev-parse', '--show-toplevel'], canonical)) : null
  const gitCommonDirRaw = isRepo ? line(runner(['rev-parse', '--git-common-dir'], canonical)) : null
  const gitCommonDir = gitCommonDirRaw === null ? null : (isAbsolute(gitCommonDirRaw) ? gitCommonDirRaw : resolve(canonical, gitCommonDirRaw))
  const gitDirRaw = isRepo ? line(runner(['rev-parse', '--git-dir'], canonical)) : null
  const gitDir = gitDirRaw === null ? null : (isAbsolute(gitDirRaw) ? gitDirRaw : resolve(canonical, gitDirRaw))
  const headOid = isRepo && !bare ? line(runner(['rev-parse', '--verify', 'HEAD'], canonical)) : null
  const dirty = isRepo && !bare ? (runner(['status', '--porcelain'], canonical).stdout ?? '').trim().length > 0 : false

  const canonicalWorktree = worktreeRoot === null ? null : canonicalize(worktreeRoot)
  const nested = canonicalWorktree !== null && canonicalWorktree !== canonical
  const superproject = isRepo ? runner(['rev-parse', '--show-superproject-working-tree'], canonical) : null
  // A linked worktree keeps its own git dir but shares the common dir with the
  // primary checkout, so two Projects would own one Git history.
  const sharedGitDir = gitDir !== null && gitCommonDir !== null
    && (canonicalize(gitDir) ?? gitDir) !== (canonicalize(gitCommonDir) ?? gitCommonDir)

  const reasons: string[] = []
  if (!isRepo) reasons.push('not_a_git_worktree')
  if (bare) reasons.push('bare_repository')
  if (nested) reasons.push('nested_worktree_or_submodule')
  if (superproject !== null && superproject.status !== 0) reasons.push('unresolved_superproject')
  if (superproject !== null && line(superproject) !== null) reasons.push('submodule_repository')
  if (sharedGitDir) reasons.push('linked_worktree_or_shared_git_dir')
  if (isRepo && !bare && gitCommonDir === null) reasons.push('unresolved_git_common_dir')

  const readinessReasons: string[] = []
  if (reasons.length === 0 && headOid === null) readinessReasons.push('no_head_commit')

  return {
    requestedPath: requested,
    canonicalPath: canonical,
    worktreeRoot: canonicalWorktree,
    gitCommonDir,
    gitDir,
    headOid,
    dirty,
    bare,
    isRepository: isRepo,
    nested,
    supported: reasons.length === 0,
    reasons,
    executionReady: reasons.length === 0 && readinessReasons.length === 0,
    readinessReasons,
  }
}

/** Stable digest of the resolved Git facts used for context matching. */
export function contextDigestOf(parts: { canonicalPath: string; gitCommonDir: string | null; headOid: string | null }): string {
  return `ctx:${parts.canonicalPath}|${parts.gitCommonDir ?? ''}|${parts.headOid ?? 'no-head'}`
}
