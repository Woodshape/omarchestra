# Remote execution Node manual observations

Status: **COMPLETED — SUPPORTED WITH CONSTRAINTS**

Private command output, receipts, process trees, and session evidence remain ignored under `evidence/local/`. This document records bounded observations only; it contains no credentials.

## Operator inputs and authorization

- Date: 2026-09-01
- Operator: `woodshape` (interactive operator)
- Local host/user/UID: `woodshape-arch` / `woodshape` / 1000
- Remote SSH target: `omarchestra@srv1327543.hstgr.cloud`
- Node alias / pinned ID: `hostinger` / `2292a057-5f79-4207-86f6-5758d7ee4420`
- Remote repository: `/srv/omarchestra`
- Receipt ID: `94fede07-4830-48d6-b964-e4aa04a011ef`
- Team Goal ID: `30de2cdb-313f-490b-8480-0533cf6aac26`
- Private preflight: `evidence/local/preflight-results.json`, SHA-256 `0d0f0e8faf7714250781f2f3e4f328ece71b04a5d80eb2b3a6605e0ed9aa0b6a`
- Private sync check: `evidence/local/sync-check-results.json`, SHA-256 `66dce04224c1697afa37426559fcd3b091a03c89cac61114cf3b76a9baab3693`
- [x] Receipt/preflight, read-only checks, resource creation, runner start, presentation, disconnect/reconnect, takeover, validation, cleanup, and postflight each received the required human authorization.

## 1. Preflight and checkout

- [x] Local and remote Boomux 1.8.0/protocol 49 exposed the required public contract.
- [x] The existing local daemon was not started, restarted, stopped, or reconfigured by the spike.
- [x] Alias, SSH target, pinned Node ID, registration revision 1, and tombstone epoch 0 matched exactly.
- [x] The Node was current, online, non-stale, and exposed the required remote PTY and owner-environment capabilities.
- [x] Remote execution used non-root UID/GID 1001; `sudo -n` returned exit 1.
- [x] `/run/user/1001` was owner-only mode 0700.
- [x] Pre-existing global and Node-qualified resource identities were privately captured; the baseline was empty.
- [x] Local and remote configuration/integration fingerprints were captured without reading private Boomux state or mutating configuration.
- [x] The absent remote config was represented as `null`, not as a fabricated digest.
- [x] No pre-existing receipt or exact-prefix collision existed.
- [x] All required spike files were regular, non-symlink files beneath the explicit remote repository root; traversal was refused.
- [x] The initial sync check performed no repository, dependency, credential, or provider mutation. Later reviewed commits were synchronized separately for live bug fixes.
- Preflight evidence: `evidence/local/bound-preflight.json`, `preflight-results.json`, `preflight-remote-results.json`
- Sync evidence: `evidence/local/sync-check-results.json`
- Uncertainty: none at the preflight boundary.

## 2. Workspace, Shell, and runner ownership

- [x] One new global Workspace was resolved from raw public before/after JSON.
- Global Workspace: `f06c086d-6af9-4be3-a934-c8305ec52387`
- Owner Workspace: `114c0192-1b9c-45fd-8c0d-45ffed75309f`
- Placement: pinned Node `2292a057-5f79-4207-86f6-5758d7ee4420`, state `active`
- [x] Exactly three pending role Shells were resolved from owner snapshots and exact Shell inspections.
- Coordinator Shell / initial Run: `5b40a766-1f88-47dc-a2fa-58acb58de443` / `427ab04b-4597-472b-975e-1cb0a182767b`
- Builder Shell / initial Run: `79a9a17d-e392-4909-9fc8-68147ec45645` / `f3f271e7-e692-4ca4-b9cf-f79d224b3c62`
- Reviewer Shell / initial Run: `e496f80a-09b4-4262-842a-57738c8fa1e0` / `bd3b0b61-c57f-4ae0-8a38-9eefe769c9aa`
- [x] All intents were durable before mutation plans printed, used receipt-derived identities, and were reconciled from raw public evidence.
- [x] `mark-attempted` and the one-attempt-at-a-time rule guarded creation and initial presentation.
- [x] The three Shell readbacks agreed on one owner Workspace and one active placement; no foreign Shell, Launcher, Agent, or placement appeared.
- [x] Bridge `BOOMUX_SHELL_ID` values matched the receipt mappings.
- Runner unit: `omarchestra-remote-spike-94fede07-4830-48d6-b964-e4aa04a011ef.service`
- Runner PID: `3505520`
- Socket: `/run/user/1001/omarchestra-remote-spike-94fede07-4830-48d6-b964-e4aa04a011ef.sock`, mode 0600
- State: `/home/omarchestra/.local/state/omarchestra/omarchestra-remote-spike-94fede07-4830-48d6-b964-e4aa04a011ef.state.json`, mode 0600
- [x] Runner evidence used raw `systemctl --user show` and exact owner-path facts; normalized self-assertions were not accepted.
- Evidence: `evidence/local/live.receipt.json` and the private creation/readback files.

## 3. Native presentation and visible identity

- [x] All three exact remote PTYs opened immediately in native local Ghostty/Hyprland windows and were visibly tiled.
- [x] No terminal output was parsed as identity or telemetry.
- [x] Initial and re-presentation inspections observed the same receipt-owned Run IDs.
- [x] The generic-open limitation was recorded as `atomicExpectedRunGuarantee: false`.
- Coordinator PID / Pi session / extension: `3514201` / `01a0579b-486d-75af-8ed6-c5b7d99fbb95` / `…-coordinator`
- Builder PID / Pi session / extension: `3518442` / `01a0579c-633e-7e63-bc6e-b50911a1dc86` / `…-builder`
- Reviewer PID / Pi session / extension: `3518923` / `01a0579c-7b21-7339-b22d-ff6d47b06bdb` / `…-reviewer`
- Attachment-state observability: unavailable through the generic public contract.
- [ ] **Role labels were not visible in the Pi TUIs.** Builder could only be identified from its unique prior assignment content. This is a product-visible failed criterion and a classification constraint.
- Screenshot: private clipboard capture referenced in `evidence/local/` observations.

## 4. Bridge, assignment, and process behavior

- [x] Exactly three bridge handshakes were accepted with unique receipt-bound Agent Run, Shell, Pi session, extension, PID, and role identities.
- [x] The managed Builder assignment was acknowledged `accepted` and settled in the visible Pi.
- [x] Repeating the identical assignment returned `duplicate`, `sent: false`, and created no second visible turn.
- [x] Runner snapshots preserved all three mappings and durable cursor state.
- [ ] A live `busy` rejection was not separately exercised.
- [x] Exact `ps`/`pstree` evidence showed each visible Pi host and no hidden Pi child, JSON/RPC worker, or second agent process.
- [x] The runner was a separate normal Node-local process.
- Evidence: `evidence/local/assignment-builder-*.json`, `process-*-results.json`, and control snapshots.

## 5. Disconnect, reconnect, and re-presentation

- [x] The control client and all three local terminal windows were closed without closing any Boomux Shell, stopping the daemon, or mutating Node registration.
- [x] Runner, bridge, Pi PID/session, exact Shell Run, Team Goal, assignment, artifact, and cursor state survived.
- [x] Direct SSH inspection returned the same three Run IDs.
- [x] A new authenticated control client returned the same pinned Node and Team Goal.
- [x] All three PTYs were re-presented with unchanged Runs, PIDs, Pi sessions, and bridge identities.
- [x] Events were ordered; no cursor expiry or stream replacement occurred.
- Cursor before/after reconnect: `runner-94fede07-4830-48d6-b964-e4aa04a011ef:29`
- Evidence: `evidence/local/disconnect-*.json`, `reconnect-control-snapshot.json`, `represent-*.json`

## 6. Manual takeover isolation

- [x] The operator submitted `Manual takeover check` through the visible Builder Pi, not through PTY injection or the control console.
- [x] Builder emitted `human_message_submitted` and `manual_takeover`.
- [x] Only Builder entered `manual_takeover`.
- [x] Builder assignment `human-gate-builder-assignment-1` entered `needs_reconciliation`.
- [x] Coordinator and Reviewer remained `managed` and unchanged.
- Evidence: `evidence/local/manual-takeover-reconcile-snapshot.json`, `manual-takeover-reconcile-events.json`

## 7. Validation and events

- [x] The harmless remote Node command completed with exact argv, exit 0, signal null, stdout `2\n`, and empty stderr.
- [x] Artifact `human-gate-validation-1` durably recorded pass status plus byte/character/line counts and SHA-256 digests.
- [x] No stdout/stderr body entered runner state.
- [x] `validation_recorded` appeared at runner sequence 42; bounded event pages remained strictly ordered.
- [x] The validation artifact was not treated as Agent Run or semantic Reviewer evidence.
- [ ] Source-event duplicate rejection was covered by fake-only automation but was not independently forced during the live gate.
- Live finding: `record_validation` originally required newline-bearing output while the control protocol forbade it. Commit `200be13` changed the contract to precomputed stream metadata only. To avoid restarting the active old runner, this live artifact used its validated generic `record_artifact` operation.
- Evidence: `evidence/local/validation-*.json`

## 8. Exact cleanup

- [x] Fresh registration, global Workspace, owner snapshot, and per-Shell evidence passed `exactCleanupPlan()` before cleanup.
- [x] Runner unit stop was confirmed as inactive/dead with MainPID 0.
- [x] Exact socket and state paths were removed and confirmed absent.
- [x] Exactly the three receipt-owned Shells were closed and returned typed `not_found` with explicit owner-Workspace context.
- [x] Exactly the receipt-owned global Workspace was closed and returned typed `not_found`.
- [x] Specialized raw-evidence confirmations recorded every successful destructive result; no name, prefix, focus, wildcard, broad process action, daemon lifecycle action, or registration mutation authorized cleanup.
- [x] No foreign resource, additional placement, or changed Shell Run appeared in the fresh pre-cleanup evidence.
- [ ] The first generated Shell-close/readback pair was not live-correct: it addressed the remote owner Workspace through local Boomux, then omitted explicit owner context during absence inspection.
- Recovery: cleanup stopped immediately. The failed local close was proven to be a no-op by a fresh remote inspection of the unchanged Coordinator Shell/Run. Shell close/inspect was corrected to the receipt-bound remote Boomux environment; explicit owner context then produced typed `not_found`. Builder and Reviewer used the corrected route. Regression tests now require this routing.
- Evidence: `evidence/local/pre-cleanup-exact-evidence.json`, `cleanup-*.json`, `live.receipt.json`
- Uncertainty: none remained after exact no-op reconciliation and specialized confirmations.

## 9. Postflight and conclusion

- [x] Alias, pinned Node ID, SSH target, registration revision 1, and tombstone epoch 0 were unchanged.
- [x] Local/remote Boomux configuration and integrations were preserved. Local integration status differed only in executable path presentation for two hosts; the catalog and all other structured status fields were unchanged.
- [x] The empty pre-existing global and Node-qualified resource baselines were preserved.
- [x] The exact runner unit/PID, socket, state, Workspace, placement, Shells, and bridges were absent.
- [x] Node registration, Boomux/Pi installation, credentials, checkout, and unrelated resources remained.
- Postflight evidence: `evidence/local/postflight-results.json`, `postflight-pid-result.json`, `postflight-verified.json`

Conclusion: **SUPPORTED WITH CONSTRAINTS**

Reason: one remote Node can host three persistent, visible, interactive Pi processes under an unprivileged identity while local native terminals present their exact Boomux PTYs. Managed assignment, deduplication, durable state, disconnect/reconnect, same-Run re-presentation, structured telemetry, takeover isolation, validation, and exact cleanup were demonstrated. The missing visible role labels prevent an unconstrained result.

Residual risks and required production work:

1. Make role and managed/waiting/takeover state visibly persistent in every native terminal.
2. Preserve the documented generic `boomux open` process-exit/replacement race constraint until a public atomic expected-Run guard exists.
3. Use receipt-bound remote owner context for all owner-Shell cleanup and inspection; keep the live regression test.
4. Use metadata-only validation control requests from commit `200be13`; never send output bodies.
5. Normalize integration fingerprints over stable public fields rather than executable-path presentation.
6. Exercise live busy rejection and source-event replay/deduplication in a later production acceptance gate.
