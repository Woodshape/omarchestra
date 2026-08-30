# Visible interactive Pi bridge spike

Status: **complete — supported with constraints**

This is the first Omarchestra feasibility spike. It is a throwaway probe, not application architecture.

## Question

Can one visible interactive Pi TUI, with an extension loaded into that same process:

1. handshake with a local runner stub;
2. receive a managed assignment and execute it in the visible host session;
3. emit structured lifecycle, message, tool, and attention events;
4. detect a submitted human message and report manual takeover;
5. reconnect after the runner stub restarts; and
6. do this without launching a second hidden Pi agent?

The question is falsified if any required behavior needs a second Pi session/process, PTY input injection, terminal scraping, or replacement of the interactive TUI.

## Assumptions and boundary

- The runner and Pi run as the same trusted local user on a Unix-like host.
- The assignment arrives while the visible Pi host session is idle. This spike rejects a new assignment as `busy`; it does not queue or interrupt work.
- One extension instance handles one Agent Run and retains assignment deduplication only in memory while that instance survives.
- A runner restart may lose events sent while disconnected. Reconnection supplies a current state snapshot; this spike does not provide durable replay or exactly-once delivery.
- A submitted ordinary TUI message is observable as `input.source === "interactive"`. Unsubmitted editor keystrokes are intentionally not takeover.
- The runner stub, protocol, tests, and extension are confined to this directory. There is no Boomux, QML, SQLite, production orchestration, PTY control, or final application architecture here.

## Versions and Pi APIs

Verified locally:

```text
pi --version   # 0.84.4
node --version # v26.8.1
```

The extension uses Pi **0.84.4** extension APIs in the existing host session:

- `ExtensionAPI` extension factory
- `pi.on("session_start")` and `pi.on("session_shutdown")`
- `pi.on("input")`
- `pi.on("agent_start")`, `pi.on("agent_end")`, and `pi.on("agent_settled")`
- `pi.on("message_start")`, `pi.on("message_update")`, and `pi.on("message_end")`
- `pi.on("tool_execution_start")`, `pi.on("tool_execution_update")`, and `pi.on("tool_execution_end")`
- `pi.on("ui_prompt_start")` and `pi.on("ui_prompt_end")`
- `pi.sendUserMessage()` to execute the managed assignment in the loaded host session
- `pi.registerCommand()` for the manual attention probe
- `ctx.mode`, `ctx.isIdle()`, and `ctx.sessionManager.getSessionId()`
- `ctx.ui.notify()` and `ctx.ui.confirm()`

No Pi SDK session API is used. In particular, the prototype does not use `createAgentSession`, `InteractiveMode`, `runRpcMode`, RPC mode, `child_process`, a Pi executable invocation, or a PTY library.

Documentation consulted before implementation:

- Pi `docs/extensions.md`, including extension resource lifetime and input-source behavior
- Pi `docs/sdk.md`, to distinguish embedding a new session from extending the existing host session
- Pi `docs/tui.md`
- Pi `docs/session-format.md`
- Relevant extension examples: `README.md`, `send-user-message.ts`, `input-transform.ts`, `input-transform-streaming.ts`, `status-line.ts`, `file-trigger.ts`, `structured-output.ts`, `message-renderer.ts`, `entry-renderer.ts`, `reload-runtime.ts`, and `model-status.ts`

## Prototype protocol

The dependency-free protocol is versioned NDJSON over a Unix-domain socket.

Runner to extension:

- `hello_ack`
- `assignment`

Extension to runner:

- `hello`
- `assignment_ack` with `accepted`, `busy`, `duplicate`, or `invalid`
- ordered `event` records with a stable extension-instance event ID and monotonically increasing sequence
- `state_snapshot` after every successful handshake

The extension reconnects with bounded exponential backoff. A surviving extension remembers accepted assignment IDs, so a restarted runner resending the same assignment receives `duplicate` instead of executing it again. A different assignment receives `busy` while the prior assignment is active.

Frames reject unknown fields, unsupported protocol versions, malformed IDs, invalid states, and oversized data. Telemetry is bounded to 16 KiB encoded, depth 6, 64 object keys, 64 array items, and 4,096 characters per string. Assistant thinking deltas, raw tool arguments, raw partial tool results, and raw final tool results are not published. Observable message text can still contain sensitive project data and must be treated accordingly.

## Success criteria and current evidence

| Criterion | Automated evidence | Manual evidence required |
| --- | --- | --- |
| Handshake with runner | Real Unix-socket integration test passes | Passed: TUI PID `98226` identified in `hello` |
| Execute assignment in visible host session | Extension calls `pi.sendUserMessage()`; source audit excludes another session | Passed: assignment, `read` call, and exact response observed in that TUI |
| Lifecycle/message/tool/attention events | Event mapping and ordered transport implemented; protocol tests pass | Passed with telemetry-volume/content constraints |
| Submitted human message causes takeover | Pure source-classification test passes | Passed: events 40–41 and visible acknowledgement |
| Reconnect after runner restart | Real listener replacement test passes across three runner instances | Passed: same PID/session/extension reconnected and state was preserved |
| No hidden Pi agent | Source audit rejects SDK, spawn, RPC, and PTY paths | Passed: process tree contained no descendant Pi agent |

Automated success means the transport and pure extension logic support the design. It cannot establish that Pi rendered and executed the assignment in a human-visible interactive terminal.

## Reproducible automated validation

From the repository root, with no dependency installation:

```bash
node --check spikes/pi-visible-bridge/runner.mjs
node --check spikes/pi-visible-bridge/lib/client.mjs
node --check spikes/pi-visible-bridge/lib/protocol.mjs
node --check spikes/pi-visible-bridge/lib/state.mjs
node --check spikes/pi-visible-bridge/test/runner.test.mjs
node --check spikes/pi-visible-bridge/test/extension.test.mjs
node --check spikes/pi-visible-bridge/test/integration.test.mjs
pi --offline --no-extensions -e ./spikes/pi-visible-bridge/extension.ts --list-models >/tmp/pi-visible-models.txt
node --test spikes/pi-visible-bridge/test/*.test.mjs
git diff --check
```

Captured result: [`evidence/automated.txt`](evidence/automated.txt). The extension loads successfully through Pi 0.84.4 in offline resource-listing mode, and all 11 tests pass. Coverage includes fragmented NDJSON, malformed frames, handshake ordering, assignment acknowledgement states, deduplication, input-source classification, bounded serialization, reconnect, state reconciliation, ordered events, and prohibited hidden-agent mechanisms.

## Manual visible-TUI validation gate

This gate passed on 2026-08-30. The procedure remains below for reproducibility. Captured observations are recorded in [`evidence/manual-observations.md`](evidence/manual-observations.md).

Use two visible terminals from the repository root.

### Terminal 1: start the runner

```bash
cd ~/claude/omarchestra
rm -f /tmp/omarchestra-pi-visible-bridge.sock \
  spikes/pi-visible-bridge/evidence/manual-runner.ndjson
node spikes/pi-visible-bridge/runner.mjs \
  --socket /tmp/omarchestra-pi-visible-bridge.sock \
  --assignment-id visible-spike-1 \
  --prompt 'Use the read tool to read spikes/README.md, then reply with exactly: VISIBLE BRIDGE ASSIGNMENT COMPLETE' \
  | tee spikes/pi-visible-bridge/evidence/manual-runner.ndjson
```

Keep this terminal visible. Its stdout is structured NDJSON evidence.

### Terminal 2: start exactly one interactive Pi

```bash
cd ~/claude/omarchestra
OMARCHESTRA_BRIDGE_SOCKET=/tmp/omarchestra-pi-visible-bridge.sock \
OMARCHESTRA_AGENT_RUN_ID=visible-spike-agent \
OMARCHESTRA_EXTENSION_INSTANCE_ID=visible-spike-extension \
pi -e ./spikes/pi-visible-bridge/extension.ts
```

Do not use `-p`, `--mode json`, or `--mode rpc`.

### Observe assignment and telemetry

Confirm all of the following:

1. Terminal 1 records `hello`, `hello_ack`, `bridge_connected`, `session_started`, `state_snapshot`, and an `accepted` assignment acknowledgement.
2. Terminal 2 visibly shows the assignment, the `read` tool call, and the exact completion text in the same interactive session.
3. Terminal 1 records message and tool start/update/end events from that turn.
4. In Terminal 2 run `/bridge-attention-probe`, visibly answer the confirmation, and confirm Terminal 1 records `attention_required` and `attention_resolved`.
5. Submit the ordinary message `Human takeover probe` in Terminal 2. Confirm Terminal 1 records `human_message_submitted` and `manual_takeover` before or alongside the resulting turn.

### Restart only the runner

Press Ctrl-C in Terminal 1. Leave Terminal 2 and its Pi process running. Restart Terminal 1 with the same runner command above, changing the final `tee` invocation to `tee -a` so reconnect evidence is appended rather than overwritten.

Confirm the restarted runner records:

- a fresh `hello` and accepted `hello_ack`;
- `bridge_reconnected`;
- a `state_snapshot` preserving control and assignment state; and
- a `duplicate` acknowledgement for `visible-spike-1`, with no second execution in Terminal 2.

Then run `/bridge-attention-probe` once more to prove event delivery continues after reconnect.

### Process-tree check

Read the visible Pi PID from the runner's `hello.message.pid`, substitute it below, and capture:

```bash
VISIBLE_PI_PID=<pid-from-hello>
ps -o pid,ppid,sid,stat,args -p "$VISIBLE_PI_PID"
pstree -ap "$VISIBLE_PI_PID"
pgrep -af '(^|/)pi( |$)|runner\.mjs'
```

Verify that the PID is Terminal 2's interactive Pi and that its descendant tree contains no second Pi agent. The separate Node runner is expected. If `pstree` is unavailable, use:

```bash
ps --forest -eo pid,ppid,sid,stat,args | grep -E "(^|[[:space:]])($VISIBLE_PI_PID|PID)|[p]i( |$)|runner\.mjs"
```

Record observed output or screenshots before changing the conclusion below.

## Captured evidence and failures

### Captured

- `evidence/automated.txt`: 11 passing tests using real Unix sockets for runner/client integration.
- `evidence/manual-runner.ndjson`: 78 records proving the visible model/tool turn, takeover, runner restart, state reconciliation, duplicate rejection, and post-reconnect attention.
- `evidence/manual-process-tree.txt`: the visible Pi PID and absence of a descendant hidden Pi agent.
- `evidence/manual-observations.md`: human-observed gate results and constraints.
- `evidence/fusion/`: preserved collaboration prompt, plan, proposals, task reports, final report, and run summary.
- Static source audit: no SDK-created session, RPC agent, child Pi process, or PTY injection mechanism.
- Local commands report Pi 0.84.4 and Node v26.8.1.

### Not captured

- No real Pi-owned authentication, permission, or other native attention prompt has been exercised.

### Known constraints and unsupported behavior

- Slash extension commands are checked before the `input` event, so they are **not proven automatic takeover paths**. The `/bridge-attention-probe` command tests attention only.
- `!` and `!!` user-bash submissions use the separate `user_bash` event and are **not proven automatic takeover paths** by this prototype.
- `ui_prompt_start` and `ui_prompt_end` document blocking extension UI prompts. They do not prove coverage of every native Pi, provider, authentication, permission, or unknown attention condition, and these notification hooks are best-effort.
- Reconnect sends current state, not a durable replay of events missed while disconnected. A sequence gap is therefore possible and truthful.
- Deduplication survives a runner restart only while the same extension instance remains alive. Pi reload, session replacement, Pi restart, and machine reboot recovery are not supported.
- The runner has no authentication, authorization, socket-permission hardening, durable storage, or active-listener ownership protocol. It is trusted-local spike code.
- Cancellation, handoff, return-to-team, and accept/resume/retry reconciliation are not implemented.
- Busy assignments are rejected rather than queued.
- Session shutdown delivery is best-effort during process teardown.
- Unix-domain sockets make this prototype non-portable to Windows.
- Manual evidence exposed a filtering defect: `toolResult` message events included complete tool-result text despite the intended raw-result exclusion. Production telemetry must omit tool-result bodies.
- Token-level `message_updated` events are too high-volume for durable storage or direct QML projection. Production telemetry must coalesce or discard streaming deltas.
- User and assistant message text remains sensitive; the production bridge needs an explicit content policy rather than treating structured events as a transcript.

## Conclusion

**Supported with constraints.** One visible interactive Pi TUI accepted and executed a managed assignment through `pi.sendUserMessage()`, emitted structured lifecycle/tool/attention events, reported submitted human input as manual takeover, reconnected after runner restart with preserved state, rejected duplicate execution, and had no descendant hidden Pi agent.

The result validates the same-process bridge direction, not the prototype as production code. The production contract must address telemetry filtering/coalescing, durable ordering/replay, trust and socket permissions, broader input/attention coverage, reconciliation commands, and recovery beyond a surviving extension instance.

## Implications for `docs/design/mvp.md`

The manual gate passed and the authoritative design now records these evidence-backed constraints:

1. Managed assignment delivery uses `pi.sendUserMessage()` from an extension loaded in the visible interactive host process; it does not use the SDK to create another session.
2. Handshake identity minimally includes protocol version, Agent Run ID, Pi session ID, extension instance ID, host PID, and TUI mode.
3. Assignments require stable IDs and explicit `accepted`, `busy`, `duplicate`, or `invalid` acknowledgements.
4. Submitted ordinary interactive input is reported from `input.source === "interactive"`; extension-originated assignment input is excluded. Slash commands and user-bash need explicit additional handling or must remain documented gaps.
5. Guaranteed telemetry is limited to the Pi 0.84.4 hooks manually verified. Attention coverage must distinguish extension UI prompts from unverified native conditions.
6. Events need stable IDs and monotonically increasing sequence numbers. A reconnect handshake must include a state snapshot. Durable replay, acknowledgement cursors, and persistence remain runner-contract work.
7. Runner restart recovery is supported only while the visible Pi and extension instance survive. In-flight uncertainty must remain explicit.
8. The protocol must bound and redact telemetry; it must not treat structured events as a complete transcript.

The remaining schema, persistence, filtering, trust, and compatibility details stay open as production technical-contract work.

## Prototype file disposition

| File | Disposition |
| --- | --- |
| `extension.ts` | Throw away after extracting an evidence-backed bridge contract; do not promote directly to production. |
| `runner.mjs` | Throw away; it is a trusted-local deterministic stub, not the Team Runner. |
| `lib/client.mjs` | Throw away; reconnect behavior is a fixture without durable replay or production lifecycle policy. |
| `lib/protocol.mjs` | Retain with this spike as reproducible evidence only; any production schema requires deliberate redesign/versioning. |
| `lib/state.mjs` | Retain with this spike as a pure test fixture only; it is not the production domain model. |
| `test/runner.test.mjs` | Retain with the spike as automated evidence. |
| `test/extension.test.mjs` | Retain with the spike as automated evidence. |
| `test/integration.test.mjs` | Retain with the spike as automated evidence, including the hidden-agent source guard. |
| `evidence/automated.txt` | Retain as captured automated evidence. |
| `evidence/manual-runner.ndjson` | Retain as captured visible execution and reconnect evidence; it contains sensitive message/tool content from the controlled probe. |
| `evidence/manual-process-tree.txt` | Retain as process-identity evidence. |
| `evidence/manual-observations.md` | Retain as the human gate record and constraint summary. |
| `evidence/fusion/` | Retain as collaboration provenance; it is not runtime input or product architecture. |
| `README.md` | Retain as the spike record and manual validation gate. |

No prototype file is promoted into the final application by this result.
