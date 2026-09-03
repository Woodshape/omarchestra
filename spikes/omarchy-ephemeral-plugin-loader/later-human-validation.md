# Later human validation plan

Status: **CANCELLED — rejected per-run loader path; never execute**

This historical plan is retained only to document what the fake spike did not prove. ADR 0001 selected an explicitly installed persistent Omarchestra Companion Plugin with ephemeral Projection Sessions, so Omarchestra will not seek, install, or live-test this temporary-panel candidate. The replacement human gate belongs to the Companion Plugin path described in `prototypes/first-vertical-slice/docs/live-agent-console-gate.md`.

Everything below is superseded historical procedure, not current product work or a runnable recipe.

## Entry conditions

No live resource may be created until all conditions hold:

1. The temporary-panel interface has completed upstream or package-owner review.
2. An accepted build containing the interface is installed through the normal trusted Omarchy update path. A repository patch artifact is not sufficient.
3. The installed package version and source hashes are recorded and match the accepted build.
4. A non-mutating request to the installed `temporary-panel` target returns a valid `omarchy.temporary-panel/v1` capability response with `supported: true`.
5. The candidate's same-UID TOCTOU limitation is accepted for the trusted repository source, or the installed implementation has replaced it with a stronger descriptor-based guarantee.
6. The Agent Console source passes its repository checks and is owned by the current user, canonical, non-symlinked, and quiescent for the duration of registration and load.
7. The operator explicitly authorizes the existing human Agent Console gate.

Target or method absence, an unknown interface version, malformed capability JSON, a false support flag, changed installed hashes, or any failed source precondition stops the run before a runner, Pi, Ghostty, Hyprland action, provider, Boomux, SSH connection, systemd unit, or UI resource is created.

## Preflight record

Before registration, record outside Git in the existing private manual-gate state location:

- operator authorization and time;
- installed Omarchy and Quickshell versions and accepted source hashes;
- exact capability response;
- byte hashes or absence of `~/.config/omarchy/shell.json` and the normal installed-plugin state;
- canonical Agent Console source path;
- absence of any registration or live resource created by this run.

The preflight must not write user shell configuration or stage source below `~/.config/omarchy/plugins`.

## Human sequence

After preflight succeeds:

1. Register the repository-local Agent Console panel by absolute canonical path.
2. Poll the returned operation identity until validation returns one opaque registration identity. Do not derive authority from plugin ID or path.
3. Inspect the registration and verify panel-only, hidden, process-memory-only state before starting other resources.
4. Start the existing combined human-gate resources using their exact resource registry: Team Runner, three decorationless Ghostty windows, and the visible Pi processes. Do not add a new launcher in this spike.
5. Summon the panel with the initial committed projection.
6. Confirm exactly three Agent Console cards and three Pi footer labels agree while all roles are waiting.
7. Deliver the managed Builder assignment through the existing visible-agent path. Send the later committed projection through `call` using the exact registration identity, then confirm Builder changes to managed/working while Coordinator and Reviewer remain byte-for-byte unchanged.
8. Submit authorized interactive Builder input and deliver the committed manual-takeover projection through `call`. Confirm Builder-only takeover and sibling isolation.
9. Hold the state for one minute. Confirm the decorationless Pi footers and Agent Console cards remain visible and agree without reading or scraping conversation output.
10. Hide the exact registration. Confirm the panel is no longer visible and its item is unloaded while the registration remains inspectable and reusable.
11. Summon it again and confirm the authoritative runner snapshot reconstructs the same committed projection without interrupting agents.
12. Hide, then unregister the exact registration. Poll until teardown is terminal. Confirm its Loader, item, payload queue, call queue, ID claim, and source claim are gone.
13. Repeat hide and unregister. Confirm the documented idempotent results and that no sibling or installed plugin changed.
14. Clean up every gate resource by its recorded exact identity.

## Forced-failure sequence

A separate authorized run must force failure after registration and after panel load:

1. Register every created resource before advancing.
2. Trigger one assertion failure or interruption.
3. Hide and unregister only the recorded temporary registration.
4. Run the existing exact-identity gate cleanup.
5. Confirm unrelated processes, windows, sockets, directories, plugins, and shell state survive.
6. Treat any refused cleanup as pending and retryable. Never broaden cleanup by name, prefix, focus, wildcard, or global shell restart.

## Acceptance observations

The private report must establish:

- the capability query occurred before any other resource creation;
- source stayed in the repository;
- registration and enablement remained process-local;
- initial summon and at least two later committed updates reached the same panel;
- wrong, stale, and duplicate identities failed without affecting the current registration;
- hide and unregister addressed only the exact registration;
- all Loader, object, and queue state disappeared after unregister;
- shell configuration and installed plugin state stayed byte-identical;
- shell restart, if separately authorized, cleared temporary state and did not revive the old identity;
- forced failure cleanup removed only gate-owned resources;
- no hidden agent performed visible-agent work.

Visual observations and screenshots remain private under `${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/`. They do not enter Git.

## Failure policy

Any mismatch aborts the gate and records an `ABORTED` result. Cleanup still uses exact registered identities. The operator must not compensate with a standalone Quickshell process, generic Qt/GTK window, source copy or symlink under user config, temporary `shell.json` edit, assumed preinstalled plugin, shell restart, or installed-source edit.

## Result boundary

A passed human gate would prove live behavior only for the accepted installed Omarchy and Quickshell versions, the exact Agent Console source, and the stated trusted same-user threat model. It would not prove upstream portability, race-free same-UID source protection, reboot recovery, remote execution, or production readiness.
