# Boomux terminal-runtime adapter spike

Status: **complete — supported with constraints**

This is the second Omarchestra feasibility spike. It is a throwaway adapter probe, not production architecture.

## Question

Can Omarchestra use Boomux strictly behind the narrow replaceable terminal-runtime port below to create and present one three-role Team Goal, observe exact process-run lifecycle, detach and reconnect native terminal windows, and clean up only its own resources?

```text
capabilities()
create(session specification) -> terminal session reference
present(reference)
inspect(reference) -> lifecycle state
close(reference)
subscribe(references, cursor) -> ordered lifecycle events
```

The question is falsified if the required behavior needs Boomux Rust modules, direct daemon protocol access, private runtime state, terminal-output scraping, Boomux entities in the Omarchestra domain model, mutation of existing user resources, or hidden attachment commands.

## Scope and assumptions

- Boomux, its daemon, Hyprland, and a compatible XDG terminal are separately installed user dependencies.
- The spike targets the installed Boomux **1.8.0**, `boomux.cli/v1`, and daemon protocol **49**. Commands without stable JSON output are version-pinned to this tested CLI.
- Only the local Node is eligible. Cached remote projections may be snapshotted but never authorize a mutation.
- The daemon must already be running. The adapter reports a typed unavailable failure rather than implicitly starting, restarting, or stopping it.
- One collision-resistant prefix names the spike Workspace and all three role Shells.
- The three Shell startup commands are exact argument vectors for a harmless spike probe process. There is no Pi integration.
- Terminal attachment presence is not observable through Boomux snapshots. Closing a window and reconnecting therefore remain human observations.
- Existing Workspaces, Shells, Agents, configuration, integrations, and Nodes are user data. The manual flow snapshots them before its first mutation and never targets them.
- No setup, update, uninstall, integration mutation, remote Node mutation, web server, global cleanup, QML, SQLite, production orchestration, or final runner is in scope.

## Source of truth and captured version

Safe discovery was captured without starting or contacting the daemon:

```text
boomux --version
boomux --json capabilities
boomux --help
boomux workspace --help
boomux workspace create --help
boomux workspace inspect --help
boomux workspace close --help
boomux shell --help
boomux shell create --help
boomux shell inspect --help
boomux shell close --help
boomux open --help
boomux events --help
boomux daemon status --help
boomux node snapshot --help
boomux list --help
boomux launcher list --help
boomux agent list --help
boomux integration list --help
boomux integration status --help
boomux config path --help
boomux config validate --help
```

The complete output is in [`evidence/cli-source-truth.txt`](evidence/cli-source-truth.txt). It records:

```text
boomux 1.8.0
schema: boomux.cli/v1
command: capabilities
data.cli_version: 1.8.0
data.daemon_protocol_version: 49
```

Public documentation consulted:

- `/tmp/pi-boomux/README.md`
- `/tmp/pi-boomux/docs/architecture.md`
- `/tmp/pi-boomux/docs/cli-json.md`
- `/tmp/pi-boomux/docs/event-stream.md`
- `/tmp/pi-boomux/docs/native-terminal-follow-up.md`
- `/tmp/pi-boomux/docs/live-pty-handoff.md`
- `/tmp/pi-omarchy-boomux` as a public-CLI reference consumer

No Boomux source module or private state file is an adapter dependency.

## Capability contract

The adapter must reject the installation before mutation unless the capability envelope has the exact schema and command, CLI version `1.8.0`, protocol `49`, and the required values below.

Required JSON commands:

```text
capabilities
daemon.status
workspace.list
workspace.inspect
node.snapshot
list
shell.inspect
agent.list
integration.list
integration.status
events
```

Required features:

```text
typed_errors
shell_run_identity
daemon_events
reconnectable_event_cursors
global_workspaces
multi_node_workspace_placements
hyprland_special_workspaces
coordinated_shell_desktop_placement
protocol_49
```

The Hyprland feature names advertise static CLI support. They do not prove that Hyprland is running or that Boomux's optional special-Workspace layer is enabled. Those are part of the human gate.

The complete advertised command, feature, integration-host, and stable-error lists are preserved in the capability capture. Stable Boomux error codes are retained as typed errors without parsing their human messages.

## JSON envelope contract

Advertised JSON commands emit one document on stdout:

```json
{
  "schema": "boomux.cli/v1",
  "command": "shell.inspect",
  "data": {}
}
```

A JSON failure writes one document to stderr and exits nonzero:

```json
{
  "schema": "boomux.cli/v1",
  "command": "shell.inspect",
  "error": {
    "code": "not_found",
    "message": "human-readable context only"
  }
}
```

The adapter validates the schema, expected command, and exactly one of `data` or `error`. It preserves advertised error codes. Missing executables, malformed JSON, wrong envelopes, incompatible capabilities, non-JSON command failures, unknown mutation outcomes, ownership conflicts, cursor expiry, and changed Runs are separate adapter-defined typed failures.

## Exact public commands used by the prototype

### Stable JSON dependencies

```text
boomux capabilities --json
boomux daemon status --json
boomux workspace list --json
boomux workspace inspect GLOBAL_WORKSPACE_ID --json
boomux node snapshot --json
boomux list --json
boomux shell inspect SHELL_ID --json
boomux agent list --json
boomux agent list --workspace OWNER_WORKSPACE_ID --json
boomux integration list --json
boomux integration status --json
boomux events --limit 256 --wait-ms 0 --json
boomux events --after CURSOR --limit 256 --wait-ms WAIT_MS --json
```

`node snapshot` contacts the local daemon and may include cached remote projections. The adapter selects the one exact current local Node and never routes a mutation through a remote projection.

### Weaker non-JSON dependencies

```text
boomux workspace create PREFIX
boomux shell create GLOBAL_WORKSPACE_ID --node LOCAL_NODE_ID \
  --name PREFIX-ROLE --cwd CWD -- EXACT_ARGV...
boomux open SHELL_ID --workspace GLOBAL_WORKSPACE_ID \
  --title PREFIX-ROLE --takeover
boomux shell close SHELL_ID --workspace OWNER_WORKSPACE_ID
boomux workspace close GLOBAL_WORKSPACE_ID
boomux config path
boomux config validate
```

These commands are human-output dependencies and are not advertised JSON commands for these forms. The globally visible `--json` help option does not make an unadvertised command a stable JSON operation. The adapter never parses human stdout for identity or error classification. It reconciles successful or ambiguous mutations through advertised JSON snapshots.

The spike deliberately creates an empty Workspace and then three Shells. The advertised atomic JSON `workspace.create` form creates a generated first Shell with an empty startup argv, so it cannot directly create the explicitly named Coordinator probe required by this spike.

## Port mapping

### `capabilities()`

1. Parse `boomux capabilities --json` without contacting the daemon.
2. Enforce the pinned schema, CLI, protocol, commands, and features.
3. Parse `boomux daemon status --json` and require a running protocol-49 daemon.
4. Return only adapter-level capabilities and typed availability failures.

### `create(specification)`

1. Require a private preflight snapshot and bind its path, timestamp, and exact local Node ID into the spike receipt.
2. Persist the intended unique prefix, role, cwd, and exact argv in the receipt.
3. Revalidate the exact local Node before mutation; never rely on the potentially ambiguous `local` alias.
4. Prove with JSON `workspace.inspect` that the prefix is absent and record that precondition.
5. Create one empty prefixed global Workspace through the weak command, then resolve and record its exact ID.
6. Create the Coordinator, Builder, and Reviewer Shells through exact argv arrays.
7. Reconcile each Shell through JSON snapshots and record its owner Workspace ID and Shell ID.
8. Return an opaque adapter-generated reference. Boomux IDs remain private foreign-reference data.

A repeated create is idempotent only when the receipt already contains the complete exact mapping for the same specification. An interrupted mutation without a recorded exact ID is not reclaimed by name or prefix and is never retried automatically.

### `present(reference)`

1. Resolve only a receipt-owned opaque reference.
2. Inspect the exact Shell before presentation.
3. Reject an already exited Run rather than intentionally restarting it.
4. Invoke public `boomux open` with exact argv and explicit Workspace placement.
5. Poll `shell.inspect` for a bounded period and record the exact started or surviving Run ID.
6. If an existing Run ID changes, return a typed Run-change failure.

`--takeover` follows the reference consumer's single-controller behavior. It may displace another attachment to that same spike-owned Shell. It does not target sibling role Shells or user Shells.

### `inspect(reference)`

`shell.inspect` supplies authoritative terminal lifecycle facts:

- Shell status: `pending`, `running`, or `exited`.
- Exact Run ID and generation.
- Start and end timestamps.
- Exit reason and exit code.
- Output revision.
- Whether Boomux injected `BOOMUX_RUN_ID` into that process.

The adapter normalizes those facts to its own lifecycle values. It does not expose a Boomux Workspace, Shell, or Run as an Omarchestra domain object and does not infer attachment state.

### `close(reference)`

This operation is destructive cleanup: it terminates the current process and removes the exact Shell. It is not terminal-window closure or detach.

Before cleanup, the adapter re-inspects all exact IDs and refuses Workspace closure if it finds an unrecorded Shell, Launcher, or Agent in the spike placement. It closes recorded Shell IDs individually, verifies their absence, then closes only the recorded global Workspace ID and verifies removal. A recorded successful close is an idempotent no-op.

The spike never invokes `boomux desktop close`, `boomux close --focused`, daemon stop, or name/prefix-based cleanup.

### `subscribe(references, cursor)`

- A null cursor requests an atomic snapshot and baseline cursor.
- A supplied cursor requests only newer events.
- Cursors are opaque `<stream-uuid>:<event-id>` values.
- The daemon retains 8,192 events and returns at most 256 per request.
- Event IDs provide publication order within one stream.
- Events unrelated to requested references are filtered, but the returned cursor still advances across them.
- On the first `run_started` or `run_exited` observation, the adapter records the exact foreign Run ID internally and emits only a generated opaque Run reference. A later conflicting ID becomes `run_changed`.
- On `cursor_expired`, the adapter requests one fresh baseline and returns `baseline: true`; callers must reconcile the snapshot rather than treat the page as continuous replay.
- Graceful daemon handoff preserves the stream. Cold startup replaces it.

Relevant lifecycle events are `workspace_created`, `workspace_closed`, `shell_created`, `shell_closed`, `run_started`, `run_exited`, and `handoff_completed`. `output_changed` advances ordering but is not itself a lifecycle transition.

## Window close, detach, and exact-Run limits

Closing a native terminal emulator window closes its Boomux attachment socket. According to Boomux's public runtime contract, the daemon retains the PTY and child process. There is no public non-destructive detach command needed by this spike, and attachment presence is not exposed in snapshots or events.

Public `boomux open` does not expose an expected-Run argument. The binary advertises `exact_run_attachment`, but the adapter does not require or rely on it: that capability covers a lower protocol primitive and exact Session opening, not a guarded generic public Shell-open command. Ordinary open may restart an exited Shell.

Pre- and post-inspection can detect a changed Run but cannot eliminate the race where a running process exits between inspection and attachment and `open` starts a replacement. The spike can support reopening a surviving process under the manually tested no-concurrent-exit condition. It cannot claim unconditional race-free exact-Run presentation through Boomux 1.8.0's public generic Shell CLI.

Boomux snapshots also omit the child PID. The manual probe process writes its own PID, `BOOMUX_SHELL_ID`, and `BOOMUX_RUN_ID` directly to an ignored owner-only evidence file supplied in its exact argv. The manual driver compares that file with `inspect()` without reading or parsing rendered terminal output.

## Safety policy

1. Discovery and automated tests perform no mutation and open no GUI.
2. The manual driver requires a generated private preflight snapshot before its first mutation and binds that evidence to the ownership receipt.
3. Preflight records existing public resource and integration projections, the active config path and validation result, and either the exact bounded config bytes or an explicit absent state. Config bytes remain ignored private evidence and are never interpreted as runtime state.
4. No Boomux durable state file, daemon socket, hidden command, or Rust module is read or imported.
5. Every spike resource has one generated recognizable prefix.
6. Intent is recorded before mutation; destructive cleanup requires exact created-and-recorded IDs.
7. Human output is never parsed for identity.
8. Ambiguous weak-command outcomes stop the run. They are not replayed, guessed, or cleaned by name.
9. Cleanup fails closed if ownership cannot be proven or foreign resources appear in the spike Workspace.
10. Existing user resources and settings are never renamed, opened, closed, installed, or changed.
11. The adapter never starts, restarts, or stops the daemon.
12. Real presentation requires an explicit manual command. Fake executors are mandatory in automated tests.

## Evidence status

| Evidence | Status |
| --- | --- |
| Installed version, complete capability envelope, and relevant help | Captured without daemon contact in `evidence/cli-source-truth.txt` |
| Deterministic adapter tests | Passed: 61 tests, 0 failures; `evidence/automated.txt` |
| Source-coupling audit | Passed, including dynamic production-file inventory and terminal-scraping prohibition |
| Fusion collaboration provenance | Preserved under `evidence/fusion/` |
| Safe pre-mutation private user-data snapshot | Passed during final validation; output retained only under ignored `evidence/local/` |
| Three native tiled windows | Passed by human observation |
| Expected role identity in each terminal | Passed by human observation and direct private probes |
| Window close leaves exact Run and PID alive | Passed for Builder; all sibling identities also remained stable |
| Reopen uses the same exact Run and PID | Passed under the tested no-concurrent-exit condition |
| Sibling terminals remain unaffected | Passed |
| Exact-ID cleanup preserves all pre-existing resources | Passed by postflight identity/configuration comparison |

Public-contract capture did not contact the daemon. Final automated validation additionally ran the read-only preflight once and saved its user-data snapshot under ignored `evidence/local/`. No Workspace, Shell, process, terminal window, configuration mutation, integration mutation, or cleanup command was executed.

## Manual observation gate

This gate passed on 2026-08-30. The procedure remains below for reproducibility; captured results are in [`evidence/manual-observations.md`](evidence/manual-observations.md). The executable driver separates read-only preflight, live mutation, and GUI authorization. Run it from an unmanaged control terminal at the repository root. Substitute the exact preflight filename printed by the first command and choose a new receipt filename under the ignored directory.

```bash
node spikes/boomux-runtime-adapter/manual.mjs preflight

node spikes/boomux-runtime-adapter/manual.mjs create \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
  --preflight spikes/boomux-runtime-adapter/evidence/local/preflight-<timestamp>.json \
  --cwd "$PWD" \
  --allow-live-mutations

node spikes/boomux-runtime-adapter/manual.mjs inspect \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json

node spikes/boomux-runtime-adapter/manual.mjs present-all \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
  --allow-gui

for role in coordinator builder reviewer; do
  node spikes/boomux-runtime-adapter/manual.mjs probe \
    --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
    --role "$role"
done

node spikes/boomux-runtime-adapter/manual.mjs subscribe \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json
```

Stop before cleanup until the window-close and exact-process reconnect observations below are complete. Record every observation in [`evidence/manual-observations.md`](evidence/manual-observations.md).

1. Confirm preflight reported Boomux 1.8.0, protocol 49, a running daemon, one exact current local Node, and private snapshots including bounded configuration bytes or an explicit absent state.
2. Confirm create produced exactly one prefixed Workspace and three prefixed role Shells and recorded their exact private mappings.
3. Confirm Hyprland tiles three native terminal windows and each visibly shows its expected role, Shell ID, Run ID, and PID.
4. Save `inspect` and `probe` results for all roles.
5. Close one terminal emulator window using its normal window-close action. Do not run any Boomux close command.
6. Run `inspect` and the selected role's `probe` command again. Confirm the Shell remains running with the same opaque Run reference and probe PID. Confirm the other two windows and processes are unchanged.
7. Re-present only that role and repeat its probe:

```bash
node spikes/boomux-runtime-adapter/manual.mjs present \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
  --role builder \
  --allow-gui
node spikes/boomux-runtime-adapter/manual.mjs probe \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
  --role builder
```

8. Confirm the reopened terminal has the same Shell, opaque Run reference, and PID, with no replacement process.
9. Record ordered lifecycle events and any explicit baseline reseed after cursor expiry.
10. Run exact-ID cleanup only after every prior observation passes:

```bash
node spikes/boomux-runtime-adapter/manual.mjs cleanup \
  --receipt spikes/boomux-runtime-adapter/evidence/local/manual-receipt.json \
  --allow-live-mutations
```

11. Run a new read-only preflight and privately compare it with the bound baseline. Confirm every pre-existing resource ID remains and no prefixed spike resource remains.

If Hyprland or its Boomux Workspace layer is unavailable, if any Run changes, if another resource is affected, or if cleanup ownership is uncertain, record the gate as failed. Do not repair the environment by changing Boomux configuration or integrations within this spike.

## Failures and open constraints

Automated review found and corrected three unsafe prototype behaviors before conclusion: rendered-output PID scraping was replaced by direct private probe evidence, pre-existing prefix collisions now fail before mutation, and manual creation now requires a bound preflight snapshot. Event-first Run identity is now persisted behind an opaque reference.

Remaining constraints:

- Local GUI presentation, tiling, window detach, reconnect, sibling isolation, and cleanup passed in the tested environment; remote behavior remains unproven.
- Generic Shell presentation lacks an atomic public expected-Run guard.
- Non-JSON create, present, and close dependencies require an exact tested CLI pin and JSON postcondition reconciliation.
- Attachment state is unavailable through the public snapshot/event contract.
- Event replay is bounded and memory-backed; cursor expiry requires a fresh baseline.
- Daemon crash, cold restart, machine reboot, and automatic process recovery are outside the guarantee.
- An ambiguous mutation may leave a uniquely prefixed orphan that this spike deliberately refuses to guess or delete.

## Conclusion

**Supported with constraints.**

The captured Boomux 1.8.0 public contract and completed human gate prove capability negotiation, uniquely prefixed Workspace and Shell creation, opaque reference mapping, lifecycle inspection, three native tiled terminals, process survival after window closure, same-Run/same-PID re-presentation, sibling isolation, ordered event polling, and exact-ID cleanup behind a narrow adapter.

The strongest remaining contract gap is generic exact-Run presentation: public `open` can be checked before and after but cannot atomically bind the requested Run. Production must either accept and represent that constraint, obtain a public expected-Run Shell-open operation, or use a different runtime implementation.

Remote Node federation, remote PTY presentation, disconnect survival, and node-qualified cleanup remain separate feasibility work.

## Design implications

1. Boomux identifiers remain opaque adapter metadata. Team Goals, Roles, Agent Runs, assignments, and lifecycle policy remain Omarchestra concepts.
2. Terminal lifecycle and assignment lifecycle stay separate. A terminal Run exit never determines assignment outcome.
3. Native-window attachment state is unavailable rather than inferred.
4. The Boomux implementation is version-pinned where it relies on non-JSON commands; JSON readers still validate schema, command, fields, and stable errors.
5. Cursor expiry is a snapshot-reconciliation boundary, not an event that may be ignored.
6. Cleanup authority comes from the spike receipt and exact readback, never names, desktop focus, or current selection.
7. The production runtime port needs an explicit policy for the exact-Run presentation race before the Boomux adapter contract can be closed.

The passed contract and its remaining exact-Run race are recorded in `docs/design/mvp.md`.

## Prototype file disposition

All prototype files remain inside this spike and are evidence only. None is promoted into production by this result.

| File | Disposition |
| --- | --- |
| `.gitignore` | Retain to prevent committing private snapshots, probe records, and ownership receipts. |
| `README.md` | Retain as the authoritative spike record and manual gate. |
| `manual.mjs` | Retain as a reproducible manual fixture; do not promote into the Team Runner. |
| `probe-process.mjs` | Retain as manual process-identity evidence only; throw away for production. |
| `lib/adapter.mjs` | Retain with the spike as executable contract evidence; redesign deliberately for production. |
| `lib/commands.mjs` | Retain with the spike as the tested Boomux 1.8.0 argv map. |
| `lib/envelopes.mjs` | Retain with the spike as JSON-contract evidence; do not treat it as a production compatibility policy. |
| `lib/errors.mjs` | Throw away after extracting the typed-failure requirements. |
| `lib/executor.mjs` | Throw away; it is a bounded fixture, not production process supervision. |
| `lib/receipt.mjs` | Throw away; its local JSON receipt is not durable Team Runner persistence. |
| `test/adapter.test.mjs` | Retain as deterministic lifecycle, ownership, idempotency, and cursor evidence. |
| `test/contracts.test.mjs` | Retain as deterministic argv, envelope, capability, and failure evidence. |
| `test/fixtures.mjs` | Retain with the tests only; fixtures are not Boomux domain models. |
| `test/source-audit.test.mjs` | Retain as the guard against private-state, Rust, hidden-command, shell, and terminal-scraping coupling. |
| `evidence/cli-source-truth.txt` | Retain as exact Boomux 1.8.0 discovery evidence. |
| `evidence/automated.txt` | Retain as captured syntax, test, safe-preflight, and diff-check evidence. |
| `evidence/fusion/` | Retain as collaboration provenance; it is not runtime input or product architecture. |
| `evidence/manual-observations.md` | Retain as the passed human gate and constraint record. |
| Ignored `evidence/local/` files | Keep local only and delete manually when no longer needed; never commit user data. |
