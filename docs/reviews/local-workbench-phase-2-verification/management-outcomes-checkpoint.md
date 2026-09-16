# S2 checkpoint — retirement/purge outcomes and no-send Adoption commands

Status: **Bounded outcome repair passes. S2 and full Adoption remain incomplete.** Snapshot `b3fefd6` preserves the preceding database-command work. This checkpoint is direct implementation and source self-review, not independent agent review or live evidence.

## Retirement/purge protocol

Store schema **4** adds `management_operations`; the independent fence schema remains **2**. Older development stores are refused without migration or overwrite.

1. Before preparation, validate retained target and operation eligibility: retirement requires disconnection (or the already-retired same binding); purge requires a terminal retired leaf. Freeze the target's Project, Role, binding digest, predecessor, control epoch, generation and available Goal/incarnation identity. Validate command identifiers and target shape/bounds.
2. Persist the exact intent ID, originating session, payload hash, command kind, Run ID and frozen target in the store. This is durable authorization, not success feedback.
3. Apply S1's write-ahead ledger operation. Retirement fences identity then releases membership/records retirement. Purge records irreversible intent, deletes permitted history while retaining effect uncertainty, then compacts the fence. These independent database writes are **not atomic**.
4. In one store transaction, append the final revision/event, persist the normalized acknowledged receipt and remove the pending operation. A purge completion event is generic: it does not recreate Run history.
5. Only then update public authority counters and return the outcome. Post-commit cleanup failures cannot be converted into rejected receipts.

Any failure after preparation latches the active owner unavailable. Reopening the exact owned root reconciles pending operations against the latest independent ledger **before returning the runner for admission**. Recovery is idempotent, does not consume another vacancy generation, never reconstructs a purged Run, and refuses changed target/ledger/journal evidence. An operation interrupted before the first fence write can complete only from its retained explicit authorization, not from observation or inferred identity.

The old receipt/effect split in the authority retirement/purge route is removed. Same-ID replay returns the original saved outcome without another mutation. No release/purge transport send is needed to revoke a disconnected Run; the retained fence is authoritative, not remote delivery success.

## Adoption-side database commands

`request_adoption` and `take_control` now participate in the same outer effect/event/revision/receipt transaction as the existing database-owned commands. They perform no external frame send. Failure restores the manager's transient proposal/pending/exchange state and the authority's observation cache as well as SQL effects. Retry cannot leave a ghost proposal or consume an observation without a receipt.

Take control additionally refuses proposed/authorized/acknowledged-but-uncommitted bindings: ordinary Pi observation or a proposal cannot acquire managed control authority.

**Authorization delivery remains outstanding.** `authorize_adoption` sends an external frame and is not wrapped as a database-only command. The committed-binding delivery path also still needs durable post-commit delivery tracking, safe unknown-delivery handling and explicit recovery. No send is described as rolled back by SQL. The legacy manager's Project-only occupancy and missing real incarnation/bridge composition still require S4/S5.

## Failure evidence

`test/phase-2-retirement-outcomes.test.ts` initially failed the interruption/outcome cases against the preceding authority route (`/tmp/p2-retirement-outcomes-red.log`). It now exercises:

- interruption after command preparation, each existing ledger/store boundary, the durable effect, receipt insertion inside the final transaction, and final commit before caller feedback;
- restart completion to one acknowledged receipt, one revision and stable vacancy generation, followed by replay and another restart;
- actual receipt-write failure, connected-retirement refusal, leaf-purge refusal, frozen-target or journal drift, and post-commit cleanup failure;
- membership release and retained writer uncertainty, without recreating purged history.

`test/phase-2-adoption-outcomes.test.ts` adds receipt-failure rollback for request-Adoption and Take control, exact observation/proposal restoration, idempotent epoch handling, and refusal of control before Adoption commitment. Its transport is an object-event fake; it is not framed real-bridge evidence.

Reproduction:

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-retirement-outcomes.test.ts \
  packages/local-workbench-v1/test/phase-2-adoption-outcomes.test.ts
```

The Phase 2 gate includes both suites. The persistence foundation gate also covers startup command reconciliation. Full package tests and Phase 1 presentation checks pass; existing five runtime TODOs remain. Full Phase 2 still returns **1/BLOCKED** after its implemented subset passes. Logs: `/tmp/p2-management-outcomes-{green,all,phase1,gate}.log`, `/tmp/p2-retirement-outcomes-{red,green}.log`.

No installation, live Pi/provider, desktop mutation, Assignment/check execution or prototype/spike modification occurred. Only the preceding work was committed as requested; this checkpoint's changes remain uncommitted. Nothing was pushed.

## Remaining S2 work at this checkpoint

The subsequent [source/outcome checkpoint](source-outcomes-checkpoint.md) implements snapshot-before-feedback, source queries/heartbeat/reconnect and truthful unavailable presentation/recovery results. Durable bridge delivery and full authority-envelope validation remain outstanding.


- Durable authorization/binding delivery tracking: commit effect and delivery intent together; send only afterward on the exact connection; preserve unknown delivery instead of retrying or rejecting a committed command.
- Atomic acknowledgement-to-membership integration and challenged lost-delivery recovery, using S1 identity/membership tables and the S4 real bridge. The current no-send command repair does not close these S5 prerequisites.
- Full closed intent-envelope/target validation and explicit outcome queries.
- Snapshot-before-feedback, authoritative heartbeat, resnapshot, exact close/reconnect and truthful unavailable presentation/recovery outcomes.

Do not declare F7/F13, S2, full Adoption or Phase 2 complete from this checkpoint. In particular, SQL success is not proof of either Pi delivery or a displayed success state.
