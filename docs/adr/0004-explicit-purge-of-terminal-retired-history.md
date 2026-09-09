---
status: accepted
---

# Explicit purge of terminal retired history

## Decision

Retirement history is retained by default, but the user may explicitly
choose **Delete Retired History** for a terminal retired Agent Run.

A purge is allowed only when no replacement commit names that Run as its
predecessor. If a replacement descendant exists, the predecessor purge is
blocked; the user must purge descendants newest-to-oldest. This preserves
predecessor linkage for every retained record and avoids silently rewriting
lineage.

Purge removes the selected Run's Omarchestra durable Adoption/retirement
history records, presentation card, and associated retirement/Adoption events.
It retains only a minimal exact-binding security fence, which is not a Run,
history card, or reconstructable orchestration commitment; late frames or a
same-binding reconnect therefore remain rejected. Purge does not delete or
modify Pi conversations, session files, processes, tools, checkouts, artifacts,
or any external resource. Purge is never automatic and requires an explicit UI
confirmation.

The Role vacancy-generation high-water mark survives purge. Removing a
record must not allow a stale replacement proposal from an earlier
Generation to become valid after restart or cleanup.

## Rationale

Retained cards are useful for reconciliation and lineage, but an unbounded
history makes the Agent Console unusable over time. A leaf-only purge gives
operators cleanup authority without deleting a predecessor still needed by a
retained replacement link. The contract keeps process and Pi-history
boundaries unchanged and treats purge as a separate destructive operation,
not as a side effect of retirement.

## Consequences

- The retired-card presentation exposes a disabled explanation when a
  replacement successor must be purged first.
- Durable stores need a purge transaction, a persistent vacancy high-water
  mark, and a minimal non-presented binding fence.
- Historical Adoption commitments are immutable while retained; explicit
  purge is the only user-authorized deletion path.
- Automated and human gates must cover successful leaf purge, blocked
  predecessor purge, restart reconstruction, and stale-generation fencing.
