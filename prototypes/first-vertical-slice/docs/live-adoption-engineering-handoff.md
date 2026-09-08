# Live Adoption engineering handoff

Status: **bounded engineering implementation complete; fake acceptance green;
independent read-only review PASS; human installation and live validation unrun.**

The original partial work is checkpointed at `add63d8`; initial authority fixes
are at `7d7a314`. The historical failed Fusion findings are preserved in
[the archived handoff](history/live-adoption-engineering-handoff-before-completion.md).
This completion does not retroactively accept those scaffold results.

## Implemented boundaries

- **F12:** `LiveAdoptionPresentation` opens an actual, random-generation-bound
  Companion Adoption session, validates the loaded 0.4.0 method surface and
  installation fingerprint, polls bounded intents, deduplicates them, and
  publishes combined authoritative observed/managed snapshots. Publication
  failure is latched. QML expires stale actionable presentation after two
  seconds. The manual gateway uses this adapter, not a parallel fake router.
- **F13:** One gateway registry preserves connection metadata and propagates
  lifecycle/expiry/disconnect. Final identity, sequence, lease, proposal,
  authorization, Node, goal and Role checks share the synchronous transaction.
- **F14:** The actual manual extension retains its acknowledged proposal only
  within the surviving Pi session, answers fresh recovery challenges, receives
  the original commitment, and sends a post-activation readiness receipt.
  SQLite binding tombstones survive observed-ID changes. `--resume` requires
  original DB/socket ownership evidence and a separate SQLite exclusive
  ownership lock; a second live gateway cannot acquire it. SIGKILL leaves
  recovery resources intact. Pi/extension restart and reboot are **not** covered.
- **F15:** Same-connection readiness follows committed delivery and bridge
  activation, renews a bounded lease, and is revoked on disconnect/expiry.
  The manual extension's input hook reads only `source`, never content, always
  continues Pi input, and reports interactive takeover. Takeover is durable,
  reaches Pi and Companion, and prevents readiness from resuming on reconnect.
  Interactive input during gateway loss is retained as a source-only pending
  flag and reconciled before readiness, even if the committed frame was lost.
  Adoption creates no Assignment. Return-to-team/work dispatch is outside this
  disposable Adoption slice; no new dispatch implementation is claimed.
- **F16:** The composed tests use the real Companion adapter, framed channel,
  gateway/runner, manual Pi extension, and SQLite. Both delivered and lost
  committed-frame cases recover through fresh transports without a second
  commit. They also prove durable takeover survives reconnect. QML methods
  execute in an isolated JS context and the complete 0.4.0 package is linted.
- **F17:** Ownership is captured at creation, not at cleanup. Substituted files,
  parent directories, symlinks, unrelated manifest paths and unknown sidecars
  fail closed. Only the gateway holding the ownership lock removes DB files;
  the launcher checks absence rather than racing a resumed writer. Success
  requires machine-observed commit/readiness/takeover/pre-cleanup disconnect
  and no Assignment, exact cleanup, plus explicit operator UI attestation.
  A normal exit alone cannot produce PASS.
- **F18:** Companion 0.4.0 is an additive catalog release with a separate
  Adoption panel/session. Historical 0.2.0 and 0.3.0 assets and defaults remain
  unchanged. Runtime code performs no installation, enable, rescan or unload.
  Adopted runs retain `runtimeBinding = null` and guarantee `unavailable`.

## Review and evidence

A fresh read-only LUNA review (`openai-codex/gpt-5.6-luna`, low thinking)
returned **PASS — bounded engineering readiness** after the recovery and
verdict corrections. It did not run tests or live integrations. Local review
trace: `/tmp/adoption-luna-final-review.jsonl`. An earlier reviewer attempt
produced no output before timeout; the first completed review identified gaps
and also requested out-of-scope Pi-crash recovery and an incorrect idle
prerequisite for takeover. Those two requests were rejected against the locked
same-process-survival and human-intervention contracts, not silently weakened.

Reproduce fake engineering acceptance with:

```sh
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-live-adoption-check
```

The final dedicated gate passes **78/78**. Detailed counts and evidence limits
are in [the completion ledger](../evidence/live-adoption-completion.md).

The other regression recipes are `prototype-live-observer-check`,
`prototype-observer-adoption-check`, `prototype-companion-check`,
`prototype-live-agent-console-check`, `prototype-vertical-slice-manual-check`,
and `prototype-vertical-slice` (default/WAL).

## Remaining human boundary

No installed Companion or global Pi configuration was modified, and no live
Adoption procedure was run. Engineering no longer requires the hard-coded
incomplete guards: both entrypoints retain TTY checks, and the gateway requires
its exact authorization phrase before opening authority resources. A separate
explicit setup must install 0.4.0 before the human procedure. See
[live validation](live-adoption-live-validation.md). Human PASS remains unclaimed.
