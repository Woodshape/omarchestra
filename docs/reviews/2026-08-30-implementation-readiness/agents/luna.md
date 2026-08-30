## Blocking decisions

The document explicitly leaves these eight decisions open:

1. **Workflow topology and gates**  
   Confirm the fixed Coordinator → Builder → Reviewer → correction → integration flow. Define retry count, transition conditions, and artifact acceptance rules.

2. **User intervention**  
   Decide whether users may type into agents during assignments. Specify how manual actions affect assignment ownership, state, cancellation, and audit events.

3. **Window creation policy**  
   Decide whether all three terminals launch immediately or waiting roles launch later. Define behavior after terminal closure and reopening.

4. **Model configuration**  
   Decide whether role models are fixed or selectable. If selectable, define allowed models, defaults, and whether model changes apply only to new runs.

5. **Approval semantics**  
   Enumerate `needs_attention` causes and identify which can be resolved from QML versus requiring native-terminal interaction.

6. **Interrupted-run recovery**  
   Decide whether MVP supports resumable Task Capsules. The current restart rule only moves work to `needs_attention`, so “resume” behavior remains unspecified.

7. **Validation requirements**  
   Decide whether reviewer output alone permits integration or whether the runner must execute deterministic project commands. If commands are required, define command selection, timeout, environment, and failure handling.

8. **Completion semantics**  
   Decide whether the Coordinator integrates automatically after review or waits for explicit user acceptance/rejection.

## Additional implementation blockers

These are not listed as open decisions but still prevent an implementation-ready specification:

- **Target repository, languages, and toolchain** are unspecified.
- **Pi bridge contract** is undefined: extension API, assignment protocol, event schema, identity binding, reconnect behavior, and supported telemetry.
- **Boomux runtime contract** is undefined: exact CLI capabilities, process survival after window closure, reconnect semantics, event cursors, and failure behavior.
- **Persistence design** is unspecified: database/file format, transaction boundaries, snapshot schema, event retention, and recovery rules.
- **Runner/QML protocol** is unspecified: snapshot, event, intent, acknowledgement, error, and idempotency schemas.
- **Shared-checkout enforcement** is underspecified. “Read-only by orchestration contract” does not define whether or how writes by Coordinator/Reviewer are detected or prevented.
- **Cancellation and retry boundaries** are unspecified, especially for an agent currently running a tool or holding the shared checkout.
- **Project command and environment policy** is absent, including repository validation, dirty-worktree handling, and allowed working directory.

The eight numbered items are product decisions. The bridge, Boomux, persistence, and protocol contracts are feasibility/specification work that must be completed before implementation delegation.