## 1. Proposed end state

Create a self-contained throwaway spike under `spikes/pi-visible-bridge/` with:

- A Pi extension loaded by `pi -e` into the visible interactive TUI.
- A local Node runner stub using a Unix-domain socket and newline-delimited JSON.
- The extension calls `pi.sendUserMessage()` directly for assignments. It never creates an SDK session, starts a child process, or launches another Pi.
- Structured events for:
  - handshake, connection, disconnection, and reconnection;
  - assignment accepted, started, settled, rejected, or reconciliation required;
  - message start, update, and end;
  - tool execution start, update, and end;
  - extension UI attention start and end;
  - submitted interactive input and `manual_takeover`.
- A bounded reconnect loop that re-handshakes and sends a current-state snapshot after the runner restarts.
- Automated tests for framing, protocol validation, assignment deduplication, source classification, event projection, and socket reconnection.
- A spike record with exact setup, API inventory, automated evidence, known failures, file disposition, and a manual verification checklist.

The record must not conclude that visible-TUI support is proven until a human observes it. Before that, its conclusion should state that the capability remains unconfirmed at the required manual gate rather than misclassifying an untested capability as unsupported.

Use Pi extension APIs, not the SDK session APIs. The SDK would create or embed another agent session and is unnecessary for controlling the host session.

## 2. Implementation tasks

### A1. Define the spike protocol

Create a small versioned NDJSON protocol with runtime validation:

- Extension to runner:
  - `hello`
  - `state_snapshot`
  - `assignment_ack`
  - `event`
- Runner to extension:
  - `hello_ack`
  - `assignment`
- Common envelope fields:
  - protocol version
  - agent run ID
  - Pi session ID
  - extension instance ID
  - message/event ID
  - timestamp

Assignment acknowledgements distinguish `accepted`, `busy`, `duplicate`, and `invalid`.

Dependency: none.

### A2. Implement transport and runner stub

Implement:

- Unix socket server with stale-socket cleanup.
- NDJSON framing across fragmented and combined reads.
- Structured stdout and optional evidence-file logging.
- Optional one-shot assignment supplied by CLI arguments or a JSON fixture.
- Graceful shutdown that leaves Pi running.
- Client reconnect with bounded exponential backoff and no process spawning.
- Re-handshake plus current assignment/control snapshot after reconnect.

Dependency: A1.

### A3. Implement the Pi extension

Start the socket client only from `session_start` and close it idempotently from `session_shutdown`.

Use these Pi 0.84.4 APIs:

- `pi.on("session_start")`
- `pi.on("session_shutdown")`
- `pi.on("input")`
- `pi.on("before_agent_start")`
- `pi.on("agent_start")`
- `pi.on("agent_settled")`
- `pi.on("message_start" | "message_update" | "message_end")`
- `pi.on("tool_execution_start" | "tool_execution_update" | "tool_execution_end")`
- `pi.on("ui_prompt_start" | "ui_prompt_end")`
- `pi.sendUserMessage()`
- `ctx.mode`, `ctx.isIdle()`
- `ctx.sessionManager.getSessionId()`
- `ctx.ui.setStatus()` and `ctx.ui.notify()`

Assignment handling:

1. Require `ctx.mode === "tui"`.
2. Reject while Pi is busy.
3. Deduplicate assignment IDs for the extension instance.
4. Mark the assignment accepted.
5. Call `pi.sendUserMessage(prompt)`.
6. Associate subsequent agent, message, and tool events with that assignment.
7. On `agent_settled`, report settled unless takeover occurred, in which case report `needs_reconciliation`.

Human takeover handling:

- `input.source === "interactive"` while managed emits `human_message_submitted` and transitions to `manual_takeover`.
- `input.source === "extension"` is the managed assignment and must not trigger takeover.
- Document that extension commands bypass `input`, and `!` user-bash input has a separate API. Those paths cannot be claimed as automatically detected by this spike.

Add a `/bridge-attention-probe` command using `ctx.ui.confirm()` so `ui_prompt_start` and `ui_prompt_end` can be exercised visibly.

Dependencies: A1 and A2.

### A4. Add focused automated tests

Tests should cover:

- fragmented and multiple NDJSON frames;
- invalid protocol messages;
- assignment acceptance, busy rejection, and duplicate acknowledgement;
- interactive versus extension input classification;
- assignment lifecycle projection;
- tool and message event serialization;
- runner shutdown and restart with the same extension client reconnecting;
- handshake and state snapshot after reconnect;
- source guard proving no `createAgentSession`, `InteractiveMode`, `child_process`, or Pi executable spawning exists in the prototype.

Dependencies: A1 and A2. Most tests can run in parallel with A3 once protocol types are stable.

### A5. Write the spike record and evidence

Record:

- Falsifiable question and assumptions.
- Pi version `0.84.4`.
- Exact APIs listed in A3.
- Local trust and Unix-socket security assumptions.
- Reproducible automated and manual commands.
- Captured automated test output.
- Empty/manual evidence fields that cannot be populated by a nested agent.
- Constraints and failures.
- Proposed Pi bridge contract implications without editing `docs/design/mvp.md`, because the request confines changes to the spike directory.
- Explicit disposition for every file.

Dependency: A1 for the initial document. Final evidence depends on A4. The visible conclusion depends on A6.

### A6. Human manual gate

A human must:

1. Start the runner.
2. Start visible interactive Pi with `pi -e <extension>`.
3. Confirm the bridge status is visibly connected.
4. Dispatch an assignment that explicitly requires one tool call.
5. Observe the assignment running in that exact visible TUI.
6. Confirm lifecycle, assistant message, and tool events in runner output.
7. Run `/bridge-attention-probe` and observe attention events.
8. Submit a normal human message and observe `manual_takeover`.
9. Stop and restart only the runner, then observe reconnection and a fresh handshake/state snapshot.
10. Inspect the process tree and confirm there is one Pi process, with only the separate runner stub beside it.

Dependency: A2 through A5. This cannot be parallelized or truthfully replaced by headless testing.

## 3. Best ownership for SOL

SOL should own:

- A1 protocol and state-transition design.
- Review of A3 against Pi lifecycle semantics.
- A5 contract implications, constraints, and conclusion wording.
- Final audit that no second agent session or hidden Pi process is introduced.

TERRA and LUNA can implement the transport/runner and extension/tests in parallel after A1 is fixed.

## 4. Collision and safety concerns

- **R1: Shared protocol files.** Assign one owner to protocol schemas before runner and extension work begins.
- **R2: Socket cleanup.** Only the runner may unlink the socket path. The extension must never remove a live server socket.
- **R3: Duplicate assignment after reconnect.** Runner restart must not silently re-run an assignment. Repeated IDs receive `duplicate`, and reconnect sends state rather than assuming completion.
- **R4: Busy host session.** Do not call `pi.sendUserMessage()` without `deliverAs` while streaming. Reject the assignment as busy for this spike rather than introducing interruption policy.
- **R5: False takeover.** Extension-injected assignment messages have source `extension` and must be excluded. Only submitted interactive input counts.
- **R6: Incomplete input coverage.** Slash commands bypass `input`; user bash has a separate event. Document these as unsupported automatic takeover paths.
- **R7: Telemetry claims.** `ui_prompt_*` covers blocking extension UI prompts, not every possible authentication, provider, or native Pi condition.
- **R8: Message volume and sensitivity.** Bound message updates and avoid logging thinking content, credentials, full tool results, or unlimited deltas.
- **R9: Reload versus runner restart.** Prove runner restart only. Pi `/reload`, session replacement, and full Pi restart are separate recovery cases.
- **R10: Scope.** No Boomux, QML, SQLite, production auth, durable event store, SDK-created agent, or edits outside the spike directory.

## 5. Objective validation

Automated acceptance requires all tests to pass and captured output to show:

- one handshake;
- assignment acceptance and deduplication;
- structured lifecycle, message, and tool serialization;
- interactive-source takeover classification;
- connection loss;
- reconnection after server restart;
- a new handshake and state snapshot;
- no hidden-agent APIs or process-spawning code.

Visible execution remains unproven until A6 is completed and its observations are recorded. The implementation should stop at that manual gate rather than claim visible-TUI support.