# S1 checkpoint — binding identity, membership and recoverable revocations

Status: **S1 durable-substrate gate PASS. Phase 2 management acceptance remains BLOCKED.** Direct implementation and source self-review; no independent agent review or live integration is claimed.

## Landed implementation

- Store and fence schema **2** are explicit. Development schema-1 roots are rejected without migration, overwrite or inferred identity. The manifest schema is unchanged. Restore remains unavailable.
- `binding-identity.ts` defines four closed, bounded, independent identity fields: Execution Node and opaque process, Pi-session and extension capabilities. Canonical serialization determines the retained SHA-256 incarnation key. This is identity storage, **not bridge authentication or OS process attestation**.
- `binding_identities` attaches immutable incarnation and Goal identity to an existing Run. Goal/Project/Node mismatches, changed identity, duplicate incarnation and extra content are rejected. Binding commitment fields cannot be retargeted after identity attachment. Startup validates persisted associations and hashes.
- `role_memberships` is separate from proposals and connection/control state. Its `(Goal, Role)` primary key and unique Run reference enforce committed occupancy. A caller's store transaction changes binding state and inserts membership together; competing claims roll back. Disconnect does not delete membership. Retirement releases it in the store retirement transaction. High-water keys now include Goal.
- The runner's new `bindIdentity` and `commitMembership` entry points consult retained Run and incarnation fences. New observed/Run IDs cannot evade those checks. The old Adoption and projection implementations still need conversion to these entry points/tables in S4/S5; their earlier F2/F3 findings are **not** closed by persistence-only tests.
- Retirement writes independent ledger intent before the store transition. Purge now records irreversible ledger intent **before** deleting history. The store transaction deletes leaf binding/identity/membership and associated Adoption/retirement events, while retaining Project writer-effect uncertainty separately. The final ledger transaction replaces retirement context with only `{run_id, incarnation_key}`. Vacancy high-water rows remain. No external artifacts or Pi resources are touched.
- Recovery completes pending purges, including interruption after store deletion but before fence compaction, before authority admission. Latest minimal fences also defeat stale restored store rows; this is a negative recovery test, not portable restore support. Missing or mismatched retirement evidence fails closed.
- A cross-ledger exception latches the open runner unavailable until close/reopen/reconciliation. It is not reported as an atomic two-database commit. S2 must still tie operation outcomes to durable intent receipts and projection revisions before reporting command success.
- Event inserts atomically retain their cursor high-water mark through SQLite triggers. Deleting the latest history event cannot rewind ordering. Remaining Assignment-result events and Goals are not purged.

## Negative and interruption coverage

`test/phase-2-fence-operations.test.ts` exercises:

1. Failure after retirement ledger commit and after store retirement commit.
2. Failure after purge intent, after store history deletion, and after minimal-fence compaction.
3. Admission refusal on the faulted owner; exact-root reopen and idempotent recovery.
4. Closed identity privacy (throwing content getter), immutable Goal/identity/commitment fields and Node mismatch.
5. Proposals not occupying Roles, atomic competing-claim failure, and the same Role in separate Goals.
6. Retirement release without clearing uncertain effects; a new Run ID cannot rebind the retired incarnation through the new runner API, including after purge/restart.
7. Actual SQL absence of full history and exact two-column minimal fences, with stable high-water marks.
8. Stale restored history being removed rather than revived.
9. Unsupported old store/ledger schemas; malformed persisted incarnation; missing or contradictory ledger evidence; missing interrupted ownership receipt with byte-identical preserved databases.

The original diagnostic record already demonstrates the pre-repair F8 full-row retention defect. New boundary-injection tests verify the implemented recovery protocol; they are not described as a historical red run of that absent protocol. The first development test run caught a stale schema-version expectation, which was corrected to assert explicit schema-1 refusal, not weakened migration acceptance.

## Reproduction and results

All commands operate on disposable roots without installed Pi, desktop mutation or provider calls:

```sh
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-foundation-check
timeout --kill-after=5s 90s just --no-dotenv local-workbench-v1-check
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-phase-2-check
```

- S1 foundation gate passes and includes ownership, schema, backup and new fence-operation tests. Node subprocesses have deadlines and exact test cleanup.
- Full package tests pass with the pre-existing five runtime TODOs retained; Phase 1 presentation/offscreen checks pass.
- Full Phase 2 still exits **1/BLOCKED**, not acceptance. The implemented subset is green.
- Logs: `/tmp/p2-s1-foundation.log`, `/tmp/p2-fence-all.log`, `/tmp/p2-fence-phase1.log`, `/tmp/p2-fence-gate.log`.
- No prototype/spike changes, installation, live Pi, Assignment/check execution, commit or push in this checkpoint.

## Next handoff: S2

Use the new durable substrate, rather than claiming legacy binding-state rows are exact memberships. S2 must make effect/event/revision/outcome persistence atomic, publish memory only after SQL commit, reconcile ledger operations with command receipts, validate the full intent identity envelope, publish snapshots before feedback, and implement truthful unavailable outcomes plus source lifecycle/heartbeat/query behavior. The bridge, fully Goal-scoped Adoption/projections, challenged recovery and native entry remain S4–S6 work. S1 does not make the plugin ready for a human management walkthrough.
