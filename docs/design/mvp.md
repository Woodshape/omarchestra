# Omarchestra — MVP Design

Status: **MVP product scope locked; Companion Plugin vertical slice fake-proven; production technical contracts pending**
Last updated: 2026-09-02
Related research: [`foundation-assessment.md`](../research/foundation-assessment.md)

This document is the authoritative record of the MVP scope. It supersedes earlier architectural recommendations where they conflict with decisions recorded here.

Decision labels:

- **Locked** — agreed; do not reopen without new evidence.
- **Proposed** — current default; needs explicit confirmation.
- **Deferred** — intentionally outside the MVP.
- **Open** — must be decided before implementation.

## Product outcome

**Locked.** Build an Omarchy-native control plane for teams of visible coding agents.

Every active agent is the real interactive process shown in its own native terminal window and tiled by Hyprland. The desktop console observes and coordinates these agents; it does not replace them with hidden headless workers or simulated cards.

A successful MVP lets a user create one Team Goal on the local Omarchy machine or one explicitly selected remote GNU/Linux execution Node, watch all participating agents through native local tiled terminals, inspect their structured state from an Omarchy console, focus any exact agent window, and receive one integrated result.

## Product principles

1. **Visible execution.** No hidden Pi JSON/RPC worker may perform the work represented by a visible agent.
2. **One process, two views.** The native Pi TUI is the complete conversational view; the Agent Console is a structured operational projection of that same process.
3. **One PTY authority.** Only the terminal runtime owns an Agent Run's PTY, process lifetime, attach/detach, and resize.
4. **Native windows first.** Hyprland arranges terminal windows. The Omarchestra Companion Plugin does not embed or render terminals.
5. **Structured observability.** Agent state comes from a bridge inside the visible agent, not ANSI/PTY scraping.
6. **Thin desktop shell.** QML renders projections and sends intents. It does not supervise children, schedule work, enforce Git safety, or own durable state.
7. **Replaceable terminal runtime.** Boomux is the prototype implementation of a narrow runtime port, not the product's domain model.
8. **Honest state.** The UI distinguishes observed facts, inferred state, and unavailable telemetry. It must not fabricate transcripts, progress, isolation, or resumability.
9. **Node-local execution authority.** The selected execution Node owns its Project, Team Runner, agent bridges, validation, artifacts, and durable workflow state. The local desktop consumes projections and sends acknowledged intents.
10. **Installation is not a Team Goal.** An explicitly installed Omarchestra companion plugin is durable product infrastructure. Team Goals own ephemeral Projection Sessions and never install, register, copy, or unload QML.
11. **Observation is not management.** A visible Pi started outside Omarchestra may report structured lifecycle facts, but discovery grants no role, assignment, writer, PTY, or process authority. Management begins only through explicit Adoption.

## MVP architecture

```text
Omarchy shell
└── Installed Omarchestra Companion Plugin
    ├── bar indicator
    ├── Agent Console
    └── create/control/focus/adopt intents
              │
              │ ephemeral Projection Session
              │ snapshot + ordered events + intents
              ▼
Team Runner / Agent Registry (our process)
├── durable Team Goal state
├── observed, unassigned Pi sessions
├── workflow/orchestration state machine
├── writer policy
├── artifact and validation records
├── presentation projection
├── managed Pi bridge connections
├── ordinary-terminal Pi observer connections
└── TerminalSessionRuntime port
              │
              ▼
BoomuxRuntime adapter
└── Boomux daemon
    └── one Workspace per Team Goal
        ├── Coordinator Shell → native terminal → visible interactive Pi
        ├── Builder Shell     → native terminal → visible interactive Pi
        └── Reviewer Shell    → native terminal → visible interactive Pi

Ordinary Omarchy terminal → visible interactive Pi
                           └── observer extension → Observed Pi Session
```

For a local Team Goal, the Team Runner and Boomux owner are local. For a remote Team Goal, the execution runner, bridge sockets, repository, validation, and durable state live on the selected remote Node; the local desktop reaches them through authenticated SSH transports. The detailed locked boundary is [`remote-execution.md`](remote-execution.md).

### Authority boundaries

| Concern | Authority |
| --- | --- |
| Team Goals, roles, assignments and workflow | Team Runner on the selected execution Node |
| Structured status, tool activity and agent messages | Bridge in the visible Pi process |
| PTY, process, attach/detach and terminal resize | Terminal runtime (Boomux in MVP) |
| Conversation and model-session semantics | Visible Pi process |
| Checkout contents and Git history | Git on the selected execution Node |
| Presentation and user intents | Installed local Omarchestra Companion Plugin |
| Ordinary Pi lifecycle facts | Observer extension inside that visible Pi process |
| Adoption of an observed session | User confirmation plus exact same-process acknowledgement and Team Runner commit |
| Product installation and removal | Explicit setup/uninstall workflow, never a Team Goal |

No authority derives canonical state by scraping another authority's presentation output. Plugin presence does not imply a live Projection Session, and observation does not imply management.

## Terminal runtime boundary

**Locked.** The prototype uses Boomux without forking it. Boomux remains a separately installed dependency and is accessed through its stable CLI/capability surface.

The Team Runner stores Boomux identifiers only as opaque foreign references:

```json
{
  "runtime": "boomux",
  "workspaceRef": "opaque",
  "terminalRef": "opaque",
  "processRunRef": "opaque"
}
```

Our UI and orchestration model do not expose Boomux entities directly.

The conceptual runtime port is intentionally narrow:

```text
capabilities()
create(session specification) -> terminal session reference
present(reference)
inspect(reference) -> lifecycle state
close(reference)
subscribe(references, cursor) -> ordered lifecycle events
```

The runtime owns terminal lifecycle only. It does not own Team Goals, role semantics, assignments, messages, artifacts, or Fusion workflows.

A future runtime may replace `BoomuxRuntime` without changing Team Goal or QML semantics. Because remote execution is in MVP scope, a complete replacement must provide Node identity, remote projection/transport, and exact attachment semantics in addition to local PTY persistence.

### Evidence-backed local Boomux contract

The completed [`Boomux runtime-adapter spike`](../../spikes/boomux-runtime-adapter/README.md) establishes for Boomux 1.8.0/protocol 49:

1. Capability negotiation, daemon availability, snapshots, lifecycle events, typed errors, and cursor recovery are available through validated `boomux.cli/v1` envelopes.
2. Workspace/Shell creation, generic presentation, and exact-ID cleanup require version-pinned non-JSON commands followed by JSON postcondition reconciliation. Human output is never an identity source.
3. One Workspace and three role Shells can be mapped behind Omarchestra-generated opaque references without importing Rust modules, reading private Boomux state, or exposing Boomux entities to the UI/domain.
4. Closing a native terminal detaches presentation while the daemon-owned PTY, exact Run, and PID survive. Re-presenting the tested Builder returned to the same Run and PID without affecting siblings.
5. Attachment presence is unavailable through public snapshots/events and must remain `unavailable`, not inferred.
6. Lifecycle events are ordered within one opaque stream cursor. Cursor expiry or cold stream replacement requires a fresh snapshot/reconciliation boundary.
7. Cleanup authority comes from durable exact-ID ownership records and readback. Names, prefixes, focus, current selection, or wildcard/global operations never authorize destruction.
8. Generic `boomux open` lacks an atomic expected-Run guard. Pre/post inspection detects replacement but cannot prevent the exit-and-restart race. Production must represent this risk, obtain a guarded public operation, or select another runtime.
9. The local result does not establish remote Node behavior; that receives a separate spike.
10. Prototype files remain evidence and are not promoted directly into production.

## Visible agent bridge

**Locked; feasibility supported with constraints by the Pi 0.84.4 spike.** Every managed Pi terminal runs the same interactive Pi TUI the user sees, plus our bridge extension.

The bridge:

- identifies its Agent Run and terminal runtime binding;
- reports lifecycle transitions;
- reports current task and tool activity when Pi exposes them;
- reports attention/blocking conditions;
- reports model and context telemetry when available;
- publishes explicit agent-authored orchestration messages;
- receives assignments and orchestration control messages;
- reports submitted human input and manual-control transitions;
- produces a structured handoff when returning from manual control;
- reconnects to the Team Runner after a plugin or runner restart.

The bridge must not launch a hidden second agent to perform the assignment.

A structured control/telemetry channel is acceptable. Hidden execution is not.

### Evidence-backed Pi bridge contract

The completed [`visible Pi bridge spike`](../../spikes/pi-visible-bridge/README.md) establishes:

1. Managed assignment delivery uses `pi.sendUserMessage()` from an extension loaded into the visible interactive host process. It does not create an SDK session, spawn Pi, use RPC mode, or inject PTY input.
2. Handshake identity includes protocol version, Agent Run ID, Pi session ID, extension instance ID, host PID, and verified TUI mode.
3. Assignments have stable IDs and explicit `accepted`, `busy`, `duplicate`, or `invalid` acknowledgements.
4. Submitted ordinary TUI input is observable as `input.source === "interactive"` and excludes extension-originated assignment delivery. Slash commands and user-bash remain explicit coverage gaps.
5. Events have stable IDs and monotonically increasing per-extension sequence numbers. Reconnection supplies a state snapshot; it does not imply durable replay or exactly-once delivery.
6. Runner restart recovery is supported while the same visible Pi process and extension instance survive. Pi/extension restart and reboot recovery remain outside the MVP guarantee.
7. Extension-owned confirmation prompts can report attention. Native Pi, provider, authentication, permission, and unknown conditions retain the terminal-owned fallback until individually proven.
8. Production telemetry omits tool-result bodies and thinking content, applies an explicit user/assistant content policy, and coalesces or discards token-level streaming deltas before durable storage or QML projection.
9. The spike implementation is evidence only. No prototype file is promoted directly into production.

Production message schemas, socket trust/permissions, durable cursor semantics, reconnect reconciliation, and compatibility policy remain open technical-contract work.

### Ordinary-terminal Pi observation

**Locked.** The complete terminal behavior is specified in [`pi-terminal-behavior.md`](pi-terminal-behavior.md). Product setup may install one opt-in global Omarchestra observer extension for Pi. When a user starts a visible interactive Pi in an ordinary terminal, outside an Omarchestra/Boomux-managed ShellRun, the extension may connect to the local owner-only Agent Registry and publish privacy-bounded structured lifecycle facts.

An ordinary session appears in the Agent Console as an **Observed Pi Session** under **Unassigned Agents**. It is not an Agent Run, has no Role or Assignment, and grants Omarchestra no writer, workflow, PTY, terminal, process-lifecycle, or input authority. Omarchestra does not scrape or project its conversation. Failure to connect is fail-open for Pi and visibly unavailable to Omarchestra.

An observed session becomes managed only through **Adoption**: the user selects the exact current session, chooses a Team Goal on the session's Execution Node and an unoccupied Role, confirms the action, and the extension inside that same visible Pi process acknowledges the proposed binding. The Team Runner then reconciles current activity and commits the new Agent Run before dispatching work. Node-mismatched, unknown, stale, busy, exited, already-managed, role-conflicting, or unacknowledged sessions fail closed. Discovery, focus, recency, PID alone, terminal title, cwd, or equal names never authorize Adoption. For the MVP, ordinary-terminal observation is local to the Omarchy Node, so these sessions may enter local Team Goals only.

The observer reports lifecycle and identity metadata only under an explicit telemetry policy. Initial MVP observation excludes prompts, responses, tool-result bodies, thinking, credentials, terminal output, and repository contents. Product setup and uninstall own observer installation; a Team Goal never installs or removes it.

## Domain model

### Execution Node

An Omarchestra-owned identity and connection profile for one machine capable of owning Projects and Agent Runs. The local Omarchy machine is one Execution Node; an MVP Team Goal may instead select one preconfigured remote GNU/Linux Node. SSH routes and Boomux Node IDs remain opaque transport/runtime references.

### Project

A canonical Git repository identified by `(execution_node_id, canonical_absolute_path)`. A path is never copied to or inferred for another Node.

### Team Goal

One durable orchestration attempt for a user goal in a Project. It selects exactly one Execution Node at creation and owns the workflow, roles, assignments, artifacts, runtime bindings, and outcome record on that Node.

### Role

A declared responsibility within a Team Goal, such as Coordinator, Builder, or Reviewer.

### Team Profile

A named, versioned YAML configuration that binds the fixed MVP roles to Pi models, thinking levels, and role prompt configuration. The Create Team Goal form selects a Team Profile rather than constructing an arbitrary per-role model stack.

The profile is validated before any terminal is created. At Team Goal creation, the Team Runner persists the fully resolved effective profile; later YAML edits affect only future Team Goals.

The exact schema is part of the runner configuration contract, but follows Fusion Harness's explicit model-stack approach. Conceptually:

```yaml
schema: visible-agents/team-profile/v1
name: default
roles:
  coordinator:
    model: provider/model
    thinking: medium
    prompt: prompts/coordinator.md
  builder:
    model: provider/model
    thinking: medium
    prompt: prompts/builder.md
  reviewer:
    model: provider/model
    thinking: medium
    prompt: prompts/reviewer.md
validation_default:
  mode: review_only
```

### Validation Policy

The explicit evidence policy for accepting one Team Goal. The Team Profile supplies a default and the user confirms or changes it when creating the goal.

The MVP supports exactly two modes:

- `review_only` — required for research, planning, documentation, and other judgment-based work. Coordinator records acceptance criteria; Reviewer returns a structured accepted/rejected verdict with findings. A successful outcome is labelled **Reviewed**.
- `review_and_command` — used for coding or mechanically testable work. The same structured review is required, then the runner executes a configured deterministic command as a normal non-agent subprocess. Both gates must pass. A successful outcome is labelled **Verified**.

There is no unqualified `none` mode. A command result never substitutes for semantic review, and review-only work is never described as mechanically verified.

### Agent Run

One exact visible harness process performing one Role. An Agent Run is managed by a Team Runner and bound to one exact visible Pi process and, when available, one Pi model-session identity. Omarchestra-launched runs also have a terminal Runtime Binding; an adopted ordinary session need not gain PTY authority. An Observed Pi Session is not an Agent Run until Adoption commits.

### Observed Pi Session

One visible interactive Pi session that reports structured lifecycle facts but is not assigned to a Team Goal. It remains observable, unassigned, and unmanaged and carries no Runtime Binding guarantee.

### Adoption

The explicit transition from one exact current Observed Pi Session to an Agent Run in a selected Team Goal on the same Execution Node and an unoccupied Role. Adoption requires user confirmation, same-process acknowledgement, reconciliation, and a durable Team Runner commit.

### Companion Plugin

The versioned Omarchestra-owned QML product surface explicitly installed and enabled through Omarchy's supported third-party plugin mechanism. It persists across Team Goals and owns presentation only.

### Projection Session

An ephemeral presentation relationship between the Companion Plugin and one local or remote projection source. It carries snapshots, ordered events, and acknowledged intents and can reconnect or clear without installing or unloading the Companion Plugin.

### Agent Control Mode

The authority mode for one Agent Run:

- `managed` — the Team Runner may dispatch work according to the workflow;
- `manual_takeover` — the user is directly steering the visible agent and automatic dependent dispatch is paused;
- `reconciling` — manual work has ended, but its handoff and effect on the current Assignment have not yet been accepted, resumed, or retried.

Control mode is distinct from terminal, agent, and assignment lifecycle.

### Assignment

A unit of work routed by the Team Runner to one Agent Run. It has explicit input, write authority, dependencies, state, and expected output. Work affected by manual takeover is marked `needs_reconciliation`; it is never silently treated as completed or failed.

### Agent Event

An ordered structured fact reported by the bridge or terminal runtime. Examples: connected, assignment-started, tool-started, attention-required, assignment-completed, process-exited.

### Artifact

A durable output accepted from an Assignment: plan, implementation summary, review, validation result, or integrated result. An Artifact is not a terminal transcript.

### Runtime Binding

Opaque references connecting an Agent Run to the terminal runtime. Runtime bindings are replaceable infrastructure metadata.

### Task Capsule

**Deferred.** A future durable restart recipe containing the goal, accepted artifacts, remaining assignments, runtime/session references, and verification state. It is not a serialized live process.

The MVP persists the underlying Team Goal, assignments, accepted artifacts, ordered events, workflow stage, and runtime/session references. Recent Goals may reopen surviving terminals or retry from the latest accepted state, but the MVP does not promise portable context reconstruction or a guaranteed Capsule resume recipe.

## MVP workflow

**Locked.** The MVP supports one fixed three-role workflow:

```text
1. Coordinator receives the Team Goal and produces a plan with explicit acceptance criteria.
2. Builder receives the goal plus accepted plan and performs the work.
3. Reviewer receives the goal, plan and produced artifacts, then reviews read-only against the acceptance criteria.
4. Builder receives required corrections, if any, within a bounded retry count.
5. In `review_and_command` mode, the runner executes the configured deterministic command; failure returns to the correction loop.
6. Coordinator automatically receives the accepted review and applicable command evidence, then produces the integrated result.
7. The Team Goal completes automatically as **Reviewed** or **Verified** according to its Validation Policy; no final user approval click is required.
```

All three agents are created and presented as visible native terminal windows at Team Goal start so the user can see the entire playing field. Agents waiting on a dependency remain open and show a truthful `waiting` state. Closing a waiting window detaches its terminal without ending the Agent Run; the console can present it again.

### Write policy

**Proposed.** The MVP uses one shared checkout and grants write authority only to Builder. Coordinator and Reviewer are read-only by orchestration contract. The Team Runner owns the writer invariant.

This avoids worktree creation, branch integration, and merge-conflict policy in the first release.

## Agent lifecycle states

**Proposed.** The normalized MVP states are:

- `starting` — terminal process is being created;
- `connecting` — process exists but its bridge has not completed the handshake;
- `waiting` — connected and waiting on a dependency or assignment;
- `working` — actively executing an assignment;
- `needs_attention` — waiting for user action or approval;
- `completed` — current assignment completed successfully;
- `failed` — assignment or agent process failed;
- `cancelled` — intentionally stopped;
- `disconnected` — terminal process may exist but structured telemetry is unavailable;
- `exited` — terminal process ended.

Terminal lifecycle and assignment lifecycle remain distinct internally even when the UI presents a combined status.

## Human intervention

**Locked.** Visible agents remain genuinely interactive throughout the MVP.

An Omarchestra-launched Agent Run begins in `managed` control mode. An ordinary-terminal Pi remains an Observed Pi Session with no Agent Control Mode until Adoption completes; observation alone never enters `managed`.

1. An Agent Run begins in `managed` control mode only after managed launch or committed Adoption.
2. The user may explicitly choose **Take control**, or may submit input directly in the native terminal.
3. Observed human input during managed work transitions the Agent Run to `manual_takeover`.
4. The Team Runner pauses new assignments to that Agent Run and all dependent workflow stages. It does not silently kill a running model/tool action.
5. The affected Assignment becomes `needs_reconciliation`, not completed or failed.
6. The user explicitly chooses **Return to team** when manual work is finished.
7. The visible agent produces a structured handoff describing work performed, changed artifacts, and its claimed Assignment status.
8. The Agent Run enters `reconciling`. No dependent work is dispatched until an explicit `accept`, `resume`, or `retry` action is durably recorded.
9. Acceptance remains subject to the Assignment's validation and writer-safety policy.

Direct terminal interaction and console-initiated takeover have the same durable semantics. Unsubmitted keystrokes do not constitute takeover; a submitted user message or explicit control action does.

## Approval and attention boundary

**Locked.** Attention is classified by the authority capable of resolving it.

### Runner-owned attention

The Agent Console may resolve only decisions represented by the Team Runner's validated intent protocol:

- accept, resume, or retry reconciled manual work;
- retry or cancel an Assignment;
- acknowledge an orchestration notification;
- approve progression to the next workflow stage when the workflow requires it.

### Agent-owned attention

The native terminal must resolve interaction owned by Pi or the underlying harness:

- tool permission prompts;
- authentication;
- harness/model questions;
- interactive commands;
- any condition not represented by the bridge's structured protocol.

For agent-owned or unknown attention, the console reports `needs_attention` and presents/focuses the exact terminal. It may acknowledge the desktop notification, but cannot claim the underlying condition is resolved. The MVP never injects terminal keystrokes to answer prompts.

## Omarchy UI scope

### Installation and runtime boundary

**Locked.** Omarchestra follows Boomux's companion-plugin model. An explicitly authorized `omarchestra setup`-class workflow installs, validates, and enables one versioned Omarchestra Companion Plugin through Omarchy's supported third-party plugin mechanism and may reload the shell after showing the exact plan. A matching uninstall workflow removes only unchanged Omarchestra-owned assets and configuration entries.

Installation is persistent product state and may write the normal Omarchy plugin/configuration locations with explicit human consent. Normal Team Goal and Projection Session operations do not install, copy, link, register, enable, update, or unload QML and do not write `shell.json`. The already-installed plugin opens, hides, clears, and reconstructs ephemeral Projection Sessions from authoritative snapshots and events.

The rejected per-run repository-local loader and its candidate upstream patch remain spike evidence, not an MVP dependency. Omarchestra will not require or submit an upstream Omarchy feature for this surface. A fourth terminal dashboard remains unnecessary while the supported companion-plugin path is available.

### Evidence-backed Companion Plugin prototype contract

The removable first vertical slice now establishes, with fake-only automated evidence:

1. `omarchestra.companion/v1` capability discovery is bounded and fails closed before a runner connection on an absent plugin, foreign protocol, missing capability, or stale plugin generation.
2. Exact compatibility is initially pinned to Omarchy `4.0.2-1` and Quickshell `0.3.1-1`; unknown versions fail before mutation.
3. Installation inspection is read-only and produces an immutable digest-bound plan. Install, update, rollback, and exact uninstall require authorization for that exact plan and revalidate filesystem, receipt, and configuration preconditions.
4. Symlinks, unsafe ownership or modes, malformed or conflicting configuration, foreign targets, and missing, extra, changed, or receipt-inconsistent assets fail closed. Recovery does not overwrite external drift and reports incomplete recovery explicitly.
5. One installed plugin remains enabled across multiple Team Goals. Each open receives a distinct ephemeral Projection Session and starts from a validated authoritative snapshot.
6. Ordered updates, reconnect, resnapshot, acknowledged intents, and stale-session handling stay in the reused non-QML projection core and adapter. QML renders plain committed values and emits presentation intents only.
7. Fake plugin reload rejects the old generation, creates a fresh Projection Session, and reconstructs identical cards without changing fake agent identities, connections, assignments, or delivered turns.
8. Runtime hide, clear, and cleanup perform no installation operation and leave installed assets, receipt, and `shell.json` bytes identical.
9. Automated recipes, Fusion reachability, module imports, and QML authority are source-audited as fake-only. The human setup procedure is reachable in automation only through `--check` and static analysis.

The contract and evidence are under [`prototypes/first-vertical-slice/`](../../prototypes/first-vertical-slice/). This closes the bounded Companion packaging/Projection Session milestone only. The live procedure has not been run, and this evidence does not promote the prototype to production.

### Bar indicator

**Proposed.** Show:

- active Team Goal count;
- working agent count;
- attention/failure indicator;
- action to open the Agent Console.

### Agent Console

**Proposed.** The MVP console contains:

1. **Team Goal list** — active and recent goals with overall state.
2. **Team Goal detail** — goal text, workflow stage and final outcome.
3. **Agent cards** — persistently visible role and control state, model, current assignment, elapsed time, latest structured event, and attention. These cards are the redundant team-wide role/state surface for the decorationless native terminals.
4. **Unassigned Agents** — Observed Pi Sessions from ordinary terminals, visibly labelled observed/unmanaged with available lifecycle metadata and no fabricated Role, Assignment, PTY persistence, or control authority.
5. **Agent actions** — present/focus exact managed terminal, take control, return to team, reconcile manual work, resolve runner-owned approvals, acknowledge notifications, cancel where safe, and explicitly adopt an eligible observed session. Agent-owned approvals redirect to the terminal.
6. **Structured activity feed** — ordered orchestration and agent events, not a scraped transcript.
7. **Create Team Goal form** — Execution Node, Node-qualified Project, goal, validated YAML Team Profile, and Validation Policy. Resolved role/model assignments are shown before launch; `review_and_command` also requires a command.

Context usage and cost are displayed only if Pi exposes reliable values through the bridge.

### Native terminal behavior

**Locked.** Clicking an Agent card presents or focuses the exact native terminal bound to that Agent Run. Closing the terminal window must not kill the agent process. Reopening reconnects to the same process while it remains alive.

Agent windows remain decorationless and visually native to Omarchy. Each managed visible Pi TUI persistently shows `<Role> · <state>` through the bridge-owned Pi status surface, while the Agent Console persistently repeats role and state across the team. The bridge also publishes `Omarchestra — <Role> — <state>` as dynamic terminal-title metadata for Hyprland, launchers, and window switchers, but title metadata is not treated as persistently visible chrome or as an independent acceptance surface.

An Observed Pi Session displays `Unassigned · observed` in Omarchestra's named Pi status slot without replacing other extension statuses and retains its ordinary terminal title. Omarchestra may focus a currently correlated ordinary terminal as a presentation convenience, but it does not promise Boomux persistence, reattachment, resize, process control, or exact terminal recovery; Adoption alone does not grant PTY authority or fabricate a managed Runtime Binding.

## Persistence and recovery

### Required for MVP

- Closing or reopening an agent terminal does not terminate the visible Pi process.
- Reloading/restarting the installed Companion Plugin does not interrupt agents; it creates a new Projection Session and reconstructs presentation.
- The Team Runner persists Team Goals, assignments, events, artifacts, workflow state, and runtime bindings.
- After plugin restart, the console reconstructs itself from a runner snapshot plus ordered events.
- After Team Runner restart, it reconstructs its durable projection and reconnects to surviving visible agents.
- A remote Team Runner retains goals, events, artifacts, writer authority, and agent bridges when local terminal windows or SSH presentation disconnect.
- SSH loss marks the remote Node and affected Agent Runs disconnected or stale; reconnection uses identity verification, a durable snapshot, and retained ordered events or an explicit history gap.

### Proposed degraded recovery rule

If the Team Runner restarts during an in-flight assignment, it does not guess whether an unrecorded step completed. The Team Goal enters `needs_attention` until the visible agent reconnects and the user or workflow explicitly resumes/retries.

### Deferred

- Automatic continuation after a full machine reboot
- Transparent model-context restoration when the underlying harness cannot resume
- Boomux daemon replacement guarantees beyond what the selected Boomux version provides

## MVP safety rules

1. At most one Assignment has write authority for a Project checkout.
2. Read-only roles receive an explicit no-write contract; enforcement strength must be represented honestly.
3. The Team Runner never sends a new assignment to an Agent Run already marked working unless the workflow explicitly supports interruption.
4. A terminal process exit and an assignment failure are recorded separately.
5. Cancellation is idempotent.
6. Ordered events have stable IDs/cursors so QML reloads do not duplicate or omit state transitions.
7. The Agent Console does not claim offline/network isolation in the MVP.
8. Submitted human input during managed work is durably recorded and triggers `manual_takeover`.
9. Manual takeover pauses dependent dispatch but does not silently terminate an in-flight model/tool action.
10. Work affected by takeover remains `needs_reconciliation` until an explicit action is recorded.
11. Returning control requires a structured agent handoff.
12. `accept`, `resume`, and `retry` are explicit idempotent reconciliation actions; validation policy still applies after `accept`.
13. The console resolves only runner-owned attention represented by validated intents.
14. Agent-owned or unknown attention is resolved in the native terminal; the console never answers it through PTY input injection.
15. Every Team Goal requires structured Reviewer acceptance; no validation mode may bypass review.
16. A deterministic command is required only in `review_and_command` mode, runs as a non-agent subprocess, and cannot by itself mark a goal accepted.
17. The UI labels successful `review_only` outcomes **Reviewed** and successful `review_and_command` outcomes **Verified**.
18. Team Goal runtime paths never install, enable, update, or unload the Companion Plugin and never write Omarchy configuration.
19. An Observed Pi Session is visibly unassigned and receives no Assignment, Role, writer authority, input, or process action before exact acknowledged Adoption commits.
20. Observer telemetry excludes conversation and terminal content and fails open for the visible Pi process.

## Explicitly deferred

- Integrated split-pane terminal renderer
- Hidden/headless agent execution
- Non-Pi harnesses
- One Team Goal spanning multiple Execution Nodes
- Cross-Node writer coordination
- Automatic remote host provisioning or repository/credential synchronization
- Windows or macOS execution Nodes
- Public remote network listeners
- Per-agent worktrees
- Parallel write-enabled agents
- Automated branch integration
- Arbitrary user-authored workflow DAGs
- Rich cross-agent chat/transcript aggregation
- Terminal-output scraping
- Full reboot recovery
- Network sandboxing/offline mode
- Mobile/web clients
- Replacing Boomux with our native PTY daemon
- Named Task Capsules with portable or guaranteed context reconstruction
- Forking Boomux

## Draft acceptance criteria

The MVP is demonstrable when:

1. A user opens the Agent Console from the Omarchy bar and creates a Team Goal for a Node-qualified local or remote Git Project.
2. The system creates the configured visible interactive Pi agents in decorationless native terminal windows tiled by Hyprland; each Pi status persistently exposes its role and managed/waiting/takeover state without relying on conversation content, and the Agent Console redundantly shows the same team-wide projection.
3. No hidden agent process performs work on behalf of those visible agents.
4. The console shows each Agent Run's role, current assignment and normalized state from structured bridge events.
5. Selecting an Agent Run focuses or reopens its exact terminal.
6. Closing a terminal and reopening it reconnects to the same still-running Pi process.
7. The fixed workflow produces plan, implementation, review and integrated-result artifacts.
8. Only Builder receives write authority during the workflow.
9. Attention, process failure and assignment failure are visibly distinguishable.
10. Restarting the installed Companion Plugin reconstructs the same Team Goal projection without interrupting agents.
11. Restarting the Team Runner preserves recorded state and safely reports uncertain in-flight work rather than guessing.
12. Cancelling a Team Goal stops further assignment dispatch and reaches a stable recorded outcome.
13. Submitting a user message to a managed visible agent pauses dependent orchestration and records manual takeover.
14. Returning the agent to the team requires a visible structured handoff and an explicit accept, resume, or retry decision before dependent work continues.
15. A runner-owned approval can be completed from the console, while an agent-owned approval visibly redirects the user to the exact native terminal.
16. A `review_only` goal cannot complete without a structured accepted review and is labelled Reviewed.
17. A `review_and_command` goal cannot complete unless both structured review and deterministic command succeed and is labelled Verified.
18. After its required gates pass, Coordinator integration and Team Goal completion proceed automatically without a redundant final user approval.
19. For a remote goal, all three agents and the Team Runner execute on one preconfigured non-Omarchy GNU/Linux Node while their native terminal windows render locally.
20. Closing local windows or interrupting SSH does not terminate remote agents or discard durable workflow state.
21. Reconnection restores the same Node-qualified Team Goal, Agent Runs, and exact surviving terminal attachments, or reports a truthful stale/gap/uncertain state.
22. An explicit setup installs and enables the versioned Companion Plugin once; creating, running, cancelling, and cleaning up Team Goals causes no plugin or Omarchy-configuration mutation.
23. Starting Pi in an ordinary local Omarchy terminal with the opt-in observer installed produces an Observed Pi Session under Unassigned Agents without granting management authority or exposing conversation content.
24. Adopting that session requires exact same-process acknowledgement and user confirmation; stale or unacknowledged adoption changes neither the Pi session nor Team Goal.

## Implementation readiness

Status: **MVP product scope and the local/remote feasibility classifications are locked; the Companion vertical slice is complete fake-only, while remaining production technical contracts are not ready for an end-to-end implementation run.**

Before delegating broad implementation to Fusion Harness, the project still needs:

1. validate opt-in ordinary-terminal Pi observation and exact acknowledged Adoption without granting premature authority;
2. resolve the product policy or runtime capability for Boomux's generic exact-Run presentation race;
3. define production runner/bridge/observer snapshot, event, intent, SSH trust, deployment, and persistence contracts;
4. convert validated prototype slices into milestone-sized production implementation slices with executable acceptance gates.

The separate Companion human procedure remains optional pending live evidence. Its unexecuted status is not an invitation to revive the rejected temporary-loader path.

Fusion Harness is a source of orchestration behavior and a tool for reviewing/building the new product. The new product should not be implemented directly inside the `fusion-harness` repository unless an explicit monorepo decision is made.

### Fusion readiness review

On 2026-08-30, the `sol`, `terra`, and `luna` Fusion stack independently reviewed this document for implementation blockers. All three agreed that the architecture is coherent but not yet implementation-ready. Their strongest shared finding was that **human intervention semantics were the highest-risk unresolved product decision**: unrestricted terminal input could make managed assignment state, artifact acceptance, cancellation, and retry claims untruthful. The locked Human intervention section now resolves that product-level ambiguity; concrete bridge events and reconciliation schemas remain part of the Pi bridge technical contract.

Preserved evidence:

- [`prompt.md`](../reviews/2026-08-30-implementation-readiness/prompt.md)
- [`sol.md`](../reviews/2026-08-30-implementation-readiness/agents/sol.md)
- [`terra.md`](../reviews/2026-08-30-implementation-readiness/agents/terra.md)
- [`luna.md`](../reviews/2026-08-30-implementation-readiness/agents/luna.md)
- [`summary.json`](../reviews/2026-08-30-implementation-readiness/summary.json)

## Product decision status

All MVP product-scope decisions and feasibility classifications are locked. The bounded Companion Plugin packaging and Projection Session prototype milestone is complete fake-only. Remaining work is confined to the production technical contracts below and the separate observer/Adoption slice.

## Accepted vertical-slice prototype defaults

These defaults are intentionally reversible and do not yet constitute production architecture decisions:

1. Build one narrow vertical slice before the full DAG workflow: three visible role-labelled Pi terminals, durable runner state, one managed assignment, takeover detection, and reconnect.
2. Use TypeScript on Node 22+ for the runner, adapters, and control protocol prototype.
3. Use SQLite with explicit transactions as the persistence candidate. Journal mode remains unlocked; default journaling and WAL must be compared against the actual single-writer workload.
4. Use versioned NDJSON over owner-only Unix sockets locally and authenticated SSH stdio remotely.
5. Run the Node-local prototype runner as a systemd user service and keep the explicitly installed Companion Plugin as a thin QML presentation client. Projection Sessions, not plugin installation, are the runtime lifecycle.
6. Keep agent Ghostty windows decorationless. Show role plus managed/waiting/takeover state persistently in the Pi status surface and redundantly in Agent Console cards; publish the same identity as dynamic terminal-title metadata for window-manager integrations without treating it as persistent chrome.
7. Keep Team Profile model selection replaceable. Extra provider authentication and the final Luna/Sol/Reviewer model stack are not prerequisites for this vertical slice.

## Open technical contracts

These are specification/spike outputs rather than product-feature choices, but each must be closed before its implementation milestone begins:

1. **Project boundary:** repository is locked at `~/claude/omarchestra`; the accepted prototype toolchain must be validated before languages, packaging, IPC transport, and service startup become production commitments.
2. **Runner persistence and protocol:** SQLite is the prototype candidate, but transaction boundaries, journal mode, snapshot/event/intent schemas, cursor ordering, deduplication, acknowledgement, migrations, and retention remain open.
3. **Pi bridge, observer, Adoption, and presentation fan-out:** managed-bridge feasibility is closed as supported with constraints. Production work remains for the opt-in global observer's installation and privacy policy, exact observed-session identity and retention, ordinary-terminal correlation, reconnect, same-process Adoption acknowledgement, busy/stale conflicts, reconciliation into a Role, socket trust/permissions, exact schemas, durable replay/cursors, telemetry filtering/coalescing, slash-command and user-bash policy, attention coverage, compatibility, and one committed role/state value reaching Pi status, title metadata, and Agent Console cards without stale divergence.
4. **Boomux adapter:** local feasibility is closed as supported with constraints. Production work remains for the generic exact-Run presentation race, version-pinned weak mutation commands, attachment-state unavailability, compatibility policy, and remote Node evidence.
5. **Remote execution:** Node identity, prerequisite/deployment policy, authenticated SSH stdio protocol, remote runner lifecycle, durable projection replay, disconnection semantics, and Node-qualified runtime routing.
6. **Checkout safety:** dirty-checkout policy, concurrent Team Goals for one Project, strength of read-only enforcement, writer lease scope, and Builder commit policy.
7. **Cancellation and failure:** interruption behavior, process termination policy, timeouts, bounded retries, preservation of terminals, and separation of process and assignment failure.
8. **Artifact acceptance:** schemas for plan, implementation, review, corrections, validation, and integrated result; acceptance authority for each artifact.
9. **Recovery actions:** definition and idempotency of resume/retry, plus how a reconnected visible agent proves the status of uncertain work.

### Closed prototype technical milestone

- **Companion Plugin packaging and Projection Sessions:** the bounded prototype now covers explicit plan-bound setup/update/rollback/uninstall, owned-asset and configuration validation, exact compatibility negotiation, incomplete recovery, persistent installation across Team Goals, stale-generation rejection, authoritative reconstruction, acknowledged intents, and byte-identical runtime cleanup. Production packaging, broader compatibility, and live rendering evidence remain separate from this closed prototype milestone.

## Decision log

- 2026-08-30: Native Omarchy/Hyprland terminal windows selected over an integrated split-pane renderer.
- 2026-08-30: All working agents must be visible interactive processes; hidden Pi JSON workers rejected.
- 2026-08-30: Own QML plugin and Team Runner selected; giant QML implementation rejected.
- 2026-08-30: Boomux selected as the prototype terminal runtime through a narrow adapter; forking rejected.
- 2026-08-30: Future replacement by a minimal native PTY daemon remains an explicit option.
- 2026-08-30: Structured bridge telemetry selected over PTY/transcript scraping.
- 2026-08-30: Human intervention locked as managed → manual takeover → structured handoff → explicit reconciliation; dependent workflow dispatch pauses during takeover and reconciliation.
- 2026-08-30: MVP workflow locked as Coordinator plan → Builder implementation → read-only Reviewer → bounded Builder correction → Coordinator integration.
- 2026-08-30: All required agent terminals open at Team Goal start; waiting agents remain visible to show the full playing field.
- 2026-08-30: Role/model configuration locked to named YAML Team Profiles modeled after Fusion Harness stacks; the resolved profile is snapshotted per Team Goal and no arbitrary per-role picker is included.
- 2026-08-30: Approval authority locked: the console resolves runner-owned structured decisions; Pi/harness-owned and unknown attention must be resolved in the exact native terminal, without PTY keystroke injection.
- 2026-08-30: Named Task Capsules deferred; MVP durability retains goals, assignments, accepted artifacts, events, workflow stage, and runtime/session references without promising portable context reconstruction.
- 2026-08-30: Validation locked to `review_only` and `review_and_command`; both require structured Reviewer acceptance, only the latter requires a deterministic command, and outcomes are labelled Reviewed versus Verified.
- 2026-08-30: Goal completion locked as automatic Coordinator integration after required gates pass; no redundant final user approval is required.
- 2026-08-30: All MVP product-scope decisions are locked; feasibility spikes and technical contracts remain.
- 2026-08-30: Product name and target workspace locked as **Omarchestra** at `~/claude/omarchestra`.
- 2026-08-30: Visible Pi bridge feasibility classified **supported with constraints** after automated and manual TUI evidence; same-process assignment, observability, takeover, runner reconnect, duplicate rejection, and absence of a hidden child agent were proven.
- 2026-08-30: Single-Node remote execution promoted into locked MVP scope: a Team Goal may execute wholly on one preconfigured remote GNU/Linux Node while Omarchy UI and native terminals remain local. Cross-Node teams, provisioning, and repository synchronization remain deferred.
- 2026-08-30: Local Boomux runtime feasibility classified **supported with constraints** after 61 automated tests and a passed human gate proving native tiling, detach survival, same-Run/same-PID re-presentation, sibling isolation, ordered events, and exact-ID cleanup. The generic public-open race remains unresolved.
- 2026-09-01: One-Node remote execution feasibility classified **supported with constraints** after the controlled human gate; missing persistent role labels became an explicit failed acceptance criterion.
- 2026-09-01: Accepted reversible vertical-slice defaults: TypeScript/Node 22+, SQLite with journal mode deliberately unlocked, versioned NDJSON over Unix sockets/SSH stdio, systemd user service, thin QML, and durable role/state presentation. Final model/provider selection is deferred.
- 2026-09-01: Local human presentation evidence rejected persistent Ghostty title bars: Omarchy's decorationless windows hide title metadata, forced client decorations looked non-native, and narrow tiled titles truncated. The locked visual contract is now Pi status per terminal plus redundant Agent Console cards; dynamic terminal titles remain window-manager metadata only.
- 2026-09-02: The Agent Console installation model was corrected to follow Boomux: explicit setup installs and enables one persistent Omarchestra Companion Plugin; Team Goals own only ephemeral Projection Sessions. Per-run QML registration and an upstream Omarchy loader change were rejected as unnecessary lifecycle coupling.
- 2026-09-02: An opt-in global Pi observer may list ordinary-terminal Pi sessions as Observed and Unassigned, but observation grants no management authority. Exact same-process acknowledgement, user confirmation, reconciliation, and a durable commit are required for Adoption into a Team Goal.
- 2026-09-02: The bounded Companion Plugin vertical slice completed fake-only: exact authorized installation lifecycle, one persistent installation across Team Goals, ephemeral session generations, reload reconstruction, acknowledged intents, presentation-only QML, and byte-identical runtime cleanup are green. The human setup/visual gate exists but was not run; observer and Adoption remain unimplemented.
