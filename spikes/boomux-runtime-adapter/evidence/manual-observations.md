# Boomux runtime adapter manual observations

Status: **PASS — supported with constraints**  
Date: 2026-08-30

## Environment

- Operator: repository owner
- Omarchestra baseline commit: `9c5efef`
- Boomux: `1.8.0`
- Capability schema: `boomux.cli/v1`
- Daemon protocol: `49`
- Desktop: Omarchy on Hyprland
- Presentation: native terminals selected through Boomux/`xdg-terminal-exec`
- Local Node identity: captured privately and unchanged through cleanup
- Receipt and pre/postflight snapshots: retained under ignored `evidence/local/`

## Preflight safety

**Passed.** A read-only preflight ran before mutation and captured the public Workspace, Shell, Agent, integration, configuration, event, and Node projections. The ownership receipt was bound to that exact preflight, timestamp, and local Node identity. Configuration was present and its SHA-256 remained unchanged after cleanup.

No setup, update, uninstall, integration mutation, remote mutation, web, daemon lifecycle, GUI, or cleanup command ran during preflight.

## Created resources

**Passed.** Live creation produced exactly one uniquely prefixed Workspace and three role Shells. Boomux identifiers remained in the ignored private receipt; the public adapter returned only opaque references:

| Role | Opaque terminal reference | Initial state |
| --- | --- | --- |
| Coordinator | `tsr_1883e516-8346-4f04-8a99-40d5b6d9487c` | `pending` |
| Builder | `tsr_dffb602f-ba87-4455-b896-07996bb2140b` | `pending` |
| Reviewer | `tsr_b9d438ad-6bd7-417b-a876-bd1fbe010696` | `pending` |

No pre-existing resource was renamed, adopted, opened, or changed.

## Initial native presentation

**Passed by human observation and direct identity probes.** `present-all` opened exactly three distinguishable native terminals, and Hyprland tiled them. Each displayed its expected role, Shell identity, Boomux Run identity, and probe PID. The screenshot is retained privately as `evidence/local/initial-windows.png`; rendered terminal output was not used by the adapter as identity evidence.

| Role | State | Opaque Run reference | Probe PID |
| --- | --- | --- | ---: |
| Coordinator | `running` | `trr_0171be8b-c545-4713-833b-9c6f222c8893` | 164654 |
| Builder | `running` | `trr_12b2563b-30c0-483c-a57e-492140f0d700` | 164746 |
| Reviewer | `running` | `trr_1788f2cc-9333-4f55-803d-8ee2687cd95c` | 164825 |

All Runs were generation 1.

## Window detach and process survival

**Passed.** The operator closed only the Builder terminal emulator window through its normal window-close action. No Boomux close command was used.

Read-only inspection and direct probe evidence after closure showed:

- Builder remained `running` with the same opaque Run and PID `164746`.
- Coordinator remained `running` with the same opaque Run and PID `164654`.
- Reviewer remained `running` with the same opaque Run and PID `164825`.
- The other two windows remained unaffected.

This proves that native window closure detached presentation without ending or replacing any spike process.

## Exact surviving-process re-presentation

**Passed under the tested no-concurrent-exit condition.** The operator invoked `present(reference)` only for Builder. Its native terminal reappeared and visibly showed the same role and PID `164746`.

Post-reopen inspection and direct probes confirmed the same Shell mapping, same opaque generation-1 Run reference, and same PID for all three roles. No replacement Run was created and sibling processes remained unchanged.

This observation does not remove the documented generic-open race: Boomux 1.8.0 has no public expected-Run guard, so a process that exits between pre-inspection and `open` could be restarted before the adapter detects the changed Run afterward.

## Snapshot and event evidence

**Passed.** The adapter consumed ordered lifecycle events from the preflight cursor through cursor `2cfa6b6a-24c5-461d-b220-7440fe394364:146` before cleanup.

Observed receipt-owned events included:

- one `workspace_created`;
- three `shell_created`;
- three `run_started` with exact receipt-owned Run mappings;
- output revisions without treating them as lifecycle transitions.

Window closure did not produce a process-exit event. Unrelated event IDs were filtered while the returned cursor still advanced.

## Exact-ID cleanup and postflight

**Passed.** Cleanup re-inspected receipt ownership, closed the three exact recorded Shell IDs, verified their absence, then closed the exact recorded Workspace. All three opaque references subsequently inspected as `closed`.

A new read-only postflight recorded cursor `2cfa6b6a-24c5-461d-b220-7440fe394364:150` and confirmed:

- the same local Node identity;
- the same configuration SHA-256;
- no missing pre-existing Node/resource identity;
- no spike-owned exact ID remained;
- no occurrence of the unique spike prefix remained.

No name-, prefix-, focus-, wildcard-, or global cleanup operation was used.

## Gate result

Result: **PASS**

The human gate proves native tiling, role identity, window-detach survival, same-Run/same-PID re-presentation, sibling isolation, ordered lifecycle observation, and exact-ID cleanup for the tested Boomux 1.8.0 environment.

Overall classification: **supported with constraints** because generic `boomux open` lacks an atomic public expected-Run guard, attachment state is unavailable in snapshots, some mutation/presentation commands are non-JSON version-pinned dependencies, and bounded event cursors require snapshot reconciliation after expiry.
