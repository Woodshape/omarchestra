# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Agents may execute locally or together on one remote GNU/Linux Node while their terminals and Agent Console remain on the local Omarchy desktop.

## Status

**MVP product scope and feasibility classifications locked; production technical contracts pending.**

The visible Pi bridge, local Boomux runtime adapter, and one-Node remote execution are supported with documented constraints after automated and human validation. The desktop follows Boomux's model: an explicitly installed Omarchestra companion plugin is durable product infrastructure, while Team Goal projection sessions are ephemeral. An opt-in global Pi observer will also list ordinary-terminal Pi sessions as observed and unassigned until explicit adoption. The next milestone is a narrow production-shaped vertical slice of those installation, observation, and projection seams.

## Design

- [MVP design](docs/design/mvp.md) — authoritative product scope, decisions, acceptance criteria, and open technical contracts
- [Pi terminal behavior](docs/design/pi-terminal-behavior.md) — managed terminal presentation, ordinary-terminal observation, Adoption, and takeover behavior
- [Domain language](CONTEXT.md) — canonical terms for managed Agent Runs, Observed Pi Sessions, Adoption, the Companion Plugin, and Projection Sessions
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
