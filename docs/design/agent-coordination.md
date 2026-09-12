# Agent coordination direction

Status: **Approved product direction; not implementation evidence.**

This addendum to [the MVP design](mvp.md) records the user's approved changes following the retirement/replacement discussion. It supersedes earlier mandatory Reviewer acceptance and role-specific validation rules. Message-board terminology is an initial design, deliberately open to future refinement.

## Management and historical retirement

Pi is either managed or unmanaged. Managed participation permits authorized Assignments and message-board subscriptions. Unmanaged Pi operates independently: no orchestration prompt, peer interruption, automatic subscription delivery, or cancellation authority.

Retirement describes a historical Agent Run binding, not a third Pi management mode. Retiring the Run removes management authority and preserves a permanent tombstone against recovery of that binding. A future explicitly authorized Adoption is a new binding, not resurrection of the retired Run; safe eligibility for re-adopting a surviving incarnation requires its own technical contract and must not weaken existing tombstone checks.

Manual takeover remains distinct: membership persists while automatic work and message delivery pause. Shared-checkout interference from unmanaged Pi is acknowledged; isolation is not required for MVP.

## Coordination

Retain the single-writer orchestration rule for the shared checkout. File-level isolation, dynamic claims, swarm-grade concurrency, and fine-grained write enforcement are deferred. Declared write sets with deterministic system admission are a possible later enhancement, not a prerequisite for the message board. Multiple Builder roles do not imply concurrent writer permission.

## Role-independent acceptance gates

An Assignment has a natural-language goal and an explicitly configured executable acceptance gate. The system executes the gate; a passing result is the task acceptance authority. A separate Reviewer agent approval is not mandatory.

Gate definitions are independent of Role and task type. Examples:

- implementation: configured tests and checks pass;
- planning: a specified plan file exists and contains content;
- research: a specified research artifact exists and contains content.

The latter gates intentionally establish artifact presence/content, not semantic correctness. Report exactly which gate passed; do not label this independent semantic review or imply more verification than the gate performs. Review agents remain useful optional participants, not compulsory completion authorities.

On gate failure, work continues within configured stopping limits. Gate execution failure or unavailable evidence is not a pass. Gate identity/version, execution context, candidate-state association, edit authority, result persistence, and completion aggregation require bounded technical contracts before implementation. The worker must not silently weaken the acceptance contract to make itself pass.

The existing Coordinator/Builder/Reviewer choreography remains a prototype/default workflow, not a required shape of the acceptance mechanism. This decision does not itself implement arbitrary DAGs or agent swarms.

## Stop orchestration

Deterministic configured conditions stop orchestration. An optional watchdog agent may submit an auditable stop request under explicitly granted authority; it does not acquire arbitrary process control.

Stopping revokes new Assignment and automatic message delivery, requests supported cooperative cancellation, and records the actual result. Already-running tools may continue; an acknowledgement of the stop intent is not proof of process/tool termination. There is no OS-level Pi kill or termination escalation in this scope. Pi remains usable and workspace changes are retained. Operator-authorized rollback is deferred.

Exact trigger schemas, budget measurement/overshoot, watchdog authorization, and cancellation acknowledgement remain technical-contract work.

## Message board

Each Project owns one durable Message Board:

```text
Project → Message Board → Channels → Threads → Messages
```

- **Board:** Project-scoped storage and communication functionality.
- **Channel:** one coherent work initiative, typically linked to a Team Goal, Assignment, or PR; for example `PR #6 — Agent Team Runs`.
- **Thread:** a focused topic/workstream such as backend, frontend, testing, planning, or research. It may span several Assignments; an Assignment may reference several threads.
- **Message:** an individual question, finding, talking point, or artifact reference within a thread.

Managed agents may post and poll messages, subscribe or be explicitly subscribed to threads/channels, and receive addressed pings. Subscription controls interest and delivery, not Assignment or writer authority. A ping does not silently create a permanent subscription. Unmanaged agents are not interrupted by board activity.

Updates are immediately available on the board and produce bounded notifications. Message content enters Pi only through explicit reads or permitted delivery boundaries, rather than unconditional injection into a busy session. Pending notifications accumulate while busy; automatic delivery pauses during manual takeover. The board is not a mirror of Pi transcripts.

Persist ordered messages and per-agent read cursors. Distinguish posted, notified, read, and acted-upon states. Prefer artifact references over repeated context copies. Only the Team Runner can authorize an Assignment; board messages cannot override that authority.

Persistence/envelopes, permissions and subscription ownership, cursor/replay semantics, notification coalescing, content-size limits, retention, and visible delivery acknowledgement require a bounded design/acceptance milestone. This direction does not imply those mechanisms already exist.

### Approved future review integration

The user approved [Plannotator artifact review through the Board](../plans/plannotator-board-review-integration.md) as a future direction, tracked in the [backlog](../backlog.md). Human review outcomes and annotations belong to an exact artifact revision and linked thread; they do not automatically create Assignments, authorize execution or replace executable acceptance gates. Plannotator remains an optional external review surface, not an orchestrator. Integration waits for durable artifact/Assignment identity and Board contracts and does not block the current Local Workbench milestone.
