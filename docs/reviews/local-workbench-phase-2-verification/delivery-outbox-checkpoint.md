# S2 checkpoint — post-commit management delivery

Status: **Bounded outbox repair passes; S2 and Phase 2 remain incomplete.** Direct implementation/self-review, not independent review or real Pi bridge evidence. Previous source checkpoint committed as `87133ff`. This checkpoint changes store schema **4 → 5**, retaining fence schema 2. Older development stores fail closed; no migration/restore is introduced.

## Contract implemented

- Authorization now commits binding state, event/revision, normalized command receipt and a closed `bridge_deliveries` record in one SQLite transaction. Transient proposal/pending state rolls back with failed commands. No port call occurs inside that transaction.
- Binding commitment likewise commits its state/control change and delivery intent together before sending. The earlier ACK fact is still a separate transaction; Goal-scoped atomic membership integration remains S5.
- Authority transactions collect post-commit callbacks. Only after SQL commit and public counter publication can they run. A post-commit failure cannot restore old transient state, overwrite the saved outcome or return a domain rejection for the committed command.
- Each immutable queued record names a frame, Run, kind (`adopt|committed`), frozen metadata-only frame body, exact live subscription token and deadline. Fields and nested payloads are bounded/closed. One record per Run/kind; no reset-to-queued transition.
- Immediately before attempting a write, the dispatcher checks the original subscription object, current port object, exchange, deadline, fence and binding state/digest. Replaced connections—even with equal labels—cannot receive the old packet.
- `queued → attempting` is committed before calling the port. Expiry/connection/fence refusal is `not_sent`; a throwing port is `unknown`; a normal local return is `written`. **Written is not Pi receipt, readiness or exactly-once execution.** Delivery uncertainty does not reject the already committed authorization.
- Failure persisting the write disposition leaves a durable attempt marker and the saved command receipt. On owner reopen, `queued → not_sent` and `attempting → unknown`. Existing terminal dispositions remain evidence. There is no startup dispatcher, automatic retransmission or retargeting to another connection.
- Purge cascades deletion of retained frame bodies with Run history, without removing the independent minimal fence or clearing writer uncertainty.

`bridge-delivery.ts` defines the record and closed management payload validator. `AdoptionManager.queueDelivery` owns the live dispatch closure. Store transitions are transactional and monotonic. Neither raw port errors nor Pi content are stored in disposition reasons.

## Evidence and gate

`test/phase-2-delivery-outbox.test.ts` covers:

- a **separate read-only SQLite connection** observing the committed authorization, receipt and attempt marker before a send;
- receipt-before/after, outbox insertion and actual SQL `COMMIT` failures: no bytes sent, no durable authorization, retry after rollback;
- accept-then-throw behavior, duplicate command/ACK suppression and no restart replay;
- faults before an attempt, after the attempt-marker commit and after local write, including typed errors that must not produce false rejected outcomes;
- atomic committed-binding/outbox rollback, synchronous ACK handling, expiry and replacement-connection refusal;
- purge retention and unknown payload-field refusal on insertion/startup.

These are deterministic fault injections and reopen tests, **not SIGKILL/power-loss or human/live-Pi testing**. The existing zero-length ACK deadline test now also requires zero outbound frames, then injects a forged late reply to the expired queued exchange to retain its negative ACK check.

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-delivery-outbox.test.ts
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-foundation-check
timeout --kill-after=5s 90s just --no-dotenv local-workbench-v1-check
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-phase-2-check
```

Full package/foundation/presentation checks pass, with the existing five runtime TODOs retained. Full Phase 2 remains **exit 1/BLOCKED** after its implemented subset passes. Logs: `/tmp/p2-delivery-{red,green,all,foundation,phase1,gate}.log`.

## Still not implemented

Full authority-envelope validation remains S2 work. This is the legacy object-port Adoption path, not the production framed Pi extension, exact incarnation/Goal membership integration or challenged receipt reconciliation. Those remain S4/S5, including surfacing downstream delivery/recovery state through the integrated management UI. Native owner/client lifecycle remains S6. Assignment delivery, Pi input and gate execution remain prohibited. No installation, provider call or prototype/spike runtime change.
