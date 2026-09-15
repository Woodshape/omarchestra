# Local Workbench v1 — Phase 2 composition (P2.1 foundation)

Status: **P2.2–P2.5 implemented and gate-green. The independent final authority verdict is FAIL and the human walkthrough is unperformed.** The canonical verdicts, open requirements, commands and working/disabled inventory are in [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md); where this document describes a limit, the closeout controls.

Part 1 of this document is the P2.1 foundation record: the durable runner in
`packages/local-workbench-v1/runner/` and its gate
`packages/local-workbench-v1/scripts/phase-2-foundation-gate.sh`. Part 2 (from D12) is the P2.2–P2.5 record.

## D1 — one foreground runner owns everything durable

A single foreground composition owns the Project registry, the SQLite store,
the owner lock, management authority, and the authoritative projection. There
is one store, one owner lock, one retained fence ledger, and no second
registry. Automation always injects desktop/host ports and disposable roots;
nothing in this slice reads `HOME`, XDG paths, dotenv, or user configuration.

Composition root: `runner/runner.ts` (`openWorkbenchRunner`).

## D2 — startup order is fixed and recoverable

1. Resolve injected roots: create the owned directory `0700` when missing,
   reject symlinks, foreign uid, group/other access, and non-canonical paths
   (`runner/paths.ts`).
2. Reject an interrupted manifest write (`manifest.json.new`) and reject
   workbench resources that exist without an ownership manifest.
3. Read and validate the ownership manifest, or create it for a genuinely new
   root.
4. Acquire the lifetime owner lock (`owner.sqlite`, `BEGIN EXCLUSIVE`) **before**
   creating identity or writing the manifest, so two first-runs cannot race into
   two manifests. The owner lock is never taken over by PID inspection,
   timestamp comparison, or stale-file deletion.
5. Open the store (`workbench.sqlite`), validate declared schema shape and Node
   identity, then increment `runner_epoch` inside `BEGIN IMMEDIATE`.
6. Open the retained fence ledger (`fences.sqlite`) and verify its integrity.
7. Run recovery: retained fences win over store state, unfinished in-flight
   bindings keep writer uncertainty.
8. Ready.

Shutdown reverses the order and releases the owner lock last. Clean shutdown
closes connections without deleting history.

## D3 — durable resources

| Resource | Owner-only | Purpose |
| --- | --- | --- |
| `manifest.json` | `0600` | kind, schema, Node identity, resource names |
| `workbench.sqlite` | `0600` | meta, projects, goals, check definitions, bindings, events, intent dedup |
| `owner.sqlite` | `0600` | lifetime ownership lock (no durable history) |
| `fences.sqlite` | `0600` | binding fences and vacancy high-water marks, retained independently |
| `backups/` | `0700` | verified backups plus metadata, rotated to the newest two |

Store settings are verified, not assumed: `foreign_keys=ON`,
`journal_mode=DELETE`, `synchronous=FULL`, `busy_timeout=1000`, and
`BEGIN IMMEDIATE` for every authority transaction. Any other journal mode,
any missing or unexpected table, any schema version other than 1, and any
integrity failure block startup.

## D4 — fail-closed rejections

Every rejection is a `WorkbenchError` with a stable code, the exact condition,
and one concrete recovery action (`runner/errors.ts`):

`unsafe_path`, `unexpected_resource`, `missing_resource`, `foreign_owner`,
`manifest_missing`, `manifest_drift`, `identity_drift`, `second_owner`,
`unsupported_schema`, `schema_drift`, `store_unavailable`,
`backup_precondition`, `backup_unavailable`, `migration_unavailable`,
`restore_unavailable`, `fence_missing`, `fence_conflict`, `integrity_failure`,
`invalid_input`.

No recovery action suggests deleting unknown directories, taking over a lock,
or restoring automatically.

## D5 — fencing, retirement, replacement, purge

1. `retireBinding` commits the fence and advances the vacancy generation in the
   independent ledger **before** the store records the retirement. A crash
   between the two commits is repaired by recovery, and the fence wins.
2. Retirement retains writer uncertainty. A binding whose writer may still have
   been writing is never presented as clean, and committed work is never
   downgraded to uncertain.
3. Replacement requires a generation strictly greater than the retained
   high-water mark for that Project and role. Generation reuse is refused.
4. `purgeBinding` requires an independently retained fence, a terminal retired
   (or already purged) leaf, and no active successor. Without a fence it fails
   `fence_missing` with no mutation, so purge cannot bypass fencing.
5. The fence row and vacancy high-water mark are retained forever; purge only
   clears presentation history.

## D6 — backup, migration, restore support matrix

| Capability | Supported | Preconditions / reason |
| --- | --- | --- |
| Backup | yes | exclusive ownership held, store `integrity_check` clean, `VACUUM INTO` into the owner-only backup dir, SHA-256 digest + schema metadata, newest two retained |
| Migration | no forward step | Phase 2 has no step beyond schema 1, so version 1 is a verified no-op; any other version is `unsupported_schema`/`migration_unavailable`, forward-only, never a downgrade |
| Restore | no | fails closed as `restore_unavailable` with an explicit operator action; no invented success |
| Backup verification | yes | digest match, schema version, metadata presence beside the database |

## D7 — zero-dispatch invariant

This slice contains no delivery port, no validator executor, no subprocess
spawn, and no network import. The foundation gate therefore executes zero
Assignment deliveries and zero acceptance checks, and asserts it in the source
audit and foundation suite. Later Phase 2 tasks must keep that invariant and
instrument any delivery port so an accidental call throws.

## D8 — module map

| Module | Responsibility |
| --- | --- |
| `runner/errors.ts` | error codes, `WorkbenchError`, normalization |
| `runner/paths.ts` | injected roots, owned directory/file validation, unexpected entries |
| `runner/identity.ts` | durable local Node identity (random, path/PID independent) |
| `runner/manifest.ts` | ownership manifest validate/read/atomic write |
| `runner/schema.ts` | declared store schema version 1 and DDL |
| `runner/store.ts` | `node:sqlite` store, settings, epoch, projects/goals/bindings/intent dedup |
| `runner/owner-lock.ts` | lifetime exclusive owner lock |
| `runner/fences.ts` | retained binding fences, vacancy high-water marks |
| `runner/recovery.ts` | fence-wins recovery and writer uncertainty |
| `runner/backup.ts` | backup/rotate/verify, migration plan, restore fail-closed |
| `runner/runner.ts` | the one foreground composition and its lifecycle |
| `runner/index.ts` | public surface |

## D9 — validation evidence

Commands and observed results on branch `feature/local-workbench-v1`,
Node `v26.8.1` (SQLite 3.53.4):

```text
just --no-dotenv local-workbench-v1-foundation-check
  node: v26.8.1
  runner-foundation tests: 16/16 pass
  source-audit + retained-release + qml-boundary: 31/31 pass
  Phase 2 foundation gate: PASS

just --no-dotenv local-workbench-v1-check
  Phase 0/1 automated presentation gate: PASS
```

Foundation suite covers: owner-only root modes; durable random identity and
identity persistence across reopen; epoch increment per start; in-process and
cross-process second-owner exclusion via a spawned `node` child; owner-lock
release on unclean process exit; symlink and symlinked-ancestor refusal;
unexpected state entries; interrupted manifest writes; manifest drift,
unsupported manifest schema, deleted manifest beside history, missing fence
ledger, identity drift; store schema-version, dropped-table, extra-table and
WAL drift; fence-ledger schema drift; write-ahead fencing and idempotent
fencing; purge-without-fence refusal with no mutation; active-successor purge
refusal; vacancy generation reuse refusal; fence-wins recovery and in-flight
uncertainty; project/goal/intent dedup persistence; backup precondition,
digest verification, tamper detection, rotation to two; migration/restore
fail-closed; root overlap and non-canonical rejection; zero-dispatch source
scan.

## D10 — preserved changes

The following working-tree modifications were present before this task and were
not touched:

1. `docs/plans/local-workbench-ux-redesign.md`
2. `docs/plans/local-workbench-v1-phase-2-handoff.md`
3. `docs/plans/local-workbench-v1.md`

Changed or added by this task:

1. `packages/local-workbench-v1/runner/` (new)
2. `packages/local-workbench-v1/test/runner-foundation.test.ts` (new)
3. `packages/local-workbench-v1/scripts/phase-2-foundation-gate.sh` (new)
4. `packages/local-workbench-v1/test/source-audit.test.mjs` (narrow edit: SQLite
   tokens allowed only under `runner/`, plus an audit for the new gate)
5. `justfile` (new `local-workbench-v1-foundation-check` recipe)
6. this document

No prototype or spike runtime code is imported; no live Pi, desktop, or service
is launched; no Project is mutated; nothing is committed or pushed.

## D11 — Phase 3 and remaining Phase 2 handoff

Remaining Phase 2 tasks that must reuse the constants and APIs defined here
(`WorkbenchError` codes, `resolveRoots`/`WorkbenchRoots`, manifest constants,
`STORE_*` schema constants, `WorkbenchStore`, `FenceLedger`):

1. Project registry: `inspect_project`, `register_project` with Git inspection
   and confirmation, persisted through `putProject`.
2. Goal store and check catalog: persistent Team Goals and C14 checks with
   hard-disabled execution reasons.
3. Observer bridge, framed channel, and the real projection/intent router
   connected to the actual QML presentation adapter, with `authorize_adoption`
   enabled on the real path only and `start_assignment` still rejected.
4. Runtime entry and QML presentation host, single-foreground open/hide/stop.
5. Executable Phase 2 acceptance gate
   (`just --no-dotenv local-workbench-v1-phase-2-check`) plus a separately
   authorized human management walkthrough that cannot dispatch.

Known open questions carried into those tasks: installed Pi extension
management APIs (ship the bridge disabled with an actionable reason if absent),
any QML host resnapshot round-trip the Phase 1 shell lacks, and whether a
minimal retained fence ledger is sufficient for purge in the full journey.

---

# Part 2 — runnable Phase 2 (P2.2–P2.5)

Part 1 above is the P2.1 foundation record. Part 2 implements the bounded journey on top of it: register and confirm a real local Project, create durable Team Goals and configured checks, observe and adopt one visible Pi, keep retirement/replacement/purge semantics, reopen and restart, and connect the actual QML intents and adapter rather than a parallel implementation.

## D12 — module map additions

| Module | Responsibility |
| --- | --- |
| `runner/git-context.ts` | The only module that spawns. Fixed-argv read-only `git rev-parse`/`status` through `spawnSync(..., {shell:false, timeout:5s, maxBuffer:1MiB})`. Resolves canonical path, worktree root, Git common dir, HEAD, dirtiness, plus refusal and readiness reasons. |
| `runner/authority.ts` | The management authority: registry, Goals, checks, selection, revision, cursor, intent dedup and the authoritative snapshot. One transaction per commit (`event + revision`). |
| `runner/adoption.ts` | Proposal → authorize → acknowledge → commit → delivery → readiness, plus takeover, disconnect, retirement, replacement and purge over the retained fence ledger. |
| `runner/transport.ts` | Closed framed channel (`encodeFrame`/`decodeFrame`), the observer port, and the read-only Pi installation probe. |
| `runner/projection.ts` | Builds the `omarchestra.workbench/v1` snapshot the adapter validates, including per-check `configure_checks` actions and the `registration` detail. |
| `runner/host.ts` | Composes the durable runner with `createPresentationShell` and routes intents through `authority.handleIntent`. Publishes only a changed snapshot, so an idle tick writes nothing. |
| `runner/main.ts` | The one foreground entry point and its line protocol. Spawns nothing. |

`runner/store.ts` gained `CheckRecord`, `EventRecord`, `setGoalState`, `putCheck`/`getCheck`/`latestCheck`/`listChecks`, `appendEvent`/`listEvents`/`maxCursor`, and `listProjects`/`listGoals`. `runner/index.ts` re-exports the new surface.

## D13 — the actual adapter is the only path

The real path replaces the fixture controller for `open`, `applyProjection` and `intentResult`. `openPreview`/`updatePreview` stay fixture-labelled, and the snapshot carries `fixture: {active: false, label: ''}` on the durable path.

Changes to the presentation layer:

1. `console/schema.ts` accepts `inspect_project {path}`, `confirm_register_project {registrationId}` and `create_check {projectId, name, summary, mode, commandSummary, definitionDraft}`. `path` must be absolute, must contain no `..` segment and stays within 4096 bytes.
2. `console/detail-schema.ts` adds `RegistrationDetail` (`kind: 'registration'`) as a closed detail variant.
3. `console/live-projection-adapter.ts` gates Project-scoped intents on the selected Project, requires a check `cwd` inside the Project's canonical path, requires a supported registration for `confirm_register_project`, and refuses `start_assignment` with the Phase 3 reason.
4. `console/plugin/WorkbenchOverview.qml` renders the registration facts from `projection.details` and emits `inspect_project` and `confirm_register_project`. It never derives Git facts.
5. `console/plugin/WorkbenchChecks.qml` opens the same validated editor for a new check as for an edit. It emits `create_check` only when the name and summary are non-empty and the closed field validation passes, so no placeholder definition reaches the runner. The new-check draft is keyed per Project (`checks:<projectId>:new`) so unsaved field text survives navigation.
6. `console/plugin/WorkbenchConsole.qml` treats declaration intents as modal-free, so they reach the runner without a confirmation dialog. The runner still validates and may reject. `request_adoption` keeps its confirmation dialog because it names a Goal and a Role.

One adapter defect was found and fixed by the composed test: `emitIntent` called `intentSink` before emitting the `submitted` feedback, so an in-process runner's committed outcome reached the view first and `submitted` overwrote it. `submitted` is now emitted to the view before `intentSink` runs, so the committed outcome is the last feedback the view sees.

## D13b — corrections after independent review

An independent authority/persistence review and an independent UI/composition review found the first delivery's adoption path unreachable from the real QML. The corrections below carry regression tests in `test/phase-2-authority.test.ts`, `test/phase-2-composed.test.ts` or `test/retained-release.test.mjs`, with three LOW exceptions that have no test pinning them: the uniform `checkSummary` reason, `contextMatch: false`, and the rendered rejection `Reason:`.

1. Observations and pending proposals render as the choices that emit `request_adoption` and `authorize_adoption`, so the adapter routes the same identities the runner committed. Previously three of the four adoption seams could not be reached from QML.
2. `take_control` carries `{agentRunId}` in schema, QML and route. It previously advertised an `assignmentId` payload the runner could not resolve.
3. `assertLive` guards every binding mutation. Late `adopt_ack`, `readiness` and `input_observed` frames after retirement or purge are refused; `input_observed` and takeover move the Run to `manual_takeover` and bump its control epoch; any non-retired, non-purged binding blocks a new adoption for the same Project and Role regardless of connection state.
4. An acknowledgement deadline is enforced at acknowledgement time and by `sweepExpired()`. An expired acknowledgement is refused and a duplicate after the exchange is a stable no-op instead of a second commit.
5. Recovery downgrades `acknowledged`, `committed` and `ready` to `disconnected` with `writerState: 'uncertain'`, so a restart cannot present a committed Run as ready.
6. Purge is leaf-only across all binding states, and a purged binding is no longer projected as retired history.
7. The Git inspector records and compares `--git-dir` against the common dir, refusing a linked worktree or shared Git directory; registration refuses overlapping Project storage in both directions.
8. The accepted 0.7.0 bytes are frozen under `companion/retained/0.7.0/` and read through a version-driven manifest; Phase 2 publishes `0.8.0` instead of mutating 0.7.0.

Findings that cannot be closed without a live Pi, an executing validator or a schema migration were not closed in Phase 2. The independent final authority review rejected the claim that they are Phase 3 obligations: they are open Phase 2 requirements with the exact remaining gaps listed in [the Phase 2 engineering closeout](local-workbench-v1-phase-2-closeout.md) section 2, and `F1`/`F6`/`F7`/`F10`/`F11`/`F12` plus the remainder of `F3`/`F9` are unresolved against their original scope.

## D14 — entry point and protocol

`runner/main.ts` is the normal foreground entry:

```text
workbench start   --state-dir <dir> [--runtime-dir <dir>] [--extension-root <dir>] [--session <id>]
workbench status  --state-dir <dir> [--extension-root <dir>]
workbench backup  --state-dir <dir>
workbench inspect --path <dir>
```

`inspect` needs no state root and is read-only. `start` writes `ready` before the first projection, so a reader always knows the session and runner epoch before it sees a snapshot. Every root is explicit; there is no discovery of a user's installation or configuration, no daemon, no socket and no work dispatch. `probePiInstallation` reports `available`/`absent`/`incompatible` and never writes.

## D15 — admission without delivery

The adoption path commits a binding, acknowledges the frozen digest and confirms readiness, but no delivery port exists. `createRunnerSource` publishes snapshots only. There is no executor, no validator runner and no network import anywhere in `runner/`. The zero-dispatch invariant is enforced by the source audit and restated by both gates.

## D16 — validation evidence

Branch `feature/local-workbench-v1`, Node `v26.8.1`, SQLite 3.53.4:

```text
just --no-dotenv local-workbench-v1-phase-2-check                 # PASS
  durable runner foundation (P2.1):            16/16 pass
  runnable management and adoption journey:     7/7 pass
  actual presentation adapter composition:     72/77 pass, 5 todo
    phase-2-composed 2, phase-2-entry 2, presentation-shell 3,
    intent 17, projection 15, acceptance 16, phase1-followup 10,
    stale-session 7
  Phase 1 boundary audits against the updated tree: 38/38 pass
  actual QML render and intent capture (offscreen Qt 6.11.2): 18 QML rows,
    0 failed, 0 skipped, no QML warning
  Phase 2 acceptance gate: PASS (zero deliveries, zero check executions)

just --no-dotenv local-workbench-v1-foundation-check              # PASS
just --no-dotenv local-workbench-v1-check                         # Phase 0/1 gate PASS
package test suite (test/*.test.ts, test/*.test.mjs): 142 pass, 0 fail, 5 todo
canonical prototype regressions: 163/163 pass
```

`test/phase-2-composed.test.ts` proves the composition to the limits of an in-memory presentation port: the real runner and real adapter feed a real offscreen QML harness that captures the intents the operator would produce, and those captured intents commit durable state. It asserts `selectedProjectId === null` before confirmation, that `confirm_register_project` names the runner-issued `registrationId`, that the new-check editor stays disabled until the operator fills the validated fields, that the committed check draft is scoped to the registered canonical path, that `start_assignment` is disabled, and that exactly one `check_created` event exists. A second composition drives one adoption over an injected observer transport: a `session_observed` frame renders an adoptable choice, the captured `request_adoption` passes through the real confirmation dialog, the pending proposal renders an authorization choice, the captured `authorize_adoption` sends the exact adopt frame, and only the acknowledged delivery and readiness make the Run `ready`.

`test/phase-2-entry.test.ts` drives the real foreground process: an inspect of a real worktree, a refusal for a non-repository, one live session that inspects, confirms, creates a Goal and creates a check with the runner's own revision, then a separate process that reads the committed state back through `status` and `backup`. Three committed mutations produce exactly three events, four intents are acknowledged, and the closure record is the last line the process writes.

`test/phase-2-authority.test.ts` covers the adoption journey (propose, authorize, acknowledge, commit, ready, extension input no-op, interactive takeover, retirement, replacement with predecessor and generation 2, leaf-only purge, vacancy-generation refusal), real Git inspection via `git init`, and installation negotiation.

The gates run foreground under `env -i` with disposable HOME/XDG/TMPDIR, injected clocks and id sources, and disposable state roots. They assert zero Assignment deliveries and zero acceptance-check executions. The Phase 2 gate refuses to pass when the offscreen Qt render is unavailable rather than reporting a limitation as PASS.

Limit the composition claim accordingly. `ComposedPort.send()` collects objects and `emit()` calls handlers directly, so the composed test is not a framed fake host executing real extension bridge logic; the required `actual QML intent → real adapter → one runner → disposable SQLite → framed fake host using the real bridge logic → authoritative projection` chain remains incomplete, as the independent final authority review recorded. Zero-dispatch in that test likewise rests on the adapter's refusal of `start_assignment` rather than an armed delivery spy.

## D17 — preserved changes

Pre-existing working-tree modifications, untouched: `docs/plans/local-workbench-ux-redesign.md`, `docs/plans/local-workbench-v1-phase-2-handoff.md`, `docs/plans/local-workbench-v1.md`, and the retained `companion/retained/0.6.0/` release.

No prototype or spike runtime code is imported. Nothing installs or changes user configuration, launches a live Pi, desktop or service, mutates a real Project, or commits. Assignment delivery and acceptance-check execution stay disabled with reasons.

## D18 — handoff

The canonical Phase 2 closeout is [local-workbench-v1-phase-2-closeout.md](local-workbench-v1-phase-2-closeout.md). The bounded Phase 3 handoff is [local-workbench-v1-phase-3-handoff.md](../plans/local-workbench-v1-phase-3-handoff.md), which lists the open Phase 2 requirements, the Phase 3 scope for one gated Assignment, and the Phase 4 prerequisites before live dispatch. The human-only management walkthrough is [local-workbench-v1-phase-2-walkthrough.md](local-workbench-v1-phase-2-walkthrough.md); it is separately authorized, was not performed, and is not authorized by the independent verdicts.
