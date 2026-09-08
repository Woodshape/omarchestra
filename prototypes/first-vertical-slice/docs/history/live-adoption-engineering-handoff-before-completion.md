# Historical live Adoption engineering handoff

**Archived before engineering completion; not current status.** See
[the current handoff](../live-adoption-engineering-handoff.md). Remaining links
and findings below retain their original historical context.

Status: **INCOMPLETE / BLOCKED. Partial implementation and passing fake
regressions exist. Required composed-path acceptance has not passed independent
review. Both live entrypoints remain disabled before resource creation.**

The collaboration produced partial prototype implementation and passing fake
regressions. Independent reviews (6.a LUNA, 6.b ASTRA) found required
Companion-to-same-Pi integration absent. These are blockers, not accepted scope
reductions. No installation, live validation, commit or push was performed
during this correction.

## Post-checkpoint implementation progress

The partial work was checkpointed as `add63d8`. Subsequent single-writer fixes
have **58/58** dedicated fake tests passing, without live resources or installed
configuration changes. This is progress, not independent acceptance of F12–F18.

- Added six authority-boundary tests. The initial three failed for unbound
  transport methods, missing actionable choices, and unknown-choice fallback.
- Preserve transport method receivers; reject unknown choices; publish vacant
  local Roles and advance observer revisions on registration/loss/expiry.
- Propagate expiry to runner authority; use a real monotonic default clock;
  revalidate binding, revision, sequence, Node and target inside the synchronous
  commit transaction. Capture commit context before acknowledgement delivery.
- Remove the manual gateway's duplicate registry/router and route every frame
  and disconnect through one gateway session with a shared clock.
- Exercise Companion controller confirmation through framed transport and the
  actual observer adapter into SQLite, then verify the same fake Pi's footer,
  observer removal, managed card and persisted state through a second DB open.
  This still does not exercise installed Companion IPC or the manual extension.
- Do not enable runner dispatch from presentation delivery. There is still no
  implemented same-Pi readiness handshake; runner readiness stays false.
- Reject durable-store Promise transactions and close SQLite on startup failure.
  Committed binding tombstones now also reject direct re-registration.

Validation: `prototype-live-adoption-check` 58/58, `prototype-live-observer-check`
69/69, `prototype-observer-adoption-check` 137/137, `prototype-companion-check`
87/87, `prototype-live-agent-console-check` 78/78, and
`prototype-vertical-slice-manual-check` 6/6. All commands used `just`, with
`QMLLINT_BIN=/usr/lib/qt6/bin/qmllint`; `git diff --check` passed.
`just prototype-vertical-slice` also passed default and WAL scenarios; its
nondeterministic generated evidence was restored to the checkpoint version.
No live Adoption readiness, independent review, or full completion is claimed.

## Evidence qualification

The writer reports 52 passing live-Adoption tests, including 13 tests in the
composed test file. These results establish only their individual assertions.
They do not establish complete Companion-to-same-Pi Adoption, crash-stage
recovery, managed readiness, cleanup acceptance or closure of F12–F18. F16 and
F17 remain incomplete.

## Provenance

- **P1 FLASH, tasks 1.a, 2.a, 3.b, 4.b, 5.a, 7.a:** sole delegated writer.
  Tasks 1.a and 3.b returned placeholders, leaving the planned initial red
  tests and Companion/managed bridge implementation undone. Task 2.a added
  partial authority/recovery and tests. Task 4.b added cleanup code and selected
  review fixes. Task 5.a extended partial tests and reported regression results.
  Task 7.a updated documentation. Their completion claims are superseded by
  independent review. The sibling store and earlier containment predate this run.
- **P2 LUNA, tasks 1.c, 4.a, 6.a, 8.a:** independent read-only acceptance
  reviews. Final disposition BLOCKED. Task 8.a identified remaining contract
  and provenance inconsistencies.
- **P3 ASTRA, tasks 1.b, 3.a, 6.b:** read-only architecture requirements,
  authority/recovery review (AR1–AR8), and final scope/evidence review (FA1–FA6).
- **P4 ASTRA, final sequential integration:** preserved all implementation and
  pre-existing working changes, corrected task 8.a documentation inconsistencies,
  recorded unresolved verdict and red-first evidence gaps, compared protected
  paths against HEAD, and reran all seven fake recipes. Both existing live
  guards remain unchanged. No implementation completion or independent review
  of these final documentation edits is claimed.

Source reports are in the collaboration artifact directory
`/tmp/fusion-harness-6BUGkW/collaborate/reports/`, notably `6.a-luna.md` and
`6.b-astra.md` and `8.a-luna.md`. These reports and the plan identify this run,
not the earlier collaboration that created the initial sibling implementation.

## Outstanding blockers

- **F12 Companion — BLOCKED.** The manual gateway does not compose
  `LiveAdoptionCompanion`, `LiveCompanionProjection`, `ProjectionSessionManager`,
  capability discovery, installation fingerprinting, or intent routing. The
  companion and projection units are isolated scaffolding, not the actual
  Adoption path. Runner observer agents now expose vacant local Role choices,
  but those choices are not yet wired to installed Companion IPC.
- **F13 Authority — PARTIAL, awaiting independent review.** Duplicate manual
  registry routing is removed; connection metadata is preserved by the core;
  disconnect and sweep revoke runner authority. Fake busy/disconnect/expiry
  races during asynchronous acknowledgement reject commit. Final synchronous
  binding checks are stronger. This does not establish complete live authority
  lifecycle acceptance or managed-connection recovery.
- **F14 Recovery — BLOCKED.** Recovery primitives exist in the gateway core, but
  manual routing now reaches the core binding lookup and recovery proof path.
  The extension has no recovery
  challenge/proof flow. Composed tests call runner recovery methods directly;
  they do not test manual restart, transport reconnect, extension recovery, or
  bridge restoration.
- **F15 Managed bridge — BLOCKED.** `LiveAdoptionManagedBridge.handleInput()`
  only returns a boolean and discards the input. The extension registers no
  `pi.on('input')` handler. The coordinator applies presentation before sending
  `adoption.committed`; the runner no longer maps that presentation to bridge
  activation. There is no real managed transport action and the
  required post-delivery activation ordering is not established.
- **F16 Evidence — INCOMPLETE.** The reported 13/13 and 52/52 counts are not
  tied to an immutable snapshot. The new happy-path test now uses
  `LiveAdoptionCompanion` and SQLite with framed gateway and observer adapter,
  but still uses `createObserverExtension()` rather than the actual manual
  Adoption extension. Other recovery tests still bypass required components;
  the complete installed Companion/recovery/readiness path remains unproven.
- **F17 Cleanup/verdict — INCOMPLETE.** Exact cleanup code exists but is
  unreachable while the guards remain active. There is no
  `manual/test/live-adoption-launcher.test.mjs`. Existing source audits do not
  execute substitution, identity mismatch, cleanup failure, or phase-verdict
  scenarios. PASS still depends only on successful gateway exit plus cleanup,
  not verified Adoption observations. Gateway failure plus cleanup failure
  produces `ABORTED`, not `FAIL`, which also requires contract review.
- **F18 Contracts — static containment accepted; live readiness blocked.**
  Observation-only gateway rejects `adoption.ack` as `unsupported_protocol`;
  managed release remains `0.2.0`; observer release `0.3.0` and additive
  `session.observer` remain separate; durable state preserves
  `runtimeBinding: null` and `runtimeBindingGuarantee: 'unavailable'`; live
  guards remain active. This does not establish live Adoption.

## Contract distinction

The activation, recovery, capability discovery, fingerprinting and cleanup
requirements below are the intended contract. Only behavior explicitly linked
to independently accepted evidence is implemented acceptance. Missing wiring is
a blocker, not an accepted scope reduction.

## Final validation

ASTRA reran the seven recipes below during final sequential integration, each
foreground with `timeout 60s`, `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint`, and
`/usr/lib/qt6/bin` prepended to PATH. Logs are in
`/tmp/astra-6BUGkW-final/<recipe>.log`. The pre-validation bytes of the already
modified `evidence/fake-only-acceptance.txt` were saved and restored exactly.
These are coordinator regression runs, not independent acceptance review.

| Command | Exit | Result |
| --- | --- | --- |
| `just prototype-live-adoption-check` | 0 | 52/52, launcher no-resource check PASS |
| `just prototype-live-observer-check` | 0 | 69/69 |
| `just prototype-observer-adoption-check` | 0 | VERDICT PASS |
| `just prototype-companion-check` | 0 | VERDICT PASS |
| `just prototype-live-agent-console-check` | 0 | 78/78, QML diagnostics emitted |
| `just prototype-vertical-slice` | 0 | ACCEPTANCE GATE COMPLETE |
| `just prototype-vertical-slice-manual-check` | 0 | 6/6 |
| `git diff --check` | 0 | clean |

These green counts establish only their individual assertions. They do not
establish complete Companion-to-same-Pi Adoption, crash-stage recovery, managed
readiness, cleanup acceptance or closure of F12–F18. Neither live entrypoint
was executed.

## Changed files

Paths below are relative to `prototypes/first-vertical-slice/`, except justfile.
This is the cumulative working-tree inventory, including changes that predate
this collaboration. It is not an attribution of every change to this run.

- `justfile`
- `observer/companion-projection.ts`
- `observer/contracts.ts`
- `observer/test/companion-projection.test.ts`
- `observer/live-adoption-store.ts`
- `observer/live-adoption-runner.ts`
- `observer/live-adoption-gateway-core.ts`
- `observer/live-adoption-companion.ts`
- `observer/test/live-adoption-runner.test.ts`
- `observer/test/live-adoption-gateway.test.ts`
- `observer/test/live-adoption-companion.test.ts`
- `observer/test/live-adoption-durability.test.ts`
- `observer/test/live-adoption-managed-bridge.test.ts`
- `observer/test/live-adoption-composed.test.ts`
- `observer/test/live-adoption-source-audit.test.mjs`
- `manual/live-adoption-store.ts`
- `manual/live-adoption-gateway.ts`
- `manual/live-adoption-extension.ts`
- `manual/run-live-adoption-bridge.sh`
- `docs/live-adoption-integration-contract.md`
- `docs/live-adoption-live-validation.md`
- `docs/live-adoption-engineering-handoff.md`
- `evidence/live-adoption-red.txt`
- `evidence/live-adoption-f16-evidence.txt`
- `evidence/fake-only-acceptance.txt`

Final integration ran `git diff --quiet HEAD --` against
`observer/live-gateway-core.ts`, `observer/adoption.ts`,
`companion/contracts.ts` and `companion/releases.ts` with exit 0. These four
paths match HEAD. This is preservation evidence, not live compatibility or
independent engineering acceptance. Existing delegated implementation remains
available for correction.

## Version and live-validation statement

No installation or live validation was performed during this correction.
Historical Pi 0.84.4 references and the reported installed Pi 0.85.1 version do
not establish compatibility or support. Any future human procedure requires
separate authorization and version-specific validation after engineering
acceptance.

## R1 limitation

R1 accepts best-effort activity classification only. It does not exempt
capability discovery, installation fingerprinting, authority revalidation,
recovery or managed bridge composition.

## Next action

Use the current fake gate only as a regression baseline. The next writer must
first add failing tests through the actual Companion/manual extension path,
then unify manual registry/runner routing and implement recovery and managed
readiness. Resolve AR1 (complete synchronous checks), AR4 (deadline/context
capture before request delivery), AR6 (existing database validation), and AR8
(actual composed recovery evidence). Recheck partial AR2/AR3/AR5/AR7 fixes
against the original review cases rather than accepting their writer labels.
Add runtime cleanup-substitution and phase-verdict tests before changing F17.
Independent review must evaluate each F12–F18 behavior, not aggregate counts.

There is **no approved runnable human Adoption procedure** at this checkpoint.
`just prototype-live-adoption-bridge` is intentionally disabled and exits before
resource creation. Do not remove its guards until F12–F18 have regression
coverage, actual composition is complete, and independent review accepts it.
Continue with one writer and a read-only reviewer. Do not install or run live
validation as part of that engineering correction.
