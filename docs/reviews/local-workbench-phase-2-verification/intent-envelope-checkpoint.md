# S2 checkpoint — authority intent envelopes

Status: **S2 command/source gate PASS in the injected runner path; Phase 2 remains BLOCKED.** Direct implementation and source self-review, not independent review or real Pi/native integration evidence.

## Boundary implemented

`WorkbenchAuthority.handleIntent(unknown)` now validates before receipt lookup, hashing, routing or storage mutation. `runner/intent-envelope.ts` shares the concrete presentation schema rather than maintaining a second permissive action schema, and adds:

- a private bounded JSON-data copy: no accessors, coercion/toJSON hooks, proxies, class instances, symbols, sparse arrays or non-JSON values;
- incremental encoded-byte accounting, depth/key/array/string bounds and safe-integer validation;
- exact protocol, required/closed envelope and discriminated payload validation, including closed check drafts;
- matching target/payload IDs for selection, registration confirmation, check editing, Adoption and Run management; null targets for inspection/Goal/check creation;
- exact non-null Run targets for currently unavailable presentation/recovery/Assignment actions. Assignment actions retain their real presentation shape (`target: Run`, payload Assignment reference), not an invented equality between different domain IDs. They still return unavailable; no Assignment resolver or execution is enabled.

Malformed envelopes return bounded `invalid_envelope` rejection **without a receipt**: they establish no admitted command identity and cannot poison an existing result. Valid new envelopes must match current session/generation/epoch/revision before routing. Session changes now report `session_changed`, not a fictitious runner restart.

## Durable identity and recovery

Store schema **5 → 6** changes receipt fingerprint semantics. The existing `payload_hash` column and management journal now carry canonical SHA-256 of the **complete validated original envelope**, including protocol, ID, session, plugin generation, runner epoch and expected revision, as well as kind/target/payload. Unsupported earlier roots fail closed; no migration or restore is introduced. Fence schema remains 2.

- Exact replay returns the immutable original result without re-executing, including after owner restart. Canonical object-key reordering is harmless.
- Reusing an ID with changed authority metadata or action data is `intent_identity_conflict`, not the previous success.
- Stale receipts retain the submitting session, not the receiving owner's session.
- Read-only source queries use the same validation and fingerprint. Historical lookup does not confer current authority; the adapter still fences obsolete associations.
- Routing consumes the private validated copy, so caller mutation during a store callback cannot change the action after hashing.
- Inspection's transient registration cache now joins the receipt transaction's rollback checkpoint. A failed inspection receipt cannot leave an unacknowledged confirmation candidate behind.

No QML payload shape or layout change was needed. Direct-authority test factories now send the actual protocol and exact per-kind payload/target pairs instead of relying on the old bypass. The old replay fixture now preserves the original revision; separate tests reject changed replay revisions.

## Evidence

`phase-2-intent-envelope.test.ts` initially reproduced malformed input admission, changed replay metadata, receipt session rebinding and caller-data mutation (`/tmp/p2-envelope-red.log`). Its repaired tests cover those cases plus bounds, accessor/proxy non-invocation, target checks before storage, schema-5 refusal, exact restart replay, stale authority and unavailable Assignment actions.

`phase-2-source-outcomes.test.ts` verifies complete-envelope query conflicts and no re-execution. The command-transaction regression now verifies inspection-cache rollback as well as registration rollback. Existing real-QML composed tests remain passing; they do not prove a native installed entry or real Pi bridge.

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-intent-envelope.test.ts \
  packages/local-workbench-v1/test/phase-2-command-transactions.test.ts \
  packages/local-workbench-v1/test/phase-2-source-outcomes.test.ts
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-foundation-check
timeout --kill-after=5s 90s just --no-dotenv local-workbench-v1-check
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-phase-2-check
```

Full package, foundation and presentation checks pass, retaining five existing runtime TODOs. The implemented Phase 2 subset passes; the full gate deliberately remains **exit 1/BLOCKED**. Logs: `/tmp/p2-envelope-{red,green,all,foundation,phase1,gate}.log`. No installation, live Pi/provider, desktop modification, prototype/spike change, commit or push.

## Readability review follow-up

The user confirmed that `intent-envelope.ts` was too dense to review comfortably. The approved behavior-preserving cleanup separates bounded copying, JSON byte accounting and target association. Literal JSON punctuation replaces unexplained byte counts; named limits, JSON value types and a documented descriptor reader replace compressed checks and `any`. Protocol rules, schema version and rejection behavior are unchanged. Existing targeted and full package regressions pass; logs: `/tmp/p2-envelope-cleanup-{targeted,all}.log`.

## Next and limits

Next: **S3 Project-context validation**, followed by resolved check resources. This closes S2's command-envelope/source requirements, not all F12 collection/transport concerns or F13 native lifecycle integration. S4 must supply the real content-free framed Pi bridge and pre-parse transport bounds. S5 must replace legacy Project-only Adoption occupancy with exact incarnation/Goal membership and challenged recovery. S6 must provide native owner/client integration and complete acceptance. In particular, opaque intent IDs and valid envelopes are not same-process Pi proof or permission to execute work.
