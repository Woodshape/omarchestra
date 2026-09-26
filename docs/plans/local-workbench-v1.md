# Local Workbench v1 implementation plan

Status: **Phase 0 contracts and Phase 1 task-first presentation delivered. Phase 2 S1–S6 engineering gates pass, but the full live management/Adoption walkthrough remains incomplete. The first Phase 3 Project-context gate passes; `start_assignment` remains disabled and rejected. Track the current one-Assignment implementation and open topics in the [Assignment-loop tracker](local-workbench-v1-assignment-loop.md).**

Canonical collaboration result: [delivery and provenance](../design/local-workbench-v1-result.md). Latest [Phase 1 engineering closeout](../design/local-workbench-v1-phase-1-closeout.md) records the completed follow-up and evidence limits.

Current evidence: [screen/state design](../design/local-workbench-v1-screens.md),
[validation and limitations](../design/local-workbench-v1-validation.md), and
[bounded Phase 2 handoff](local-workbench-v1-phase-2-handoff.md). No live dispatch,
installation, or durable production management is enabled by automation. The [human layout walkthrough](../design/local-workbench-v1-human-layout.md) now provides a separately confirmed candidate setup and fixture-only native preview; the operator has exercised it and supplied the UX findings above.

## Outcome

Deliver a coherent Omarchy Companion UI that the operator can use for real local
work: select a Project, create a Team Goal, adopt one visible Pi, issue an
Assignment with an executable acceptance gate, observe progress, and retain its
result. Prioritize a finished-feeling workbench and one working execution loop
over additional standalone lifecycle demonstrations.

This is a bounded step toward the MVP, not a declaration that the MVP is done.
The approved [agent coordination design](../design/agent-coordination.md) governs
acceptance and stopping. Mandatory Reviewer approval and the older exclusive
`review_only` / `review_and_command` modes are not requirements for this slice.

## Authority and required context

Before implementation, read:

- [MVP design](../design/mvp.md), including its coordination amendment.
- [Agent coordination direction](../design/agent-coordination.md).
- [Domain language](../../CONTEXT.md).
- [Pi terminal behavior](../design/pi-terminal-behavior.md).
- [Persistent Companion ADR](../adr/0001-install-a-persistent-omarchy-companion-plugin.md).
- [Observation before Adoption ADR](../adr/0002-observe-ordinary-pi-before-explicit-adoption.md).
- [Connection-bound capabilities ADR](../adr/0003-use-connection-bound-observer-capabilities.md).
- [Explicit purge ADR](../adr/0004-explicit-purge-of-terminal-retired-history.md).
- [Retirement/replacement plan](explicit-retirement-replacement.md) and its linked
  replacement-takeover correction evidence.
- [Live Adoption engineering handoff](../../prototypes/first-vertical-slice/docs/live-adoption-engineering-handoff.md).

Read installed Pi extension documentation before changing the bridge. Read
relevant foundation research and spike evidence before relying on runtime
capabilities. If an unresolved capability needs a spike, follow
[the spike guide](../../spikes/README.md); do not turn contract closure into an
unbounded research phase.

The existing code remains removable prototype evidence. Phase 0 must explicitly
choose the code/package boundary for this slice; neither this plan nor reuse of
prototype tests silently promotes prototype modules to production.

## Scope

### Deliver in v1

- One unified Agent Console, reachable through the installed Companion surface.
- Local Project selection/registration and active/recent Team Goal navigation.
- Creation of a Team Goal and one gated Assignment for an adopted visible Pi.
- Managed agents, Unassigned sessions, and collapsed retired history in one UI.
- Explicit, acknowledged Adoption, retirement and leaf-only purge actions.
- Real same-Pi Assignment delivery, bounded correction attempts, executable gate
  results, and durable completion records.
- Take control, manual takeover, Return to team and bounded reconciliation for
  the single-Assignment loop; no silent return to managed dispatch.
- Stop orchestration without OS-level Pi termination.
- Durable local state that survives closing the console and clean runner exits.
- Honest reconnect/stale/uncertain presentation and an explicit recovery action
  where safe automatic reconciliation is not established.

Start with one active Assignment per local Project. Saved Projects and Team
Goals may be navigated without implying concurrent execution. Enforce admission
in the runner, not by hiding buttons. This is a slice limit, not a new permanent
MVP restriction.

### Design now; implement in follow-on slices

Reserve the information architecture for Assignments, Board and Activity.
The Board destination must be visibly unavailable until its backend exists;
preview fixtures must never look like live work. Do not ship fake posting,
subscription or message-delivery actions.

Follow-on work is ordered as:

1. Project Board → Channel → Thread → Message, explicit posting/reading,
   artifact references and durable read cursors.
2. Subscriptions, bounded notifications and permitted delivery boundaries.
3. Multiple agents coordinating through runner-authorized Assignments and the
   board, with optional Reviewer participation and single-writer admission.

### Not in this slice

- Automatic three-terminal launch, terminal-runtime replacement or PTY control
  for adopted ordinary terminals.
- Remote execution implementation. It remains MVP scope, not a v1 prerequisite.
- Arbitrary DAGs, concurrent writers, worktrees, rollback, process-kill escalation,
  automatic re-Adoption of a retired surviving incarnation or reboot resume.
- Transcript mirroring, token streaming, invented progress percentages or
  inferred model/cost data.
- Fusion Harness embedded as a second scheduler, registry or durable authority.
- A full-screen or user-resizable workspace mode for the console. The dock
  surface has fixed geometry in v1: opening a detail changes only the content
  inside it, because a resizing layer surface makes the shell re-reserve
  compositor edge space and shifts neighbouring terminals. A larger workspace
  view is worth revisiting once the console carries more than a dock can hold.

## Non-negotiable boundaries

1. The Team Runner remains the sole management, Assignment, gate and durable
   projection authority. QML renders data and emits intents only.
2. Observation never dispatches work. Adoption requires exact same-process ACK,
   reconciliation and durable commit; readiness must follow committed delivery.
3. Original and replacement Runs receive identical dispatch, takeover, recovery
   and presentation semantics. Retired/purged bindings remain fenced.
4. A Role is not a writer lease. Retirement and disconnection do not establish
   checkout safety or prove tools have stopped.
5. At most one write-authorized Assignment exists per Project checkout.
   Unmanaged/human interference is possible; do not claim OS isolation.
6. A worker cannot change its gate definition or edit authority to manufacture
   acceptance. Gate pass is acceptance authority, not mandatory agent review.
7. Manual takeover pauses automatic work and future automatic message delivery;
   pending work remains subject to explicit reconciliation and its gate.
8. Stop revokes new dispatch and requests only supported cooperative cancellation.
   A stop ACK is not evidence that tools or processes ended.
9. Observer content exclusions remain intact. User-authored Assignment text and
   explicit artifacts need their own managed-content policy; they are not a
   license to collect Pi conversations, thinking or tool-result bodies.
10. Setup/update is explicitly authorized. Opening, hiding, running or stopping
    work never installs QML or changes Omarchy configuration.

## Target UI/UX

### Layout

The [task-first redesign](local-workbench-ux-redesign.md) supersedes the original all-controls form and appended-detail arrangement below. New Team Goal is only Project context and goal text. Add agent, Assignment preparation and reusable check configuration are separate flows; authority contracts remain unchanged.

Use one native, theme-consistent console with a compact docked agent overview
and a detail area suitable for forms and results. Phase 1 settles exact sizing,
expansion and navigation rather than squeezing every form into a narrow card.
Keep native Pi terminals visible; do not embed terminals.

```text
Omarchestra                                      Runner: connected / stale
Project selector                       Active / Recent Team Goals
  Team Goal title                      [New Team Goal]
  Goal and overall outcome
  Agents | Assignments | Board (not available yet) | Activity

  Managed agents
    Role · control mode · connection
    Assignment and last structured event
    Available actions / reason an action is unavailable
  Unassigned sessions
    Observed status · eligibility · Adopt
  Retired history (collapsed, count)
    Retired · Role · identity · successor link · explicit delete
```

### Essential interactions

| Surface | Required behavior |
| --- | --- |
| Project selection | Canonical local Git Project selected explicitly; bad paths and unsupported state rejected visibly. Pi cwd alone never grants identity or authority. |
| New Team Goal | Goal text and explicit local Project; show resolved configuration and supported adoption-first scope, not automatic launch promises. |
| Agent card | Separate membership/control, connection and Assignment status. Current Pi and Companion use the same committed role/control value. Unknown metadata stays unavailable. |
| Adoption | Exact session, Goal and Role confirmation; distinguish proposed, authorized, awaiting ACK, committed, ready and failed/expired. Clear obsolete feedback. |
| Assignment editor | Natural-language goal, target Run, gate definition/version, execution context and stopping limits; explicit start confirmation. |
| Gate result | Gate identity, candidate/attempt, pass/fail/error/timeout, bounded diagnostics and artifact references. An artifact-presence gate is not semantic verification. |
| Takeover/reconciliation | Show why dispatch paused; Return to team requests a structured handoff, then explicit accept/resume/retry under gate and writer rules. |
| Stop | Explain that work may continue in Pi/tools; display actual cancellation acknowledgement separately from dispatch revocation. |
| History | Retired first, not a misleading current “managed” headline. Successor-first purge with separate destructive confirmation; never delete external work. |
| Connection loss | Visible stale banner, disabled authority actions, retained last-known state labelled as such. Reopen from an authoritative snapshot. |

Keyboard navigation, focus indication, readable wrapping, bounded scrolling,
empty/loading/error states and confirmation cancellation are acceptance work,
not optional polish. Preserve form drafts across ordinary projection updates;
never preserve a stale authority confirmation across session/identity changes.

## Phase 0 — close only the contracts this loop needs

Phase 0 technical decisions are recorded in the [Local Workbench v1
contract](../design/local-workbench-v1-contract.md) and [transition
tables](../design/local-workbench-v1-transitions.md). These are specifications,
not runtime implementation evidence. Phase 1 remains the executable presentation
boundary; later-phase enforcement must pass its own composed gates.

Deliver a short Local Workbench contract and transition tables under
`docs/design/`, linked from this plan when created. Each unresolved row below
must have a recorded decision and testable failure behavior before its affected
runtime path is implemented. Proposed defaults are recommendations, not already
locked product decisions. Ask the user only when a decision changes scope or
observable policy beyond the approved design.

| Contract | Required output / proposed narrow direction |
| --- | --- |
| Code and deployment boundary | Select reusable modules versus new package, supported Node/Pi/Omarchy versions, launch/setup commands and ownership. Preserve one runner/store composition; no competing prototype service. |
| Project and admission | Canonical Node-qualified Project identity, dirty-checkout policy, explicit binding between selected Project and execution context, one active Assignment admission and uncertain-writer handling. Reject context mismatch rather than guessing or changing Pi cwd silently. |
| Persistence | Outside-Git owner-only durable location, exclusive runner ownership, schema version/migration, backup/recovery and retention. Clean shutdown must not delete workbench history like the disposable gate does. |
| Protocol | Bounded snapshots/events/intents with IDs, revisions, cursor gaps, deduplication and ACKs. Enumerate commit, delivery and presentation failure windows. |
| Assignment delivery | Stable Assignment/attempt IDs; exact Run binding; accepted/busy/duplicate/invalid responses; extension-originated input excluded from human takeover. Uncertain delivery must not blindly resend a second turn. |
| Completion signal | Explicit structured candidate submission from the same Pi; agent-settled or conversational “done” alone is not completion. Define allowed artifact references and bounds. |
| Gate authority | Operator-confirmed, versioned gate frozen per attempt. Define who can edit it, how a changed gate invalidates pending results, and how worker edits to referenced scripts/configuration are handled. |
| Gate execution | Explicit executable/argv, canonical cwd, environment policy, timeout, output bounds and ownership of validator resources. Arbitrary gate execution is code execution, not a harmless UI preview. No interpolation of worker text into shell commands. |
| Candidate association | Persist what exact candidate the gate evaluated, including dirty/untracked files where relevant. Define detection of concurrent changes and stale results; never accept evidence for a different candidate. Gate execution may itself mutate files and must be accounted for. |
| Retry and aggregation | Proposed: finite configured correction attempts, same frozen gate, no infinite retry. Define correction payload and stop limits; one accepted Assignment completes this slice's Goal with its result record and no mandatory Reviewer. |
| Takeover and return | Durable handoff schema, accept/resume/retry intents, admission checks and handling of a gate result arriving during takeover. Accepting a handoff never bypasses the executable gate. |
| Stop and uncertainty | Explicit trigger/limit schema, cooperative API compatibility, ACK deadlines and truthful unsupported/unknown outcomes. Preserve files and Pi usability; no kill escalation. |
| Content policy | Bounds and retention for explicit goal, handoff, artifact and gate diagnostics; secret-sensitive output stays out of general activity feeds/QML unless explicitly permitted and filtered. |

Completion: written contracts cover the happy path and rejection/recovery paths.
Resolve technical uncertainty with bounded fixtures/spikes, not new product
features. UI design can proceed in parallel; live dispatch cannot bypass this
phase.

## Phase 1 — screen design and executable presentation shell

- Produce screen sketches/state fixtures for the entire layout and action table.
- Implement the unified console against injected authoritative projections.
- Give intent feedback an explicit lifecycle and clear identity association.
- Keep unsupported Board/runtime actions disabled with explanations.
- Use an additive versioned Companion release; preserve historical release bytes.
- Settle setup/update and runtime open/hide behavior without touching installed
  configuration from automated tests.

Gate: QML lint, projection/intent tests, narrow/wide layout fixtures, stale-session
rejection and source audits pass. Arrange one consolidated operator layout
checkpoint rather than repeated live checks for individual controls.

## Phase 2 — durable local workbench and real agent management

- Implement Project/Goal records and active/recent navigation with the selected
  durable ownership contract.
- Connect the new UI to the existing management authority: registration,
  Adoption, readiness, takeover, retirement and purge.
- Keep replacement takeover/recovery tests in the composed path.
- Closing the console clears only presentation; runner shutdown closes resources
  without deleting Project/Goal/Assignment history.
- Implement actionable startup errors and safe reopen/recovery, not instructions
  to delete unknown runtime directories.

Gate: fake/injected UI → runner → disposable database tests prove Goal creation,
exact Adoption, snapshot reconstruction, identity fencing and zero dispatch
before Assignment start. Demonstrate two sequential Goals without reinstalling
or rebuilding the Companion.

## Phase 3 — one real gated Assignment loop

Current progress, ordered implementation slices, open technical topics, and executable/live gates are tracked in the [first useful Assignment-loop tracker](local-workbench-v1-assignment-loop.md). This high-level roadmap does not authorize live dispatch.

- Implement Assignment, attempt and gate-result transitions from Phase 0.
- Wire the same-Pi delivery port; retain stable IDs and current readiness checks.
- Add explicit candidate submission, bounded validator execution and durable
  result association.
- On pass, record accepted outcome with gate evidence and explicit artifact
  references. On failure, issue bounded correction work only while eligible;
  on exhausted limits or uncertainty, stop/require attention truthfully.
- Surface all real stages in the UI; do not infer acceptance from model output.

Gate: composed fake-Pi + framed transport + runner + disposable SQLite + injected
validator tests pass. Also run harmless deterministic validator subprocess
fixtures in scratch directories to exercise exit, timeout, output bounds and
cleanup without providers, real Projects or live Pi.

## Phase 4 — intervention, stop and recovery

- Complete Take control, source-only input takeover, Return to team and explicit
  reconciliation for the same Assignment loop.
- Prevent a passing gate from completing stale, stopped or unreconciled work.
- Persist stop/limit outcomes and deny subsequent dispatch; distinguish tools
  that may remain active from confirmed idle state.
- Reconcile surviving connections after runner loss; never infer exactly-once
  execution or automatically transfer work to a replacement.

Gate: failure injection at each durable transition proves no duplicate delivery,
no stale gate acceptance, no second writer and no silent takeover reset. Include
replacement Runs, late ACKs/results, connection loss, clean restart and explicit
history gaps. Unsupported recovery remains visibly blocked, not simulated.

## Phase 5 — package and use for one real task

- Provide one documented setup/update path and one normal workbench startup/open
  path; no multi-terminal checklist scripts required for routine work.
- Run the slice's automated gate once as a release check, plus affected existing
  regressions. Existing zero-dispatch Adoption tests remain zero-dispatch;
  Assignment tests use a separate explicit authority path.
- With separate operator consent, install/update the release and perform one
  small real local task through the complete UI loop.
- Record which checks were automated, observed by the operator, skipped or
  unsupported. Do not translate skipped validation into PASS.

The user has requested pausing repetitive validation loops. Do not make old
independent-review or live restart checklists a prerequisite to starting this
slice. Retain automated regression safety and use a single focused live release
exercise rather than repeated manual attestations.

## Executable acceptance gate to add

Proposed recipe: `just local-workbench-v1-check` (does not exist yet).

It must run without a desktop/provider and cover:

1. Project/Goal creation, invalid context rejection and durable reopen.
2. Unmanaged session cannot receive Assignment or automatic board content.
3. Exact acknowledged Adoption followed by readiness; original/replacement parity.
4. One explicit Assignment start → one same-Pi delivery → explicit candidate →
   gate execution → persisted accepted result in the console.
5. A second Project writer is denied, including during uncertain prior work.
6. Gate fail, execution error, timeout, changed gate and stale candidate never pass.
7. Bounded correction attempts stop at the configured limit.
8. Manual takeover pauses dispatch; reconciliation cannot bypass the gate.
9. Stop prevents new work without claiming process/tool termination.
10. Lost ACK/result, runner restart and stale UI actions do not duplicate work.
11. UI close/reopen preserves history and installed assets; normal shutdown does
    not purge the durable workbench database.
12. Privacy/authority audits and static QML lint pass; no live installation,
    provider, terminal launch or user-state access is reachable from automation.

The separate human exercise verifies visual usability and actual same-Pi work;
it is not a substitute for the executable safety cases.

## Fusion Harness execution

Use `just fusion` as the external development harness with this repository as
all agents' working directory. One writer implements; other agents may inspect
contracts, screen states and tests. Fusion does not own workbench runtime state,
dispatch or gate authority and its repository is not the implementation target.

Suggested initial handoff:

> Read docs/plans/local-workbench-v1.md and its required context. Execute Phase 0
> and Phase 1 design first. Produce bounded contracts and a screen/state design,
> identifying decisions that require user agreement. Preserve the single runner
> authority and agent-coordination amendment. Do not enable live dispatch,
> install anything, launch live Pi, commit or push without separate authorization.

Subsequent implementation tasks should target one phase and its acceptance gate,
not request an unrestricted full-MVP build.

## Done means

The operator can open the installed console, choose a local Project, create a
Goal, adopt Pi and finish one real gated Assignment without using test-harness
controls. Progress, takeover, failures, gate evidence and retained outcomes are
truthful and understandable. The next task can start without reinstalling the
plugin or erasing the previous task's state.

A board preview, mock execution or successful ungated Pi conversation is not
completion. The final report lists shipped paths/commands, tests, live evidence,
known constraints, and the next Message Board milestone.
