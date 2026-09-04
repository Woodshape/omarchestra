# Proposed observer bridge live validation

Status: **PROPOSED — not run; no live observer or Adoption evidence exists**

**PROTOTYPE — NOT PRODUCTION.** This is a human-only procedure for the
observation-only bridge. It is not an automated recipe and it does not install
the Companion, create a Team Goal, perform Adoption, or claim production
support.

## Scope and stop rules

This procedure validates only:

```text
visible ordinary Pi
  -> observer extension in that same Pi process
  -> owner-only Unix NDJSON socket
  -> disposable observation gateway
  -> Companion 0.3.0 applyObservedAgents seam
```

Observation grants no Team Goal, Role, Assignment, control mode, writer lease,
Runtime Binding, PTY, terminal, process, prompt, input, or workflow authority.
The separate Pi command is printed for the operator and is never launched by the
launcher. The gateway has no Adoption route.

Stop without weakening the contract if any step would require terminal
scraping, conversation inspection, input inspection, input injection, PTY
control, a hidden Pi, a child process launched for Pi, or a plugin mutation.
Do not turn this procedure into live Adoption validation. No live Adoption
claim is permitted from this run.

## Companion 0.3.0 prerequisite

The required installed component is the Omarchestra-owned
`omarchestra.agent-console` **0.3.0** release. The catalog retains the earlier
0.2.0 managed Companion artifact as historical coverage. The observer release
is a separate catalog entry with the same plugin ID, additive
`session.observer`, and the observer QML assets. `COMPANION_PLUGIN_VERSION =
0.2.0` remains the historical default for the existing managed Projection
Session path and must not be changed as part of this observer procedure.

The operator must complete any install or update as a separate, explicitly
authorized setup operation before this run. The observer launcher performs only
read-only capability discovery and before/after installation fingerprinting.
It must not install, update, rescan, enable, disable, unload, or rewrite the
Companion.

The read-only preflight must report:

- protocol `omarchestra.companion/v1`;
- plugin ID `omarchestra.agent-console`;
- version `0.3.0`;
- a positive plugin generation;
- all six baseline managed capabilities; and
- additive `session.observer`.

If any fact differs, stop. Do not treat a 0.2.0 installation as an observer
release and do not install from inside this bridge run.

## Automated preparation

The only unattended command for this bridge is the fake-only check:

```bash
just prototype-live-observer-check
```

It runs injected in-memory transports, the observer and Companion fakes, static
reachability/privacy audits, module imports, shell syntax checks, and
`run-live-observer-bridge.sh --check`. It does not inspect user state, invoke
Omarchy shell IPC, open a live socket, launch Pi, or inspect an installed
plugin. It produces no private live evidence. Automation performed no live run,
and no live Adoption claim is made.

## Human setup

Use one ordinary terminal and one additional interactive terminal for the
visible Pi. Run from a checkout of the repository with:

- Pi 0.84.4 or the explicitly validated compatible Pi version;
- the compatible Omarchy/Quickshell host for Companion 0.3.0;
- a canonical existing `XDG_RUNTIME_DIR` outside the repository; and
- an `XDG_STATE_HOME` outside the repository for private evidence.

The runtime directory created by the launcher is mode `0700`. Evidence is
created below `$XDG_STATE_HOME/omarchestra/observer-gates`, with the evidence
directory mode `0700` and evidence files mode `0600`. Do not point either
location into the repository, through a symlink, or at a shared scratch tree.

The launcher will print the ordinary visible Pi command before starting the
gateway. Run that command manually through the normal terminal workflow. Do not
start Pi through a Team Runner, a terminal runtime, a shell wrapper, or the
launcher. Do not record prompts, responses, input, tool data, terminal output,
repository content, credentials, cwd, title, focus, provider/model values, or
raw errors.

## Human procedure

From the repository root, in the gateway terminal, run:

```bash
just prototype-live-observer-bridge
```

The command requires a TTY on both stdin and stdout. It prints the exact Pi
command, the bounded checklist, and the exact authorization phrase. Type the
phrase exactly when prompted:

```text
I AUTHORIZE OMARCHESTRA OBSERVER LIVE BRIDGE
```

The launcher prints the Pi command, waits, and then starts one foreground
observer gateway only after the operator presses Enter. It never launches the
printed Pi command. In the other terminal, the operator runs the printed
command manually with `OMARCHESTRA_OBSERVER_SOCKET` set to the exact displayed
Unix-socket path.

Check the following facts in order. Record only the phase labels and bounded
status/version facts, not the session content:

1. **Fail-open.** While the launcher is waiting and the gateway socket is
   absent, run the printed Pi command. Keep that same Pi process open and
   confirm it remains interactive while observer connection attempts fail.
2. **Reconnect and registration.** Promptly return to the launcher and press
   Enter before the bounded reconnect budget is exhausted. Complete the exact
   authorization prompt. Confirm that the same visible Pi process reconnects
   and produces one current observed registration with no duplicate record.
   Registration attempt and source sequence values must increase, and the
   status must be exactly `Unassigned · observed`. If the retry budget expires,
   stop and restart the procedure instead of weakening it.
3. **Heartbeat.** Leave the visible Pi idle for more than one five-second
   heartbeat interval. Confirm the gateway remains healthy and the observation
   remains current.
4. **Disconnect.** Close the visible Pi normally. Confirm the observation is
   unavailable. The bridge must not kill, supervise, scrape, or reattach the
   terminal.
5. **Expiry.** Leave the disconnected observation alone for more than the
   fifteen-second lease. Confirm it expires from the current collection.
6. **Fresh process.** Run the same printed command again while the gateway is
   running. Confirm one fresh current registration with fresh process/session
   identities and no duplicate collection entry. Do not claim continuity with
   the closed Pi process.
7. **Pause and resume.** Use only `pause`, `status`, and `resume` in the
   gateway terminal. Confirm registry sweeping and lease expiry continue while
   publication is paused, and that the latest bounded snapshot publishes after
   resume.
8. **Quit and cleanup.** Use `quit`. Confirm the gateway exits, installation
   fingerprint before and after is identical, and the exact socket and runtime
   directory are absent after device/inode checks. Do not recursively remove a
   substituted or unexpected resource.

## Companion panel-opening limitation

Companion 0.3.0 exposes `applyObservedAgents` as a sessionless observer state
update. That call does **not** open `AgentConsole.qml`: the panel's visibility
still depends on its existing `open()` Projection Session path. The observer
gateway cannot summon the panel, create a managed three-card projection, or
invent a Projection Session to make an observed card visible.

Therefore this procedure may establish successful capability verification,
observation publication health, registration, heartbeat, disconnect, expiry,
reconnect, and cleanup without visual panel evidence. If an independently valid
Companion Projection Session is already open, the operator may observe the
`Unassigned Agents` projection there, but must not create that managed session
solely for this test or interpret it as live Adoption evidence. A future
Companion contract change is required for a standalone observer-only panel.

## R1 limitation

Pi 0.84.4 does not expose a complete content-free start/end lifecycle for
slash-command and `user_bash` execution. Extension commands bypass the input
hook, and `user_bash` is content-bearing without a matching completion event.
The observer contract therefore accepts `ctx.isIdle()` plus its existing guards
as best-effort reconciliation. This run must not inspect input or command
content, wrap shell execution, scrape the terminal, inspect conversation state,
or inject input. A passing run is not proof that arbitrary command activity was
absent.

## Evidence and disposition

The launcher retains only bounded private evidence:

- `procedure.md`, the fixed checklist;
- `companion-capabilities.json`, the validated protocol/plugin/version/generation
  and capability list;
- `installation-fingerprint-before.txt` and `installation-fingerprint-after.txt`;
- `observer-events.ndjson`, containing allow-listed phase names; and
- `verdict.txt`.

Evidence contains no prompts, responses, input, tool names or results, terminal
output, repository content, credentials, environment values, cwd, title,
focus, provider/model values, or raw errors. It must remain outside Git.

The launcher refuses existing runtime paths, symlink components, non-canonical
paths, unsafe ownership/modes, socket substitution, and runtime identity drift.
It uses exact device/inode checks and non-recursive directory removal. If a
cleanup check fails, preserve the resource and the private evidence for manual
reconciliation. Never guess a path or use recursive deletion.

A successful run would establish only the bounded live observer transport and
publication behavior above. It would not establish production packaging,
standalone observer-panel opening, Adoption, remote execution, reboot
recovery, PTY guarantees for an adopted session, or broader Pi compatibility.
