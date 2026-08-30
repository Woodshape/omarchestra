# Feasibility spikes

Spikes close one risky technical question without becoming production architecture by accident.

## Required record

Each spike gets its own directory and records:

1. **Question** — one falsifiable capability or design uncertainty.
2. **Success criteria** — observable evidence required to answer it.
3. **Setup** — exact versions, commands, configuration, and assumptions.
4. **Evidence** — captured output, behavior, and failures.
5. **Conclusion** — supported, unsupported, or supported with constraints.
6. **Design impact** — technical contracts or MVP claims that change.
7. **Disposition** — throw away, retain as test fixture, or promote deliberately.

## Planned order

1. **Visible Pi bridge — complete, supported with constraints.** One interactive Pi TUI received a managed assignment, emitted structured events, reported human takeover, reconnected after runner restart, and had no hidden descendant agent. See [`pi-visible-bridge/README.md`](pi-visible-bridge/README.md).
2. **Boomux runtime adapter — next.** Prove create, present, detach, reconnect, inspect, and close behavior through the supported public CLI/capability surface.

Broad implementation begins only after the relevant spike has produced a contract recorded in [`docs/design/mvp.md`](../docs/design/mvp.md).
