# Local Workbench v1 — bounded Phase 3 handoff

> **Historical implementation snapshot.** The Phase 2 verdict and implementation inventory below predate later S1–S6 engineering completion and must not be used as current status. Use the [canonical Phase 2 integration result](../design/local-workbench-v1-phase-2-integration-result.md) for current evidence and the [Assignment-loop tracker](local-workbench-v1-assignment-loop.md) for current Phase 3 progress/open topics. The D6 intervention prerequisites remain the live-dispatch safety gate.

Phase 2 delivered a runnable durable management path and connected the actual presentation path, and it stops before any work is dispatched. The independent final authority verdict on Phase 2 is **FAIL**, and its unresolved findings are Phase 2 requirements returned to Phase 2, not Phase 3 obligations. This handoff therefore states: what Phase 3 receives, what is still open in Phase 2, the bounded Phase 3 scope for one gated Assignment, and the Phase 4 intervention prerequisites before live dispatch. It is written from the state of the code after Phase 2, not from the original plan.

Canonical Phase 2 record: [the final integration result](../design/local-workbench-v1-phase-2-integration-result.md). Phase 2 acceptance exits 1 (BLOCKED). The inherited task-level inventory below is qualified by that newer record.

## What Phase 3 receives

| Surface | State at the end of Phase 2 |
| --- | --- |
| Project registry | Durable. `inspect_project` then `confirm_register_project`, one `project_registered` event per Project. Final integration rejects selected submodule roots. Repository replacement and complete context validation remain open F9 work. |
| Team Goals | Durable. `create_goal`, `select_goal`, state changes through `setGoalState`. |
| Check catalogue | Durable, versioned. `create_check` at version 1, `configure_checks` at `version + 1` with stale-edit refusal. The runner stores the validated draft and a digest, but it does not yet resolve executables or resources or hash their contents (open F10); C14 resolution and content hashing are a Phase 2 requirement. |
| Adoption | Durable stage machine over the retained fence ledger, with frozen proposal digest, generation high-water marks, retirement, replacement and leaf-only purge. Bindings and fences identify Run IDs, not Pi incarnations (open F2), and bindings carry no Goal identity (open F3). |
| Projection and intents | The `omarchestra.workbench/v1` snapshot and the real `console/live-projection-adapter.ts`. `start_assignment` is present, disabled with `phase_3_unavailable`, and refused by both the adapter and the runner. |
| Entry | `runner/main.ts`: `start`, `status`, `backup`, `inspect`, with every root explicit and no daemon. |
| Store | `node:sqlite`, schema version 1, retained fence ledger, intent dedup, event cursor, runner epoch, owner lock. Effects and dedup outcomes do not share one transaction yet (open F7). |
| Backup | SHA-256 digest and schema metadata, rotated to two, verified against the recorded digest. Restore and migration are not implemented. Final integration preserves colliding backup targets. Rotation ownership and actual backup database integrity verification remain open F11 work. |

## D1 — enforce the accepted execution contracts

C2/C5/C7–C12 already select explicit operator authority, write admission, committed delivery, frozen gates, stopping and uncertainty semantics. Do not reopen these policies or require live Pi to implement injected bridge tests. First finish Phase 2. Then implement one gated Assignment against those contracts and prove the Phase 4 intervention failure windows before separately authorized live dispatch.

## D2 — the surfaces Phase 3 must not rebuild

1. `runner/git-context.ts` is the only module allowed to spawn a process, with fixed argv, no shell, a 5-second timeout and a 1 MiB output bound. Any Phase 3 executor must not widen that rule; the source audit asserts it.
2. The zero-dispatch invariant is asserted in the source audit and restated by both gates. Phase 3 keeps the assertion, adds delivery, and instruments the delivery port so an unintended call throws rather than runs.
3. `WorkbenchAuthority.commit` writes the event and the revision in one transaction. Delivery must not introduce a second commit path.
4. The adapter's fail-closed behaviour is the boundary. Phase 3 enables one action at a time, with a reason when it is unavailable.

## D3 — known gaps Phase 3 inherits

1. **Q2 — installed Pi extension management APIs.** Phase 2 ships the observer transport seam and the adoption state machine; the exact Pi identity and challenged-connection contracts are open Phase 2 requirements (F1), and no actual Pi extension exists in the package. The installation probe reports `available`/`absent`/`incompatible` read-only. Which management calls an installed extension actually exposes is still unverified, because verifying it means touching a live installation. Until it is verified, the bridge stays honest: absent capabilities report a reason, never a fabricated success.
2. **Q3 — presentation host resnapshot.** The runner holds one authoritative in-process connection and publishes only a changed snapshot. A native QML host that can be reloaded independently may need a resnapshot round-trip the Phase 1 shell lacks. This is a presentation seam, not a durability seam.
3. **Restore and migration.** `backup` reports `restoreSupported: false` and `migrationsSupported: false`. Phase 3 needs a restore that validates before it replaces, or an explicit decision to leave restore out.
4. **Operator checkpoint.** The human-only walkthrough in [local-workbench-v1-phase-2-walkthrough.md](../design/local-workbench-v1-phase-2-walkthrough.md) was not performed and is not authorized. It remains the Phase 2 native check and a precondition for claiming Phase 2 operator acceptance. The authority verdict states the workbench is not ready for it.

## D4 — open Phase 2 requirements (not Phase 3 obligations)

The independent final authority review found that none of its F1–F12 is fully closed and rejected the earlier framing that moved required Phase 2 work here. These are open Phase 2 requirements. Phase 3 must not treat them as accepted, and any Phase 3 delivery work depends on the safety-relevant ones: F1 (exact Pi identity and challenged connection), F2 (fences keyed to Pi incarnations), F3 (takeover/occupancy separation and Goal identity), F4 (connection, digest and expiry checks), F5 (challenged-extension recovery), F6 (resource and manifest ownership), F7 (dedup in the same transaction) and F9 (Git and storage identity, including the standalone submodule at its own root).

The exact remaining gap for each finding is recorded in [the Phase 2 engineering closeout](../design/local-workbench-v1-phase-2-closeout.md) section 2. Findings closable without a live Pi — F6, F7, F9, F10 (resource resolution and content hashing at save time, which executes nothing), F11 (backup replace semantics) and F12 (bounds and persisted schema) — are Phase 2 engineering work and are not gated on the live-Pi questions. F1, F2, F3, F4 and F5 require the real bridge and recovery implementation in Phase 2, tested with injected hosts and disposable resources.

Earlier tests accepted weakened retirement and purge semantics. Corrections preserve only the valid subset. The final Phase 2 gate reports that subset and exits 1 because complete acceptance is blocked. This section supersedes the earlier D5 deferral table, which wrongly moved these items to Phase 3.

## D5 — bounded Phase 3 scope

In order, and each step only after the previous is green:

1. Complete Phase 2 acceptance, then implement the accepted delivery and stop contracts (D1 above).
2. One delivery port for one Assignment, over the existing commit path, with the zero-dispatch assertion extended rather than removed, and an armed delivery spy in every scenario.
3. Assignment start review over the frozen check definition and its digest, with the failure windows proven before enabling.
4. Validator execution with a constructed environment, declared resources and bounded output, only after 1–3 are green.
5. Restore with validation, or an explicit decision to defer it.
6. The native operator checkpoint, with separate authorization.

Nothing in Phase 3 may enable Board or Plannotator integration, remote execution, or a second registry. Those are out of scope for this handoff.

## D6 — Phase 4 intervention prerequisites before live dispatch

Phase 3 may build and test delivery against injected hosts and a framed fake bridge. Before any live dispatch against a real Pi and a real worktree, Phase 4 must first implement and prove the accepted intervention contracts. They are prerequisites, not features:

1. **Stop authority and blast radius.** Who may revoke dispatch, what a `stop` is allowed to do to a running Pi (the contract forbids killing Pi, closing terminals and rolling back files), and how a partially delivered Assignment is detected.
2. **Writer safety and reconciliation.** The exact quiescence evidence accepted before a writer is released, and the operator reconciliation required whenever coverage was lost or manual work occurred.
3. **Manual takeover during delivery.** How takeover mid-delivery pauses automatic delivery and who resumes it.
4. **Uncertainty handling.** How an uncertain writer or an unknown delivery is resolved by an operator without automatic retry.
5. **Diagnostics and privacy.** What restricted diagnostic access Phase 4 exposes, under which explicit consent, and what it excludes.
6. **Replacement and purge under live load.** That retirement, replacement and purge keep their leaf-only and generation guarantees once real deliveries exist.

Until those are recorded and proven, no live dispatch is authorized, regardless of Phase 3 test results.
