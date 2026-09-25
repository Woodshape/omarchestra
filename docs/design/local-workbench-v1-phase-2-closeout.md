# Local Workbench v1 — Phase 2 engineering closeout

**Prior task 6.a record. Superseded by the [canonical final integration result](local-workbench-v1-phase-2-integration-result.md).** The final Phase 2 gate exits 1 (BLOCKED), not PASS. Final integration fixed individual backup-collision, submodule/storage-overlap and takeover-disconnection paths. Other findings remain open. Counts and dispositions below describe the state before those changes.

Status: **Phase 2 engineering closeout is FAIL on the authority scope and NOT READY for operator acceptance.** The independent UI/adapter and foreground-entry verification, performed read-only, returned READY with recorded residuals. The separately authorized human management walkthrough has not been performed and is not authorized by this document.

This is the final Phase 2 closeout. It records what is implemented and verified, what the independent verdicts say, which requirements remain open, the exact foreground commands, and the bounded Phase 3 entry condition. It does not claim complete engineering readiness: the independent final authority verdict returned FAIL and returned its unresolved items to Phase 2 rather than accepting them as Phase 3 obligations.

Evidence rule for this document: every count below was produced by a command run foreground in this session with disposable state, and every source statement was verified by reading the file named. No command installed anything, launched Pi, opened a desktop, mutated a real Project, or wrote outside the repository and a temp directory.

## 1. Independent verdicts

| Review | Scope | Verdict | Source |
| --- | --- | --- | --- |
| Final authority review (ASTRA, 5.a) | Exact identity, persistence, ownership, recovery, fencing, bounds | **FAIL.** None of F1–F12 is fully closed against its original scope; the workbench is not ready for the separately authorized human walkthrough. | `5.a-astra.md` |
| Final UI/adapter verification (GLM-FLASH, 5.b) | QML intents, presentation adapter, packaged release, foreground entry | **READY for closeout with residuals R1–R4.** | `5.b-glm-flash.md` |
| Correction pass (deepseek-flash, 4.a) | Applied the findings of the two first reviews | Self-reported. Both verifiers inspected its output and its tests; neither reran its commands. | `4.a-deepseek-flash.md` |

Both verifiers executed no commands, so their verdicts rest on source and test inspection. The numbers in this document rest on commands this slot ran.

## 2. Open Phase 2 requirements

The independent authority review returned these to Phase 2. They are not accepted deferrals and they are not Phase 3 work. Disposition per finding, with the exact remaining gap:

| Finding | Priority | Status | Remaining gap |
| --- | --- | --- | --- |
| F1 — exact Pi identity and challenged connection | P0 | Unresolved | `runner/transport.ts` has no exact process/session/extension identity or challenged-connection validation, and no real Pi extension exists in the package. |
| F2 — late frames after a fence | P0 | Partial | `assertLive()` rejects fenced Run IDs before ACK/readiness/takeover mutations, but fences identify Run IDs, not Pi incarnations, so the same incarnation re-observed under another ID is unfenced. |
| F3 — takeover, disconnect and occupancy | P0 | Partial | Per-Run control epochs and `manual_takeover` persist and disconnected occupants block a new commitment, but retirement is still permitted directly from connected manual takeover, and bindings carry no Goal identity. Abandoned proposals also count as occupancy, so a failed competing ACK can present as a managed occupant. |
| F4 — acknowledgement and generation timing | P0 | Partial | The five-second ACK deadline, duplicate suppression, pending-clear and commit-time generation check exist, but exact connection/activity checks and confirmation-digest validation are absent, ACK handling does not recheck proposal expiry, and `sweepExpired()` leaves the durable binding `authorized`. |
| F5 — restart honesty | P0 | Partial | Recovery converts `acknowledged`/`committed`/`ready` to `disconnected` and preserves writer uncertainty, but `manual_takeover` rows are excluded from the connection reset and are still projected connected; challenged surviving-extension recovery and offline takeover reconciliation are unimplemented; the `recover` intent is acknowledged without performing recovery. |
| F6 — resource and manifest ownership | P0 | Unresolved | Ownership is filename-based. A missing `owner.sqlite` is still recreated rather than refused, and exact file/parent identity, in-place replacement detection and fence-ledger ownership are absent. |
| F7 — one transaction for effects and dedup | P1 | Unresolved | Effects commit before dedup outcomes are written; retirement and purge bypass the authority event/revision commit; the in-memory revision advances before `COMMIT` succeeds; runner-side generation validation is missing. |
| F8 — minimal retained fences after purge | P1 | Partial | Successor-first ordering, purged-card removal and ledger `purgedAt` recovery exist, but purge retains the full binding/history rather than only minimal fences, and the database state and ledger purge marker are still separate writes without interruption coverage. |
| F9 — Git and storage identity | P1 | Partial | Disposable linked-worktree refusal and Project-versus-Project overlap refusal are tested, but the check does not cover a state root inside a Project, a standalone submodule at its own root, or a replacement repository at an identical path. Git still inherits the ambient environment and permits optional index writes. |
| F10 — check resource resolution and hashing | P1 | Unresolved | `normalizeCheckFields()` still accepts draft definitions without canonical executable/resource resolution or content hashing. Saving JSON with a digest does not satisfy C14. |
| F11 — safe backup | P1 | Unresolved | Rotation removes an existing timestamp-named backup when `VACUUM INTO` fails on a collision, rotation is filename-authorized, and verification lacks a real backup SQLite integrity check. |
| F12 — bounds and persisted schema | P1 | Unresolved | Projection collections still truncate silently, pending collections are unbounded, schema validation inspects required column names instead of complete constraints, persisted counters lack safe-integer validation, and transport payload validation is open-ended. |

Residuals from the UI/adapter verification, carried into the closeout:

| Residual | Disposition in this closeout |
| --- | --- |
| R1 (LOW–MED) — a standalone submodule at its own root still registers. `rev-parse --git-dir` and `--git-common-dir` resolve to the same module directory and the toplevel equals the selected path, so the `nested` and `sharedGitDir` checks both stay false. `nested_worktree_or_submodule` fires only when a subdirectory of a repository is selected. | **Recorded, not fixed.** It is part of open finding F9, which the authority verdict returns to Phase 2; this closeout does not assign it to Phase 3 and does not claim it closed. Registration grants no execution authority, so it does not block the engineering closeout. The walkthrough must not treat submodule registration as verified. |
| R2 (LOW) — `authorize_adoption` is modal-free while `request_adoption` uses the confirmation dialog. | Accepted as recorded in D13 item 6. The adoption-review path shows the exact proposal facts and the runner bounds the blast radius. A single-click card authorization is weaker ceremony than C4's dialog pattern; if the operator checkpoint reports misclick risk, the bounded remedy is routing card choices through adoption review. |
| R3 (LOW) — three LOW corrections (uniform `checkSummary` reason, `contextMatch: false`, rendered rejection `Reason:`) have no dedicated test pinning them. | **Wording corrected in the ledger.** The claim that each correction has a regression test holds for the others and not for these three. No test was added in this closeout. |
| R4 (observation) — the runner host performs no presentation-contract negotiation on open; the constants are consistent at 0.8.0 and the native-host negotiation question remains open. | Carried as a Phase 3 presentation seam (Q3 in the handoff). |

The authority review also recorded that the composed adoption test uses `ComposedPort`, whose `send()` collects objects and whose `emit()` calls handlers directly, so the required chain `actual QML intent → real adapter → one runner → disposable SQLite → framed fake host using the real bridge logic → authoritative projection` is not yet complete: the fake host does not execute real extension bridge logic, and the delivery spy declared at `test/phase-2-authority.test.ts:113–114` is never wired into a delivery path, so its `deliveryAttempts === 0` assertions (lines 234 and 252) are vacuous. Zero-dispatch is established by the Phase 1 boundary audits (no delivery or executor module exists in `runner/`), by the source audit that enforces those tokens, and by the adapter's refusal of `start_assignment`. It is not established by an armed delivery spy in every scenario, and the gate prints the invariant rather than measuring a counter.

## 3. Working versus disabled functionality

Working through the real runner, real adapter and real QML with recorded evidence:

1. Register and confirm a real local Git Project by inspect-then-confirm, with runner-computed refusal reasons.
2. Durable Team Goals through `create_goal` and `select_goal`.
3. Durable Project-scoped checks with versioned reconfiguration, stale-edit refusal, and a new-check editor that cannot submit until the fields validate.
4. Observe, propose, authorize, acknowledge, commit and confirm readiness for one visible Pi over an injected observer transport, with the frozen proposal digest and the five-second ACK deadline.
5. Takeover marker (`manual_takeover` plus control epoch), retirement, replacement with predecessor and generation, and leaf-only purge over the retained fence ledger.
6. Reopen and clean restart through one foreground process and one SQLite store, with readiness downgraded honestly after restart.
7. Receipts ordered so the committed outcome is the last feedback the view sees, and rejection reasons rendered with `Reason: <reasonCode>`.
8. `start`/`status`/`backup`/`inspect` foreground entry with every root explicit, no daemon and no socket.

Disabled and never faked:

1. Assignment delivery and acceptance-check execution. `start_assignment` is refused with `phase_3_unavailable` by both the adapter and the runner, and no delivery port, validator executor or network import exists in `runner/`.
2. Restore and migration. `backup` reports `restoreSupported: false` and `migrationsSupported: false` rather than imitating either.
3. A live observer transport. Phase 2 injects the transport; the observed-Pi list is empty without one, which is the honest state.
4. The QML window itself. No Phase 2 command launches the desktop host; the QML is exercised offscreen against the real adapter and runner by the gate.

## 4. Reproducible foreground commands

Every command is foreground, takes explicit roots, and needs no network, provider, desktop or installed Pi. `--state-dir` must be inside a disposable or operator-owned directory.

Start the durable runner and open the presentation session:

```bash
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts \
  start --state-dir <state-dir> [--runtime-dir <runtime-dir>] [--extension-root <extension-root>] [--session <id>]
```

The process writes one JSON record per line on stdout: `ready` (session, state dir, runner epoch, installation state), then `open` (the session envelope carrying the first authoritative projection), then one `projection` or `feedback` record per event, then `closed`. Each stdin line is one presentation intent in the adapter's request shape (`{"kind":...,"target":...,"payload":{...}}`). The foreground entry point has no QML window. Its `open` record is stdio output, not native presentation. EOF on stdin (`Ctrl-D`) stops the runner and releases its owner lock while retaining SQLite history. It is not presentation-only hide. Native open/hide remains unimplemented. Stopping the process ends the session; the next `start` on the same state dir reports the loss of connectivity truthfully instead of optimistic readiness.

One-shot commands (status/backup acquire ownership and advance the runner epoch, so they are not read-only checks of an active runner):

```bash
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts status --state-dir <state-dir>
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts backup --state-dir <state-dir>
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts inspect --path <worktree>
```

Gates, all foreground with disposable roots:

```bash
just --no-dotenv local-workbench-v1-phase-2-check
just --no-dotenv local-workbench-v1-foundation-check
just --no-dotenv local-workbench-v1-check
```

The `--no-dotenv` flag is required because the root `justfile` otherwise loads the external Fusion dotenv before any recipe runs.

## 5. Human management walkthrough

The walkthrough is [the Phase 2 human management walkthrough](local-workbench-v1-phase-2-walkthrough.md). It is **not performed and not authorized** by Phase 2 or by this closeout, and it is **zero-dispatch**: it may not deliver an Assignment or execute an acceptance check at any point. It requires its own recorded authorization because it is the only step that touches a real Project and a real Pi.

The independent authority verdict states explicitly that the workbench is not ready for it. The precondition to authorize it is closure or explicit operator acceptance of the open Phase 2 requirements in section 2, at minimum the P0 items. It also inherits residual R1: registration expectations in the walkthrough must not assume submodule refusal.

## 6. Evidence and limitations

Commands run foreground in this session, each bounded to 60 seconds, with disposable state:

```text
just --no-dotenv local-workbench-v1-phase-2-check   -> PASS (zero deliveries, zero check executions)
  durable runner foundation (P2.1)                   16 tests / 16 pass / 0 fail
  runnable management and adoption journey            7 tests /  7 pass / 0 fail
  actual presentation adapter composition            77 tests / 72 pass / 0 fail / 5 todo
  Phase 1 boundary audits                            38 tests / 38 pass / 0 fail
  offscreen QML render and intent capture            18 rows / 0 failed / 0 skipped / no QML warning
just --no-dotenv local-workbench-v1-foundation-check -> PASS
just --no-dotenv local-workbench-v1-check            -> Phase 0/1 gate PASS
test/*.test.ts + test/*.test.mjs                     -> 147 tests / 142 pass / 0 fail / 5 todo
QMLTESTRUNNER_BIN=/bin/false bash scripts/phase-2-gate.sh -> exit 1
git diff --check                                     -> clean
git diff --exit-code -- prototypes/ spikes/          -> clean
```

Limitations that the evidence does not cover:

1. Offscreen Qt substitutes host, theme and decorative ports. It is render and intent-capture evidence, not a native compositor checkpoint.
2. No live Pi, shell or desktop was launched, so no live management API, native resnapshot or real Adoption is proven. `--extension-root` only reads an installation's reported state.
3. The passing tests do not establish the missing contracts that the authority review names. A green gate is an automated subset, not phase completion.
4. The canonical prototype regressions (163 tests) were rerun during the correction pass with `/usr/lib/qt6/bin` on `PATH`; without that directory on `PATH` the `qmllint`-invoking recipes fail with `spawnSync qmllint ENOENT`. That condition predates this delivery.

## 7. Collaboration provenance

| Slot / task | Contribution | Disposition |
| --- | --- | --- |
| ASTRA / 1.b, GLM-FLASH / 1.c | First independent read-only contract and UI reviews | Fed the Phase 2 proposal. |
| deepseek-flash / 1.a, 2.a | Phase 2 proposal, then the P2.1 foundation and the runnable P2.2–P2.5 implementation | Preserved, then corrected. |
| ASTRA / 3.a, GLM-FLASH / 3.b | First independent implementation reviews (authority FAIL with F1–F12; UI HIGH/MED/LOW) | Drove the correction pass. |
| deepseek-flash / 4.a | Correction pass (P0/P1 fixes, retained-release integrity, QML adoption regression, prototype reruns) | Self-reported; both verifiers inspected it. |
| ASTRA / 5.a | Independent final authority verification | **FAIL**; unresolved items returned to Phase 2. |
| GLM-FLASH / 5.b | Independent final UI/adapter verification | READY with residuals R1–R4. |
| deepseek-flash / 6.a | This closeout, ledger and handoff correction | Documentation only; the independent verdicts are recorded unaltered. |

Recorded collaboration failures and limits:

1. No verifier executed a command. Both final verdicts are source-and-test inspections, and the execution counts in this document are this slot's own.
2. Task 4.a's report claimed every listed fix has a regression test. That was overstated for three LOW fixes and is corrected in the ledger (residual R3).
3. The Phase 3 handoff wrongly moved required Phase 2 work into Phase 3. That is corrected in the handoff: the authority findings are Phase 2 requirements returned to Phase 2, and only genuinely new Phase 3 work is handed forward.
4. Host continuation in a later turn is not independent review; nothing in this closeout treats it as such.

## 8. Phase 3 handoff

The bounded Phase 3 entry condition is [the Phase 3 handoff](../plans/local-workbench-v1-phase-3-handoff.md), which states the open Phase 2 requirements, the Phase 3 scope for one gated Assignment, and the Phase 4 intervention prerequisites that must be decided before any live dispatch.

At this historical closeout, the 0.6.0 and 0.7.0 release copies remained outside the active catalogue. The later operator-approved source-history policy in [ADR 0006](../adr/0006-use-git-history-for-companion-release-source.md) removed those copies from the current tree; Git history preserves the prior files.
