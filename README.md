# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Agents may execute locally or together on one remote GNU/Linux Node while their terminals and Agent Console remain on the local Omarchy desktop.

## Status

**MVP product scope locked; technical design pending.**

The visible Pi bridge and local Boomux runtime adapter are both supported with documented constraints after automated and human validation. The remote execution Node is the next feasibility spike.

## Design

- [MVP design](docs/design/mvp.md) — authoritative product scope, decisions, acceptance criteria, and open technical contracts
- [Architecture overview](docs/design/mvp-architecture.html) — standalone visual overview
- [Remote execution boundary](docs/design/remote-execution.md) — locked single-Node SSH execution scope and recovery semantics
- [Foundation assessment](docs/research/foundation-assessment.md) — Boomux, Herdr, Fusion Harness, and Omarchy research
- [Fusion readiness review](docs/reviews/2026-08-30-implementation-readiness/) — independent implementation-blocker review

## Fusion workspace

Fusion Harness remains an external development tool. Launch it with this repository as the working directory:

```bash
just fusion
```

The application toolchain has intentionally not been selected yet.
