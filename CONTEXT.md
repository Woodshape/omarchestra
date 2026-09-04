# Omarchestra domain language

## Current prototype boundary

The observer/Adoption terms below are implemented only in the removable
fake-only prototype under `prototypes/first-vertical-slice/`. Its automated
protocol, privacy, registry, projection, and transaction gates are green, but
that evidence is not live feasibility or production code. R1 remains open:
Pi 0.84.4 does not expose a complete content-free start/end lifecycle for
slash-command and `user_bash` execution, so live observer/Adoption validation
must wait for a public signal or an explicitly recorded reconciliation-contract
revision.

## Core terms

### Team Goal

One durable orchestration attempt for a user goal. A Team Goal selects exactly one Execution Node and owns its workflow, roles, assignments, artifacts, runtime bindings, and outcome.

### Agent Run

One exact visible coding-agent process performing one Role in a Team Goal. An Agent Run is managed by the Team Runner and bound to an exact terminal process run.

### Observed Pi Session

A visible interactive Pi session that reports structured lifecycle facts to Omarchestra but is not part of a Team Goal. Observation grants no assignment, control, writer, PTY, or process-lifecycle authority.

### Adoption

The explicit transition that binds one exact Observed Pi Session to a Team Goal on the same Execution Node and to one Role as an Agent Run. Adoption requires current-session identity, same-process acknowledgement, user confirmation, and reconciliation; discovery alone never adopts a session.

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
