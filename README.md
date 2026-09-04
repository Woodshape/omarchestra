# Omarchestra

Visible-agent orchestration for Omarchy.

Omarchestra coordinates teams of real interactive coding agents, each shown in its own native terminal and tiled by Hyprland. Agents may execute locally or together on one remote GNU/Linux Node while their terminals and Agent Console remain on the local Omarchy desktop.

## Status

**MVP product scope locked; the Companion Plugin slice is live-proven, and the observer/Adoption slice is fake-only green with R1 accepted as bounded risk.**

The visible Pi bridge, local Boomux runtime adapter, and one-Node remote execution are supported with documented constraints after automated and human validation. The removable first vertical slice proves one explicitly authorized, versioned Companion Plugin installation, three real interactive Pi hosts, ephemeral Projection Sessions, committed role/state agreement, Builder-only managed work and takeover, one-minute persistence, reload reconstruction, and runtime clear/hide without changing the persistent installation. The observer/Adoption prototype now proves bounded protocol, privacy, registry, same-process acknowledgement, transactional Adoption, Companion projection, and cleanup behavior using fakes only.

No live observer installation or Adoption validation is claimed. The observer bridge transport, gateway, Companion 0.3.0 seam, launcher, and reachability checks are fake-only. Its `--check` path creates no live or user state, and its human procedure prints but never launches Pi. Pi 0.84.4 lacks a complete content-free lifecycle signal for slash-command and `user_bash` execution; the current bounded contract accepts `ctx.isIdle()` plus its existing guards as best-effort and records this as follow-up hardening, without inspecting content. The separate Companion human gate passed on 2026-09-03 with private owner-only evidence.

## Design

- [MVP design](docs/design/mvp.md) — authoritative product scope, decisions, acceptance criteria, and open technical contracts
- [Pi terminal behavior](docs/design/pi-terminal-behavior.md) — managed terminal presentation, ordinary-terminal observation, Adoption, and takeover behavior
- [Domain language](CONTEXT.md) — canonical terms for managed Agent Runs, Observed Pi Sessions, Adoption, the Companion Plugin, and Projection Sessions
- [Architecture overview](docs/design/mvp-architecture.html) — standalone visual overview
- [Remote execution boundary](docs/design/remote-execution.md) — locked single-Node SSH execution scope and recovery semantics
- [Foundation assessment](docs/research/foundation-assessment.md) — Boomux, Herdr, Fusion Harness, and Omarchy research
- [Fusion readiness review](docs/reviews/2026-08-30-implementation-readiness/) — independent implementation-blocker review
- [Companion Plugin v1 prototype contract](prototypes/first-vertical-slice/docs/companion-plugin-v1.md) — persistent installation, ephemeral Projection Sessions, ports, and fail-closed lifecycle
- [Companion setup and validation](prototypes/first-vertical-slice/docs/live-agent-console-gate.md) — fake-only gate plus the passed human-authorized procedure
- [Observer and Adoption implementation plan](docs/plans/observer-adoption-implementation.md) — bounded fake-only milestone and R1 boundary
- [Observer live bridge spike](spikes/observer-live-bridge/README.md) — fake-only contract, Companion 0.3.0 limitation, and human-only boundary
- [Proposed observer/Adoption live validation](prototypes/first-vertical-slice/docs/observer-adoption-live-validation.md) — human-only observer procedure, not yet run

## Fusion workspace

Fusion Harness remains an external development tool. Launch the general, unprompted three-slot stack with:

```bash
just fusion
```

To explicitly create or resume `prototype/observer-adoption-gate` and start `/fh-collaborate` with the committed observer/Adoption plan, run:

```bash
just fusion-observer-adoption
```

The accepted prototype defaults are TypeScript/Node 22+, SQLite with explicit transactions (journal mode intentionally unlocked), versioned NDJSON over Unix sockets and SSH stdio, a systemd user service, and thin presentation-only QML. These remain reversible prototype defaults rather than final production commitments.

Run the complete fake-only Companion gate without touching live systems:

```bash
just prototype-companion-check
```

Run the complete fake-only observer/Adoption gate:

```bash
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-observer-adoption-check
```

Run the separate fake-only observer bridge gate:

```bash
just prototype-live-observer-check
```

The existing live Companion recipe is `just prototype-companion-setup-validation` and retains the historical base release. The observer bridge recipe is `just prototype-live-observer-bridge`; it requires an already installed and enabled Companion 0.3.0, a compatible host, an interactive TTY, and the exact displayed authorization phrase. It is observation-only, cannot perform Adoption, and cannot independently open the observer panel. Automation and Fusion never invoke this live path.
