# Plannotator artifact review through the Message Board

Status: **User-approved future direction; backlogged, not scheduled or implemented.**

## Intent and decision

Use Plannotator as an optional external artifact-review surface. Record its feedback and human judgment in an artifact-linked Message Board thread instead of letting it directly drive an agent. The user explicitly endorsed this boundary and deferring integration until durable artifact/Assignment identity exists.

This does not add a prerequisite to the current Local Workbench milestone. The [MVP design](../design/mvp.md) and [agent coordination direction](../design/agent-coordination.md) retain authority. Human review does not replace the configured executable acceptance gate, create a mandatory Reviewer veto, or authorize execution.

Plannotator may separately be used as a development tool to review Omarchestra plans and code. That use is not product integration evidence; HTML mockups do not replace native QML testing.

## Proposed user journey

1. From an Assignment's artifacts, choose **Review in Plannotator** for an exact revision.
2. The Team Runner validates the target and opens an external browser review through a bounded adapter. QML emits an intent; it never launches a process itself.
3. The operator annotates the document, approves it with optional notes, or dismisses review.
4. The runner records the outcome and feedback in a linked thread under the existing Project → Message Board → Channel → Thread → Message hierarchy.
5. The workbench shows the reviewed artifact revision, outcome, feedback summary and link to the thread.
6. Relevant managed agents receive bounded notifications through permitted Board delivery boundaries. Feedback can inform an existing authorized Assignment; any new Assignment or change in authority requires the runner's normal admission path.

**Approval is a recorded human judgment, not “start executing.”** Feedback stays useful when the original agent is busy, disconnected or retired because it belongs to the artifact and thread, not whichever Pi happens to be active.

## Ownership and invariants

- The runner/store owns review correlation, durable outcomes, artifact identity and Board publication. Plannotator's archive/status data is not a second orchestration store.
- Bind a review to an Omarchestra-owned request ID, Project, artifact ID and immutable revision/content digest; include Team Goal and Assignment linkage when applicable. An upstream review ID is only a foreign reference.
- Record the reviewed revision, not just a mutable path. Changed content makes feedback historical; it must not silently approve a newer candidate.
- Distinguish pending, approved, annotated, dismissed, failed and interrupted outcomes. Approval may include non-blocking notes. A closed tab, process exit, missing output or adapter error is never inferred approval.
- Distinguish feedback recorded, notified, read and addressed. Sending a notification proves neither reading nor remediation.
- Deduplicate completion callbacks and Board messages. Reconnect, duplicate output, plugin reload and late feedback must not duplicate delivery or retarget an agent.
- No fallback to the currently active Pi session. Delivery to an exact Run remains subject to its current identity, management, retirement and takeover constraints. Busy feedback queues; automatic delivery pauses during manual takeover. Unmanaged Pi is not interrupted.
- Review text is user/agent content, not instructions that override writer admission, gate definitions or runner policy. Observation remains content-free: integration reviews explicitly selected artifacts, never scrapes terminal output or discovers conversations.

These are design requirements, not finalized protocol field names or implementation guarantees.

## Integration approach

### First candidate: explicit Markdown artifact review

Prefer a separately installed, version-pinned CLI behind an injected runner port. Use a documented structured-output mode, validate command-specific outcomes, and keep browser-server lifetime separate from the workbench projection lifetime. Treat any strict CLI approval flags as human-review outcome reporting, not Omarchestra task acceptance.

The adapter must review a stable snapshot and preserve its exact association through completion. A source file path alone does not establish this. Use bounded, explicit content selection and owner-only storage; decide retention and cleanup without deleting source artifacts or other reviews.

### Later candidate: Pi extension event interface

Upstream exposes asynchronous plan review with `reviewId`, `plannotator:review-result` and `review-status`. It also offers `executionMode: "external"` and `plannotator:plan-approved` handoffs.

Evaluate these only if they improve the approved user journey. External mode avoids the default approval-to-execution loop, but does not supply Omarchestra identity, authorization or durable Board semantics. Neither event receipt nor approval may trigger dispatch directly. Avoid importing upstream browser/server internals into the production package.

### Code review follows separately

The upstream review server supports staging/unstaging; a browser labeled “review” is not a proven read-only surface. Before using it with a managed checkout, establish a restricted adapter path or disposable candidate snapshot and verify that the reviewed diff cannot silently switch scope. No direct index/worktree mutation outside writer admission.

## Privacy and capability limits

- No automatic global installation, hooks, plan-mode configuration or shell changes. Setup remains separately authorized.
- Limit the initial integration to review/annotation. Do not adopt Plannotator's execution loop, checklist scheduler, AI review agents or embedded agent-terminal runtime.
- Audit network behaviour for the pinned release. Local-first is not network-free: release checks, optional AI, sharing and URL fetching have distinct boundaries. Disabling AI alone is not proof that every execution capability is disabled.
- Begin with explicit local Markdown artifacts. Remote transport, PR retrieval, URL/live-app annotation and hosted sharing are outside the first slice and need their own contract review.
- Review content is deliberately richer than observer telemetry. Specify content-size limits, secret handling, data ownership, storage permissions, retention and deletion before implementation. Do not export full Projects or Pi conversation history by default.

## Delivery sequence and readiness

1. **Development use now:** manually review selected design documents/diffs; no production dependency.
2. **Prerequisites:** durable Project/Assignment/artifact revision identity and Board storage, permissions, ordered publication and notification/delivery semantics.
3. **Bounded feasibility work:** pin an upstream release; prove Markdown outcome parsing, immutable input association, capability restrictions, cancellation and cleanup using disposable data. Follow [the spike guide](../../spikes/README.md) before starting.
4. **First integration slice:** review intent → injected adapter → durable outcome → one linked Board message → permitted notification. No automatic execution.
5. **Separate extensions:** code-diff review after mutation/snapshot closure; Pi event integration only if justified by evidence.

## Acceptance requirements for the first slice

- An exact artifact revision opens and its returned outcome becomes one linked Board message.
- Annotated, approved-with-notes, dismissed and adapter-failed cases remain distinguishable; malformed or contradictory output fails closed.
- A changed artifact cannot inherit approval; duplicate and delayed responses cannot publish or deliver twice.
- Busy, manual-takeover, disconnected and retired targets never cause fallback delivery to another session.
- Approval, dismissal, annotations and notifications dispatch no Assignment, acquire no writer permission and mark no executable gate passed.
- Tests use injected ports and disposable storage; no live agent, installed plugin, global configuration or actual checkout mutation.
- Separately authorized human review proves browser opening, feedback return and native workbench/Board presentation. Automated tests alone do not establish usability or live integration.

## Research basis and limits

Read-only source review of upstream revision `0f2bd6051c66d26f2d776a2a521d856627b3316c`:

- [Repository README](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/README.md): workflows, privacy and optional features.
- [Pi integration README](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/apps/pi-extension/README.md) and [event definitions](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/apps/pi-extension/plannotator-events.ts): external handoff and asynchronous review contracts.
- [Current-session fallback](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/apps/pi-extension/current-pi-session.ts): behaviour that must not be inherited for exact-Run delivery.
- [Review server](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/packages/server/review.ts): staging/unstaging paths.
- [Annotate completion](https://github.com/backnotprop/plannotator/blob/0f2bd6051c66d26f2d776a2a521d856627b3316c/apps/hook/server/annotate-command.ts): command-specific decision output and error handling.

This was not a security audit, dependency compatibility test or executed integration. Revalidate release-specific APIs and restrictions before implementation.
