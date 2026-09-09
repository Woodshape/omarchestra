# Omarchestra domain language

## Current prototype boundary

The observer/Adoption terms below are implemented only in the removable
prototype under `prototypes/first-vertical-slice/`. Its automated
protocol, privacy, registry, projection, and transaction gates are green, but
that evidence is not live feasibility or production code. R1 is an accepted
bounded risk for the current prototype contract: Pi 0.84.4 does not expose a
complete content-free start/end lifecycle for slash-command and `user_bash`
execution, so the adapter uses `ctx.isIdle()` plus its existing guards as
best-effort and records the limitation for later hardening without inspecting
content. The observer bridge has fake-only transport, gateway, Companion 0.3.0,
launcher, and reachability evidence. Its `--check` path is no-resource and its
live procedure requires a human TTY. Automation performed no live run. The
operator reported live observation verification PASS and accepted the slice
(closeout recorded 2026-09-08). Live Adoption remains unrun; no live Adoption
claim is made. Companion 0.3.0's explicit sessionless `openObservedAgents`,
`applyObservedAgents`, and `clearObservedAgents` lifecycle is fake-proven. It
opens and updates only `Unassigned Agents` state and clears it without
fabricating a Projection Session, managed cards, managed cursor, Team Goal,
Role, Assignment, Agent Run, or managed authority. The immutable historical
managed default remains Companion 0.2.0.

The separate live-Adoption engineering integration is now fake-tested and
independently reviewed, with Companion 0.4.0's additive Adoption session,
actual same-Pi acknowledgement/readiness, durable takeover and challenged
recovery. Historical 0.2.0/0.3.0 artifacts remain unchanged. Installation and
human live Adoption validation are still unrun; engineering completion is not
live evidence. Details: `prototypes/first-vertical-slice/docs/live-adoption-engineering-handoff.md`.

## Core terms

### Team Goal

One durable orchestration attempt for a user goal. A Team Goal selects exactly one Execution Node and owns its workflow, roles, assignments, artifacts, runtime bindings, and outcome.

### Agent Run

One exact visible coding-agent process performing one Role in a Team Goal. An Agent Run is managed by the Team Runner and bound to an exact terminal process run.

### Observed Pi Session

A visible interactive Pi session that reports structured lifecycle facts to Omarchestra but is not part of a Team Goal. Observation grants no assignment, control, writer, PTY, or process-lifecycle authority.

### Adoption

The explicit transition that binds one exact Observed Pi Session to a Team Goal on the same Execution Node and to one Role as an Agent Run. Adoption requires current-session identity, same-process acknowledgement, user confirmation, and reconciliation; discovery alone never adopts a session.

### Retirement

An explicit, durable, irreversible removal of a disconnected or exited Agent Run's orchestration authority. It releases Role occupancy but preserves historical records and identity tombstones. It neither terminates the process nor proves checkout writer safety. Approved policy; implementation pending.

### Replacement

Fresh Adoption of a new visible Pi process into a retired Run's vacated Role, linked to its predecessor. The user may manually resume Pi conversation history, but history does not restore Agent Run identity or automatically resume Assignments. Approved policy; implementation pending.

### Role

A declared responsibility within a Team Goal, such as Coordinator, Builder, or Reviewer.

### Assignment

A unit of work routed by the Team Runner to one Agent Run. It has explicit input, write authority, dependencies, state, and expected output.

### Companion Plugin

The durable, explicitly installed Omarchestra product surface in the Omarchy shell. Its presence is installation state, not Team Goal state, and it owns no agent, workflow, PTY, or durable orchestration authority.

### Projection Session

An ephemeral presentation relationship between one Companion Plugin instance and an Omarchestra projection source. A Projection Session may open, update, reconnect, hide, and clear UI state without installing or unloading the Companion Plugin.

### Team Runner

The authority for Team Goals, roles, assignments, workflow, artifacts, and presentation projections on one selected Execution Node.

### Execution Node

An Omarchestra-owned identity and connection profile for one machine capable of owning Projects, Team Runners, and Agent Runs.

### Runtime Binding

Opaque references connecting an Agent Run to its terminal runtime. Runtime bindings are replaceable infrastructure metadata, not Omarchestra domain identity.

### Manual Takeover

The control mode entered when a user directly steers a managed visible agent. Dependent orchestration pauses until the affected work is explicitly reconciled.
