# Remote execution Node spike

Status: **automated harness complete; controlled remote/GUI gate pending**

This is the third Omarchestra feasibility spike. It is throwaway evidence code, not production architecture.

## Question

Can one preconfigured non-Omarchy GNU/Linux Node own one Team Goal, one coordinated Workspace, exactly three role Shells, three visible interactive Pi processes, one node-local runner, and three bridge connections while the local machine presents the PTYs and loses/reestablishes its control connection?

The result is unsupported if work requires a hidden Pi process, SDK/RPC session creation, PTY input injection, terminal-output scraping, a public TCP listener, guessed resource ownership, or cleanup broader than exact receipt-owned IDs.

## Scope and boundary

The harness proves the runner and bridge contract with deterministic fakes. It does not contact SSH, Boomux, Pi, systemd, Hyprland, a provider, or a remote checkout during automated tests.

Authority is split as follows:

- The remote Boomux Node owns the Workspace, Shells, Shell Runs, PTYs, and visible Pi processes.
- The node-local runner owns durable Team Goal, role binding, assignment, event, and artifact state.
- Each visible Pi process loads `bridge-extension.js` and calls only `pi.sendUserMessage()` for managed assignments.
- The local control client reaches the runner through authenticated SSH stdio. The remote helper then connects to the runner's owner-only Unix socket.
- The local Boomux CLI presents exact remote Shell IDs. The harness never uses terminal bytes as identity or observability.

The runner does not start Pi. Boomux starts the three interactive processes in the exact Shells. The bridge does not create a Pi session, use RPC or JSON mode, invoke a Pi executable, or write PTY input.

## Implemented contract

### Durable runner

`RunnerCore` stores a validated `omarchestra.remote-execution-node.runner-state/v1` document through `DurableStateStore` or `MemoryDurableStore`.

The state records:

- one receipt ID and Team Goal ID;
- exactly `coordinator`, `builder`, and `reviewer` bindings, each with one unique Agent Run ID, Shell ID, and optional Shell Run ID;
- each bridge's exact Pi session, extension instance, PID, connection, control mode, and last source sequence;
- assignment IDs, role, bounded prompt, state, acknowledgement, and delivery count;
- a bounded globally ordered event list, first retained sequence, opaque cursor, and bounded source-event deduplication IDs;
- bounded artifact summaries and validation results.

Every durable runner-state mutation persists before its transport response. An active assignment remains durable when the bridge or control transport disconnects. Runner restart changes stale connected records to disconnected, records `runner_restarted`, and permits only the same visible identity to reconnect. A changed Pi session, extension identity, PID, Agent Run, Shell, or Team Goal is rejected.

The filesystem store creates owner-only directories and `0600` files, uses a temporary file plus rename for replacement, rejects symlinks and foreign owners, bounds the encoded state, and never deletes a path other than its exact state file or temporary write file.

### Owner-only Unix socket

`RunnerServer` listens only on the validated Unix socket path. Its parent must be a real owner-controlled private directory, and the socket is chmodded and read back as owner-only. An existing socket is not replaced automatically. A stale or ambiguous path requires an explicit human decision outside this harness.

The socket accepts two authenticated-by-transport protocols:

- a bridge hello containing Team Goal ID, role, Agent Run ID, Shell ID, Pi session ID, extension instance ID, PID, and `tui` mode;
- a control hello containing receipt ID, Team Goal ID, and control-client ID.

Only one connection may own a role at a time. A second connection cannot take over an active role. Reconnect is accepted only when the durable visible-process identity matches.

`remote-helper.mjs control-proxy` is the SSH-stdio side. It validates NDJSON in both directions and forwards only control frames to the exact Unix socket. It never opens a TCP listener.

### Assignments, events, and cursors

Assignments have stable IDs and `accepted`, `busy`, `duplicate`, or `invalid` acknowledgements. The runner persists the assignment before delivery. The bridge remembers accepted IDs for the lifetime of its visible extension instance, so a runner resend after a transport loss is a duplicate and is not executed again.

Bridge events have stable per-extension IDs and positive source sequences. The runner assigns its own ordered durable sequence. Repeated source IDs are ignored. A source sequence jump creates an explicit `bridge_event_gap` record and marks the following event with `gapBefore: true`. Event pages are bounded to 256 records. A cursor older than retained history returns `gap: true`, `gapReason: "cursor_expired"`, `baseline: true`, and a current snapshot. A null cursor requests a baseline explicitly.

A runner snapshot sent on every bridge handshake contains the same Team Goal and role, current assignment projection, control mode, cursor, and visible-process identity metadata. The control client requests a fresh snapshot after SSH-stdio reconnect and retains cursor state without pretending to replay an unavailable gap.

### Takeover isolation

An ordinary submitted Pi message is detected only when Pi reports `input.source === "interactive"`. It records bounded character metadata and changes only that role to `manual_takeover`. An active assignment becomes `needs_reconciliation`; it is never silently completed. A builder takeover does not change Coordinator or Reviewer control modes or assignments. No bridge method injects input into the terminal.

The extension emits only metadata. It omits assignment prompt bodies from telemetry, thinking blocks, tool arguments, tool results, partial tool-result bodies, and raw text deltas. Text deltas become one bounded count/character summary per message, and tool updates are coalesced. User and assistant text is represented by bounded counts and block types rather than a transcript.

### Validation artifacts

`makeValidationArtifact()` records a deterministic non-agent command, exit status, signal, byte/character/line counts, SHA-256 values, and optional bounded structured result. It does not store command output bodies. A validation artifact is evidence only. It cannot substitute for the three visible Agent Run identities, a Reviewer result, or semantic acceptance.

`remote-helper.mjs sync-check` is a read-only remote checkout check for the spike files. It reports file presence, size, and digest without copying repository contents or credentials.

## Files

| Path | Purpose |
| --- | --- |
| `runner.mjs` | Owner-local runner CLI and Unix-socket server. |
| `bridge-extension.js` | Pi extension loaded into each visible interactive host. CommonJS wrapper uses dependency-free dynamic imports so Pi's jiti loader can load it. |
| `remote-helper.mjs` | SSH-stdio control proxy and read-only checkout sync check. |
| `manual.mjs` | Strict explicit-input, plan-only manual gate generator. It never executes a command. Mutation, presentation, and cleanup plans print only through the receipt-backed manual gate. |
| `lib/manual-gate.mjs` | Receipt-backed manual gate boundary: initialize/bind/record/confirm/ambiguous transitions over `FileReceiptStore`, with intent persisted before any live plan is printed. |
| `lib/protocol.mjs` | Strict versioned NDJSON frames, limits, and validators. |
| `lib/durable-store.mjs` | Owner-only durable runner state and schema validation. |
| `lib/runner-core.mjs` | Durable bindings, assignment, event, cursor, artifact, and reconnect logic. |
| `lib/bridge-state.mjs` | Pure visible-bridge state and assignment/takeover projection. |
| `lib/bridge-client.mjs` | Reconnecting owner-only Unix-socket bridge client. |
| `lib/control-client.mjs` | Reconnecting client for an injected SSH-stdio transport. It does not create SSH processes. |
| `lib/telemetry.mjs` | Redaction, bounds, and metadata-only summaries. |
| `lib/artifacts.mjs` | Structured validation artifact creation and validation. |
| `test/*.test.mjs` | Fake-only protocol, runner, reconnect, state, telemetry, safety, and source tests. |
| `test/link-check.mjs` | Relative Markdown link check. |
| `evidence/automated.txt` | Captured automated commands and results. |
| `evidence/manual-observations.md` | Pending human-only gate record. |
| `evidence/local/` | Ignored owner-local receipts, snapshots, state, process evidence, and sensitive live output. |

The existing `lib/validation.mjs`, `lib/commands.mjs`, `lib/envelopes.mjs`, `lib/executor.mjs`, `lib/receipt.mjs`, and `lib/runtime.mjs` are task 1.a public Boomux and receipt fixtures. Task 1.b adds the runner/bridge modules without changing production Omarchestra.

## Setup inputs

No target value is hardcoded into the harness. The manual plan requires explicit validated values for:

- local Boomux alias, expected pinned Boomux Node ID, and SSH target;
- remote repository and every executable path, including the exact remote `rm` path used only for receipt-owned runner files;
- receipt and Team Goal UUIDs;
- generated Agent Run UUIDs and reconciled Shell IDs;
- exact receipt-derived runner unit, socket, state, bridge, and helper paths. The plan rejects a unit not equal to `omarchestra-remote-spike-<receipt-id>.service`, a socket without the receipt-derived suffix, or a state path without the receipt-derived prefix;
- explicit remote `ps` and `pstree` executable paths for process evidence.

The documented setup examples in the fusion prompt are reference points only. The human operator must substitute values obtained from the current read-only preflight.

## Automated validation

From the repository root, with no dependency installation:

```bash
node --check spikes/remote-execution-node/bridge-extension.js
node --check spikes/remote-execution-node/runner.mjs
node --check spikes/remote-execution-node/remote-helper.mjs
node --check spikes/remote-execution-node/manual.mjs
node --check spikes/remote-execution-node/lib/*.mjs
node --check spikes/remote-execution-node/test/*.mjs
node --test spikes/remote-execution-node/test/*.test.mjs
node spikes/remote-execution-node/test/link-check.mjs
git diff --check
```

The tests use fake executors, fake network modules for reconnect cases, fake readable/writable SSH-shaped transports, memory stores, and temporary local state files. One integration test uses a temporary local owner-only Unix socket for `RunnerServer`. Tests do not invoke SSH, Boomux, systemd, Pi, a GUI, or a remote command.

Coverage includes strict frame and identity validation, exact role uniqueness, owner-only persistence, state rehydration, assignment acknowledgement and deduplication, ordered source events, cursor expiry and baseline behavior, reconnect snapshots, changed-identity refusal, single-role takeover isolation, metadata-only telemetry, coalescing, SSH-stdio reconnect behavior, Unix path-only transport, source coupling guards, and link validation.

## Manual gate

The live gate is pending. Do not run it during an automated or Fusion validation run. Each numbered phase requires a fresh human authorization and a private evidence copy under `evidence/local/`. Do not place live receipts, remote state, process trees, or provider/session data in Git.

`manual.mjs` is deliberately plan-only. It validates the full input set and prints exact argv vectors and framed control messages. It does not run the printed commands. This prevents an accidental Fusion run from starting a daemon, Pi, service, or GUI. Use its output as the source for the controlled human commands.

Define every value explicitly from the read-only setup, including all executable paths. Example variable names are placeholders, not defaults:

```bash
NODE_ALIAS='<preflight alias>'
EXPECTED_NODE_ID='<preflight pinned Node UUID>'
SSH_TARGET='<preflight user@host>'
REMOTE_REPO='<preflight absolute checkout>'
RECEIPT_ID='<new receipt UUID>'
TEAM_GOAL_ID='<new Team Goal UUID>'
```

The following staged actions are the required order. Stop after each plan and obtain the stated authorization before executing its printed live command.

### 1. Read-only preflight

Run a `preflight` plan with explicit `--node-alias`, `--expected-node-id`, `--ssh-target`, `--remote-repo`, `--receipt-id`, `--team-goal-id`, all ten executable flags, `--runner-path`, `--remote-helper-path`, `--bridge-path`, `--socket-path`, `--state-path`, and `--unit`.

Execute only its read commands. Capture privately:

- local Boomux capabilities and daemon status;
- exact alias, target, Node ID, registration revision, tombstone epoch, current online projection, protocol, and capabilities;
- local global Workspace list and event baseline;
- remote UID, runtime directory owner/mode, and `sudo -n` failure;
- bounded remote prerequisite and checkout facts;
- local Boomux configuration path/validation results and integration list/status fingerprints, recording an explicit `null` fingerprint where the configuration file is absent;

Reject UID 0, any noninteractive sudo capability, a foreign runtime directory, a stale/offline Node, a Node ID mismatch, a changed registration, a missing capability, or a pre-existing receipt/prefix collision. These configuration and integration captures are read-only: never read private Boomux state or mutate configuration or integrations on either Node.

Before the preflight plan, initialize the owner-only durable receipt with `receipt-init --receipt-store <ignored private path>`; after capturing the private preflight evidence, bind it with `preflight-bind --preflight-file <path>` (the bind requires the strictly validated execution identity, including the nonzero sudo-probe exit and the derived runtime directory).

### 1.5. Receipt-bound remote preflight

After binding, run the receipt-backed `preflight-remote` phase. It prints the remote Boomux capability, daemon, configuration, and integration reads with the receipt-bound `XDG_RUNTIME_DIR`. Capture the raw results and record them with `record-remote-preflight --evidence-file <path>`; this record is the first authority for remote configuration and integration fingerprints. No mutation plan is printable before that record, and no runtime-dependent remote command is printed before binding.

### 2. Remote checkout sync check

Run the `sync-check` plan and execute its exact SSH command only after authorizing this read-only phase. Confirm all required spike files are present at `spikes/remote-execution-node/` beneath the explicit remote repository root (never at the repository top level) and record their digests. The check refuses symlinks, irregular files, and upward traversal. Do not synchronize files, install dependencies, copy credentials, or alter the repository.

### 3. Create the Workspace and exact Shells

After the private preflight is bound, authorize `workspace-create` through the receipt gate; the gate persists the durable `workspace_create` intent before printing the plan, and the plan's Boomux binary and Workspace name come from the receipt, never from free CLI flags.

**Attempted boundary:** immediately before executing every printed mutating command, run `mark-attempted --operation-id <id>` on that operation. Every creation/readback confirmation requires `attempted`; a bare `intended` intent cannot be confirmed. A crash after `mark-attempted` blocks identical replay until the outcome is exactly reconciled through the specialized evidence action — and if the operator cannot prove the outcome, it must be recorded with `mark-ambiguous`. There is no generic `confirm-operation` command: generic exact confirmation was removed because it could bypass the specialized evidence actions; ambiguous resource operations can only be reconciled through those actions' raw public evidence.

Print the interleaved exact public readbacks (Workspace list before, create, Workspace list after) with `mark-attempted --operation-id workspace-create` before the create, confirm the readback with record-workspace-creation, and only then proceed. Execute the one public local Boomux command to create one empty coordinated Workspace with the receipt-derived exact name. An empty Workspace has zero placements, so this readback can prove only the global Workspace ID: resolve it with `record-workspace-creation --evidence-file <path>` whose evidence carries the raw public `before` Workspace IDs and the full after `workspace list --json` document, resolved strictly by `resolveWorkspaceCreation()`. A self-asserted normalized ID, or a guessed owner Workspace ID, is not accepted at this step. `shells-create` resolves the global Workspace ID from that confirmed readback only.

Execute the three public local Boomux Shell-create commands printed by `shells-create` (each interleaved with an owner Node snapshot readback), each with exact `--node <EXPECTED_NODE_ID>`, repository cwd, and receipt-derived command argv. Reconcile each Shell with `record-shell-readback --role <role> --evidence-file <path>`; the evidence must carry raw public JSON, not hand-authored assertions:

```json
{
  "ownerSnapshot": "<full public node snapshot JSON showing the one owner Workspace>",
  "shellInspection": "<full public boomux shell inspect SHELL --json document>"
}
```

The gate passes this evidence through `resolveShellCreation()`, which proves the single new Shell's identity, its pending status and null Run, the exact cwd and full intended argv, the owner Workspace ID, and the absence of foreign Shells, Launchers, and Agents in the owner Workspace. Then record the complete mapping with `record-workspace-readback --evidence-file <path>`, whose evidence is the raw `workspace inspect <GLOBAL_ID> --json` document. The mapping derives the owner Workspace ID from the three agreeing Shell readbacks and requires it to match the single remote placement; a cross-owner Shell set or missing/changed placement is refused.

After `runner-start`, record the exact runner ownership through `record-runner-readback --evidence-file <path>` (after `mark-attempted --operation-id runner-start`). The evidence must be raw structured data, parsed and validated by the gate, never a self-asserted normalized object:

```json
{
  "unitShow": ["Id=<unit>", "LoadState=loaded", "ActiveState=active", "SubState=running", "MainPID=<positive integer>"],
  "fileStatus": {
    "schema": "omarchestra.remote-execution-node.file-status/v1",
    "socketPath": "<exact socket path>",
    "statePath": "<exact state path>",
    "files": [
      { "label": "socket", "path": "<exact socket path>", "status": "socket present", "exists": true, "kind": "socket", "mode": "0600", "ownerUid": <positive int> },
      { "label": "state", "path": "<exact state path>", "status": "file present", "exists": true, "kind": "file", "mode": "0600", "ownerUid": <positive int> }
    ],
    "spikePathsAbsent": false
  }
}
```

After `present-all`, reconcile every initial running Run ID through `record-shell-run-readback --role <role> --evidence-file <path>` (after `mark-attempted --operation-id present-<role>`). The evidence is the raw public `boomux shell inspect <SHELL_ID> --json` document; the gate validates the receipt Shell/owner mapping and running status, extracts the Run ID with the shared strict normalizer, refuses replacements on repeat, and never accepts a hand-typed Run ID.

The bridge uses Boomux's documented `BOOMUX_SHELL_ID` process environment because the Shell ID is generated by creation. Confirm each hello's resolved Shell ID equals the receipt mapping. No shell name or creation stdout is an identity source. If a weak command outcome is ambiguous, record it with `mark-ambiguous --operation-id <ID> --reason <text>` and stop; an ambiguous receipt blocks every later plan until exactly reconciled.

### 4. Start the exact node-local runner

Authorize `runner-start` through the receipt gate only after the receipt holds the three exact pending Shell mappings (`record-workspace-readback`). Execute the exact `systemd-run --user --unit <receipt-derived unit> --service-type=exec --quiet -- <remote-node> <runner-path> ...` vector printed by the plan. It starts one normal unprivileged runner and no Pi process. Read back the exact user-unit ID, active state, main PID, owner-only socket, and state file, then record that readback with `record-runner-readback`. Do not start/restart/stop the Boomux daemon.

At this point all three Shells are still pending and no Pi process exists. New Shells stay pending until their first `boomux open`; that is why the runner starts before presentation, so the bridges connect on the first open.

### 5. Present all three remote PTYs

Authorize `present-all` after the receipt records the runner mapping; the plan prints, per role, a runtime-env `shell inspect` before, the open, and a `shell inspect` after, preserving the documented non-atomic race classification. The three Shells are pending at this point and no running Run is required or expected before the first open. Execute the three exact public `boomux open <SHELL_ID> --node <EXPECTED_NODE_ID> --workspace <GLOBAL_ID> --title ... --takeover` vectors immediately. This is the only GUI phase.

Inspect each Shell before and after open. Record `atomicExpectedRunGuarantee: false`. A replacement Run is detectable but not prevented by generic public `open`; treat it as unsupported and uncertain. Attachment presence is unavailable unless a public contract supplies it. Each open starts the initial Run: reconcile every initial running Run ID into the receipt with `record-shell-run-readback` after the opens, never before the first presentation.

### 6. Confirm visible identity and assignment behavior

In all three native terminal windows, confirm the visible role, repository, Pi session, and bridge connection. Use the authenticated control proxy with framed requests to obtain the runner snapshot. Confirm:

- exactly three bridge handshakes with distinct Agent Run, Pi session, extension, PID, and Shell identities;
- assignment acknowledgements are `accepted`, and repeating an assignment produces `duplicate` without a second visible turn;
- the runner snapshot and receipt contain the same Team Goal and role mappings;
- the activity feed is structured bridge metadata, not terminal output.

Do not infer completion from a prompt string or rendered ANSI bytes.

### 7. Process tree

Authorize the evidence read. For each exact PID from bridge hello, run the explicit `ps` and `pstree` vectors from the `process-tree` plan. Prove there are exactly three visible Pi host processes, each in its assigned Shell, and no Pi descendant or hidden worker. Record PID, PPID, session, command path, and tree privately.

### 8. Disconnect survival

Authorize the disconnect observation. Close only the local SSH control client and all three local terminal windows through normal window actions. Do not close Boomux Shells, stop the runner unit, stop a daemon, or kill a process.

After the local disconnect, verify through an independent exact SSH inspection that the remote runner unit, owner-only socket/state, three bridge/Pi PIDs, three Shell Runs, and durable Team Goal/assignment state continue. Record any unavailable observation instead of inferring it.

### 9. Direct exact inspection

Run the `inspect-direct` plan. Through the explicit SSH route, inspect each exact remote Shell ID with public Boomux JSON and compare the same Shell Run IDs with the receipt and prior process evidence. A changed or missing Run blocks reconnection claims.

### 10. Reconnect and re-present

Authorize a new control SSH stdio client and run the `reconnect` plan. Confirm the control snapshot includes the same pinned Node, Team Goal, Agent Run IDs, Shell IDs, Shell Run IDs, Pi sessions, extension instances, and PIDs. Request events after the saved cursor.

If the cursor expired or the stream changed, record `gap: true` and the fresh baseline. Do not describe a baseline as continuous replay. After the inspections pass, authorize the receipt-backed `represent-all` (distinct `represent-<role>` receipt operations, printed with pre/post runtime-env inspections) and reconcile each re-presented Run with `record-represent-run-readback --role <role> --evidence-file <raw shell inspect JSON>`; the re-presented Run must be the receipt-owned Run, and a changed Run is refused as the documented unsupported uncertain outcome.

### 11. Manual takeover isolation

In one visible Pi, submit ordinary human text. Confirm structured `human_message_submitted` and `manual_takeover` events, that only that role becomes `manual_takeover`, and that its active assignment becomes `needs_reconciliation`. Confirm Coordinator and Reviewer state does not change. Do not answer an agent-owned prompt through the console or a PTY input path.

### 12. Validation artifact and events

Authorize the harmless validation phase. Execute the exact remote Node command from the `validate` plan, capture only its bounded structured result and status, then fill the plan's `controlFrameTemplate` with the observed exit status, signal, and stream metadata before sending it through the control protocol. Do not send the template unchanged. Confirm the artifact has digests and status but no output body and does not replace Agent Run or Reviewer evidence.

Run the `events` plan from the saved cursor. Confirm strictly ordered durable event sequences, source deduplication, and truthful gap/baseline fields.

### 13. Exact cleanup

Do not proceed unless all prior observations pass. Bind final exact public snapshots (coordinator Workspace snapshot, owner-Node snapshot, per-Shell inspections, and the reconciled pinned Node identity) into a fresh private evidence file and authorize `cleanup` with `--evidence-file <path>`. The plan calls `exactCleanupPlan()` against the durable receipt and that fresh evidence; its resource IDs come from the receipt only, and CLI-supplied Workspace/Shell IDs are ignored. Reconcile the pinned Node alias/ID/target before every destructive operation. Refuse cleanup if any foreign Shell, Launcher, Agent, placement, changed Shell Run, changed registration, missing receipt evidence, or uncertain outcome appears.

Before every destructive command, run `mark-attempted --operation-id <id>` with the exact `operationId` printed on the command record (`cleanup-unit-stop`, `cleanup-remove-files`, `cleanup-shell-close-<role>`, `cleanup-workspace-close`); only one cleanup operation may be attempted at a time, and its specialized confirmation must land before the next is marked. Readbacks require the attempted state and refuse to confirm from a bare intent. Execute only exact receipt-owned actions, interleaving the printed public readback after each destructive step, and **stop on the first unproven or ambiguous outcome** — do not execute any following destructive command; record an unprovable outcome with `mark-ambiguous`, which blocks the receipt until exactly reconciled:

1. stop the exact runner user unit, then read back its exact unit state (`LoadState`, `ActiveState`, `SubState`, `MainPID=0`);
2. remove only the exact receipt socket and state paths through the printed direct-argv `<remote rm> -f -- <socket> <state>` SSH command, then read back both paths' absence through the fixed read-only remote-helper `file-status` action, and confirm with `confirm-cleanup-files`;
3. close each of the three exact Shell IDs in its exact owner Workspace, each immediately followed by `shell inspect <ID> --json` requiring the typed `not_found` error, confirmed per role with `confirm-shell-close --role <role>`;
4. close the one exact global Workspace, then read back `workspace inspect <GLOBAL_ID> --json` with the typed `not_found` error, confirmed with `confirm-workspace-close`; compare the owner-Workspace absence through the bound preflight baseline.

Never use names, prefixes, focus, wildcards, `pkill`, global close, daemon stop, or Node registration operations as cleanup authority.

### 14. Postflight

Run read-only Node registration, configuration, Node snapshot, Workspace, Shell, process, event, and configuration/integration fingerprint reads (both Nodes, with explicit absent-config fingerprints where applicable). Compare every result with the bound preflight, including the configuration and integration fingerprints. Prove the `<NODE_ALIAS>` registration was not renamed, retargeted, forgotten, rekeyed, upgraded, uninstalled, or otherwise changed, and that all pre-existing global and Node-qualified resources remain. Prove no spike unit, process, socket, state file, Workspace, placement, Shell, or bridge remains.

## Evidence status and constraints

Current automated evidence is in [`evidence/automated.txt`](evidence/automated.txt). [`evidence/manual-observations.md`](evidence/manual-observations.md) is intentionally pending and contains the exact human-only fields to record. `evidence/local/` is ignored because receipts, snapshots, remote state, PIDs, session identities, and command output may be sensitive.

Known limits:

- No live SSH, GUI, Pi, systemd, Boomux mutation, or remote validation was run in this Fusion implementation pass.
- Generic Boomux `open` has no atomic expected-Run guard. Pre/post inspection detects replacement but cannot eliminate the race.
- Public Boomux snapshots do not expose attachment presence. The value remains unavailable.
- A reconnect snapshot is not event replay. Cursor expiry is an explicit gap and baseline.
- Bridge assignment deduplication survives runner disconnect while the same visible extension instance survives. Pi restart, extension reload, and full reboot recovery need a separate gate.
- Native Pi/provider/authentication/permission attention outside the verified extension UI hooks remains terminal-owned and unavailable to the runner.
- Validation output is intentionally represented by bounded metadata and hashes, not a transcript.

## Conclusion

The automated contract is **supported with constraints**. It demonstrates a single durable remote-runner authority, exact three-role binding, visible-Pi same-process assignment delivery, owner-only Unix transport, reconnect snapshots, deduplication, ordered bounded events, metadata-only telemetry, takeover isolation, and exact artifact representation without prohibited coupling.

The end-to-end remote claim remains **pending** until the staged human gate proves remote process ownership, native local PTY presentation, SSH/window disconnect survival, exact reattachment, manual takeover, and receipt-only cleanup.

## Disposition

Retain this directory as reproducible evidence and test fixtures. Do not promote its schemas or process supervision directly into Omarchestra production. Revisit durable protocol, socket trust, SSH credential policy, telemetry retention, exact-Run presentation, and reboot recovery before implementation.