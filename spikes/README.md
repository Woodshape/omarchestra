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
2. **Boomux runtime adapter — complete, supported with constraints.** Public CLI integration plus a passed human gate proved create, present, detach, same-Run/same-PID reconnect, inspect, events, sibling isolation, and exact-ID cleanup. See [`boomux-runtime-adapter/README.md`](boomux-runtime-adapter/README.md).
3. **Remote execution Node — complete, supported with constraints.** Against an actual non-Omarchy GNU/Linux host, the controlled gate proved Node registration, node-local runner/bridges, remote PTYs rendered locally, disconnect survival, projection recovery, exact reattachment, and exact-ID cleanup. See [`remote-execution-node/README.md`](remote-execution-node/README.md).
4. **Omarchy ephemeral plugin loader — complete, rejected-path evidence.** On installed Omarchy 4.0.2-1 the repo-local ephemeral panel capability is absent; the spike produced a frozen `omarchy.temporary-panel/v1` contract, a fake-only model with all eight seams red→green, and a candidate patch applied and linted only against hash-verified scratch copies. ADR 0001 rejected this lifecycle: no patch will be installed or submitted. The next path is explicit persistent Companion Plugin setup plus ephemeral Projection Sessions. See [`omarchy-ephemeral-plugin-loader/README.md`](omarchy-ephemeral-plugin-loader/README.md).
5. **Observer live bridge — fake-only contract green; live validation not run.** The observer extension, owner-only Unix transport, disposable gateway, and Companion 0.3.0 publication seam are covered by fake and static evidence. The procedure is human-only, observation-only, and makes no live Adoption claim. See [`observer-live-bridge/README.md`](observer-live-bridge/README.md).

Broad implementation begins only after the relevant spike has produced a contract recorded in [`docs/design/mvp.md`](../docs/design/mvp.md).
