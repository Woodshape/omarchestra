1. Proposed end state

`spikes/pi-visible-bridge/` contains a throwaway Node runner stub and a Pi `-e` extension. The extension connects to the runner over localhost NDJSON, receives one idempotent assignment, injects it into the same visible Pi session with `pi.sendMessage(..., { triggerTurn: true })`, and emits structured events for:

- connection and session/agent lifecycle
- user and assistant message lifecycle
- tool start, update, and end
- Pi UI prompt attention
- direct submitted interactive input as `manual_takeover`

The extension reconnects after socket loss with bounded backoff. It starts no Pi subprocess. A spike record documents APIs, evidence, constraints, manual gate, and disposition.

2. Tasks, dependencies, parallelism

- A1: Define the spike protocol and acceptance scenarios: `hello`, `assignment`, `assignment_ack`, `event`, runner restart/reconnect, and error framing.
- A2: Build a dependency-free localhost NDJSON runner stub with deterministic assignment delivery and event capture.
- A3: Build the Pi extension, loaded via `pi -e`, using `session_start` and `session_shutdown` for socket lifecycle; `input`, agent/message/tool/UI-prompt events for telemetry; and `pi.sendMessage` for assignment delivery.
- A4: Add focused Node tests for framing, assignment idempotency, event serialization, and runner reconnect. A2 and A3 depend on A1. A4 can begin once the protocol is defined.
- A5: Add `README.md` as the spike record, plus a manual verification command and evidence template. Depends on A1. Populate the conclusion only after A6.
- A6: Manual visible-TUI validation: run the runner and one visible Pi command in a real terminal, submit a normal human message, restart the runner, and inspect captured events/processes. Depends on A2–A5.

A2 and A3 can run in parallel after A1. A4 and A5 can run in parallel with implementation.

3. Best slot ownership

I should own A3 and A4: the extension event mapping, assignment injection path, reconnect state machine, and protocol-level tests. This is the highest-risk API integration.

4. Collision and safety concerns

- F1: `input` reports submitted interactive messages, but extension commands bypass that event. The spike must scope takeover evidence to a normal submitted prompt, not `/command` input.
- F2: Assignment injection must use `pi.sendMessage`, not `pi.sendUserMessage`, so it is distinguishable from human input and does not falsely trigger takeover.
- F3: Reconnect and assignment delivery need stable `assignmentId` plus acknowledgement/deduplication. Otherwise a runner or extension restart can execute work twice.
- F4: Socket resources must start in `session_start` and close in `session_shutdown`, not in the extension factory.
- F5: Runner event capture must be append-only and local. No transcript scraping, PTY injection, hidden Pi subprocess, or production persistence.
- F6: Pi 0.84.4 documents event hooks, but documentation alone cannot prove the visible TUI behavior. The record must remain `pending manual validation` until A6.

5. Objective validation

- Automated: Node tests prove NDJSON framing, protocol validation, assignment deduplication, reconnect after listener replacement, and emitted event shapes.
- Manual command starts exactly one `pi -e spikes/pi-visible-bridge/bridge.ts` process plus one Node runner stub.
- In the visible Pi terminal, the managed assignment appears and causes work in that same session.
- Runner capture includes handshake, assignment acknowledgement, lifecycle, message, tool, attention, and `manual_takeover` after a normal submitted human prompt.
- Restarting only the runner produces a new handshake and continued event capture from the still-visible Pi process.
- Process observation confirms no second Pi process was launched.
- The spike conclusion is `supported`, `unsupported`, or `supported with constraints` only after the human records this evidence.