# Observer and Adoption implementation plan

Status: **fake-only prototype phases complete; live validation blocked by R1; prototype milestone only**

## Outcome

Build the next removable vertical slice: an ordinary interactive Pi started in
a normal local Omarchy terminal becomes an **Observed Pi Session** shown under
**Unassigned Agents**, and can become a managed **Agent Run** only through an
exact, current, user-confirmed, same-process acknowledged **Adoption**.

This milestone closes the bounded fake-only observer/Adoption contract. It does
not establish live Pi feasibility or start broad production implementation;
those remain subject to the explicit R1 boundary below.

## Required context

Read these files completely before planning or editing:

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/design/mvp.md`
4. `docs/design/pi-terminal-behavior.md`
5. `docs/adr/0002-observe-ordinary-pi-before-explicit-adoption.md`
6. `docs/adr/0001-install-a-persistent-omarchy-companion-plugin.md`
7. `prototypes/first-vertical-slice/docs/companion-plugin-v1.md`
8. `prototypes/first-vertical-slice/docs/live-agent-console-run-report.md`
9. Pi extension documentation and examples referenced by `AGENTS.md` or the
   installed Pi documentation when extension behavior is changed.

Completion criterion: every proposal cites the authoritative rule it preserves,
and no proposal reopens a locked product decision.

## Non-negotiable boundaries

- The ordinary session is the real visible interactive Pi process.
- Observation grants no Team Goal, Role, Assignment, writer lease, Agent
  Control Mode, Runtime Binding guarantee, PTY authority, process authority, or
  prompt-delivery authority.
- The observer runs inside that same Pi process and fails open when Omarchestra
  is absent or incompatible.
- Ordinary observation and Adoption are local-only in the MVP. An ordinary
  local Pi cannot enter a remote Team Goal.
- Telemetry is structured and privacy-bounded. It excludes conversation,
  prompts, responses, thinking, tool arguments/results, terminal output,
  repository content, credentials, and environment values.
- Adoption requires exact current identity, the same Execution Node, an
  unoccupied Role, explicit user confirmation, same-process acknowledgement,
  reconciliation, and one durable Team Runner commit before managed work.
- PID, cwd, terminal title, focus, recency, display name, or equal strings alone
  never authorize observation correlation or Adoption.
- QML renders projections and emits intents only. Protocol validation, expiry,
  deduplication, reconciliation, transactions, and authority remain outside
  QML.
- Automated gates remain fake-only: no live Pi/provider request, Ghostty,
  Hyprland action, Omarchy shell IPC, user configuration mutation, Boomux, SSH,
  or systemd.
- The installed Companion release and private evidence on any developer machine
  are not test fixtures and must not be inspected or mutated by automation.
- All prototype implementation remains under
  `prototypes/first-vertical-slice/` and stays marked
  **PROTOTYPE — NOT PRODUCTION**.
- Fusion preserves one writer and must not commit or push.

## Module seams to establish

Design deep modules with these responsibilities; exact names may change when a
smaller interface is demonstrated.

1. **Observer protocol module** — bounded `omarchestra.observer/v1` envelopes,
   identity values, compatibility, acknowledgement, expiry facts, and typed
   failures. It performs no I/O.
2. **Telemetry policy module** — converts allowed same-process lifecycle facts
   into the observer projection and rejects forbidden or unbounded fields.
3. **Agent Registry module** — owns current Observed Pi Sessions, injected
   clock/transport/persistence seams, reconnect and expiry, deduplication, and
   authoritative snapshots/events.
4. **Adoption module** — owns proposal identity, eligibility checks, explicit
   authorization, same-process acknowledgement, reconciliation, idempotency,
   and the atomic observed-session-to-Agent-Run commit.
5. **Observer extension adapter** — translates Pi lifecycle hooks and named
   status into the protocol. It never creates another Pi session or controls
   the terminal/process.
6. **Companion projection adapter** — combines managed cards and Unassigned
   Agents as plain committed data and routes presentation/Adoption intents to
   the registry/runner.
7. **QML presentation** — renders `Unassigned · observed`, availability, and
   Adoption choices without deriving eligibility or authority.

Completion criterion: callers and tests exercise behavior through these seams;
live adapters do not leak into the shared modules.

## Execution phases

### Phase 0 — baseline and branch safety

1. Confirm the checkout is on `prototype/observer-adoption-gate`, clean, and
   based on the main commit containing this plan.
2. Run `just prototype-companion-check` and the relevant existing fake-only
   gates. Revert nondeterministic generated evidence if a gate refreshes it.
3. Record baseline commands and results in the new milestone ledger.

Completion criterion: the baseline is green, the worktree contains only the
intentional ledger addition, and no live resource was contacted.

### Phase 1 — sharpen the open contract

Before implementation, compare at least two identity/handshake designs. Lock the
smallest design that can prove:

- one process incarnation distinct from a reused PID;
- one Pi session and one observer-extension incarnation;
- local Execution Node identity;
- monotonic registration/reconnect ordering;
- bounded heartbeat/expiry without wall-clock authority confusion;
- one Adoption proposal that cannot be replayed into another process/session;
- acknowledgement from the exact current extension instance;
- crash recovery without a half-adopted session.

Update the authoritative design only where it currently labels these shapes as
open. Add an ADR only if a durable trade-off is selected.

Completion criterion: protocol tables include fields, bounds, ordering,
expiry, privacy classification, and rejection behavior for every envelope.

### Phase 2 — red gates first

Create intended-failure tests before implementation for:

1. ordinary registration → `Unassigned · observed` with no management fields;
2. disconnect/reconnect and injected-clock expiry;
3. registry absence/incompatibility leaving visible Pi usable;
4. rejection of forbidden telemetry and oversized/malformed envelopes;
5. happy Adoption ordering: propose → user authorization → same-process ack →
   reconcile → atomic commit → managed presentation;
6. stale identity, reused PID, Node mismatch, remote Team Goal, occupied Role,
   busy session, exited session, already-managed session, duplicate proposal,
   ack refusal/timeout, and identity drift;
7. process/runner failure at every Adoption stage leaving either exactly
   observed/unassigned or exactly committed/managed—never both or neither;
8. zero assignment/prompt/process action before the durable commit;
9. adopted ordinary Pi gaining no fabricated Boomux/PTY guarantee;
10. QML remaining presentation-only while its intent/result path is callable;
11. session-scoped bounded deduplication and fresh authoritative reconstruction;
12. source audits proving automated reachability is fake-only and telemetry
    cannot contain forbidden content classes.

Capture concise red evidence under the prototype evidence directory.

Completion criterion: every required behavior has a red-capable test at its
owning seam, and the intended failures are reviewed before implementation.

### Phase 3 — protocol, privacy, and registry

Implement the pure protocol and telemetry policy first, then the Agent Registry
against fake clock, fake persistence, and fake transport adapters. Keep
availability, lifecycle, eligibility, and expiry distinct. Generate snapshots
and ordered events from registry state; presentation is not authority.

Completion criterion: registration, reconnect, expiry, deduplication, privacy,
and fail-open extension behavior are green without importing Adoption or QML.

### Phase 4 — transactional Adoption

Implement Adoption as an explicit state machine with one transaction owner.
Authorization binds the exact immutable proposal. Revalidate all eligibility
facts immediately before commit. Acknowledge/refuse through the same observer
connection. Reconcile current activity explicitly. Commit the Agent Run, Role,
control mode, and presentation value atomically; remove/transition the observed
record in the same transaction. Dispatch remains impossible until commit.

Completion criterion: the happy path and every conflict/crash matrix case are
green and no intermediate state grants partial authority.

### Phase 5 — same-process observer adapter

Implement the opt-in global Pi extension adapter with injected ports and a fake
Pi host harness. It owns only its named status slot and displays
`Unassigned · observed` while currently registered. After committed Adoption it
switches to the committed `<Role> · <state>` value and only then accepts managed
messages through the managed bridge seam.

Specify installation/update/uninstall as explicit product operations, but keep
this milestone's unattended implementation and checks fake-only. Do not install
or modify global Pi configuration.

Completion criterion: fake-host tests prove same-process identity/
acknowledgement, fail-open ordinary use, status-slot isolation, and absence of
a hidden agent or terminal/process control. Live feasibility remains subject to
R1 below.

#### R1 — content-free command/activity lifecycle

The fake-host implementation and tests are green, but the Pi 0.84.4 public
extension surface does not provide complete content-free start/end lifecycle
coverage for slash-command or `user_bash` execution. The input hook is bypassed
for extension commands, and the `user_bash` hook is content-bearing without a
matching completion event. `ctx.isIdle()` alone cannot prove safe Adoption
reconciliation for those activities. This is a live-feasibility blocker, not a
permission to inspect content, wrap shell execution, scrape the terminal, or
weaken the contract. Live installation and validation remain stopped until a
public signal is available or this rule is explicitly revised in the design.

### Phase 6 — Companion presentation

Extend the plain projection and canonical QML sources with **Unassigned
Agents** and Adoption intents/results. Keep packaged-source byte equality.
Eligibility and error text arrive as bounded plain data; QML does not compute
whether Adoption is allowed. Existing managed cards and Companion behavior must
remain unchanged.

Completion criterion: QML syntax/lint, source audits, canonical/package equality,
stale-session rejection, and intent acknowledgement tests are green.

### Phase 7 — integrated fake-only acceptance

Add `just prototype-observer-adoption-check`. Its standalone scenario must show:

1. an ordinary visible-host fake remains usable before/without registry;
2. registration produces exactly one current Observed Pi Session;
3. the Companion projection shows `Unassigned · observed` and no managed
   authority;
4. forbidden data never enters protocol, registry state, events, or QML;
5. an invalid Adoption matrix leaves the session observed and unassigned;
6. one exact authorized Adoption commits once and only once;
7. no managed work is sent before commit;
8. after commit the same process identity becomes the selected Agent Run and
   receives the committed role/state presentation;
9. reload/reconnect reconstructs the same authority state without duplication;
10. cleanup removes only exact fake runtime resources and never mutates the
    installed Companion lifecycle.

Also rerun `just prototype-companion-check`,
`just prototype-live-agent-console-check`, and relevant vertical-slice gates.

Completion criterion: all fake-only gates pass, `git diff --check` passes,
source/secret audits are clean, and generated nondeterministic evidence is not
left as accidental diff.

### Phase 8 — review and closeout

Run independent Standards and Spec reviews against the fixed baseline. Resolve
all authority, privacy, transaction, replay, expiry, packaging, QML, and cleanup
findings test-first. Update `CONTEXT.md`, authoritative design, ADR references,
README status, prototype documentation, and a red/green ledger. Preserve the
prototype's wipe instructions.

Do not run a human live gate, install an observer, mutate Pi configuration,
commit, push, merge, or begin broad production work. Report:

- modified files;
- exact gate commands/results;
- unresolved findings and deliberately deferred decisions;
- proposed human-only observer/Adoption validation recipe;
- whether the milestone is ready for human review.

Completion criterion: independent review is green or every remaining blocker is
explicit; the worktree is ready for the human to inspect and commit.

## Stop conditions

Stop and report rather than weakening a contract when:

- exact same-process identity cannot be proven through Pi's public extension
  surface;
- Adoption would require terminal/PTY scraping or input injection;
- a transaction cannot prevent partial authority;
- privacy exclusions cannot be enforced before data crosses the observer seam;
- the generic public interface would require a remote ordinary-session claim;
- an automated test would need a live desktop, provider, Pi process, user
  configuration mutation, or installed Companion state.

A stopped spike with reproducible evidence is an acceptable result. A simulated
success that bypasses one of these conditions is not.
