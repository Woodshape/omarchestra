# Observer and Adoption vertical-slice red-to-green ledger

Status: **Phases 0–8 fake-only green; R1 accepted as bounded risk; ready for user review, live validation not run**

This ledger records the test-first progression for the observer/Adoption
prototype milestone defined in
[`docs/plans/observer-adoption-implementation.md`](../../../docs/plans/observer-adoption-implementation.md).
All automated commands below are fake-only or static. They did not contact a
live Omarchy shell, mutate user configuration, launch a GUI, Pi, provider,
Boomux, SSH, Hyprland, or systemd, or create private live evidence.

The interrupted Fusion session had no recoverable in-memory state. The
recoverable work was checkpointed before the main-branch integration:

| Checkpoint | Meaning |
| --- | --- |
| `11343bb` | existing observer/Adoption implementation and test WIP checkpoint |
| `a7e4c6a` | fake-only observer acceptance gate, evidence, and recipe checkpoint |
| `62837f9` | merge of `main` commit `e45c72c` (`just fusion` stays general; the milestone launcher is `just fusion-observer-adoption`) |

## Phase 0 — baseline and branch safety

The baseline checkout was `prototype/observer-adoption-gate`, clean, and based
on plan commit `be27626` plus the live Companion milestone at `6a104b9`. The
current branch is still `prototype/observer-adoption-gate`; the later
acceptance and documentation work is now checkpointed as listed above.

| Command | Result | Exit |
| --- | --- | --- |
| `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-companion-check` | 78/78 tests pass; standalone Companion verdict PASS; setup `--check` and launcher checks PASS | 0 |
| `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-live-agent-console-check` | 71/71 tests pass; fake-only setup checks PASS | 0 |
| `just prototype-vertical-slice` | complete default and WAL runner scenarios; `ACCEPTANCE GATE COMPLETE` | 0 |
| `just prototype-vertical-slice-manual-check` | 6/6 tests pass; role-label wizard static check PASS | 0 |

`prototype-vertical-slice` refreshes `evidence/fake-only-acceptance.txt` with
fresh PIDs, temporary paths, and timestamps. That nondeterministic tracked
output was restored after the run, so it is not an accidental diff.

## Red gates before implementation

The Phase 2 red suites were captured before implementation and remain retained:

| Suite | Result |
| --- | --- |
| protocol/privacy/registry | 33 intended failures, 0 pass |
| Adoption/observer adapter | 38 intended failures, 0 pass |
| Companion observer/QML/acceptance | 26 intended failures and 6 unchanged managed-QML passes |

The red evidence is in `observer-protocol-registry-red.txt`,
`observer-adoption-adapter-red.txt`, and `observer-companion-acceptance-red.txt`.
No assertion was weakened to obtain the red results.

## Green phase ledger

| Phase | Evidence | Final result |
| --- | --- | --- |
| Phase 3 protocol/privacy/registry | `observer-protocol-registry-green.txt` | 43/43 green; strict envelopes, privacy policy, registry reconnect/expiry/dedup/reconstruction, and fail-open behavior |
| Phase 4 transactional Adoption | `observer-adoption-green.txt` | 28/28 green; ordering, complete invalid/crash matrix, restart discard, committed reconstruction, and no partial authority |
| Phase 5 same-process adapter | `observer-extension-adapter-green.txt` | 20/20 green in the fake host; exact identity/ack, fail-open behavior, status isolation, and post-commit bridge boundary |
| Phase 6 Companion/QML | `observer-companion-qml-green.txt` | 29/29 green; Unassigned Agents, opaque intents/results, QML/source audits, lint, and canonical/package byte equality |
| Phase 7 integrated acceptance | `observer-acceptance-green.txt` | `just prototype-observer-adoption-check`: 129/129 tests green plus static QML lint; standalone ten-outcome acceptance PASS |
| Phase 8 review/closeout | this ledger and linked design docs | fake-only closeout recorded; R1 risk disposition is explicit; live validation remains unrun |

## Phase 6 — Companion/QML evidence

```text
$ QMLLINT_BIN=/usr/lib/qt6/bin/qmllint node --experimental-strip-types --test \
    observer/test/companion-projection.test.ts \
    observer/test/source-audit.test.mjs \
    console/test/qml-boundary.test.mjs

29 tests
29 pass
0 fail
exit 0

PHASE_6_GREEN
```

The full output is retained in `observer-companion-qml-green.txt`.

## Phase 7 — integrated fake-only acceptance

The new recipe is `prototype-observer-adoption-check`. Its standalone
composition in `observer/acceptance.ts` proves:

- an ordinary visible-host fake remains usable without the registry;
- exactly one observed registration is projected as `Unassigned · observed`;
- forbidden data is rejected before crossing protocol, registry, event,
  Companion, or QML-handoff surfaces;
- all 16 invalid Adoption cases remain observed and unassigned;
- `propose → authorize → same_process_acknowledged → reconciled → committed`
  occurs once on the exact connection;
- no managed work, assignment, prompt, or process action occurs before commit;
- the same identity becomes `Builder · managed` only after commit, with
  `runtimeBindingGuarantee=unavailable`;
- reload/reconnect reconstructs one committed result without duplication; and
- cleanup removes only the exact fake resource while preserving unrelated and
  installed-Companion state.

The concise standalone output is retained in `observer-acceptance-green.txt`.
The complete recipe also reran the observer suites, source audits, QML
boundary, and static lint without invoking any human-only path.

The separate observer bridge gate is `prototype-live-observer-check`. Its
62/62 tests passed, including the explicit 0.3.0-versus-0.2.0 catalog check,
fragmented/multiple framing, malformed and
bounded input, registration, heartbeat, disconnect, expiry, reconnect,
Companion publication, fail-open extension behavior, launcher TTY and private
resource audits, and static import/recipe/privacy reachability. It also passed
Bash syntax validation, side-effect-free manual module imports, and the
launcher `--check` path. No live socket, Pi, Omarchy shell, installed
Companion, user configuration, or private live evidence was accessed.

## R1 — accepted bounded risk; future hardening

The Pi 0.84.4 public extension surface supports the selected random
process/Pi-session/extension identities, current connection binding, named
status, documented session lifecycle, and the fake-tested acknowledgement
shape. It does **not** provide a complete content-free start/end lifecycle for
slash-command execution: extension commands bypass the input event, and
`user_bash` is a content-bearing pre-execution hook with no matching completion
event. `ctx.isIdle()` is not a complete classifier for arbitrary slash-command
or `user_bash` activity.

The user explicitly accepts this limitation for the current bounded contract.
The adapter uses `ctx.isIdle()` plus its existing guards as best-effort
reconciliation, without adding input inspection, shell wrapping, terminal
scraping, conversation inspection, or input injection. R1 no longer blocks the
prototype or a future human validation attempt; stronger activity signalling
remains future hardening. No live observer installation or Adoption validation
has been run.

The proposed human-only procedure is
[`../docs/observer-adoption-live-validation.md`](../docs/observer-adoption-live-validation.md).

## Phase 8 — review and closeout disposition

Completed closeout checks:

- [x] observer implementation modules remain under the removable prototype
  directory and are marked **PROTOTYPE — NOT PRODUCTION**;
- [x] protocol, privacy, registry, Adoption, adapter, Companion projection,
  transport, gateway, launcher, acceptance, QML, import-graph, and
  automated-recipe source audits pass;
- [x] `git diff --check` passes after generated nondeterministic evidence is
  restored;
- [x] README, `CONTEXT.md`, MVP design, Pi terminal design, implementation
  plan, prototype README, observer contract, and the proposed human procedure
  state the fake-only boundary and accepted R1 risk disposition;
- [x] the generic `just fusion` launcher remains general after integrating
  `main`; the observer milestone launcher is `just fusion-observer-adoption`;
- [x] the persistent Companion installation lifecycle is not touched by the
  observer acceptance path; and
- [ ] live observer feasibility, installation, and Adoption validation — not run
  in this fake-only milestone and still not claimed as evidence.

No independent live Standards/Spec review can be claimed from the interrupted
Fusion session. The static contract/source review is green; the remaining
finding is explicit rather than hidden behind the fake acceptance gate.

## Remaining production work

The fake-only milestone does not close production observer installation,
socket trust and permissions, durable persistence/retention, replay/cursors,
compatibility breadth, telemetry filtering/coalescing, slash-command and
`user_bash` lifecycle coverage, or the final committed role/state fan-out.
Those remain production technical contracts and must not be inferred from this
prototype.
