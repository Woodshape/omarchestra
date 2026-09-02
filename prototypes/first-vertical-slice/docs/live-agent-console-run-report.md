# Live Agent Console implementation run report

Status: **IMPLEMENTATION COMPLETE (fake-only) — all automated seams red→green. The original per-run loader path is retired; live agreement awaits the persistent Companion Plugin replacement gate.**

This report belongs to the disposable first vertical slice. It records what the
original Fusion run proved and is not live or production evidence. Architecture
disposition on 2026-09-02: keep the projection seam, keep the old launcher
fail-closed, and replace per-run QML registration with explicit Companion
Plugin setup plus ephemeral Projection Sessions (ADR 0001).

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
3. the live Agent Console recipe is clearly human-only and is not referenced by
   any automated recipe;
4. the current human recipe checks the unsupported Omarchy capability and
   exits before creating any live resource;
5. no standalone Quickshell, generic Qt/GTK, user-config staging, symlink, or
   preinstalled-plugin fallback exists.

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

Because the current human recipe implements the retired loader path, it must
continue to fail before registration of runner, Pi, Ghostty, provider,
Hyprland, or UI resources. Fake cleanup evidence does not claim that a combined
live run occurred. Runtime cleanup for the replacement gate must clear exact
Projection Session and Team Goal resources while leaving the installed
Companion Plugin intact.

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
existing explicitly permitted local prototype runner checks. The human recipe
must never be reachable from an automated recipe.

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

| Evidence | Required result | Current state |
| --- | --- | --- |
| Projection adapter red test | Fails for intended missing adapter behavior | Done — `evidence/live-agent-console-adapter-red.txt` (12✖/0✔; implementation modules absent) |
| QML boundary red test | Fails for intended missing QML behavior | Done — `evidence/live-agent-console-qml-red.txt` (1✔/5✖; plugin sources absent) |
| Launcher/cleanup/audit red tests | Fail for intended missing contracts | Done — `evidence/live-agent-console-launcher-red.txt` (launcher 5✖/3✔, cleanup module-not-found, audit 4✖/1✔) |
| Projection adapter green test | Snapshot/event/reconnect/gap cases pass | Done — `evidence/live-agent-console-adapter-green.txt` (12✔/0✖) |
| QML boundary green test and lint | Injection and forbidden-dependency checks pass | Done — `evidence/live-agent-console-qml-green.txt` (6✔/0✖; `qmllint -I /usr/share/omarchy/shell` passes) |
| Launcher/cleanup/source-audit green tests | Human-only, exact fake cleanup, fake-only graph pass | Done — `evidence/live-agent-console-launcher-green.txt` (27✔/0✖) and combined in `evidence/live-agent-console-fake-only.txt` |
| `just prototype-live-agent-console-check` | Unattended and fake-only | Done — 45 tests, 45 pass, 0 fail, plus module link checks, launcher `--check`, and `qmllint` (`evidence/live-agent-console-fake-only.txt`) |
| Existing automated prototype gates | Remain green | Done — `just prototype-vertical-slice` exit 0 (gate refreshed `evidence/fake-only-acceptance.txt`); `just prototype-vertical-slice-manual-check` exit 0 |
| Live Pi/Agent Console visual agreement | Later explicit human gate only | Pending Companion Plugin setup and replacement gate |

## Final report fields

1. **Changed files.**

   - `justfile` — added `prototype-live-agent-console-check` (unattended,
     fake-only) and `prototype-live-agent-console-gate` (human-only).
   - `console/projection-core.ts`, `console/live-projection-adapter.ts` —
     projection state machine and foreground adapter (non-QML, injectable
     transport/sink).
   - `console/plugin/manifest.json`, `console/plugin/AgentConsole.qml`,
     `console/plugin/AgentConsoleCards.qml` — presentation-only Omarchy panel
     source; never installed, enabled, or loaded.
   - `console/test/projection-adapter.test.ts`, `console/test/qml-boundary.test.mjs`,
     `console/test/source-audit.test.mjs` — seam tests.
   - `manual/live-gate-resources.ts` — fake resource registry, exact-identity-only cleanup.
   - `manual/run-live-agent-console-gate.sh` — human-only fail-closed launcher
     with a fake-only `--check` mode.
   - `manual/test/live-agent-console-launcher.test.mjs`,
     `manual/test/live-gate-resources.test.ts` — launcher-contract and
     failure-cleanup seam tests.
   - `qml/AgentProjectionFixture.qml` — removed the client-side display-name map.
   - `README.md`, `docs/live-agent-console-gate.md`,
     `docs/live-agent-console-launch-blocker.md`, this report.
   - `evidence/live-agent-console-{adapter,qml,launcher}-{red,green}.txt`,
     `evidence/live-agent-console-fake-only.txt`,
     `evidence/live-agent-console-validation.txt`.

2. Exact red→green evidence: adapter 12✖→12✔
   (`evidence/live-agent-console-adapter-{red,green}.txt`), QML boundary
   1✔/5✖→6✔ (`evidence/live-agent-console-qml-{red,green}.txt`),
   launcher/cleanup/audit red 4✔/9✖ (`live-agent-console-launcher-red.txt`)
   → 27✔/0✖ (`live-agent-console-launcher-green.txt`). Final combined run:
   `just prototype-live-agent-console-check` — 45 tests, 45 pass, 0 fail
   (`evidence/live-agent-console-fake-only.txt`).

3. Findings. **Fake-only and automated:** all five seams (projection adapter,
   QML boundary, launcher contract, failure cleanup, source audit) pass with
   fake transports/registries only. **Human-proven (prior):** Pi status
   labels, transitions, isolation, persistence
   (`docs/manual-role-label-gate.md`). **Human-only:**
   `prototype-vertical-slice-role-label-gate` (completed terminal-side
   evidence) and the retired `prototype-live-agent-console-gate` (fails closed
   before any resource creation); neither is reachable from an automated
   recipe or module. **Rejected path:** repo-local ephemeral loading inside the
   installed Omarchy shell (`docs/live-agent-console-launch-blocker.md`).

4. Post-review checks: `just prototype-live-agent-console-check` 45/45;
   `just prototype-vertical-slice` exit 0; `just prototype-vertical-slice-manual-check`
   exit 0; `qmllint -I /usr/share/omarchy/shell` pass; module link check pass;
   `bash -n` clean on both wizards; source audits green; secret scan clean;
   `git diff --check` clean; shellcheck unavailable, recorded as skipped in
   `evidence/live-agent-console-validation.txt`.

5. Residue: no prototype scratch directories, sockets, repository runtime
   files, or runner/gate processes remain (`live-agent-console-validation.txt`,
   post-fix section); no private live evidence path exists in Git.

6. No live GUI, Pi, provider, remote, Boomux, systemd, SSH, Quickshell, or
   Omarchy UI action occurred during this Fusion run; the human gate was never
   invoked and the fake-only check reaches the combined launcher only via
   `--check`.

7. Remaining steps: fake-prove explicit setup, compatibility verification,
   update, rollback, and exact uninstall for a versioned Companion Plugin;
   adapt this projection core to open/reconnect/hide/clear Projection Sessions;
   then run a replacement explicitly human-authorized gate. No upstream
   Omarchy capability or per-run QML registration is required. Live Pi + Agent
   Console agreement remains unproven and unclaimed until that gate passes.

Review findings F1 (console `open()` must apply a validated projection before
opening), F2 (stale report status), and F3 (wipe instructions) are resolved.
The later cleanup review is also resolved: process identity is verified exactly
at registration and cleanup rather than by substring; directory/socket device
and inode identities are captured; symlink components are rejected both at
registration and cleanup; and refused resources remain pending and retryable
instead of making `clean` report a false success. See `evidence/live-agent-console-validation.txt`
for the post-fix runs.

Do not commit or push this prototype work.
