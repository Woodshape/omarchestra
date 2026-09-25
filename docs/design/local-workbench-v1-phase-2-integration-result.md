# Phase 2 canonical collaboration result

Status: **S1–S6 disposable engineering acceptance PASS; bounded independent integration review completed with no remaining blocking findings; overall Phase 2 INCOMPLETE: the operator authorized the human walkthrough and [live 0.8.0 setup plus stable native open](../reviews/local-workbench-phase-2-verification/live-setup-and-open.md) now pass. Project/Goal management, Pi observation and exact confirmed Adoption have not yet run.** No live Adoption or Assignment/check execution has been performed. The [S6 native/composed checkpoint](../reviews/local-workbench-phase-2-verification/native-owner-composition-checkpoint.md) records the new exit gate and its limits.

The collaboration findings D1–D4 below are a **historical report about the original delivered tree**, not current implementation or acceptance claims. This record supersedes the task 6.a gate-green wording in the [earlier closeout](local-workbench-v1-phase-2-closeout.md). The sequential S1–S6 repairs preserve that evidence without silently rewriting the original review.

## Subsequent direct implementation

The [S1 persistence and binding/fence checkpoint](../reviews/local-workbench-phase-2-verification/binding-fence-checkpoint.md) now passes its bounded durable-substrate gate. It supersedes the original ownership/backup and full-row-purge implementation facts below, not the then-open overall Phase-2 result. The later S2 command/source checkpoints also pass. The [S3 Project-context checkpoint](../reviews/local-workbench-phase-2-verification/project-context-checkpoint.md) added directory identity, fail-closed Git facts, startup/operation revalidation and explicit transactional reconfirmation through offscreen QML. The later [S3 check-resource checkpoint](../reviews/local-workbench-phase-2-verification/check-resources-checkpoint.md) now passes runner-resolved versioned check definitions (store schema 8), including executable/resource hashes and offscreen QML create/edit. Neither checkpoint has independent final review. The [S4 real bridge checkpoint](../reviews/local-workbench-phase-2-verification/real-pi-bridge-checkpoint.md) now tests an actual Pi extension adapter, bounded owner-only socket and exact-identity registry against a fake host. The subsequent [S5 framed Adoption checkpoint](../reviews/local-workbench-phase-2-verification/framed-adoption-checkpoint.md) now connects operator intent, challenged ACK, Goal-scoped Run commitment and delivery, readiness, surviving-extension recovery, takeover, retirement and purge through a disposable paired fake Pi. Current store schema is **9**; prior schema-8 development roots fail closed without an explicit supported upgrade. The legacy object-event manager remains only for historical injected tests, **not** native composition. [S6](../reviews/local-workbench-phase-2-verification/native-owner-composition-checkpoint.md) now composes the owner, installed-Companion negotiation, actual offscreen QML, presentation adapter, Goal-scoped framed fake-Pi Adoption and validated collection pages. The Phase-2 engineering gate exits **0** (foundation 41/41, management 191/191, presentation 83 pass/5 pre-existing TODO, audits 39/39, offscreen QML 18 rows). The Phase-1 and affected prototype regressions also pass. The [independent read-only integration review](../reviews/local-workbench-phase-2-verification/independent-integration-review.md) found three blocking S6 gaps, verified their repairs in follow-up and reports no remaining blocker in reviewed paths. No human management walkthrough or live Pi/desktop acceptance has passed. The collaboration findings below describe the original delivered tree, not these later repairs.

## D1. Historical original-collaboration integration changes (superseded by S1–S6)

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

## D2. Historical original-delivered-tree inventory (superseded by S1–S6)

Working in the implemented subset: persistent Project/Goal/check-draft records, basic versioning, actual QML registration/check/Adoption intents through the presentation adapter, injected management transitions, ordinary SQLite owner exclusion, retained-release packaging, and disposable offscreen tests. Management transitions tested using collected objects are not proof of the exact visible Pi bridge.

Unavailable or incomplete (original delivered-tree inventory, now superseded for the S4 bridge checkpoint above): real Pi extension and framed transport composition, exact challenged incarnation identity, surviving-extension recovery, native installed-Companion negotiation and normal open/hide, independent exact-resource ownership, atomic intent effects/outcomes, complete check resource resolution, minimal purge history deletion, and bounded authority collections/schema validation. This is the original delivered-tree inventory, superseded for check resolution and the other S1/S2/S3 repairs linked above. Remaining Phase 2 obligations are tracked under F1–F12 in the completion sequence. The corrections above close individual failure paths, not all original findings.

Assignment delivery, acceptance-check execution, correction loops, Board, Plannotator, remote execution, restore and migrations remain unavailable. No live Pi, desktop or service was launched. No user configuration, real Project, historical prototype or spike was changed. Nothing was committed or pushed.

In the **original delivered tree**, `runner/main.ts start` was a foreground stdio surface: EOF stopped that runner and `status` opened a new one. This is no longer the current entry point. S6 now uses an owner-only socket with foreground `start`, one-shot `open`/`hide`/`status`, and offline backup only while the owner is stopped. See the current [native owner checkpoint](../reviews/local-workbench-phase-2-verification/native-owner-composition-checkpoint.md).

## D3. Historical validation from the original integration turn (not current gate results)

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

At the time of this original review, zero Assignment/check execution was supported only by absence/refusal of execution surfaces and static audits; its unused delivery spy did not establish full-chain acceptance. The subsequent S6 gate now includes framed fake-Pi and offscreen QML composition with no execution. Neither gate exercises live Pi or a human-managed desktop.

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

## D5. Current next handoff

S1–S6 engineering exit gates now pass under disposable/offscreen fake-only automation. The [bounded independent integration review](../reviews/local-workbench-phase-2-verification/independent-integration-review.md) inspected the owner, Companion, adapter and fake-Pi paths; its three initial blockers have been repaired and checked in read-only follow-up. The operator **explicitly authorized** the focused human management walkthrough, but its [original read-only preflight](../reviews/local-workbench-phase-2-verification/human-walkthrough-preflight.md) found installed Companion 0.7.0 and Omarchy 4.0.4-1 against release 0.8.0's then-active 4.0.3-1 pin. The operator subsequently chose API-based rather than fixed-version gating. This change is fake-host verified, not an installed-shell compatibility claim. The [operator-directed live setup/open](../reviews/local-workbench-phase-2-verification/live-setup-and-open.md) now passes after two verified TTY-authorized 0.8.0 updates (the second loaded the corrected QML), a shell reload, loaded-component negotiation, stable owner status and a compositor-visible dock. This is **partial** human acceptance: native Project/Goal actions, Pi observation and exact confirmed Adoption remain unrun. Do not claim live Adoption or Phase-2 completion.

Once Phase 2 passes, the bounded Phase 3 task is one explicitly authorized gated Assignment using C2/C5/C7–C10. C11/C12 intervention, stop, unknown-delivery and writer-reconciliation failure windows must be proven before separately authorized live dispatch. The accepted contracts already select those policies. No additional policy ceremony or Board/remote feature is required for the remaining Phase-2 human-management boundary.
