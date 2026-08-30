# Omarchestra remote execution MVP scope

Status: **Locked MVP scope; feasibility pending**  
Decision date: 2026-08-30  
Parent design: [`mvp.md`](mvp.md)

This document is the authoritative remote-execution boundary for the MVP. The parent design summarizes the decision; this document owns its detailed semantics and deferrals.

## Decision

The Omarchestra MVP supports a Team Goal whose agents execute either on the local Omarchy machine or on one explicitly selected remote GNU/Linux machine reached through SSH.

The local Omarchy machine continues to provide the Agent Console and native terminal windows. The selected execution Node owns the repository, agent processes, PTYs, bridge connections, validation commands, and durable execution state.

## MVP remote boundary

1. One execution Node per Team Goal.
2. Coordinator, Builder, and Reviewer are colocated on that Node.
3. The local Node runs Omarchy, the QML plugin, and the desktop control client.
4. A remote Node may run a different GNU/Linux distribution; Omarchy, Hyprland, and a graphical desktop are not required remotely.
5. Initial remote targets are GNU/Linux x86_64 or aarch64 machines compatible with the shipped Boomux and Omarchestra binaries.
6. SSH authentication and host trust are configured by the user before a Team Goal starts.
7. Boomux, Pi, Omarchestra execution components, provider credentials, Git repository, and project tools already exist on the remote Node.
8. The MVP does not synchronize repositories or credentials between Nodes.
9. Boomux owns remote PTYs and presents their exact attachments in native terminals on the local Omarchy machine.
10. Omarchestra's execution runner and Pi bridges communicate locally on the selected execution Node.
11. The local desktop communicates with the remote Omarchestra runner through an authenticated SSH transport; it does not expose a remote public TCP service.
12. Remote agents and orchestration continue when the local terminal windows close or the local SSH connection is interrupted.
13. Reconnection restores the current durable Team Goal projection and reattaches to exact surviving terminal sessions.
14. Event gaps, stale projections, unavailable Nodes, and uncertain in-flight work are represented explicitly rather than inferred away.
15. No cross-Node team, distributed checkout, automatic remote provisioning UI, or automatic repository synchronization is included.

## Architectural consequence

```text
Local Omarchy Node
├── Omarchestra QML plugin
├── desktop coordinator/client
├── Boomux coordinating Node
└── native terminal windows
          │
          ├── Boomux federation over SSH
          └── Omarchestra authenticated stdio protocol over SSH
                         │
Remote execution Node
├── Omarchestra execution runner
├── durable Team Goal/event state
├── local Pi bridge socket
├── Boomux owning Node
├── persistent PTYs and visible interactive Pi agents
├── project checkout
└── validation commands
```

The Team Runner becomes Node-local execution authority rather than an always-local process. The local desktop consumes a projection and sends validated intents to the owning runner.

## Domain-model changes

### Execution Node

An Omarchestra-owned identity and connection profile for one machine capable of owning Projects and Agent Runs. Boomux Node IDs and SSH routes are opaque runtime/transport references, not Omarchestra domain identity.

### Project

Project identity becomes Node-qualified:

```text
(execution_node_id, canonical_absolute_path)
```

A path is never copied to or inferred for another Node.

### Team Goal

Each Team Goal selects exactly one Execution Node at creation. Its resolved Team Profile, Project, validation policy, assignments, artifacts, and Agent Runs remain owned by that Node for the lifetime of the goal.

### Runtime Binding

A remote binding includes opaque owning-Node, Workspace, Shell, Shell Run, and attachment references. Omarchestra never routes an inner Boomux resource ID without its owning Node context.

## Persistence and disconnection semantics

- Closing a local terminal detaches presentation without ending the remote process.
- Losing SSH marks the Node and affected Agent Runs disconnected or stale.
- The remote runner retains workflow state, events, artifacts, and writer authority.
- No new local intent is reported successful until the owning runner acknowledges it.
- Reconnection begins with identity verification, a durable snapshot, and an ordered event cursor/replay where retained.
- Cursor expiry or missing history produces an explicit gap followed by a fresh snapshot.
- Full remote-machine reboot recovery remains subject to Pi, Boomux, and runner session capabilities and is not implied by SSH reconnection.

## Boomux consequence

Remote execution expands Boomux's MVP role beyond local PTY persistence to include:

- Node identity and registration;
- SSH bootstrap and compatibility negotiation;
- remote daemon authority;
- Node-qualified projections;
- remote PTY attachment;
- local presentation of remote terminals;
- disconnect/reconnect behavior.

Boomux remains behind a runtime adapter, but a future replacement would need remote identity, transport, projection, and attachment semantics in addition to a PTY daemon.

## Additional feasibility spike

After the local Boomux runtime-adapter spike, run a **remote execution Node spike** against an actual non-Omarchy remote machine.

It must prove:

1. explicit Node registration and identity pinning;
2. remote prerequisite detection without modifying unrelated user state;
3. creation of one remote Workspace and three remote Shells;
4. presentation of all three remote PTYs as local native tiled terminals;
5. node-local Pi bridge and execution-runner communication;
6. local projection/intent transport over SSH;
7. agent and workflow survival across local connection loss;
8. reconnect to the same Node, Team Goal, Agent Runs, and Shell Runs;
9. remote validation execution and artifact persistence;
10. cleanup limited to spike-owned resources.

The spike must stop at human validation gates for local window presentation, physical remote identity, disconnect survival, and exact reattachment.

## Explicitly deferred

- One Team Goal spanning multiple execution Nodes
- Cross-Node writer coordination
- Repository or credential synchronization
- Automatic remote host provisioning UI
- Remote desktop rendering
- Windows or macOS execution Nodes
- Public network listeners
- Replacement of Boomux's federation implementation

## Evidence status

The local Boomux runtime-adapter is supported with constraints after automated and human validation. Remote behavior is not inferred from that local evidence; the separate remote execution Node spike is the next feasibility gate.
