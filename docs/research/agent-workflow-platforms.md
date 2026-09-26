# Durable workflow and agent platforms: Trigger.dev and Inngest

Status: **Research and future options only; no product or architecture decision.**

This note compares Trigger.dev and Inngest as possible infrastructure for Omarchestra agent workflows. It incorporates the clarification that both platforms can stream agent activity: streaming is a viable observation layer, but it does not itself provide a visible Pi TUI, PTY ownership, or Omarchestra's authority model.

## Executive summary

- **Current Omarchestra core:** keep the Team Runner as the authority for Team Goals, Assignments, acceptance gates, artifacts, and workflow state on the selected Execution Node. Keep visible Pi as the managed coding agent and Boomux as terminal-runtime owner.
- **Trigger.dev:** strong background-task primitives and a good fit for managed, isolated async workloads. Its AI Chat/Realtime features can stream responses to a viewer. Its worker execution model is less naturally colocated with the user's selected Execution Node unless an explicit local bridge or worker placement is designed.
- **Inngest:** durable, event-driven functions execute on application compute using either an HTTP `serve()` endpoint or an outbound `connect()` worker. That offers a more direct path to node-local execution, but worker routing/affinity to the exact Omarchestra Execution Node still needs proof. AgentKit provides multi-agent networks, routers, tool calls, human waits, and streaming.
- **Future swarm/team-run viewer:** either could power a distinct headless/remote-agent execution mode with a browser or Companion observation surface. The UI can show run state, assistant messages, tool activity, and links to Board threads. This would be a deliberate product-scope extension: today's locked MVP describes visible interactive Pi processes and defers hidden/headless agents and arbitrary workflow DAGs.
- **Neither platform should silently become the canonical source of Team Goal or Assignment state.** Treat platform run IDs and streams as execution references/events. The Team Runner should validate and commit authority-bearing state transitions.

## Omarchestra constraints relevant to this evaluation

The authoritative design establishes these boundaries:

- One Team Goal selects one Execution Node; the owning Node has the repository, Team Runner, bridges, validation, artifacts, and durable workflow state.
- A managed Agent Run is an exact visible interactive Pi process. A hidden worker must not do the work represented by that visible agent.
- Boomux owns PTY/process lifetime and terminal attachment. Pi owns its conversation/model-session semantics. The Team Runner owns workflow and assignment authority.
- The Companion is a projection client, not a task scheduler or state authority. The Project Message Board is structured coordination, not a transcript mirror.
- The approved coordination direction retains a single writer, makes task acceptance depend on an explicit executable gate rather than a mandatory Reviewer, and does not itself approve arbitrary workflow DAGs or swarms.

Consequently, engine-level completion, agent output, or cancellation cannot by itself establish that an Omarchestra Assignment passed its gate, that a Role is vacant, or that an agent process stopped.

## Platform profiles

### Trigger.dev

Trigger.dev is a durable task platform: task code is deployed to Trigger.dev workers and runs with queues, retries, idempotency, concurrency controls, tracing, and waitpoints. Its AI examples include orchestration with parallel task batches, durable chat agents, and sub-agents.

**Streaming is supported.** `chat.agent()` streams messages through Trigger's AI Chat transport; regular tasks can stream data through Realtime streams. Sub-agent tool patterns can stream preliminary worker output to a parent agent. A browser-based team-run viewer therefore fits its documented model. A QML client would need an adapter/authentication path rather than React hooks, but the platform is not limited to displaying only run status.

Important distinctions and caveats:

- The documented AI Chat model is a Trigger-managed agent/session and stream, not an interactive Pi TUI or Boomux PTY. It can provide message-level observability without providing native-terminal identity or interaction.
- Cloud workers execute in Trigger's isolated worker environment. A task does not automatically have the selected Execution Node's checkout, owner-only sockets, provider credentials, or Boomux daemon.
- Trigger documents self-hosting as a webapp plus worker deployment. Its current self-host feature table marks checkpoints and autoscaling unavailable; do not assume Cloud wait/suspend economics or capabilities apply to self-hosted deployments.
- Idempotency keys deduplicate task triggers, not arbitrary effects in Pi, the filesystem, a database, or an external service. Retry-safe bridge operations and durable Runner transactions are still needed.

### Inngest

Inngest is an event-driven durable execution engine. Functions are written in ordinary TypeScript, Python, or Go. `step.run()` records completed work and its result; on replay, completed steps are memoized while the function walks the prior path and continues. `waitForEvent`, sleeps, retries, concurrency, throttling, batching, and event triggers support long-running workflows.

**The execution placement differs usefully from Trigger.dev.** With `serve()`, Inngest invokes an HTTP endpoint in the app. With `connect()`, a long-running app worker opens an outbound WebSocket connection to Inngest and receives work without requiring a public inbound listener. This could let Omarchestra execute selected functions on an Execution Node, but routing a given Team Goal to exactly its owning Node is not established by the general worker-pool documentation. Treat Node affinity as an open integration contract, not an automatic property.

Inngest also has **AgentKit**, a TypeScript library for single agents and multi-agent Networks. Networks share state/history and use code-based or model-based routing. AgentKit supports streamed agent events, including text/tool activity, through Inngest Realtime; its streaming publisher is transport-agnostic, while its documented ready-made hooks are React-oriented. An Omarchestra Companion could consume a normalized stream through a backend adapter.

Important distinctions and caveats:

- Durable function replay is not preservation of one long-lived interactive process. Completed steps are replayed from stored results; process-local mutable state should not be the source of truth across step boundaries. A Pi TUI/PTY still belongs under the Runner and Boomux.
- Side effects must be placed inside durable steps and designed to tolerate the boundary between performing an effect and recording its result. Stable IDs, Runner outbox/acknowledgement semantics, and reconciliation remain necessary.
- Inngest cancellation stops a function between steps; an already executing step is allowed to finish. That is not proof that an external Pi process or tool stopped, and it does not replace Omarchestra's cooperative stop and acknowledgement contract.
- AgentKit Network routing is an agent-workflow mechanism, not Omarchestra's Assignment admission, writer lease, or executable-gate authority. An LLM router may suggest which worker runs next; it must not silently change the acceptance contract.
- Inngest supports a self-hosted single-node server. Its docs describe SQLite as the default persistence and an embedded in-memory Redis for the simple setup, with external Redis/Postgres options. Self-hosting places uptime, data integrity, upgrades, and security on Omarchestra. The CLI describes the single-node server as beta in its command help, and the docs disclaim a direct support guarantee for self-hosted deployments.

## Use-case categorization

| Omarchestra use case | Trigger.dev | Inngest | Assessment |
|---|---|---|---|
| Webhook-driven GitHub/issue/PR integrations, notifications, scheduled non-sensitive jobs | Strong | Strong | Good adjacent work. The Runner still decides whether an event changes a Goal, Assignment, or Board. |
| Batch model/profile evaluation against fixed fixtures | Strong | Strong | Useful development/evaluation infrastructure. Do not treat an LLM score as a live Assignment gate unless the product explicitly defines that executable contract. |
| Parallel read-only research or analysis over an immutable artifact/commit | Strong | Strong | Can produce a proposal/supporting Artifact. Do not grant shared-checkout write authority or let a hidden worker satisfy a visible Agent's Assignment. |
| Test-failure triage or research enrichment | Good as a sidecar | Good as a sidecar | Label as auxiliary work and let a visible agent or user decide how to use it. Preserve source and revision references. |
| Human waits for external approval | Strong | Strong | Use waitpoints/`waitForEvent` as wake-up mechanisms. The Runner validates exact Goal/Assignment/artifact revision and records the authoritative decision. |
| High-level viewer for many headless agents, streaming assistant messages and tool progress | Strong | Strong; AgentKit has a direct network/event-stream path | Promising future mode. Browser view may be quickest; QML can render a normalized stream through a projection adapter. Requires content policy, retention, reconnect/replay, and auth design. |
| Visible managed Pi assignment dispatch, process lifecycle, PTY persistence, manual takeover | Poor as authority | Poor as authority; local `connect()` workers may be a useful adapter | Preserve the existing Runner/bridge/Boomux chain. An engine task may request an action, not claim it happened. |
| Deterministic acceptance gate against the owning checkout | Weak unless a node-local executor is proven | Better placement options via `connect()`, but still not automatically authoritative | Keep execution and candidate-state association with the owning Runner. Record exact gate version/context/result there. |
| Arbitrary user-defined workflow DAGs or unrestricted agent swarms | Technically attractive | AgentKit Networks and Workflow Kit are directly relevant | Product-scope extension, not an implementation shortcut. Single-writer, stop, acceptance, permissions, and visible-execution rules still apply. |

### Where each is most interesting

**Trigger.dev** is most compelling when Omarchestra wants managed durable background jobs, parallel async analysis, or a Trigger-native agent session with streamed responses. Its task queues and traces suit sidecar work; its AI Chat and sub-agent streams could support a future browser-based run inspector. Its Cloud worker placement is a drawback when a task needs the selected Node's local checkout or execution authority.

**Inngest** is most compelling when Omarchestra wants event-driven durable orchestration while keeping function code on app-owned compute. `connect()` could be explored as a node-local worker channel, and AgentKit Networks plus realtime events map naturally to a swarm viewer. The unresolved issue is not whether Inngest can run code locally or stream events; it is how exact Node affinity, process lifetime, assignment authority, and durable Omarchestra state interact with its function replay model.

## Future directions (not approved scope)

These are research candidates, not product commitments or changes to the locked MVP.

### 1. Keep both platforms outside the MVP execution path

Continue with the Node-local Team Runner and existing Pi/Boomux authority boundaries. Reconsider external engines only for a concrete workload that the Runner should not own, such as third-party integrations, offline model evaluations, or optional read-only enrichment.

### 2. Add a background-job adapter for auxiliary work

If useful, define a narrow Omarchestra-owned port for optional jobs. Pass identifiers and immutable Artifact/commit references rather than broad repository access. Store a platform run ID only as opaque metadata. The Runner should commit any accepted result and expose it through its own ordered projection; the platform is not the source of Goal state.

### 3. Explore an explicit Agent Swarm execution mode

A future Team Run could consist of platform-managed/headless agents with a high-level viewer that shows each worker's status, selected assistant messages, tool activity, and links to Board threads. This is distinct from a managed visible Pi Agent Run unless the product design deliberately changes that definition.

Before such a mode is accepted, define at least:

- Worker/Agent identity and relationship to Goal, Assignment, Role, and predecessor/replacement records.
- Whether workers execute on the selected Node, in a sandbox, or in a provider-managed environment; how access to source, secrets, and untrusted code is bounded.
- Which assistant messages, tool calls/results, reasoning fields, and Board context are stored or streamed, to whom, and for how long.
- How streams reconnect, replay, deduplicate, and represent gaps without becoming canonical lifecycle state.
- How workers read/post Board messages; a Board ping is not an Assignment, and Board threads must not become an accidental transcript dump.
- Who owns write admission, candidate state, gates, cancellation requests, and stop acknowledgement. Keep one writer and make exact gate evidence Runner-owned.
- Whether the mode supports manual takeover or has a different human-control contract.

### 4. Use engine events as a projection input, not an authority channel

A future stream adapter could normalize provider events into bounded presentation events (e.g. worker started, assistant text delta, tool started/completed, result available). Use exact Team Goal/Assignment/worker IDs and generation checks. Keep user intents and authority-bearing transitions on the validated Runner protocol. For the current Companion, that is preferable to giving QML direct platform credentials or allowing a platform event to mutate managed state.

## Bounded evaluation questions if this becomes actionable

A later comparison should test one small, non-production slice against both engines, with no live terminal or repository mutation:

1. Can the same run stream assistant text, tool events, and status to a browser and to a normalized Companion projection, including reconnect and event-gap behavior?
2. Can a worker be proven to execute on the exact Goal-owning Node, including when multiple Nodes are online and one disconnects? For Inngest Connect, prove routing/affinity rather than assuming it from `instanceId` or worker concurrency.
3. What happens if a worker crashes immediately before or after dispatching an external side effect? Verify retries do not duplicate Board messages, Assignment delivery, gate execution, or artifacts.
4. How do deployment/version changes affect in-flight Goals, persisted workflow state, and explicit retry/replay? The frozen Team Profile/gate contract must not silently change.
5. Can human approval and stop requests be delivered as Runner-validated events without exposing a bearer capability that grants broader authority?
6. What content reaches platform logs/traces, provider APIs, and durable conversation history? Can the required privacy/retention policy be enforced?
7. What is the actual self-hosted install, upgrade, backup, recovery, and support burden on a local Omarchy Node and a remote execution Node?

This is a proposed evaluation checklist, not an approved spike or permission to run live-system tests.

## Sources

### Trigger.dev

- [Introduction and core concepts](https://trigger.dev/docs/introduction)
- [AI-agent examples](https://trigger.dev/docs/guides/ai-agents/overview)
- [Tasks](https://trigger.dev/docs/tasks/overview), [queues and concurrency](https://trigger.dev/docs/queue-concurrency), [idempotency](https://trigger.dev/docs/idempotency)
- [AI Chat overview](https://trigger.dev/docs/ai-chat/overview), [Realtime streams](https://trigger.dev/docs/realtime/overview), [sub-agents](https://trigger.dev/docs/ai-chat/patterns/sub-agents)
- [Claude Agent SDK guide](https://trigger.dev/docs/guides/ai-agents/claude-code-trigger)
- [Self-hosting overview](https://trigger.dev/docs/self-hosting/overview)

### Inngest and AgentKit

- [Inngest docs index](https://www.inngest.com/llms.txt)
- [Durable execution](https://www.inngest.com/docs-markdown/learn/how-functions-are-executed), [serving functions](https://www.inngest.com/docs-markdown/learn/serving-inngest-functions), [Connect workers](https://www.inngest.com/docs-markdown/setup/connect)
- [Self-hosting](https://www.inngest.com/docs-markdown/self-hosting), [Realtime](https://www.inngest.com/docs-markdown/features/realtime), [cancellation semantics](https://www.inngest.com/docs-markdown/features/inngest-functions/cancellation), [user-defined workflows](https://www.inngest.com/docs-markdown/guides/user-defined-workflows)
- [Durable Agents](https://www.inngest.com/docs-markdown/learn/durable-agents), [AgentKit](https://agentkit.inngest.com/), [AgentKit streaming](https://agentkit.inngest.com/streaming/overview), [AgentKit Networks](https://agentkit.inngest.com/concepts/networks), [AgentKit human-in-the-loop](https://agentkit.inngest.com/advanced-patterns/human-in-the-loop)

### Omarchestra decisions

- [MVP design](../design/mvp.md)
- [Agent coordination direction](../design/agent-coordination.md)
- [Remote execution boundary](../design/remote-execution.md)
