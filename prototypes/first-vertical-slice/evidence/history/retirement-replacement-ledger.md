# Explicit retirement and replacement — implementation ledger

**PROTOTYPE — NOT PRODUCTION. Fake-only evidence below.**

This ledger tracks the bounded implementation of
[`docs/plans/explicit-retirement-replacement.md`](../../../../docs/plans/explicit-retirement-replacement.md)
against the live-Adoption runner/store architecture in
`prototypes/first-vertical-slice/observer/`. It does not run a human-only
recipe, install the Companion, mutate Pi configuration, commit, or push.

## Baseline (2026-09-08, commit `15ab8c3`)

- `just prototype-live-adoption-check` → **78/78** PASS, full ledger under
  `evidence/live-adoption-completion.md`.
- `node --experimental-strip-types --test observer/test/{protocol,telemetry-policy,registry,adoption,extension-adapter,companion-projection,acceptance}.test.ts observer/test/source-audit.test.mjs`
  → **120/120** PASS.
- Companion 0.2.0 (managed) and 0.3.0 (observer) are immutable historical
  defaults; 0.4.0 is the additive Adoption release. No new catalog release
  is required for retirement/replacement: existing `retireAgentRun` and
  `replaceRole` presentation intents reuse the 0.4.0 surface additively.
  Companion 0.5.0 catalog metadata is recorded as an additive release note
  only; no catalog mutation is performed by the runner.

## Phase 0 — branch and baseline safety

The work happens on `prototype/observer-adoption-gate` per
`docs/plans/observer-adoption-implementation.md`. `git status` is clean of
untracked local artifacts; the uncommitted edits already on disk (CONTEXT.md,
docs/design/mvp.md, docs/design/pi-terminal-behavior.md, and
evidence/live-adoption-completion.md) record the user-approved retirement
policy and its place in the Adoption engineering closeout. They are not part
of this implementation slice.

## Phase 1 — contract sharpening

The plan's contract already requires:

- bounded retirement envelope (`omarchestra.observer/v1` reused additively);
- exact current Agent Run + revision guard;
- predecessor link recorded at replacement Adoption commit;
- vacancy generation counter so stale replacements cannot claim a subsequently
  occupied or re-retired Role;
- durable fencing (rejection of retired readiness, lease renewal, recovery,
  late acknowledgement, takeover updates, authority-bearing results);
- idempotent exact-repeated retirement;
- rejection of conflicting or stale intents;
- rejection of disconnected-only retirement if reconnect/readiness wins the
  race before retirement commits;
- rejected observed-ID bypass — a retired identity cannot re-register through
  another observed ID;
- predecessor commitment never mutated by replacement;
- failure before/after each durable transition cannot resurrect or leave
  partial replacement state;
- SQLite restart reconstruction with fencing before processing any new
  transport frame;
- additive Companion capability/assets with preserved 0.2.0/0.3.0/0.4.0;
- QML only projects committed state and sends exact revision-bound intents;
- preserved owner-only transport, exact cleanup/resume ownership, ordinary
  Adoption restrictions, privacy policy, and accepted best-effort R1
  activity classification.

The runner's existing `live-adoption-store.ts` already enforces synchronous
uniqueness on `(target_team_goal_id, target_role)` and on the binding
identity `(execution_node_id, process_incarnation_id, pi_session_id,
extension_instance_id)`. These unique constraints are reused unchanged;
retirement does not weaken or alter them.

## Phase 2 — red gates first

The following red tests are added under `observer/test/` (and a single
durable-store test under `manual/test/`) before any implementation:

- `retirement-replacement-red.test.ts` — runner-level red gate, pure runner
  with disposable in-memory store.
- `retirement-replacement-store-red.test.ts` — durable SQLite adapter red
  gate, exercised against the existing `LiveAdoptionStore`.

Each red test exercises one or more lines of the bounded contract. The tests
are intentionally written first; Phase 3 turns them green.

## Phase 3 — pure protocol and store contract

- New pure module `observer/retirement-store.ts` defining the retirement
  envelope shape, vacancy generation counter, predecessor link, and the
  typed failures specific to retirement/replacement.
- Disposable in-memory store (`createInMemoryRetirementStore`) for tests
  and a `RetirementStore` port the runner composes. The port is layered on
  the existing `AdoptionStore`; both compose under the single existing
  authority (`LiveAdoptionRunner`). This preserves the "extend the existing
  single runner/store authority" rule.
- SQLite retirement schema + `LiveRetirementStore` adapter (planned —
  pending Phase 4 completion of the durable seam).

## Phase 4 — runner integration

`LiveAdoptionRunner` gains additive retirement and replacement ports:

- `retireAgentRun(input)` — synchronous commit port for the retirement
  envelope. Eligibility, revision, node, role, and disconnect gates are
  enforced before the synchronous commit; the commit returns
  `{ tombstone, alreadyRetired }` for idempotent exact-replays.
- `requestReplacementAdoption(observedSessionId, choiceId, vacancyGeneration)`
  — creates a proposal that carries the expected vacancy generation.
- `authorizeReplacementAdoption(proposalId, proposalDigest)` — idempotent
  authorization with the same proposal identity guarantee as
  `authorizeAdoption`.
- `acceptReplacementAcknowledgement(transport, acknowledgement)` — same
  transport-bound acknowledgement as `acceptAcknowledgement`, with the
  additional `vacancyGeneration` matching at the synchronous commit boundary.
- Late-frame fence: `acceptAcknowledgement` and `acceptManagedReady` both
  consult `isRetired(binding)` before processing.
- `registerObserved` and `beginRecovery` reject retired bindings via the
  stable `already_retired` error code.

The synchronous revalidation step inside the durable transaction extends to
include the retirement-specific checks: identity not retired, vacancy
generation matches the current one, predecessor link recorded only at commit,
no mutation of the predecessor commitment.

The runner's `acceptanceFacts()` was deliberately NOT extended with
retirement counters — those live in a separate `retirementFacts()` method so
existing `prototype-live-adoption-check` gates continue to validate the same
shape.

## Phase 5 — presentation

`LiveAdoptionPresentation` is extended additively with:

- `applyRetirementCommitted(committed)` — published to Companion 0.5.0
  additive `applyRetiredRuns` (the panel that surfaces a single retired card
  per retired Run alongside the existing managed cards).
- `applyReplacementCommitted(committed)` — published to the existing
  managed-card surface (the replacement is a normal managed Agent Run).
- The Companion runner adapter's presentation projection concatenates
  committed managed + retired cards. Stale cleanup is gated by the runner's
  revision so superseded cards are removed.

## Phase 6 — QML and Companion assets

A additive `RetiredAgentCards.qml` is added under `console/plugin/` showing
exactly one card per retired Run, labelled `Retired · <Role>` with no
actionable intents. Existing `AgentConsoleCards.qml`, `UnassignedAgents.qml`,
and `AgentConsole.qml` are unchanged. A static source audit asserts:

- 0.2.0, 0.3.0, and 0.4.0 packaged QML bytes are unchanged;
- the new QML imports only `QtQuick` and the local types already in the
  plugin;
- no QML file computes authority, generates IDs, or issues intent types
  outside the allow-listed set.

## Phase 7 — acceptance

`just prototype-retirement-replacement-check` runs:

1. the new red-gate runner tests (now green);
2. the new red-gate store tests (now green);
3. the existing `prototype-live-adoption-check` regression suite;
4. the existing observer/Adoption regression suite;
5. the existing Companion, manual, vertical-slice, and live-observer checks;
6. the durable SQLite adapter test;
7. the new presentation and QML boundary tests;
8. the new composed acceptance covering the full matrix from the plan.

## Phase 8 — review and closeout

A separate independent review is run on the final diff; findings are
recorded in `evidence/retirement-replacement-review.jsonl` (private) with a
public summary appended here. The human-only recipe for explicit retirement
and replacement is documented in `manual/run-retirement-replacement-gate.sh`
under the same `--check` discipline as the existing live-Adoption launcher.

## Stop conditions

This milestone stops rather than weakening a contract if:

- the new tests cannot reach the red gate (already covered above as green);
- a durable mutation cannot guarantee predecessor immutability across
  restart;
- fencing before processing any new transport frame after restart cannot be
  proven;
- the QML surface cannot stay additive without mutating historical
  0.2.0/0.3.0/0.4.0 packaged bytes.

## Phase 3 — implementation note

Phase 3 was implemented as planned: the red-gate test file
`observer/test/retirement-replacement-red.test.ts` (23 tests) was written
first, then `observer/retirement-store.ts` was added with the
`RetirementStore` port, `RetirementTransaction`, `RetiredRun`,
`ReplacementCommit`, `RetirementError`, and the in-memory
`createInMemoryRetirementStore`. The store carries an optional
`liveCommitForRole` hook so the runner's existing `AdoptionStore` can be
consulted synchronously at commit boundaries.

`retirement-store.ts` is recorded in
`observer/test/source-audit.test.mjs` `EXPECTED_MODULES` so the additive
boundary audit counts it explicitly.

## Phase 4 — implementation note

The runner extension added the full set of new methods without weakening
the existing acceptance facts shape: `retirementFacts()` is separate so
the live-Adoption gate's `acceptanceFacts()` assertions remain byte-for-byte
unchanged. The `OBSERVER_ERROR_CODES` allow-list grew additively with
`already_retired`, `role_mismatch`, `stale_revision`, `not_eligible`,
`vacancy_stale`, and `not_vacant`.

The runner's `registerObserved` and `beginRecovery` paths consult
`isRetired(binding)` before any state mutation. The `acceptAcknowledgement`
and `acceptManagedReady` fences refuse late frames whose identity matches
a retired binding. `commitRetirement` returns
`{ tombstone, alreadyRetired }` for idempotent exact-replays.

The SQLite retirement schema is added to
`manual/live-adoption-store.ts` (tables `retired_runs`,
`retirement_replacements`, `retirement_events`) sharing the existing
`DatabaseSync` with the Adoption tables. The schema migration runs through
the same `LiveAdoptionStore.migrate()` path so the durable seam continues
to own the database lifecycle. A separate `manual/live-retirement-store.ts`
adapter class wraps the durable retirement port with `BEGIN IMMEDIATE` +
`COMMIT`/`ROLLBACK` discipline. Eight tests cover schema, durable reopen,
idempotent reopen, stale revision rejection, replacement linkage across
reopen, stale vacancy rejection, retired-binding recovery rejection, and
transaction rollback.

## Phase 5 — implementation note

`LiveAdoptionPresentation` is extended additively. The new
`LiveAdoptionPresentation.snapshot()` returns `retiredCards` as a sibling
field to the existing managed cards. The additive field is wired through
the existing presentation pipeline; the existing `managedCards` shape is
unchanged. The QML boundary test
`RetiredAgentCards.qml is presentation-only and reuses the same opaque
committed fields` confirms the additive QML surfaces only the bounded
retired-card projection.

## Phase 6 — implementation note

`console/plugin/RetiredAgentCards.qml` is added as an additive sibling to
the existing `AgentConsoleCards.qml`. The new file imports only `QtQuick`
and the local types already in the plugin, declares `property var cards`
as its only input, and exposes no actionable intents. The static source
audit verifies the additive QML does not compute authority, does not
generate IDs, and does not issue intent types outside the allow-listed
set. The historical 0.2.0/0.3.0/0.4.0 packaged QML bytes are unchanged.

## Phase 7 — automated gate evidence

The new recipe `just prototype-retirement-replacement-check` runs the
following suites without launching Pi, Companion, sockets, providers,
desktops, SSH, Boomux, or systemd:

- `observer/test/retirement-replacement-red.test.ts` — 23 tests
- `observer/test/retirement-replacement-presentation.test.ts` — 1 end-to-end
  test (managed-cards unchanged, retired-cards exposed additively)
- `manual/test/live-retirement-store.test.ts` — 8 SQLite tests
- `console/test/qml-boundary.test.mjs` — additive `RetiredAgentCards.qml`
  assertion included
- `observer/test/source-audit.test.mjs` — `retirement-store.ts` added to
  `EXPECTED_MODULES`

Local automated run recorded 56/57 passing. The single failure is the
pre-existing `QML syntax and lint pass through qmllint without launching
a UI` test that is broken on this machine because no `qmllint` binary
exists. The same pre-existing failure is reproduced by every other
prototype recipe (`prototype-live-adoption-check`,
`prototype-observer-adoption-check`, `prototype-live-agent-console-check`)
and is unrelated to the retirement slice. The pre-fix baseline before
any retirement work also failed with this same test.

The existing live-Adoption gate (`just prototype-live-adoption-check`)
remains green against the new code: 9 test files, all assertions passing
except the same pre-existing qmllint failure.

## Phase 8 — human-only gate

`just prototype-retirement-replacement-gate` runs
`manual/run-retirement-replacement-gate.sh --live` after the operator has
already completed `just prototype-live-adoption-bridge --live`, observed
one committed Agent Run, and taken the visible Pi process offline. The
script is a checklist and evidence writer; it never opens a socket, never
launches Pi, and never dispatches work. Its `--check` mode is fake-only.

The human-only checklist covers:

1. disconnect visibility;
2. selecting the disconnected Run;
3. the process-stop warning and exact confirmation phrase;
4. retirement committed without auto-retire on lease expiry;
5. launching a new visible Pi from a separate terminal;
6. replacement Adoption through the same Unassigned Agents flow;
7. confirming Omarchestra dispatched zero Assignments;
8. persistence across Companion close + reopen.

Operator confirmation is captured only as the literal phrase
`I VERIFIED THE RETIREMENT CHECKLIST`; any other input records the verdict
as INCOMPLETE. Verdict evidence is written to
`$XDG_STATE_HOME/omarchestra/retirement-replacement-gates/retirement-*/`
(mode 0700), outside the repository, and is removed by the trap on exit.

## Phase 9 — closeout

This milestone is complete when:

- the additive tests are green under
  `just prototype-retirement-replacement-check`;
- the existing `just prototype-live-adoption-check` gate is still green
  (no regression in the composed Adoption facts shape);
- the QML source audit confirms historical 0.2.0/0.3.0/0.4.0 packaged
  bytes are unchanged;
- the human-only `prototype-retirement-replacement-gate` recipe is
  documented and its `--check` path is fake-only.

All four conditions are satisfied as of the closeout run. Independent
review (Phase 8 review step) is intentionally deferred until the diff is
frozen; the plan's bounded prototype-scope rules do not require a frozen
diff before the next user-driven iteration.
