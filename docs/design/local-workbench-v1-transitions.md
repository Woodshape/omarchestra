# Local Workbench v1 transition tables

Status: Phase 0 specification, not implemented runtime evidence. Governed by [C1–C13](local-workbench-v1-contract.md) and the [approved slice](../plans/local-workbench-v1.md). Every authority transition belongs to the runner, never QML. Tests of presentation fixtures do not establish durable enforcement.

## T1. Project, Goal, and admission

| From / input | Guards | Atomic result | Rejection / recovery |
| --- | --- | --- | --- |
| No Project / register | Canonical local Git root, supported repository, explicit Node/path confirmation | Project record and revision | Invalid, foreign Node, bare, inaccessible or unsupported context leaves no partial Project |
| Project / create Goal | Current revision, explicit bounded goal and resolved configuration | Durable Goal, active/recent navigation entry, zero Assignments | Conflict/stale returns reason and current snapshot |
| Goal / confirm Assignment start | Exact Run ready/managed, context and dirty baseline confirmed, frozen gate, stopping limits, no active Assignment or uncertain writer | Assignment, attempt, writer epoch, event and pending outbox commit together | Busy/context mismatch/uncertainty/gate invalid changes nothing |
| Active Assignment / second start | No admissible transition | None | Deny even if Role differs, first Run disconnected, or UI mistakenly enables action |
| Terminal Assignment / release writer | Candidate/epoch/reconciliation and quiescence checks established | Release current exact writer record | Unknown effects retain uncertain lease and deny next Assignment |
| Uncertain writer / reconcile | Explicit operator acknowledgement, prior effects recorded, no known active tools or unresolved evidence | New revision with clearance record, no automatic dispatch | Missing facts remain blocked; retirement or idle alone cannot clear |

## T2. Observation, Adoption, and readiness

| From / input | Guards | Result | Rejection / recovery |
| --- | --- | --- | --- |
| Unassigned / propose | Exact current observed connection, local Goal, vacant Role, eligible activity | Immutable proposal, no managed authority | Stale/busy/Node mismatch rejects |
| Proposed / authorize | Exact session/Goal/Role confirmation, current revision, 30-second confirmation TTL | Authorized proposal challenge | Cancel/expiry leaves Unassigned |
| Authorized / send proposal | Same current connection and identity | Awaiting ACK | Lost connection expires proposal, no commit |
| Awaiting ACK / same-Pi ACK | Exact challenge, capability binding, proposal, vacancy generation, activity | Commit Run, Role, control and presentation together | Invalid/late ACK cannot bind Run; failed transaction leaves no partial authority |
| Committed / deliver commitment | Current fenced checks and connection | Binding delivered, not yet ready | Lost delivery remains committed/unready, recover exact commitment |
| Delivered / readiness receipt | Same challenged connection, exact committed binding, no pending takeover | Ready lease and committed display value | No receipt, expired lease or disconnect remains unready |
| Ready / source-only input | Exact current nonretired Run, interactive source | T4 takeover transaction | Extension-originated input is not takeover |

Adoption never creates an Assignment. Same-Pi readiness and Assignment start are separate authority boundaries. Existing observer lease behavior retains its five-second heartbeat/fifteen-second lease unless explicitly revised in the future management adapter; the two-second C4 presentation freshness bound is independent.

## T3. Assignment, attempt, candidate, gate

| From / input | Guards | Result | Rejection / recovery |
| --- | --- | --- | --- |
| Draft / confirmed start | T1 admission | Admitted attempt and pending delivery | No commit means no send |
| Admitted / deliver | Recheck current readiness, identity, context, writer/control epoch and no stop | Dispatching, stable delivery ID | Failed eligibility pauses; no queued hidden turn |
| Dispatching / accepted ACK | Exact delivery and same Pi receipt | Delivered/running | Accepted does not mean completed |
| Dispatching / duplicate ACK | Exact stored payload digest and receipt | Record known earlier delivery without another turn | Conflicting duplicate rejects |
| Dispatching / busy or invalid ACK | Exact attempt | Refused, requires attention or explicit eligible retry | No queue, no automatic re-send |
| Dispatching / 5-second timeout or lost transport | Delivery cannot be proved | Delivery unknown, writer uncertain | Query same surviving extension receipt, never blindly resend |
| Running / agent settles or says done | No structured candidate | No acceptance transition | Retain last structured state without invented completion |
| Running / submit candidate | Exact Run/attempt/control epoch, bounded valid artifact refs | Candidate submitted | Retired/predecessor/old attempt rejects before mutation |
| Candidate submitted / prepare validator | Stable manifest, frozen gate resources, current epochs, quiescent eligible work | Persist candidate association and gate-running record | Changed/unreadable/oversized scope or uncertain tools yields attention |
| Gate running / exit 0 | Output/time limits, post-manifest stable and identical, gate hashes unchanged | Provisional pass evidence | Validator mutation is candidate_changed, not pass |
| Provisional pass / accept transaction | Recheck candidate/gate/context/epochs, no stop/takeover, current writer and quiescence | Accepted Assignment and completed Goal with immutable result | Race loser persists nonaccepting historical evidence |
| Gate running / nonzero exit | Exact invocation | Failed gate evidence | Eligible bounded correction only through next row |
| Failed gate / correction | Limits remain, managed/ready, quiescent prior attempt, same gate and admission | New attempt ID/ordinal, fresh association and delivery | Exhaustion stops; uncertainty blocks |
| Gate running / spawn error, timeout, output limit | Exact invocation | Error/timeout/output_limit evidence and attention | Unknown surviving validator effects retain writer uncertainty |
| Pending gate / operator changes definition | Exact operator intent and revision | New gate version, pending evidence invalidated | Worker changes cannot redefine gate; new attempt still consumes configured budget |
| Any active attempt / elapsed or attempt limit | Persisted limit reached or interval uncertain | Stop dispatch, record limit/attention | Restart does not reset budget |

## T4. Intervention and reconciliation

| From / input | Atomic result | What stays blocked | Failure behavior |
| --- | --- | --- | --- |
| Managed / Take control or interactive input | Increment control epoch, manual_takeover, Assignment needs_reconciliation | New Assignment and automatic message delivery | Do not suppress input or claim tool cancellation |
| Manual takeover / Return to team | Record explicit handoff request at supported same-Pi delivery boundary | Automatic work | Busy/unsupported remains paused; 30-second timeout is attention |
| Handoff requested / exact structured receipt | Persist handoff and enter reconciling | Dependent/automatic work | Wrong binding, stale epoch, malformed content rejects |
| Reconciling / accept | Record explicit reconciliation intent, request fresh candidate/gate validation | Direct completion without gate | Claimed completion or old passing result is insufficient |
| Reconciling / resume | Validate handoff, current context, limits and writer checks; record new control epoch | Dispatch until reconciliation commit and readiness | No silent managed reset on reconnect |
| Reconciling / retry | Same checks, fresh attempt under remaining configured budget | Old attempt/result acceptance | New gate version requires separate operator confirmation |
| Manual/reconciling / late gate pass | Store historical evidence, never accept | Completion and writer release | A later accept requires fresh current candidate validation |

## T5. Stop and cancellation

| Input / stage | Durable fact | Separate fact | Recovery |
| --- | --- | --- | --- |
| Operator or configured stop trigger | New dispatch/message delivery revoked before cancellation request | Tools may continue | Stop remains effective after reconnect/restart |
| Cooperative API available | Cancellation requested | Only exact adapter-supported request sent to Pi | Missing API is unsupported, not simulated cancellation |
| Cancellation ACK | Request acknowledged | Not process/tool termination | Keep writer uncertain unless effects/quiescence independently reconciled |
| 5-second cancellation deadline | Timeout/unknown | No kill escalation | Attention and retained files/Pi usability |
| Gate pass races stop | First committed authority transition wins | If stop committed first, pass cannot complete | Both events remain auditable |
| Repeated same stop intent | Return original committed result | No repeated cancellation authority | Conflicting reused ID rejects |

Validator resource cancellation is limited to the runner-owned validator child. Unconfirmed validator descendants prevent cleanup/clearance. Stop never signals Pi process groups or claims rollback.

## T6. Retirement, replacement, purge, and recovery

| Input / stage | Guards and durable result | Failure behavior |
| --- | --- | --- |
| Retire current Run | Disconnected/exited, exact Run/Goal/Role/revision; fence binding, release Role, increment vacancy generation atomically | Reconnect wins first: retirement is stale and requires reconfirmation |
| Replacement Adoption | Fresh observed process, exact confirmed ACK, predecessor and current vacancy generation | Failed ACK leaves vacancy and retirement intact, never resurrects predecessor |
| Replacement ready | Same committed-delivery/readiness/control logic as original Run | No Assignment transfer, no writer clearance from vacancy |
| Retained original or replacement reconnect | Resolve both commitment families, fresh challenge, same surviving capabilities, pending takeover before readiness | Neither may reappear as Unassigned due to lookup asymmetry |
| Retired/purged binding reconnect or late frame | Reject before readiness, registration, recovery, result or takeover mutation | Changing observed ID does not evade binding fence |
| Purge retired leaf | Separate destructive exact-revision confirmation, no retained successor | Remove only permitted Run history and card; preserve minimal fence and generation high-water |
| Purge predecessor with successor | No admissible transition | Disabled explanation: purge successor first |
| Runner restart | Exclusive ownership, schema/integrity checks, load fences, increment epoch, mark unfinished delivery/gates/writers uncertain | Unknown ownership or recovery gaps opens no dispatch path |
| Pi/extension/session replacement or reboot | No identity continuity guarantee | Explicit attention/fresh eligible Adoption where permitted, no retired-incarnation re-Adoption |

## T7. Projection and intent presentation

| Input / stage | Adapter behavior | QML behavior |
| --- | --- | --- |
| Open new session | Negotiate generation/capability, require authoritative snapshot | Loading, no authority actions |
| Valid snapshot | Atomically replace validated projection | Render committed plain values, unknown telemetry unavailable |
| Next ordered event | Match epoch/base revision/cursor, apply validated change | Update without clearing ordinary drafts |
| Duplicate event | Same ID/cursor/content ignored | No duplicate feedback/activity |
| Gap/conflict/publication failure | Latch stale, request snapshot | Retain last-known state with warning and disabled authority actions |
| Two seconds without authoritative update | Stale by local monotonic time | Never appear live from a timer-generated progress state |
| User confirmed action | Capture exact target/session/revision and unique ID, bounded pending queue | Submitted feedback, no optimistic authority state |
| Committed ACK | Match intent/session/target/origin revision | Acknowledged only, render later authoritative lifecycle separately |
| Reject/5-second timeout | Rejected or unknown, no fresh automatic resend | Reason and explicit refresh/reconciliation affordance |
| Session/identity/relevant revision change | Invalidate confirmation and obsolete feedback | Preserve text drafts separately, require fresh confirmation |
| Hide/clear | End presentation session only | Release dock space; do not unload installation or delete durable state |
| Board or unsupported runtime action | No authority intent | Visible disabled reason, no fake posting/execution |

## T8. Commit, delivery, and presentation failure windows

| Window | Required durable/recovery outcome | Objective future failure injection |
| --- | --- | --- |
| Before admission/Adoption commit | No authority or partial records | Throw before commit, assert zero dispatch and no occupancy/lease |
| After commit before outbox delivery | Retain committed record, no false readiness/delivery | Restart, reconstruct exact commitment and pending state |
| After send before ACK | Unknown, not resend | Drop ACK, query surviving receipt, assert at most one Pi API call |
| After ACK before receipt commit | Recover through same receipt identity | Crash store commit, reject blind retry/new delivery ID |
| After receipt commit before UI publish | Durable state survives, UI stale | Throw publisher, reopen with authoritative snapshot |
| Candidate capture while checkout changes | No association/pass for mixed state | Change dirty/untracked/ignored bytes between scans |
| Validator changes file or referenced script | Nonaccepting candidate_changed/gate_changed | Exit zero after mutation, assert no Goal completion |
| Pass during takeover/stop/new epoch | Store stale evidence without completion | Interleave transactions and assert epoch fencing |
| Retirement while replacement proposed | Current vacancy generation decides | Competing ACKs commit at most one occupant |
| Purge then restart/late frame | Fence/high-water persists | Reopen store, reject retired ID and stale replacement generation |
| Crash during migration/backup/restore | Preserve recoverable old state, no dispatch | Inject each file/transaction step, reject missing fence ledger |
| UI reload with pending intent | New session does not recreate action | Return old feedback, assert no mutation or optimistic state |

## Acceptance mapping and phase boundary

C1 maps to package/import/release and no-install source audits. C2–C3 map to invalid-context/admission/ownership/reopen cases. C4 maps to executable schema, projection/intent, draft/confirmation and QML boundary tests. C5–C6 map to exact delivery and candidate cases. C7–C10 map to gate/version/mutation/budget/aggregation cases. C11–C12 map to intervention/stop/replacement/recovery cases. C13 maps to bounded content and privacy audits.

Only C4 presentation behavior, fixture coverage, package/release boundaries and associated source audits are implemented in Phase 1. Runtime rows require composed disposable-store/transport/validator tests in their implementation phase. No helper-only or fixture-only pass may be reported as durable writer denial, real gate execution, same-Pi delivery, or successful restart recovery.
