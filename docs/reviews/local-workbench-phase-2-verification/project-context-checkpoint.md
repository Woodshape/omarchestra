# S3 checkpoint — Project context and explicit reconfirmation

Status: **bounded Project-context checkpoint PASS; S3 overall incomplete; Phase 2 BLOCKED.** Direct implementation, source self-review and disposable automated evidence only. No independent review, installed Companion test or live Pi/provider exercise. Changes are uncommitted at this checkpoint.

## Question and outcome

Can failed Git queries or a repository replaced at the same path retain the appearance/authority of the confirmed Project?

The previous implementation could treat failed status as clean and accept an old confirmation after same-path replacement. The repair retains an observed directory identity, rejects unavailable facts, revalidates before applicable operations and offers explicit reconfirmation without losing history or clearing writer uncertainty.

A further negative probe established that fixed Git argv alone was not a read-only guarantee: configured clean filters and partial-clone remote helpers actually executed disposable canaries on baseline `68960cf`. Those canaries do not execute with the repaired inspector. Safe parent repositories with submodules remain supported; their existing regression was preserved, not disabled to get PASS.

## Implemented contract

- `runner/project-identity.ts` captures canonical UTF-8 directory paths and bigint device/inode/UID/birth-time identities. `repo-v1:<sha256>` binds the root, Git common directory and worktree admin directory. Before/after inspection checks detect observed substitution and changed Git pointers.
- **Store schema 7**, fence schema 2. Existing `projects.context_digest` now means this directory identity, **not** the C9 content baseline or a Run's execution context. Older development schemas, including 6, fail closed; no migration, restore or silent fingerprint acquisition. HEAD/dirty facts are separate, so ordinary commits/edits do not replace the repository.
- Required Git queries preserve failure, timeout, signal, malformed/oversized output and invalid UTF-8. Unknown cleanliness is `null`, not false. Failed HEAD verification is not an unborn repository: a symbolic branch and specifically absent ref must establish that fact. Ordinary path whitespace is not trimmed away.
- The fixed Git executable retains the constructed environment, disabled fsmonitor and optional index writes. Lazy fetch is disabled and Git transport protocols are denied. Before status, an exact read-only config query checks external clean/process filters. Bounded NUL-paired index metadata finds initialized submodules whose root/configuration/index must be checked too. Safe parent status and child fsmonitor suppression have real-Git tests; selecting a submodule itself remains unsupported.
- Bounds: 5-second Git process timeout with SIGKILL, 1 MiB output bound, 32 repositories per status preflight and a 15-second whole-inspection admission deadline. An already-running bounded query may finish after that deadline; its facts cannot become available. Missing/uninitialized Gitlinks do not cause an invented child repository. Unknown/unsupported index metadata or excessive traversal refuses status rather than guessing.
- Authority startup, Project/Goal selection and check create/edit revalidate confirmed context. Check writes never rely on the display cache. Missing/replaced/uninspectable repositories remain in history but cannot authorize check configuration. Pure Goal/history operations remain usable. Fresh inspection can restore availability after transient failure when the original identity is unchanged.
- The registration cache returns private-copy views. Confirmation rechecks repository identity, paths, HEAD/dirty facts and eligibility. A previously failed inspection cannot become confirmation authority merely because Git later recovers.
- A changed registered identity presents **Reconfirm context** in actual QML, with an explanation that history/uncertainty remain and work does not resume. Its private inspection captures the prior Project revision/identity. Confirmation updates the same Project, increments its revision and records `project_context_confirmed` within the effect/event/receipt transaction. Goal/check/binding history and both binding-level and purged-effect uncertainty remain. Receipt failure rolls back the binding and tentative availability; original-envelope replay is mutation-free.
- State-root overlap includes Git common storage. Registration also rejects overlapping/shared canonical Project/common-directory storage. No Project contents or Git configuration are rewritten to make inspection succeed.

`console/{schema,detail-schema}.ts` accepts nullable Project/registration cleanliness; Start-review cleanliness remains a strict captured boolean. `runner/projection.ts` shows unavailable check actions/catalogue entries when context is unavailable. These are last-probe display facts, not a filesystem watcher or execution readiness.

## Failure and composed evidence

`test/phase-2-project-context.test.ts` covers:

- each failed required query, incomplete/error/signalled/oversized/malformed output, broken HEAD versus legitimate unborn HEAD;
- root replacement with identical Git bytes, common-directory replacement alone, Git binding relocation, replacement during inspection, changed HEAD before confirmation and mutation of returned inspection views;
- startup replacement/removal, fresh checks instead of cached availability, create/edit refusal, transient-query recovery, preserved history and strict schema-6 refusal;
- explicit reconfirmation, receipt failures before/after insertion, exact replay, unchanged Goal history, retained writer/uncertain-effect records and durable reopening;
- actual filter/remote-helper canaries, nested unsafe configuration, preserved safe-parent behavior, child fsmonitor suppression, malformed index metadata, traversal cap and exact admission deadline.

`test/phase-2-composed.test.ts` extends the actual offscreen QML → captured intent → presentation adapter → runner → committed snapshot journey. After registering and creating a check, the fixture replaces the repository, inspects again, renders **Reconfirm context**, captures its click and confirms the new binding. The same Project/check remain and no Assignment is created. This uses the existing injected presentation port and offscreen host/theme substitutions, not native Omarchy installation or a Pi bridge.

Existing transaction fixtures now supply real disposable directory identities or matching explicit Git facts. The source audit permits only the exact read-only `git config --includes --null --name-only --get-regexp ...` invocation; other config/mutation commands remain forbidden. The production subprocess boundary stays in `git-context.ts`.

## Reproduction and observed results

Host: Node **26.8.1**, Git **2.55.0**; not universal platform certification.

From the repository root:

```sh
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/phase-2-project-context.test.ts

timeout --kill-after=5s 90s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/*.test.ts \
  packages/local-workbench-v1/test/*.test.mjs

timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-foundation-check
timeout --kill-after=5s 90s just --no-dotenv local-workbench-v1-check
timeout --kill-after=5s 60s just --no-dotenv local-workbench-v1-phase-2-check
```

The recorded full-package run additionally used `env -i`, a disposable HOME/TMPDIR and a minimal PATH. Gate scripts supply their own disposable roots/environment. Git fixture setup and subprocess probes are bounded; only disposable repositories are changed.

To characterize the old implementation without editing the working tree:

```sh
baseline=$(mktemp -d /tmp/p3-project-baseline.XXXXXX)
trap 'rm -rf -- "$baseline"' EXIT
git archive 68960cf packages/local-workbench-v1 | tar -x -C "$baseline"
cp packages/local-workbench-v1/test/phase-2-project-context.test.ts \
  "$baseline/packages/local-workbench-v1/test/"
timeout --kill-after=5s 60s node --experimental-strip-types --test \
  "$baseline/packages/local-workbench-v1/test/phase-2-project-context.test.ts"
```

Baseline: **42 cases, 5 pass / 37 fail**. This includes missing new APIs/contracts, not 37 independently classified defects. In particular the filter and remote-helper cases fail their **must not execute** assertions. The baseline intentionally runs only harmless canaries in disposable fixtures; it is not a green release gate.

Current package: **336 tests, 331 pass, five existing TODOs, no failures**. Foundation and presentation/QML lint gates pass. Full Phase 2 deliberately exits **1 / BLOCKED** after its implemented subset passes. `phase-2-gate.sh` includes the new Project-context cases.

Logs: `/tmp/p3-project-baseline-final.log`, `/tmp/p3-project-all.log`, `/tmp/p3-project-git-safety.log`, `/tmp/p3-project-foundation.log`, `/tmp/p3-project-phase1.log`, `/tmp/p3-project-gate.log`. `git diff --check` passes; `prototypes/`, `spikes/` and retained release bytes are unchanged. No user configuration, live Project, Pi/provider or desktop was used. Nothing was committed or pushed.

## Remaining boundary

These are observed directory/configuration checks, **not** a filesystem lock, portable restore authorization, hostile-same-UID sandbox or C9 content fingerprint. A heartbeat does not rescan Git. Cached facts never authorize check writes. Reconfirmation is not Adoption or writer reconciliation.

The next S3 slice still must resolve/fingerprint executable, cwd and declared check resources under C14, persist normalized versions and prove zero execution on save. Retaining a check here is not proof that its resources are resolved or still match. S4/S5 still need the real bridge and actual Run-context/Goal-scoped Adoption integration; S6 still needs native owner/client entry and complete acceptance. No live management walkthrough or Assignment execution is authorized by this checkpoint.
