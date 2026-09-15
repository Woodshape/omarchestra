# Local Workbench v1 collaboration result

Current status: Phase 0 contracts and Phase 1 presentation engineering are delivered. The **task-first redesign (Companion 0.7.0)** is implemented: nine task-first QML components, one labelled default journey fixture with opt-in developer scenarios, Project-scoped configured-check selection, and exact-fact Adoption/Start reviews. `just --no-dotenv local-workbench-v1-check` reports 119 Node tests (114 pass, five deferred runtime TODOs) and twelve passing offscreen Qt rows. The consolidated native operator layout checkpoint remains pending; Phase 2 had not started at the time of this record. No durable execution claim.

Subsequent [independent validation](../reviews/local-workbench-ux-redesign-validation.md) rejected several gaps. The [correction slice](../reviews/local-workbench-ux-redesign-corrections.md) closes them with 115 Node pass/five runtime TODOs, 16 Qt rows and 163 affected regression tests passing. The loaded presentation contract is now `task-first-v2`; native UX acceptance remains pending. The Fusion DAG itself failed at 2.a; later reports were produced in-session, not independent delegated final reviews.

The provenance and original validation below record the earlier Fusion delivery, not the latest test counts.

**Phase 2 is incomplete. Its gate exits 1 (BLOCKED) after passing the implemented subset.** The final sequential fixes, actual validation, unresolved requirements and slot/task provenance are recorded in [the canonical Phase 2 integration result](local-workbench-v1-phase-2-integration-result.md). The human management walkthrough remains blocked and unrun.

## Delivered paths

| Output | Path |
| --- | --- |
| Authority, persistence, protocol, gate, intervention and recovery contracts C1–C13 | [contract](local-workbench-v1-contract.md) |
| Happy/rejection/recovery transitions and failure windows T1–T8 | [transitions](local-workbench-v1-transitions.md) |
| Screen design and state limitations | [screens](local-workbench-v1-screens.md) |
| Exact validation commands, results and evidence limits | [validation ledger](local-workbench-v1-validation.md) |
| Presentation package, injected composition, fixtures, QML, release and tests | `packages/local-workbench-v1/` |
| Automated Phase 0/1 subset | `just --no-dotenv local-workbench-v1-check` |
| Bounded next-phase prompt with entry conditions | [Phase 2 handoff](../plans/local-workbench-v1-phase-2-handoff.md) |

## Slot/task provenance

| Slot / task | Contribution | Canonical disposition |
| --- | --- | --- |
| ASTRA / 1.a | Package boundary, C1–C13, T1–T8, plan links | Preserved and amended during integration |
| FLASH / 1.b | Read-only UI/package design, 0.5.0 reservation and dotenv/lint findings | Incorporated, especially additive 0.6.0 decision |
| LUNA / 1.c | Read-only contract/action/safety matrix and regression map | Used to derive bounded acceptance |
| FLASH / 2.a | Initial schema, projection/adapter, QML, fixtures, package and tests | Preserved and corrected. Its initial completion claim and 0.5.0 choice are superseded |
| LUNA / 2.b | Read-only contract and implementation gap audit, V01–V34 | Integration addressed validator/projection/action/release gaps. Later runtime vectors remain proposed |
| LUNA / 3.a | Failure tests, source/privacy/release audits, isolated gate and initial ledger | Ten failing assertions drove integration. Earlier lint-unavailable report is superseded by discovery of the installed binary |
| ASTRA / 4.a | Integration corrections, 0.6.0 packaging, QML method composition, added fixtures, tests and Phase 2 prompt | Delivered bounded implementation and explicitly retained incomplete screen acceptance |
| ASTRA / final integration | Read all seven reports, inspected shared state, fixed queued-intent revision rebinding, reran final gates and wrote this result | Canonical final evidence below |

Source task reports remain under `/tmp/fusion-harness-PeTNtL/collaborate/reports/`. That path is ephemeral provenance, not runtime input. No concurrent writer or worktree copy was used. The final turn preserved all prior changes and touched only the QML queue fence, its test, and result documentation.

## Technical decisions and behavior

**D1.** `packages/local-workbench-v1/` is a new private production-intended presentation boundary, with no prototype runtime imports and no second runner/store. One future runner remains authority. QML renders projections and emits plain intents.

**D2.** Companion 0.6.0 is additive. The archived 0.5.0 metadata reservation is respected. Historical prototype release bytes/defaults are unchanged. New compatibility target is Omarchy 4.0.3-1 / Quickshell 0.3.1-1, not a live-validation claim.

**D3.** Acceptance is an operator-confirmed executable gate, frozen/versioned per attempt and independent of Role. Dirty baselines require explicit confirmation. Unknown writer effects survive stop ACK, retirement, disconnection and replacement. These are runtime specifications, not fixture-proven enforcement.

**D4.** The shell provides dock/detail navigation, Project/Goal selectors, managed/observed/collapsed-retired sections, action feedback, confirmations, forms, gate/candidate/artifact detail, and visibly disabled Board/runtime actions. Fixture mode stays labeled. Queued clicks are discarded when projection identity, revision or connection changes, so a stale click cannot acquire a newer expected revision. Exact Assignment start and Adoption authorization remain unavailable rather than issuing incomplete authority payloads.

No genuine user-policy blocker prevents the bounded presentation follow-up. No policy approval is inferred for later live actions.

## Final validation

- **V1.** `just --no-dotenv local-workbench-v1-check`: exit 0 on Node v26.8.1, 90 tests total, 85 pass, zero fail, five explicitly proposed runtime TODOs. Includes execution of actual QML root methods in an isolated JS context composed with the adapter.
- **V2.** Static QML lint: exit 0 with warnings. The gate requires `/usr/lib/qt6/bin/qmllint`, resolves the `qs` namespace through disposable system-QML aliases, ignores settings and treats import failures as errors. Warnings are not visual evidence.
- **V3.** The eleven affected prototype regression suites listed verbatim in the validation ledger: 163/163 pass, zero failures/skips/TODOs. This preserves prototype evidence rather than proving production runtime integration.
- **V4.** Shell syntax, document links, `git diff --check`, and `git diff --exit-code -- prototypes/ spikes/`: pass.

Final ephemeral logs: `/tmp/workbench-canonical-gate.log` and `/tmp/workbench-canonical-regression.log`. No provider, desktop, live Pi, user configuration update, real Project mutation, installation, commit or push occurred.

## Remaining work and stop boundary

**R1 — closed in follow-up.** Typed proposal/handoff/stop/start detail views, exact read-only confirmation/diagnostic-consent previews, full gate/context/resource presentation and synchronized target-keyed drafts now have executable coverage. Runtime authority ports remain explicitly unavailable, not simulated.

**R2 — engineering closed; native checkpoint pending.** Real offscreen Qt layout/input tests and source audits now cover narrow/wide components, drafts, palette application, keyboard cancellation/navigation, literal text and the dialog. The native layer-shell host/theme are substituted; actual Omarchy visual acceptance remains one separately authorized checkpoint.

**R3.** Production persistence, writer admission, exact Adoption, dispatch, candidate scanning, validators, retry, cancellation/quiescence and durable recovery remain unimplemented. Existing prototype parity tests and presentation fixtures do not establish those capabilities.

Stop before Phase 2. R1/R2 engineering closure is recorded in the follow-up; retain the native operator checkpoint as unrun. The prepared Phase 2 prompt remains the next bounded implementation handoff for durable Project/Goal records and existing management through one runner/store, with disposable reopen, two sequential Goals, exact Adoption, original/replacement takeover/recovery and identity fencing. Phase 2 must remain zero-dispatch. Do not start unrestricted MVP implementation.
