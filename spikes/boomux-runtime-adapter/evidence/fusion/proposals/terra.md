## 1. Proposed end state

A self-contained Node spike in `spikes/boomux-runtime-adapter/` that:

- Implements the six-method runtime port with opaque session and run references.
- Uses only Boomux CLI argv arrays and `boomux.cli/v1` JSON envelopes.
- Creates one uniquely prefixed empty Workspace, then three uniquely prefixed Shells for Coordinator, Builder, and Reviewer.
- Uses `open <shell-id> --workspace <workspace-id>` without `--takeover` for presentation.
- Treats terminal-window closure as a human desktop action, not `close(reference)`. `close(reference)` maps to destructive `shell close`.
- Polls `events --json` with opaque cursor mapping, filters only spike-owned resource events, and never infers terminal attachment state from snapshots.
- Stops at a manual Hyprland gate before concluding detach, reconnection, or tiling behavior.

I could not execute `boomux` in this read-only phase. The implementation must capture the installed 1.8.0 `--version`, `capabilities --json`, and relevant `--help` output before fixing capability requirements.

## 2. Tasks, dependencies, and parallelism

| Task | Depends on | Parallel |
|---|---|---|
| A1. Record the live CLI contract: version, capabilities envelope, JSON command list, feature list, error codes, and relevant help text. | None | Can run with A2 scaffolding |
| A2. Implement CLI executor, JSON envelope/error parser, typed failures, opaque reference ledger, and port methods. | A1 | Can begin with fixture-backed interfaces |
| A3. Implement deterministic tests and source audit. Test argv construction, JSON parsing, cursor ordering, idempotency policy, unavailable Boomux, capability failures, and prohibited coupling. | A2 | Test fixtures can be drafted with A2 |
| A4. Add explicit live/manual driver and local-only evidence storage. It must snapshot existing state, require a running daemon, create only prefixed resources, and gate GUI operations behind an explicit command. | A1, A2 | Documentation can begin earlier |
| A5. Write the spike record, captured evidence, conclusion constraints, design implications, and disposition table for every prototype file. | A3, A4 | Ongoing, final conclusion waits for A4 |

A2 command mapping:

```text
capabilities()
  boomux capabilities --json
  boomux daemon status --json
  boomux node snapshot --json

create(spec)
  boomux workspace create <prefixed-workspace>             # human-only, weak
  boomux workspace inspect <name> --json
  boomux shell create <workspace-id> --node <local-node-id>
    --name <prefixed-role-shell> --cwd <cwd> -- <argv...>  # human-only, weak
  boomux shell inspect <shell-name> --workspace <workspace-id> --json

present(ref)
  boomux open <shell-id> --workspace <workspace-id>        # human-only, weak

inspect(ref)
  boomux shell inspect <shell-id> --json

subscribe(refs, cursor)
  boomux events --json
  boomux events --after <cursor> --wait-ms <bounded> --json

close(ref)
  boomux shell close <shell-id> --workspace <workspace-id> # human-only, destructive
```

Cleanup first verifies `boomux list --json` contains only recorded Shell IDs for the spike Workspace, closes recorded Shells individually, then closes the recorded Workspace.

## 3. Best ownership for this slot

I should own A2 and A3: the adapter boundary, typed CLI protocol handling, opaque mapping, deterministic tests, and source audit. This confines implementation to one new spike directory and avoids overlap with architecture decisions or manual GUI observation.

## 4. Collision and safety concerns

- R1. `workspace create`, `shell create`, `open`, `shell close`, and `workspace close` are human-output dependencies. Their success must be confirmed through JSON readback, and their failures must remain weaker typed command failures rather than parsed text.
- R2. `open` must never use `--takeover`. Re-presenting an attached Shell could otherwise disconnect another terminal.
- R3. Boomux snapshots expose Shell and Run lifecycle, not whether a native window remains attached. The adapter must report attachment state as unavailable.
- R4. `shell close` terminates the process. It cannot represent ordinary terminal-window closure. The manual gate must close the terminal emulator window, never `boomux desktop close`.
- R5. Automated tests must use a fake CLI executor and never call `open`, `--open`, `workspace open`, setup, update, integration installation, remote Node, web, or daemon-stop commands.
- R6. Live evidence must snapshot existing Boomux state before mutation into ignored local files such as `evidence/local/`. Do not commit user Workspace names, paths, or state.
- R7. Every created Workspace and Shell name must use one generated recognizable prefix. The adapter records exact IDs before cleanup and rejects unrecorded references.
- R8. The source audit must reject Rust source imports, Boomux state paths, daemon socket paths, hidden attachment commands, shell execution APIs, and `shell: true`.

## 5. Objective validation

Automated validation should prove:

1. Capability checks require Boomux 1.8.0, `boomux.cli/v1`, protocol 49, required JSON commands, and required static features.
2. Missing executable, invalid JSON, wrong schema, unsupported capability, stopped daemon, cursor expiry, and changed Run produce typed failures.
3. Every subprocess call uses an argv array with no shell interpolation.
4. Runtime references and Run references remain adapter-generated opaque values.
5. `create` is idempotent per stable session key. `close` is idempotent only after recorded success. `present` is intentionally non-idempotent because Boomux does not expose attachment presence.
6. Event cursors advance across ignored events, emitted events remain ordered, and `cursor_expired` requires a fresh snapshot.
7. The source audit prevents private-state and Rust-module coupling.

Manual validation should prove:

1. The three prefixed native terminals appear tiled under Hyprland.
2. Each terminal displays its expected prefixed Shell and recorded `BOOMUX_RUN_ID`.
3. Closing the Builder terminal window leaves its recorded Node fixture PID and exact Shell Run running.
4. Re-presenting Builder reconnects to the same Shell Run and PID without `--takeover`.
5. Coordinator and Reviewer retain their original Run IDs and remain visible.
6. Cleanup affects only recorded Shell IDs and the recorded Workspace ID.

The final spike conclusion must remain pending until this human observation gate is recorded.