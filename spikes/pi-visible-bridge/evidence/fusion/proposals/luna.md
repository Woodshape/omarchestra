## 1. Proposed end state

Create only `spikes/pi-visible-bridge/` containing:

- A small TypeScript Pi extension loaded into the same interactive Pi process.
- A local runner stub using Unix-socket JSONL IPC.
- A minimal versioned protocol covering:
  - handshake and identity
  - assignment delivery and acknowledgement
  - lifecycle, message, tool, and attention events
  - reconnect with sequence/cursor replay
  - runner restart
- Focused automated protocol/unit tests.
- A spike record with captured automated evidence and a clearly marked manual validation gate.

The extension must execute assignments by calling Pi’s existing-session API, principally `pi.sendUserMessage()`. It must not import or create `createAgentSession()`, invoke Pi RPC mode, or launch another Pi process.

The likely conclusion should remain provisional until a human observes the real interactive TUI.

## 2. Implementation tasks, dependencies, and parallelism

### Sequential core

1. **Protocol and evidence schema**
   - Define JSONL envelopes, protocol version, agent identity, event IDs, sequence numbers, acknowledgements, reconnect cursor, and failure records.
   - Dependency: none.

2. **Runner stub**
   - Listen on a Unix socket.
   - Accept handshake.
   - Send a deterministic assignment.
   - Record received events.
   - Support deliberate disconnect/restart and replay from the client cursor.
   - Dependency: protocol schema.

3. **Pi extension**
   - Start connection only from `session_start`, per Pi’s resource-lifecycle guidance.
   - Handshake with session ID and configured Agent Run identity.
   - Deliver assignments through `pi.sendUserMessage()`.
   - Emit:
     - `session_start` / shutdown
     - `agent_start`, `agent_end`, `agent_settled`
     - message lifecycle events
     - tool execution events
     - `ui_prompt_start` / `ui_prompt_end` as attention evidence
     - `input` events
     - model/thinking changes where useful
   - Classify `input.source === "interactive"` as submitted human input and report `manual_takeover`. Do not classify unsent editor keystrokes.
   - Reconnect with bounded backoff and cursor-based reconciliation.
   - Dependency: protocol schema and runner stub.

4. **Automated tests**
   - Test framing, handshake, assignment validation, event ordering, acknowledgements, reconnect, replay, duplicate suppression, and malformed messages.
   - Test extension logic with mocked Pi API and mocked socket transport where possible.
   - Dependency: runner and extension implementation.

5. **Manual TUI validation**
   - Launch one visible Pi process with the extension and runner stub.
   - Observe assignment execution in the same visible session.
   - Submit a human message and confirm takeover event.
   - Kill/restart the runner and confirm reconnect without a second Pi process.
   - Capture commands, event logs, process listing evidence, screenshots or terminal transcript.
   - Dependency: runnable spike and credentials/model availability.

### Parallel work

- Protocol schema and spike-record template can proceed in parallel with runner-stub scaffolding.
- Runner tests and extension unit-test harness can proceed in parallel after the protocol is fixed.
- Documentation of exact APIs and file dispositions can proceed while implementation is built.
- Manual validation preparation can proceed in parallel, but the conclusion must wait for observed results.

## 3. What this slot is best suited to own

Own the **Pi extension and bridge contract**, including:

- Event mapping from Pi extension hooks to Omarchestra events.
- Assignment injection through `pi.sendUserMessage()`.
- Human-input classification through the `input` event’s `source`.
- Reconnect state machine and cursor handling.
- Tests proving no SDK-created or child Pi agent exists.
- The spike record’s API table, unsupported behavior, and manual validation gate.

The runner stub can remain intentionally simple and deterministic.

## 4. Collision and safety concerns

- Do not use Pi SDK `createAgentSession()` or `runRpcMode()`. Either would risk testing a second or headless agent rather than the visible host session.
- `sendUserMessage()` always triggers a turn. The bridge must reject or defer assignments while the session is busy rather than silently interrupting active work.
- `input` events distinguish submitted input, not raw keystrokes. Manual takeover must be triggered only for `source === "interactive"` or an explicit takeover command.
- `source === "extension"` must not trigger manual takeover for bridge-delivered assignments.
- Avoid recursive loops where bridge-injected messages produce bridge commands or are mistaken for runner acknowledgements.
- Event emission must be serialized and durable enough to avoid duplicate lifecycle events after reconnect.
- Reconnect must not replay an assignment into Pi unless the assignment delivery state is unambiguously unresolved.
- `session_shutdown` must close sockets and timers. Background resources must not start from the extension factory.
- Attention events from Pi UI prompts indicate attention, not resolution. The bridge must not answer prompts or inject terminal keystrokes.
- Automated tests cannot establish visible-TUI support. The conclusion must be `supported with constraints` or `undetermined` until manual evidence exists.
- Keep all prototype files under `spikes/pi-visible-bridge`; do not alter `docs/design/mvp.md` until evidence supports a precise contract update. A later documentation task should record the result and close only the Pi bridge items justified by the spike.

## 5. Objective validation

Automated acceptance:

- Protocol messages are strict JSONL with schema validation.
- Handshake identifies the same Pi session and Agent Run.
- A runner assignment produces one visible-session user message through the extension path.
- Event records contain stable IDs and monotonically ordered sequence numbers.
- Lifecycle, message, tool, and attention mappings are captured.
- Interactive input produces a manual-takeover event.
- Extension-originated assignment input does not.
- Runner disconnect and restart recover the connection and replay missing events exactly once.
- Tests confirm no child process is spawned and no SDK agent session is created.

Manual acceptance gate:

```text
Start runner stub.
Start one interactive `pi` with the spike extension.
Observe the visible assignment response in that same TUI.
Submit a human message in the TUI.
Restart the runner stub.
Observe reconnect and continued event delivery.
Verify process listing contains only the one Pi process and runner stub.
```

Required record:

- Exact Pi version: `0.84.4`.
- APIs: `ExtensionAPI`, `pi.on`, `pi.sendUserMessage`, `session_start`, `session_shutdown`, `input`, agent/message/tool/UI prompt events, and `ctx.sessionManager` or session ID access as needed.
- Automated logs and test output.
- Manual transcript or screenshots.
- Explicit failures and environmental limitations.
- Disposition for every file:
  - extension: throw away unless deliberately retained as a test fixture;
  - runner stub: throw away;
  - protocol types/tests: retain only if explicitly promoted;
  - captured logs: retain as spike evidence;
  - setup/package files: throw away or retain as a fixture, explicitly stated.
