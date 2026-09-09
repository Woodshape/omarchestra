# Live Adoption human validation

Status: **engineering acceptance complete; human setup and live validation unrun.**

**PROTOTYPE — NOT PRODUCTION.** This procedure creates a disposable, locally
owned Team Goal/Role store. It never launches Pi, installs a plugin, dispatches
an Assignment, or grants PTY/process authority. Automated engineering gates do
not execute this procedure.

## Separate prerequisite

Explicitly install/verify the Omarchestra-owned Companion **0.4.0** through the
existing authorized setup procedure, selecting `--release 0.4.0`. This is a
separate human operation, not something the gateway performs. The historical
managed default remains 0.2.0; accepted observation uses immutable 0.3.0.
0.4.0 adds a separate Adoption session and preserves those presentation paths.

The gateway checks the loaded method surface, generation and stable
installation fingerprint. A stale loaded plugin is rejected rather than
updated/reloaded automatically. No broader Pi compatibility or live rendering
claim follows from fake-host tests.

## Procedure

Run from the repository root in an interactive terminal:

```sh
just prototype-live-adoption-bridge
```

The launcher prints, but never executes, the command for a visible ordinary Pi
in a second terminal. Keep that **same Pi process and extension** alive.
Before gateway startup, confirm fail-open ordinary use while its socket is
absent. Press Enter in the gateway terminal and authorize exactly:

```text
Run Omarchestra Live Adoption Bridge? y/N    (N is the default; type y or Y to authorize)
```

1. Confirm the same Pi registers as **Unassigned · observed**, without changing
   its ordinary title or receiving work.
2. In Companion's Adoption panel, choose the exact session and vacant local
   Role. Confirm the exact displayed proposal. Verify one Agent Run, the same
   Pi's committed Role/status, and no automatic Assignment.
3. Confirm readiness becomes connected only after that Pi receives the commit.
4. Submit ordinary interactive input in Pi. It must continue unchanged, while
   Pi and Companion show **manual takeover** and managed readiness is revoked.
   The bridge reads only input `source`; it never reads or records content.
5. Close that Pi session. Confirm the managed connection is disconnected.
6. Type `status`, then `quit` in the gateway. Gateway success requires its
   machine-observed commit, same-Pi readiness, durable takeover and disconnect
   **before cleanup**, and zero Assignment dispatch.
7. Only if all UI observations actually passed, enter
   `I VERIFIED THE ADOPTION CHECKLIST` at the launcher prompt. Otherwise leave
   the human checklist unconfirmed. Exact cleanup must also pass.

`PASS` means machine facts passed **and the operator attested to the UI**;
it is not an independently audited UI transcript. Missing facts cannot produce
success merely by typing the confirmation phrase. Cleanup failure is FAIL,
missing UI attestation is INCOMPLETE, and aborted startup is ABORTED.

## Recovery boundary

Recovery covers gateway loss while the **same Pi process/extension survives**,
not Pi crash, `/reload`, session replacement, or reboot. The manual extension
makes up to 32 bounded reconnect attempts (roughly 143 seconds of backoff).
Outside that retry window this procedure makes no automatic recovery promise.

If the foreground gateway is killed with SIGKILL, the launcher records
`RECOVERY_REQUIRED` and preserves exact runtime/ownership evidence. It prints a
`node ... live-adoption-gateway.ts --live --resume ...` command referring to the
original socket and database identity files. Run that exact command promptly
and authorize it. Do not reconstruct paths or identities from names/PIDs.

The resumed gateway must acquire the separate SQLite exclusive ownership lock
before touching the old socket; an active gateway prevents recovery. Original
DB/owner-file inodes and the socket inode must match. The store loads before
fresh registration; the surviving extension answers a new connection-bound
challenge and receives the original committed result, not another Adoption.
Durable manual takeover cannot silently return to managed readiness.

A successful direct resumed gateway invocation removes its owned DB/lock/socket
resources. The printed `rmdir` command removes only the empty runtime directory;
no recursive deletion is authorized. The original SIGKILL run remains
`RECOVERY_REQUIRED`, not retroactively PASS. A full human PASS requires a fresh
complete checklist or a separately recorded recovery review.

## Privacy, installation and cleanup

Private evidence stays outside Git under
`$XDG_STATE_HOME/omarchestra/adoption-gates` (or the normal HOME fallback).
Directories are 0700; files are 0600. Evidence contains fixed procedure text,
allow-listed phases, exact socket/database/ownership-file identities, and a
verdict. Do not copy conversation, input, tool data, terminal output, credentials,
repository content, or raw errors into evidence.

Only the gateway holding its ownership lock removes the exact DB files. The
launcher verifies they are absent. Replacements, symlinks, changed parent
identity, unrelated manifest paths, or residual unowned SQLite sidecars stop
cleanup and must be reconciled manually without guessing or recursive deletion.

Runtime operations never install, update, rescan, disable, unload or remove the
Companion. `runtimeBinding` stays null and its guarantee stays unavailable.

## Accepted R1 limitation

`ctx.isIdle()` plus existing guards remains best-effort under the accepted R1
contract. This is not a complete slash-command/user-bash classifier. Do not
inspect content, wrap shell commands, or inject terminal input to strengthen it.

## Automated preparation

```sh
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-live-adoption-check
```

This runs injected transports/Pi/shell, disposable SQLite fixtures, isolated QML
functions, static lint, cleanup adversarial tests and non-TTY refusal checks.
It never performs installation or a live Adoption run.
