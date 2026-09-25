import { randomBytes } from 'node:crypto'

/** Display only. Independent of all connection, session and Adoption secrets. */
export const isSessionCode = (value: unknown): value is string => typeof value === 'string' && /^[A-F0-9]{4}-[A-F0-9]{4}$/.test(value)
const randomCode = () => { const hex = randomBytes(4).toString('hex').toUpperCase(); return `${hex.slice(0, 4)}-${hex.slice(4)}` }

/** Owner-lifetime codebook. Never recycle an expired session's display code.
 * Reconnects preserve it; a new owner allocates fresh codes, not identity proof.
 * Bounded exhaustion affects presentation only, not ordinary Pi operation.
 */
export class SessionCodes {
  private readonly byIdentity = new Map<string, string>()
  private readonly used = new Set<string>()
  private readonly issue: () => string
  private readonly capacity: number
  constructor(issue: () => string = randomCode, capacity = 4096) { this.issue = issue; this.capacity = capacity }
  forIdentity(key: string): string | null {
    const existing = this.byIdentity.get(key)
    if (existing) return existing
    if (this.byIdentity.size >= this.capacity) return null
    for (let attempt = 0; attempt < 16; attempt++) {
      const code = this.issue()
      if (!isSessionCode(code)) throw Error('invalid_session_code')
      if (this.used.has(code)) continue
      this.used.add(code); this.byIdentity.set(key, code)
      return code
    }
    return null
  }
}
