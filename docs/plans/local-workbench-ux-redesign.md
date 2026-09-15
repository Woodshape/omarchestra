# Local Workbench — task-first UX redesign

Status: **Engineering implemented (Companion 0.7.0), followed by the accepted all-pages visual iteration. The operator reported “ok working now” and explicitly authorized Phase 2 engineering. The [Phase 2 execution plan](local-workbench-v1-phase-2-handoff.md) supersedes the pending entry prerequisite; no exhaustive checklist or runtime PASS is inferred.**

The initial delivery required [independent corrections](../reviews/local-workbench-ux-redesign-corrections.md), now implemented in `packages/local-workbench-v1/` and `manual/`: Create contract, review invalidation, Project transport, progressive disclosure and advanced configuration drafts. Current evidence: 120 Node tests
(115 pass, five deferred runtime TODOs) and sixteen passing offscreen Qt rows via
`just --no-dotenv local-workbench-v1-check`. No installation, shell restart,
live Pi, real dispatch, commit or push occurred. Those evidence limits describe the original correction slice. Subsequent native feedback and visual changes are recorded in the [all-pages closeout](../reviews/local-workbench-all-pages-visual-pass.md); another redesign walkthrough is not a Phase 2 entry blocker.

## Why this task exists

The operator confirmed that the fixed-width dock works after restarting the
shell, but found the UI only "okay-ish" and New Team Goal almost unusable:
too many controls, settings and technical details. This is not full native UX
acceptance. Automated presentation tests did not establish usability.

The user approved a task-first redesign after a Boomux UI/UX review. This task
supersedes the original Phase 1 form/navigation arrangement, not its authority,
privacy, execution or persistence contracts. It is a bounded Phase 1b before
Phase 2 integration—not authorization to build the rest of the workbench.

Outcome: a calm fixed-width companion where the normal journey is obvious:
**select Project → create Team Goal → add agent → prepare Assignment → review
start → follow work/result**. Creation is not dispatch. All execution remains
unavailable in this presentation slice.

## Authority and context

Read completely before implementation:

- `AGENTS.md`, `CONTEXT.md`, `docs/design/mvp.md` and its coordination amendment
  `docs/design/agent-coordination.md`.
- `docs/plans/local-workbench-v1.md`.
- `docs/design/local-workbench-v1-{contract,transitions,screens}.md`.
- `docs/design/local-workbench-v1-{result,validation,phase-1-closeout,human-layout}.md`.
- `docs/plans/local-workbench-v1-phase-2-handoff.md`.

Read the terminal behavior design and relevant ADRs if changing how Adoption,
retirement, takeover or recovery are presented. Read Omarchy skill/plugin docs
before changing native host/setup behavior. This task requires no Pi API changes.
Do not import prototype/spike runtime into `packages/local-workbench-v1/`.

## Reference, not a replacement architecture

Reviewed Boomux desktop source revision:
`99f7ff9e81e235eec884bd0a874c79261e38ef89`.

- [Project menu and sidebar source](https://github.com/gardnmi/boomux/blob/99f7ff9e81e235eec884bd0a874c79261e38ef89/desktop/src/main.rs):
  `project_menu`, `sidebar`, `sidebar_agent`.
- [Desktop guide](https://github.com/gardnmi/boomux/blob/99f7ff9e81e235eec884bd0a874c79261e38ef89/desktop/README.md).
- [Omarchy companion](https://github.com/gardnmi/omarchy-boomux): form-free local
  creation, contextual menus, compact navigation and separate settings.

Borrow hierarchy, context reuse, compact rows, primary actions, and progressive
disclosure. Do not copy terminal embedding, automatic process start/restart,
attachment takeover, process termination, or automatic integration installation.
The earlier foundation assessment describes an older Boomux revision; it is not
a description of today's Desktop. This review was source/documentation based,
not a hands-on usability evaluation of Boomux.

## Approved interaction direction

### Fixed shell and clear navigation

- Preserve the fixed dock width; navigation, forms, history and dialogs must
  never resize compositor reservations. Fullscreen/resizable app mode is deferred.
- Persistent compact Project selector, current Goal context and connection state.
- One main content destination at a time. Details replace the relevant content,
  with a clear Back path; do not append every detail beneath the overview.
- Keep a recognizable Goal list and agent overview. Normal navigation should
  not require reading internal IDs or understanding runner terminology.
- Keep Board reserved and visibly disabled, with a short reason. No fake backend.
- Common tasks are discoverable without opening a menu. Secondary maintenance
  belongs in a keyboard-accessible `⋮` menu, not a full-width button per operation.

### New Team Goal: only create a Goal

```text
New Team Goal
Project: omarchestra                         Change

What should the team accomplish?
[ multiline goal text                           ]

                               Cancel   Create
```

Project defaults to the explicitly selected Project; Change opens the Project
selector. Do not infer Project authority from Pi cwd. Create is enabled only
for valid input and an available authoritative action. In fixture preview it
must remain visibly preview-only, not imply durable creation.

No Assignment fields, agent selector, gate identity/version, executable/argv,
resource paths, environment, timeout/output limits or correction counters appear
in this form. No automatic Pi launch, Adoption or dispatch follows creation.

### Add agent: a separate contextual flow

From the selected Goal, expose Add agent. List eligible observed sessions with
human-readable labels and available status; select a Role, then review the exact
binding. Unknown/ineligible sessions retain a short explanation.

Use friendly copy while preserving the technical Adoption transition. Never
replace same-process ACK, reconciliation, commit or readiness with optimistic UI.
Replacement must show its predecessor and retain all fences. Confirmation shows
meaningful session/Goal/Role context; exact IDs remain inspectable for ambiguous
cases. Nothing auto-selects and authorizes a different session on refresh.

### Assignment: task, agent, acceptance check

A separate Assignment surface contains natural-language task, target agent and
an explicitly selected configured acceptance check. Inherit Project and Goal
context visibly; use friendly agent names plus Role/status, not raw Run IDs as
choice labels. One primary action advances to an exact start review.

Acceptance-check selection is not "turn off validation". Missing configuration
blocks start with a clear Configure checks path. A Project-level configuration
surface owns reusable check definitions; advanced executable/resource/context
and limit editing belongs there, not in Goal creation.

**This run designs and implements the injected presentation contract for this
selection/configuration only.** Specify identity/version, definition summary,
configuration edit authority, invalidation and empty/error behavior. Use fixture
catalogue data. Do not implement a durable preset service, automatic discovery
of repository scripts, shell-string parsing, a template marketplace, or a second
store. Future runner integration persists/resolves configuration under C7/C8.
A preset reference is never execution authority: the runner must resolve and
freeze the complete definition and resources before start authorization.

### Review, work and results

- Start review shows task, exact agent, Project/location, acceptance-check name
  and command, important limits and dirty-checkout consequences in plain language.
- Technical details remain explicitly inspectable: full argv, environment,
  hashes, baseline and resolved resource identity. Disclosure cannot hide a
  material execution consequence or substitute for explicit confirmation.
- One explicit start confirmation, not a succession of redundant approvals.
- Compact work rows show task/state and relevant next action. No fabricated
  percentage, completion inferred from idle, or claim of semantic review.
- Results state which check passed/failed and offer relevant artifacts/details.
- Takeover, return, reconciliation and stop show task-specific copy. A stop ACK
  never claims Pi or its tools stopped. History maintenance stays secondary.

### Copy and interaction quality

Use “Take control”, not `take_control`; explain recovery in user language rather
than printing protocol reason codes as the primary message. Technical identifiers
belong in details. Keep unavailable actions truthful but avoid walls of disabled
controls. Preserve accessibility names, visible keyboard focus, Tab/Shift-Tab,
Escape, scrolling, literal text rendering and target-specific draft retention.
Changing target/state invalidates confirmations, not unrelated draft text.

## Scope and deliverables

1. A concise screen/flow specification with sketches and control inventory for
   each destination. Update the canonical screens document; do not leave a
   competing design. State where every removed control has moved or why it is
   unavailable. Resolve bounded presentation decisions without another research
   round; ask only for a genuine scope/authority change.
2. Refactored QML components and validated view-model/intents within
   `packages/local-workbench-v1/`. Split the combined Goal/Assignment form.
   Preserve the single adapter/authority boundary; no generic arbitrary payloads.
3. One realistic default fixture journey with one Project, a Goal, one eligible
   session and a configured check. Special failure/history cases are available
   through a separate developer scenario selector, not all rendered together.
   Keep persistent preview labelling. Simulation belongs to an injected fake
   authority, never to QML or the production runner. Unsupported runtime actions
   must not report success; review screens can be reached through staged fixture
   snapshots without pretending an actual intent committed.
4. Adapt the human preview launcher to open that normal journey, retaining
   separate explicit setup consent, exact-session cleanup and no installation
   changes from runtime. Preserve historical releases, including the installed
   0.6.0 candidate: publish this redesign additively as 0.7.0 with reproducible
   retained 0.6.0 assets. Keep the existing plugin ID. Do not duplicate an entire
   historical runtime catalogue in the production package.
5. A focused gate and handoff recording shipped paths, behavior, limitations,
   exact setup/preview commands and next runtime integration work. Update the
   Phase 2 handoff to consume the new flow and configured-check contract.

## Work sequence and collaboration

1. Inventory current source, branch and uncommitted files. Treat pre-existing
   untracked `packages/`, `manual/` and docs as valuable baseline work, not scratch.
   One implementation writer; parallel read-only UX/contract review is useful.
2. Establish the screen/flow specification and view-model changes first, then
   implement the complete normal journey. Review actual component behavior and
   information hierarchy, not merely CSS or fixture snapshots.
3. Move exceptional details out of the default flow; integrate setup/preview
   and additive packaging. Preserve runtime safety regressions.
4. Run the focused gate and affected regressions, fix defects, and close out.
   Do not stop at a plan, scaffold, or collection of disabled placeholder buttons.
   Do not start Phase 2–4 runtime work to make this presentation task look complete.

## Acceptance

Use `just --no-dotenv local-workbench-v1-check`, extending its existing tests
rather than building another parallel test framework. The acceptance authority
for UX remains a separate operator walkthrough, not test counts.

Automated coverage should prove observable behavior:

- New Team Goal has only Project context, goal text and Cancel/Create; no gate or
  Assignment controls in its visual or keyboard path.
- Normal navigation exposes one contextual destination and restores drafts/back
  navigation correctly. Repeated expand/navigation never changes panel width.
- Actual rendered components allow keyboard traversal, wrapping, scrolling and
  Escape cancellation at the fixed dock width. Menus are keyboard accessible.
- Check selection resolves a versioned fixture definition; changing target,
  definition, relevant revision or session invalidates the pending review.
- No stale/unsupported action, fixture operation or preview configuration grants
  real authority or executes a command. Existing identity/privacy checks hold.
- Package setup/preview selects the new candidate, historical bytes are retained,
  and absent/stale loaded components fail with actionable instructions. Do not
  claim a file fingerprint alone proves which QML the shell has loaded; validate
  the loaded presentation contract. Incarnation timing is not content attestation.

Keep tests focused on the user journey and authority boundaries. Update tests
that hard-coded rejected UX; do not keep a bad interaction to preserve a regex.
Do not replace actual-component tests with a growing list of source assertions.
Report concise results and failures, not a large test-count sales pitch.

Human checkpoint, after separate installation consent: the operator creates a
Goal draft, finds Add agent, reviews an Adoption, prepares an Assignment, inspects
its start review, and locates a result using labelled staged fixtures. They
should not need protocol terminology or low-level configuration to navigate.
Record usability findings honestly. No automated desktop/provider/user-state
access, installation, shell restart, live Pi, real dispatch, commit or push.

## Completion boundary

Engineering is complete when this redesigned presentation journey and its gate
are delivered, affected docs agree, and the human preview command is ready.
Native UX acceptance remains pending until the operator tries it. Durable Goal
creation/Adoption remain Phase 2; real dispatch, gates and intervention remain
Phase 3/4. Fullscreen, terminal rendering and Board implementation stay deferred.
