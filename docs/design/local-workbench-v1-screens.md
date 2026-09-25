# Local Workbench v1 — screen and flow design

Status: **Phase 1b task-first redesign specification (canonical).** This document
supersedes the original Phase 1 form/navigation arrangement. It does not change
the authority, privacy, execution or persistence contracts in the
[contract](local-workbench-v1-contract.md) and
[transition tables](local-workbench-v1-transitions.md). Implementation status and
native operator acceptance are tracked in the [validation ledger](local-workbench-v1-validation.md)
and [Phase 1 closeout](local-workbench-v1-phase-1-closeout.md).

Authority: [redesign plan](../plans/local-workbench-ux-redesign.md),
[slice plan](../plans/local-workbench-v1.md), [contract](local-workbench-v1-contract.md),
[transitions](local-workbench-v1-transitions.md), [human layout](local-workbench-v1-human-layout.md).

The console renders injected authoritative projections and emits validated
intents. It does not create durable Projects or Goals, adopt live Pi, dispatch
Assignments, execute gates, or simulate those operations as live functionality.
Unsupported execution stays visibly unavailable.

## Fixed shell

One native, theme-consistent console with **content-independent geometry**. The vertical dock uses `Style.space(420)` width, clamped by the screen, and top/bottom anchors stretch it to the available native height. `Style.space(560)` is an implicit height hint, not proof of a fixed 560-pixel native dock. Offscreen substituted-Window dimensions are not native reservation evidence. Opening a destination, a form, a menu, a dialog or
retired history changes content *inside* that surface and never resizes it. This
is a hard requirement: a layer surface that resizes makes the shell re-reserve
compositor edge space, so neighbouring terminals shift whenever the operator
navigates. Content scrolls instead of the surface growing. Fullscreen/resizable
app mode is deferred and is not part of this slice.

Exactly two `implicitWidth`/`implicitHeight` lines exist on the root and both
reference `root.panelWidth`/`root.panelHeight`. No destination, dialog or menu
may add a surface geometry binding.

## Normal journey

One main content destination at a time, with a Back path. Details replace the
relevant content; the console never appends every detail beneath the overview.

```text
Overview (Project + Goal list + managed agents + unassigned sessions)
  ├─ New Team Goal ──► Overview
  ├─ Goal ──► ⋮ Goal actions (runner-committed only) ──► Add agent / Prepare assignment / Checks
  ├─ Add agent ──► Adoption review ──► Add agent
  ├─ Prepare assignment ──► Assignment preparation ──► Start review ──► Work and result
  │        └─ Configure checks (Project-level)
  ├─ Checks (Project-level)
  └─ Activity

Overview ──► Board (visibly disabled, no backend; not a destination)
```

The ten destinations are `overview`, `goal`, `new_goal`, `add_agent`,
`adoption_review`, `assignment`, `checks`, `start_review`, `work` and `activity`;
they are negotiated as one set with the shell and a mismatch refuses the
projection. `Board` is a disabled control on the Overview, not a destination.
Back follows the path that reached the destination (`start_review` →
`assignment` → Goal or Overview; `adoption_review` → Add agent; `checks` → its
origin).

Persistent context is always visible at the top: Project selector, current Goal,
runner connection state and the fixture/preview label. Normal navigation never
requires reading internal IDs or understanding runner terminology. Exact
identifiers are rendered literally as plain facts in Adoption review and Start
review, where they are material to the decision, rather than hidden behind a
disclosure widget.

## Destinations and control inventory

### D1. Overview (root)

```text
Omarchestra                              Runner: connected
Preview · staged fixture — no real work
Project: /home/user/work/omarchestra            [Change]
Goal: Ship the parser fix
Team Goals
  Ship the parser fix  ·  active
[ New Team Goal ]
Managed agents
  Builder · managed
  Builder · managed · connected
  Assignment: assignment-1
[ Take control: No assignment is running for this agent. ]
[ Retire agent: Finish or reassign the active Goal before retiring this agent. ]
Unassigned sessions
  pi-a1b2
  Availability: available · Lifecycle: running
[ Adopt pi-a1b2 into Ship the parser fix as Builder ]
[ Retired history (0) ]
Assignments and checks
[ Add agent ]            [ Prepare assignment ]
[ Checks ]               [ Work and result ]
[ Board ]                [ Activity ]
Board backend is not available in this slice.
```

- Controls: persistent header (`Runner`, fixture label, Project selector `Change`,
  current Goal), each Goal row (select), `New Team Goal`, managed-card actions,
  observed-session adoption choice, `Retired history` disclosure, and the
  `Assignments and checks` grid: `Add agent`, `Prepare assignment`, `Checks`,
  `Work and result`, `Board` (disabled with reason), `Activity`.
- Every card label is an opaque committed presentation string; `piStatus` is
  never rebuilt from role/control/assignment fields. Disabled actions show the
  runner's exact reason and emit nothing.
- Observed rows and Add agent selection rows show connection availability,
  lifecycle, activity and health separately. An unavailable Adoption has a
  persistently visible runner-owned `adoptionReason` (bounded plain text), not a
  tooltip or popup. `available` describes the connection, never permission to
  adopt. Busy/unknown activity, reservations and stale pending authorization do
  not silently disappear behind identical labels. Connected observed and
  managed rows show `Pi XXXX-XXXX`, matching that same Pi's named status slot;
  Add agent and Assignment target rows repeat it. Missing/legacy/disconnected
  codes explicitly show `Session code unavailable`. Codes never replace exact
  target IDs and a changed visible code disarms an armed action. Overview row
  headers now expose **Show terminal pane**: one click emits `present` with only
  the runner-issued connection ticket and an empty payload. This is navigation,
  not a consequential authority change. Literal checked/unknown/unavailable
  explanations stay in the dock; there is no popup or automatic retry.
  Disconnected/legacy/checking rows disable navigation. Lifetime and evidence are tracked in
  [session usability](../plans/workbench-session-usability.md).
- Board is visible but disabled with a short reason and emits no intent.
- Back: none (root). Escape disarms an armed action first, then closes an open menu or Project list; otherwise no-op.

### D2. Goal

```text
← Back
Ship the parser fix                                              [ ⋮ ]
State: active · Outcome: not recorded
(⋮ menu, when open: only runner-committed Goal actions)
[ Stop assignment: No assignment is running for this Goal. ]
[ Add agent ]
[ Prepare assignment ]
[ Checks ]
Retired history is listed with the managed agents.
```

- Controls: `Back`, goal text, `State`/`Outcome` facts, `⋮` menu (keyboard
  accessible, inline rather than floating so panel geometry and the input mask
  are unchanged) containing only the runner-committed `selectedGoal.actions`,
  and the `Add agent`, `Prepare assignment` and `Checks` navigation buttons.
- Secondary maintenance is not a full-width button per operation. Retired
  history is disclosed in the Overview card list, not duplicated here.
- Back: Overview.

### D3. New Team Goal

```text
← Back
New Team Goal
Project: /home/user/work/omarchestra
[ Change Project ]
Team Goal
[ multiline goal text                         ]
[ Cancel ]                        [ Create ]
```

- Controls: `Back`, Project context, `Change Project`, multiline goal text,
  `Cancel`, `Create`.
- `Create` is enabled only for non-empty input, a connected runner and a
  committed `create_goal` action. The emitted payload carries `projectId` and
  `goalText`; nothing is created before the runner commits the intent.
- **Nothing else appears here.** No Assignment fields, agent selector, gate
  identity/version, executable/argv, resource paths, environment, timeout/output
  limits or correction counters. No automatic Pi launch, Adoption or dispatch
  follows creation.
- Back/Cancel: Overview; the goal draft is retained and keyed by Project.

### D4. Add agent

```text
← Back
Add agent
Choose one unassigned session and the Role it should fill.
Eligible sessions
[ pi-a1b2  ·  available · running ]
Role
[ Builder ]  [ Reviewer ]
[ Review exact binding ]
(no authoritative adoption proposal yet → nothing can be authorised)
```

- Controls: `Back`, eligible session rows with the runner's opaque `piStatus`
  plus availability/lifecycle, Role rows, `Review exact binding`.
- Ineligible/unknown sessions keep a short explanation and cannot be selected.
  `Review exact binding` stays disabled until a matching committed adoption
  proposal exists.
- Nothing auto-selects or authorizes a different session on refresh.
- Back: Goal.

### D5. Adoption review

```text
← Back
Adoption review
Proposal: proposal-a1b2
Observed session: observed-session-a1b2
Project / Node: project-workbench-1 / node-workbench-1
Goal / Role: goal-parser-fix / Builder
Predecessor: none · Vacancy generation: 0
Stage: proposed
ACK and committed delivery must precede readiness. No Assignment is created by adoption.
[ Authorize adoption: runtime unavailable ]
```

- Controls: `Back`, the exact proposal facts, `Authorize adoption` (disabled with
  a reason in this slice).
- Same-process ACK, reconciliation, commit and readiness are preserved; no
  optimistic UI. Replacement shows its predecessor and retains every fence.
- The request control in Overview/Add agent requires two presses of the same button for the exact observed session, Goal and Role. The proposal authorization shown here remains a separate committed step with its literal IDs and same-process ACK; it is not a replacement confirmation pop-up.
- The authorization action is unavailable until the runtime port exists and is
  labelled as such, and it emits nothing while disabled.
- Back: Add agent.

### D6. Assignment preparation

```text
← Back
Assignment preparation
Task
[ multiline task text                         ]
Target agent
  Builder · Builder · managed · managed · connected
Acceptance check
  Unit tests · v3 · validator · available
  (no check configured → Configure checks)
[ Configure checks ]
(blocked reason, when present)
[ Start review ]                               (primary)
```

- Controls: `Back`, task text, agent choice rows, check choice rows,
  `Configure checks`, the blocked reason, `Start review`.
- Inherits Project and Goal context visibly. Agent choice rows carry the
  runner's opaque `piStatus` alongside Role and control mode, so no label is
  derived and no raw Run ID is a choice label.
- Acceptance-check selection is **not** "turn off validation". A missing
  configuration blocks start with a clear `Configure checks` path.
- `Start review` is enabled only when a ready agent, a non-empty task and a
  resolved available configured check exist; the blocking reason is rendered
  verbatim from the runner-owned facts.
- Attempt limits (`maxCorrections`, `elapsedMs`) are frozen runner facts under
  C10. They are not editable here in this slice; they appear as exact frozen
  limits in Start review.
- Back: Goal; the assignment draft is retained.

### D7. Configure checks (Project-level)

```text
← Back
Acceptance checks
Checks are configured per Project and reused across Team Goals.
  Unit tests · v3 · validator
  run "node --test"
  available · digest 3f9a1c2b
  Artifact presence · v1 · artifact_presence
  writes dist/report.txt
  available · digest 7c1de004
(no check configured → explicit empty state)
Edit definition
  [ name ] [ summary ] [ command summary ] [ mode: validator | artifact_presence ]
  [ Advanced definition ] (collapsed)
    executable / arguments / cwd / nonsecret environment / resource paths
    check timeout / output bytes / corrections / work time limit
    Exact identity and existing definition digest
[ Save check ] (draft intent only; no execution)
```

- Controls: `Back`, check rows, basic metadata, `Advanced definition`, `Save check`. The advanced editor contains explicit executable/argv/cwd/environment/resource-path and limit draft fields. Tab leaves multiline editors; invalid paths/limits disable Save, and the adapter enforces complete bounds.
- Owns reusable check definitions. Nothing here exists in Goal creation.
- The operator intent adds the closed `definitionDraft` described in C14. Resource paths are editable; hashes are not. The runner must resolve, version and freeze the full definition before a separate start authorization. Saving never executes the draft.
- `mode` is a closed union mirrored from the runner (`validator`,
  `artifact_presence`), never free text.
- Identity/version, definition summary, edit authority, invalidation and
  empty/error behavior are specified in the
  [configured-check contract](local-workbench-v1-contract.md#c14-project-scoped-configured-acceptance-checks).
- In this slice the catalogue is injected fixture data. Editing is a presentation
  draft and never execution authority. No durable preset service, repository
  script discovery, shell-string parsing, template marketplace or second store.
- Back: origin (Overview or Assignment preparation).

### D8. Start review

```text
← Back
Review start
Task: <plain text>
Agent: Builder · Acceptance check: Unit tests
Command · Location · Existing changes retained
Timeout / output limit · Corrections / work time limit
[ Technical details ] (collapsed: exact identities, hashes, argv, environment, resources)
This is code execution with no isolation or rollback…
[ Back to assignment ]
[ Confirm start: runtime unavailable ]
```

- Controls: `Back`, `Back to assignment`, `Technical details`, disabled `Confirm start`. Task and meaningful consequences come first. Exact identities, argv, environment, hashes, baseline and resolved resources remain literal and inspectable behind the disclosure.
- Shows task, exact agent, Project/location, check name and command, important
  limits and dirty-checkout consequences in plain language. Disclosure cannot
  hide a material execution consequence.
- One explicit start confirmation, not a succession of redundant approvals. The
  action is unavailable until the runtime port exists and is labelled as such.
- Back: Assignment preparation. Changing target, definition, relevant revision or
  session invalidates this review and its confirmation without deleting the task
  draft.

### D9. Work and result

```text
← Back
Work and result
┌ Assignment: assignment-1 · failed
│ Goal / Agent · Task · Check + result · Attempt · corrections
│ Candidate · Artifacts
│ [ Retry with a new attempt ]  [ Stop assignment ]
│ Stop stop-1 · operator / Dispatch revoked: yes / Cancellation: requested
│ Cancellation acknowledgement is not tool/process termination. Files are retained.
└
┌ Assignment: assignment-2 · running
│ …its own Goal / Agent / Task / Check / Attempt / Candidate / Artifacts
│ …its own intervention buttons, bound to assignment-2
└
[ Back to Project ]
```

- Every committed Assignment in the Project gets **its own row** with its own
  facts and its own intervention buttons. The destination never silently shows
  only the first Assignment.
- All supplied Assignment rows remain reachable by scrolling, bounded by the snapshot's 100-record limit. No rows are discarded or falsely redirected to Activity, which is an event feed.
- Compact work facts show the committed assignment task, state and its exact
  next actions. No fabricated percentage, completion inferred from idle, or
  claim of semantic review.
- Results state which check passed/failed and which artifacts are recorded.
- Takeover, return, reconciliation and stop show task-specific copy. A stop ACK
  never claims Pi or its tools stopped.
- The committed outcome detail for that row's Assignment (`stop`, `handoff`,
  `diagnostics`) renders inside that row; a detail belonging to another
  Assignment is never shown there.
- Disabled actions show a reason. The header `Back` returns to the Goal when a
  Goal is selected (else Overview); the explicit `Back to Project` button always
  returns to the Overview.

### D10. Activity

Reason-code feed: stable codes, IDs, bounded labels and state transitions only.
Never submitted text or validator stdout/stderr. Back: Overview.

### D11. Board (disabled, not a destination)

Visible but disabled with a short reason, emits no intent, no fake posting,
subscriptions, execution or progress. The reason is stated once on the Overview;
`Board` never becomes a destination.

### D12. Retired history (secondary disclosure)

Collapsed behind a `Retired history (n)` disclosure in the Overview card list;
successor-blocked purge disabled with a reason; leaf purge only under ADR 0004.
It expands inside the Overview rather than opening a destination, so it cannot
change surface geometry.

## Destination and Back behavior

| Destination | Parent / Back | Escape |
| --- | --- | --- |
| Overview | none (root) | closes dialog/menu/Project list; else no-op |
| Goal | Overview | returns to Overview |
| New Team Goal | Overview | returns to Overview, draft retained |
| Add agent | Goal when a Goal is selected, else Overview | returns to that parent |
| Adoption review | Add agent | returns to Add agent |
| Assignment preparation | Goal when a Goal is selected, else Overview | returns to that parent, draft retained |
| Configure checks | origin (Overview or Assignment preparation) | returns to origin |
| Start review | Assignment preparation | returns to Assignment preparation, draft retained |
| Work and result | Goal when a Goal is selected, else Overview | returns to that parent |
| Activity | Overview | returns to Overview |

Escape disarms an armed action first, then dismisses a menu or Project list **before** navigating Back. No separate confirmation box, overlay or desktop notification is used.

## Draft keys

Drafts are ephemeral presentation text, keyed by target, retained by the root
view and synchronized with the adapter. They survive ordinary projection updates,
destination changes and close/reopen of the retained view; presentation-process
restart does not promise recovery. Drafts are never an authority confirmation.

| Draft | Key | Fields |
| --- | --- | --- |
| New Goal | `goal:new:<projectId>` | `goalText` |
| Assignment | `assignment:<projectId>:<goalId>:<agentRunId>` | `taskText` |
| Check config | `checks:<projectId>:<checkId>` | `name`, `summary`, `mode`, `commandSummary` |

Agent, check and Goal selection are presentation state keyed by
`<projectId>:<goalId>`, not draft text and not authority. A target with no
selection has no draft key, so typed text cannot be retained for a target the
operator has not chosen. Changing target/state invalidates confirmations, never
unrelated draft text. Capacity errors are visible. Limit: 64 target drafts, keys
at most 512 characters, serialized draft text at most 24,000 characters each.

## Keyboard and focus

- Namespace-qualified native surfaces avoid Qt Controls shadowing. Explicit
  palette bindings and accessible form names are preserved.
- Tab order follows destination order; the persistent context header is reachable
  first. `Back` is a real focusable control and the first focusable item of a
  non-root destination.
- Multiline editors: Tab hands focus to the next control and Shift-Tab returns.
  The editor otherwise consumes Tab as a literal tab character, so the hand-off
  is explicit rather than relying on default key handling.
- `⋮` menus open with Enter/Space on the trigger and are traversed with
  Tab/Shift-Tab like every other control in the dock, activated with Enter/Space
  and closed with Escape; focus returns to the trigger. When the only committed
  action is disabled, the menu shows the runner's exact reason and has no
  focusable entry.
- Escape disarms an armed action first, then closes an open menu or Project
  list, then navigates Back. The handler lives inside the panel window on the
  panel surface: the layer-shell panel is a separate window, so a handler on the
  console root item would never receive a key event from panel focus.
- Focused controls scroll into view; labels and editors never exceed the
  component width; authored text renders literally (`Text.PlainText`/
  `TextEdit.PlainText`).

## Where every removed control moved

| Removed from Goal creation | New home |
| --- | --- |
| Assignment goal text | Assignment preparation → Task |
| Target agent Run `ComboBox` | Assignment preparation → Target agent rows (friendly label + Role/status) |
| Gate identity field | Configure checks → check identity (selected from the catalogue, never typed) |
| Gate version field | Configure checks → version owned by the catalogue; selection references it |
| Executable field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Argv field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Context/cwd field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Environment field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Resource paths field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Timeout field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Output-limit field | Configure checks → runner-owned full definition (C14); frozen fact in Start review |
| Maximum corrections | Start review → frozen C10 limit fact; no Goal-creation field |
| Elapsed limit | Start review → frozen C10 limit fact; no Goal-creation field |
| Disabled `Start Assignment` button | Assignment preparation → `Start review`; Start review → `Confirm start` (runtime unavailable) |
| Detail appended beneath the overview | Replaced by the one-destination router with a Back path; committed stop/handoff/diagnostics facts render beside the work they describe |

## Fixture journey and developer scenarios

The default rendered fixture is **one realistic journey**: one Project, one Goal,
one eligible observed session and one configured check, labelled
`Preview · staged fixture — no real work`. It walks Overview → Goal → New Team
Goal → Add agent → Adoption review → Assignment preparation → Start review →
Work and result.

Special failure/history cases are available only through a separate developer
scenario selector, never all rendered together: `stale`, `gap`, `error`,
`takeover`, `reconciling`, `gate_pass`, `gate_fail`, `gate_timeout`,
`retired_leaf`, `board_disabled`, `no_check`, `invalid_check`, `artifact_only`.
Each scenario binds a committed `assignment-1` to its managed card, so
assignment-scoped actions carry the identity their intent requires. Simulation
belongs to an injected fake authority, never to QML or the production runner.

## Preview labelling and honesty

- Fixture mode is persistently labelled. A staged snapshot is never presented as
  a committed operation.
- Review screens can be reached through staged fixture snapshots without
  pretending an actual intent committed.
- Unsupported management/execution actions cannot pretend to be live; Board and
  Start stay disabled with reasons.
- Intent feedback lifecycle: `submitted → acknowledged|rejected|unknown|stale|expired`.
  `acknowledged` means the runner committed the intent, not that Pi delivery
  succeeded.
- Consequential enabled actions use their **original button** for explicit two-press confirmation. The first press only arms and relabels it `Confirm: <committed label>`; the second press on that same exact action emits the intent. No review box, focus jump, overlay or notification is created. The currently selected Goal remains in the header, the observed session in its row, and the Role in the committed action label. A cursor-only heartbeat keeps the button armed. After 30 seconds or a session/generation/epoch/selection/target/authority/relevant-revision change, it resets to its original label; a subsequent press only arms the current action anew. Escape disarms without emitting. Runner revalidation, the Adoption proposal's literal identity review, same-Pi ACK and durable commit still gate management.

## Privacy and authority

Observation remains lifecycle-only; general activity and snapshots never carry
prompts, responses, tool arguments/results, terminal output, repository contents
or secrets. Authored Goal/Assignment/handoff text is bounded, plain-text,
owner-only managed content under C13. `piStatus` is an opaque committed display
value and is never rebuilt from role/control/assignment fields. Every disabled
action shows a reason; the runner computes domain eligibility and QML only
narrows for stale/unsupported presentation.

## Implementation boundary

This slice implements only the presentation journey above: strict bounded
projection/intent types and validators, an injected authoritative source and
intent sink, destination/Back routing, the Project-scoped configured-check
presentation contract, one default fixture journey with a developer scenario
selector, and the unified QML shell. It does not claim that fixture transitions
enforce a durable writer, run a validator, recover a process, or complete a real
Goal. Durable Goal creation/Adoption remain Phase 2; real dispatch, gates and
intervention remain Phase 3/4.
