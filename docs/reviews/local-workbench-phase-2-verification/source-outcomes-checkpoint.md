# S2 checkpoint — committed presentation and outcome recovery

Status: **Bounded source/adapter repair passes; S2 and Phase 2 remain incomplete.** Direct implementation and source self-review, not independent review or native/live Pi evidence. Store schema remains 4; fence schema remains 2.

## Implemented

- `runner/host.ts` stages the known outcome, publishes a fresh committed snapshot through the actual presentation shell, and only then resolves displayed feedback. A failed projection publication cannot display success. Source snapshot caching advances only after successful publication.
- The adapter requires a fresh, successfully published snapshot at or beyond `committedRevision` before accepting acknowledged feedback. A known receipt protects its already-sent intent from being invalidated by that command's own snapshot transition. Session/generation/epoch mismatch still rejects association. Recovering an original command's result does not reactivate a confirmation or emit a new authority action.
- `PresentationPort.intentResult(false)` now reports rejection rather than being ignored. Pending state is finalized only after the view accepts feedback. Duplicate terminal feedback is mutation-free and does not notify the view again.
- The source implements read-only `query_intent` with the **full original validated intent**. Its session and normalized kind/target/payload hash must match the retained receipt. A reused ID with changed payload is rejected; missing outcome is reported unknown without persisting a fake result or executing anything. Historical-session lookup grants no mutation authority; the adapter still enforces its current association.
- `request_snapshot` forces a fresh snapshot and validates session. Unknown request kinds/fields are refused. Gap presentation precedes a synchronous resnapshot reply, so an old gap frame cannot overwrite the recovered state. Reentrant publication requests defer to the next publish tick instead of recursing indefinitely.
- One-second, owner-driven full-snapshot heartbeats preserve idle freshness. No new revision, event or epoch is manufactured. Missing updates still cross the existing two-second stale bound. The host must be ticked; no hidden/background timer is introduced.
- Closing a channel releases only its exact subscriber. Old channels cannot query or close a replacement. Adapter callback generations fence delayed old callbacks. Source loss permits same-owner adapter reconnect, retains drafts and unresolved intents, and queries their outcomes instead of re-submitting them. Explicit adapter stop remains final disposal.
- Fresh presentation adapters use independent opaque intent namespaces, avoiding counter reuse against the same owner. Completed/expired entries can be pruned to preserve the bounded pending queue; unresolved work is not silently evicted.
- The unimplemented `present`/`recover` authority cases now return `handler_unavailable`, not false acknowledgements. No existing native presentation/recovery implementation was removed.

## Evidence

The initial `phase-2-source-outcomes.test.ts` run reproduced premature success, failed-publication handling, idle staleness, retained closed channels and missing outcome queries (`/tmp/p2-source-red.log`). The repaired tests use the real runner/store, authority, source, adapter and presentation-shell code with an injected view. They verify:

- displayed snapshot before success, publication failure with one durable effect, and receipt recovery without re-execution;
- rejected view feedback remaining unresolved until accepted;
- idle freshness and genuine staleness without owner updates;
- exact source close/reconnect with unchanged owner epoch;
- read-only, payload-bound outcome queries, missing results and invalid requests;
- adapter replacement without intent-ID reuse, bounded completed receipt retention and truthful unavailable operations.

`intent.test.ts` now rejects feedback ahead of its snapshot instead of asserting optimistic success. `stale-session.test.ts` covers captured old callbacks and draft preservation across reconnect. The unchanged real-QML composed tests remain passing.

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-source-outcomes.test.ts \
  packages/local-workbench-v1/test/intent.test.ts \
  packages/local-workbench-v1/test/stale-session.test.ts
```

Full package tests and Phase 1 presentation checks pass, retaining the existing five runtime TODOs. Full Phase 2 remains **exit 1/BLOCKED** after its implemented subset passes. Logs: `/tmp/p2-source-{red,green,all,phase1,gate}.log`. No installation, live Pi/provider, desktop mutation, execution, prototype/spike change, commit or push.

## Remaining

At this checkpoint, durable post-commit Adoption delivery/unknown-delivery tracking and complete authority-envelope validation remained S2 work. The subsequent [delivery-outbox checkpoint](delivery-outbox-checkpoint.md) implements durable queued intent and attempt dispositions without replay; full authority-envelope validation remains open. Real Pi proof, Goal-scoped Adoption integration and challenged recovery remain S4/S5. Native foreground/client integration remains S6: this checkpoint proves source-channel lifetime, not the currently incomplete native command/EOF lifecycle. `present` and `recover` remain unavailable until their real ports exist. No human management invitation or complete Adoption claim follows this checkpoint.
