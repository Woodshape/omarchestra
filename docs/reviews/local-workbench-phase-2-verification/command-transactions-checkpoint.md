# S2 first checkpoint — database-owned command outcomes

Status: **Bounded command-transaction repair passes; S2 and Phase 2 remain incomplete.** Direct implementation and source self-review, not independent agent review or a functional-release claim.

## Implemented boundary

The following existing authority commands now execute under one outer SQLite transaction:

- `confirm_register_project`
- `select_project`, `select_goal`
- `create_goal`
- `create_check`, `configure_checks`

Eligible domain effects, selection metadata, event/cursor, projection revision and normalized intent receipt commit or roll back together. Store transactions support nested savepoints so existing mutation helpers participate in that outer transaction rather than independently committing.

The authority stages revision/cursor privately during a command. Public projection counters remain at the last committed value until the outer transaction succeeds. Direct event commits also update memory only after their store transaction succeeds. Unsafe counter exhaustion is refused. A command invoked reentrantly inside a command transaction is rejected.

Failed Project registration restores its transient confirmation cache as well as SQL effects, allowing retry with the same inspection when still valid. Generated opaque IDs need not be reused after rollback. Typed domain errors roll back tentative effects before recording rejection. Receipt writes, including rejection/stale receipts, run transactionally. Same-ID changed payload still returns an identity conflict instead of mutating again.

Store schema **3** adds persisted outcome `reason` and `detail`, so replay preserves normalized receipt fields, including rejection explanations, across restart. Fence schema remains **2**. Earlier development stores are unsupported and preserved, not migrated, recreated or overwritten. This change does not enable restore or claim durable reconstruction of transient inspection views.

New commands also reject a mismatched Companion generation, with a truthful stale-generation outcome. This is not a claim that the entire incoming envelope is now closed/validated.

## Evidence

`test/phase-2-command-transactions.test.ts` covers failures before/after receipt insertion, outer commit-boundary failure, staged versus public revision, direct-event failure, registration-cache restoration, all listed durable mutation kinds, typed rejection after tentative mutation, normalized replay/restart, and wrong plugin generation.

The initial test run reproduced receipt/effect splitting, premature revision publication and missing generation validation (`/tmp/p2-command-red.log`). Subsequent tests exercise registration, selection/check rollback and persistence of rejection text. These are injected failures on real disposable SQLite storage, not a claim of simulated disk durability or real Pi integration.

Reproduction:

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-command-transactions.test.ts \
  packages/local-workbench-v1/test/runner-foundation.test.ts
```

The new tests are included in `local-workbench-v1-phase-2-check`. Full package tests and Phase 1 presentation checks pass, with the existing five runtime TODOs retained. Full Phase 2 still returns **exit 1/BLOCKED** after its implemented subset passes. Logs: `/tmp/p2-command-{green,all,phase1,gate}.log`.

No installation, live Pi/provider, Project mutation outside disposable tests, Assignment/check execution, prototype/spike change, commit or push.

## Remaining S2 work

- Cross-ledger retirement/purge needs recoverable command identity and result reconciliation; SQLite savepoints do not make independent databases atomic.
- Adoption/bridge commands still have external sends and transient manager state. They are deliberately **not** wrapped as ordinary database commands. Durable outcome/delivery ordering and rollback/recovery need their own integration.
- Full closed envelope validation, target/payload association, bounds and explicit stale-session outcome queries remain outstanding. Existing receipt lookup behavior is preserved; lookup is not new mutation authority.
- Source heartbeat, snapshot-before-feedback, resnapshot/outcome queries, close/reconnect and truthful unavailable `present`/`recover` outcomes remain outstanding.
- No frontend success/publication guarantee is inferred from a committed database receipt. The source/adapter checkpoint must prove that separately.

Next: finish the authority outcome protocol for cross-ledger/bridge operations and the projection-source publication path. Do not mark S2, F7/F13 or Phase 2 closed from this database-command subset.
