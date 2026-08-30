# Boomux + Herdr + Fusion Harness as an Omarchy-native system

Research date: 2026-08-30

## Sources checked

Primary source revisions used for this assessment:

- Boomux [`dc9d733`](https://github.com/gardnmi/boomux/tree/dc9d733f2d3e2642934387ceeecc81ce3f031338)
- Boomux's existing Omarchy plugin [`b1a1d84`](https://github.com/gardnmi/omarchy-boomux/tree/b1a1d844d819604cd78b7ce04815cef20bc79807)
- Herdr [`4a3b04f`](https://github.com/herdrdev/herdr/tree/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c)
- Fusion Harness [`01a3482`](https://github.com/disler/fusion-harness/tree/01a348202482cad0e7d3c34eada180f711aaddd7)
- Installed Omarchy 4.0.1-1 shell documentation and plugin host under `/usr/share/omarchy/shell/`

## Conclusion

The proposed product is feasible as an **Omarchy-native system**, but it should not be implemented as one giant QML plugin.

The strongest architecture is:

1. A Rust daemon owns PTYs, processes, durable runtime state, agent state, and orchestration runs.
2. An Omarchy QML plugin is the desktop control and presentation client.
3. Terminal rendering lives in native terminal clients or a separate purpose-built graphical client, not inside `omarchy-shell`.
4. A Pi adapter supplies Fusion Harness-style multi-model workflows while the daemon remains the lifecycle authority.

This is not a speculative pattern: Boomux already implements most of it and ships an existing companion Omarchy plugin. The proposed system is therefore closer to **an evolution or focused fork of Boomux** than a greenfield Omarchy plugin.

## What Boomux already provides

Boomux already describes itself as persistent workspaces for native terminal windows. Its daemon owns PTYs and child processes; terminal attachments may disconnect without killing the process. It launches native terminal windows through `xdg-terminal-exec`, has coordinated Workspaces, durable Shells, remote Nodes, agent integrations, snapshots/events, a TUI, a web terminal, Hyprland special-workspace presentation, and graceful live PTY handoff.

Sources:

- [Boomux README: product and persistence contract](https://github.com/gardnmi/boomux/blob/dc9d733f2d3e2642934387ceeecc81ce3f031338/README.md)
- [Boomux architecture: product boundary and daemon ownership](https://github.com/gardnmi/boomux/blob/dc9d733f2d3e2642934387ceeecc81ce3f031338/docs/architecture.md)
- [Boomux native terminal follow-up](https://github.com/gardnmi/boomux/blob/dc9d733f2d3e2642934387ceeecc81ce3f031338/docs/native-terminal-follow-up.md)
- [Boomux live PTY handoff](https://github.com/gardnmi/boomux/blob/dc9d733f2d3e2642934387ceeecc81ce3f031338/docs/live-pty-handoff.md)

Important boundary: Boomux explicitly says it is **not an embedded multiplexer**. Its model deliberately has no separate tab, pane, and terminal identity layers. Each Shell is normally rendered by an external native terminal. Boomux uses `portable-pty` for PTYs and a `vt100` shadow parser for reconstruction/read operations, while passing live bytes through to the attached terminal.

### Existing Omarchy implementation

There is already an official companion project, `gardnmi/omarchy-boomux`.

It is an Omarchy `bar-widget` plugin written in QML/JavaScript. The bar widget opens a persistent layer-shell side pane with Workspace, Shell, Agent Session, Agent, Node, update, web, and configuration controls. The pane reserves a screen edge so Hyprland tiles applications beside it. It calls the Boomux CLI with exact argv and validates a machine-readable compatibility contract before making requests.

Sources:

- [Plugin README](https://github.com/gardnmi/omarchy-boomux/blob/b1a1d844d819604cd78b7ce04815cef20bc79807/README.md)
- [Plugin manifest](https://github.com/gardnmi/omarchy-boomux/blob/b1a1d844d819604cd78b7ce04815cef20bc79807/manifest.json)
- [Compatibility contract](https://github.com/gardnmi/omarchy-boomux/blob/b1a1d844d819604cd78b7ce04815cef20bc79807/compatibility.json)
- [QML entry point](https://github.com/gardnmi/omarchy-boomux/blob/b1a1d844d819604cd78b7ce04815cef20bc79807/Panel.qml)
- [Layer-shell side pane](https://github.com/gardnmi/omarchy-boomux/blob/b1a1d844d819604cd78b7ce04815cef20bc79807/SidePane.qml)

This directly proves that a rich, persistent Omarchy control surface is viable. It also demonstrates the correct trust split: the plugin handles desktop presentation; Boomux handles daemon lifecycle, remote routing, authentication, PTYs, and persistence.

## What Herdr contributes

Herdr is a different terminal model. Its server owns workspaces, tabs, pane layouts, PTYs, and recognized agents. Its terminal client renders multiple panes in one host terminal. It exposes pane topology and agent control through a CLI and newline-delimited JSON socket interface.

Useful capabilities not present in Boomux's core model include:

- Workspace → tab → pane topology
- Split, resize, swap, move, zoom, and layout export/apply
- A full terminal multiplexer user experience
- Agent-native prompt/wait/read/send primitives
- Server-owned semantic waits for `working`, `blocked`, `done`, and `idle`
- A broad event subscription interface
- A manifest-based executable workflow plugin system
- Terminal emulation built around vendored `libghostty-vt`

Sources:

- [Herdr concepts](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/docs/next/website/src/content/docs/concepts.mdx)
- [Herdr agent automation](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/docs/next/website/src/content/docs/agent-automation.mdx)
- [Herdr socket interface](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/docs/next/website/src/content/docs/socket-api.mdx)
- [Herdr persistence semantics](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/docs/next/website/src/content/docs/session-state.mdx)
- [Herdr plugin model](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/docs/next/website/src/content/docs/plugins.mdx)
- [Herdr PTY/terminal implementation](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/src/pane.rs)
- [Herdr vendored libghostty-vt build](https://github.com/herdrdev/herdr/blob/4a3b04f59ba3b7d8a15cea187b23e1e80c343b0c/build.rs)

Herdr's plugin system is unrelated to Omarchy's: Herdr plugins are arbitrary executable workflows declared by TOML. They can have build commands, actions, event hooks, and terminal pane entry points. Omarchy plugins are QML loaded inside `omarchy-shell`.

## What Fusion Harness contributes

Fusion Harness is not a PTY/session manager. It is a Pi extension implementing multi-model orchestration.

Its useful product concepts are:

- Two to five named model slots
- Architect and primary-builder roles
- Independent read-only opinions
- N-way debate
- Parallel research followed by one fusion writer
- Dependency-DAG collaboration
- One shared-checkout writer token
- Gate-first build/validation loops
- Per-run inspectable artifacts and summaries
- Model/session-specific execution context

Sources:

- [Fusion Harness README](https://github.com/disler/fusion-harness/blob/01a348202482cad0e7d3c34eada180f711aaddd7/README.md)
- [Extension factory and session wiring](https://github.com/disler/fusion-harness/blob/01a348202482cad0e7d3c34eada180f711aaddd7/extensions/fusion-harness/fusion-harness.ts)
- [Child Pi runner](https://github.com/disler/fusion-harness/blob/01a348202482cad0e7d3c34eada180f711aaddd7/extensions/fusion-harness/modules/child-runner.ts)
- [Collaboration and build orchestration](https://github.com/disler/fusion-harness/blob/01a348202482cad0e7d3c34eada180f711aaddd7/extensions/fusion-harness/modules/cmd-build.ts)
- [Writer lease](https://github.com/disler/fusion-harness/blob/01a348202482cad0e7d3c34eada180f711aaddd7/extensions/fusion-harness/modules/writer-lease.ts)

The current implementation is tightly coupled to Pi's extension interface and launches clean-room `pi --mode json -p` children. Its slot sessions are intentionally scoped to one Pi process, and artifacts are written under `/tmp`. Those lifecycle choices should not silently become system-wide persistence rules.

## Capability comparison

| Concern | Boomux | Herdr | Fusion Harness |
| --- | --- | --- | --- |
| Owns PTYs/processes | Yes | Yes | No; launches child agents |
| Persistent detach/reattach | Yes | Yes | Only through child/session behavior |
| Native Omarchy/Hyprland integration | Strong; existing plugin | None in the checked source | None |
| Native terminal windows | Core presentation | Runs inside an existing terminal | Runs inside Pi |
| Tabs/split panes/multiplexer layout | Explicitly outside model | Core capability | No |
| Agent lifecycle state | Integrations + durable run binding | Detection/integrations + waits | Internal orchestration state |
| Remote nodes | Strong Node federation | Remote attach/session model | No |
| Multi-model fusion/debate/DAG | No | Generic automation primitives | Core capability |
| Full terminal renderer | External native terminal; bounded web renderer | libghostty-vt + Ratatui client | No |
| Existing Omarchy plugin | Yes | No | No |

## The central design decision

Do **not** run Boomux and Herdr as co-equal PTY owners for the same pane. That creates two lifecycle authorities, two persistence models, two attachment protocols, and ambiguous ownership during close, resize, handoff, and recovery.

Choose one runtime authority:

### Option A — Boomux foundation

Best when the intended experience is:

- Native Ghostty/Alacritty windows
- Hyprland/Omarchy Workspaces
- Side-pane control surface
- Remote Nodes
- Persistent independent Shells

Add Herdr-inspired tab/pane layout only if a real multiplexed canvas is required. This is not a small feature: Boomux explicitly omits those identity layers, so adding them changes the core domain model and protocol.

### Option B — Herdr foundation

Best when the intended experience is:

- One multiplexer client containing split terminal panes
- Tabs, pane movement, zoom, and layout automation
- Agent-first CLI control and waits
- Integrated terminal rendering

Build a new Omarchy QML frontend and add Boomux-inspired Hyprland presentation, Node federation, and native-window attachment. This gives up Boomux's already-working Omarchy integration and requires more desktop work.

### Recommendation

Start from **Boomux plus `omarchy-boomux`** unless split-pane multiplexing inside one window is the non-negotiable center of the product.

If an integrated terminal canvas is required later, add it as a separate client of the same daemon rather than embedding it into `omarchy-shell`.

## Recommended module shape

```text
Omarchy Shell process
└── Omarchy plugin (QML)
    ├── bar status
    ├── side pane / overlay
    └── presentation adapter only
             │ snapshot + intents + event stream
             ▼
Runtime daemon (Rust)
├── Workspace Runtime module
│   ├── PTYs and processes
│   ├── workspace/pane identities
│   ├── attach/detach/resize
│   └── persistence and recovery
├── Agent Observation module
│   ├── Pi/Claude/Codex/OpenCode adapters
│   └── semantic lifecycle state
├── Orchestration module
│   ├── opinion/fusion/debate/collaborate/validate
│   ├── DAG scheduler
│   ├── single-writer lease
│   └── durable run artifacts
└── Presentation Projection module
    ├── one UI snapshot
    ├── ordered event stream
    └── validated user intents
             │
      ┌──────┴──────────┐
      ▼                 ▼
Native terminal     Workspace client
attachment          (optional separate GUI/TUI)
(Ghostty etc.)       with terminal renderer
```

The **Presentation Projection module** should be deep: QML should learn one compact snapshot/event/intent interface, not the daemon's full protocol. The existing Boomux plugin demonstrates both the feasibility and the cost of exposing many individual CLI commands directly to a large QML implementation.

The **Orchestration module** should own the writer-token and DAG invariants. Individual Pi, Claude, Codex, or OpenCode adapters should not each reimplement fusion rules.

The **Agent Adapter seam** becomes real as soon as two harnesses are supported. Each adapter translates a runtime-neutral task into one harness invocation and reports normalized events; it does not own Workspace or PTY lifecycle.

## Omarchy plugin scope

The installed Omarchy shell supports these plugin kinds: `bar-widget`, `bar`, `panel`, `overlay`, `menu`, and `service`. It loads QML entry points into one long-running Quickshell process. QML can create layer-shell surfaces and ordinary floating windows and can invoke external processes.

The plugin should own:

- Bar attention and run status
- Workspace/Agent/Fusion run navigation
- Start, stop, focus, open, and acknowledge intents
- Configuration and workflow forms
- Notifications and small previews
- Optional full-screen orchestration dashboard

It should not own:

- PTY file descriptors
- Child process supervision
- Durable state
- Agent orchestration scheduling
- Git checkout writer locks
- Remote transport/authentication
- Terminal emulation or high-rate cell rendering

Because all Omarchy plugins share `omarchy-shell`, a crash or event-loop stall can affect the bar, overlays, notifications, lock screen, and Polkit agent. Keeping the QML layer thin is therefore a reliability requirement, not just code organization.

## Full terminal UI choices

1. **Native terminal attachments — recommended first.** Reuse Boomux's current pattern: daemon-owned PTY, `xdg-terminal-exec`, byte-transparent attach client.
2. **Herdr-like TUI client.** Add a client that renders several daemon panes inside Ghostty. This is still a normal external application and keeps terminal complexity out of the desktop shell.
3. **Separate native graphical client.** Use Qt/GTK and a terminal engine such as libghostty-vt. The Omarchy plugin launches/focuses it and provides desktop chrome/status.
4. **QML terminal renderer inside `omarchy-shell` — reject.** Quickshell `Process` pipes are not a terminal engine, and implementing PTY, VT, shaping, graphics, keyboard protocols, scrollback, and rendering in the shell process has poor isolation.

## Suggested delivery sequence

### Phase 0 — Decide the experience

Choose one:

- Native windows arranged by Hyprland
- One integrated split-pane terminal canvas
- Both, with two clients over one daemon

This decision determines whether Boomux or Herdr is the better runtime base.

### Phase 1 — Prove the Omarchy surface

Fork or prototype against `omarchy-boomux`:

- Add Fusion Run list/detail UI
- Display slot, model, state, cost/context, and attention
- Add opinion/fusion/debate/collaborate actions
- Keep all terminal opening delegated to Boomux

### Phase 2 — Extract orchestration

Move Fusion Harness concepts behind a runtime-neutral orchestration interface:

```text
start(run_spec) -> run_id
cancel(run_id)
snapshot(run_id) -> run_projection
subscribe(after_cursor) -> ordered events
```

The run specification should contain roles, model adapters, task/prompt, write policy, and validation policy. It should not expose Pi extension objects to the daemon or QML.

### Phase 3 — Pi adapter

Initially keep Fusion Harness as a Pi extension, but make it report normalized run/task/slot events to the daemon. The daemon becomes the durable projection; Pi remains the execution adapter.

### Phase 4 — Durable orchestration

If system-managed runs must survive the Pi UI closing, move child supervision and the orchestration state machine into the daemon. Reuse Fusion Harness's behavioral contracts, but explicitly redesign session retention and artifact storage rather than inheriting its `/tmp` process-lifetime choices.

### Phase 5 — Integrated terminal client, only if needed

Build a separate Herdr-like client over the daemon. Do not add a second PTY owner.

## Primary risks

- **Domain collision:** Boomux `Workspace/Shell/Run` and Herdr `Workspace/Tab/Pane/Agent` do not map one-to-one.
- **Dual authority:** combining daemons rather than concepts makes lifecycle and recovery ambiguous.
- **QML complexity:** the existing Boomux entry point is already large; adding orchestration directly will create a shallow UI-to-CLI pass-through unless a projection module is introduced.
- **Session semantics:** Fusion Harness intentionally discards slot brains on Pi exit, while Boomux/Herdr emphasize durable sessions. This needs an explicit product decision.
- **Writer safety:** terminal persistence does not enforce checkout safety. The single-writer lease belongs in the orchestration module and must cover all participating harness adapters.
- **Security:** Omarchy plugins, agent extensions, and runtime plugins all execute unsandboxed. Remote/web terminal access is equivalent to shell access.
- **Renderer scope:** Ghostty-quality rendering is a separate engineering program, not an Omarchy panel feature.
- **License/supply chain:** the checked top-level projects use permissive licenses, but any direct reuse of Herdr's vendored Ghostty/portable-pty sources and generated web assets needs a dependency and notice audit.

## Questions to resolve before implementation

1. Is the primary visible unit a native terminal **window**, a multiplexed **pane**, or an **agent**?
2. Must several PTYs render inside one graphical Omarchy surface, or is Hyprland tiling native terminal windows acceptable?
3. Should active agent/model sessions survive only detach, daemon restart/handoff, or full reboot?
4. Does a Fusion Run own its agents, or may it temporarily coordinate agents already running in arbitrary panes?
5. Is one writer enforced per Git checkout, per Workspace, or per coordinated run?
6. Must non-Pi agents participate in fusion on day one?
7. Are remote Nodes in the first release or a later phase?
8. Is the existing Boomux/Omarchy UX a foundation to extend, or merely a reference to reimplement?

## Screenshot feasibility assessment

Three screenshots attributed to `@BLUECOW009` were reviewed locally:

- `/tmp/pi-clipboard-1cf026c1-4cf4-4bd3-96de-763df09130d6.png`
- `/tmp/pi-clipboard-9f072710-3fe2-4afc-8923-96de-763df09130d6.png`
- `/tmp/pi-clipboard-65c93301-ff5e-4813-9e6f-490620dda58e.png`

The linked X posts could not be independently retrieved, and no public source repository was found from the visible product strings. Static screenshots cannot prove that the displayed state is backed by working orchestration rather than fixtures. They only prove that the interface was rendered or composited.

Nothing pictured exceeds Omarchy's QML capabilities. Tabs, cards, forms, scrollable chat, modal goal creation, attention counters, role progress, and task-capsule lists are ordinary Qt Quick UI. A bar widget can open a large `PanelWindow`/overlay exactly as the existing Boomux plugin does.

The backend claims divide into three groups:

1. **Mostly present in Boomux:** durable Workspaces/Shells/Runs, daemon supervision, native terminal opening, Agent/Session projections, attention, exact eligible session resume, event polling, and an Omarchy frontend pattern.
2. **Mostly present in Fusion Harness:** coordinator/builder/reviewer-style roles, multi-agent fan-out, progress streams, fusion, collaboration DAGs, validation, artifacts, and one-writer safety.
3. **New implementation required:** durable Team Goal state, durable task/message projection, background orchestration independent of the Pi UI, worktree-per-agent lifecycle, assignment/claim records, restartable task capsules, and verified network isolation.

The screenshots' "Isolated worktrees" mode is not Fusion Harness's current model. Fusion Harness deliberately shares one checkout and serializes write-enabled tasks with a writer lease; it also rejects worktree commands during collaboration. Worktree-per-agent branching and merge/integration policy would be a separate execution mode.

The "Offline" promise is also nontrivial. Removing network tools from a prompt is not network isolation, and cloud agents still need provider access. A truthful implementation needs a kernel-enforced namespace/sandbox or an explicit restricted-egress proxy policy. The UI should not claim offline operation based only on tool allowlists or environment variables.

The chat feed is reliable when the system owns a structured JSON event stream, as Fusion Harness does for Pi children. It is not generally safe to reconstruct arbitrary agent conversations from PTY output. Unmanaged agents should expose only lifecycle and terminal-open actions unless an official integration reports structured messages.

A precise model for this interface would be:

- **Project:** canonical repository identity.
- **Team Goal:** one durable orchestration run against a Project.
- **Room:** one execution environment, usually a worktree plus a Boomux Shell.
- **Role:** coordinator, builder, reviewer, judge, or another declared responsibility.
- **Assignment:** one DAG task routed to one Role/Agent Run.
- **Agent Run:** one exact harness process execution bound to a Boomux Shell Run.
- **Message:** a structured orchestration event, not scraped terminal text.
- **Task Capsule:** a durable restart recipe plus accepted artifacts and remaining work; it is not a serialized live process.

Verdict: the screenshots may be a mock, prototype, or working private implementation; authenticity cannot be established from the available evidence. The product they depict is technically achievable with Boomux + an orchestration module inspired by Fusion Harness + an Omarchy QML frontend. The hard work is durable orchestration semantics and isolation, not the displayed UI.
