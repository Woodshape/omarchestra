Not implementation-ready. The eight explicit Open decisions must be resolved, and four execution contracts are still unspecified.

F1. Resolve the proposed workflow and finalization rules: topology, validation command versus reviewer-only approval, and automatic versus user-approved completion.

F2. Define human intervention semantics. Unrestricted terminal typing can invalidate assignment state, artifacts, and retry behavior unless the runner defines observe, pause, takeover, resume, and override rules.

F3. Choose lifecycle presentation: the document requires all agents be created at goal start but leaves whether waiting windows open immediately unresolved.

F4. Lock model configuration and approval routing: per-role defaults versus form selection, plus which attention states the console can clear versus terminal-only resolution.

F5. Explicitly defer Task Capsules or specify their MVP resume behavior. The current “post-MVP unless selected” language conflicts with the open MVP decision.

F6. Specify the Pi bridge contract after the feasibility spike: handshake identity/authentication, assignment/control message format, event types and ordering, reconnect reconciliation, and what telemetry is actually guaranteed.

F7. Specify the Boomux adapter contract: exact CLI/version, creation and persistent-process semantics, close-versus-window-close behavior, focus/reopen behavior, lifecycle subscription mechanism, and failure handling.

F8. Choose the implementation boundary: target repository or monorepo, languages/toolchain, persistence backend, event/snapshot schemas, intent schemas, and migration/recovery rules.

The highest-risk blocker is F2. Without a defined relationship between user terminal input and runner authority, “managed” agent state cannot be truthful or safely orchestrated.