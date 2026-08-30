# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Its Agent Console observes and controls those visible processes without replacing them with hidden headless workers.

## Status

**MVP product scope locked; technical design pending.**

Implementation begins with feasibility spikes for the visible Pi bridge and the replaceable Boomux terminal-runtime adapter.

## Design

- [MVP design](docs/design/mvp.md) — authoritative product scope, decisions, acceptance criteria, and open technical contracts
- [Architecture overview](docs/design/mvp-architecture.html) — standalone visual overview
- [Foundation assessment](docs/research/foundation-assessment.md) — Boomux, Herdr, Fusion Harness, and Omarchy research
- [Fusion readiness review](docs/reviews/2026-08-30-implementation-readiness/) — independent implementation-blocker review

## Fusion workspace

Fusion Harness remains an external development tool. Launch it with this repository as the working directory:

```bash
just fusion
```

The application toolchain has intentionally not been selected yet.
