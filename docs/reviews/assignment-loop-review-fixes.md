# Assignment-loop review fixes

Scope: the eight findings in the independent review of the uncommitted AL-02–AL-07 implementation. `cad005e` preserves that implementation (and all other pending work) unchanged. The fixes are a separate follow-up; neither commit authorizes installation, reload, Owner restart, Pi dispatch or a real Project gate.

## Fix and regression map

| Finding | Resulting behavior | Executable regression |
| --- | --- | --- |
| 1 — accepted-then-throw | The extension retains an `unknown` receipt **before** invoking Pi. Throws/async returns are unproven, not `invalid`/not-sent. Duplicates and receipt queries preserve uncertainty without a second API call; Stop cannot release the writer. Receipt capacity refuses new delivery rather than evicting dedup evidence. | `phase-3-assignment-delivery.test.ts`: accepted-then-throw, duplicate, receipt query and Stop |
| 2 — missing Pi Candidate entry | The installed factory registers `omarchestra_submit_candidate`. The model supplies only bounded summary/artifact references; exact Run/Assignment/Attempt/control identity comes from the extension's retained delivery. Unmanaged, pre-delivery, caller-authored identities, takeover and ended sessions refuse. The composed gate invokes the registered tool, not the private helper, for the successful submission. | Native-entry and registered-tool tests in `phase-3-assignment-delivery.test.ts`; AL-07 composed test |
| 3 — stale dispatch identity/context | Dispatch resolves the frozen Attempt against current binding digest/incarnation, control epoch, exact connection/challenge, writer epoch, stop and Project binding. A fresh challenged Project-context digest is required again at the send effect; Pi independently rechecks its local cwd before calling its API. Registry timeouts use monotonic remaining duration, not Owner wall timestamps. | Delivery tests for epoch, reported/unreported cwd, stale context and expired budget |
| 4 — cached idle as quiescence | New optional `management.quiescence` capability and closed request/report frames provide an exact Attempt-bound activity/context query. Acceptance checks its source, identities, sequence, connection, and <=2-second monotonic age **after** the final scan. Cached idle and validator exit are insufficient; lost query/coverage or manual takeover cannot release the writer. Dispatch after a coverage gap stays blocked pending separate reconciliation. | Busy versus cached-idle, fresh/stale reply, missing reply and disconnect tests; stale final-transaction evidence test |
| 5 — incomplete acceptance evidence | Pre/post/final scans retain and compare the full baseline fingerprint as well as the worktree manifest, covering HEAD/index/config. Final acceptance revalidates Project binding/revision, latest gate version and executable/resource pins. Only digests/bounded metadata are retained. | Zero-exit index/HEAD/config mutations; external executable and Git-context changes at the final acceptance boundary |
| 6 — takeover wiring | The framed interactive-input path and dock Take control both call the same Assignment pause mutation inside the binding/epoch transaction. Current Attempt and Assignment enter attention and queued outbox records are revoked. Already-running work is not claimed stopped. | Real input-hook and presentation-intent tests assert epoch, lifecycle, outbox, held writer and ability to record handoff |
| 7 — elapsed limits | Admission transaction stores an owner-epoch monotonic start/limit alongside the Assignment. Retry and dock recreation cannot reset it. Delivery, pre-launch, gate deadline, final acceptance and the native Owner's hidden-dock tick enforce it. Expiry records Stop and requests cooperative termination of the Runner-owned validator child only. A restart/missing interval cannot manufacture a new budget. | Pre-launch expiry, wall-clock independence, active-gate expiry, and native hidden-dock budget tests |
| 8 — output bounds | Capture enforces both 32 KiB per stream and the configured combined allowance (at most 64 KiB). Crossing either yields non-pass. | Executor tests for 40,000+40,000 bytes, a smaller combined allowance and exact 32+32 KiB boundary |

The new quiescence capability is advertised only when the native Candidate registration and Pi send APIs exist. Older observer/Adoption peers remain usable for those purposes, but cannot enable Start for an incomplete execution loop.

The Phase 2 envelope regression also now uses the already-landed Assignment-target association for intervention intents and explicitly rejects a mismatched Run target. It still asserts no execution/receipt for malformed association; no authority validator was relaxed.

## Reproduce

From the repository root, with disposable state and offscreen Qt only:

```sh
just --no-dotenv local-workbench-v1-phase-3-context-check
just --no-dotenv local-workbench-v1-phase-3-admission-check
just --no-dotenv local-workbench-v1-phase-3-delivery-check
just --no-dotenv local-workbench-v1-phase-3-candidate-check
just --no-dotenv local-workbench-v1-phase-3-assignment-gate-check
just --no-dotenv local-workbench-v1-phase-3-intervention-check
just --no-dotenv local-workbench-v1-phase-3-assignment-loop-check
just --no-dotenv local-workbench-v1-phase-2-check
```

Validated on Node **v26.8.1**:

| Gate | Result |
| --- | --- |
| Context | 4/4 Node cases; 29/29 offscreen Qt cases |
| Baseline prerequisite | 9/9 |
| Admission | 26/26 |
| Delivery + store | 33/33 |
| Candidate | 40/40 |
| Executor + gate acceptance | 37/37 |
| Intervention | 16/16 |
| AL-07 composed | 1/1, including registered tool submission and authoritative reopen |
| Full Phase 2 | Engineering PASS: foundation 50/50, management/native 256/256, presentation 86 passed plus 5 historical TODO placeholders, source/authority 37/37, migration/release 55/55, wake and rendered-layout gates including 29 Qt cases |
| Static hygiene | `git diff --check` and Phase 3 shell syntax passed; no `tsc` executable available |

The five historical TODO placeholders are not claimed as executed runtime tests. The Phase 3 gates above exercise the changed execution paths separately. This is host continuation and regression evidence, not an independent re-review or live acceptance.

## Remaining boundaries

- AL-08 remains blocked. No installed/runtime resources were changed and no live Pi or real Project Assignment/check was run.
- No migration is enabled. Existing schema-9 state still refuses; pre-fix schema-10 in-flight work without a provable owner-epoch budget cannot continue.
- Same-process activity is still best-effort under the accepted slash/user-bash limitation, not OS proof or write isolation. Resource scans detect observed drift, not transient restored writes. A final scan exceeding quiescence freshness refuses rather than weakening the two-second bound.
- Full return-to-team, operator uncertain-writer clearance and all live-use prerequisites remain separate from these eight fixes. A disconnected writer cannot be cleared merely by an idle reconnect. Existing direct-call intervention helpers are not represented as a complete native return-to-team workflow.
- Broader validator descendant supervision is not introduced. No Pi/process-group signal, kill escalation, rollback, automatic uncertain resend, installation or reload occurs.
