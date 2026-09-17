/** Bounded, fixed-argv Git inspection. No shell, validator, Pi or write command. */
import { spawnSync } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute, normalize, resolve } from 'node:path'
import { workbenchError } from './errors.ts'
import { canonicalDirectory, sameDirectory, repositoryIdentityDigest } from './project-identity.ts'

export const GIT_COMMAND_TIMEOUT_MS = 5_000
export const GIT_MAX_OUTPUT_BYTES = 1 << 20
export const GIT_INSPECTION_BUDGET_MS = 15_000
export const MAX_STATUS_REPOSITORIES = 32

export interface GitCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
  signal?: string | null
}
export type GitRunner = (argv: readonly string[], cwd: string) => GitCommandResult

/** Fixed binary, argv and environment. Do not inherit GIT_DIR or Git config. */
export const defaultGitRunner: GitRunner = (argv, cwd) => {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.fsmonitor=false', ...argv], {
    cwd,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
    env: {
      PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
    },
  })
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return { status: result.status, signal: result.signal, error: result.error,
      stdout: decoder.decode(result.stdout ?? new Uint8Array()), stderr: decoder.decode(result.stderr ?? new Uint8Array()) }
  } catch {
    return { status: null, stdout: '', stderr: '', error: new Error('Git output is not UTF-8') }
  }
}

export interface GitInspection {
  requestedPath: string
  canonicalPath: string
  worktreeRoot: string | null
  gitCommonDir: string | null
  gitDir: string | null
  headOid: string | null
  /** Null means unknown, never clean. */
  dirty: boolean | null
  bare: boolean | null
  isRepository: boolean | null
  nested: boolean
  supported: boolean
  reasons: string[]
  executionReady: boolean
  readinessReasons: string[]
  /** Exact observed directory identities, not a checkout content baseline. */
  repositoryIdentity: string | null
}

function query(runner: GitRunner, argv: readonly string[], cwd: string): GitCommandResult {
  try { return runner(argv, cwd) }
  catch { return { status: null, stdout: '', stderr: '', error: new Error('Git query failed') } }
}

function completed(result: GitCommandResult): boolean {
  return result.error === undefined && (result.signal === undefined || result.signal === null)
    && Number.isInteger(result.status) && typeof result.stdout === 'string' && typeof result.stderr === 'string'
    && result.stdout.isWellFormed() && result.stderr.isWellFormed()
    && Buffer.byteLength(result.stdout) <= GIT_MAX_OUTPUT_BYTES && Buffer.byteLength(result.stderr) <= GIT_MAX_OUTPUT_BYTES
}

/** Remove only Git's trailing newline, not whitespace belonging to a path. */
function line(result: GitCommandResult): string | null {
  if (!completed(result) || result.status !== 0) return null
  const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  return value
}

function statusFact(result: GitCommandResult): boolean | null {
  if (!completed(result) || result.status !== 0) return null
  if (result.stdout === '') return false
  if (!result.stdout.endsWith('\n')) return null
  // Porcelain v1: two status codes, a space, then a quoted or plain path.
  const rows = result.stdout.slice(0, -1).split('\n')
  return rows.every(row => /^[ MADRCUT?!]{2} [^\u0000\r\n]+$/.test(row)) ? true : null
}

function booleanFact(result: GitCommandResult): boolean | null {
  const value = line(result)
  return value === 'true' ? true : value === 'false' ? false : null
}

/** A failed HEAD query alone does not establish an unborn repository. */
function inspectHead(runner: GitRunner, cwd: string): { oid: string | null; known: boolean } {
  const verified = query(runner, ['rev-parse', '--verify', 'HEAD^{commit}'], cwd)
  const oid = line(verified)
  if (oid !== null && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) return { oid, known: true }
  if (!completed(verified) || ![1, 128].includes(verified.status!)) return { oid: null, known: false }

  const reference = line(query(runner, ['symbolic-ref', '--quiet', 'HEAD'], cwd))
  if (!reference || Buffer.byteLength(reference) > 4096 || !reference.startsWith('refs/heads/')) return { oid: null, known: false }
  const exists = query(runner, ['show-ref', '--verify', '--quiet', reference], cwd)
  // Exit 1 from this specific query means the named branch ref is absent.
  const absent = completed(exists) && exists.status === 1 && exists.stdout === '' && exists.stderr === ''
  return { oid: null, known: absent }
}

/** Status may recurse into initialized submodules. Check their configuration as
 * well, without executing their filters. Missing/uninitialized Gitlinks have no
 * child repository to execute. This is not a concurrent-mutation sandbox.
 */
function statusPrecondition(runner: GitRunner, cwd: string, visited = new Set<string>()): string | null {
  if (visited.has(cwd) || visited.size >= MAX_STATUS_REPOSITORIES) return 'git_status_scope_exceeded'
  visited.add(cwd)
  const top = line(query(runner, ['rev-parse', '--show-toplevel'], cwd))
  if (top === null || canonicalDirectory(top)?.path !== cwd) return 'unresolved_status_root'
  const filters = query(runner, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'], cwd)
  const noFilters = completed(filters) && filters.status === 1 && filters.stdout === '' && filters.stderr === ''
  if (!noFilters) return completed(filters) && filters.status === 0 && filters.stdout.length > 0
    ? 'unsupported_git_filter' : 'unresolved_git_configuration'

  const index = query(runner, ['ls-files', '-z', '--format=%(objectmode)%x00%(path)'], cwd)
  if (!completed(index) || index.status !== 0) return 'unresolved_git_index'
  if (index.stdout !== '' && !index.stdout.endsWith('\0')) return 'unresolved_git_index'
  // The fixed format is a sequence of NUL-terminated (mode, path) pairs.
  const fields = index.stdout === '' ? [] : index.stdout.slice(0, -1).split('\0')
  if (fields.length % 2 !== 0) return 'unresolved_git_index'
  for (let i = 0; i < fields.length; i += 2) {
    const [mode, path] = [fields[i], fields[i + 1]]
    if (!['100644', '100755', '120000', '160000'].includes(mode)) return 'unsupported_git_index_mode'
    if (!path || isAbsolute(path) || path.split('/').some(part => ['', '.', '..'].includes(part))) return 'unresolved_git_index'
    if (mode !== '160000') continue
    const child = resolve(cwd, path)
    try {
      if (!lstatSync(child).isDirectory()) continue // Type change, not a child Git process.
      lstatSync(resolve(child, '.git'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return 'unavailable_submodule_context'
    }
    if (canonicalDirectory(child)?.path !== child) return 'unavailable_submodule_context'
    const reason = statusPrecondition(runner, child, visited)
    if (reason !== null) return reason
  }
  return null
}

export function inspectProjectPath(requestedPath: unknown, runner: GitRunner = defaultGitRunner): GitInspection {
  if (typeof requestedPath !== 'string' || !requestedPath.isWellFormed() || !isAbsolute(requestedPath)
      || Buffer.byteLength(requestedPath) > 4096 || /[\u0000-\u001f\u007f]/.test(requestedPath)) {
    throw workbenchError('invalid_input', 'project path must be a bounded absolute path', 'enter the absolute path of a local Git worktree')
  }
  const deadline = performance.now() + GIT_INSPECTION_BUDGET_MS
  const originalRunner = runner
  const expired = (): GitCommandResult => ({ status: null, stdout: '', stderr: '', error: new Error('Git inspection deadline') })
  runner = (argv, cwd) => {
    if (performance.now() >= deadline) return expired()
    const result = originalRunner(argv, cwd)
    return performance.now() >= deadline ? expired() : result
  }
  const requested = normalize(resolve(requestedPath))
  const root = canonicalDirectory(requested)
  if (root === null) {
    throw workbenchError('invalid_input', 'project path is not an accessible directory', 'enter the absolute path of an existing local directory')
  }
  const canonical = root.path
  const reasons: string[] = []
  const isRepo = booleanFact(query(runner, ['rev-parse', '--is-inside-work-tree'], canonical))
  const bare = booleanFact(query(runner, ['rev-parse', '--is-bare-repository'], canonical))
  if (isRepo !== true) reasons.push(isRepo === null ? 'unresolved_worktree' : 'not_a_git_worktree')
  if (bare !== false) reasons.push(bare === null ? 'unresolved_bare_repository' : 'bare_repository')

  const resolveGitDirectory = (option: string) => {
    const path = line(query(runner, ['rev-parse', option], canonical))
    return path ? canonicalDirectory(isAbsolute(path) ? path : resolve(canonical, path)) : null
  }
  const worktree = isRepo === true ? resolveGitDirectory('--show-toplevel') : null
  const common = isRepo === true ? resolveGitDirectory('--git-common-dir') : null
  const git = isRepo === true ? resolveGitDirectory('--git-dir') : null
  const nested = worktree !== null && worktree.path !== canonical
  if (isRepo === true && worktree === null) reasons.push('unresolved_worktree_root')
  if (nested) reasons.push('nested_worktree_or_submodule')
  if (isRepo === true && common === null) reasons.push('unresolved_git_common_dir')
  if (isRepo === true && git === null) reasons.push('unresolved_git_dir')
  if (common && git && common.path !== git.path) reasons.push('linked_worktree_or_shared_git_dir')

  let headOid: string | null = null
  let dirty: boolean | null = null
  let headKnown = false
  if (isRepo === true && bare === false) {
    const superproject = line(query(runner, ['rev-parse', '--show-superproject-working-tree'], canonical))
    if (superproject === null) reasons.push('unresolved_superproject')
    else if (superproject !== '') reasons.push('submodule_repository')
  }
  // Never ask status about a rejected/nested selection: its repository-wide
  // traversal could reach Gitlinks outside that selection's index prefix.
  if (reasons.length === 0) {
    const head = inspectHead(runner, canonical)
    headOid = head.oid
    headKnown = head.known
    if (!headKnown) reasons.push('unresolved_head')
    else {
      const statusReason = statusPrecondition(runner, canonical)
      if (statusReason !== null) reasons.push(statusReason)
      else {
        dirty = statusFact(query(runner, ['status', '--porcelain'], canonical))
        if (dirty === null) reasons.push('unresolved_status')
      }
    }
  }

  // Detect directory substitution and .git pointer changes during inspection.
  // This is a before/after check, not an atomic lock against repository edits.
  let stable = false
  if (worktree !== null && common !== null && git !== null) {
    const rootAfter = canonicalDirectory(requested)
    const worktreeAfter = resolveGitDirectory('--show-toplevel')
    const commonAfter = resolveGitDirectory('--git-common-dir')
    const gitAfter = resolveGitDirectory('--git-dir')
    stable = sameDirectory(root, rootAfter) && sameDirectory(worktree, worktreeAfter)
      && sameDirectory(common, commonAfter) && sameDirectory(git, gitAfter)
    if (!stable) reasons.push(rootAfter && worktreeAfter && commonAfter && gitAfter
      ? 'repository_changed_during_inspection' : 'repository_revalidation_failed')
  }
  if (performance.now() >= deadline) reasons.push('git_inspection_deadline')
  const repositoryIdentity = stable && common && git ? repositoryIdentityDigest(root, common, git) : null
  const readinessReasons = reasons.length === 0 && headKnown && headOid === null ? ['no_head_commit'] : []
  return {
    requestedPath: requested, canonicalPath: canonical, worktreeRoot: worktree?.path ?? null,
    gitCommonDir: common?.path ?? null, gitDir: git?.path ?? null, headOid, dirty, bare, isRepository: isRepo, nested,
    supported: reasons.length === 0, reasons,
    executionReady: reasons.length === 0 && readinessReasons.length === 0,
    readinessReasons, repositoryIdentity,
  }
}

export function contextDigestOf(inspection: GitInspection): string {
  if (!inspection.supported || inspection.repositoryIdentity === null) {
    throw workbenchError('invalid_input', 'Git repository identity is unavailable', 'inspect the repository again before confirmation')
  }
  return inspection.repositoryIdentity
}
