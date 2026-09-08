/** PROTOTYPE — NOT PRODUCTION. Creation-time ownership, never cleanup-time adoption. */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class AdoptionOwnedDatabase {
  private readonly identity: { dev: bigint; ino: bigint }
  private readonly parentIdentity: { dev: number; ino: number }
  readonly databasePath: string
  constructor(databasePath: string, expectedIdentity?: string) {
    this.databasePath = databasePath
    if (!path.isAbsolute(databasePath)) throw new Error('database path must be absolute')
    const parent = fs.lstatSync(path.dirname(databasePath))
    this.parentIdentity = { dev: parent.dev, ino: parent.ino }
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
        || parent.uid !== process.getuid?.() || fs.realpathSync(path.dirname(databasePath)) !== path.dirname(databasePath)) {
      throw new Error('database requires an owner-only canonical directory')
    }
    const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
      | (expectedIdentity === undefined ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0)
    const fd = fs.openSync(databasePath, flags, 0o600)
    try {
      const stat = fs.fstatSync(fd, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n
          || (expectedIdentity !== undefined && `${stat.dev}:${stat.ino}` !== expectedIdentity)) throw new Error('database ownership mismatch')
      this.identity = stat
    } finally { fs.closeSync(fd) }
  }
  manifest(): string { return `${this.databasePath} ${this.identity.dev}:${this.identity.ino}\n` }
  remove(): void {
    const parent = fs.lstatSync(path.dirname(this.databasePath))
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== this.parentIdentity.dev || parent.ino !== this.parentIdentity.ino) throw new Error('database directory identity changed')
    // SQLite normally removes its own rollback journal. Never claim ownership
    // of a residual or replacement sidecar by inspecting it at cleanup time.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { fs.lstatSync(this.databasePath + suffix) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      throw new Error('unowned SQLite sidecar remains; cleanup incomplete')
    }
    let stat: fs.BigIntStats
    try { stat = fs.lstatSync(this.databasePath, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
        || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      throw new Error('database identity changed; refusing cleanup')
    }
    fs.unlinkSync(this.databasePath)
  }
}

/** SQLite releases this separate process-ownership lock on crash. It never
 * locks the Adoption state DB, so the same process can commit normally. */
export class AdoptionRuntimeOwnership {
  private readonly database: AdoptionOwnedDatabase
  private readonly owner: AdoptionOwnedDatabase
  private readonly lock: DatabaseSync
  constructor(databasePath: string, priorManifest?: string) {
    let identities: string[] | undefined
    if (priorManifest !== undefined) {
      const lines = priorManifest.trim().split('\n')
      identities = [databasePath, databasePath + '.owner'].map((file, index) => {
        const prefix = file + ' '
        if (lines.length !== 2 || !lines[index].startsWith(prefix)) throw new Error('invalid ownership manifest')
        const identity = lines[index].slice(prefix.length)
        if (!/^[0-9]+:[0-9]+$/.test(identity)) throw new Error('invalid ownership identity')
        return identity
      })
    }
    this.database = new AdoptionOwnedDatabase(databasePath, identities?.[0])
    try { this.owner = new AdoptionOwnedDatabase(databasePath + '.owner', identities?.[1]) }
    catch (error) { if (!identities) this.database.remove(); throw error }
    this.lock = new DatabaseSync(databasePath + '.owner')
    try {
      this.lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
    } catch (error) {
      this.lock.close()
      if (!identities) { this.owner.remove(); this.database.remove() }
      throw error
    }
  }
  manifest(): string { return this.database.manifest() + this.owner.manifest() }
  close(): void { this.lock.close() }
  remove(): void {
    // Caller has closed the state DB first. Keep the ownership lock until
    // removal completes, then release it and remove the exact lock file.
    try { this.database.remove() } finally { this.lock.close() }
    this.owner.remove()
  }
}
