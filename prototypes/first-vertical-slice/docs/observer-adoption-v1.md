# Observer and Adoption v1 prototype contract

Status: **bounded fake-only prototype implemented; live validation blocked by R1**

**PROTOTYPE — NOT PRODUCTION.** This contract records the shapes required for
the removable observer/Adoption milestone. It does not define production
packaging, install an observer, grant a remote ordinary-session claim, or
promote prototype code into production.

Related authority:

- [`../../../docs/design/mvp.md`](../../../docs/design/mvp.md)
- [`../../../docs/design/pi-terminal-behavior.md`](../../../docs/design/pi-terminal-behavior.md)
- [ADR 0002](../../../docs/adr/0002-observe-ordinary-pi-before-explicit-adoption.md)
- [ADR 0003](../../../docs/adr/0003-use-connection-bound-observer-capabilities.md)

## Authority boundary

An ordinary session is the visible interactive Pi process. Observation grants
no Team Goal, Role, Assignment, Agent Control Mode, writer lease, Runtime
Binding guarantee, PTY, terminal, process, input, prompt-delivery, or workflow
authority. The observer publishes allow-listed lifecycle facts and fails open
when Omarchestra is absent or incompatible.

Adoption is the only transition to management. It requires an exact current
identity, one local Team Goal on the registry-assigned Execution Node, one
unoccupied Role, explicit authorization of one immutable proposal,
acknowledgement from the exact current extension connection, activity
reconciliation, immediate eligibility revalidation, and one Team Runner
transaction. No managed work may be dispatched before that transaction
commits.

## Identity decision

Two designs were compared:

| Design | Decision | Reason |
| --- | --- | --- |
| Independent random process, Pi-session, and extension capabilities held inside the visible Pi plus current-connection challenges | selected | Smallest design that defeats PID reuse and proves possession by the current extension connection without collecting OS timing identity |
| PID, Linux `/proc` process-start ticks, boot identity, Pi session, and extension identity | rejected | Adds Linux/procfs coupling and process-timing metadata while still requiring the same current extension acknowledgement |

This is functional same-process proof through Pi's public extension surface and
an owner-only local channel, not OS process attestation. If the public surface
cannot sustain the exact identity and current-connection acknowledgement, the
prototype stops. It must not substitute PID, cwd, title, focus, recency,
display name, or equal strings.

### Identity values

| Value | Issuer and lifetime | Rule |
| --- | --- | --- |
| `processIncarnationId` | At least 128 random bits created inside the visible Pi process and retained only while the observer can retain it in that process | Never derived from PID or machine metadata. Rotation after reload causes a conservative new identity, never inferred continuity. |
| `piSessionId` | Pi public `SessionManager.getSessionId()` value for the current session | A session switch invalidates the old observed identity. |
| `extensionInstanceId` | At least 128 random bits for one `session_start` to `session_shutdown` observer lifecycle | A reload or replacement invalidates the old extension identity. |
| `hostPid` | Current process PID | Restricted diagnostics on registration only. Excluded from Companion projection and never authority. |
| `executionNodeId` | The local registry's configured Node identity | Assigned by the registry from the local owner-only connection, never trusted from hostname, cwd, environment, or a client claim. |
| `observedSessionId` | At least 128 random bits allocated by the registry | Names one registry record but is insufficient without its exact identity and current connection. |

The authoritative observed identity is
`(observedSessionId, executionNodeId, processIncarnationId, piSessionId,
extensionInstanceId)`. Non-TUI and already-managed hosts do not register as
ordinary observed sessions.

## `omarchestra.observer/v1`

The observer protocol is strict bounded NDJSON. Every frame has exactly:

| Field | Type | Bound |
| --- | --- | --- |
| `protocol` | literal | `omarchestra.observer/v1` |
| `type` | bounded ASCII identifier | 64 characters |
| `messageId` | bounded opaque ID | 128 characters |
| `body` | exact object for `type` | complete encoded frame remains within 16 KiB |

Unknown fields, types, capabilities, or enum values fail closed. Values must be
finite acyclic plain JSON with at most four levels of nesting. The incremental
decoder rejects a partial buffer over 32 KiB.

| Value class | Bound |
| --- | --- |
| Random capability or opaque ID | 1–128 bounded ASCII characters and at least 128 random bits where this contract requires random issuance |
| `proposalDigest` | Exactly 64 lowercase hexadecimal SHA-256 characters over the canonical immutable proposal |
| `hostPid` | Positive integer no greater than 2,147,483,647; diagnostic only |
| Version, enum, reason, or failure code | 1–64 bounded ASCII characters and an exact allow-listed value where specified |
| Counter, attempt, sequence, revision, or duration | Non-negative safe integer; attempts and post-registration source sequences are positive |
| Presentation label | 1–512 Unicode characters |
| Failure detail | 1–1,024 Unicode characters, locally authored |
| Capability array | Exactly three unique entries in canonical order |
| Current observed-session collection | At most 64 entries |
| Registry event page | At most 128 entries |

Initial observer capabilities are exactly `observe.lifecycle`,
`adoption.acknowledge`, and `managed.activate`. Missing, duplicate, foreign, or
unknown capabilities are incompatible. Incompatibility prevents registration
but never prevents ordinary Pi use.

### Observer to registry envelopes

| Type | Exact body fields | Ordering and rejection |
| --- | --- | --- |
| `observer.register` | `processIncarnationId`, `piSessionId`, `extensionInstanceId`, `hostPid`, `hostMode`, `observerVersion`, `capabilities`, `registrationAttempt`, `sourceSequence`, `lifecycle`, `activity`, `health` | Must be the first frame. `hostMode` is exactly `tui`. A new connection requires a strictly greater attempt for the exact extension identity. |
| `observer.heartbeat` | `connectionId`, `connectionChallenge`, `sourceSequence`, `lifecycle`, `activity`, `health` | Exact current transport and connection values; sequence must increase. Refreshes the lease but creates an event only when authoritative state changes. |
| `observer.lifecycle` | `connectionId`, `connectionChallenge`, `eventId`, `sourceSequence`, `lifecycle`, `activity`, `health` | Exact current connection and next source sequence. Exact duplicate message replay may return its cached result; changed bytes under one ID fail. |
| `observer.close` | `connectionId`, `connectionChallenge`, `sourceSequence`, `reason` | Reasons are exactly `quit`, `reload`, `new`, `resume`, or `fork`. Makes the record unavailable immediately. |
| `adoption.ack` | `processIncarnationId`, `piSessionId`, `extensionInstanceId`, `connectionId`, `connectionChallenge`, `proposalId`, `proposalDigest`, `acknowledgementNonce`, `registryRevision`, `sourceSequence`, `decision`, `activity`, `refusalCode` | Accepted only from the transport that received the request. `decision` is `acknowledged` or `refused`; `refusalCode` is null only for acknowledgement. Every bound value must match and remain current. |

`lifecycle` is `running` or `exited`. `activity` is `idle`, `busy`,
`waiting_for_user`, or `unknown`. `health` is `healthy` or `degraded`.
Lifecycle, availability, activity, eligibility, and expiry remain distinct.

### Registry to observer envelopes

| Type | Exact body fields | Rule |
| --- | --- | --- |
| `observer.registered` | `observedSessionId`, `executionNodeId`, `connectionId`, `connectionChallenge`, `acceptedRegistrationAttempt`, `acceptedSourceSequence`, `heartbeatIntervalMs`, `leaseDurationMs`, `registryRevision`, `piStatus` | Allocates fresh connection values. `piStatus` is exactly `Unassigned · observed`. It grants no management field. |
| `observer.rejected` | `requestMessageId`, `code`, `detail` | Bounded locally authored detail; no raw error, path, or submitted value. The Pi remains usable. |
| `adoption.request_ack` | `proposalId`, `proposalDigest`, `acknowledgementNonce`, `observedSessionId`, `executionNodeId`, `processIncarnationId`, `piSessionId`, `extensionInstanceId`, `connectionId`, `connectionChallenge`, `registryRevision`, `targetTeamGoalId`, `targetRole`, `acknowledgementRemainingMs` | Sent only after exact user authorization and only over the proposal's current observer connection. |
| `adoption.committed` | `proposalId`, `proposalDigest`, `agentRunId`, `targetTeamGoalId`, `targetRole`, `controlMode`, `piStatus`, `terminalTitleMetadata`, `runtimeBindingGuarantee` | Sent only after the Team Runner transaction returns committed. `controlMode` is `managed`; runtime guarantee is `unavailable`. |
| `adoption.failed` | `proposalId`, `code`, `detail` | Reports failure without changing ordinary-session authority. A post-commit delivery failure cannot roll back the durable managed result. |

## Ordering, reconnect, and deduplication

An observer extension increments `registrationAttempt` for every connection
attempt. The registry retains the high-water mark for the exact extension
identity. A different connection at or below that value is stale. A higher
attempt supersedes the prior connection, which becomes non-authoritative, and
allocates a new `connectionId` and `connectionChallenge`.

`sourceSequence` is monotonic per extension incarnation. Registration carries
its current value; each accepted heartbeat, lifecycle, close, and Adoption
acknowledgement must increase it. Reconnect supplies a current snapshot and
does not imply replay or exactly-once delivery.

The registry owns a durable monotonic `registryRevision`. Accepted registration,
changed lifecycle/availability/health, expiry, and Adoption state changes
advance it and produce stable, ordered registry events. A Companion projection
starts from an authoritative snapshot and then accepts contiguous revisions.
It never derives authority from raw observer frames.

Message deduplication is bounded to 256 identities per extension incarnation.
An exact replay on the same current connection returns the cached result.
Reusing an ID with different bytes is `message_id_conflict`. A fresh extension
identity receives fresh deduplication state.

## Heartbeat and expiry

| Fact | Prototype value | Authority |
| --- | --- | --- |
| Heartbeat interval | 5 seconds | Registry-selected duration returned at registration |
| Observed-session lease | 15 seconds after the last accepted registration, heartbeat, or lifecycle frame | Injected registry monotonic clock only |
| Adoption proposal lifetime | 30 seconds | Injected Adoption monotonic clock only |
| Post-authorization acknowledgement timeout | 5 seconds | Injected Adoption monotonic clock only |

Sender wall clocks are omitted. On transport close, an observed record becomes
`unavailable` immediately and cannot be adopted. It remains in the current
snapshot until its lease expires, then leaves the current registry. Reconnect
within the lease still requires a higher registration attempt and fresh
connection values. Display ages may be derived from the registry clock but
never authorize an action.

Monotonic deadlines are not restored across process restart. Registry restart
discards uncommitted proposals and makes observations non-current until fresh
same-process registration. Durable committed Agent Runs reconstruct as managed.

## Telemetry policy and privacy

The observer adapter constructs allow-listed facts. It never passes a Pi event,
unknown object, or raw exception to protocol validation.

The authoritative observed record contains exactly:

```text
observedSessionId
executionNodeId
processIncarnationId
piSessionId
extensionInstanceId
lifecycle
activity
availability
health
registryRevision
piStatus
```

`piStatus` is exactly `Unassigned · observed`. The record contains no Team Goal,
Role, Assignment, Agent Control Mode, writer lease, Runtime Binding,
prompt-delivery, PTY, terminal, process, or workflow authority.

| Class | Values | Permitted handling |
| --- | --- | --- |
| P0 operational | Protocol/version, lifecycle, activity, availability and health enums, durations, revisions | Registry events and bounded Companion presentation |
| P1 pseudonymous identity | Observed-session, Execution Node, process-incarnation, Pi-session, extension, connection and event IDs | Owner-only protocol and registry; project only the minimum current intent-correlation ID |
| P2 Adoption authority | Proposal ID/digest, challenges/nonces, authorization ID, Team Goal ID and Role | Adoption control path only; never ordinary telemetry |
| P3 restricted diagnostic | PID | Registration diagnostics only; never projection, correlation, or authority |
| P4 forbidden | Prompts, responses, thinking, conversation/message content, input/editor text or length, tool names/arguments/results, terminal output, repository content or path, cwd, title, focus, recency, display name, model/provider data, credentials, environment names/values, raw errors | Reject before transport; never store, log, emit, or project |

Observer projection publishes only `observedSessionId`, the fixed `piStatus`,
`lifecycle`, `availability`, `health`, `registryRevision`, and bounded opaque
Adoption choices. Process, Pi-session, extension, connection, challenge, PID,
and Node identity do not enter QML.

## Registry state and limits

The registry holds at most 64 current observed sessions. One record keeps
lifecycle, activity, availability, health, connection generation, source
sequence, lease fact, deduplication state, and registry revision separately.
Observation eligibility is derived outside presentation and is false unless
the record is current, available, running, idle, healthy, local, and unmanaged.

Registry event pages contain at most 128 events. Collections and counters fail
before their bounds or `Number.MAX_SAFE_INTEGER`. There is at most one pending
Adoption proposal per observed session.

## Companion observer projection

Observer presentation is additive to `omarchestra.companion/v1`. It does not
modify the existing `AgentConsoleHandoff`, its three managed cards, its Team
Runner cursor, or the `present_agent` intent. An observer-capable immutable
Companion release advertises optional `session.observer`; the existing six
managed capabilities remain unchanged.

The separate observer snapshot contains exactly:

```text
observerRevision
agents[]:
  observedSessionId
  piStatus
  lifecycle
  availability
  health
  choices[]:
    choiceId
    label
    enabled
```

QML receives neither target identity nor eligibility inputs. Non-QML code maps
an opaque `choiceId` to the exact target Team Goal, local Execution Node, and
Role.

| Intent/result | Exact fields | Rule |
| --- | --- | --- |
| `request_adoption` | current Projection Session identity, `intentId`, `observedSessionId`, `choiceId` | Requests an immutable proposal; QML supplies no Team Goal, Node, Role, or eligibility fact. |
| `authorize_adoption` | current Projection Session identity, `intentId`, `proposalId`, `proposalDigest` | Represents explicit confirmation of exactly the displayed proposal. |
| observer intent result | current Projection Session identity, `intentId`, `phase`, `code`, `detail`, nullable `proposalId`, nullable `proposalDigest`, nullable `remainingMs`, nullable `displayLabel` | Bounded plain data. QML renders it and owns no validation, expiry, deduplication, acknowledgement, reconciliation, or transaction. |

Observer shell calls are separate `applyObservedAgents` and
`observedIntentResult` calls. Adoption intents never travel through the managed
`LiveProjectionAdapter`.

## Immutable Adoption proposal

A proposal freezes exactly:

```text
proposalId
proposalDigest
observedSessionId
executionNodeId
processIncarnationId
piSessionId
extensionInstanceId
connectionId
connectionChallenge
registryRevision
targetTeamGoalId
targetExecutionNodeId
targetRole
createdMonotonic
expiresMonotonic
acknowledgementNonce
```

Creation validates a current available observed identity, a local Team Goal on
the same registry-assigned Node, an unoccupied Role, idle activity, running
lifecycle, healthy observation, and no Agent Run mapping. A second proposal
cannot create another pending proposal for that session.

Authorization binds the exact proposal ID, digest, target, one-use
authorization ID, and issuer-verifiable token. Automated tests use a fake
authorizer. QML never verifies authorization.

After authorization, the Team Runner sends `adoption.request_ack` only through
the proposal's exact current transport. Acknowledgement is accepted only when
the transport object, complete identity, connection values, proposal values,
nonce, registry revision, source sequence, and unexpired deadlines all match.
Equal envelope values on another transport are insufficient.

## Activity reconciliation

The same-process adapter reports only `idle`, `busy`, `unknown`, or `exited`.
It may acknowledge only `idle`, established locally from the public Pi host
surface: the identity and TUI session are current, no agent run or queued
continuation is active, no extension UI prompt is active, the session is not
shutting down, and any editor check remains local without emitting content or
length.

`busy`, `unknown`, and `exited` refuse. If slash-command or user-bash activity
cannot be classified through the public extension surface, the result is
`unknown`. The observer must not wrap shell execution, scrape terminal output,
inspect conversation state, or inject input to obtain certainty.

### R1 — live content-free activity lifecycle remains open

The fake Pi host can inject `idle`, `busy`, `unknown`, and `exited` facts, and
those cases are covered by the fake-only adapter and Adoption gates. That does
not establish the corresponding live Pi guarantee. Review of the documented Pi
0.84.4 extension surface found no complete content-free start/end lifecycle for
slash-command execution: extension commands bypass the input event, while
`user_bash` is a content-bearing pre-execution hook with no matching completion
event. `ctx.isIdle()` is not documented as a complete classifier for those
arbitrary activities.

Therefore the prototype deliberately stops before live installation or
Adoption validation. Until Pi exposes a content-free command/activity lifecycle
(or this reconciliation rule is explicitly revised and recorded), an adapter
must not treat `ctx.isIdle()` alone as proof that acknowledgement is safe. The
fake acceptance result is evidence of composition and authority ordering only,
not live feasibility.

Reconciliation imports no conversation, prior work, repository change, or
Assignment state. It cannot fabricate completed work.

## Transaction and dispatch invariant

Immediately before commit, the Adoption owner synchronously revalidates the
exact observed identity, current transport and connection generation, registry
revision, local Node, local Team Goal, vacant Role, available/running/idle
state, unmanaged status, proposal, authorization, acknowledgement, and
reconciliation result.

One Team Runner transaction atomically:

1. creates exactly one Agent Run bound to the process, Pi-session, and extension
   identity;
2. binds the selected Role and sets Agent Control Mode to `managed`;
3. commits one opaque role/state presentation value;
4. records `runtimeBinding = null` and
   `runtimeBindingGuarantee = unavailable`;
5. removes or transitions the observed record in the same transaction; and
6. records one Adoption event and advances the durable cursor.

The identity is exactly observed/unassigned before commit and exactly
committed/managed after commit, never both or neither. The dispatch port
receives no committed readiness token and sends no Assignment, prompt, control,
process, or terminal action until the transaction returns committed. Managed
bridge readiness remains separate; delivery waits for that bridge without
reversing the committed Agent Run.

## Failure and restart matrix

| Failure point | Authoritative result |
| --- | --- |
| Before authorization, acknowledgement, reconciliation, or commit | Observed and unassigned when still current |
| Disconnect, expiry, identity/activity drift, Node mismatch, remote goal, occupied Role, or acknowledgement refusal/timeout before commit | No management change; unavailable observation remains only through its lease |
| Transaction failure | Full rollback to observed and unassigned |
| Registry/runner crash with a pending proposal | Proposal is discarded; observation requires fresh registration |
| Failure sending `adoption.committed` after commit | Exactly committed and managed; never recreate the observed record |
| Exact retry after committed result | Return the same Agent Run and result without another transaction |
| Extension reconnect after committed result | Recover through the managed bridge identity; reject recreation as observed |
| Companion reload | Fresh Projection Session and authoritative snapshots; no observer or Agent Run authority change |

## Rejection behavior

| Condition | Code or result | State effect |
| --- | --- | --- |
| Malformed, unknown-field, non-finite, cyclic, or oversized frame | `invalid_envelope` or `envelope_too_large` | Reject before registration or state mutation; close the offending connection when framing is unsafe |
| Foreign protocol or capability set | `unsupported_protocol` or `incompatible_extension` | No observed record; ordinary Pi remains usable |
| Invalid identity, non-current connection, stale attempt, sequence regression, or changed duplicate message | `invalid_identity`, `connection_not_current`, `stale_registration`, `invalid_sequence`, or `message_id_conflict` | No lease refresh, event, proposal, or authority change |
| Capacity or telemetry-policy violation | `session_limit` or `privacy_violation` | Reject before persistence, logging, registry events, or Companion projection |
| Unavailable, expired, busy, unknown, exited, or already-managed session | Matching stable session code | No proposal or commit; preserve the current authoritative state |
| Node mismatch, remote Team Goal, or occupied Role | `node_mismatch`, `remote_team_goal`, or `role_occupied` | No proposal or commit |
| Duplicate/conflicting, stale, expired, missing, or replayed proposal/authorization | Matching proposal or authorization code | No second proposal or transaction; an exact completed retry may return its prior committed result |
| Acknowledgement mismatch, refusal, timeout, identity drift, or reconciliation failure | Matching stable code | Invalidate the pending attempt; remain observed/unassigned when still current |
| Transaction failure | `transaction_failed` | Roll back every observed-to-managed write |
| Delivery failure after commit | `postcommit_delivery_failed` | Retain exactly committed/managed state and recover from authoritative state |

## Typed failures

Every failure derives from one observer error type and carries a stable code
plus bounded locally authored detail. Callers branch on codes, never prose.

```text
invalid_envelope
envelope_too_large
unsupported_protocol
incompatible_extension
invalid_identity
invalid_sequence
stale_registration
message_id_conflict
session_limit
privacy_violation
connection_not_current
session_unavailable
session_expired
proposal_not_found
proposal_conflict
proposal_stale
proposal_expired
authorization_required
authorization_mismatch
authorization_replayed
node_mismatch
remote_team_goal
role_occupied
session_busy
session_unknown
session_exited
already_managed
ack_refused
ack_timeout
identity_drift
reconciliation_failed
transaction_failed
postcommit_delivery_failed
```

`postcommit_delivery_failed` reports transport degradation only. It does not
change the committed Adoption result.

## Installation and live boundary

Observer installation, update, rollback, and uninstall are explicit product
operations separate from Team Goals. This milestone specifies them but does not
implement live installation or run it. Automated gates use only fake clock,
persistence, transport, authorization, Pi host, managed bridge, Companion shell,
and cleanup
ports. They do not inspect or mutate a developer's installed Companion release,
private evidence, Pi configuration, or Omarchy configuration, and never invoke
Pi/provider requests, Ghostty, Hyprland, Quickshell, Omarchy shell IPC, Boomux,
SSH, systemd, PTYs, or terminal scraping. The proposed human-only procedure is
recorded in [`observer-adoption-live-validation.md`](observer-adoption-live-validation.md),
but it is blocked by R1 and has not been run.
