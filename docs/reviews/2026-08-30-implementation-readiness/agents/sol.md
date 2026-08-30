The document’s eight **Open decisions** all block the end-to-end specification:

- **D1 Workflow:** Confirm topology, correction loop, retry limit, and failure path.
- **D2 User intervention:** Define whether terminal input is allowed during managed assignments and how it changes state.
- **D3 Window creation:** Choose eager creation of all agents or creation when runnable.
- **D4 Models:** Choose fixed role defaults or per-role user selection.
- **D5 Approvals:** Define which attention states the console can resolve.
- **D6 Recovery scope:** Include minimal Task Capsules or defer them.
- **D7 Validation:** Decide whether review alone is sufficient or a deterministic command is required.
- **D8 Completion:** Choose automatic coordinator integration or explicit user acceptance.

The draft also contains unresolved decisions not fully captured by that list:

- **D9 Technology boundary:** Select repository, implementation languages, packaging, local IPC transport, and service startup model.
- **D10 Persistence and event semantics:** Select storage and define snapshot, event, intent, cursor, deduplication, and multi-source ordering rules.
- **D11 Bridge contract:** After the Pi spike, lock handshake identity, assignment delivery, acknowledgements, reconnect behavior, supported telemetry, and compatibility requirements.
- **D12 Boomux contract:** Lock the supported Boomux version, exact CLI operations, capability detection, identifier reconciliation, and failure behavior.
- **D13 Checkout safety:** Define dirty-checkout policy, concurrent Team Goals targeting one Project, read-only enforcement strength, and whether Builder commits changes.
- **D14 Cancellation and failure:** “Cancel where safe” is unspecified. Define whether cancellation interrupts work, terminates Pi, preserves terminals, and how timeout, retry, process exit, and assignment failure interact.
- **D15 Artifact acceptance:** Define artifact schemas, who accepts each artifact, how required corrections are represented, and what constitutes an accepted integrated result.
- **D16 Recovery action:** The degraded recovery rule says “resume/retry” but does not define either operation, assignment idempotency, or how a reconnected agent proves completion.
- **D17 Proposed sections:** Write policy, lifecycle states, UI scope, and degraded recovery remain explicitly **Proposed**. They need confirmation or revision under the document’s own decision-label rules.

The Pi and Boomux spikes are feasibility gates rather than product decisions, but their results must resolve **D11–D12**. The largest specification gaps are **D10, D13, D14, and D16** because they determine whether the writer invariant, event history, cancellation, and crash recovery are actually safe.