import { createHash } from 'node:crypto'

/** Stable definition/intent serialization; keep exact bytes for existing receipts. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

/** Opaque, domain-separated binding between a confirmed Project root and Pi's current ExtensionContext.cwd. */
export function projectExecutionContextDigest(canonicalPath: string): string {
  return sha256(`omarchestra.project-execution-context/v1\0${canonicalPath}`)
}
