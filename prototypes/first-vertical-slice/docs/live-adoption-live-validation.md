# Live Adoption bridge live validation

Status: **BLOCKED; manual execution disabled; not run**

The procedure below is a future acceptance checklist, not a runnable validated
implementation. The launcher and gateway refuse live execution before resource
creation. Companion routing, lifecycle invalidation, transactional revalidation,
recovery and managed input remain incomplete. Capability discovery and
installation fingerprinting described below are requirements, not implemented
operations. See [the final handoff](live-adoption-engineering-handoff.md).

**PROTOTYPE — NOT PRODUCTION.** This is a human-only procedure for the
disposable live Adoption bridge. It is not an automated recipe and it does not
install the Companion, create a Team Goal, dispatch work, or claim production
support. It validates the bounded observed-to-managed Adoption transition only.

## Scope and stop rules

This procedure validates only:

```text
visible ordinary Pi
  -> Adoption extension in that same Pi process
  -> owner-only Unix NDJSON socket
  -> disposable Adoption gateway + durable store
  -> Companion 0.3.0 observer request/confirmation intents
  -> one committed Agent Run with committed role/state
  -> same-Pi managed bridge activation after commit
```

Adoption grants no automatic assignment. `runtimeBinding = null` and
`runtimeBindingGuarantee = unavailable` are preserved. The separate Pi command
is printed for the operator and is never launched by the launcher.

Stop without weakening the contract if any step would require terminal
scraping, conversation inspection, input inspection, input injection, PTY
control, a hidden Pi, a child process launched for Pi, a plugin mutation, or
automatic work dispatch. Do not turn this procedure into a production claim.

## Companion 0.3.0 prerequisite

The required installed component is the Omarchestra-owned
`omarchestra.agent-console` **0.3.0** release with additive `session.observer`.
The catalog retains the earlier 0.2.0 managed Companion artifact as historical
coverage. `COMPANION_PLUGIN_VERSION = 0.2.0` remains the historical default for
the managed Projection Session path and must not be changed.

The operator must complete any install or update as a separate, explicitly
authorized setup operation before this run. A completed Adoption launcher must perform read-only capability discovery and
before/after installation fingerprinting. The current launcher implements
neither and is disabled. It must not install, update, rescan, enable, disable,
unload, or rewrite the Companion.

## Automated preparation

The only unattended command for this bridge is the fake-only check:

```bash
just prototype-live-adoption-check
```

It runs injected in-memory transports, the durable store, the runner, the
gateway, the Companion controller, the managed-bridge activation tests, and
static reachability/privacy audits. It does not inspect user state, invoke
Omarchy shell IPC, open a live socket, launch Pi, or inspect an installed
plugin. It produces no private live evidence. Automation performed no live run.

## Human setup

Use one ordinary terminal and one additional interactive terminal for the
visible Pi. Run from a checkout of the repository with:

- the explicitly validated compatible Pi version (historical Pi 0.84.4
  references and the reported installed Pi 0.85.1 version do not establish
  compatibility or support);
- the compatible Omarchy/Quickshell host for Companion 0.3.0;
- a canonical existing `XDG_RUNTIME_DIR` outside the repository; and
- an `XDG_STATE_HOME` outside the repository for private evidence.

The runtime directory created by the launcher is mode `0700`. Evidence is
created below `$XDG_STATE_HOME/omarchestra/adoption-gates`, with the evidence
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
just prototype-live-adoption-bridge
```

The command requires a TTY on both stdin and stdout. It prints the exact Pi
command, the bounded checklist, and the exact authorization phrase. Type the
phrase exactly when prompted:

```text
I AUTHORIZE OMARCHESTRA ADOPTION LIVE BRIDGE
```

The launcher prints the Pi command, waits, and then starts one foreground
Adoption gateway only after the operator presses Enter. It never launches the
printed Pi command. In the other terminal, the operator runs the printed
command manually with `OMARCHESTRA_ADOPTION_SOCKET` set to the exact displayed
Unix-socket path.

Check the following facts in order. Record only the phase labels and bounded
status/version facts, not the session content:

1. **Fail-open.** While the launcher is waiting and the gateway socket is
   absent, run the printed Pi command. Keep that same Pi process open and
   confirm it remains interactive while observer connection attempts fail.
2. **Registration.** Start the gateway, complete the exact authorization
   prompt, and confirm the same visible Pi process produces one current
   observed registration with status exactly `Unassigned · observed`.
3. **Adoption.** From the Companion Unassigned Agents panel, request Adoption
   for the exact current session, confirm the exact displayed proposal, and
   confirm the same-process acknowledgement. Confirm exactly one committed
   Agent Run with the committed role/state and **no automatic assignment**.
4. **Managed bridge.** Confirm the committed role/state appears in the same
   visible Pi and that managed input is handled only by the committed bridge.
5. **Disconnect.** Close the Pi session. Confirm the managed bridge deactivates
   and no dispatch remains enabled.
6. **Quit and cleanup.** Use `quit`. Confirm the gateway exits and the exact
   socket and runtime directory are absent after device/inode checks. Do not
   recursively remove a substituted or unexpected resource.

## R1 limitation

Pi 0.85.1 does not expose a complete content-free start/end lifecycle for
slash-command and `user_bash` execution. The observer contract therefore accepts
`ctx.isIdle()` plus its existing guards as best-effort reconciliation. This run
must not inspect input or command content, wrap shell execution, scrape the
terminal, inspect conversation state, or inject input. A passing run is not
proof that arbitrary command activity was absent.

R1 accepts best-effort activity classification only. It does not exempt
capability discovery, installation fingerprinting, authority revalidation,
recovery or managed bridge composition.

## Evidence and disposition

The launcher retains only bounded private evidence:

- `procedure.md`, the fixed checklist;
- `adoption-events.ndjson`, containing allow-listed phase names;
- `socket-identity`, the exact socket device/inode;
- `database-identity`, the exact database/sidecar device/inode values; and
- `verdict.txt`.

Evidence contains no prompts, responses, input, tool names or results, terminal
output, repository content, credentials, environment values, cwd, title,
focus, provider/model values, or raw errors. It must remain outside Git.

The launcher refuses existing runtime paths, symlink components, non-canonical
paths, unsafe ownership/modes, socket substitution, and runtime identity drift.
It uses exact device/inode checks and non-recursive directory removal. If a
cleanup check fails, preserve the resource and the private evidence for manual
reconciliation. Never guess a path or use recursive deletion.

A successful run of the currently documented checks would establish only the
bounded live Adoption transport, one committed observed-to-managed transition,
and same-Pi managed bridge activation. It would not establish production
support, remote execution, reboot recovery, PTY guarantees for an adopted
session, or broader Pi compatibility.

## Version and live-validation statement

No installation or live validation was performed during this correction.
Historical Pi 0.84.4 references and the reported installed Pi 0.85.1 version do
not establish compatibility or support. Any future human procedure requires
separate authorization and version-specific validation after engineering
acceptance.
