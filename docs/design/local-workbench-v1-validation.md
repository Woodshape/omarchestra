# Local Workbench v1 Phase 0/1 validation ledger

**Independent findings corrected; native UX acceptance pending.** The [independent red findings](../reviews/local-workbench-ux-redesign-validation.md) are closed by the [correction slice](../reviews/local-workbench-ux-redesign-corrections.md): actual Create/Save payload composition, same-revision review invalidation, native Project switching, progressive disclosure and advanced configuration drafts. Current gate: 115 Node pass, five deferred runtime TODOs; 16 Qt rows pass; QML lint PASS; affected regressions 163/163 pass. Counts below record the preceding delivery.

Canonical closeout and slot/task provenance: [collaboration result](local-workbench-v1-result.md).

Current status: the 0.6.0 closeout below is superseded by the **task-first redesign** in the [screen and flow design](local-workbench-v1-screens.md) and [contract](local-workbench-v1-contract.md): Companion 0.7.0, nine task-first QML components, one default journey fixture with opt-in developer scenarios, 119 Node tests (114 pass, five deferred runtime TODOs) and twelve passing offscreen Qt rows. The native operator layout checkpoint remains pending. No durable execution claim.

The original integration commands/counts and initial limitations below are historical; current dispositions are recorded under Remaining gaps.

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
| `start_assignment`/`authorize_adoption` are rejected by the adapter before the action allow-list, so they can never be emitted | Intended. Phase 1 renders exact facts and refuses; no runtime port exists. |
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
