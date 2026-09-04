---
status: accepted
---

# Use connection-bound random capabilities for ordinary Pi identity

An ordinary Pi observer identifies its current process, Pi session, and
extension incarnation with independent cryptographically random opaque values
created inside the visible Pi process. The local Agent Registry binds those
values to its configured Execution Node and to one current transport
connection, then issues fresh connection and Adoption challenges. Adoption
acknowledgement is valid only on that exact connection for the exact current
identity and immutable authorized proposal.

PID plus Linux process-start time and boot identity was rejected. It adds
procfs coupling and process-timing metadata without replacing the need for a
current same-process extension acknowledgement. PID remains optional restricted
diagnostic metadata and never authorizes correlation, reconnect, or Adoption.
If an extension reload cannot retain a process capability, it creates a fresh
identity and loses continuity rather than correlating by PID, cwd, terminal
title, focus, recency, display name, or equal strings.

This is functional same-process proof within Pi's public extension surface and
the owner-only local channel, not OS process attestation. If that surface cannot
preserve the exact current identity and acknowledgement contract, the observer
prototype must stop rather than weaken the boundary.
