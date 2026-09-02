# Omarchestra first vertical-slice prototype

**PROTOTYPE — NOT PRODUCTION.** Removable as one directory
(`rm -rf prototypes/first-vertical-slice/` plus the five `justfile` recipes
listed under "Wipe instructions").
This directory is throwaway evidence for one question; nothing here is
production architecture and no file in it is promoted into the product.

## The question

> Can the accepted TypeScript/Node + SQLite + versioned-NDJSON seams
> truthfully support three persistently role-labelled visible-agent
> projections, one managed assignment, Builder-only manual takeover, durable
> runner restart, and reconnect — without coupling QML to persistence or
> creating a hidden agent process?

## Answer after the automated gate

**Supported with constraints.** Run `just prototype-vertical-slice` to
reproduce the fake-only evidence in `evidence/fake-only-acceptance.txt`.

Supported by the captured evidence:

- durable SQLite state (Team Goal, role bindings, assignment, event cursor,
  control modes) with schema versioning and explicit immediate transactions;
- strict bounded versioned NDJSON (`omarchestra.first-vertical-slice/v1`) over
  an owner-only Unix socket with identity handshake, snapshot, ordered events,
  acknowledgement/deduplication, and reconnect;
- three fixed roles with Pi-status strings, dynamic terminal-title metadata,
  and QML Agent Console projections derived from committed durable state only;
- one managed Builder assignment delivered through the visible-bridge boundary
  with replay suppression (identical replay never creates a second turn);
- Builder-only manual takeover flipping the assignment to
  `needs_reconciliation` while Coordinator and Reviewer stay byte-identical;
- actual runner stop/recreate over the same scratch database with the same
  bridge identities reconnecting and a thin projection client resuming from a
  saved cursor;
- a QML-facing thin client and fixture that receive snapshots plus ordered
  events through the protocol and structurally cannot touch storage;
- assignment acknowledgement authorization rejects wrong-role and unknown
  `busy`/`invalid` statuses without a durable state or event change;
- failed acceptance scenarios terminate their exact runner and remove their
  exact scratch directory before returning the failure;
- no hidden agent: fakes represent the visible interactive Pi hosts, and the
  scoped source audits plus the exact subprocess ledger show no process creation,
  PTY input, scraping, or SDK/RPC session paths outside the exact runner launches
  (one intentional failure-cleanup probe plus start/restart for each journal mode).

Constraints that keep this from being "supported" outright:

- real same-process Pi status and dynamic terminal metadata are human-proven,
  but the QML Agent Console remains a fixture rather than a live redundant
  surface; forced visible Ghostty title bars were rejected as non-native and
  truncation-prone (`docs/manual-role-label-gate.md`);
- the SSH-stdio transport is an injected-stream interface; no SSH is exercised;
- journal mode stays deliberately undecided: the gate measures `default` and
  `WAL` and reports the effective mode of each run without ranking them;
- same-user Unix-socket permissions are the only prototype trust boundary;
- recovery is proven only for runner restart while the same simulated
  visible-host identity survives (Pi restart, extension reload, changed PID,
  and reboot remain unsupported by design here);
- migrations beyond schema version 1, retention, cancellation,
  reconciliation, and the full Coordinator → Builder → Reviewer workflow are
  non-goals;
- local-filesystem detection is best-effort: known network/FUSE filesystems
  are rejected, but locality is not proven.

## Setup

- Node.js >= 22.6.0 (verified on Node 26 with bundled SQLite 3.53.4). No
  dependencies are installed; everything runs from the standard library.
- The acceptance gate creates its own fresh temporary state directory under
  the OS temp location, outside the repository, with mode `0700`; the database
  and Unix socket inside it are mode `0600`. No runtime database, socket, or
  SQLite sidecar is written into the repository; the command intentionally
  refreshes the tracked fake-only evidence file. Exact runner and scratch-state
  cleanup runs in `finally` on both successful and failed scenarios.

## One-command acceptance gate

```bash
just prototype-vertical-slice
```

The gate runs unattended. It first forces one intentional post-start failure
and proves the exact runner and scratch directory are absent. Then, for each of
the two journal modes (`default` and `WAL`), it performs and prints complete
inspectable state after every guided step:

1. fresh state directory, schema migration, bootstrap, journal-mode report;
2. three fake visible-host bridge handshakes over the real owner-only socket,
   followed by wrong-role/unknown acknowledgement rejection with no durable change;
3. initial labels (all roles `waiting`, all durable projections mutually distinct);
4. first managed Builder assignment: `accepted`, exactly one fake visible turn;
5. Builder disconnect/reconnect under management: replay acknowledged
   `duplicate`, still exactly one turn;
6. simulated interactive Builder input: Builder-only `manual_takeover`,
   assignment `needs_reconciliation`, Coordinator/Reviewer byte-identical;
7. thin projection client captures its durable cursor and disconnects;
8. the exact runner process is stopped and waited on;
9. the runner is recreated over the same scratch database and prints recovered state;
10. the projection client resumes from its saved cursor and receives the restart event page plus an authoritative snapshot;
11. the same exact bridge identity tuples reconnect (Builder remains in
    `manual_takeover` with no assignment dispatch) while their connection events
    arrive as a strictly ordered live stream;
12. final state and the complete ordered durable event list.

Static audits inside the gate additionally prove: SQLite is owned only by
`src/store.ts`; the presentation layer and QML snapshot/event fixture have no
storage dependency; no executable prototype module spawns processes, touches
PTYs, or opens TCP listeners; the injected SSH-stdio seam round-trips frames
without SSH; and the process ledger contains only the exact local runner
launches required by the cleanup probe and two journal-mode scenarios.

## Human presentation evidence

Two authorized local attempts resolved the presentation contract. Decorationless
Omarchy windows proved the three real Pi status labels across waiting, managed,
takeover, sibling isolation, and one-minute persistence, but exposed no
persistent terminal-title chrome. Forced Ghostty client decorations made title
metadata visible, but looked non-native and truncated in narrow Builder and
Reviewer tiles. The operator rejected that UI.

The accepted contract is decorationless Ghostty, persistent Pi status per
terminal, redundant Agent Console cards, and dynamic terminal titles as
window-manager metadata only; see
[`docs/manual-role-label-gate.md`](docs/manual-role-label-gate.md).

## Live Agent Console status

The Agent Console projection seam is implemented and fake-proven. Its original
per-run repository-local loader is unsupported and now rejected; live visual
agreement remains a later human gate through an explicitly installed persistent
Companion Plugin. Classification:

- **Fake-only proof (automated):** `just prototype-live-agent-console-check`
  runs all five seams unattended — the projection adapter (snapshot
  initialization, exactly three roles, ordered events, gap/duplicate/
  malformed/stale-identity rejection, resnapshot and explicit gap recovery),
  the QML boundary (injected plain values, no storage/process/PTY/SSH/scraping
  dependency), the launcher contract (decorationless, never `--title`,
  human-only recipe), the exact-identity failure cleanup, and the
  recipe/module source audit. Evidence:
  `evidence/live-agent-console-fake-only.txt`.
- **Prior terminal-side human proof:** real Pi status labels, transitions,
  isolation, and persistence
  ([`docs/manual-role-label-gate.md`](docs/manual-role-label-gate.md)).
- **Retired (still fail closed):** the existing combined launcher asks for the
  rejected repo-local ephemeral-loader capability and exits before resource
  creation. It remains safe historical code, not the product path
  ([`docs/live-agent-console-launch-blocker.md`](docs/live-agent-console-launch-blocker.md)).
- **Pending:** fake-only setup/update/uninstall proof for a versioned Companion
  Plugin, followed by live Pi + Agent Console agreement through an ephemeral
  Projection Session in a later explicitly human-authorized gate
  ([`docs/live-agent-console-gate.md`](docs/live-agent-console-gate.md)).

The prototype QML source under `console/plugin/` is schema-checked and linted
but has not been installed or loaded. Explicit product setup—not a Team Goal—
will own future installation and exact Omarchy configuration changes.

## Guided manual walkthrough (optional, no live systems)

1. `just prototype-vertical-slice` — read the printed state blocks in order;
   each step renders the full snapshot, labels, acknowledgements, and events.
2. `prototypes/first-vertical-slice/evidence/fake-only-acceptance.txt` — the
   captured output of the last gate run.
3. `service/omarchestra-runner@.service.template` — the intended foreground
   systemd user-unit boundary (never installed, never started).
4. `qml/AgentProjectionFixture.qml` — the thin-client projection shape.
5. `console/plugin/AgentConsole.qml` — the presentation-only Agent Console
   card component (injected values only; never installed or loaded live).
6. `docs/manual-role-label-gate.md` — completed human evidence, the rejected
   visible-title assumption, and the revised decorationless presentation contract.
7. `docs/live-agent-console-gate.md` — the replacement Companion Plugin gate
   plan and the retired launcher's fail-closed disposition.
8. `docs/live-agent-console-launch-blocker.md` — installed-API evidence for
   the rejected repo-local loading path and the selected resolution.
9. `docs/live-agent-console-run-report.md` — the seam-by-seam run report and
   evidence ledger for this fusion run.

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `src/store.ts` | Sole SQLite owner: schema version 1, migrations, explicit immediate transactions, owner-only permissions, filesystem/mount safety |
| `src/domain.ts` | Validated state transitions (bootstrap, handshake, assignment, duplicate, takeover) through the store interface |
| `src/presentation.ts` | Pure label derivation and the presentation-update contract |
| `src/protocol.ts` | Envelope shapes, bounds, validators, frame codec only |
| `src/transport.ts` | Owner-only Unix socket plus the injected SSH-stdio stream interface (no process creation) |
| `src/visible-bridge.ts` | Visible-host port and automation fake; no agent implementation |
| `src/thin-client.ts` | Snapshot/event projection only; no storage authority |
| `src/runner.ts` | Sole composition point for store, domain, transport, and clients |
| `src/cli.ts` | Foreground runner lifecycle; requires `--state-dir` |
| `src/acceptance.ts` | Fake-only acceptance gate; the only module allowed to spawn the runner CLI |
| `qml/` | Inert QML-facing snapshot and ordered-event projection fixture |
| `console/projection-core.ts` | Pure projection state machine: snapshot baseline, three fixed roles, ordered events, gaps, resnapshot, plain handoff |
| `console/live-projection-adapter.ts` | Foreground connection adapter: validation, cursor checks, reconnect, plain-data handoff; injectable connector/sink |
| `console/plugin/` | Presentation-only Agent Console QML panel source (manifest, console, cards); never installed or loaded |
| `service/` | Non-installed systemd user-unit template |
| `manual/live-gate-resources.ts` | Fake resource registry: exact process identity, filesystem device/inode plus symlink safety, and retryable incomplete cleanup for PIDs, windows, sockets, directories |
| `manual/run-live-agent-console-gate.sh` | Human-only combined-gate launcher; fail-closed preflight plus fake-only `--check` |
| `manual/` | Human-authorized disposable Pi/Ghostty adapter, wizard, and fake-only checks |

## Non-goals

Full workflow DAG, Git writer leases, real Boomux/Pi launching, remote SSH
execution, provider/model profiles, production QML UI, authentication,
production migrations/retention, cancellation, artifact review, reconciliation
(return-to-team), ordinary-terminal observation/Adoption, Companion Plugin
packaging, Task Capsules, and final packaging. `reconciling` control
mode and return-to-team are intentionally absent from this slice; that is a
prototype scope limit, not an MVP decision change.

## Findings for production contracts

Evidence-backed items that should become production contracts:

1. One durable global event sequence doubles as the projection cursor; event
   insertion and cursor advance must stay in one transaction, and bounded replay
   pages must continue through the captured cursor (validated here).
2. Assignment deduplication needs both a durable runner-side record and a
   surviving-bridge memory; replay after reconnect must be an explicit
   `duplicate` acknowledgement, not a second turn.
3. Pi status, terminal-title metadata, and Agent Console role/state projections
   must come from one committed presentation value and be sent only after the
   corresponding transaction commits. Visible Ghostty title bars are not a
   product surface.
4. Projection clients need a captured-cursor reconnect: complete ordered pages
   first, authoritative snapshot second, live stream third; the client advances
   and validates its cursor on every page and live event.
5. Takeover must validate source identity and monotonic source sequences and
   must touch only the affected role.
6. Owner-only filesystem enforcement (directory `0700`, database/socket
   `0600`, pre-creation symlink-component rejection, repository exclusion)
   belongs in the store open path, not the caller.
7. The thin-client dependency boundary is enforceable by a source audit that
   inspects the module graph, not just file text.
8. Product installation and Team Goal execution need separate lifecycles: a
   persistent Companion Plugin survives exact Projection Session cleanup.
9. Ordinary-terminal Pi discovery needs a separate observed/unassigned state;
   reusing managed Agent Run semantics would grant authority before Adoption.

Unresolved questions (deliberately not decided here):

- production journal mode (both modes measured; none ranked);
- live Companion Plugin rendering and its agreement/latency relative to the
  human-proven Pi status surface;
- observer identity/expiry and exact same-process Adoption protocol;
- socket trust beyond same-user Unix permissions, and the authenticated
  SSH-stdio protocol;
- recovery beyond a surviving bridge identity (Pi restart, extension reload,
  reboot);
- migrations, retention, cancellation, and reconciliation semantics;
- production event-page sizing and retention policy within the 16 KiB frame bound.

## Relationship to the authoritative design

The durable runner, managed bridge, projection, and terminal-presentation seams
remain aligned. The prototype's repository-local per-run QML launcher is a
known superseded seam and stays fail-closed; production-shaped follow-up uses
persistent Companion Plugin installation and ephemeral Projection Sessions.
Ordinary-terminal observation/Adoption and `reconciling` are recorded scope
limits rather than silently simulated here.

## Wipe instructions

```bash
rm -rf prototypes/first-vertical-slice/
# and remove every prototype recipe for this directory from the justfile:
#   prototype-vertical-slice
#   prototype-vertical-slice-manual-check
#   prototype-vertical-slice-role-label-gate
#   prototype-live-agent-console-check
#   prototype-live-agent-console-gate
```

Scratch state never enters the repository: each run creates its own temporary
directory outside Git and removes it on success or failure.