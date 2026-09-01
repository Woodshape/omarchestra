# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Agents may execute locally or together on one remote GNU/Linux Node while their terminals and Agent Console remain on the local Omarchy desktop.

## Status

**MVP product scope and feasibility classifications locked; production technical contracts pending.**

The visible Pi bridge, local Boomux runtime adapter, and one-Node remote execution are supported with documented constraints after automated and human validation. The next milestone is a narrow production-shaped vertical-slice prototype.

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

For the next prototype, the accepted defaults are TypeScript/Node 22+, SQLite with explicit transactions (journal mode intentionally unlocked), versioned NDJSON over Unix sockets and SSH stdio, a systemd user service, and a thin QML client. These are reversible spike defaults rather than final production commitments.
