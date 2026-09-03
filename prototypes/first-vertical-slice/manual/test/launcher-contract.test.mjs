import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const wizard = fs.readFileSync(path.join(here, '..', 'run-role-label-gate.sh'), 'utf8')

test('live Pi windows remain decorationless while allowing dynamic title metadata', () => {
  assert.match(wizard, /ghostty\s+\\\n\s+--class=.*\\\n\s+--window-decoration=none\s+\\/)
  assert.doesNotMatch(wizard, /\s--title=/)
})
