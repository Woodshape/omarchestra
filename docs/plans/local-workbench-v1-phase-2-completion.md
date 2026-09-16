# Phase 2 completion — sequential engineering slices

Status: **S1 durable-substrate gate PASS; Phase 2 remains BLOCKED.** The [first persistence checkpoint](../reviews/local-workbench-phase-2-verification/persistence-checkpoint.md) repairs owned-resource substitution and backup/schema validation. The [binding/fence checkpoint](../reviews/local-workbench-phase-2-verification/binding-fence-checkpoint.md) adds exact identity/membership storage and interruption-safe minimal retention. Direct implementation and source self-review only, not independent agent review. S2 is in progress: the [database-owned command checkpoint](../reviews/local-workbench-phase-2-verification/command-transactions-checkpoint.md) and [management-outcome checkpoint](../reviews/local-workbench-phase-2-verification/management-outcomes-checkpoint.md) pass. Retirement/purge now reconcile durable authorization and receipts across the ledger; request-Adoption and Take control are transactional. External Adoption delivery outcomes and projection-source lifecycle remain outstanding. S4/S5 must convert the legacy Adoption/projection path to the new identity/membership substrate before management acceptance.

A subsequent user-directed [Adoption exchange guard checkpoint](../reviews/local-workbench-phase-2-verification/adoption-exchange-checkpoint.md) repairs deadline and subscription-lifetime checks in the existing manager. This is a bounded F4/connection-guard repair, not full S5 integration or satisfaction of the S2/S4 prerequisites. Completing S2 remains a prerequisite for full Adoption integration.

This is the concrete completion sequence for the existing [Phase 2 scope](local-workbench-v1-phase-2-handoff.md), not a replacement architecture or new product scope. Read the [independent verification and reproductions](../reviews/local-workbench-phase-2-verification/README.md) and [canonical Fusion result](../design/local-workbench-v1-phase-2-integration-result.md) first. Preserve the delivered work and final safety fixes. Do not repeat the previous giant P2.2–P2.5 delegation.

## Outcome and constraints

The milestone remains: register a Project, persist Goals/checks, adopt an exact visible Pi and reopen the native workbench without losing history. All engineering gates are disposable/offscreen/provider-free. Real Assignment delivery and check execution remain prohibited. No Board, Plannotator, remote execution, global installation, service setup or broad visual redesign.

The current authority and bridge abstractions need correction, not blind preservation. In particular, replace Project-only membership, string-only identity and no-op acknowledged operations rather than layering adapters over their incorrect semantics. Preserve compatibility only where it does not perpetuate these defects. Do not enable restore or invent migrations for unknown schemas; explicitly reject unsupported roots and document supported upgrade handling.

Use one writer per shared checkout, read-only reviewers, and a checkpoint at the end of **each** slice. Do not label design-only review as implementation verification. Each next delegation consumes landed files and the previous acceptance report. Reviewers verify named invariants and actual UI/adapter payloads rather than test totals. No commit/push unless separately requested.

## S1 — Exact owned persistence and binding schema

**Findings:** F6, persistent portions of F2/F3/F8/F11/F12.

**Primary files:** `runner/{paths,manifest,owner-lock,schema,store,fences,backup,recovery,runner}.ts`.

- First define the durable identity shape shared with S4/S5: Node, Pi process/session/extension incarnation, Goal-scoped Role membership, predecessor linkage and vacancy high-water key. Keep membership, connection/readiness and control independent. Proposals are not members.
- Verify exact ownership of state parents and resources, including main DB, owner DB and fence ledger; missing/replaced lock resources cannot create a second authority. Acquire/revalidate in an explicit startup order. A filename or PID is never ownership evidence.
- Validate schema constraints and persisted safe-integer counters, not just column names. Reject unsupported schema and missing independently retained fence evidence before admission.
- Define recoverable fence/store operation ordering and minimal security retention before wiring destructive history deletion in S5. Explicitly handle interruption at each separate durability boundary; never call two database writes atomic.
- Backups require owned-target tracking, exclusive creation, bounded metadata validation and real backup database integrity/schema checks. Rotation deletes only verified owned backups, not filenames matching a pattern. Preserve repaired collision refusal.

**Exit gate:** the disposable lock-substitution reproduction is rejected, actual two-process exclusion still passes, substituted resources/sidecars and weakened schemas fail closed, malformed/non-SQLite backup and foreign rotation candidates are refused. Add interruption tests for the retained ledger protocol. No management admission on uncertain startup.

**Checkpoint:** safe durable substrate and agreed exact identity/membership types. Not a functional Adoption release.

## S2 — Transactional commands and projection-source lifecycle

**Findings:** F7, F13, authority envelope portions of F12.

**Primary files:** `runner/{authority,host,store,projection}.ts`, presentation adapter/shell.

- Validate full closed runner intent envelopes, current session/generation/epoch, target/payload association and bounds at the authority boundary, not only in QML.
- Commit eligible effects, event/revision and normalized intent outcome in one transaction. Publish in-memory revision/cursor only after successful commit. Handle cross-ledger retirement outcomes through S1's recoverable operation protocol.
- Replays return durable original outcomes without new mutation; changed payload under the same ID is rejected. Define stale-session outcome lookup without granting new authority.
- Publish the committed snapshot before final acknowledged feedback. Failed publication cannot imply displayed success; outcome query must recover the durable result rather than rerun the action.
- Implement authoritative heartbeat, gap/resnapshot/outcome queries and exact source close/reconnect. Do not bypass freshness checks to avoid stale UI. Pending unavailable `present`/`recover` must return truthful unavailable outcomes until their real ports are implemented.

**Exit gate:** inject failure before SQL commit and before/after outcome persistence/publication; prove no receipt/effect split, revision drift, duplicate effect or optimistic UI acknowledgement. Wrong generation/target is rejected. Idle remains fresh only with real heartbeats, loss latches stale, resnapshot recovers, close/reopen does not leak a subscriber or stop the store.

**Checkpoint:** reliable authority command/result path using existing durable Project/Goal flows. Update fake views and tests, not only the authority API.

## S3 — Project context and resolved check definitions

**Findings:** F9, F10.

**Primary files:** `runner/{git-context,authority,store,projection}.ts`, strict definition validators.

- Preserve the existing fixed Git binary, constructed environment, submodule rejection and state-root overlap fixes.
- Fail closed on every failed required Git query; unknown cleanliness/context is not clean. Distinguish legitimately absent HEAD from inspection failure.
- Record/revalidate repository and Git common-directory identity so a replacement at the same path is not the confirmed Project. Recheck applicable context before operations and startup admission without guessing execution readiness.
- Validate the closed C14 draft, resolve executable/cwd/declared resources canonically under the existing bounds, read/hash permitted resource bytes and persist the full normalized versioned definition. Reject nonexistent, changed, escaped, unreadable or unsupported resource targets and caller hashes/authority.
- Save never executes a validator. Preserve first-check creation, selected-Project binding, version conflict handling and invalid-draft retention through the actual UI path.

**Exit gate:** disposable same-path repository replacement and failed-status cases are rejected; no-HEAD registration still works. Missing/modified resources, stale edits and malformed definitions fail closed; valid create/edit returns runner-resolved digests and versions with zero execution.

**Checkpoint:** real persistent Project/Goal/check configuration ready to compose with native presentation, but no execution claim.

## S4 — Real content-free bridge and connection registry

**Findings:** F1, F2, transport/registry portions of F12; uses S1 identity contract.

**Primary files:** new production-intended bridge/transport modules, `runner/transport.ts` and registry boundary. Read installed Pi API documentation before implementation; use prototypes only as evidence, never runtime imports.

- Implement the actual Pi extension entry and injectable host adapter, framed owner-only local transport, closed discriminated envelopes, incremental byte bounds and per-connection ordering.
- Establish exact incarnation identity and fresh connection challenge/capabilities. Resolve retained membership/fences before ordinary observation; changing observed IDs never bypasses a fence.
- Observation is content-free and fail-open for Pi; membership/Role selection is runner/operator-owned. Maintain separate connections, bounded registry expiry and monotonic liveness. One disconnect affects only its exact connection, not all Runs.
- Capture source-only interactive takeover facts while offline in the surviving extension. No conversation/text inspection. Preserve accepted R1 and its limitations.

**Exit gate:** exercise the real bridge logic using fake host APIs over paired framed channels, including fragmented/oversized/malformed frames, wrong incarnation, stale/superseded connection, duplicates, registry capacity and lease expiry. Throwing content getters prove privacy. No Assignment/check execution ports become enabled.

**Checkpoint:** genuine bridge code exists and is fake-host transport-tested; no installed extension is loaded during automation.

## S5 — Exact Adoption, recovery and retirement/purge

**Findings:** F2–F5, F8; requires S1/S2/S4.

**Primary files:** `runner/{adoption,authority,recovery,fences,store,projection}.ts` and shared bridge logic.

- Separate pending proposals from committed members. Bind Role occupancy to Goal, not just Project. Abandoned/refused/expired proposals release only pending state; they never become disconnected managed Runs.
- Freeze exact target, incarnation, connection challenge, generation, digest and expiry. At ACK/commit synchronously revalidate proposal **and** ACK deadlines, current connection/activity, target occupancy and authorization. Implement one commit → binding delivery → receipt/readiness path.
- Recover only the same surviving extension through fresh challenge/proof, including lost committed delivery. Reconcile pending offline takeover before readiness. Original/replacement Runs use the same code and parameterized tests.
- Retirement is explicitly confirmed, permanently fences the exact incarnation and cannot retire a connected takeover. Preserve the recent disconnect/takeover fix. No implicit Assignment transfer or uncertainty release.
- Purge actually removes permitted terminal leaf history while retaining only the specified security fences/high-water/effect evidence; it is not merely hidden cards or `state=purged`. Use S1's interruption-safe protocol.
- Project/Goal projections cannot expose unrelated managed membership, and late retired/purged frames cannot restore authority under fresh observed IDs.

**Exit gate:** parameterized original/replacement matrix covers late/wrong-connection ACK, abandoned proposal, competing Role claims, lost commit/readiness, offline input, superseded recovery, retirement/reconnect races and purge/restart replay. Goal-scoped membership and retained effects are proven. Every scenario exercises framed real bridge logic and asserts zero execution.

**Checkpoint:** exact management core ready for the native adapter. No human management invitation yet.

## S6 — Native foreground integration and complete acceptance

**Findings:** F1 native-entry gap, F3 UI scoping, F12 collection presentation, remaining F13 integration.

**Primary files:** `runner/{main,host,projection}.ts`, native desktop adapter, QML/adapter integration, package gates and walkthrough.

- Implement foreground owner startup plus separate open/hide/status clients addressing that owner. Do not create a new runner/epoch for status or each presentation. EOF of a presentation client is not runner shutdown.
- Implement exact installed-Companion capability/session/generation negotiation and polling through an injected desktop command port. No installation or shell restart in runtime paths. Absent/stale/incompatible installation is actionable, never printed fake success.
- Wire actual QML registration, Goal creation, check configuration, proposal confirmation, readiness, takeover state, retirement/replacement/purge and retained navigation to the authoritative runner. Preserve the visual design and clearly separate fixtures.
- Replace silent collection truncation with bounded validated pagination/navigation; enforce registry/proposal admission caps upstream. Surface unknown facts honestly.
- Add fully composed tests: actual QML intents → real presentation adapter → one runner/store → framed real bridge with fake Pi host → fresh rendered snapshot and exact feedback. Demonstrate two Goals, reconnect and client hide/reopen with owner/history intact.
- Give every subprocess test a deadline and deterministic child/stdin cleanup, including failure paths. Do not repeat the 51-minute hung entry test. Avoid relying on `tail` pipelines or unreferenced timers as timeout enforcement.

**Exit gate:** full required Phase 2 matrix passes. Only then remove the unconditional BLOCKED terminator from `phase-2-gate.sh`, replacing it with actual required assertions, never only a banner edit. Run existing Phase 1 and affected prototype regressions. Record immutable release packaging, supported normal commands, genuine limitations and the separately authorized human management procedure. Preserve zero dispatch.

**Checkpoint:** ready for one focused human management check. Phase 3 begins only after Phase 2 completion; real dispatch additionally requires the specified intervention/unknown-delivery safety prerequisites.

## Execution discipline

Run **one slice per delegation/run**, with concrete exit tests and read-only review before continuing. S3 may be reviewed/designed while other work runs, but shared-checkout edits remain sequential. Do not bundle S4, S5 and S6 back into one large writer task.

For each closeout record:

1. Which finding IDs and exact subclaims closed; which remain open.
2. Negative tests that failed before the repair and pass with fail-closed expectations afterward.
3. Reproducible bounded commands and actual results; no unrelated test-count sales pitch.
4. Shipped user-visible behaviour and remaining disabled surfaces.
5. Specific next-slice handoff, including schema/identity choices.

Preserve current uncommitted work. The diagnostic reproducer intentionally characterizes defects and will stop matching as fixes land; convert cases into regression tests rather than maintaining defect expectations as release acceptance. No extra product-scope approval is needed for these existing contracts; stop only for a genuine unresolved policy decision, not because tests cannot be run against live Pi.
