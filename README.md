# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Agents may execute locally or together on one remote GNU/Linux Node while their terminals and Agent Console remain on the local Omarchy desktop.

## Status

**MVP product scope locked; the Companion Plugin vertical slice is live-proven and production technical contracts remain pending.**

The visible Pi bridge, local Boomux runtime adapter, and one-Node remote execution are supported with documented constraints after automated and human validation. The removable first vertical slice proves one explicitly authorized, versioned Companion Plugin installation, three real interactive Pi hosts, ephemeral Projection Sessions, committed role/state agreement, Builder-only managed work and takeover, one-minute persistence, reload reconstruction, and runtime clear/hide without changing the persistent installation. The unattended proof remains fake-only; the separate human gate passed on 2026-09-03 with private owner-only evidence.

Ordinary-terminal Pi observation and Adoption remain separate open technical work. This milestone did not implement or validate either behavior.

## Design

- [MVP design](docs/design/mvp.md) — authoritative product scope, decisions, acceptance criteria, and open technical contracts
- [Pi terminal behavior](docs/design/pi-terminal-behavior.md) — managed terminal presentation, ordinary-terminal observation, Adoption, and takeover behavior
- [Domain language](CONTEXT.md) — canonical terms for managed Agent Runs, Observed Pi Sessions, Adoption, the Companion Plugin, and Projection Sessions
- [Architecture overview](docs/design/mvp-architecture.html) — standalone visual overview
- [Remote execution boundary](docs/design/remote-execution.md) — locked single-Node SSH execution scope and recovery semantics
- [Foundation assessment](docs/research/foundation-assessment.md) — Boomux, Herdr, Fusion Harness, and Omarchy research
- [Fusion readiness review](docs/reviews/2026-08-30-implementation-readiness/) — independent implementation-blocker review
- [Companion Plugin v1 prototype contract](prototypes/first-vertical-slice/docs/companion-plugin-v1.md) — persistent installation, ephemeral Projection Sessions, ports, and fail-closed lifecycle
- [Companion setup and validation](prototypes/first-vertical-slice/docs/live-agent-console-gate.md) — fake-only gate plus the separate human-authorized procedure

## Fusion workspace

Fusion Harness remains an external development tool. Launch it with this repository as the working directory:

```bash
just fusion
```

The accepted prototype defaults are TypeScript/Node 22+, SQLite with explicit transactions (journal mode intentionally unlocked), versioned NDJSON over Unix sockets and SSH stdio, a systemd user service, and thin presentation-only QML. These remain reversible prototype defaults rather than final production commitments.

Run the complete Companion gate without touching live systems:

```bash
just prototype-companion-check
```

The only active live Companion recipe is `just prototype-companion-setup-validation`. It requires a compatible host, an interactive TTY, and the exact displayed authorization phrase. Automation and Fusion never invoke its live path.
