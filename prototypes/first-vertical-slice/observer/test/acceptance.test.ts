/**
 * PROTOTYPE — NOT PRODUCTION.
 *
 * Phase 2 red gate for the standalone observer/Adoption acceptance scenario.
 * This test intentionally fails until `observer/acceptance.ts` composes only
 * fake ports in Phase 7. It must never launch or contact a live resource.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const ACCEPTANCE_PATH = path.resolve(TEST_DIR, '..', 'acceptance.ts')

async function runAcceptance(): Promise<any> {
  const module = await import('../acceptance.ts')
  assert.equal(typeof module.runObserverAdoptionAcceptance, 'function')
  return await module.runObserverAdoptionAcceptance()
}

const INVALID_CASES = [
  'stale_identity',
  'reused_pid',
  'node_mismatch',
  'remote_team_goal',
  'role_occupied',
  'session_busy',
  'session_unknown',
  'session_exited',
  'already_managed',
  'duplicate_proposal',
  'proposal_expired',
  'connection_not_current',
  'ack_refused',
  'ack_timeout',
  'identity_drift',
  'transaction_failure',
]

test('standalone acceptance proves all ten observer and Adoption outcomes', async () => {
  const result = await runAcceptance()

  // 1. Ordinary visible-host fake remains usable before and without registry.
  assert.equal(result.ordinaryHost.visible, true)
  assert.equal(result.ordinaryHost.inputResultWithoutRegistry, 'continue')
  assert.equal(result.ordinaryHost.hiddenAgentCount, 0)
  assert.equal(result.ordinaryHost.processActionCount, 0)

  // 2. Registration creates exactly one current Observed Pi Session.
  assert.equal(result.registration.currentObservedCount, 1)
  assert.equal(result.registration.piStatus, 'Unassigned · observed')

  // 3. Companion shows observed/unassigned with no managed authority.
  assert.equal(result.beforeAdoption.observerProjection.agents.length, 1)
  assert.equal(result.beforeAdoption.observerProjection.agents[0].piStatus, 'Unassigned · observed')
  assert.deepEqual(result.beforeAdoption.managementFields, [])

  // 4. Forbidden content is absent from every crossed seam.
  assert.deepEqual(result.privacy.checkedSurfaces, [
    'protocol', 'registry_state', 'registry_events', 'companion_projection', 'qml_handoff',
  ])
  assert.equal(result.privacy.forbiddenCanaryAbsent, true)
  assert.equal(result.privacy.violationRejectedBeforeTransport, true)

  // 5. Every invalid Adoption leaves the exact session observed/unassigned.
  assert.deepEqual([...result.invalidAdoption.cases].sort(), [...INVALID_CASES].sort())
  assert.equal(result.invalidAdoption.allStayedObserved, true)
  assert.equal(result.invalidAdoption.commitCount, 0)

  // 6. One exact authorized Adoption commits once and only once.
  assert.deepEqual(result.commit.order, [
    'proposed', 'authorized', 'same_process_acknowledged', 'reconciled', 'committed',
  ])
  assert.equal(result.commit.commitCount, 1)
  assert.equal(result.commit.agentRunCount, 1)
  assert.equal(result.commit.observedCount, 0)

  // 7. No managed work or process action occurs before commit.
  assert.equal(result.authority.managedMessagesBeforeCommit, 0)
  assert.equal(result.authority.assignmentsBeforeCommit, 0)
  assert.equal(result.authority.promptsBeforeCommit, 0)
  assert.equal(result.authority.processActionsBeforeCommit, 0)

  // 8. The same process identity becomes managed, with honest runtime facts.
  assert.deepEqual(result.managed.identity, result.registration.identity)
  assert.equal(result.managed.piStatus, 'Builder · managed')
  assert.equal(result.managed.controlMode, 'managed')
  assert.equal(result.managed.runtimeBinding, null)
  assert.equal(result.managed.runtimeBindingGuarantee, 'unavailable')
  assert.equal(result.managed.managedMessagesAfterCommit, 1)

  // 9. Reload/reconnect reconstructs the same authority once.
  assert.equal(result.recovery.commitCount, 1)
  assert.equal(result.recovery.agentRunCount, 1)
  assert.equal(result.recovery.observedCount, 0)
  assert.equal(result.recovery.duplicateCount, 0)
  assert.deepEqual(result.recovery.identity, result.managed.identity)

  // 10. Cleanup removes only exact fake runtime resources and leaves durable
  // installation lifecycle entirely untouched.
  assert.equal(result.cleanup.onlyExactFakeResourcesRemoved, true)
  assert.equal(result.cleanup.unrelatedFakeResourcesPreserved, true)
  assert.equal(result.cleanup.installedCompanionMutationCount, 0)
  assert.equal(result.cleanup.userConfigurationMutationCount, 0)
  assert.equal(result.cleanup.liveActionCount, 0)
})

test('acceptance evidence itself contains no forbidden canary or fabricated PTY guarantee', async () => {
  const result = await runAcceptance()
  const encoded = JSON.stringify(result)
  assert.doesNotMatch(encoded, /PRIVATE_OBSERVER_CANARY/)
  assert.doesNotMatch(encoded, /"runtimeBindingGuarantee":"(?:guaranteed|boomux|persistent)"/i)
  assert.doesNotMatch(encoded, /terminalOutput|toolArguments|toolResults|conversationContent|environmentValues/)
})

test('acceptance implementation is fake-only and cannot launch a subprocess or import a human adapter', () => {
  assert.equal(fs.existsSync(ACCEPTANCE_PATH), true, 'observer/acceptance.ts must exist')
  const source = fs.readFileSync(ACCEPTANCE_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.doesNotMatch(source, /node:child_process|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/)
  assert.doesNotMatch(source, /manual\/|live-companion-omarchy|live-role-label-extension/)
  assert.doesNotMatch(source, /companion\/installation|src\/store\.ts/)
  assert.doesNotMatch(source, /\.config\/omarchy|~\/\.pi|manual-gates/)
})
