# Local Workbench v1 — Phase 2 human management walkthrough (separately authorized)

**Status: not performed, not authorized, zero-dispatch.** This document is the script for a human operator checkpoint. The Phase 2 automation did not run any part of it, and none of it is authorized by the Phase 2 task or by the Phase 2 closeout. It requires a separate, explicit authorization, because it is the only step that touches a real Project and a real Pi. At no point may it deliver an Assignment or execute an acceptance check.

The independent final authority verdict on Phase 2 is **FAIL**, and it states explicitly that the workbench is not ready for this walkthrough. The precondition to authorize it is closure or explicit operator acceptance of the open Phase 2 requirements in [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md) section 2, at minimum the P0 items, plus a recorded authorization.

Nothing here installs software, changes user configuration, or delivers an Assignment.

The [final integration result](local-workbench-v1-phase-2-integration-result.md) supersedes the task-level instructions below. Submodule refusal now has a disposable real-Git regression. The missing real bridge, challenged recovery and native open/hide still block this walkthrough. EOF stops the runner, it is not presentation-only hide. Do not run these steps as an acceptance procedure until the complete Phase 2 gate passes.

## Preconditions

1. A disposable local Git worktree with at least one commit, outside every workbench state root.
2. A state root owned by the operator with mode `0700`, on local storage.
3. Node `v26.8.1` or later on `PATH`.
4. Separate authorization for this checkpoint, recorded before starting.

## W1 — read-only inspection

```bash
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts inspect --path <worktree>
```

Expect one `inspection` record naming the canonical path, Git common dir, HEAD and dirtiness, with `supported: true`. Point it at a non-repository and expect exit `1` with `inspection: null` and a reason.

## W2 — register and confirm

```bash
node --experimental-strip-types packages/local-workbench-v1/runner/main.ts start --state-dir <state>
```

Send `{"kind":"inspect_project","target":null,"payload":{"path":"<worktree>"}}`. Expect `submitted` then `acknowledged`, and a projection whose `details` contains one `registration` entry. Confirm it with `confirm_register_project` naming that exact `registrationId`. Expect one `project_registered` event, the Project selected, and `details` empty.

## W3 — Goals and checks

Create one Team Goal and one Project-scoped check through the emitted intents, using each projection's own `revision`. `+ New check` opens the definition editor rather than submitting anything: the Create control stays disabled until the name, summary and closed definition fields validate. Expect one event per mutation, and a check at version 1 with a digest.

## W4 — observe and adopt one visible Pi

The real adoption path needs an observer transport. Without one the observed-Pi list is empty and no proposal exists, which is the honest Phase 2 state. If a Pi bridge is authorized later, observe one session, propose, authorize, acknowledge and confirm readiness. Expect the delivery and readiness records to name the same frozen proposal digest, and expect no Assignment delivery at any point.

## W5 — retire, replace, purge

Expect retirement to keep the immutable predecessor, replacement to record a new generation naming the predecessor, and purge to be refused while any non-purged successor binding exists, including one that is already retired. A purged generation must never be reusable.

## W6 — restart

End the session with EOF, then run `status --state-dir <state>` and `backup --state-dir <state>`. Expect the Project, Goal, check and events to be present, and expect `restoreSupported: false`.

## What to record

1. The worktree path, state root and Node version.
2. Every record the walkthrough produced, verbatim.
3. Any divergence from the expectations above, including any event or acknowledgement that was not produced.
4. Whether any Assignment delivery or check execution occurred. Any occurrence is a Phase 2 defect, not a limitation.
5. The native-theme, compositor and geometry observations that offscreen Qt cannot cover.
