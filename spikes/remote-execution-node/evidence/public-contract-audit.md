# Public contract audit

Status: captured for the automated harness; no daemon or remote Node was contacted.

## Sources

The spike uses only these public Boomux materials:

- Boomux 1.8.0 `README.md`, especially Remote Nodes and automation guidance.
- Boomux 1.8.0 `docs/remote-nodes.md`.
- Boomux 1.8.0 `docs/cli-json.md`.
- Boomux 1.8.0 `docs/event-stream.md`.
- The installed CLI's non-mutating `--version`, `capabilities --json`, and relevant `--help` output, captured in [`boomux-public-contract.txt`](boomux-public-contract.txt).

The capture invoked no daemon status, Node snapshot, SSH, Workspace, Shell, open, close, Pi, systemd, or GUI action. Help and static capabilities do not start or contact the daemon.

## Accepted public boundary

1. `boomux capabilities --json` is static discovery. The harness requires CLI 1.8.0, protocol 49, `boomux.cli/v1`, typed errors, pinned Node identity, combined Node snapshots, projection synchronization, remote PTY attachment, owner-environment attachment, global Workspaces, multi-Node placements, Shell Run identity, and reconnectable cursors.
2. `node inspect SELECTOR --json` supplies the local registration's exact alias, SSH target, pinned Node ID, revision, and tombstone epoch. `node snapshot SELECTOR --json` supplies current observed health, staleness, protocol, capabilities, and Node-qualified projections. Both are reconciled before every mutation, presentation, reconnect, and cleanup phase.
3. An SSH target is a route, not identity. The harness requires the registration alias, input target, and expected pinned Node ID to agree. It never adds, renames, retargets, forgets, upgrades, uninstalls, reauthenticates, or rekeys a Node.
4. Cached projections are read-only presentation evidence. Mutation and exact owner inspection require a live verified route. Direct remote inspection runs the same public JSON CLI on the owning Node through the explicit authenticated SSH route. It does not read Boomux files, sockets, Rust modules, or daemon protocol messages.
5. Empty `workspace create NAME` and command-backed `shell create GLOBAL --node NODE --name NAME --cwd CWD -- ARGV...` are human-output mutations. Human stdout is discarded as identity evidence. Intent is durable before invocation, and advertised JSON snapshot/inspect readback must prove one exact new identity and specification.
6. The atomic JSON Workspace create form necessarily creates its generated first Shell and cannot carry this spike's required exact Pi argv. The harness therefore creates an empty coordinated Workspace, then exactly three role Shells.
7. `open SHELL --node NODE --workspace GLOBAL --title TITLE --takeover` is a human-only presentation operation. Pre/post public inspection can detect a Shell Run replacement but cannot provide an atomic expected-Run guarantee. The harness records `atomicExpectedRunGuarantee: false`; any replacement is an unsupported, uncertain outcome.
8. Public snapshots and events do not expose attachment presence. The normalized value remains `unavailable`.
9. Event cursors order one daemon stream. Cursor expiry or stream replacement is an explicit gap followed by a fresh baseline snapshot, never continuous replay.
10. Cleanup authority comes only from the bound receipt and exact readback. Names and prefixes are collision checks, not destruction authority. Foreign Shells, Launchers, Agents, changed Runs, changed Node identity, incomplete evidence, or ambiguity block cleanup.

## Command allowlist

Stable JSON reads:

```text
capabilities --json
daemon status --json
node list --json
node inspect SELECTOR --json
node snapshot [SELECTOR] --json
workspace list --json
workspace inspect ID --json
shell inspect ID --json
events [--after CURSOR] --limit N --wait-ms N --json
```

Version-pinned human-output operations, always followed by JSON reconciliation:

```text
workspace create NAME
shell create GLOBAL --node NODE --name NAME --cwd CWD -- ARGV...
open SHELL --node NODE --workspace GLOBAL --title TITLE --takeover
shell close SHELL --workspace WORKSPACE
workspace close GLOBAL
```

No public command output containing terminal bytes is consumed. In particular, the harness never calls or parses `boomux read`.

## Excluded coupling

The harness does not import Boomux Rust modules, read private state or runtime sockets, invoke hidden commands, contact the daemon protocol directly, scrape PTY/ANSI output, mutate configuration or integrations, manage either daemon, mutate Node registration, use focused/current selection for identity, or perform global cleanup.
