# Live Agent Console gate — first vertical-slice prototype

Status: **FAIL CLOSED ON THE INSTALLED OMARCHY API — live visual agreement pending.**

This is the manual procedure for the removable first vertical-slice
prototype's combined live Agent Console gate. The automated gate remains
fake-only and never invokes this procedure, any visible agent host, terminal
emulator, desktop compositor action, provider, terminal runtime, remote
transport, service manager, or desktop shell/UI process.

## What each layer proves

| Evidence | Kind | Status |
| --- | --- | --- |
| `just prototype-vertical-slice` | fake-only automated | proven (durable runner, protocol, takeover, restart, reconnect) |
| `just prototype-vertical-slice-manual-check` | fake-only automated | proven for the role-label adapter |
| `just prototype-live-agent-console-check` | fake-only automated | green — all five seams (adapter, QML boundary, launcher contract, failure cleanup, source audit) |
| `just prototype-vertical-slice-role-label-gate` | prior human evidence | completed — three decorationless visible Pi hosts, persistent Pi status labels, waiting → managed → manual_takeover, sibling isolation, one-minute persistence (`docs/manual-role-label-gate.md`) |
| Agent Console cards against live Pi | human-only | **PENDING — blocked**, see below |

## The combined human gate recipe

```bash
just prototype-live-agent-console-gate
```

This recipe is human-authorized only. It is never referenced by any automated
recipe, test, or acceptance module; the fake-only
`prototype-live-agent-console-check` recipe may invoke its launcher only with
`--check`.

## Failure rules

1. The launcher must preflight the upstream ephemeral plugin capability and
   exit nonzero **before** it starts or contacts a runner, visible agent host,
   terminal emulator, desktop compositor action, provider, terminal runtime,
   remote transport, service manager, or desktop shell/UI process.
2. No live resource registration may happen before that preflight passes. If
   any resource is ever created by a future launcher version, it must register
   exact identities (PIDs, window classes/addresses, sockets, scratch
   directories) in the gate resource registry so that cleanup removes exactly
   those resources on success, failure, interruption, and assertion paths,
   while unrelated resources survive untouched.
3. Cleanup is authorized only by exact registered identities. Process identity
   must match byte-for-byte at registration and cleanup; directory/socket
   device and inode identity must remain unchanged; and their paths may contain
   no symlink component at registration or cleanup. A refusal remains pending and keeps
   the registry unclean until an exact retry succeeds. Names, prefixes,
   substring matches, wildcards, focus, or global stop/restart operations never
   authorize destruction.
4. Any checkpoint failure aborts the gate, records the deviation, and runs
   exact cleanup; aborted runs write an explicit ABORTED verdict into the
   private evidence.
5. On this installation the recipe always fails closed with exit 1 and prints
   the blocker report. That is the intended behavior, not a bug.

## Private evidence location

Private live evidence belongs outside Git under:

```text
${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/
```

It is created with mode `0700` by an authorized run only. No screenshot,
transcript, scratch directory, socket, or process record from a live run ever
enters the repository.

## Why live loading is unsupported today

The installed Omarchy shell discovers third-party plugins only under the
user's plugin configuration directory; enablement persists user shell
configuration; and summon accepts only a discovered, enabled plugin ID. There
is no supported repo-local, ephemeral, non-mutating plugin loader. The full
installed-API evidence, the forbidden fallbacks (standalone Quickshell
instances, generic Qt/GTK windows, symlinks or copies under the user config,
`shell.json` edits, assumed preinstalled copies), and the exact failure
behavior are recorded in
[`live-agent-console-launch-blocker.md`](live-agent-console-launch-blocker.md).

The current human recipe therefore fails closed before any resource creation
and points operators at the completed terminal-side gate and the blocker
report.

## Smallest required upstream plugin-path capability

The next upstream capability must provide, as a supported public API:

```text
registerTemporaryPlugin(absoluteRepoPluginDirectory) -> opaque registration
summon(opaque registration, payload)
hide(opaque registration)
unregister(opaque registration)
```

Equivalent shapes are acceptable when they keep the source in the repository,
make registration process-local or explicitly ephemeral, write nothing under
the user's Omarchy configuration or installed shell sources, run inside the
existing shell with shared theme injection, return an exact identity that
authorizes only its own hide/unload, document restart/crash/duplicate/
collision semantics, and expose a non-mutating capability query so the human
launcher can fail before creating any other resource. Details:
[`live-agent-console-launch-blocker.md`](live-agent-console-launch-blocker.md).

## Remaining human gate steps (after the upstream capability exists)

1. An operator explicitly runs `just prototype-live-agent-console-gate`.
2. The launcher preflights the capability, then starts the runner, three
   decorationless Ghostty/Pi hosts, and the Omarchy Agent Console surface.
3. The operator confirms, without reading conversation content: three
   decorationless Pi footers showing `<Role> · <state>`; three Agent Console
   cards redundantly showing the committed role/state values; waiting →
   managed → manual_takeover; Coordinator/Reviewer sibling isolation; and
   one-minute persistence.
4. The controller cross-checks the console's rendered values against the
   adapter's plain-data handoff log (never against scraped terminal output).
5. Exact cleanup removes every registered resource; a forced-failure path must
   do the same. Private evidence records the verdict.

Until that gate runs and passes, live Pi/Agent Console visual agreement is
unproven and must not be claimed by any document or test.