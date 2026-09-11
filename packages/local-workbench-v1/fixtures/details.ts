import type { WorkbenchDetail } from '../console/detail-schema.ts'
import { managedFixture } from './projections.ts'

const hash = 'a'.repeat(64)
export const detailFixtures: WorkbenchDetail[] = [
  { kind: 'adoption', proposalId: 'proposal-1', observedSessionId: 'observed-1', projectId: 'project-local-1', goalId: 'goal-1', executionNodeId: 'local-1', role: 'Builder', predecessorAgentRunId: 'retired-1', vacancyGeneration: 2, stage: 'awaiting_ack' },
  { kind: 'start', confirmationId: 'confirmation-1', projectId: 'project-local-1', goalId: 'goal-1', agentRunId: 'run-1', goalText: 'Produce an artifact; acceptance is the configured gate only.', executionNodeId: 'local-1', gitCommonDir: '/fixture/project/.git', headOid: 'abcdef', baselineDigest: hash, dirty: true, maxCorrections: 1, elapsedMs: 900000,
    gate: { gateId: 'gate-1', version: 1, digest: hash, executable: '/usr/bin/test', executableDigest: hash, argv: ['-s', 'plan.md'], cwd: '/fixture/project', environment: [{ name: 'LANG', value: 'C.UTF-8' }], resources: [{ path: '/usr/bin/test', digest: hash }], timeoutMs: 60000, outputBytes: 65536, semanticClaim: 'A pass proves only the encoded validator result, not semantic correctness.' } },
  { kind: 'handoff', handoffId: 'handoff-1', assignmentId: 'assignment-1', attemptId: 'attempt-1', agentRunId: 'run-1', controlEpoch: 3, claimedState: 'partial', outstandingEffects: 'unknown', summary: '<b>Explicit handoff, not a transcript</b>', artifactRefs: ['plan.md'] },
  { kind: 'stop', stopId: 'stop-1', assignmentId: 'assignment-1', dispatchRevoked: true, trigger: 'operator', cancellationStatus: 'acknowledged' },
  { kind: 'diagnostics', assignmentId: 'assignment-1', attemptId: 'attempt-1', state: 'withheld', reason: 'Restricted excerpt requires explicit consent and a detail port.' },
]
export const detailedFixture = { ...managedFixture, details: detailFixtures, fixture: { active: true, label: 'Phase 1 detail design fixture; no runtime' } }
