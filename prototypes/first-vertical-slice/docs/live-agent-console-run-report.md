# Live Agent Console implementation run report

Status: **COMPANION MILESTONE COMPLETE (fake-only) — installation, Projection Session, QML, acceptance, and boundary seams are green. The per-run loader is retired; live agreement remains unproven.**

This report belongs to the disposable first vertical slice. It records what the
original Fusion run and the follow-up Companion milestone proved. It is not
live or production evidence. Architecture disposition on 2026-09-02: keep the
projection seam, keep the old launcher fail-closed as rejected evidence, and
replace per-run QML registration with explicit Companion Plugin setup plus
ephemeral Projection Sessions (ADR 0001). That replacement is now complete
fake-only; its human procedure exists but was not run.

## Scope and authority

The intended slice projects the existing Team Runner snapshot and ordered event
stream into three Agent Console cards. Authority remains unchanged:

- the Team Runner owns durable state, orchestration, the event cursor, role
  identity, and committed presentation values;
- the visible Pi process owns conversation/model semantics and displays its
  persistent footer status;
- Boomux or the selected terminal runtime owns PTYs and process attachment;
- the non-QML projection adapter owns protocol validation, cursor checks,
  reconnect, and plain-data handoff;
- QML renders injected values only.

The console must not read SQLite, infer canonical state from terminal output,
scrape ANSI or PTY output, inject terminal input, supervise agent processes, or
become another orchestration authority.

## Test-first public seams

These seams are fixed before implementation. Each new test must first fail for
the intended missing behavior, then pass after its owning implementation lands.
Automated tests use fake transports and fake process/window/resource registries.
They must not invoke the human gate or any live desktop, agent, provider,
remote, terminal-runtime, or service resource.

### S1. Projection adapter seam

A validated authoritative snapshot establishes the baseline. The adapter must:

1. accept exactly one Coordinator, one Builder, and one Reviewer card;
2. preserve each snapshot role and `agentRunId` as the connection's identity
   baseline;
3. advance only through contiguous ordered event sequences;
4. reject gaps, duplicates, malformed frames, cursor disagreement, duplicate or
   missing roles, and changed role/Agent Run identities;
5. enter an explicit reconnecting or gap condition rather than infer state;
6. after ordered events, obtain a new authoritative snapshot through the same
   runner projection protocol before publishing changed card values;
7. recover from a gap only through an explicit fresh authoritative snapshot;
8. never read SQLite or import runner domain/orchestration modules.

The adapter does not derive presentation state from control mode, assignment
state, event names, terminal text, or `piStatus`. The committed `piStatus`
string is the complete card label.

### S2. QML boundary seam

Injected plain projection values render the three card labels. Tests must prove
that QML:

1. displays the injected committed `piStatus` strings without parsing or
   rebuilding role/state labels;
2. presents the injected adapter status, including ready, reconnecting, and
   explicit gap conditions;
3. contains no SQLite, runner-domain, process-supervision, PTY, SSH,
   terminal-scraping, or durable-storage dependency;
4. cannot launch the adapter or any agent/terminal resource;
5. parses and lints without starting Quickshell or the Omarchy UI.

A valid repository-local manifest and panel source prove only the plugin source
shape and presentation boundary. They do not prove that installed Omarchy can
load that source live.

### S3. Launcher contract seam

Tests must prove:

1. every agent Ghostty launch uses `--window-decoration=none`;
2. no agent Ghostty launch pins `--title`;
3. the retired launcher remains fail-closed and absent from active recipes;
4. the replacement Companion setup recipe is clearly human-only, requires a
   TTY and exact typed authorization, and is reachable in automation only via
   `--check` or static analysis;
5. no standalone Quickshell, generic Qt/GTK, temporary user-config staging,
   symlink, or assumed preinstalled-plugin fallback exists.

Dynamic `Omarchestra — <Role> — <state>` title metadata remains available to
Hyprland/window switchers, but is not visible chrome or an independent human
acceptance surface.

### S4. Failure cleanup seam

A forced failure after fake resource registration must remove only the exact
registered fake resources:

- PIDs;
- window classes and addresses;
- sockets;
- scratch directories.

The check must leave unrelated fake resources untouched and exercise cleanup
on failure, interruption, and assertion paths. Exact identities authorize
cleanup: process identities must match byte-for-byte at registration and
cleanup; filesystem device/inode identity is captured; and filesystem paths
must have no symlink component at registration or cleanup. Refused resources
remain pending and retryable, and `clean` stays false until no registration
remains. Names, prefixes, substring matches, wildcard matching, current focus,
and global stop or restart operations do not authorize cleanup.

The retained old launcher still implements the rejected loader path and must
continue to fail before registration of runner, Pi, Ghostty, provider,
Hyprland, or UI resources. The active replacement procedure has fake-proven
exact PID, window, runner/control-socket, and directory cleanup plus byte-identical
installation fingerprints around runtime clear/hide. Fake cleanup evidence
does not claim that a combined live run occurred.

### S5. Source-audit seam

The dependency and recipe audit must prove that default automated commands
cannot launch or control:

- Pi or a provider request;
- Ghostty;
- Hyprland actions;
- Quickshell or Omarchy UI;
- SSH;
- Boomux;
- systemd.

The fake-only check may start only its bounded test/lint processes and any
existing explicitly permitted local prototype runner checks. Fusion and every
automated recipe are statically barred from the live adapter and human path;
the replacement script may be executed by automation only with `--check`.

### S6. Companion installation seam

The fake-only installation suite fixes immutable inspection plans, exact
compatibility, plan-bound authorization, no-follow filesystem identity,
receipt-backed ownership, supported shell enablement, update, rollback, exact
uninstall, and incomplete recovery. Unknown versions, symlinks, foreign or
changed assets, ownership/mode errors, malformed/conflicting `shell.json`,
stale preconditions, and forged authorization fail before unrelated state is
changed.

### S7. Persistent plugin and ephemeral Projection Session seam

One installed `omarchestra.agent-console` persists across Team Goals. Every
open receives a new session generation and begins from an authoritative
snapshot. The existing projection core and adapter own ordered events,
resnapshot, reconnect, acknowledged intent deduplication, and stale-generation
rejection. Fake plugin reload reconstructs identical cards without changing
agent identities, connections, assignments, or delivered turns. Runtime
clear/hide leaves plugin assets, receipt, and `shell.json` byte-identical.

## Plain projection handoff contract

The adapter-to-QML value has exactly these top-level fields:

```json
{
  "status": "ready",
  "cursor": 12,
  "cards": [
    {
      "role": "coordinator",
      "agentRunId": "agent-run-coordinator-1",
      "piStatus": "Coordinator · waiting"
    },
    {
      "role": "builder",
      "agentRunId": "agent-run-builder-1",
      "piStatus": "Builder · managed"
    },
    {
      "role": "reviewer",
      "agentRunId": "agent-run-reviewer-1",
      "piStatus": "Reviewer · waiting"
    }
  ]
}
```

Contract rules:

1. `status` is `ready`, `reconnecting`, or `gap`.
2. `cursor` is the last accepted non-negative runner event cursor.
3. `cards` contains exactly three entries in Coordinator, Builder, Reviewer
   order after the first authoritative snapshot.
4. `role`, `agentRunId`, and `piStatus` are copied from validated runner
   projection values. No QML-side display-name map or adapter-side state-label
   derivation is permitted.
5. `piStatus` is displayed as one opaque committed label. Neither layer splits
   it into role and state or reconstructs it from other fields.
6. During reconnecting or gap after a baseline, the handoff may retain the last
   authoritative three cards, but `status` makes them explicitly non-current.
   Events never mutate those retained cards.
7. No handoff is published before the first valid authoritative snapshot.
   This avoids fabricating placeholder role/state values. A pre-baseline
   protocol failure is reported by the adapter as a failure, not converted into
   invented cards.
8. A fresh snapshot may return the handoff to ready only when its cursor and all
   three role/Agent Run identities pass validation.

This value is in-memory projection data, not durable state. The handoff carries
no transcript, terminal output, assignment prompt, SQLite reference, process
control, or user intent.

## Omarchy live-launch finding and disposition

Installed Omarchy has no supported repo-local ephemeral third-party plugin
loader. It scans third-party plugins only under
`~/.config/omarchy/plugins/`; enabling a third-party plugin persists
`~/.config/omarchy/shell.json`; and `summon` accepts only a discovered, enabled
plugin ID. The exact evidence is recorded in
[`live-agent-console-launch-blocker.md`](live-agent-console-launch-blocker.md).

The old implementation must continue to fail closed rather than substitute a
standalone dashboard or hidden per-run configuration mutation. The product
resolution is separate, explicit installation of a persistent Omarchestra
Companion Plugin through the supported third-party path. A Team Goal then uses
only an ephemeral Projection Session and cannot mutate installation state.

## Evidence ledger

| Evidence | Intended red | Current green state |
| --- | --- | --- |
| Original projection adapter | `live-agent-console-adapter-red.txt`: 12 fail | `live-agent-console-adapter-green.txt`: 12 pass |
| Original QML boundary | `live-agent-console-qml-red.txt`: 1 pass / 5 fail | `live-agent-console-qml-green.txt`: 6 pass plus static lint |
| Original launcher/cleanup/audit | `live-agent-console-launcher-red.txt`: intended missing-contract failures | `live-agent-console-launcher-green.txt`: original seams green; retired launcher remains fail-closed |
| Companion installation | `companion-installation-red.txt`: 22 intended failures | `companion-installation-green.txt`: 22 pass |
| Companion Projection Session | `companion-projection-red.txt`: 1 negative assertion pass / 23 intended failures | `companion-projection-green.txt`: 24 pass |
| Integrated Companion acceptance | `companion-acceptance-red.txt`: 1 boundary pass / 4 intended failures | `companion-acceptance-green.txt`: 5 pass plus standalone acceptance verdict |
| Extended recipe/module/QML boundary | Assertions added after implementation | `companion-boundary-green.txt`: 18 pass |
| Human replacement procedure | Live execution prohibited in automation | `companion-human-recipe-check.txt`: TTY, exact authorization, private evidence, exact cleanup, and `--check` boundaries pass; live not run |
| Complete Companion gate | All fake seams compose | `just prototype-companion-check`: 58/58 tests plus standalone acceptance and launcher `--check` pass |
| Agent Console fake-only regression | Existing and extended seams remain green | `just prototype-live-agent-console-check`: 58/58 tests plus module links, launcher `--check`, syntax, and QML lint pass |
| Existing prototype gates | No regression | `prototype-vertical-slice` and `prototype-vertical-slice-manual-check` pass |
| Live Pi/Agent Console visual agreement | Human-only | Not run and not claimed |

The consolidated Companion chronology is in
[`../evidence/companion-red-green-ledger.md`](../evidence/companion-red-green-ledger.md).

## Final report fields

1. **Implemented fake-only.** The shared Companion contract, deep installation
   lifecycle, fake Omarchy ports, persistent-plugin shell fake, ephemeral
   Projection Session manager, reused projection core/adapter, adapted QML,
   integrated acceptance, standalone acceptance, and extended boundary audits
   are complete.
2. **Automated entry point.** `just prototype-companion-check` is the complete
   unattended Companion gate. `just prototype-live-agent-console-check`
   retains the wider Agent Console regression and static boundary checks.
3. **Human-only entry point.** `just prototype-companion-setup-validation` is
   the only active live Companion recipe. It requires a compatible host, TTY,
   displayed immutable plan, exact typed authorization, owner-only private
   evidence, and exact runtime cleanup. Its live path was not invoked.
4. **Retired path.** `manual/run-live-agent-console-gate.sh`, its blocker
   report, and the ephemeral-loader spike remain fail-closed rejected evidence.
   No active recipe depends on them.
5. **Boundaries.** Routine projection imports cannot reach installation or
   configuration mutation code. QML has no filesystem, protocol, cursor,
   reconnect, shell-command, terminal, storage, or orchestration authority.
   Runtime cleanup never removes the persistent plugin.
6. **Scope.** Ordinary-terminal observation and Adoption remain unimplemented.
   Production packaging, broader compatibility, and live rendering evidence
   also remain outside this completed fake-only milestone.
7. **Live claim.** No live GUI, Pi, provider, remote, Boomux, systemd, SSH,
   Quickshell, Omarchy UI, installation, or private live-evidence action
   occurred in this Companion run.

Review findings F1 (console `open()` must apply a validated projection before
opening), F2 (stale report status), and F3 (wipe instructions) are resolved.
The later cleanup review is also resolved: process identity is verified exactly
at registration and cleanup rather than by substring; directory/socket device
and inode identities are captured; symlink components are rejected both at
registration and cleanup; and refused resources remain pending and retryable
instead of making `clean` report a false success. See `evidence/live-agent-console-validation.txt`
for the post-fix runs.

Do not commit or push this prototype work.
