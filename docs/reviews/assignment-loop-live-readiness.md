# Assignment-loop live-readiness checkpoints

Status: **IN PROGRESS; no live activation or task execution.** The operator reported review complete with no changes requested for PR #1, then authorized closing the upgrade/native-intervention prerequisites before live testing and before merging into `feature/local-workbench-v1` or `main`. That authorization does not waive the existing C2–C14/D6 safety contracts.

## Read-only live preflight

At reviewed checkpoint `ae17ffc`:

- The exact installed `omarchestra-workbench-owner.service` was already failed (`MainPID=0`); its journal recorded `identity_drift` for the legacy ownership receipt, followed by `start-limit-hit`.
- Existing `workbench-phase2-live/ownership.json` was v2. The v1/v2→v3 receipt migration already exists but had not been applied.
- Read-only SQLite inspection reported `user_version=9`, metadata `schema_version=9`, and `runner_epoch=16`. Before/after database SHA-256 matched. The new runtime requires schema 10 and does not migrate at startup.
- Installed and source Companion manifests both reported 0.14.0. No installation/current-source parity or live execution compatibility is claimed from that version string.
- Native Stop, return-to-team and operator uncertain-writer reconciliation remained incomplete. Direct-call intervention tests are not proof of operator entry points.

No live receipt/database edits, service reset/start, installation, shell/Pi reload, real dispatch, gate or merge followed this preflight.

## U1 — explicit offline schema upgrade (engineering checkpoint)

Local commit: `84e1fb5`. Not applied to installed state.

Entry: `manual/workbench-store-upgrade.ts`; implementation: `runner/store-migration.ts` under `packages/local-workbench-v1/`.

- Only the exact schema-9 layout from `b84e02f` is eligible. Its frozen DDL is digest-pinned by a regression. Schema shape/constraints/triggers, integrity/foreign keys, stored domain records, Node identity, counters and the independent fence ledger are validated; no version-number-only promotion.
- Inspection is read-only and requires existing canonical/private roots, a valid v3 ownership receipt, no runtime occupants/SQLite sidecars, and an empty private evidence directory outside state/runtime and Git/registered Projects. It never creates missing roots, removes sockets/journals, repairs receipts or resets systemd.
- Apply requires the exact displayed plan digest. Revalidate before/after acquiring the real lifetime owner lock; acquire SQLite write reservations for the store and fence ledger. No caller-supplied `ownershipHeld` boolean grants upgrade authority.
- Preserve and fsync byte-exact schema-9, fence, manifest and receipt evidence, plus a digest-bound plan. Reopen/validate the database backups before schema mutation and revalidate evidence before commit.
- Add the Assignment tables/indexes, advance both schema versions and record the authorized migration plan **in one in-place SQLite transaction**. Preserve every existing row/rowid (except schema version), Node/Goal/Project/check identity, event/intent history, epoch/revision/cursor, membership, uncertainty, revocation/high-water mark and ownership inode. No new Assignment, readiness, writer grant, retry, recovery or dispatch.
- Successful completion retains two verified clean store snapshots (before schema 9 and after schema 10), the unchanged independent fence snapshot, and bounded result metadata in the explicitly selected evidence directory. Existing backup inventory is not replaced or rotated by this one-time operation. Partial evidence is retained, never adopted/overwritten by a retry.
- Precommit exceptions roll back the transaction; subprocess crash tests establish SQLite recoverability. `--plan` deliberately refuses leftover journals rather than mutating them. A crash needing hot-journal recovery still requires a separately reviewed, lock-held SQLite recovery operation, not journal deletion or automatic restore.
- Postcommit evidence failure reports **schema 10 committed, evidence incomplete**, with the schema-9/fence backup and the plan in SQLite retained. Never claim rollback, retry migration, restore or downgrade automatically.
- Normal startup still refuses schema 9. Ordinary schema-10 reopen advances the epoch and runs the existing conservative recovery; migrated ready bindings do not inherit readiness or writer clearance. Older schemas/restore remain unsupported. Read/hash input is capped at 64 MiB per file.

### Executable evidence

On Node v26.8.1, disposable state only:

- `just --no-dotenv local-workbench-v1-store-upgrade-check`: **64/64 passed** (26 upgrade cases plus receipt/reboot, lifecycle-store and foundation cases).
- Real CLI plan/apply and wrong/missing authorization; receipt migration→store migration→normal reopen; every legacy row, exact inode, revoked incarnation/high-water and uncertain effects preserved.
- Wrong schema/metadata/constraints/foreign keys/Node/counters/check/fences, missing paths, unsafe/symlink/overlapping evidence, stale plans, concurrent owner, path substitution and backup tampering refuse.
- Rollback faults at backup/DDL/version/precommit; bounded child process exits around DDL/version/precommit/postcommit; explicit postcommit reporting. Exact crash children have independent 15-second hard timeouts.
- Full Phase 2 engineering gate: **PASS**, including 29 offscreen Qt cases. Its five historical TODO cases remain unexecuted.
- AL-07 composed fake-Pi loop: **1/1 passed**.

This is host engineering evidence, not independent review, a migration of the actual installed root, or live acceptance.

### Later authorized application order

After the remaining intervention/release prerequisites pass:

1. Reinspect the exact stopped Owner roots and prepare the existing receipt migration. Review/apply that exact v2→v3 plan with its separate evidence backup; do not start the service yet.
2. Select/create a new private empty evidence directory outside the checkout. Run the explicit store upgrade `--plan` with `--state-dir`, `--runtime-dir` and `--evidence-dir`.
3. Review that exact plan, then use `--apply` with the same paths and `--authorize <displayed digest>`. Changed facts require a new review, never an overridden digest.
4. Verify old/new database and independent fence evidence before the separate release installation/Owner startup plan. Never substitute an empty state root to hide an upgrade failure.

No step above has been performed against the installed root.

## U2 — native operator Stop (engineering checkpoint)

- `stop` now routes through the existing complete-envelope validation, current authority/revision checks, deduplication and command transaction. Stop lifecycle, queued-outbox revocation, writer state, event/revision and the operator receipt commit together.
- Validator abort is an **after-commit** effect. Receipt failure rolls back every Stop mutation and cannot signal the child. Pi cancellation remains `not_requested`; no Pi signal, terminal action, tool-termination claim or file rollback.
- The authoritative projection publishes Assignment-owned Stop independently of Run-card presence or bridge liveness. The real Work/Result QML renders that exact action with the existing second-press confirmation and an explicit blast-radius warning. Stop remains usable after Run retirement/purge; unknown prior effects still retain the writer.
- The composed fake-Pi test now runs two production-entry paths: Candidate→Accept→gate and Candidate→disconnect→operator retirement/purge→QML Stop. Both reopen SQLite and verify durable outcomes; the Stop case has no Run card, invokes no gate, sends no second task and preserves uncertainty. The test waits for Qt layout before physical button hit-testing instead of clicking unpolished, overlapping delegates.
- Added native-command regressions for receipt rollback/cancellation ordering, exact replay, changed/stale/incorrect targets, disconnected Pi, an actually running validator and Stop winning the final acceptance boundary. Existing direct-call tests remain, without treating them as return-to-team implementation.

Validation on Node v26.8.1, disposable state/offscreen Qt only:

- Intervention: **19/19 passed**.
- Executor/gate acceptance: **39/39 passed**, including running-child Stop and final-acceptance race.
- Composed QML/fake-Pi loop: **2/2 passed**, including Stop after real authority retirement/purge.
- Full Phase 2 engineering gate: **PASS**, including **29 Qt cases**; historical TODO placeholders remain unexecuted.

These are host engineering checkpoints, not independent review of the follow-up commits, live Pi testing or full D6 completion. No changes were installed and no live root was migrated.

## Remaining ordered checkpoints

1. Same-Pi return request and structured handoff, with explicit reconciliation and fresh control epoch; busy/unknown/late evidence must stay paused. Do not simply expose the direct-call helper as a complete workflow.
2. Operator uncertain-writer reconciliation with recorded prior effects, explicit unmanaged-interference acknowledgement and current bounded quiescence evidence. Retired/purged or missing evidence must never become idle-derived clearance.
3. Remaining live-load replacement and diagnostics/privacy evidence; reviewed current release/setup plan; exact disposable task/check and visible Pi selection. U2's retirement/purge path proves only its stated window, not every D6 failure case.
4. Only then separately apply the reviewed live upgrade/activation steps and exercise the bounded task. No automatic merge or claim of full AL-08 completion.
