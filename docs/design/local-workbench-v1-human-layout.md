# Local Workbench v1 — one native layout walkthrough

Status: **Corrected 0.7.0 candidate fake-tested; native UX validation of this candidate unrun.** See the [correction closeout](../reviews/local-workbench-ux-redesign-corrections.md). Historical 0.6.0 dock feedback does not establish acceptance of this redesign.

This is the consolidated Phase 1 UI checkpoint, not a live agent execution gate.
All displayed Projects, Goals, agents and results are labelled fixtures. No Pi is
started/adopted, no Assignment or gate executes, and no board messages are sent.
The presented journey is the task-first contract in the
[screen and flow design](local-workbench-v1-screens.md).

## Preparation

Stop any old disposable observer/Adoption gateway first using its normal shutdown
path. Leave Pi itself usable; this procedure does not kill or control it.
Installation replaces the existing Companion UI with candidate 0.7.0. It does
not run alongside the old installed UI. Preserve existing agent work.

From the repository in a normal interactive terminal:

```sh
node --experimental-strip-types manual/local-workbench-preview.ts --setup
```

Read the exact installation plan and confirm `y` only if acceptable. Setup reuses
the existing receipt/digest/ownership-checked installer through a manual-only
adapter, not a new production dependency. Its `AgentConsole.qml` is a new tiny
forwarder to `WorkbenchHost`, satisfying the historical installer's entry-point
contract; historical source assets are not copied or changed. The native host
owns only its local plugin incarnation generation. The core view remains injected.
An already-identical installation is not updated again, preserving its prior
receipt-backed release. A changed candidate at the same version is a normal
update, so a fixed layout is reinstalled simply by re-running `--setup`; the
previous release is retained in the receipt for `--restore`.

**Then restart the shell.** Installing files does not reload them. Quickshell
keeps the panel instance alive (`keepLoaded`), so a running shell continues to
show the previous QML until it is restarted:

```sh
omarchy restart shell
```

This restarts only the desktop shell. It does not stop Pi, gateways, terminals
or any agent work. Skipping this step means validating code that is no longer on
disk; `--preview` now refuses to run in that state and prints this exact remedy. Drift, ownership or compatibility failures stop; do not
repair them by deleting unknown paths.

```sh
node --experimental-strip-types manual/local-workbench-preview.ts --preview
```

Type `PREVIEW` when asked. Preview preflight verifies the installed candidate,
summons the addressed component (the host loads a panel only when summoned, and
never reloads an already-loaded one), and compares the loaded component's
instantiation time against the receipt that installed the assets. If the running
shell predates the installation, preview stops and asks for `omarchy restart
shell` instead of showing stale code. Preview then captures an installation
fingerprint and opens one exact ephemeral session.
It cannot steal an already-active preview session and clears only its own session.
Runtime never installs/rescans/updates/unloads the Companion or writes configuration.

## Walkthrough

The terminal accepts these fixture names:
`journey` (default), `projects` (two-Project navigation), `stale`, `gap`, `error`, `takeover`, `reconciling`, `gate_pass`,
`gate_fail`, `gate_timeout`, `retired_leaf`, `board_disabled`, `no_check`,
`invalid_check`, `artifact_only`. `journey` is the default realistic creation
journey and has no committed Assignment, so its `Work and result` destination
shows the empty state; the remaining names are opt-in single-scenario variants
that supply committed work, history and outcome states.

1. **Layout:** with `journey`, walk Overview → Goal → New Team Goal → Add agent →
   Adoption review → Assignment preparation → Start review → Work and result and
   back again (the journey shows the empty result state; type `gate_fail` for a
   committed result row). The dock must **not change size** at any step: terminals and other
   windows keep their exact geometry while content, menus, the confirmation dialog
   and retired history change inside the surface. Report immediately if the dock
   or neighbouring windows shift. Check dock space reservation, native theme,
   text contrast, wrapping and scroll reachability. Keep native terminals visible.
   Test the intended screen/scale; report any untested multi-monitor
   configuration. A full-screen workspace mode is out of scope for this slice.
2. **Creation and context:** open New Team Goal, enter disposable text, and confirm
   that `Create` stays a presentation intent — nothing durable is created and no Pi
   launches. Open `Change` to expand the Project list, then Escape: focus returns to
   its invoking Change control and the surface does not resize. Type `projects` to switch between two fixture Projects while retaining a separate Goal draft for each. Confirm the Project selector, current
   Goal, runner state and fixture label stay visible at every destination.
3. **Keyboard and focus:** traverse the journey with Tab/Shift-Tab only. Focus
   must stay visible, multiline editors must hand Tab to the next control instead
   of trapping it, the `⋮` menu must open with Enter/Space on its trigger, traverse
   its entries with Tab/Shift-Tab, activate with Enter/Space, close with Escape and
   return focus to its trigger, and Escape must cancel the confirmation dialog
   before navigating Back. The default journey Goal has only a disabled action, so
   the open menu shows its reason and offers no focusable entry.
4. **Selection is not authority:** in Add agent and Assignment preparation, select
   an unassigned session, a Role, a target agent and an acceptance check. Every
   management intent must be rejected as fixture-only (`fixture_only_no_management`);
   `Confirm start`, `Authorize adoption` and diagnostic access stay visibly disabled
   with reasons. Nothing is bound, adopted or dispatched.
5. **Checks and review:** open Checks, select Unit tests and expand Advanced definition. Edit executable, arguments (one per line), working directory, nonsecret environment entries, resource paths and limits. Invalid paths/limits disable Save with an explanation; Save only emits a fixture-rejected configuration draft. Back retains drafts. For the staged start proposal, use task `Ship the parser fix`, Builder and Unit tests v3. The default review shows task/check/consequences first; Technical details reveals exact identities/hashes/environment/resources. Different task text truthfully has no matching fixture proposal. Use `no_check`/`invalid_check` to verify blocking reasons.
6. **States:** visit the remaining fixture names. Check managed/unassigned/retired
   distinctions, collapsed history, purge-blocked reasons, handoff effects, gate
   pass/fail/timeout results and stop's explicit lack of process-termination proof.
   Confirm that takeover/return/reconciliation/stop copy is task-specific and that
   no state shows a fabricated percentage or claims semantic review.
7. **Stale:** type `stale`, wait over two seconds and verify stale indication and
   disabled authority actions. Type `live` to resume fixture updates.
8. **Reopen:** type `hide`, verify dock space is released, then `open`. Drafts
   remain in this retained view; no process-restart persistence is promised.
9. **Finish:** type `done`, then `LAYOUT PASS` only if the complete checklist
   passed. Otherwise enter another answer or `quit` and describe the problem.

Cleanup clears the exact session, releases the dock and checks the installation
fingerprint. The installed Companion remains installed. Verdict evidence is
owner-only under the printed workbench-layout directory outside Git. PASS means
operator-attested native fixture layout plus exact cleanup/fingerprint checks;
it is not proof of real agent work or a durable workbench.

## Restore the previous installed UI if desired

After quitting preview, this is a separate confirmed setup operation:

```sh
node --experimental-strip-types manual/local-workbench-preview.ts --restore
```

It offers the receipt-backed previous release and requires its exact displayed
installation plan to be approved. It never deletes external work/Pi history.
If no prior release exists or assets drifted, restoration stops rather than guesses.

## Automated boundary

`just --no-dotenv local-workbench-v1-check` now includes the preview tests:
120 Node tests, 115 pass, five deferred runtime TODOs; sixteen passing offscreen Qt
rows; static lint passes with the previously documented metadata warnings.
The manual tests compose actual QML session methods with an injected controller,
exercise candidate installation/restoration through the existing fake installer,
and verify every live CLI mode rejects non-TTY before live imports/resources.
`--check` is no-resource apart from repository source reads. No live setup or
human verdict has been produced by these tests.
