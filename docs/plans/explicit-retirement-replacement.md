# Explicit retirement and replacement

Status: **User-approved policy; retirement/replacement implemented; terminal-history purge implemented and targeted validation passing.**

Authority: [MVP design](../design/mvp.md#explicit-retirement-and-replacement), [terminal behavior](../design/pi-terminal-behavior.md#explicit-retirement-and-replacement), [connection-bound identity ADR](../adr/0003-use-connection-bound-observer-capabilities.md), and [terminal-history purge ADR](../adr/0004-explicit-purge-of-terminal-retired-history.md).

## User flow

1. Select the disconnected/exited Run and explicitly confirm **Retire Agent Run**, naming its Team Goal and Role and warning that retirement does not stop its process/tools.
2. Commit irreversible retirement and Role release; retain the historical card as retired, distinct from disconnected. Do not automatically retire on lease expiry.
3. Optionally select **Delete Retired History** on a terminal retired card. The action is explicit and irreversible, deletes the selected Omarchestra Run/retirement history and card while retaining only a minimal non-presented identity fence, is blocked while a replacement descendant remains, and never deletes Pi history, session files, processes, tools, or external artifacts. Purge newest-to-oldest preserves predecessor linkage while retained.
4. User starts visible Pi themselves, optionally resuming saved history. No automatic Pi launch, history inspection, or session-file identity correlation.
5. Select that Unassigned Pi and the vacant Role, then use the existing exact confirmed/acknowledged Adoption flow. Persist a predecessor link and a new Agent Run identity.
6. Keep uncertain old work blocked for reconciliation. This bounded prototype dispatches zero Assignments.

## Bounded implementation contract

- Extend the existing single runner/store authority, not a parallel registry or UI-owned state machine.
- Persist retirement and Role vacancy atomically with expected Run/revision guards. Preserve original Adoption commitments, takeover records, and binding tombstones while retained; only the separately confirmed terminal purge may delete those selected historical records. Historical commitments must no longer imply current Role occupancy.
- Persist a Role vacancy generation/predecessor so stale replacements cannot claim a subsequently occupied or re-retired Role. Check it again in the synchronous Adoption transaction. Explicit purge preserves a monotonic vacancy-generation high-water mark and a minimal exact-binding fence.
- Make exact repeated retirement idempotent; reject conflicting or stale intents. If reconnect/readiness wins the race before retirement, reject a disconnected-only retirement until the operator refreshes and reconfirms an eligible state.
- Reject retired recovery proofs, readiness/lease renewal, late acknowledgements, takeover updates, and authority-bearing results before mutation. A retired identity cannot bypass fencing by registering another observed ID.
- Successful replacement never mutates the predecessor's original commitment. Failed acknowledgement, disconnect, expiry, or transaction failure cannot resurrect it or leave partial replacement state.
- Reconstruct retirement, vacancy, and predecessor lineage from SQLite after gateway restart. Fence before processing any new transport frame.
- Retirement revokes orchestration authority only. Do not claim OS-enforced prevention of surviving tool writes. No new Assignment delivery, Return-to-team workflow, or automatic process termination in this slice. History deletion exists only through the separately confirmed terminal purge contract above.
- Use additive versioned Companion capability/assets; preserve accepted 0.2.0/0.3.0/0.4.0 releases. QML only projects committed state and sends exact revision-bound intents. An unreachable Pi cannot be promised an immediately updated footer.
- Preserve owner-only transport, exact cleanup/resume ownership, local ordinary-terminal Adoption restrictions, privacy policy, and accepted best-effort R1 activity classification.

## Acceptance gate

Compose the real presentation adapter, framed transport, Pi extension adapter, runner, and disposable SQLite store through injected hosts/transports. Cover:

- disconnected/exited eligibility; connected, wrong-Node, stale revision and wrong-Run rejection;
- duplicate retirement, retirement/reconnect races, late old ACK/readiness/recovery, and observed-ID bypass;
- exactly one retirement/Role release and one new Adoption with predecessor linkage;
- fresh confirmation and exact replacement ACK; competing replacements and stale vacancy generations;
- failure before/after each durable transition, restart reconstruction, durable rejection of the retired identity, terminal purge, blocked predecessor purge, and stale-generation rejection after purge;
- replacement after manual conversation resume represented only as a fresh Pi identity, with no conversation access;
- historical card plus new Role occupant, stale UI rejection, zero queued/dispatched Assignments, exact ephemeral cleanup, unchanged installed assets.

Run affected existing gates and static QML/privacy/launcher audits. Obtain independent review before marking engineering complete. A passing helper-only suite is insufficient.

Human validation is separate and requires explicit installation/live consent: adopt, disconnect, retire, manually resume Pi, adopt the new process into the same Role, verify the old Run remains retired and no automatic work starts, then retire the replacement and purge terminal history newest-to-oldest. Confirm the cards remain absent after close/reopen and the visible Pi sessions/processes are unchanged. Existing normal Adoption PASS is not replacement evidence. Gateway-crash recovery remains separately untested by the human gate.
