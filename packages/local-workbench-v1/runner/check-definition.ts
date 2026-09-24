/** C14: resolve and hash a configured check without executing it or trusting caller hashes. */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { validateCheckDraft, type CheckDraft } from '../console/detail-schema.ts'
import { workbenchError } from './errors.ts'
import { canonicalJson, sha256 } from './canonical-hash.ts'
import type { CheckRecord, ProjectRecord } from './store.ts'

const MAX_RESOURCE_BYTES = 64 * 1024 * 1024
const MAX_RESOURCES = 64
const CHUNK = 64 * 1024
export interface PinnedFile { path: string; digest: string; length: number; mode: number }
export interface ResolvedCheckDefinition {
  projectId: string; checkId: string; version: number; name: string; summary: string
  mode: 'validator' | 'artifact_presence'; commandSummary: string; semanticClaim: string
  executable: string; executableDigest: string; argv: string[]; cwd: string
  environment: CheckDraft['environment']; resources: PinnedFile[]
  timeoutMs: number; outputBytes: number; maxCorrections: number; elapsedMs: number
}

function invalid(message: string): never {
  throw workbenchError('invalid_input', `Check definition: ${message}`, 'choose regular, readable, bounded files in the confirmed Project and save the complete definition again')
}

/** No path components may traverse symlinks, even when the final target is inside the Project. */
function projectResource(path: string, root: string): string {
  if (!isAbsolute(path) || path !== resolve(path) || path.includes('\0') || !path.isWellFormed()) invalid('resource path is not canonical')
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) invalid('resource must be a file inside the Project')
  let cursor = root
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part)
    try { if (lstatSync(cursor).isSymbolicLink()) invalid('symlink resource traversal is unsupported') }
    catch (error) { if ((error as { name?: string }).name === 'WorkbenchError') throw error; invalid('resource is missing or unreadable') }
  }
  return path
}

/** Open with NOFOLLOW/NONBLOCK, hash bounded bytes and reject observed replacement or mutation. */
function pinFile(path: string, requireExecutable: boolean): PinnedFile {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_CLOEXEC) }
  catch { return invalid('file is missing, inaccessible or a symlink') }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size > BigInt(MAX_RESOURCE_BYTES)) invalid('file must be a bounded regular file')
    if (requireExecutable && (before.mode & 0o111n) === 0n) invalid('executable is not marked executable')
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK)
    let size = 0
    for (;;) {
      let count: number
      try { count = readSync(fd, buffer, 0, Math.min(CHUNK, MAX_RESOURCE_BYTES + 1 - size), null) }
      catch { return invalid('file cannot be read') }
      if (count === 0) break
      size += count
      if (size > MAX_RESOURCE_BYTES) invalid('file exceeds resource byte bound')
      digest.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd, { bigint: true })
    const pathNow = lstatSync(path, { bigint: true })
    if (!pathNow.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(size) !== after.size
      || pathNow.dev !== after.dev || pathNow.ino !== after.ino) invalid('file changed during hashing')
    return { path, digest: digest.digest('hex'), length: size, mode: Number(before.mode & 0o777n) }
  } catch (error) {
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    return invalid('file became unavailable during hashing')
  } finally { closeSync(fd) }
}

function executablePath(path: string): string {
  if (!isAbsolute(path) || !path.isWellFormed() || path.includes('\0')) invalid('executable must be an absolute file')
  try {
    const canonical = realpathSync.native(path)
    if (!isAbsolute(canonical) || !basename(canonical) || !lstatSync(canonical).isFile()) invalid('executable is not a regular file')
    return canonical
  } catch (error) {
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    return invalid('executable cannot be resolved')
  }
}

export function resolveCheckDefinition(project: ProjectRecord, identity: { checkId: string; version: number }, input: {
  name: unknown; summary: unknown; mode: unknown; commandSummary: unknown; definitionDraft: unknown
}): ResolvedCheckDefinition {
  let draft: CheckDraft
  try { draft = validateCheckDraft(input.definitionDraft) }
  catch { return invalid('draft contains missing, unknown or out-of-bounds fields') }
  const name = input.name, summary = input.summary, mode = input.mode, commandSummary = input.commandSummary
  if (typeof name !== 'string' || !name.isWellFormed() || !name.trim() || Buffer.byteLength(name) > 512
    || typeof summary !== 'string' || !summary.isWellFormed() || Buffer.byteLength(summary) > 512
    || typeof commandSummary !== 'string' || !commandSummary.isWellFormed() || Buffer.byteLength(commandSummary) > 512
    || /[\u0000-\u001f\u007f]/.test(`${name}${summary}${commandSummary}`)) invalid('invalid display fields')
  if (mode !== 'validator' && mode !== 'artifact_presence') invalid('invalid check mode')
  if (draft.cwd !== project.canonicalPath) invalid('cwd must equal the confirmed Project root')
  if ([...draft.argv, draft.executable, draft.cwd, ...draft.resourcePaths, ...draft.environment.map(e => e.value)].some(v => !v.isWellFormed())) invalid('definition contains malformed Unicode')
  const environment = draft.environment
  const reserved = /^(?:HOME|TMPDIR|TMP|TEMP|PATH|LANG|LC_.*|GIT_.*|PI_.*|SSH_.*|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV)$/i
  const secret = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i
  if (environment.some(item => reserved.test(item.name) || secret.test(item.name) || /[\u0000-\u001f\u007f]/.test(item.value))) invalid('environment overrides reserved settings or resembles a secret')
  if (draft.resourcePaths.length + 1 > MAX_RESOURCES || new Set(draft.resourcePaths).size !== draft.resourcePaths.length) invalid('duplicate or excessive resources')
  const resolvedExecutable = executablePath(draft.executable)
  const executable = pinFile(resolvedExecutable, true)
  const resources: PinnedFile[] = []
  let total = executable.length
  for (const resource of draft.resourcePaths) {
    const path = projectResource(resource, project.canonicalPath)
    if (path === resolvedExecutable) invalid('executable is already pinned separately')
    const pin = pinFile(path, false)
    total += pin.length
    if (total > MAX_RESOURCE_BYTES) invalid('aggregate resources exceed 64 MiB')
    resources.push(pin)
  }
  // Recheck previously read paths: concurrent changes are not a filesystem lock.
  const again = pinFile(resolvedExecutable, true)
  if (again.digest !== executable.digest || again.mode !== executable.mode) invalid('executable changed during resolution')
  for (let i = 0; i < resources.length; i++) {
    projectResource(resources[i].path, project.canonicalPath)
    const now = pinFile(resources[i].path, false)
    if (now.digest !== resources[i].digest || now.mode !== resources[i].mode) invalid('resource changed during resolution')
  }
  return {
    projectId: project.projectId, checkId: identity.checkId, version: identity.version,
    name, summary, mode, commandSummary,
    semanticClaim: mode === 'artifact_presence' ? 'Configured command exited zero; artifact presence/content needs separate evidence, not semantic review.' : 'Configured validator exited zero; subject to candidate and resource stability.',
    executable: executable.path, executableDigest: executable.digest, argv: [...draft.argv], cwd: project.canonicalPath,
    environment: environment.map(e => ({ ...e })), resources,
    timeoutMs: draft.timeoutMs, outputBytes: draft.outputBytes, maxCorrections: draft.maxCorrections, elapsedMs: draft.elapsedMs,
  }
}

/** Fail closed on corrupt persisted bytes; caller-controlled hashes never enter this schema. */
export function readResolvedCheck(record: CheckRecord): ResolvedCheckDefinition {
  if (!/^[a-f0-9]{64}$/.test(record.digest) || sha256(record.canonicalJson) !== record.digest) invalid('persisted check digest is invalid')
  let definition: ResolvedCheckDefinition
  try {
    const value = JSON.parse(record.canonicalJson) as ResolvedCheckDefinition
    if (Object.keys(value).sort().join(',') !== 'argv,checkId,commandSummary,cwd,elapsedMs,environment,executable,executableDigest,maxCorrections,mode,name,outputBytes,projectId,resources,semanticClaim,summary,timeoutMs,version'
      || canonicalJson(value) !== record.canonicalJson || value.projectId !== record.projectId || value.checkId !== record.checkId
      || value.version !== record.version || value.name !== record.name || value.mode !== record.mode) invalid('persisted check identity/shape drift')
    if (!Number.isSafeInteger(value.version) || value.version < 1 || !['validator', 'artifact_presence'].includes(value.mode)
      || typeof value.semanticClaim !== 'string' || value.semanticClaim.length > 512
      || typeof value.name !== 'string' || !value.name.trim() || Buffer.byteLength(value.name) > 512
      || typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 512
      || typeof value.commandSummary !== 'string' || Buffer.byteLength(value.commandSummary) > 512
      || !/^[a-f0-9]{64}$/.test(value.executableDigest)
      || !Array.isArray(value.resources) || value.resources.length > 63) invalid('persisted check fields are invalid')
    validateCheckDraft({ executable: value.executable, argv: value.argv, cwd: value.cwd,
      environment: value.environment, resourcePaths: value.resources.map(r => r.path),
      timeoutMs: value.timeoutMs, outputBytes: value.outputBytes, maxCorrections: value.maxCorrections, elapsedMs: value.elapsedMs })
    let total = 0
    const paths = new Set<string>()
    for (const resource of value.resources) {
      if (Object.keys(resource).sort().join(',') !== 'digest,length,mode,path' || !/^[a-f0-9]{64}$/.test(resource.digest)
        || !Number.isSafeInteger(resource.length) || resource.length < 0 || resource.length > MAX_RESOURCE_BYTES
        || !Number.isSafeInteger(resource.mode) || resource.mode < 0 || resource.mode > 0o777
        || paths.has(resource.path)) invalid('persisted resource fields are invalid')
      const rel = relative(value.cwd, resource.path)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) invalid('persisted resource escapes the Project')
      paths.add(resource.path)
      total += resource.length
    }
    if (total > MAX_RESOURCE_BYTES || paths.has(value.executable)) invalid('persisted resource bounds are invalid')
    definition = value
  } catch (error) {
    if ((error as { name?: string }).name === 'WorkbenchError') throw error
    return invalid('persisted check is malformed')
  }
  return definition
}

/** Explicit preflight for a later start review; never substitutes for pre/post execution checks. */
export function verifyCheckResources(record: CheckRecord, project: ProjectRecord): ResolvedCheckDefinition {
  const definition = readResolvedCheck(record)
  if (project.projectId !== definition.projectId || project.canonicalPath !== definition.cwd) invalid('check belongs to a different Project context')
  if (executablePath(definition.executable) !== definition.executable) invalid('executable target changed')
  const exec = pinFile(definition.executable, true)
  if (exec.digest !== definition.executableDigest) invalid('executable changed since configuration')
  for (const resource of definition.resources) {
    const now = pinFile(projectResource(resource.path, project.canonicalPath), false)
    if (now.digest !== resource.digest || now.length !== resource.length || now.mode !== resource.mode) invalid('resource changed since configuration')
  }
  return definition
}
