# Omarchestra agent guide

## Context pointers

- **MVP product behavior or architecture:** read [`docs/design/mvp.md`](docs/design/mvp.md) completely before proposing or implementing changes. Its locked decisions are authoritative.
- **Domain concepts or terminology:** read [`CONTEXT.md`](CONTEXT.md) before naming or changing Agent Run, Observed Pi Session, Adoption, Companion Plugin, Projection Session, or another core concept.
- **Pi terminal behavior, ordinary-terminal discovery, Adoption, footer status, or takeover:** read [`docs/design/pi-terminal-behavior.md`](docs/design/pi-terminal-behavior.md) completely before changing the behavior.
- **Locked integration or lifecycle trade-offs:** read the relevant record in [`docs/adr/`](docs/adr/) before revisiting the decision.
- **Boomux, Herdr, Fusion Harness, Omarchy, PTY, or terminal-runtime claims:** read the relevant sections of [`docs/research/foundation-assessment.md`](docs/research/foundation-assessment.md) before relying on them.
- **Remote execution, SSH, Node identity, remote Projects, or disconnection semantics:** read [`docs/design/remote-execution.md`](docs/design/remote-execution.md) completely before proposing or implementing changes.
- **Observer/Adoption implementation milestone:** read [`docs/plans/observer-adoption-implementation.md`](docs/plans/observer-adoption-implementation.md) before implementing ordinary-session discovery, registry expiry, privacy filtering, Adoption acknowledgement, or Unassigned Agents presentation.
- **Implementation-readiness or planning blockers:** read [`docs/reviews/2026-08-30-implementation-readiness/`](docs/reviews/2026-08-30-implementation-readiness/) when revisiting why a technical contract exists.
- **Feasibility work:** read [`spikes/README.md`](spikes/README.md) before starting a spike.

## Current phase

Product scope is locked. Close the open technical contracts through bounded, evidenced spikes before broad implementation. Treat a requested product-scope change as a design decision: obtain explicit user agreement, update the authoritative design and its decision log, then change code.

## Completion

- A design decision is complete when the authoritative design records the outcome and no stale open item contradicts it.
- A spike is complete when its directory records the question, reproducible setup, evidence, conclusion, and resulting contract changes.
- An implementation slice is complete when its executable acceptance gate passes and affected documentation reflects the resulting behavior.

## Implementation and Fusion discipline

- Delegate one bounded implementation slice with concrete failure tests and an exit gate, not an entire multi-system phase to one writer. More planning/review agents do not substitute for working integration checkpoints.
- Keep one checkout writer. Reviewers inspect landed code and required end-to-end paths; interfaces, fixture callbacks and printed records do not prove a real bridge or native entry point.
- Resolve blocking review findings before declaring the slice complete. A passing subset is not full acceptance; report host continuation separately from independent review.
- Bound subprocess tests and clean up their exact children on failure. A shell pipeline or an unreferenced timer is not a timeout guarantee.
- Preserve partial work; turn verified failures into regressions rather than disabling required functionality to obtain PASS.

Use `just fusion` to launch the external Fusion Harness with this repository as every agent's working directory.
