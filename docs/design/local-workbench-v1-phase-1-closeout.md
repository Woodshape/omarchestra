# Local Workbench v1 — Phase 1 engineering closeout

Status: **Superseded by the task-first redesign; retained as the 0.6.0 engineering record. Phase 2 has not started.**

> **Superseded (Companion 0.7.0, task-first presentation contract).** The
> [screen and flow design](local-workbench-v1-screens.md) and
> [contract](local-workbench-v1-contract.md) now govern the presentation. The
> following items below describe the superseded arrangement and no longer match
> the implementation: `WorkbenchDetail.qml` and `WorkbenchForms.qml` are deleted
> and replaced by the nine task-first components; the combined Goal/Assignment
> form that carried Run, gate version, argv, cwd, environment/resources,
> timeout/output and correction/elapsed limits no longer exists (check
> configuration is Project-scoped under C14, and limits appear only as frozen
> facts in Start review); review-only detail/consent previews are removed rather
> than replaced, so `Confirm start`, `Authorize adoption` and diagnostic access
> are visibly disabled actions that emit nothing; and the test/Qt counts quoted
> below are the 0.6.0 measurements. The retained 0.6.0 bytes are preserved
> unchanged outside the active catalogue for `--restore` and regression tests.
> The fixed-geometry finding, the stale-shell `assertLoadedComponentIsCurrent()`
> remedy, the privacy boundary and the remaining native-walkthrough boundary
> still hold.

Subsequent human-preview preparation: the [native layout walkthrough](local-workbench-v1-human-layout.md) now provides explicit `--setup`, `--preview`, and receipt-backed `--restore` commands. Its manual-only installer adapter and native host are fake-tested; no human run is claimed. Current gate: 101 Node tests, 96 pass, five runtime TODOs, with nine passing Qt rows. The counts below record the earlier engineering closeout.

### Native walkthrough finding: the dock resized with its content

The first native run reported that expanding and collapsing sections produced a
"weird expansion of the left dock". Cause: the layer surface derived
`implicitWidth` from `detailOpen`, so opening a detail doubled the surface from
360 to 760 logical units. Because the shell re-reserves compositor edge space
whenever a layer surface resizes, neighbouring terminals moved on every
expand/collapse. Fixed by giving the surface single `panelWidth`/`panelHeight`
constants (`Style.space(420)`/`Style.space(560)`, screen-clamped) and letting
only the content inside change. Detail, forms, dialogs and retired history now
render and scroll within the fixed width.

Red-to-green: with the old expression restored, `test_fixedDock()` in
`test/rendered-layout.test.ts` fails with `Actual (): 760 / Expected (): 360`,
and the source guard in `test/layout-fixtures.test.ts` fails; both pass after the
fix. The guard rejects any `implicitWidth`/`implicitHeight` line that references
`detailOpen` or another content state. A full-screen/resizable workspace mode is
recorded as deferred, not implemented.

### The first fix appeared not to work: the shell held the old panel

The second native report was the same symptom after a correct `--setup`. The
installed assets on disk did contain the fix, but the running shell had started
at 09:49 while the assets were installed at 12:39. Quickshell keeps the panel
instance alive (`keepLoaded`), so reinstalling files never reloads a running
shell; the operator was validating the previous component. This was a defect in
the *procedure and tooling*, not in the layout: the walkthrough never required
`omarchy restart shell`, and `--preview` read capabilities before anything had
loaded the panel (the host loads a panel only when summoned, and never reloads an
already-loaded one), so it would also have failed on a freshly restarted shell.

Both are fixed: `--setup` prints the restart step, `--preview` summons a rejected
probe payload before reading capabilities, and `assertLoadedComponentIsCurrent()`
compares the loaded component's instantiation time (`pluginGeneration`, in
milliseconds) against the receipt's `installedAt`. A shell older than its own
installed assets is refused with the exact remedy rather than silently showing
stale code. Tested against the real observed values (installed
`2026-09-11T10:39:33.938Z`, shell started `2026-09-11T07:49:16Z`) plus the
summon-before-capabilities ordering.

This follow-up supersedes the engineering gaps R1/R2 in the [original Fusion result](local-workbench-v1-result.md). It does not claim a usable durable workbench, live Adoption/dispatch, or native desktop acceptance.

## Delivered

- `console/detail-schema.ts`: closed, bounded discriminated detail records for exact Adoption proposal/stage, resolved Assignment start/gate/context, structured handoff, stop outcomes, and restricted-diagnostic notices. Unknown fields, missing identities, malformed digests, unsafe paths, invalid enums, duplicate environment entries and bounds violations reject before presentation. General projections carry no diagnostic excerpt.
- `console/schema.ts`: optional validated `details` collection and 8192-byte explicit managed goal text, separate from ordinary 512-byte display labels.
- `WorkbenchDetail.qml`: exact proposal/Goal/Role/Node/predecessor/vacancy facts, resolved executable/argv/environment/resource hashes/baseline/limits, handoff claims and outstanding effects, and separate dispatch-revocation/cancellation facts. Diagnostic review explains explicit consent, filtering limits and unavailable detail transport.
- Full scrollable confirmation/consent **previews** use the actual dialog. They display all supplied facts but cannot send start, Adoption authorization or diagnostic-access requests: those runtime ports remain unimplemented. Existing supported injected intents still require confirmation. No preview is represented as an accepted authorization.
- `WorkbenchForms.qml`: goal and Assignment drafts include Run, gate version, argv, cwd, environment/resources, timeout/output and correction/elapsed limits. Drafts are keyed by Project/Goal/selected Run. They restore across target changes and console close/reopen in the retained presentation instance. Adapter synchronization keeps ordinary updates from destroying text. Capacity failures are visible; drafts never constitute confirmations.
- `WorkbenchConsole.qml`: any changed projection invalidates queued clicks/confirmations; a local two-second watchdog also revokes presentation actions when host updates cease. Preview review cannot enter the intent queue. Dialog cancellation/expiry clears the confirmation. Panel dimensions clamp to the available screen, dialogs scroll, and focused form controls are brought into the main scroll viewport.
- Authored text uses explicit plain-text rendering, including dynamic action/Project/Goal labels. Controls use explicit Omarchy palette bindings, visible native Qt focus behavior and named form fields. Native decorative surfaces are namespace-qualified so they cannot shadow Qt Controls types.
- Companion 0.6.0 packages the six presentation sources; subsequent preview preparation adds a thin native host. The manual-only setup adapter adds an entry-point forwarder for the historical installer. Historical 0.2.0/0.3.0/0.4.0 sources/defaults and prototype runtime files are unchanged. 0.6.0 remains an uninstalled candidate, not an immutable previously accepted release.

## Executable evidence

Command: `just --no-dotenv local-workbench-v1-check`.

- **97 Node tests: 92 pass, zero fail, five explicitly deferred runtime TODOs.**
- The passing Qt subprocess case contains **8 passing Qt test rows, zero failures/skips**, including setup/cleanup. It executes real QML child components and the actual root dialog/methods. Only the native layer-shell host is substituted with an offscreen Qt Window, and theme/decorative-surface ports are inert fixtures. Actual Qt Controls/layout/input execute; no installed shell plugin or user configuration is loaded.
- Qt cases cover narrow/wide geometry, literal markup-like handoff text, real field draft restoration across target changes/reopen, palette application, Tab/Shift-Tab, Escape cancellation, a confirmed stop intent, and stale queue revocation. Image capture verifies renderability but is not an operator-reviewed screenshot or native compositor validation.
- VM composition separately covers real adapter/root methods, draft retention, exact detail previews, same-revision invalidation and presentation timeout.
- Static QML lint exits 0. Installed Quickshell uncreatable-type/static dynamic-property metadata warnings remain; offscreen fixture rendering reports no QWARN, assignment errors or binding loops. Neither result certifies the installed native host.
- The eleven affected prototype suites recorded in the [validation ledger](local-workbench-v1-validation.md) were rerun: **163/163 pass**, zero TODOs/skips/failures.
- `bash -n packages/local-workbench-v1/scripts/phase-gate.sh`, `git diff --check`, and historical-source preservation checks pass.

Ephemeral logs: `/tmp/workbench-phase1-followup.log`, `/tmp/workbench-followup-regression.log`. Test scratch resources and rendered images are removed after execution. No installation, live desktop/Pi/provider/service launch, real Project mutation, commit or push occurred.

## Red-to-green findings

The follow-up did not merely add fixtures:

1. Namespace ambiguity exposed `Button` properties unsupported by the shadowing native type; imports are now qualified.
2. Actual Qt input showed multiline editors consuming Tab; explicit focus routing fixes it, with Shift-Tab and Escape tested.
3. Actual palette readback rejected a nonworking palette-object approach; explicit Control palette bindings now match injected theme colors.
4. Same-revision detail changes and a silent presentation host now invalidate pending actions, rather than allowing an old click to acquire changed context.

## Remaining boundary

One separately authorized native narrow/wide layout checkpoint remains: actual Omarchy theme, compositor edge reservation, screen/scale behavior, full form traversal and focus/scroll usability on the installed release. Do not translate the offscreen host substitute into native-shell evidence or repeat unrelated Pi/restart checklists.

Runtime start, Adoption authorization and restricted diagnostic access stay disabled until their complete ports are implemented in the relevant phases. There is no gate execution, candidate hashing, persistence, writer admission or same-Pi dispatch here. The [Phase 2 handoff](../plans/local-workbench-v1-phase-2-handoff.md) remains zero-dispatch.

Before Phase 3 gate execution, exercise the C7/C9 resource closure and all-file candidate fingerprint rules against representative ordinary build/test commands. Their treatment of ignored files and validator-created outputs may be operationally restrictive. This follow-up changes no candidate/gate policy and makes no claim that presentation tests establish its practicality.
