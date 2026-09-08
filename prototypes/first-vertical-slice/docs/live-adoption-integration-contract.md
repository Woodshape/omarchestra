# Live Adoption integration contract

Status: **BLOCKED: partial implementation, scaffold tests green, required integration acceptance incomplete**

The requirements below are the intended contract, not a completion claim.
Independent closure review found missing Companion routing, lifecycle/lease
invalidation, atomic final revalidation, committed identity recovery, and actual
managed bridge wiring. Manual execution is disabled before resource creation.
See [the final handoff](live-adoption-engineering-handoff.md).

**Contract distinction.** The activation, recovery, capability discovery,
fingerprinting and cleanup requirements below are the intended contract. Only
behavior explicitly linked to independently accepted evidence is implemented
acceptance. Missing wiring is a blocker, not an accepted scope reduction.

**PROTOTYPE — NOT PRODUCTION.** This contract records the bounded live
Adoption wiring for the removable first vertical slice. It does not define
production packaging, install an observer, grant a remote ordinary-session
claim, or promote prototype code into production. It names the real durable
transaction owner and the exact Companion-to-runner-to-same-Pi activation path
so the fake-only gates can prove the observed-to-managed transition without a
live run.

Related authority:

- [`../../../docs/design/mvp.md`](../../../docs/design/mvp.md)
- [`../../../docs/design/pi-terminal-behavior.md`](../../../docs/design/pi-terminal-behavior.md)
- [`../../../docs/adr/0002-observe-ordinary-pi-before-explicit-adoption.md`](../../../docs/adr/0002-observe-ordinary-pi-before-explicit-adoption.md)
- [`../../../docs/adr/0003-use-connection-bound-observer-capabilities.md`](../../../docs/adr/0003-use-connection-bound-observer-capabilities.md)
- [`observer-adoption-v1.md`](observer-adoption-v1.md)
- [`observer-adoption-live-validation.md`](observer-adoption-live-validation.md)

## Scope and boundaries

This slice targets **live Adoption wiring** only. It reuses the pure
`AdoptionCoordinator`, Agent Registry and observer extension adapter. The
Companion projection validators in `observer/companion-projection.ts` have
changes for async intent results and nullable failure fields, so they are not
reused unchanged. The observation-only gateway must continue to reject
`adoption.ack` as `unsupported_protocol`. Historical Companion releases 0.2.0
and 0.3.0 must remain immutable. Final integration compared
`observer/live-gateway-core.ts`, `observer/adoption.ts`,
`companion/contracts.ts` and `companion/releases.ts` against Git HEAD and found
no differences. This comparison establishes preservation of those four paths,
not live compatibility or acceptance.

Automated gates are fake-only: injected clock, persistence, transport,
authorization, Pi host, managed bridge, Companion shell, and cleanup ports.
They never open a socket, launch Pi, start a provider, touch a desktop, SSH,
Boomux, systemd, or mutate an installed plugin or global Pi configuration.

## Transaction owner

**D1. The durable transaction owner is a separate bounded Adoption store and
runner, not the existing managed `Store`/`Domain`/Team Runner.**

Evidence: `src/store.ts` `RoleIdentity` requires `terminalSessionRef` and
`shellRunId`, and its `role_bindings` schema makes both `NOT NULL UNIQUE`.
`src/runner.ts` can deliver an existing assignment during bridge handshake.
Adapting that path would require schema and workflow changes beyond this slice,
and supplying placeholder terminal references would violate the Runtime Binding
contract. The sibling store is the smaller implementation.

The new runner owns its **actual local Team Goal and vacant Roles**. It must
not claim occupancy authority over a goal independently owned by the existing
runner/database. It records only the adopted Agent Run, Role occupancy, control
state, presentation, and the observed-to-managed transition for the disposable
slice.

### Storage interface

```ts
interface AdoptionTransaction {
  // reads
  committedByIdentity(identity: CommittedIdentity): CommittedAdoption | null
  committedByProposal(proposalId: string): CommittedAdoption | null
  isRoleOccupied(teamGoalId: string, role: Role): boolean
  isIdentityCommitted(identity: CommittedIdentity): boolean
  currentCursor(): number
  eventsAfter(cursor: number): AdoptionEvent[]
  // write (one atomic commit)
  commitAdoption(input: CommitAdoptionInput): CommittedAdoption
}

interface AdoptionStore {
  transaction<T>(operation: (tx: AdoptionTransaction) => T): T
  snapshot(): DurableAdoptionState
  close(): void
}
```

Transaction callbacks are **synchronous**. The store persists one coherent
state containing:

- configured local Execution Node and Team Goal;
- Role occupancy and committed Agent Runs;
- full committed process/session/extension identity;
- the observed-to-managed transition (a durable identity tombstone);
- exact committed presentation and control state;
- proposal ID/digest to committed-result mapping;
- the Adoption event and durable cursor.

Uniqueness of both the binding identity and `(teamGoalId, role)` is enforced in
the durable transaction. Pending proposal state remains transient and is never
persisted.

## Activation path

**D2. The exact actual path is:**

```text
Companion request_adoption
  -> opaque choiceId -> LiveAdoptionCompanion
  -> LiveAdoptionRunner.requestAdoption
  -> AdoptionCoordinator.createProposal (immutable proposal)
Companion authorize_adoption (exact proposalId + digest)
  -> LiveAdoptionRunner.authorizeAdoption
  -> AdoptionCoordinator.authorizeProposal
  -> adoption.request_ack over the proposal's exact observer connection
same-process adoption.ack (same connection, current identity)
  -> AdoptionCoordinator.acceptAcknowledgement
  -> final synchronous revalidation
  -> one AdoptionStore transaction (durable commit)
  -> validated adoption.committed
  -> exact acknowledged-proposal check
  -> explicit managedBridge.enable in the same visible Pi
  -> verified bridge readiness
```

Adoption itself creates **no assignment**. `runtimeBinding = null` and
`runtimeBindingGuarantee = unavailable` are preserved. No authority or prompt
dispatch occurs before the durable commit returns.

## Final revalidation and commit share one serialization boundary

**D3.** Coordinator checks contain `await` boundaries; its commit lock
serializes coordinator commits, not registry lifecycle changes. Inside the
runner's final synchronous transaction, before commit:

1. verify the authorized proposal and acknowledgement remain current;
2. verify the exact transport object, connection ID/challenge, and identity;
3. check monotonic proposal/ack deadlines, lease, current sequence, and
   idle/running/healthy/available status;
4. check the configured local Node/goal, vacant Role, and absent committed
   identity;
5. commit the complete result once.

There is **no asynchronous yield** between these checks and commit. The gateway
queue is never held locked while waiting for an acknowledgement that must enter
through the same queue.

## Recovery

**D4. Durable recovery precedes observed registration.** On restart:

- load committed bindings/results before accepting connections;
- discard pending proposals and monotonic deadlines;
- require fresh registration for uncommitted observations;
- route an exact committed identity through a fresh managed recovery handshake
  rather than ordinary registration;
- prove possession through the current connection and a fresh challenge (stored
  equal strings or PID alone are insufficient);
- return the original committed result without another commit.

Specifically test a crash after durable commit but before `adoption.committed`
delivery: the extension may still believe it is observed in that case, and the
runner must not recreate the observed record or commit twice.

## Post-commit delivery is not commit authority

**D5.** Actual activation is:

```text
durable commit returns -> validated committed frame -> exact acknowledged
proposal check -> explicit managedBridge.enable -> verified bridge readiness
```

Runner connection loss must immediately revoke readiness and clear queued
dispatch. Durable `controlMode = managed` may remain, but it does not imply a
connected bridge or permission to dispatch. Adoption creates no assignment.

## Presentation and intents

**D6.** Publish one combined authoritative presentation revision: managed cards
and Unassigned Agents applied together from the same runner snapshot.
Presentation data is persisted in the transaction, not QML delivery success.
External Pi and Companion updates cannot be atomically delivered with a
database commit; on publication failure, retain committed authority and
mark/invalidate stale presentation rather than claiming rollback or leaving
actionable stale Adoption choices.

**D7.** Companion intents are consumed asynchronously. The current
`CompanionObserverProjectionAdapter.submitIntent()` validates
`observer.submitIntent(...)` synchronously; a live coordinator returns a
promise, so the adapter must await it. Failure results may carry nullable
`proposalId`/`proposalDigest` per `observer-adoption-v1.md`; the result
validator must accept nullable proposal fields on failure paths.

## Rejection matrix

Every required rejection must grant no authority and leave the session exactly
observed/unassigned (when still current) or exactly committed/managed:

- invalid/stale identity, reused PID, mismatched Node, remote Team Goal;
- occupied Role, busy/unknown/exited/unavailable session;
- already-managed session, duplicate proposal, ack refusal/timeout;
- disconnect, identity drift, expired-but-unswept connection;
- tombstoned (already committed) registration;
- duplicate Role claim, async revalidation race;
- commit-delivery loss, runner-loss dispatch revocation.

## Interfaces (suggested, not mandatory)

| File | Responsibility |
| --- | --- |
| `observer/live-adoption-store.ts` | Injected transactional state contract and validation |
| `observer/live-adoption-runner.ts` | Sole Adoption authority, coordinator composition, local goal/Role checks, exact connection tracking, final revalidation, recovery, dispatch readiness |
| `observer/live-adoption-gateway-core.ts` | Separate Adoption-enabled routing; `live-gateway-core.ts` stays observation-only |
| `observer/live-adoption-companion.ts` | Async request/confirmation controller, bounded results, combined authoritative projection |
| `manual/live-adoption-store.ts` | Disposable durable adapter (built-in SQLite, explicit synchronous transactions) |
| `manual/live-adoption-extension.ts` | Actual same-Pi committed managed bridge composition |

## Fake-only acceptance

The dedicated `just prototype-live-adoption-check` gate runs component,
partial-composition, durability and source-audit tests plus no-resource
entrypoint checks. Existing observer/Companion regression gates run separately.
The current passing results do not establish the required composed acceptance.
Task 1.a produced no red-test artifact, and task 2.a added tests alongside the
partial implementation. Red-first composed-path evidence remains incomplete.
Task 3.a was an architecture review, not an implementation task. The next
correction must record failing behavioral assertions before implementing the
remaining wiring and recovery. No gate authorizes live execution.
