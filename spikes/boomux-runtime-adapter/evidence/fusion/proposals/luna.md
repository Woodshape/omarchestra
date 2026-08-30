I read the required Omarchestra documents and Boomux 1.8.0 documentation/reference consumer. No files changed.

## 1. Proposed end state

Create `spikes/boomux-runtime-adapter/` containing:

- Throwaway Node adapter using only `spawn(..., argv, { shell: false })`.
- `boomux.cli/v1` envelope and error parsers.
- Opaque adapter references mapping internally to:
  - coordinator Workspace ID;
  - owner Workspace ID;
  - Shell ID;
  - exact Run ID.
- Ownership manifest containing only IDs created by this spike.
- Deterministic fake-CLI tests. No automated GUI launches.
- Raw command traces, capability output, snapshots, events, failures, manual observations, conclusion, and file-disposition table in `README.md`.

Use this command flow:

```text
boomux --json capabilities
boomux --json daemon status
boomux --json node snapshot
boomux --json events                         # baseline cursor
boomux --json workspace create NAME \
  --node LOCAL_NODE_ID --cwd REPO             # creates Workspace + first pending Shell
boomux shell rename SHELL_ID ROLE_NAME        # human-only, verify afterward
boomux shell create WORKSPACE_ID --node LOCAL_NODE_ID \
  --name ROLE_NAME --cwd REPO                 # human-only, verify with list --json
boomux open SHELL_ID --workspace WORKSPACE_ID --takeover
boomux --json shell inspect SHELL_ID
boomux --json events --after CURSOR --limit 256 --wait-ms 0
```

`create` must never parse human output. It records IDs from JSON where available and confirms human-only mutations through JSON snapshots. Ambiguous human-command outcomes become typed `unknown_outcome` failures and are never retried or resolved by prefix matching.

Define `close(reference)` as destructive Shell closure for cleanup. Boomux 1.8.0 has no public non-destructive detach command. Native window closure is a manual Hyprland/terminal action, separately validated by closing the window and then calling `present(reference)`.

Expected conclusion: **supported with constraints**. If the port requires `close` to mean non-destructive detach, or requires race-free exact-run reopening, Boomux 1.8.0's public CLI is insufficient.

## 2. Implementation tasks, dependencies, and parallelism

### A1. Source and CLI contract audit

Dependency: none. Must happen first.

Capture:

```text
boomux --version
boomux --help
boomux workspace --help
boomux workspace create --help
boomux workspace inspect --help
boomux workspace close --help
boomux shell --help
boomux shell create --help
boomux shell inspect --help
boomux shell rename --help
boomux shell close --help
boomux open --help
boomux events --help
boomux daemon --help
boomux daemon status --help
boomux desktop --help
boomux --json capabilities
```

Require:

- CLI version `1.8.0`;
- `boomux.cli/v1`;
- protocol `49` or newer;
- `workspace.create`, `workspace.inspect`, `shell.inspect`, `events`, `daemon.status`, `list`, `node.snapshot`, and `launcher.list`;
- `typed_errors`, `shell_run_identity`, `daemon_events`, `reconnectable_event_cursors`, `atomic_workspace_shell_creation`, and `create_and_open_shell`.

Snapshot existing user data through public commands only:

```text
boomux --json daemon status
boomux --json workspace list
boomux --json list
boomux --json agent list
boomux --json node list
boomux --json node snapshot
boomux --json integration list
boomux --json integration status
boomux config path
boomux config validate
```

Do not read Boomux state files.

### A2. Adapter command runner and typed contract

Dependency: A1. Can run in parallel with A3 after the port shape is agreed.

Implement:

- bounded stdout/stderr capture;
- exact argv recording;
- JSON success/error envelope validation;
- stable Boomux error-code preservation;
- local typed failures for unavailable binary, malformed output, human-command failure, unknown outcome, capability mismatch, identity mismatch, cursor expiry, run change, and ownership conflict;
- explicit `shell: false`;
- no command-string parsing or shell interpolation.

### A3. Deterministic fixtures and tests

Dependency: A1. Parallel with A2.

Cover:

- exact JSON envelopes;
- capability and version rejection;
- unavailable Boomux and unavailable daemon;
- opaque reference mapping;
- global Workspace ID versus owner Workspace ID;
- exact Shell and Run identity;
- pending, running, and exited snapshots;
- exact argv construction with spaces, quotes, `$`, semicolons, and newlines;
- baseline and paginated event cursors;
- unrelated-event filtering while advancing the cursor;
- ordering, duplicate, stream-change, and `cursor_expired` behavior;
- idempotent create and cleanup;
- partial creation compensation;
- unknown mutation outcomes;
- refusal to clean up unowned resources.

### A4. Ownership, create, present, inspect, close, subscribe

Dependency: A2 and A3.

Use recognizable names such as:

```text
omarchestra-boomux-spike-<unique-token>
omarchestra-boomux-spike-<unique-token>-coordinator
omarchestra-boomux-spike-<unique-token>-builder
omarchestra-boomux-spike-<unique-token>-reviewer
```

Return only opaque reference tokens. Never expose Boomux IDs through the conceptual port.

`present` must inspect before and after `boomux open`. It accepts a new pending Shell, but for an existing Run requires the same Run ID after presentation.

`cleanup` must:

1. inspect the exact recorded Workspace and Shell IDs;
2. refuse Workspace closure if any unowned Shell, Launcher, or Agent exists;
3. close only recorded Shell IDs;
4. close only the recorded Workspace ID;
5. verify removal through public JSON reads;
6. never stop the daemon or run global cleanup.

### A5. Manual Hyprland gate

Dependency: A4. Must be serialized and explicitly human-triggered.

Prove:

1. three native terminal windows appear and tile under Hyprland;
2. each window corresponds to the expected spike Shell;
3. each Shell has the expected exact Run;
4. a human closes one native window, not `boomux desktop close`;
5. its Run remains alive with the same Run ID and PID;
6. `present` reconnects to that same Shell Run and process;
7. the other two terminals remain unchanged;
8. exact-ID cleanup removes only spike resources.

If the Boomux special Workspace layer is not already enabled, do not modify configuration. Record ordinary Hyprland tiling separately from special-Workspace placement.

### A6. Spike record and design disposition

Dependency: A5.

`README.md` must record:

- question and success criteria;
- exact versions and commands;
- raw JSON envelope shapes;
- assumptions;
- evidence and failures;
- conclusion;
- design implications;
- cleanup outcome;
- disposition of every prototype file.

Only after the gate should the Boomux open technical contract in `docs/design/mvp.md` be updated.

## 3. What this slot is best suited to own

LUNA should own:

- `test/` fixtures and deterministic contract tests;
- source-audit tests preventing Rust, private-state, hidden-command, and shell-interpolation coupling;
- error taxonomy and cursor/reference test coverage;
- the spike README's contract, constraints, and file-disposition sections.

TERRA should own the adapter executor, ownership manifest, and manual harness. SOL should review the `close`/detach semantics and approve the final design implication before documentation changes.

## 4. Collision and safety concerns

- **C1:** `boomux open` is public but can restart an exited Shell. Pre/post checks reduce risk but cannot eliminate the race. Never claim an unconditional exact-run guarantee.
- **C2:** `close` must not map to `desktop close`. That permanently closes the Shell and terminates its process.
- **C3:** Workspace creation returns a coordinator ID and owner Workspace ID. Events may identify the owner Workspace. Keep both internal.
- **C4:** Human-only create, rename, present, and close commands are weaker dependencies. Never parse their prose.
- **C5:** Never search by prefix during cleanup. Use only IDs recorded after successful postconditions.
- **C6:** Do not modify existing config, integrations, Nodes, Workspaces, Shells, agents, or daemon lifecycle. Do not run setup, update, uninstall, remote, web, or global cleanup commands.
- **C7:** Event cursors are stream-scoped, bounded, and memory-backed. Cursor expiry or daemon replacement must force a new baseline.
- **C8:** Do not read `/home/woodshape/.local/state/boomux` or import Boomux source/Rust modules.

## 5. Objective validation

Automated validation:

```text
node --check spikes/boomux-runtime-adapter/**/*.mjs
node --test spikes/boomux-runtime-adapter/test/*.test.mjs
git diff --check
```

Tests must use an injected recording executor and prove no GUI command is executed.

Manual evidence must include:

- capability and help captures;
- pre/post public Boomux snapshots;
- exact argv trace;
- Shell inspect records before and after presentation;
- event cursor and ordered event records;
- Hyprland client/workspace observations;
- PID observations before window close, after close, and after reopen;
- final cleanup verification.

The safe answer to carry forward is: Boomux 1.8.0 is usable behind a narrow replaceable adapter for creation, inspection, presentation, event observation, manual detach/reconnect, and exact-ID cleanup. Non-destructive programmatic detach and race-free exact-run reopening remain explicit constraints.