# Omarchestra first vertical-slice prototype

**PROTOTYPE — NOT PRODUCTION.** Removable as one directory
(`rm -rf prototypes/first-vertical-slice/` plus the one `justfile` recipe).
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
- three fixed roles with persistent native-terminal-title and Pi-status label
  strings derived from committed durable state only;
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

- presentation adapters are fakes; real Pi title/status rendering is covered
  only by the plan-only manual gate (`docs/manual-role-label-gate.md`);
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
3. initial labels (all roles `waiting`, both surfaces, mutually distinct);
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

## Guided manual walkthrough (optional, no live systems)

1. `just prototype-vertical-slice` — read the printed state blocks in order;
   each step renders the full snapshot, labels, acknowledgements, and events.
2. `prototypes/first-vertical-slice/evidence/fake-only-acceptance.txt` — the
   captured output of the last gate run.
3. `service/omarchestra-runner@.service.template` — the intended foreground
   systemd user-unit boundary (never installed, never started).
4. `qml/AgentProjectionFixture.qml` — the thin-client projection shape.
5. `docs/manual-role-label-gate.md` — the plan-only human gate for the real
   Pi status surface and native terminal titles, for a later authorized run.

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
| `service/` | Non-installed systemd user-unit template |

## Non-goals

Full workflow DAG, Git writer leases, real Boomux/Pi launching, remote SSH
execution, provider/model profiles, production QML UI, authentication,
production migrations/retention, cancellation, artifact review, reconciliation
(return-to-team), Task Capsules, and final packaging. `reconciling` control
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
3. Presentation strings must be persisted with the binding row and re-sent
   only after the corresponding transaction commits.
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

Unresolved questions (deliberately not decided here):

- production journal mode (both modes measured; none ranked);
- real Pi title/status rendering and its update latency (manual gate);
- socket trust beyond same-user Unix permissions, and the authenticated
  SSH-stdio protocol;
- recovery beyond a surviving bridge identity (Pi restart, extension reload,
  reboot);
- migrations, retention, cancellation, and reconciliation semantics;
- production event-page sizing and retention policy within the 16 KiB frame bound.

## Contradictions with authoritative designs

None found. The slice stays inside the locked MVP decisions; the absent
`reconciling` mode and return-to-team flow are recorded scope limits above.

## Wipe instructions

```bash
rm -rf prototypes/first-vertical-slice/
# and remove the prototype-vertical-slice recipe from the justfile
```

Scratch state never enters the repository: each run creates its own temporary
directory outside Git and removes it on success or failure.