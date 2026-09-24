# S5 framed Adoption engineering checkpoint — 2026-09-24

**Engineering exit matrix: PASS (host-executed fake Pi, no live installation). Overall Phase 2: BLOCKED; S6/native entry and independent overall review are still outstanding.** This supersedes the earlier [ACK-only seam](challenged-ack-seam-progress.md), not the Phase 2 acceptance verdict.

## Contract and shipped behavior

- Store schema **9** adds bounded, validated pending proposals *outside* Agent Runs and Goal-scoped Role membership. Existing schema-8 roots fail closed until an explicit supported upgrade; no destructive automatic migration. Pending proposals are discarded on owner restart; incomplete authorization never becomes a disconnected Run.
- The owner-only `BridgeRegistry` and `FramedAdoptionManager` bind each proposal to the selected local Project/Goal, Role, incumbent vacancy generation, exact Pi process/session/extension incarnation, observed ID, **current connection and challenge**, proposal digest, operator intent, and independent proposal/ACK deadlines. The real Pi extension acknowledges only when idle on the exact still-current channel. Refusal, expiry, disconnect, and cancellation release *pending* state only.
- A valid ACK rechecks current Pi activity and connection, local Project context, Goal and occupancy, authorization, exact identity, both deadlines, and fences. One SQLite transaction commits binding identity, Goal-scoped membership, framed delivery intent, event/revision, and deletion of the pending proposal. **ACK alone and registration alone grant nothing.** Postcommit sending is recorded as attempting/written/not-sent/unknown; no uncertain automatic replay.
- Exact challenged `adoption_committed` receipt produces readiness. Reconnect marks connected Runs disconnected; a surviving extension presents the retained digest under a fresh challenge before the owner redelivers the binding, including after a lost commit or receipt. A new process/session/extension or stale connection cannot recover. Interactive Pi input is content-free; offline input on the surviving extension is reconciled to manual takeover before readiness. Pi footer changes from `Unassigned · observed` to committed Role/connecting, ready, or manual takeover only on challenged owner messages.
- Explicit runner-intent retirement rejects a connected Run, **including connected manual takeover**; disconnection permits confirmed retirement. The independent fence prevents revival on the old Pi even after purge or restart. Replacement uses the same framed path; terminal leaf purge removes history while preserving the exact security fence and Goal/Role vacancy high-water. A different Goal may occupy the same Role independently. Managed and retired cards are filtered to the selected Goal on the framed path.
- The injected legacy object-event `AdoptionManager` remains for historical tests but is **not connected to the production-intended framed registry**. Normal owner startup and Companion/QML wiring are S6, not claimed here. No Assignment delivery or acceptance-check execution port was introduced.

## Reproduce

From the repository root on Node 26 with disposable `/tmp` roots and the fake Pi host:

```sh
node --experimental-strip-types --experimental-sqlite --test packages/local-workbench-v1/test/phase-2-framed-adoption.test.ts
node --experimental-strip-types --experimental-sqlite --test packages/local-workbench-v1/test/phase-2-*.test.ts
just --no-dotenv local-workbench-v1-phase-2-check
```

Observed after the final supersession regression: framed matrix **12/12**, affected Phase-2 test glob **226/226**; complete recipe: foundation **41/41**, management **187/187**, presentation **83 pass / 5 existing TODO**, audits **38/38**, offscreen QML **18 rows**. Recipe intentionally exits **1/BLOCKED** for S6. No Pi extension was installed or loaded, no Assignment was delivered and no acceptance check ran. The tests use real framed paired streams and a disposable Git repository, not an object-event ACK as evidence of binding.

Matrix includes operator intent/replay, actual Pi receipt/status, independent Goal Role occupancy, late/wrong-connection ACK, abandoned ACK and cancellation, lost commitment/receipt, offline input, superseded recovery, connected-takeover retirement and reconnect race, original/replacement membership, terminal leaf purge and fence/restart replay. Existing S4 tests cover malformed/fragmented frames, lease expiry, capacity, and throwing content getters; S1/S2 tests cover interruption, uncertain writer effects, and durable command outcomes. Changed Project context revalidation is enforced at proposal, authorization, and ACK.

## Next slice

S6 must start the owner and framed listener together, negotiate an installed Companion exactly, add separate `open`/`hide`/`status` clients, wire native QML → adapter → owner → *this* fake-Pi bridge, eliminate legacy runtime entry, and replace silent truncation with bounded pagination. Run the complete gate and independent review before requesting separately authorized human management acceptance. Phase 3 dispatch/check execution remains unavailable.
