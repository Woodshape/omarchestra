# Local Workbench v1: bounded Phase 2 handoff

Status: execution prompt prepared, Phase 2 not started. [Phase 1 presentation engineering](../design/local-workbench-v1-phase-1-closeout.md) is closed with automated/offscreen Qt coverage. Native operator layout acceptance remains pending and must not be inferred from the substitute host tests.

## Entry condition

Consume the [independent correction slice](../reviews/local-workbench-ux-redesign-corrections.md), not the earlier metadata-only check editor: `configure_checks` now carries a closed `definitionDraft`, with runner-owned future resolution/versioning/freezing. Create uses the advertised null target plus selected Project in its payload. Same-revision full replacements invalidate captured reviews. Native UX acceptance remains a prerequisite.

**New prerequisite:** complete the approved [task-first UX redesign](local-workbench-ux-redesign.md) and its operator checkpoint first. The native walkthrough established fixed dock behavior but rejected the creation-flow complexity. Phase 2 must consume the redesigned contextual flows and configured-check selection contract, not wire up the superseded all-controls form. This document is not the prompt for the next Fusion run.

First inspect the worktree and preserve all existing edits. Read the [approved plan](local-workbench-v1.md), its required context, [contracts](../design/local-workbench-v1-contract.md), [transition tables](../design/local-workbench-v1-transitions.md), [screen design](../design/local-workbench-v1-screens.md), and [validation ledger](../design/local-workbench-v1-validation.md).

The bounded Phase 1 schema/form/draft/layout engineering gaps are closed; read the follow-up ledger rather than repeating them. Keep unsupported actions visibly disabled until their complete authoritative ports are available. Full native Phase 1 acceptance still needs the separately authorized consolidated operator layout checkpoint, not live Pi/restart demonstrations. This handoff does not authorize skipping that checkpoint or starting Phase 2 automatically.

## Phase 2 execution prompt

Implement Phase 2 only: durable local Project and Team Goal records, active/recent navigation, and connection of the new presentation package to existing agent-management semantics through **one** runner/store composition.

**A1. Composition and ownership:** select explicit reviewed extraction or reimplementation of necessary prototype management seams. Do not import a removable prototype service as a production dependency or start a second registry/store. Enforce owner-only disposable/test storage, exclusive ownership, schema/migration boundaries, epoch/fence reconstruction, and retained history on clean shutdown.

**A2. Project and Goal flow:** registration must canonicalize the selected local Git context and reject unsupported/mismatched context visibly. Persist confirmed resolved configuration. Prove two sequential Goals on one saved Project without rebuilding/reinstalling or deleting history. Closing the console affects presentation only. Startup errors preserve unknown resources and offer exact recovery, not blanket deletion.

**A3. Management:** wire observation, exact confirmed same-process Adoption, committed delivery then readiness, source-only takeover, retirement, replacement and leaf-only purge. Original and replacement Runs must share dispatch-eligibility, identity resolution, takeover/recovery and projection semantics. Preserve predecessor linkage, binding fences, vacancy-generation high-water marks and uncertain prior effects. Neither Role vacancy nor stop ACK establishes writer safety.

**A4. Acceptance:** compose injected UI → actual presentation adapter → one runner → disposable SQLite → fake framed same-Pi extension. Test invalid context, one successful Adoption, lost commitment/readiness receipt, stale UI revisions, connection gaps, reopen, exact same-surviving-process recovery, replacement takeover/recovery, and late retired/purged frames. Demonstrate retained history across two sequential Goals and console close/reopen. Assert zero Assignment deliveries throughout Phase 2, including after Adoption/replacement/reconnect.

**A5. Boundaries:** Assignment start/delivery, executable validators, correction loops and full intervention reconciliation belong to Phase 3/4. Do not wire them in this phase. Board stays visibly unavailable. Do not add isolation, swarms, arbitrary DAGs, Fusion runtime authority, remote execution, transcript collection or a Reviewer veto.

Run the foreground desktop/provider-free phase gate and affected regression suites with explicit scratch roots and no dotenv/user-state access. Report exact commands/counts and separate implemented from proposed gates. Preserve historical Companion bytes, the additive boundary of the active release 0.7.0, and the retained 0.6.0 bytes kept outside the active catalogue for restoration and regression tests. Any later setup/update remains an exact separately authorized operation.

Do not install/update configuration, launch live Pi/desktop/services, mutate real Projects, commit or push. Finish with shipped files/contracts, technical decisions, actual UI behavior, exact tests, remaining gaps, and a bounded Phase 3 prompt. Ask the user only for genuine scope or observable-policy changes.
