## Collaboration provenance

| Task | Agent | Contribution |
| --- | --- | --- |
| `1.a` | Sol | Audited Boomux 1.8.0 public CLI, capabilities, events, errors, and exact-Run limitation. |
| `1.b` | Luna | Designed deterministic tests, ownership cases, GUI isolation, and source-coupling audit. |
| `1.c` | Terra | Defined adapter, receipt, Workspace placement, probe, and manual-gate blueprint. |
| `2.a` | Terra | Implemented the adapter, command builders, receipts, executor, manual driver, and probe. |
| `2.b` | Sol | Captured CLI evidence and created the initial spike record and pending human gate. |
| `3.a` | Luna | Implemented fake-executor tests and source audits. |
| `3.b` | Terra | Fixed reconciliation, cursor, mutation-outcome, and lifecycle defects. |
| `4.a` | Sol | Found six final contract and safety gaps, including output scraping and Workspace adoption. |
| `4.b` | Luna | Independently reviewed coverage, GUI isolation, source inventory, and missing evidence. |
| `5.a` | Sol | Applied audit fixes, captured automated evidence, and finalized documentation. |
| Final integration | Architect | Reviewed all reports and current files, reconciled event filtering, and reran validation. |

## Final validation

- Syntax checks passed for all 12 production and test modules.
- Deterministic suite passed: **61 tests, 0 failures**.
- Source audit passed.
- `git diff --check` passed.
- Private preflight snapshots remain ignored.
- Automated evidence is recorded in `spikes/boomux-runtime-adapter/evidence/automated.txt`.
- No live creation, GUI presentation, resource closure, configuration mutation, or cleanup ran.

## Canonical result

Boomux can support the narrow replaceable adapter at the automated contract boundary:

- Capability negotiation, opaque references, exact argv, snapshots, lifecycle events, cursor recovery, typed failures, and exact-ID cleanup policy are implemented and tested.
- No Rust internals, private runtime state, daemon sockets, terminal-output scraping, or Boomux domain-object adoption is used.
- Generic `boomux open` has no atomic expected-Run guard. Pre/post inspection detects replacement but cannot prevent the exit-and-restart race.
- Native tiling, window-detach survival, identical Run/PID reconnect, sibling isolation, and safe live cleanup remain unproven.

**Conclusion: supported with constraints; the human observation gate remains `PENDING` in `evidence/manual-observations.md`.**