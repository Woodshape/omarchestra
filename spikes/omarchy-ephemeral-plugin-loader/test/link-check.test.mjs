// SPIKE — module link check (red stage).
//
// Imports every default lib/ module so broken links surface immediately.
// Red while lib/index.mjs does not exist; green once task 3.a lands the model.

import test from 'node:test'
import assert from 'node:assert/strict'

test('lib/index.mjs links and exports the frozen public surface', async () => {
  const mod = await import('../lib/index.mjs')
  assert.equal(typeof mod.createTemporaryPanelHost, 'function',
    'lib/index.mjs must export createTemporaryPanelHost')
  assert.equal(typeof mod.createScratchRegistry, 'function',
    'lib/index.mjs must export createScratchRegistry')
})