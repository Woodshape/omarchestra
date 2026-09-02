# Omarchestra agent guide

## Context pointers

- **MVP product behavior or architecture:** read [`docs/design/mvp.md`](docs/design/mvp.md) completely before proposing or implementing changes. Its locked decisions are authoritative.
- **Domain concepts or terminology:** read [`CONTEXT.md`](CONTEXT.md) before naming or changing Agent Run, Observed Pi Session, Adoption, Companion Plugin, Projection Session, or another core concept.
- **Pi terminal behavior, ordinary-terminal discovery, Adoption, footer status, or takeover:** read [`docs/design/pi-terminal-behavior.md`](docs/design/pi-terminal-behavior.md) completely before changing the behavior.
- **Locked integration or lifecycle trade-offs:** read the relevant record in [`docs/adr/`](docs/adr/) before revisiting the decision.
- **Boomux, Herdr, Fusion Harness, Omarchy, PTY, or terminal-runtime claims:** read the relevant sections of [`docs/research/foundation-assessment.md`](docs/research/foundation-assessment.md) before relying on them.
- **Remote execution, SSH, Node identity, remote Projects, or disconnection semantics:** read [`docs/design/remote-execution.md`](docs/design/remote-execution.md) completely before proposing or implementing changes.
- **Implementation-readiness or planning blockers:** read [`docs/reviews/2026-08-30-implementation-readiness/`](docs/reviews/2026-08-30-implementation-readiness/) when revisiting why a technical contract exists.
- **Feasibility work:** read [`spikes/README.md`](spikes/README.md) before starting a spike.

## Current phase

Product scope is locked. Close the open technical contracts through bounded, evidenced spikes before broad implementation. Treat a requested product-scope change as a design decision: obtain explicit user agreement, update the authoritative design and its decision log, then change code.

## Completion

- A design decision is complete when the authoritative design records the outcome and no stale open item contradicts it.
- A spike is complete when its directory records the question, reproducible setup, evidence, conclusion, and resulting contract changes.
- An implementation slice is complete when its executable acceptance gate passes and affected documentation reflects the resulting behavior.

Use `just fusion` to launch the external Fusion Harness with this repository as every agent's working directory.
