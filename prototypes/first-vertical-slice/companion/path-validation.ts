/** PROTOTYPE — NOT PRODUCTION. Shared lexical POSIX path validation for injected adapters. */

import path from 'node:path'

const POSIX = path.posix

export function normalizeAbsolutePath(
  input: string,
  error: (reason: 'absolute_posix' | 'canonical', input: string) => Error,
): string {
  if (typeof input !== 'string' || !POSIX.isAbsolute(input) || input.includes('\\')) {
    throw error('absolute_posix', String(input))
  }
  const normalized = POSIX.normalize(input)
  if (normalized !== input) throw error('canonical', input)
  return normalized
}
