# Local Workbench v1 — first useful Assignment loop tracker

Status: **ACTIVE.** Project-context reporting is implemented and gated. Assignment admission, delivery, Candidate submission, acceptance-gate execution, and Assignment-specific intervention/recovery are not implemented; `start_assignment` remains disabled and rejected.

This is the current progress tracker for the one-Pi, one-Goal, one-Assignment slice in the [main Local Workbench plan](local-workbench-v1.md). Product and safety authority remains the locked [MVP](../design/mvp.md), approved [agent-coordination direction](../design/agent-coordination.md), and [Local Workbench contract](../design/local-workbench-v1-contract.md), especially C2 and C5–C14. Transition/failure semantics are in [the transition tables](../design/local-workbench-v1-transitions.md). This tracker schedules implementation; it does not weaken or replace those contracts.

## Finish line

For one local Execution Node and Project, the operator can:

1. Select one Goal, one exact ready visible Pi Run, one configured acceptance gate, a bounded task, and stop/correction limits.
2. Review and confirm the exact current Project/Git baseline, Goal, Run/connection/control identity, frozen check definition/resources, task text, and limits.
3. Admit exactly one write-authorized Assignment for that Project in a durable transaction, then deliver one stable-ID message to that same Pi.
4. Receive an explicit, bounded Candidate from that exact Run/Attempt and associate it with the frozen gate and checkout evidence.
5. Run the configured gate under the accepted time, output, environment, and resource bounds. Record a truthful pass/failure/attention result; a pass completes the one-Assignment Goal only after final revalidation.
6. Recover from disconnects, duplicate frames, restart, timeout, takeover, stop, and lost acknowledgements without inventing success, silently releasing an uncertain writer, or blindly resending work.

The context digest is only a fresh same-process Project-root report. It is not the Git HEAD/baseline fingerprint, a filesystem snapshot, admission, writer authority, or proof of Pi API delivery.

## Scope and invariants

- One local Node, one Project, one Goal, one ready visible Pi, one Assignment and one configured gate. At most one active/uncertain writer per Project.
- Keep one Owner/Runner authority and its existing store/receipt transaction path. No parallel registry or prototype promotion.
- Navigation and the dock remain presentation-only. QML never computes admission, Git facts, gate results, or writer authority.
- Commit authority and delivery intent before sending. Delivery is not exactly-once; an uncertain outcome is not an automatic retry.
- Only a structured Candidate from the exact current Run/Attempt/control epoch can enter validation. Agent-settled, conversational “done,” and artifact appearance are not acceptance.
- A configured gate is the acceptance authority; label only what that gate proves. No mandatory Reviewer, multi-agent workflow, Message Board, delegation, remote execution, CLI/API, worktree isolation, Pi/process kill, or rollback in this slice.
- No install, shell reload, Owner restart, or Pi reload is implied by implementation or by a passing automated gate. Each requires separate authorization. Live dispatch waits for the intervention prerequisites below and a separate explicit operator authorization.
- Do not require another Adoption walkthrough/microtest as a prerequisite. Use framed fake-Pi and disposable-store integration evidence for this implementation.

## Status legend

- **DONE** — code and its stated executable gate pass; not a claim of live acceptance.
- **IN PROGRESS** — bounded implementation currently underway.
- **NOT STARTED** — no implementation slice has landed.
- **BLOCKED** — intentionally cannot proceed until the listed prerequisite/authorization is met.
- **OPEN TOPIC** — an implementation/evidence gap under an already selected contract. It is not permission to change product policy; bring any contract conflict back for explicit decision.

## Progress

| ID | Slice | Status | Evidence / exit condition |
| --- | --- | --- | --- |
| AL-00 | Durable Project/Goal/check/Adoption substrate and actual Owner/Companion composition | **DONE (engineering)** | Current canonical [Phase 2 integration result](../design/local-workbench-v1-phase-2-integration-result.md) and `just --no-dotenv local-workbench-v1-phase-2-check`. Engineering gate passes; live Project/Goal/Adoption use remains separately unperformed. Do not repeat Adoption tests to start this plan. |
| AL-01 | Fresh, challenged Project-root context prerequisite and fail-closed Start Review presentation | **DONE** | Commit `50156de`; `just --no-dotenv local-workbench-v1-phase-3-context-check`; covers no unchallenged register attestation, capability negotiation, match/mismatch/missing/stale/disconnected reports, raw-path exclusion, and rendered UI. This enables no start action. |
| AL-02 | Exact start proposal, baseline/check revalidation, durable Assignment/Attempt admission, single-writer fence and assignment outbox | **IN PROGRESS (baseline prerequisite only)** | Added the C9 double-scan helper and fake-only `local-workbench-v1-phase-3-admission-prereq-check`; this does not yet create a proposal or persist admission. Exit still requires exact confirmation and one transaction committing Assignment, Attempt, writer epoch/lease, event, dedup receipt and delivery intent; all stale/race/fault cases leave no partial admission or send. Keep the UI action disabled until the full delivery path is accepted. |
| AL-03 | Same-Pi committed delivery, bounded ACK, extension dedup and uncertainty reconciliation | **NOT STARTED** | Exit only when a committed intent reaches the exact challenged Pi extension once per stable delivery ID; accepted/busy/duplicate/invalid are distinct; no queue or blind resend; dropped ACK remains unknown and can only be reconciled against the surviving extension receipt. |
| AL-04 | Structured, bounded Candidate and artifact association | **NOT STARTED** | Exit only when Candidate identity, size, paths, artifact digests, duplicates, retired/old Run rejection and control-epoch fencing are composed through the real bridge protocol and durable store. |
| AL-05 | Frozen gate invocation, bounded executor, checkout/resource fingerprinting and accepted result | **NOT STARTED** | Exit only when a frozen versioned gate executes without shell interpolation under C7–C9 bounds; pre/post candidate and resource changes cannot pass; exit/failure/timeout/output-limit/mutation are durably distinguished; only a final revalidated pass completes the Goal. |
| AL-06 | Assignment-specific stop, takeover, bounded correction, writer uncertainty and recovery | **NOT STARTED** | Exit only when C10–C12 failure races are persisted/tested; takeover pauses future automatic delivery; Stop revokes dispatch without claiming Pi/tool termination; unknown effects retain the writer until explicit supported reconciliation. |
| AL-07 | Real UI → Owner/Runner → SQLite → challenged fake Pi → Candidate → validator composition and executable acceptance gate | **NOT STARTED** | Exit only when the actual presentation adapter/QML entry, native authority, real protocol path, durable store, bounded child process and failure-injection gate compose. A callback fixture or printed record alone is insufficient. Start remains disabled until this gate passes. |
| AL-08 | One separately authorized real local task | **BLOCKED** | Requires AL-02–AL-07, the live-dispatch prerequisites below, a reviewed release/setup plan, and explicit authorization for each needed installation/reload/task action. No authorization is granted by this plan. |

## Implementation slices and gates

### AL-02 — Admission and exact confirmation

Implement only the minimal one-Assignment domain needed by C2, C5, C7, C9 and C10. Keep preparation/review separate from admission. The Runner—not QML—must resolve and freeze:

- Project ID, Execution Node, canonical root, Git common-directory identity and Project revision;
- current HEAD/index and the bounded dirty/untracked/ignored baseline digest;
- Goal ID and exact target Run plus immutable Pi incarnation, current challenged connection, readiness and control epoch;
- check ID/version/digest, canonical definition and executable/resource pins;
- exact task text, correction/elapsed limits, and resulting Assignment/Attempt/delivery IDs.

At confirmation, revalidate current facts rather than trusting the proposal or `contextMatch`. Any Project/HEAD/baseline/check/resource/Goal/Run/connection/control/revision change invalidates the review and requires a fresh one. In one Runner transaction, persist the Assignment, Attempt, single-writer admission/epoch, event/revision, complete intent receipt and assignment delivery outbox. A second concurrent start, another Role on the same Project, or any held/uncertain writer must be rejected. Receipt/transaction failure must leave no writer or sendable outbox item. Keep `start_assignment` unavailable until AL-07; do not land a misleading “admitted but cannot deliver” UI state.

#### AL-02a — Bounded baseline capture (partial)

`runner/content-manifest.ts` now captures the registered Project/Git identity, current HEAD/status, raw HEAD/index/config state, effective local config (including includes) and a sorted content/mode manifest of the working tree. It includes ignored/untracked files, records symlink text without following targets, rejects special/nested Git storage, bounds paths/files/bytes and requires two matching complete scans within 60 seconds. The disposable test covers content/mode/HEAD/index/config changes, included-config drift, mutation between scans, identity drift, oversized/special files and deadline failure. This helper is not yet called by Start Review or admission, is not persisted, and does not establish any writer authority. The separate schema-9 evolution decision and transactional Assignment/outbox work remain open; no live state or UI action was changed.

### AL-03 — Delivery and honest uncertainty

Use the same current challenged Pi bridge and same visible Pi process. The send occurs only after the admission transaction commits and a final currentness check. Stable identity is `(assignmentId, attemptId, deliveryId, payloadDigest)`; the surviving extension records/deduplicates it and reports `accepted`, `busy`, `duplicate`, or `invalid`. `accepted` proves only that the Pi API accepted input, not completion. `busy` does not queue. Commit-before-send failures, accepted-then-throw, connection replacement, duplicate/conflicting frames, ACK loss, Owner restart, and receipt-query recovery must be injected. No recovery path creates a second turn automatically.

### AL-04 — Candidate

Add a dedicated bounded extension-to-Runner submission, not a general agent message. Validate the exact current Run/Attempt/control epoch before persistence. Use C6 bounds: one pending Candidate per Attempt, bounded summary and artifact reference count/path lengths, relative Project-contained paths, no symlink traversal, stable content digests and no transcript/tool output. Exact duplicate submission is idempotent; changed reuse rejects. Candidate receipt is not gate success.

### AL-05 — Gate and acceptance

Reuse the Project-scoped resolved check catalogue; do not treat configuration-time hashes as execution proof. Freeze the exact check definition/resources per Attempt. Follow C7–C9: explicitly declared resource closure, absolute executable/argv, no shell, constructed nonsecret environment, bounded timeout/output, one bounded Runner-owned child and scratch area, and no Pi/process-group kill. Double-scan the candidate before launch and after exit; a changed checkout or validator resource is nonaccepting even on exit 0. A gate pass remains provisional until the final transaction rechecks Candidate, gate, context, writer/control epochs, stop/takeover state and quiescence. Store bounded reason/evidence and keep general projection free of validator output.

Test normal pass, nonzero, spawn error, timeout, output cap, changed executable/resource, candidate mutation, ignored/untracked changes, path escape/symlink/special file, scan bounds, and simultaneous takeover/stop/epoch changes. Every non-pass and unknown child/quiescence outcome stays nonaccepting and preserves uncertainty.

### AL-06 — Limits and intervention

Persist correction count and elapsed accounting; a restart with an unprovable interval does not grant a fresh budget. Failure may produce only the bounded next Attempt under the same confirmed gate and remaining limits. Gate execution error, changed evidence, unknown delivery, timeout, or uncertain quiescence requires attention/reconciliation, not an automatic correction loop.

Takeover and interactive-source input pause future Assignment/message delivery and invalidate stale Candidate/pass acceptance through control-epoch fencing. Return-to-team requires an exact structured handoff and explicit reconciliation. Stop durably revokes new dispatch first; cancellation is a separate, tested capability and ACK, never proof Pi tools ended. No kill, terminal close, checkout rollback, or automatic release. A disconnected/retired/replaced Run does not clear the writer.

## Open implementation topics

Current product policy is locked; no additional user decision is needed to start AL-02. These are evidence/implementation closure items under the existing contracts:

| Topic | Selected rule | What still needs proof | Effect if unavailable |
| --- | --- | --- | --- |
| Pi send/candidate API | C5 selects same-process `pi.sendUserMessage()`; C6 requires a dedicated structured Candidate. | Read the installed Pi SDK docs before editing the extension; add actual entry-point tests with injected Pi API and framed transport. Keep capabilities explicit; do not infer an installed API or reload a live Pi. | Delivery/Candidate capability unavailable; Start stays disabled. |
| Admission baseline | Dirty checkout is allowed only against an explicitly confirmed baseline; C2/C9 define separate directory identity, Git facts and content manifest. | The bounded helper and disposable tests now exist, but it is not wired to exact Start Review/current confirmation or the future Candidate pre/post gate path. Add integration and failure-window evidence. | No admission; request fresh inspection/review. |
| Durable schema evolution | Assignment/outbox state must share the existing Runner's single authority and transaction semantics. | Current store is schema 9. Specify a forward-only schema addition or explicit refusal behavior; inject interruption/rollback/reopen and preserve retained fence/receipt guarantees. Never silently promote or overwrite a user's store. | Runner opens no Assignment authority until schema/resource ownership is verified. |
| Gate resource closure | The configured executable/resources are operator-declared and versioned; undeclared dynamic dependencies are not reproducible evidence. | Prove pre/post hashes and execution behavior for declared resources; copy into Runner-owned storage only where semantics permit, otherwise pin and recheck checkout resources. | Check unavailable; no gate launch or acceptance. |
| Quiescence and activity coverage | C9/C11 require fresh challenged evidence plus operator reconciliation where coverage was lost; `ctx.isIdle()` is best-effort and is not OS proof. | Prove supported positive/negative/unknown paths, source-only takeover, lost coverage and restart. Preserve the accepted slash/user-bash limitation; do not read content to improve detection. | Retain uncertain writer and block conflicting work. |
| Cancellation and descendants | C8/C12 allow only tested cooperative cancellation; no kill escalation. | Advertise/use only a supported Pi API; bound validator child lifetime/output and prove cleanup or quarantine on uncertain descendants. | Mark unsupported/unknown, revoke future dispatch and retain uncertainty. |
| Privacy of results | C13 permits explicit task/Candidate content under bounds; general activity excludes gate stdout/stderr and conversation data. | Test every persisted/projected field and diagnostic truncation/redaction boundary. | Suppress restricted detail; never make it a general projection. |
| Existing owner-data compatibility | No implicit state deletion or silent schema repair; the live owner/release lifecycle is separate from code tests. | Exercise forward schema behavior using disposable copies and recovery fixtures; identify any later authorized migration separately. | Do not install/restart against real state. |

If implementation evidence conflicts with a locked C2/C5–C14 decision, stop at that boundary and record the exact evidence/request a decision; do not weaken the contract to make the gate green.

## Acceptance and live-use gates

The disposable executable gate to add for this slice must compose the real current QML/adapter, Owner/Runner authority, schema/SQLite transaction, actual framed extension adapter, Candidate submission, and a harmless deterministic validator child. It must arm a delivery spy that throws unless the scenario explicitly expects one send. Required regressions include:

- stale/mismatched start confirmation, baseline/check/resource drift and connection/control change: no commit/no send;
- concurrent starts and fault injection at each durable boundary: at most one writer, no partial authority;
- post-commit send and all ACK/receipt loss windows: no blind resend, exact unknown status;
- wrong/old Run, Attempt, connection, control epoch, duplicate and changed Candidate: no mutation/pass;
- gate mutation, candidate mutation, timeout, output limit, spawn failure, stop/takeover race and restart: never a false pass or automatic lease release;
- actual QML → adapter → Owner → bridge → durable result feedback and authoritative reopen snapshot.

Before any real Pi/worktree dispatch, prove the Phase 4 prerequisites in D6 of the [bounded handoff](local-workbench-v1-phase-3-handoff.md): stop authority/blast radius, writer quiescence and reconciliation, takeover during delivery, unknown-outcome recovery, diagnostics/privacy, and retirement/replacement/purge under live-load semantics. This is an engineering safety gate, not a request to retest Adoption.

A real task is a separate operation. Obtain explicit authorization before any installation/setup, shell reload, Owner restart, Pi reload, or real Assignment/gate execution. Record the task scope, exact check, observed outcomes, uncertainty and skipped steps. Do not push without authorization.

## Updating this tracker

After each bounded slice, update its status, commit/evidence, exit-gate outcome and newly discovered open topics here. Keep one checkout writer. Preserve verified partial work and turn failures into regression tests. Do not mark a slice DONE because helper/fixture tests pass if its stated composed path is still missing.
