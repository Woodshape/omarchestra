# Local Workbench v1 Phase 0/1 validation ledger

**Independent findings corrected; native UX acceptance pending.** The [independent red findings](../reviews/local-workbench-ux-redesign-validation.md) are closed by the [correction slice](../reviews/local-workbench-ux-redesign-corrections.md): actual Create/Save payload composition, same-revision review invalidation, native Project switching, progressive disclosure and advanced configuration drafts. Current gate: 115 Node pass, five deferred runtime TODOs; 16 Qt rows pass; QML lint PASS; affected regressions 163/163 pass. Counts below record the preceding delivery.

Canonical closeout and slot/task provenance: [collaboration result](local-workbench-v1-result.md). Phase 2 canonical closeout and final verdicts: [Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md).

**Phase 2 final status: incomplete, acceptance BLOCKED (exit 1).** The [canonical integration result](local-workbench-v1-phase-2-integration-result.md) supersedes the task-level counts and gate-green wording below. Final package suite: 146 pass, 0 fail, 5 TODO. Unchanged prototype regressions: 163/163 pass. New integration regressions cover backup collision preservation, actual submodule refusal, state-root overlap and manual-control restart. Full bridge/native/recovery acceptance is still missing. The human walkthrough remains blocked and unrun.

Current status: the 0.6.0 closeout below is superseded by the **task-first redesign** in the [screen and flow design](local-workbench-v1-screens.md) and [contract](local-workbench-v1-contract.md): Companion 0.7.0, nine task-first QML components, one default journey fixture with opt-in developer scenarios, 119 Node tests (114 pass, five deferred runtime TODOs) and twelve passing offscreen Qt rows. The native operator layout checkpoint remains pending. No durable execution claim.

The original integration commands/counts and initial limitations below are historical; current dispositions are recorded under Remaining gaps. References below to `retained-release.test.mjs` and copied 0.6.0/0.7.0 bundles describe that historical checkpoint only. The current no-copy policy and replacement tests are specified in [ADR 0006](../adr/0006-use-git-history-for-companion-release-source.md).

## Delivered files and contracts

- `local-workbench-v1-contract.md` closes C1–C13 with schemas, limits, authority, persistence, admission, candidate/gate, intervention, recovery and privacy decisions.
- `local-workbench-v1-transitions.md` supplies T1–T8 including commit/delivery/presentation failure windows.
- `local-workbench-v1-screens.md` records design and remaining visual checks.
- `packages/local-workbench-v1/console/` contains schema validation, projection core, injected adapter, actual Companion-method composition and nine task-first QML components (`WorkbenchConsole`, `WorkbenchHost`, `WorkbenchOverview`, `WorkbenchGoal`, `WorkbenchCards`, `WorkbenchAssignmentForm`, `WorkbenchChecks`, `WorkbenchReview`, `WorkbenchBoard`).
- `packages/local-workbench-v1/fixtures/` contains projection/intent fixtures, one default realistic journey fixture, and opt-in developer scenarios for failure/history states.
- `packages/local-workbench-v1/companion/` packages only additive release 0.7.0, with the exact 0.6.0 bytes retained outside the active catalogue for restoration and regression tests. Historical prototype bytes and defaults are unchanged.
- `packages/local-workbench-v1/test/` contains implementation tests, acceptance cases, QML method execution in an isolated JS context, import/privacy/release audits and five explicitly deferred runtime TODOs.
- `packages/local-workbench-v1/scripts/phase-gate.sh` and `just --no-dotenv local-workbench-v1-check` run foreground with disposable environment/storage. The explicit `--no-dotenv` avoids the root justfile's external Fusion configuration.

## Technical decisions

**D1.** Production-intended presentation lives in a new package with no prototype runtime imports, store, gate executor, live Pi or dispatch. Phase 2 must compose one runner/store, not run competing services.

**D2.** Release 0.6.0 respects the archived 0.5.0 retirement metadata reservation. New compatibility target is Omarchy 4.0.3-1 / Quickshell 0.3.1-1, based on later historical host evidence. This does not modify prior releases or certify live installation.

**D3.** Dirty checkout admission requires explicit baseline confirmation, not automatic cleaning or a clean-only policy. Gate acceptance is operator-versioned and role-independent. Stop ACK/retirement/disconnect never prove writer safety.

**D4.** Data-bearing projection events are rejected pending full snapshot replacement. General Assignment diagnostics are omitted from validated projections. Start Assignment and exact Adoption authorization remain disabled until their runtime confirmation contracts can be represented completely.

No known user-policy blocker prevents further bounded Phase 1 work. Technical gaps are not requests to widen scope.

## Original Fusion integration validation

All commands ran foreground with a 60-second bound per tool invocation. No installation, user configuration mutation, provider, desktop, live Pi, real Project access, commit or push occurred.

| Command | Result |
| --- | --- |
| `just --no-dotenv local-workbench-v1-check` | 90 tests: 85 pass, zero fail, five runtime TODOs. Static QML lint exits 0 with warnings. |
| `bash -n packages/local-workbench-v1/scripts/phase-gate.sh` | PASS |
| `git diff --check` | PASS |
| `git diff --exit-code -- prototypes/ spikes/` | PASS, historical tracked evidence and release sources unchanged |
| Affected regression command below | 163/163 pass, zero skipped/TODO |

The phase gate explicitly runs these suites: `projection.test.ts`, `intent.test.ts`, `stale-session.test.ts`, `layout-fixtures.test.ts`, `acceptance.test.ts`, `presentation-shell.test.ts`, `phase1-followup.test.ts`, `rendered-layout.test.ts`, `manual/test/workbench-preview.test.ts`, `qml-boundary.test.mjs`, `source-audit.test.mjs` and `retained-release.test.mjs`.

Regression command (the temporary directory is removed after Node exits):

```sh
scratch=$(mktemp -d /tmp/workbench-regression.XXXXXX)
node_bin=$(command -v node)
env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$scratch" TMPDIR="$scratch" \
  QMLLINT_BIN=/usr/lib/qt6/bin/qmllint "$node_bin" --experimental-strip-types --test \
  prototypes/first-vertical-slice/console/test/projection-adapter.test.ts \
  prototypes/first-vertical-slice/console/test/companion-projection-session.test.ts \
  prototypes/first-vertical-slice/console/test/qml-boundary.test.mjs \
  prototypes/first-vertical-slice/companion/test/installation.test.ts \
  prototypes/first-vertical-slice/observer/test/companion-projection.test.ts \
  prototypes/first-vertical-slice/observer/test/live-adoption-composed.test.ts \
  prototypes/first-vertical-slice/observer/test/live-adoption-presentation.test.ts \
  prototypes/first-vertical-slice/observer/test/live-adoption-durability.test.ts \
  prototypes/first-vertical-slice/observer/test/retirement-replacement-red.test.ts \
  prototypes/first-vertical-slice/observer/test/retirement-replacement-presentation.test.ts \
  prototypes/first-vertical-slice/manual/test/live-retirement-store.test.ts
rm -rf -- "$scratch"
```

Final sequential rerun logs are `/tmp/workbench-canonical-gate.log` and `/tmp/workbench-canonical-regression.log` (same counts). The final turn also tested that queued QML clicks are discarded on revision changes, preventing stale clicks from acquiring a newer expected revision. These are local ephemeral evidence rather than durable repository artifacts. Node version is recorded by the gate.

## Corrections and evidence limits

The preceding acceptance task reported ten failures and unavailable lint. Integration fixed all ten assertions, then added stricter bounds/booleans, recursive checking, identity fencing, immutable handoffs, session-reset recovery, authoritative action narrowing, obsolete feedback rejection, bounded pending-slot reclamation, outcome queries, snapshot requests and QML-to-adapter method composition.

The lint binary was actually present at `/usr/lib/qt6/bin/qmllint`. The just recipe now preserves an explicit path and discovers that fallback. The gate maps Quickshell's `qs` import namespace to installed system QML through a disposable scratch symlink. `--ignore-settings --import error` prevents unresolved imports being mislabeled PASS. Remaining dynamic-property/unqualified-access/type metadata warnings are visible and are not visual acceptance. The gate does not launch QML. Earlier lint-unavailable and default-lint success-with-unresolved-import results are superseded by this final invocation, not erased from the task logs.

## Bounded follow-up review dispositions (0.7.0)

A read-only contract/authority review and a read-only UX review of the 0.7.0 task-first slice produced **no blocking findings**. Their non-blocking observations and dispositions:

| Observation | Disposition |
| --- | --- |
| `start_assignment`/`authorize_adoption` are rejected by the adapter before the action allow-list, so they can never be emitted | Intended in Phase 1. Phase 1 renders exact facts and refuses; no runtime port exists. **Superseded for `authorize_adoption` by Phase 2**, which enables it on the durable path only; `start_assignment` remains rejected. |
| `configure_checks`/`create_goal`/card actions require an enabled committed action with matching target | Intended fail-closed authority: an unknown or narrowed target cannot be written. |
| `select_project`/`select_goal` bypass the action allow-list | Accepted, non-blocking: they carry no authority, the payload is a committed identity, and the QML offers only committed entries. |
| `reviewAssociation` includes `projection.revision` and the task text | Intended: a review that would start different work than it shows never survives. Drafts survive invalidation. |
| Escape is handled inside the panel window, not on the outer root item | Required: the layer-shell panel is a separate window. Verified by the offscreen Qt Escape rows. |
| Work and result offers two back affordances (header `Back`, `Back to Project`) | Accepted and documented in the screen design: the header follows the reaching path, `Back to Project` always returns to the Project home. |
| Work and result showed only the first committed Assignment | **Fixed in this slice.** Every committed Assignment now renders as its own bounded row with its own facts and its own interventions; truncation beyond eight rows is stated. Covered by an injected-method test and an offscreen Qt row test. |
| The contextual `⋮` menu is rendered inline instead of as a floating popup | Accepted: a floating popup conflicts with the panel layer mask and the fixed dock geometry. |

## Remaining gaps and checkpoint

**R1. Screen engineering closed (0.7.0):** typed detail schemas render as exact plain-text facts in Adoption review and Start review inside the task-first destinations. Complete executable/resource/environment/context/limit facts are displayed. Start, Adoption authorization and diagnostic access still cannot emit runtime requests because those ports do not exist; the actions are visibly disabled with a reason and emit nothing. The 0.6.0 review-only detail/consent previews were removed rather than retained.

**R2. Interaction engineering closed (0.7.0):** actual form/adapter synchronization survives target switching/reopen; authored labels and editors explicitly exclude rich text. Offscreen Qt renders the journey destinations, the contextual `⋮` menu, the confirmation dialog and the checks editor with inert theme/decorative ports and a substituted Window host. Tests cover palette readback, draft restoration, Tab hand-off from multiline editors, Escape at panel-window level, menu focus restoration, stop confirmation, stale action revocation and per-row work interventions. Full native-theme/compositor usability still requires R3.

**R3. Operator checkpoint:** pending and not performed. Use one separately authorized consolidated narrow/wide layout checkpoint, not repeated live Pi/restart/reviewer checklists. No installation or desktop launch is authorized by this ledger.

**R4. Runtime coverage:** persistence, admission, exact Adoption, same-Pi dispatch, candidate scanning, validator execution, cancellation, quiescence and durable recovery are contract specifications only. The existing prototype regressions preserve historical evidence, not production integration. Five runtime TODO tests remain explicitly proposed.

The phase gate is a passing automated subset, not full phase completion. R1/R2 were resolved within the bounded task-first presentation follow-up; the native R3 checkpoint is the remaining Phase 1 acceptance. [The Phase 2 handoff](../plans/local-workbench-v1-phase-2-handoff.md) preserves this entry condition and does not authorize dispatch.

## Phase 2 ledger — durable management and admission (P2.2–P2.5)

Phase 2 moved the accepted fixture-only task-first preview onto a durable foreground runner. This ledger records what was actually executed and what remains specification. The independent final authority verdict is **FAIL**: the durable path runs and the gate is green, but the reviewed authority contracts are not all closed. The canonical Phase 2 record is [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md).

**What is working.** Register and confirm a real local Git Project through inspect-then-confirm; durable Team Goals; durable Project-scoped checks with versioned reconfiguration and stale-edit refusal; observe, propose, authorize, acknowledge, commit and confirm readiness for one visible Pi over an injected observer transport (no live bridge exists); takeover, disconnect, retirement, replacement and leaf-only purge over a retained fence ledger; reopen and clean restart through one foreground process and one SQLite store; the actual QML intents and presentation adapter (not a parallel fixture implementation); and a runnable composition with normal foreground entry points.

**What is disabled.** Assignment delivery and acceptance-check execution. `start_assignment` is refused with `phase_3_unavailable`, the projection reports the action disabled with a reason, and no delivery port, validator executor or network import exists in `runner/`.

**Evidence.** All commands were run foreground on branch `feature/local-workbench-v1` with Node `v26.8.1` (SQLite 3.53.4), injected clocks and id sources, and disposable state roots under a temp directory.

```text
just --no-dotenv local-workbench-v1-phase-2-check                  -> PASS
  runner-foundation                  16 pass / 0 fail
  phase-2-authority                   7 pass / 0 fail
  phase-2-composed                    2 pass / 0 fail
  phase-2-entry                       2 pass / 0 fail
  presentation-shell                  3 pass / 0 fail
  intent                             17 pass / 0 fail
  projection                         15 pass / 0 fail
  acceptance                         16 pass / 0 fail
  phase1-followup                    10 pass / 0 fail
  stale-session                       7 pass / 0 fail
  source-audit + qml-boundary + retained-release  38 pass / 0 fail
  rendered-layout (offscreen Qt 6.11.2)           18 rows, 0 failed, no QML warning
  invariant: zero Assignment deliveries, zero acceptance-check executions

just --no-dotenv local-workbench-v1-foundation-check               -> PASS
just --no-dotenv local-workbench-v1-check                          -> Phase 0/1 gate PASS
test/*.test.ts + test/*.test.mjs                                   -> 142 pass, 0 fail, 5 todo
```

Two defects were found and fixed by the new tests rather than asserted away:

| Defect | Fix |
| --- | --- |
| `emitIntent` reported the committed outcome to the view before the `submitted` feedback, so a synchronous in-process runner had its acknowledgement overwritten. | `submitted` is emitted before the intent sink runs, so the committed outcome is the last feedback the view sees. |
| `start` wrote the `ready` record after `host.start()` triggered `open`, so a reader could see a projection before learning its session and epoch. | `ready` is written before the host starts. |

Two further defects were in the tests themselves and were corrected: the entry test read the initial revision from a `projection` record when the first snapshot arrives inside the `open` envelope, and the parent session dropped unmatched stdout records while waiting for a specific record kind.

**Post-review corrections.** An independent authority/persistence review and an independent UI/composition review produced blocking findings against the Phase 2 delivery. Most of the corrections below have a regression test in `test/phase-2-authority.test.ts`, `test/phase-2-composed.test.ts` or `test/retained-release.test.mjs`. Three LOW corrections (uniform `checkSummary` reason, `contextMatch: false`, rendered rejection `Reason:`) have no dedicated test pinning them; the earlier claim that every listed correction had one was overstated.

| Correction | What changed |
| --- | --- |
| Retained release integrity | The accepted 0.7.0 bytes are frozen under `companion/retained/0.7.0/` and read from a version-driven manifest; `WORKBENCH_PLUGIN_VERSION` moved to `0.8.0` so Phase 2 publishes its own release instead of mutating 0.7.0. |
| Adoption reachable from QML | Transport observations and pending proposals render as the choices that emit `request_adoption` and `authorize_adoption`; the `take_control` payload carries `agentRunId`; a rejection renders its `reasonCode`. Before this, the adapter could not route three of the four adoption seams from the real QML. |
| Fail-closed binding lifecycle | `assertLive` guards every binding mutation; late frames after retirement or purge are refused; `input_observed` and takeover move a Run to `manual_takeover` and bump its control epoch; any non-retired, non-purged binding blocks a new adoption for the same Project and Role regardless of connection state. |
| Acknowledgement timing | A commit deadline is enforced at acknowledgement and by `sweepExpired()`; an expired acknowledgement is refused, and a duplicate acknowledgement after the exchange is a stable no-op instead of a second commit. |
| Restart honesty | Recovery downgrades `acknowledged`, `committed` and `ready` to `disconnected` with `writerState: 'uncertain'`; a fenced binding becomes `retired`; a purged fence is re-purged. A restart can no longer present a committed Run as ready. |
| Leaf-only purge | Purging a binding is refused while any non-purged successor exists, including a retired one. |
| Git and storage identity | The Git inspector records `--git-dir` and refuses a linked worktree or shared Git directory; registration refuses a Project whose storage overlaps an existing Project in either direction. |
| New-check authoring | `+ New check` opens the same validated editor as an edit. The definition is committed only when the name, summary and definition pass the existing field validation, and the new-check draft is keyed per Project so field text survives navigation. The previous button emitted a placeholder definition containing `/bin/true` without operator input. |

No guard was weakened to close a finding. The independent final authority review then found that none of its F1–F12 is fully closed against its original scope, and rejected the D5 framing that moved required Phase 2 work into Phase 3. Those findings are open Phase 2 requirements, listed with their exact remaining gaps in [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md) section 2 and in [the Phase 3 handoff](../plans/local-workbench-v1-phase-3-handoff.md).

Affected regression evidence (all foreground, disposable storage, no live resource):

```text
just --no-dotenv local-workbench-v1-phase-2-check        -> PASS (zero deliveries, zero check executions)
just --no-dotenv local-workbench-v1-foundation-check    -> PASS
just --no-dotenv local-workbench-v1-check               -> Phase 0/1 gate PASS
QMLTESTRUNNER_BIN=/bin/false bash scripts/phase-2-gate.sh -> exit 1
canonical prototype regressions (163 tests)              -> 163 pass, 0 fail
```

The three prototype recipes that invoke `qmllint` by bare name fail in an environment without `/usr/lib/qt6/bin` on `PATH` (`spawnSync qmllint ENOENT`); with that directory on `PATH` they pass. That condition predates this delivery and is not caused by the Phase 2 changes.

**Independent final verdicts.** Two independent final verifications inspected the corrected tree read-only and executed nothing.

| Verification | Scope | Verdict |
| --- | --- | --- |
| Final authority review | Exact identity, ownership, persistence, fencing, recovery, bounds | **FAIL.** None of F1–F12 fully closed; the workbench is not ready for the human walkthrough. |
| Final UI/adapter verification | QML intents, adapter, packaged release, foreground entry | **READY for closeout with residuals R1–R4.** |

The authority review also recorded that the composed adoption test uses an in-memory `ComposedPort` that collects objects and calls handlers directly, so the required `actual QML intent → real adapter → one runner → disposable SQLite → framed fake host using the real bridge logic → authoritative projection` chain is not complete, and that the delivery spy declared at `test/phase-2-authority.test.ts:113–114` is never wired into a delivery path, making its `deliveryAttempts === 0` assertions vacuous. Zero-dispatch rests on the boundary audits and the adapter's refusal of `start_assignment`, not on an armed delivery spy in every scenario. Residuals: R1 a standalone submodule at its own root still registers (part of open F9); R2 `authorize_adoption` is modal-free; R3 three LOW corrections are unpinned; R4 the runner host performs no presentation-contract negotiation on open. The full disposition is in [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md) sections 1–2.

**Limitations and corrections.**

1. Offscreen Qt substitutes host, theme and decorative ports. It is render and intent-capture evidence, not a native compositor checkpoint.
2. The Phase 2 gate exits non-zero with `QML offscreen render: UNAVAILABLE` when `qmltestrunner` is absent, and it passes the resolved binary to the render test through `QT_BIN`. A substituted non-Qt binary fails the gate (verified: `QMLTESTRUNNER_BIN=/bin/false` exits `1`). An unavailable or fake render is never reported as PASS.
3. `backup` reports `restoreSupported: false` and `migrationsSupported: false`. Restore is not implemented and is not imitated.
4. The Pi installation probe reports `available`/`absent`/`incompatible` from a read-only check of a supplied extension root. It does not install, configure or launch anything, and the management APIs an installed Pi extension exposes remain an open question carried into Phase 3.
5. The runner keeps one authoritative in-process connection. A QML resnapshot round-trip the Phase 1 shell lacks remains an open question for the native host.
6. The human-only management walkthrough in [the Phase 2 walkthrough](local-workbench-v1-phase-2-walkthrough.md) was **not performed**. It requires separate authorization and is the remaining Phase 2 operator checkpoint. The independent final authority verdict states the workbench is not ready for it; its precondition is closure or explicit operator acceptance of the open Phase 2 requirements.
