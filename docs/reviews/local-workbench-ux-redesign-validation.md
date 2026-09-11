# Independent validation — task-first workbench delivery

Historical disposition: **CHANGES REQUIRED**, subsequently addressed by the [engineering correction slice](local-workbench-ux-redesign-corrections.md). Native UX acceptance remains pending. The findings and red evidence below are retained unchanged.

Existing acceptance gate passes, but additional
actual-component checks reproduce defects in the delivered journey. Native UX
acceptance is still pending. No installation, shell restart, live Pi or real
execution was performed for this review. No implementation files were changed.

## Run provenance and pending follow-up

Fusion artifacts: `/tmp/fusion-harness-L787HA`.

The collaboration summary records `ok: false`, with task 2.a failing on an Ollama
502/read timeout. It contains only task executions 1.a/1.b/1.c/2.a. Later delivery
and review reports exist, but the 5.a/5.b reports explicitly say they were produced
in-session after delegation became unavailable. They are not evidence that an
independent Astra/secondary reviewer executed those final tasks.

The host-session transcript records the user's upstream-review follow-up at
2026-09-11T13:10:26.951Z, followed by an assistant tool call reading
`/tmp/omarchy-boomux-implementation-review/review.md`. Thus the follow-up was
received and read during the subsequent host continuation, not broadcast into
the failed collaboration task. Do not describe the entire delivery as one
successfully completed independently reviewed Fusion DAG.

## Checks independently rerun

- `just --no-dotenv local-workbench-v1-check`: PASS; 114 Node pass, five deferred
  runtime TODOs; 12 Qt rows pass; static QML lint PASS with warnings.
- The 11-file affected prototype regression command from the validation ledger:
  163/163 pass.
- `node --experimental-strip-types manual/local-workbench-preview.ts --check`:
  PASS, repository-source-only fixture check.
- `bash -n packages/local-workbench-v1/scripts/phase-gate.sh`: PASS.
- `git diff --check`: PASS.
- `git diff --exit-code -- prototypes/ spikes/`: unchanged against HEAD.
- Retained-release tests pass. Retained 0.6.0 WorkbenchConsole.qml additionally
  matches the independently retained pre-redesign `/tmp/WorkbenchConsole.fixed.qml`:
  SHA-256 `c6dde58082ff5bc7b533967b66feab5f0aac249c8f8bac716d673ce2a04d0598`.

Logs: `/tmp/workbench-independent-validation.log`,
`/tmp/workbench-independent-regression.log`.

## Blocking findings

### F1 — Create does not honor its advertised action contract

`console/plugin/WorkbenchGoal.qml`, Create button; `fixtures/journey.ts`;
`console/live-projection-adapter.ts: emitIntent`.

Create enables on connection plus nonempty text only. It ignores runner action
availability, selected-Project validity and the existing text bound. It emits
`target: selectedProjectId`, while the default journey advertises `create_goal`
with `target: null`. The actual adapter rejects the emitted request as
`action unavailable in authoritative projection`. Using the advertised null target
with the same payload is accepted by the injected adapter.

An added actual Qt case sets all projected actions disabled, types a Goal, then
asserts Create is disabled. It fails: actual true, expected false. The current
preview rejects all management anyway, masking both this availability defect and
the valid-create wiring mismatch.

Required: derive enabled state from current authoritative action plus valid
Project/text, use the agreed target contract, and compose the actual component
request through the actual adapter to an injected authority. This does not
require durable creation or enabling live management.

### F2 — Same-revision check changes retain a stale captured start review

`console/plugin/WorkbenchConsole.qml`: `reviewAssociation`, `applyProjection`,
`captureStartReview`, `checkById`, `startDetail`.

The association includes check ID/version but not its digest/definition or
availability. On a changed same-revision snapshot, applyProjection clears the
modal confirmation/queued intents but does not clear startReview. The existing
source lookup can combine the retained captured selection with newly projected
facts.

Actual Qt reproduction: open journey, select its agent/check v3, save task text,
capture review, clone the snapshot and change only checks[0].digest, then apply
it with the same revision. startReview remains non-null. This violates the
explicit same-revision/invalidation acceptance boundary. Execution remains
unavailable, so this is a stale-review defect, not evidence of live dispatch.

Required: invalidate captured reviews on relevant check/target/detail changes,
including same-revision replacement, without discarding task drafts. Confirm the
resolved detail matches the selected Project, agent, check definition and task
association rather than only finding matching ID/version strings.

### F3 — Project selection bypasses the native preview's intent queue

`console/plugin/WorkbenchConsole.qml: selectProject` and
`manual/workbench-preview-controller.ts: tick`.

selectProject emits the signal directly instead of enqueueing through emitIntent.
The native preview consumes takeIntent, not that signal. Actual Qt reproduction:
selectProject(...) followed by takeIntent(currentSession) returns an empty string.
In addition, the preview controller ignores select_project even if it receives
one; it has no selected-Project state. The one-Project default conceals this.

The New Goal page's additional “Change Project” button navigates to overview
rather than opening the Project picker, while the persistent header has a second
Change control. This is also unnecessary duplication in the supposedly minimal
flow.

Required: use one selection path supported by both injected and native adapters,
validate fixture Project selection and demonstrate switching two Projects with
separate Goal drafts. Provide one direct Project-change interaction that returns
to the creation context. Do not infer any domain authority from navigation.

### F4 — Start review still presents the rejected protocol wall

`console/plugin/WorkbenchReview.qml: start_review` and
`WorkbenchConsole.qml: requestConfirmation`.

The first visible start-review block renders raw confirmation/Project/Goal/Run
IDs, Node, Git common directory/HEAD, baseline digest, gate/executable digests,
JSON argv/environment/resources and numeric limits in one long Text. The task is
below this block. There is no collapsed Technical details control. Generic action
confirmation likewise starts with raw kind/target and serialized payload.

This does not deliver the approved concise task/agent/check/consequence summary
with explicitly inspectable technical details. The exact facts should remain
available, but not dominate the default decision surface. Existing tests assert
that these strings are rendered; they do not enforce progressive disclosure.

Required: friendly summary first; technical disclosure separate; material code
execution/dirty-work/limit consequences remain visible. Use action-specific copy
for interventions, not protocol identifiers as the primary explanation.

## Additional scope gap to resolve

`WorkbenchChecks.qml` edits name, summary, mode and a display-only commandSummary.
It cannot configure the executable/argv/resources/limits described as having
moved to this destination. No runtime service is requested, but the agreed
advanced configuration presentation is not delivered merely by relabelling
metadata fields “Edit definition”. Either complete the bounded injected editor,
or explicitly identify the unimplemented portion rather than calling this entire
engineering task READY.

## Upstream follow-up implementation coverage

- Read by host: **yes**, directly evidenced by its tool call.
- Fixed reservation independent of content: retained; native sizing not tested
  here. No second rail, global keybinding or CLI orchestration in QML added.
- Local Escape and focus return: implemented, including rendered tests for menu
  dismissal and Back behavior.
- Keyboard-safe multiline form: implemented and tested.
- Context menu: implemented as inline disclosure, not an anchored/clamped popup;
  docs correctly admit Tab navigation, not arrow-key menu traversal. This can be
  a legitimate single-dock design, but is not the exact upstream menu pattern.
- Bounded lists: snapshot limits and scroll clipping exist; work rows are capped
  at eight. This is not equivalent to upstream's bounded ListView architecture.
  The claim that remaining Assignment rows “stay in Activity” is not supported
  by a guaranteed per-Assignment detail navigation path; Activity renders events.
- Exact-current selection/review guidance: **incomplete**, demonstrated by F2/F3.

## Reproductions and next gate

Extra checks were added only to an isolated copy of the package:
`/tmp/workbench-independent-repro/package/test/rendered-layout.test.ts`.
They run the existing actual Qt component harness, with the same inert theme and
substituted Window host; no installed shell is imported.

```sh
node --experimental-strip-types --test \
  /tmp/workbench-independent-repro/package/test/rendered-layout.test.ts
```

Three additional tests fail for F1/F2/F3; the existing Qt cases still pass.
Results: `/tmp/workbench-independent-repro/results.log`. F1's adapter target
mismatch was separately reproduced against WorkbenchAdapter with journeyFixture:
Project-ID target rejected, advertised null target accepted.

Carry these focused behavioral cases into the real suite during correction.
Do not install 0.7.0 as an accepted redesign yet. Close the flow/contract/UX gaps
first, rerun the focused gate and affected regressions, and only then conduct one
operator walkthrough. No need to restart the entire redesign or build runtime
Phase 2–4 to close these presentation findings.
