# Phase 2 canonical collaboration result

Status: **INCOMPLETE. Engineering acceptance FAIL. Not ready for a human management walkthrough.**

This final sequential integration record supersedes the task 6.a gate-green wording in the [earlier closeout](local-workbench-v1-phase-2-closeout.md). Existing work is preserved. The authorized complete management journey was not delivered. Remaining blockers are implementation deficiencies against accepted Phase 2 contracts, not requests for new product-policy decisions.

## Subsequent direct implementation

The [S1 persistence and binding/fence checkpoint](../reviews/local-workbench-phase-2-verification/binding-fence-checkpoint.md) now passes its bounded durable-substrate gate. It supersedes the original ownership/backup and full-row-purge implementation facts below, not this overall FAIL result. The later S2 command/source checkpoints also pass. The [S3 Project-context checkpoint](../reviews/local-workbench-phase-2-verification/project-context-checkpoint.md) added directory identity, fail-closed Git facts, startup/operation revalidation and explicit transactional reconfirmation through offscreen QML. The later [S3 check-resource checkpoint](../reviews/local-workbench-phase-2-verification/check-resources-checkpoint.md) now passes runner-resolved versioned check definitions (store schema 8), including executable/resource hashes and offscreen QML create/edit. Neither checkpoint has independent final review. The [S4 real bridge checkpoint](../reviews/local-workbench-phase-2-verification/real-pi-bridge-checkpoint.md) now tests an actual Pi extension adapter, bounded owner-only socket and exact-identity registry against a fake host. The subsequent [S5 framed Adoption checkpoint](../reviews/local-workbench-phase-2-verification/framed-adoption-checkpoint.md) now connects operator intent, challenged ACK, Goal-scoped Run commitment and delivery, readiness, surviving-extension recovery, takeover, retirement and purge through a disposable paired fake Pi. Current store schema is **9**; prior schema-8 development roots fail closed without an explicit supported upgrade. The legacy object-event manager remains only for historical injected tests; native owner/Companion/QML composition is still S6 work under the [completion sequence](../plans/local-workbench-v1-phase-2-completion.md). The Phase-2 recipe still intentionally exits **1/BLOCKED** (latest host run: foundation 41/41, management 187/187, presentation 83 pass/5 TODO, audits 38/38, offscreen QML 18 rows). No independent overall review or human management walkthrough has passed. The collaboration findings below describe its original delivered tree, not these later repairs.

## D1. Final integration changes

ASTRA inspected all task reports and the shared checkout, then made these bounded corrections as the sole active final writer:

- Backup filename collisions and dangling metadata symlinks are refused without deleting existing targets. Failed VACUUM output is preserved, not unconditionally removed. Metadata creation is exclusive. Backup rotation ownership and full integrity verification remain open F11 work.
- Git inspection uses an absolute Git binary, a constructed environment, disabled global/system configuration, disabled fsmonitor and optional index writes. Selected submodule roots are refused through the public superproject query. Failed superproject queries fail closed.
- Registration rejects a Project containing the state root, and rechecks overlap at confirmation. Repository replacement at identical paths and startup resource/context verification remain open F9 work.
- Connected manual takeover cannot authorize retirement. Disconnect/restart preserves the manual-control marker while projecting disconnected status through `manual_takeover_disconnected`. This is a management state enum addition, not Assignment recovery. Exact per-connection lifecycle and Goal-scoped membership remain open F3/F5 work.
- Added four disposable integration regressions and updated the existing retirement journey to require disconnection for both original and replacement Runs.
- The Phase 2 recipe now runs its implemented subset and exits **1 with BLOCKED**, rather than printing complete acceptance PASS without the required bridge/recovery assertions. This explicit completion block must be replaced by executable full-chain acceptance when the missing implementation exists. It is not a passing Phase 2 gate.

New test: `packages/local-workbench-v1/test/phase-2-integration-safety.test.ts`.
Modified runtime: `runner/backup.ts`, `git-context.ts`, `authority.ts`, `store.ts`, `adoption.ts`, `recovery.ts`, `projection.ts`.
Modified tests/gate: `phase-2-authority.test.ts`, `source-audit.test.mjs`, `scripts/phase-2-gate.sh`.

## D2. Working versus unavailable

Working in the implemented subset: persistent Project/Goal/check-draft records, basic versioning, actual QML registration/check/Adoption intents through the presentation adapter, injected management transitions, ordinary SQLite owner exclusion, retained-release packaging, and disposable offscreen tests. Management transitions tested using collected objects are not proof of the exact visible Pi bridge.

Unavailable or incomplete (original delivered-tree inventory, now superseded for the S4 bridge checkpoint above): real Pi extension and framed transport composition, exact challenged incarnation identity, surviving-extension recovery, native installed-Companion negotiation and normal open/hide, independent exact-resource ownership, atomic intent effects/outcomes, complete check resource resolution, minimal purge history deletion, and bounded authority collections/schema validation. This is the original delivered-tree inventory, superseded for check resolution and the other S1/S2/S3 repairs linked above. Remaining Phase 2 obligations are tracked under F1–F12 in the completion sequence. The corrections above close individual failure paths, not all original findings.

Assignment delivery, acceptance-check execution, correction loops, Board, Plannotator, remote execution, restore and migrations remain unavailable. No live Pi, desktop or service was launched. No user configuration, real Project, historical prototype or spike was changed. Nothing was committed or pushed.

`runner/main.ts start --state-dir <explicit-root>` is currently a foreground **stdio client surface**, not a native workbench launcher. Its stdout `open` record does not open QML. EOF stops that runner and releases its owner lock, it is not presentation-only hide. `status` and `backup` also open a runner and advance its epoch, so they must not be described as read-only inspection of an active owner. Do not use the current walkthrough as evidence that normal start/open/hide are complete.

## D3. Validation executed in the final integration turn

Every command was foreground, awaited, bounded to 60 seconds, and used disposable storage/injected ports. Node version and Phase 2 test details are in `/tmp/workbench-final-phase2.log`.

| Command | Actual result |
| --- | --- |
| `just --no-dotenv local-workbench-v1-phase-2-check` | **Exit 1, BLOCKED** after the implemented subset passes: foundation 16/16, management plus integration safety 11/11, presentation group 72 pass/5 TODO, audits 38/38, offscreen layout 18 Qt rows. |
| `just --no-dotenv local-workbench-v1-check` | PASS, including static QML lint. Existing installed-metadata lint warnings remain. |
| `just --no-dotenv local-workbench-v1-foundation-check` | PASS, 16 foundation tests and 38 audits. Its historical completion banner is not a full Phase 2 verdict. |
| `git diff --check`, `git diff --exit-code -- prototypes/ spikes/`, `bash -n packages/local-workbench-v1/scripts/phase-2-gate.sh` | All exit 0. |
| Package `--test test/*.test.ts test/*.test.mjs` under a disposable `env -i` | 151 tests, 146 pass, 0 fail, 5 TODO. |
| Unchanged eleven-suite prototype regression command from the validation ledger, with disposable `env -i` and `/usr/lib/qt6/bin` on PATH | 163 tests, 163 pass, 0 fail, 0 TODO. |

Reproduce the full package-suite invocation with disposable storage:

```sh
scratch=$(mktemp -d /tmp/workbench-final-all.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
node_bin=$(command -v node)
env -i PATH="$(dirname "$node_bin"):/usr/lib/qt6/bin:/usr/bin:/bin" \
  HOME="$scratch" TMPDIR="$scratch" "$node_bin" --experimental-strip-types --test \
  packages/local-workbench-v1/test/*.test.ts packages/local-workbench-v1/test/*.test.mjs
```

The exact unchanged eleven-suite prototype command is in [the validation ledger](local-workbench-v1-validation.md), with `/usr/lib/qt6/bin` added to its constructed PATH so its existing qmllint invocations resolve.

Logs: `/tmp/workbench-final-foundation.log`, `/tmp/workbench-final-phase2.log`, `/tmp/workbench-final-phase1.log`, `/tmp/workbench-final-all.log`, `/tmp/workbench-final-regression.log`. These are ephemeral logs, not independently audited live evidence.

The first integration run failed one source-audit assertion because it expected bare `git` instead of the newly pinned `/usr/bin/git`. The audit was updated to require the fixed binary, fsmonitor disabling and constructed environment, then the subset passed. No test failure was hidden.

Zero Assignment/check execution is supported here by absence/refusal of execution surfaces and static audits. The unused delivery spy in earlier tests does not establish armed per-scenario counters. The required full-chain zero-execution acceptance is incomplete and is one reason the Phase 2 gate cannot pass.

## D4. Slot/task provenance and collaboration failures

Artifacts: `/tmp/fusion-harness-wSgQEL/collaborate/plan.json` and `reports/`.

| Slot/tasks | Contribution | Evidence limit |
| --- | --- | --- |
| DEEPSEEK-FLASH 1.a, 2.a | Sole delegated implementation writer, foundation and management subset | Initial completion claims exceeded implemented contracts. |
| ASTRA 1.b | Independent read-only authority checklist | Design review, no implementation/test execution claim. |
| GLM-FLASH 1.c | Independent read-only UI integration map | Design review. |
| ASTRA 3.a, 5.a | Independent implementation and final authority reviews | Both FAIL, source/test inspection only. |
| GLM-FLASH 3.b, 5.b | Independent UI reviews and correction verification | Final READY-with-residuals disagreed with required authority and native-entry completion. Not a team PASS. |
| DEEPSEEK-FLASH 4.a | Partial corrections and reported validation | Incorrectly deferred required Phase 2 work and overstated coverage. |
| DEEPSEEK-FLASH 6.a | Qualified closeout and returned findings to Phase 2 | Preserved as prior-task evidence. |
| ASTRA final integration | Sequential fixes, new tests, validation and this canonical result | Host continuation and self-validation, **not an independent review of these new fixes**. |

No child/provider execution failure is reported in the supplied task reports. The collaboration failed to deliver the complete requested slice despite completed task statuses. The claims that bridge engineering requires a live launch, hashing requires executing checks, and management dedup can wait for dispatch were incorrect. The accepted handoff already requires those behaviors in Phase 2.

## D5. Exact next handoff

Finish the open Phase 2 requirements before starting Phase 3 or arranging human management acceptance. In particular implement the actual bridge/native composition, exact identity and recovery, ownership checks, transactional outcomes and configured resource resolution, then prove the full required QML → adapter → runner → SQLite → framed fake host using real bridge logic chain. Preserve these fixes and existing releases.

The human walkthrough remains **unrun and blocked**, requiring separate authorization after engineering readiness. Do not install or launch anything as a recovery shortcut.

Once Phase 2 passes, the bounded Phase 3 task is one explicitly authorized gated Assignment using C2/C5/C7–C10. C11/C12 intervention, stop, unknown-delivery and writer-reconciliation failure windows must be proven before separately authorized live dispatch. The accepted contracts already select those policies. No additional policy ceremony or Board/remote feature is required to resume the unfinished Phase 2 engineering.
