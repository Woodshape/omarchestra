# Adoption exchange guard checkpoint

Status: **Bounded acknowledgement/connection guard repair passes. Phase 2 and complete Adoption remain BLOCKED.** This user-directed repair follows the S1 substrate checkpoint; it does not skip or close S2/S4 prerequisites for full S5 integration. Direct implementation and source self-review only.

## Implemented

`runner/adoption.ts` now:

- Bounds acknowledgement by both the proposal expiry and acknowledgement deadline. At the exact deadline the exchange is expired. Revalidates deadlines, connection lifetime and frozen binding fields immediately before commitment.
- Requires the current subscription lifetime and exact port object, not merely matching `transportId` strings. ACKs additionally match the immutable proposal digest and nonce. Changing ports, even to one with the same label, cannot inherit an exchange.
- Makes captured callbacks inert after unsubscribe/rebind. Repeated bind retains one manager listener. Failed subscriptions and synchronous disconnect during subscription cannot create an active exchange or leak that subscription's cleanup.
- Rejects wrong-connection readiness, interactive input and disconnect. A disconnect affects only Runs associated with that subscription, then invalidates it. Recovery on a new connection is not implicitly granted.
- Sends Adoption/commit frames only to the retained current exchange connection, never to whatever port a getter happens to return later.
- Treats duplicate ACK and readiness as mutation-free after a successful commit. An expired or failed exchange cannot advance on retries.
- Invalidates an uncommitted exchange on interactive input rather than granting a managed manual-control transition to an ordinary Pi.
- Returns copies of proposal views, protecting the frozen authorization data from accidental caller mutation. The digest covers the transport label, nonce and expiry as well as the proposal identity.

`TransportEvent` now declares the nonce already consumed by ACK validation. This is not the final discriminated S4 wire schema. The transport module header no longer describes the object-event seam as an implemented production framed connection.

Existing fake authority tests now explicitly rebind after disconnect; a disconnected subscription cannot silently become a new connection. No bridge or runtime has been installed.

## Evidence

`test/phase-2-adoption-exchange.test.ts` uses the actual manager, authority transaction code and disposable SQLite runner with an **object-event fake port**. Original/replacement proposal shapes exercise deadline boundaries and wrong connections/nonces. Further tests cover callback disposal, duplicate feedback, ordinary input, caller mutation, failed subscription, and deadline/connection/store drift between acknowledgement and commitment. The existing full fake original→retirement→replacement journey remains passing.

The initial timing/wrong-connection tests reproduced the defects before implementation (`/tmp/p2-adoption-exchange-red.log`). The subscription fixture was then isolated from the authority's separate observation listener so it measures only the manager's listener ownership. Additional failure-injection cases were added during source self-review.

Reproduce the bounded targeted tests:

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-adoption-exchange.test.ts \
  packages/local-workbench-v1/test/phase-2-authority.test.ts
```

They are included in `local-workbench-v1-phase-2-check`. Full package tests and the Phase 1 presentation gate pass; the overall Phase 2 gate still deliberately exits **1/BLOCKED**. Logs: `/tmp/p2-adoption-exchange-{green,all,phase1,gate}.log`. Existing five runtime TODOs remain. No Assignment/check execution, live Pi/provider, desktop mutation, prototype/spike edit, installation, commit or push occurred.

## Deliberately not claimed

- A port object/subscription is local ownership evidence, **not same-process Pi proof**. The real content-free bridge, incarnation challenges, framed decoding, bounded registry/activity leases and monotonic receiver clock remain S4 work.
- The legacy state machine still stores proposals in binding-state rows and uses Project-only occupancy. It does not yet consume S1's Goal-qualified committed-membership table end to end. Failed/expired proposal cleanup and truthful management projections remain S5 work; no readiness or membership acceptance is inferred from this checkpoint.
- The acknowledgement and commitment are still separate transactions, and intent effects/outcomes/publication are not yet atomic. Injected failure after acknowledgement may retain an acknowledged-but-uncommitted record. This checkpoint prevents it from silently becoming committed; S2/S5 must implement atomic outcomes and explicit recovery.
- Surviving-process challenged recovery and offline takeover reconciliation are not implemented. Rebinding explicitly refuses to recover an old exchange; this is fail-closed unavailability, not a working recovery experience.

Next prerequisite: S2 transactional command outcomes and projection-source lifecycle, followed by the S4 bridge and complete S5 Adoption conversion. Do not invite a human management walkthrough from these guard tests.
