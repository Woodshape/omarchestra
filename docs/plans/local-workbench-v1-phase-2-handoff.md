# Local Workbench v1 — Phase 2 execution plan

Status: **Partially implemented; full Phase 2 gate BLOCKED.**

The [canonical integration result](../design/local-workbench-v1-phase-2-integration-result.md) supersedes the earlier subset-green closeout. [Independent verification](../reviews/local-workbench-phase-2-verification/README.md) reproduced current defects and confirmed the blocked verdict. Execute the [sequential completion plan](local-workbench-v1-phase-2-completion.md), one bounded slice at a time. Human management acceptance remains blocked. The original scope/entry plan is preserved below; do not rerun it as one giant writer task.

## Entry decision

The task-first redesign and all-pages visual pass are implemented. The operator reported “ok working now”, authorized their commit (`744598f`), and subsequently explicitly confirmed proceeding to durable functionality. This is sufficient to enter Phase 2; do not reopen the redesign or demand another preliminary preview ceremony. It is not a formal exhaustive layout-checklist PASS or evidence of live runtime execution.

Consume the [independent corrections](../reviews/local-workbench-ux-redesign-corrections.md) and [all-pages visual pass](../reviews/local-workbench-all-pages-visual-pass.md). Preserve the current UI, shared controls, target-keyed drafts, exact adapter validation and conservative review invalidation. The preview is still a fixture surface, not the Phase 2 runtime.

## User-visible milestone

**“I can register my local Project, create a persistent Team Goal, adopt my visible Pi, and reopen the workbench without losing history.”**

Ship the engineering needed for that journey, not another scaffold or fixture-only demonstration. Automated acceptance uses fake Pi and disposable resources. Actual installation and human live use are separate, explicit operations after engineering closeout.

## Required context

Read completely before implementation:

- [MVP design](../design/mvp.md), [coordination direction](../design/agent-coordination.md), [domain language](../../CONTEXT.md) and [Pi terminal behavior](../design/pi-terminal-behavior.md).
- [Local Workbench plan](local-workbench-v1.md), [C1–C14 contracts and detail schema](../design/local-workbench-v1-contract.md), [transitions](../design/local-workbench-v1-transitions.md), [screens](../design/local-workbench-v1-screens.md) and [validation ledger](../design/local-workbench-v1-validation.md).
- The correction and visual-pass closeouts linked above. Earlier pending-redesign/native-entry statements describe historical checkpoints; this entry decision supersedes them for Phase 2 only.
- ADRs [0001](../adr/0001-install-a-persistent-omarchy-companion-plugin.md), [0002](../adr/0002-observe-ordinary-pi-before-explicit-adoption.md), [0003](../adr/0003-use-connection-bound-observer-capabilities.md), [0004](../adr/0004-explicit-purge-of-terminal-retired-history.md), and [retirement/replacement](explicit-retirement-replacement.md).
- [Observer/Adoption plan](observer-adoption-implementation.md), prototype [live Adoption handoff](../../prototypes/first-vertical-slice/docs/live-adoption-engineering-handoff.md) and its linked authority/transport/ownership evidence. Preserve accepted R1; do not claim complete lifecycle classification.
- Installed Pi extension documentation and linked relevant APIs before implementing the new bridge. Treat previous Pi-version evidence as a baseline, not current-version certification. Read the foundation assessment before relying on terminal/runtime claims; follow the spike guide if a genuinely unresolved contract needs a bounded experiment.

## Implementation boundaries

- Production-intended code belongs under `packages/local-workbench-v1/`. No runtime imports from `prototypes/` or `spikes/`; those remain evidence. Document reviewed extraction/reimplementation decisions rather than silently promoting old services.
- Exactly one foreground runner owns registry, SQLite, management authority and projection. No second observer daemon/registry, fixture controller as runtime authority, QML scheduler, Fusion runtime dependency or background service installation.
- Preserve prototype artifacts and retained 0.6.0 bytes. Include new presentation assets in active release packaging. Do not silently change compatibility claims; record capability/schema changes and negotiate them fail-closed.
- Minimal UI additions required for registration and real management are in scope. Preserve the approved task-first layout. No broad visual redesign.
- Assignment dispatch, executable checks, correction loops and full Assignment reconciliation are Phase 3/4. Board and Plannotator stay unavailable/backlogged. No remote execution, PTY control, terminal launch, hidden agents, conversation collection, isolation, swarms, arbitrary DAGs or Reviewer veto.

## Work packages and order

### P2.1 — Composition, persistence and ownership

Implement C1/C3 in one runner/store composition: explicit injected roots, owner-only storage, durable local Node identity, ownership manifest, schema version checks, epoch, and exact resource ownership. Use the specified SQLite transaction/journal/durability settings and a lifetime owner lock; database transaction locking alone is insufficient.

Reject a second owner, foreign or symlink-substituted paths, unsupported schemas and drift before accepting management frames. Clean shutdown preserves records. Errors name exact recovery actions, never suggest blanket removal of unknown directories. Implement backup/migration preconditions needed by supported operations; do not invent migration or restore success when unavailable. Purge must not bypass C3's independently retained fencing requirements.

Document module ownership, startup/shutdown order, commit/publication ordering and recovery invariants before connecting UI handlers. Keep the notes bounded; continue into implementation in the same run.

### P2.2 — Real Project, Goal and check configuration flows

- Register an explicitly selected local Git Project under C2. Resolve and confirm canonical top-level context; reject unsupported bare/linked-worktree/submodule or replaced/mismatched context. No-HEAD repositories remain registrable but not execution-ready.
- Add a small registration affordance for the empty Project list. Use explicit inspect/confirm intents and validated resolved facts; QML does not resolve paths or run Git. Add closed schemas and update concrete contracts/tests for missing Phase 1 intents.
- Persist minimal Goal creation (Project + goal text), active/recent navigation and current identity. Creation never adopts or dispatches. Prove two sequential Goals on one registered Project, retaining both.
- Persist operator-configured acceptance checks under C14 through the existing `configure_checks.definitionDraft` flow. Runner owns canonical resolution, resource validation, hashes and versions; never execute the check while saving. Definition edits cannot accept caller-authored hashes or authority. Start review/execution remains unavailable. If a concrete C14 creation intent is missing, add and test it explicitly rather than leaving only fixture checks selectable.
- Project/Goal/check navigation and drafts survive ordinary snapshot updates and presentation close/reopen according to the existing contract. Durable records do not depend on QML lifetime.

### P2.3 — Observation and exact live-management adapters

Implement the content-free observer and management bridge/transport seams for the visible Pi host, with injected host and transport ports. They must be usable by an explicitly authorized later live run; a fake-only replacement API is not completion. Do not install or launch them during engineering.

Wire observation, explicit Adoption proposal/review/confirmation, same-process/current-connection acknowledgement, durable binding commit, committed binding delivery, then readiness. Discovery and transport connectivity alone grant no authority.

Implement source-only takeover, same-surviving-extension recovery, retirement, replacement and leaf-only purge through the same logical Run interface. Original and replacement Runs must use identical identity resolution, readiness, takeover, projection and recovery paths. Preserve predecessor linkage, exact binding fences, vacancy-generation high-water marks and uncertain effects. Role vacancy and stop ACK never establish writer safety.

Late, duplicate, stale, disconnected, busy, wrong-Node, role-conflicting and retired/purged messages fail closed. Do not re-register retained replacements as Unassigned. Retain the accepted best-effort R1 idle guards without inspecting content.

### P2.4 — Native presentation composition and normal foreground entry

Connect the actual presentation adapter and current QML to the runner's authoritative projections and acknowledged intents. Show real reasons and receipts rather than optimistic success. Remove fixture labels only on the real runtime path; keep the separate fixture preview clearly labeled.

Provide a documented package-level foreground start/open/hide path matching C1, with explicit test roots and injected desktop ports. Start/open never installs the Companion, changes global Pi configuration, launches Pi or reloads the shell. Missing/stale/incompatible installation is an actionable error. Hide/close changes only presentation; stopping the runner preserves history and reports loss of connectivity truthfully.

A full distribution installer/service and first real task remain Phase 5, but this slice must expose a runnable composition rather than requiring a future agent to invent the launcher. Add a human-only management walkthrough for later consent. It must never dispatch Assignments.

### P2.5 — Composed acceptance and closeout

Add an executable, foreground, desktop/provider-free Phase 2 gate (for example `just --no-dotenv local-workbench-v1-phase-2-check`) and include it in the documentation. Do not merely rename the Phase 1 gate or leave Phase 2 assertions as TODOs.

Required chain:

`actual QML intent → real presentation adapter → one runner → disposable SQLite → framed fake host using the real bridge logic → authoritative projection`

Where native decoration is substituted, state that limit explicitly. Real shell and real Pi are never acceptance dependencies for automation.

Required scenarios:

- Project registration confirmation, invalid/changed Git context, no-HEAD handling, duplicate registration and bounded collection overflow without silent loss.
- Two sequential Goals; durable check create/edit/version validation; wrong-Project and stale configuration rejected; no validator process spawned.
- Observation grants no assignment/management authority; one exact Adoption succeeds with committed delivery before readiness.
- Lost acknowledgement, lost commit/readiness receipt, duplicate messages, stale UI revisions and publication failure cannot create duplicate bindings or optimistic readiness.
- Presentation close/reopen, clean runner restart and same-surviving-extension reconnect reconstruct correct state without installation mutation.
- Replacement follows the same takeover/recovery semantics; late retired/purged frames cannot recover authority, including after restart.
- Second owner, symlink/drift, bad schema and interrupted writes fail safely. Test actual cross-process owner exclusion and lock release using disposable subprocesses, not only mocked booleans.
- Every scenario asserts **zero Assignment deliveries and zero acceptance-check executions**, including after Adoption, replacement, reconnect and check saving.

Run the existing Phase 1 gate plus affected prototype management regressions unchanged. Newly shipped paths must be reachable through concrete UI intents/entry points, not only direct calls to store methods.

## Fusion coordination and restrictions

Use one implementation writer. Other agents may inspect/review read-only: one should review authority/persistence/recovery, another should review actual UI/adapter composition and user-visible journey. Sequence writing; do not allow multiple agents to mutate the shared checkout concurrently. Review concrete implementation and acceptance evidence, not only the plan.

Inspect and preserve pre-existing changes. Do not install packages/configuration, launch live Pi/desktop/services, mutate real Projects, inspect private session evidence, commit or push. Disposable Git repositories and bounded non-agent subprocesses for filesystem/Git/SQLite acceptance are allowed. No dotenv, provider credentials or user-state access in test recipes.

If a collaboration child/provider fails, report the failure and distinguish any host continuation from independently executed reviews. Do not claim team PASS from in-session role-labelled reports. If a genuine product decision blocks a safety contract, document the precise blocker; do not disable guards or claim an incomplete scaffold is ready.

## Required final deliverables

- Implemented files and the one-runner composition/ownership notes.
- Updated concrete schemas, affected design/validation documents and executable Phase 2 gate.
- User-visible working versus still-disabled actions; reproducible normal start/open and separately authorized human management walkthrough.
- Exact test commands/results, failures and evidence limits; no inferred live acceptance from fake tests.
- A bounded Phase 3 handoff for one real gated Assignment, identifying any Phase 4 intervention prerequisites before live dispatch.

Completion means the composed engineering acceptance passes and the management journey is ready for a separately authorized human check—not that real execution or the Message Board has shipped.
