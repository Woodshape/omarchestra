# Observer and Adoption vertical-slice red-to-green ledger

Status: **Phases 0–2 recorded; red gates confirmed; implementation not yet started**

This ledger records the test-first progression for the observer/Adoption
prototype milestone defined in
[`docs/plans/observer-adoption-implementation.md`](../../../docs/plans/observer-adoption-implementation.md).
All commands in this ledger are fake-only or static. They did not contact a
live Omarchy shell, mutate user configuration, launch a GUI, Pi, provider,
Boomux, SSH, Hyprland, or systemd, or create private live evidence. No commit
or push was made.

## Phase 0 — baseline and branch safety

### Checkout verification

| Check | Result |
| --- | --- |
| Current branch | `prototype/observer-adoption-gate` |
| Starting worktree | clean (`git status --porcelain` empty) |
| Plan commit | `be27626 docs: plan observer adoption milestone` |
| Plan commit is ancestor of HEAD | yes (`git merge-base --is-ancestor be27626 HEAD` → 0) |
| Plan commit is on `main` | yes (`git branch --contains be27626` lists `main`) |
| HEAD | `6a104b9 merge: live Agent Console companion milestone` |

### Baseline fake-only gates

All four existing fake-only gates were run on the clean checkout. The
`prototype-live-agent-console-check` gate requires the static QML linter
`qmllint`, which is installed at `/usr/lib/qt6/bin/qmllint` but is not on
`PATH` in this environment; the gate's own test honors the `QMLLINT_BIN`
environment variable, so it was run with `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint`.
`qmllint` is a static linter and is explicitly permitted by the plan; no live
Quickshell/Omarchy UI was started.

| Command | Result | Exit |
| --- | --- | --- |
| `just prototype-companion-check` | 77/77 tests pass; standalone `VERDICT PASS`; setup-validation check `PASS (fake-only)`; launcher `PASS (fake-only)` | 0 |
| `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-live-agent-console-check` | 67/67 tests pass; setup-validation check `PASS (fake-only)`; launcher `PASS (fake-only)` | 0 |
| `just prototype-vertical-slice` | `ACCEPTANCE GATE COMPLETE` (default + WAL journal scenarios) | 0 |
| `just prototype-vertical-slice-manual-check` | 6/6 tests pass; manual role-label wizard static check `PASS` | 0 |

### Nondeterministic evidence restore

`just prototype-vertical-slice` refreshes the tracked evidence file
`evidence/fake-only-acceptance.txt` with nondeterministic content (fresh PIDs,
temporary state-directory paths, and timestamps). Per the plan, this generated
evidence was restored to its committed state:

```bash
git checkout -- prototypes/first-vertical-slice/evidence/fake-only-acceptance.txt
```

After restore, `git status --porcelain` is empty (clean worktree).

### Phase 0 completion criterion

- [x] Checkout is on `prototype/observer-adoption-gate`, clean, and based on the
  main commit containing the plan.
- [x] Existing fake-only gates are green.
- [x] Nondeterministic generated evidence was reverted; the worktree contains
  only the intentional ledger addition.
- [x] No live resource was contacted.

## Sequence (to be filled by later phases)

| Phase | Evidence | Intended result | Final result |
| --- | --- | --- | --- |
| Phase 2 red gates | `observer-protocol-registry-red.txt`, `observer-adoption-adapter-red.txt`, `observer-companion-acceptance-red.txt` | Missing observer/Adoption implementation fails at owning seams | 33 + 38 + 26 intended failures; managed QML boundary stays green |
| Phase 3 protocol/privacy/registry | `observer-protocol-registry-green.txt` | Protocol, telemetry policy, and registry green without Adoption/QML | pending |
| Phase 4 Adoption | `observer-adoption-green.txt` | Happy path and conflict/crash matrix green; no partial authority | 28/28 green; restart discard + committed reconstruction proven |
| Phase 5 observer adapter | `observer-extension-adapter-green.txt` | Same-process identity/ack, fail-open, status-slot isolation | pending |
| Phase 6 Companion/QML | `observer-companion-qml-green.txt` | Unassigned Agents + Adoption intents; QML presentation-only; byte equality | pending |
| Phase 7 integrated acceptance | `observer-acceptance-green.txt` | `just prototype-observer-adoption-check` green; existing gates green | pending |
| Phase 8 review/closeout | this ledger | Independent review green or blockers explicit; docs updated | pending |

## Phase 2 — red gates before implementation

All eight Phase 2 suites were run before any production behavior was
implemented. Each fails at its owning seam because its implementation module
does not exist yet (`contracts.ts`, `telemetry-policy.ts`, `fakes.ts`,
`registry.ts`, `adoption.ts`, `extension-adapter.ts`, `fake-pi-host.ts`,
`companion-projection.ts`, `acceptance.ts`, and the Companion 0.3.0 release).
No assertion was weakened to obtain these results.

### Protocol-registry suites (task 2.a)

```bash
node --experimental-strip-types --test \
  prototypes/first-vertical-slice/observer/test/protocol.test.ts \
  prototypes/first-vertical-slice/observer/test/telemetry-policy.test.ts \
  prototypes/first-vertical-slice/observer/test/registry.test.ts
```

Result: **33 tests, 0 pass, 33 fail** — strict `omarchestra.observer/v1`
envelope validation, forbidden telemetry rejection before transport, and
registry registration/reconnect/expiry/dedup/reconstruction/fail-open all red
at their owning seams.

### Adoption-adapter suites (task 2.b)

```bash
node --experimental-strip-types --test \
  prototypes/first-vertical-slice/observer/test/adoption.test.ts \
  prototypes/first-vertical-slice/observer/test/extension-adapter.test.ts
```

Result: **38 tests, 0 pass, 38 fail** — full Adoption ordering/invalid matrix,
transaction/crash invariants, and the same-process observer adapter red at
their owning seams.

### Companion-acceptance suites (task 2.c)

```bash
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint node --experimental-strip-types --test \
  prototypes/first-vertical-slice/observer/test/companion-projection.test.ts \
  prototypes/first-vertical-slice/observer/test/source-audit.test.mjs \
  prototypes/first-vertical-slice/observer/test/acceptance.test.ts \
  prototypes/first-vertical-slice/console/test/qml-boundary.test.mjs
```

Result: **32 tests, 6 pass, 26 fail**. The 6 passing are the pre-existing
unchanged managed-card QML boundary assertions (no regression on the managed
path); every new observer Companion projection, stale-intent, source-audit,
acceptance, and QML 0.3.0 behavior is red.

Combined intended-failure total: **97 red tests** across the three evidence
files. Evidence is captured in `observer-protocol-registry-red.txt`,
`observer-adoption-adapter-red.txt`, and `observer-companion-acceptance-red.txt`.
All required behaviors are red-capable at their owning seams; no required
behavior is accidentally green.

### Phase 2 completion criterion

- [x] Every required behavior has a red-capable test at its owning seam.
- [x] Intended failures are reviewed and captured before implementation.
- [x] No assertion was weakened to obtain red results.

## Scope limit

This milestone implements ordinary-terminal Pi observation and Adoption as a
fake-only prototype. It does not install an observer, mutate Pi or Omarchy
configuration, run a live gate, or begin broad production work.
