# Remote execution Node manual observations

Status: **PENDING HUMAN GATE**

No live SSH, Boomux mutation, systemd service, Pi process, native terminal, GUI, or remote validation was run during this implementation pass. Do not mark a row passed from automated fake evidence.

Use only ignored `evidence/local/` files for receipts, preflight snapshots, remote state copies, process trees, session identifiers, or command output. Replace every `<...>` value with an observed value. Do not record credentials.

## Operator inputs and authorization

- Date/time:
- Operator:
- Local host/user/UID:
- Remote SSH target from preflight:
- Node alias from preflight:
- Expected pinned Node ID from preflight:
- Remote repository:
- Receipt ID:
- Team Goal ID:
- Private preflight path and SHA-256:
- Remote sync-check path and SHA-256:
- Authorization record for each phase:
  - [ ] receipt initialized and preflight bound (record intent, mapping, readback, and confirmation steps per phase)
  - [ ] preflight read-only
  - [ ] sync-check read-only
  - [ ] Workspace/Shell creation
  - [ ] runner start
  - [ ] native presentation
  - [ ] disconnect
  - [ ] reconnect
  - [ ] validation
  - [ ] cleanup
  - [ ] postflight

## 1. Preflight

- [ ] Local Boomux CLI/protocol matches the required public contract.
- [ ] Local daemon was already running. It was not started, restarted, or stopped by this spike.
- [ ] Alias, SSH target, expected Node ID, registration revision, and tombstone epoch matched exactly.
- [ ] Combined snapshot returned exactly one current, online, non-stale remote projection.
- [ ] Remote protocol and required remote-PTY/owner-environment capabilities were present.
- [ ] Remote UID was non-root.
- [ ] Noninteractive sudo probe failed as required.
- [ ] Runtime directory was owned by the execution UID and mode 0700.
- [ ] Existing global Workspace and Node-qualified resource identities were privately captured.
- [ ] Local Boomux config path/validation results and integration list/status fingerprints were privately captured.
- [ ] Remote Boomux config path/validation results and integration list/status fingerprints were privately captured.
- [ ] Explicit absent-config fingerprints were recorded as null where a config path does not exist.
- [ ] No private Boomux state was read and no configuration or integration was mutated on either Node.
- [ ] No pre-existing receipt or exact prefix collision was found.
- [ ] The owner-only receipt was initialized (`receipt-init`) and the private preflight was bound (`preflight-bind`).
- Preflight evidence file:
- Preflight cursor/baseline:
- Preflight failure or uncertainty:

## 2. Checkout synchronization check

- [ ] Remote checkout path matched the explicit input.
- [ ] Required spike files were present as regular non-symlink files beneath `spikes/remote-execution-node/` inside the explicit repository root (never at the repository top level), with no symlink, irregular file, or traversal.
- [ ] Reported file digests were captured privately.
- [ ] No repository file, dependency, credential, or provider configuration was copied or changed.
- Sync evidence file:
- Missing or changed file:

## 3. Workspace, Shell, and runner ownership

- [ ] One new global Workspace was resolved from JSON readback.
- Global Workspace ID:
- Owner Workspace ID:
- Placement Node ID:
- Placement state:
- [ ] Exactly three role Shells were resolved from public JSON readback.
- [ ] The `workspace-create` intent was recorded durably before its plan printed; the plan's Boomux binary and Workspace name came from the receipt, not CLI flags.
- [ ] Every mutating command record carried its exact receipt operationId; `mark-attempted` was run immediately before each execution, only one operation was attempted at a time (attempt_in_progress enforced), and every readback required the attempted state.
- [ ] The receipt-bound `preflight-remote` phase (post-bind, runtime-env reads) ran before any mutation; its raw remote capability/daemon JSON plus the remote configuration/integration fingerprints were recorded with `record-remote-preflight`, which is the sole authority for the remote fingerprints compared at postflight.
- [ ] The bound preflight kept local fingerprints only, plus the strictly validated execution identity (UID, derived runtime directory, source, 0700 mode, and the nonzero raw sudo -n probe exit; a recorded 0 would have been refused as sudo-capable).
- [ ] `mark-attempted --operation-id <id>` was run immediately before executing every mutating command; all readback confirmations required the attempted state, and a bare intended intent was refused.
- [ ] The global Workspace ID was resolved only from raw public `workspace list` before/after evidence through `record-workspace-creation` (`resolveWorkspaceCreation()`); no owner Workspace ID was guessed at this step.
- [ ] `shells-create` used only the confirmed receipt-resolved global Workspace ID, never a CLI-supplied ID.
- Coordinator Shell ID / Shell Run ID (the Shell is pending; the Run ID stays null until the first presentation):
- Builder Shell ID / Shell Run ID:
- Reviewer Shell ID / Shell Run ID:
- [ ] Each exact readback was recorded with `record-shell-readback` using raw public `node snapshot` plus `shell inspect` JSON resolved by `resolveShellCreation()` (identity, pending status, cwd, full argv, owner Workspace ID, no foreign resources).
- [ ] The complete mapping was recorded with `record-workspace-readback`; the owner Workspace ID was derived from the three agreeing Shell readbacks and matched the single active remote placement in the raw `workspace inspect` evidence.
- [ ] Each bridge hello Shell ID matched Boomux's `BOOMUX_SHELL_ID` and the receipt.
- [ ] No foreign Shell, Launcher, Agent, or additional placement appeared.
- [ ] The runner start was authorized only through the receipt gate after the three pending Shell mappings were recorded.
- [ ] The runner readback evidence was raw structured `systemctl --user show` lines plus socket/state path facts (path, kind, owner UID, 0600 mode), parsed by the gate; no self-asserted normalized object was accepted.
- Runner unit:
- Runner PID:
- Runner socket path and mode:
- Runner state path and mode:
- [ ] Runner state was owned by the remote unprivileged user.
- Creation/runner evidence file:
- Creation uncertainty:

## 4. Native presentation and visible identity

- [ ] `present-all` was authorized only after the receipt recorded the runner mapping; all three Shells were pending and no running Run was required before the first open.
- [ ] All three exact remote Shells were opened in local native terminal windows.
- [ ] Windows were visibly tiled by the existing desktop layer.
- [ ] No terminal output was parsed as identity or telemetry.
- [ ] Generic-open limitation was recorded: `atomicExpectedRunGuarantee: false`.
- [ ] Pre/post inspection found no Run replacement.
- [ ] Every initial running Run ID was reconciled with `record-shell-run-readback` from the raw public `shell inspect --json` evidence (mapping + running status validated; Run ID extracted by the normalizer, never typed).
- Coordinator visible PID / Pi session / extension instance:
- Builder visible PID / Pi session / extension instance:
- Reviewer visible PID / Pi session / extension instance:
- Attachment state:
  - `unavailable` unless a public contract supplied it.
- Screenshot or private inspection paths:

## 5. Bridge and assignment behavior

- [ ] Exactly three bridge handshakes were accepted.
- [ ] Agent Run IDs were unique and matched the receipt.
- [ ] Pi session IDs, extension IDs, PIDs, Shell IDs, and roles matched the receipt.
- [ ] Managed assignments used `accepted` acknowledgements.
- [ ] Repeating an assignment returned `duplicate` and caused no second visible turn.
- [ ] A busy visible session returned `busy` without replacement.
- [ ] Runner snapshot preserved all three role mappings.
- Bridge NDJSON evidence file:
- Assignment IDs and acknowledgement statuses:
- Event cursor:

## 6. Process-tree evidence

- [ ] Each exact PID was checked with `ps` and `pstree` or the documented fallback.
- [ ] Exactly three visible Pi host processes were present.
- [ ] No Pi descendant, RPC worker, JSON-mode worker, or other hidden agent was present.
- [ ] Runner was a separate normal node-local process.
- Private process-tree path:
- Unexpected process or uncertainty:

## 7. Disconnect survival

- [ ] The local control SSH client was closed normally.
- [ ] All local native terminal windows were closed normally.
- [ ] No Boomux Shell close, daemon stop, broad process action, or remote registration action was used.
- [ ] Remote runner unit remained active or its exact state was truthfully recorded.
- [ ] Remote bridge/Pi PIDs remained alive.
- [ ] All three exact Shell Runs remained unchanged.
- [ ] Team Goal, assignments, artifacts, and runner state remained durable.
- Disconnect timestamp:
- Direct inspection evidence:
- Unavailable observation or gap:

## 8. Direct inspection and reconnect

- [ ] Exact SSH direct Shell inspection returned the same three Shell Run IDs.
- [ ] A new authenticated SSH stdio control client connected.
- [ ] Reconnect snapshot returned the same pinned Node and Team Goal.
- [ ] Agent Run, Shell, Shell Run, Pi session, extension, and PID identities were unchanged.
- [ ] Events after the saved cursor were ordered.
- [ ] Any expired cursor or stream replacement was reported as an explicit gap with a fresh baseline.
- [ ] All three exact remote PTYs were re-presented without a Run replacement.
- Reconnect evidence file:
- Old cursor:
- New cursor:
- Gap/baseline details:

## 9. Manual takeover isolation

- [ ] Ordinary human text was submitted in exactly one visible Pi.
- [ ] `human_message_submitted` and `manual_takeover` were recorded.
- Role taken over:
- [ ] Only that role entered `manual_takeover`.
- [ ] Its active assignment entered `needs_reconciliation`.
- [ ] Coordinator and Reviewer state remained unchanged when Builder was taken over, or the corresponding sibling comparison was recorded.
- [ ] No PTY input injection was used.
- Takeover evidence file:

## 10. Validation and events

- [ ] The documented harmless remote Node command ran with an exact argv.
- [ ] Its structured result, exit status, and bounded digest were recorded as a validation artifact.
- [ ] The artifact did not contain an output body.
- [ ] The artifact was not used as a substitute for Agent Run or Reviewer evidence.
- [ ] Event pages were bounded and strictly ordered.
- [ ] Source-event duplicates were ignored.
- Validation artifact path/ID:
- Event evidence path:
- Validation or cursor uncertainty:

## 11. Exact cleanup

- [ ] Final exact Node registration and public snapshots matched the receipt/preflight.
- [ ] `mark-attempted --operation-id <cleanup-*>` was run immediately before every destructive cleanup command using the exact operationId of each command record; the sequence stopped on the first unproven or ambiguous outcome (`attempt_in_progress` refused out-of-order attempts).
- [ ] The printed cleanup plan interleaved the exact readbacks: unit show after stop, `file-status` after the exact direct-argv `rm -f -- <socket> <state>`, per-Shell typed `not_found`, and the Workspace typed `not_found`.
- [ ] Specialized cleanup confirmations ran from the raw interleaved readbacks (confirm-cleanup-unit-stop, confirm-cleanup-files, confirm-shell-close --role, confirm-workspace-close); no bare `exactReadback:true` file confirmed anything.
- [ ] Each destructive step was followed by its exact public readback (unit state, `file-status` absence, per-Shell `not_found`, Workspace `not_found`), and each was recorded.
- [ ] `cleanup` consumed fresh exact evidence (`--evidence-file`) through receipt-backed `exactCleanupPlan()`; CLI-supplied Workspace/Shell IDs were ignored.
- [ ] No foreign resource or additional placement was present.
- [ ] No Shell Run changed.
- [ ] Exact runner unit stopped and unit/PID absence was read back.
- [ ] Exact socket and state paths were absent after owner-local exact-path cleanup.
- [ ] Exactly three receipt-owned Shell IDs were closed and absent.
- [ ] Exactly one receipt-owned global Workspace was closed and absent.
- [ ] No name, prefix, focus, wildcard, global close, daemon stop, or registration mutation authorized cleanup.
- Cleanup evidence path:
- Cleanup refusal/uncertainty:

## 12. Postflight and conclusion

- [ ] Node alias, pinned Node ID, SSH target, registration revision, and tombstone epoch were unchanged.
- [ ] Boomux configuration and integrations were unchanged.
- [ ] Every pre-existing global Workspace remained.
- [ ] Every pre-existing Node-qualified resource remained.
- [ ] No spike process, unit, socket, state, Workspace, placement, Shell, or bridge remained.
- Postflight evidence path:

Conclusion: **PENDING** / **SUPPORTED WITH CONSTRAINTS** / **UNSUPPORTED**

Reason:

Residual risks or questions:
