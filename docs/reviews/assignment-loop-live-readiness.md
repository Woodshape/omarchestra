# Assignment-loop live-readiness checkpoints

Status: **IN PROGRESS; Companion and Owner activated; no live Assignment dispatch/task yet.** The operator reported review complete with no changes requested for PR #1, then authorized closing the upgrade/native-intervention prerequisites before live testing and before merging into `feature/local-workbench-v1` or `main`. That authorization does not waive the existing C2–C14/D6 safety contracts.

## Read-only live preflight

At reviewed checkpoint `ae17ffc`:

- The exact installed `omarchestra-workbench-owner.service` was already failed (`MainPID=0`); its journal recorded `identity_drift` for the legacy ownership receipt, followed by `start-limit-hit`.
- Existing `workbench-phase2-live/ownership.json` was v2. The v1/v2→v3 receipt migration already exists but had not been applied.
- Read-only SQLite inspection reported `user_version=9`, metadata `schema_version=9`, and `runner_epoch=16`. Before/after database SHA-256 matched. The new runtime requires schema 10 and does not migrate at startup.
- Installed and source Companion manifests both reported 0.14.0. No installation/current-source parity or live execution compatibility is claimed from that version string.
- Native Stop, return-to-team and operator uncertain-writer reconciliation remained incomplete. Direct-call intervention tests are not proof of operator entry points.

No live receipt/database edits, service reset/start, installation, shell/Pi reload, real dispatch, gate or merge followed this preflight.

## U1 — explicit offline schema upgrade (engineering checkpoint)

Engineering commit: `84e1fb5`. Installed-state application is recorded separately in U4 below.

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

At the U1 engineering checkpoint none of these steps had been performed against the installed root. U4 below records their later authorized application.

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

## U3 — native handoff, reconciliation and stopped-writer release

Implemented in `runner/assignment-intervention.ts`, `runner/pi-intervention.ts` and the existing authority, challenged bridge and Work/Result QML. Companion source is now **0.15.0**, not installed.

- Return to team is a normal exact-envelope, revision-bound operator command. The request, event and receipt commit before one same-Pi `sendUserMessage` call. Busy refuses without queueing; an unproven call stays unknown. Exact receipt replay never invokes Pi again. Requests time out to attention after 30 receiver-monotonic seconds.
- The actual registered `omarchestra_submit_handoff` tool accepts only bounded summary, relative artifact references, claimed state and outstanding effects. Identity comes from the retained operator request, not model parameters. The registry fences the connection, challenge, Run, incarnation and control epoch; the Runner verifies artifacts on disk before storing the handoff. Exact replay is idempotent; changed/late/stale reports cannot clear authority.
- Request history is owner-only metadata with stable request IDs and a current per-Assignment pointer. The original per-Attempt handoff row remains immutable; a later explicitly requested handoff is a separate retained full record, never a rewrite of prior claims. Projection uses the current request's handoff. Source input advances the epoch even while already manual, invalidating the prior handoff. Negotiated status reports carry the committed epoch; reconnect does not invent one.
- Resume/Retry require explicit operator notes about prior effects and an interference-risk acknowledgement, followed by the existing second-press confirmation. A fresh challenged Run-level probe, matching Project/baseline, original gate/resources, exact writer and remaining original limits are required. Control advances durably before same-Pi resume acknowledgement. A second stable baseline and fresh proof precede the final transaction that records reconciliation, transfers the writer epoch, creates one new Attempt and queues its delivery. Only then may the existing coordinator send. Handoff claims never directly accept work; a fresh Candidate still needs its frozen gate. Effect-review drafts/acknowledgements clear on session, generation, Owner epoch, selected Project/Goal, Attempt or handoff changes; ordinary refresh does not erase typing.
- After Stop, **Reconcile and release stopped writer** uses the same handoff, operator review and bounded quiescence checks, but creates no Attempt or delivery and cannot revive the stopped Assignment. Missing/retired/purged evidence, other unresolved effects, active tools, lost ACKs, changed context or unproven validator cleanup retain uncertainty. Legacy bindings without an Assignment are not silently cleared by this Assignment-scoped action.
- Validator lifetime markers preserve a crash/unknown-cleanup boundary; Pi idle cannot certify a Runner validator's missing exit evidence. Receipt rollback sends nothing; final-transaction failure cannot release the writer. Stop/input during asynchronous reconciliation wins before any new dispatch.
- Ordinary input remains source-only. Operator effect notes stay in owner-only request/evidence records, not Pi prompts or general projections. Explicit handoffs may appear as plain-text detail, including alongside Stop evidence. Restricted validator output is still not exposed by these actions. Assignment delivery now adds explicit Candidate-tool instructions and supplies bounded correction context; the original task text stays unchanged in durable records.
- Admission requires negotiated `management.intervention` as well as Candidate/delivery/quiescence support. Older observers can still observe/adopt; they cannot start an incomplete execution loop.

### Executable evidence

Disposable state, framed fake Pi and real offscreen Qt only:

- Composed operator gate: **4/4** — Candidate→gate; Stop after retirement/purge; actual QML Take control→Return→registered handoff tool→operator notes/risk acknowledgement→Resume→fresh Candidate→gate; and Stop→handoff→writer release without redispatch. Each path reopens SQLite.
- Native failure tests cover receipt rollback, busy Pi, accepted-then-throw, replay/conflicting reports, manual input after handoff, expiry, outstanding effects, lost resume ACK, Stop race, changed resources/checkout, final transaction failure, stopped-writer release and its audit, same surviving Pi after Owner restart, unproven validator lifetime, retired/purged refusal, lost handoff receipt, and replacement Adoption under delivered load with leaf-only purge and no write transfer. A privacy regression rejects reading input content and checks that operator notes stay out of projection/activity/Pi messages.
- Final source-release rerun on Node v26.8.1: **full Phase 2 PASS**, including **30 rendered Qt tests**; Phase 3 context **4 + 30 Qt**, baseline **9**, admission **26**, delivery/store **33**, Candidate **40**, gate executor/acceptance **39**, intervention **40**, composed **4**, store upgrade **64**, all PASS. `git diff --check` also passes. No `tsc` executable is available. Historical TODO placeholders are not execution evidence.
- Host logs: `/tmp/native-intervention-release-{phase2,context,admission-prereq,admission,delivery,candidate,assignment-gate,intervention,composed,upgrade}.txt`. Reproduce with `just --no-dotenv local-workbench-v1-phase-2-check`, the named Phase 3 `*-check` recipes, and `local-workbench-v1-store-upgrade-check`. These are host results, not independent review or live Pi acceptance.

### Read-only activation preflight after U3

- Exact installed Owner remains failed, `MainPID=0`; no restart or reset occurred.
- Runtime receipt inspection succeeds for the existing v2 receipt. Plan digest: `663feebcde84860ff6c35bf0d67cd626f15bd7bedd035bf30d77e1bc6457c63b`; old receipt hash: `905600091b9483f8404c8fdfd2951f04d3726ffe3b81c1e7baa89bad2109fe33`; proposed v3 hash: `df9c4effef847ecf04baf8d6dfc0eac8ba701d5e60d96a3061c1d0b8077c0989`. No resource is replaced by inspection.
- Read-only Companion installer inspection succeeds for the exact installed **0.14.0→0.15.0** update, retaining the existing 19-asset ownership inventory. Historical `st_dev` differs after reboot while inodes match; the installer already treats historical device numbers as diagnostics and still guards fresh operation identities. No receipt repair is needed or performed.
- The existing receipt migration and Companion setup commands require a real operator TTY. Do not synthesize a TTY/answer, bypass those guards, or replace installed assets manually. The explicit store upgrade remains separately plan-digest authorized after receipt migration.

## U4 — installed receipt and store upgrade applied

Source checkpoint: `1696a28`. The operator ran the real-TTY receipt migration and confirmed the printed v2 plan. Independent readback verified the v3 receipt hash `df9c4effef847ecf04baf8d6dfc0eac8ba701d5e60d96a3061c1d0b8077c0989` and the unchanged v2 backup hash `905600091b9483f8404c8fdfd2951f04d3726ffe3b81c1e7baa89bad2109fe33`.

With the exact enabled Owner still failed (`MainPID=0`), the explicit store plan was inspected and applied using digest `4d3f6f50463af6ae495512d8055be1e00742e446511cb038895d5ef094acde6d`. Evidence is retained at `~/.local/state/omarchestra/manual-gates/assignment-store-upgrade-vW8pSw/`: `before.sqlite`, `after.sqlite`, `fences.sqlite`, `manifest.json`, `ownership.json`, `plan.json`, `result.json`, and the separate read-only `verification.json`.

- Store advanced **9→10** in place; both schema markers read 10. Integrity and foreign-key checks pass.
- Before hash: `23cf39936421cdbc1279096e9d1be4a3b4a54645e3007725e8bc06fb88b193a1`; after/live hash: `93248e3885389d7c0d51416769a8fcfc6cd9adb4efea55d5fa8fe92c502a0e4e`.
- Independent fences remain byte-identical: `78dfb8f590bdf595ad13b40ea1d686adc3b12f2ae87d0ac8b53e47be817962d9`. The receipt is unchanged by the schema upgrade.
- A separate read-only SQLite comparison verified **every legacy row and rowid**, excluding only schema-version/migration metadata. In particular: 2 Projects, 2 Goals, 5 bindings, 2 memberships, 3 uncertain-effect records, 52 events and 127 intent receipts were preserved. Runner epoch remains **16**; there are **zero Assignments**. Preserved uncertainty has not been reconciled or cleared.
- Fresh read-only Companion update inspection passed for the owned 19-asset **0.14.0→0.15.0** release. The actual receipt-backed update and loaded-component verification are recorded below in U5.

## U5 — receipt-backed Companion activation and exact Owner start

The operator confirmed the displayed `0.15.0` install plan in a real terminal. The installer then returned `unsupported_compatibility`: it had committed the update and written `installation-result.json`, but its old in-memory shell panel still answered `0.14.0`. No blind installer retry occurred. We verified all 19 current receipt-owned inode/owner/mode/digest records and exact 0.15.0 source bytes, then ran the documented `omarchy restart shell` operation. This reloaded only the Omarchy shell; no Pi was stopped, reloaded or sent input.

The newly loaded panel reports `0.15.0`, presentation `task-first-v2`, and all ten expected destinations. Its generation is newer than the install receipt's `installedAt`. Full verification is retained in the private install evidence directory's `post-install-verification.json` alongside the exact plan/result. The existing previous release `0.14.0` remains in the installer receipt.

The user unit was verified enabled and byte-identical to `manual/omarchestra-workbench-owner.service`, then only `omarchestra-workbench-owner.service` was reset from `start-limit-hit` and started. It is active, with **zero restarts**, socket endpoints owned by its single process, and reports Runner epoch **17**. Read-only Runner status is `running`; the dock-open request succeeded. No other unit or Pi was restarted. The first immediate status query raced socket readiness and returned unavailable; retry after the ready event succeeded. Do not read the startup log's historical `executionUnavailable` Phase-3 wording as a live-dispatch test or acceptance result.

No Assignment has been admitted or dispatched, no Candidate submitted, and no real gate run. Read-only store review found no configured acceptance checks on the two migrated Projects. Their prior bindings are disconnected/retired and **three uncertain-effect records remain preserved**. They are not eligible test targets and must not be cleared to obtain a pass. The currently visible Pi process is not in either disposable Project context.

A new, mode-0700 disposable Git Project has been prepared under the private manual-gates state directory with one committed README marker and a clean baseline. `runner/main.ts inspect` reports it supported and execution-ready. The non-mutating test gate is planned as `/usr/bin/git diff --quiet HEAD`; it checks the tracked worktree only, while the Runner independently validates the full baseline (including untracked/ignored paths). Its exact SHA-256 is recorded in the local test preflight. The global Pi settings load the checked-out `~/.local/share/omarchestra/pi-observer.ts`, which imports the current extension source.

**Operator-visible boundary:** no Pi was launched, no terminal input was injected, and no hidden worker created. To use the disposable path, the operator must launch one visible Pi there. Starting it from the normal Pi command loads the already configured current extension. A single first Adoption to that new disposable Project may be required; this is not a request to repeat the previous Adoption walkthrough or to alter any prior binding. Until the visible Pi is connected to that exact fresh Project and native capabilities are verified, no Start or dispatch is safe.

## Remaining activation steps (not new implementation scope)

1. **Done:** operator-confirmed receipt migration, backed-up exact-digest schema upgrade with preserved evidence, receipt-backed 0.15.0 Companion update, loaded-version proof, and start of the exact enabled Owner unit.
2. Complete one bounded task in the prepared disposable Project using a single operator-visible Pi with the configured Companion observer. Confirm exact Project/cwd, connection/incarnation, and required native Candidate/quiescence/intervention capabilities. Configure the explicitly non-mutating gate; review the exact Start proposal before confirmation. No terminal-input injection, no hidden worker, and do not reuse or clear the legacy uncertain writers.
3. Verify Candidate→gate→durable result and Stop/reconciliation behavior in the visible operator entry points; record genuine live outcomes and limitations. **No merge before live acceptance.**
