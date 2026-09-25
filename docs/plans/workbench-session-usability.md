# Workbench session usability

Status: operator-approved sequence; implementation in progress after checkpoint `b080113`.

## Agreed scope

The operator approved three bounded slices after two indistinguishable observed
rows offered different Adoption actions. Finish the local workbench's usability
before extending execution. No Assignment/check execution, live Adoption,
installed Companion update, Pi reload, or automatic terminal launch is authorized
by this implementation request.

1. **Honest eligibility.** Project activity, health and a runner-owned reason for
   unavailable Adoption. Keep connection availability separate from eligibility.
   Exercise two connected/running observations with differing activity, busy to
   idle, unknown/degraded/disconnected, missing Goal and occupied/reserved Roles.
   Preserve same-button confirmation and runner revalidation. Exit gate: the
   disposable Phase-2 gate including actual offscreen QML passes.
2. **Human session identity.** Show a short collision-checked visual code in both
   the dock and the same Pi's named status slot, including managed presentation.
   The code is presentation only, never a connection capability or Adoption
   credential. Specify lifetime, reconnect, collision and old-extension behavior;
   test same-process correspondence, replacement, expiry and status-slot isolation.
   No conversation content, title parsing or cwd correlation. Exit gate: paired
   real bridge/fake Pi plus rendered rows, then separately authorized live check.
3. **Checked terminal navigation.** After the correlation spike, the operator
   approved bounded best-effort **Show terminal pane** while retaining Herdr.
   Route through the exact connected Pi extension, check its current pane and
   original ancestor window, and revalidate before each focus step and afterward.
   Failed preflight says unavailable; uncertainty after dispatch says unknown;
   atomic occupant/attachment selection is not promised. Missing correlation says unavailable;
   it never launches a replacement, adopts, dispatches input or changes control
   mode. Ordinary-terminal focus does not promise reattachment or PTY ownership.
   The Boomux spike is evidence, not an integrated Local Workbench runtime port.
   Exit gate: executable stale/ambiguous/window-loss failure tests and real intent
   routing, followed by a separately authorized physical desktop focus check.

## Evidence boundaries

Each slice gets its own checkpoint before moving to the next. Disposable tests
must not contact live Pi, the installed shell, compositor or user state. Physical
matching and focus acceptance cannot be inferred from fixture callbacks. One
checkout writer; independent review is reported separately from host tests.

## Slice 1 — engineering checkpoint

Implemented in the development tree, not installed:

- Observed card schema now validates `activity`, `adoptionReasonCode` and
  `adoptionReason`. Overview and Add agent show activity/health and the runner's
  literal bounded reason. Connection availability is explicitly labelled as such.
- One runner-owned eligibility query gates request choices and explains busy,
  unknown, waiting, unhealthy, disconnected, non-running, identity/fence,
  Project/Goal, existing management, pending proposal, capacity and Role conflicts.
- Reserved Roles no longer produce competing request choices. A pending proposal
  whose activity or exact connection changed has disabled authorization and a
  reason. Propose/authorize/ACK still perform their own current-state validation.
- Snapshot construction expires proposals before projecting reservation facts.
  Unchanged idle heartbeats retain choice IDs; becoming busy revokes old choices.
- A pre-existing historical recovery test followed the active release (0.12.0)
  rather than its 0.11.0 incident. Both incident comparison and fixture now use
  retained 0.11.0, checked against its fixed archive hash; the historical evidence
  digests and live authorization boundary were not widened.

Reproduction: `bash packages/local-workbench-v1/scripts/phase-2-gate.sh`.
The full disposable gate passes, including 23 offscreen Qt rows. Regression tests
in `test/session-eligibility.test.ts` first failed on missing projected activity
and incorrect reserved-Role choices. The rendered regression shows both rows,
checks the busy reason in Overview and Add agent, and restores the second Adopt
button only after an authoritative idle update. Old idle choice submission after
busy activity is rejected without creating a proposal or Run.

This proves an explainability/eligibility repair, not the exact historical
heartbeat value in the screenshot. No live installation, Pi reload, Adoption,
Assignment delivery, compositor action or physical UX validation was performed.
Verification is host continuation, not independent review. Slice 2 is recorded
below; slice 3 remains pending. The live dock and Pi footer are unchanged until
an explicitly authorized installation/reload.

## Slice 2 — shared session code checkpoint

Implemented: collision-checked `Pi XXXX-XXXX` display codes now travel through
optional bridge capability negotiation to the same Pi's named status and the
observed/managed dock rows. Reconnect preserves codes within one owner lifetime;
owner restart renegotiates them. Unavailable/legacy/disconnected codes are
explicit, never fabricated. No code grants authority or maps a terminal window.

The [contract and tests](../reviews/local-workbench-phase-2-verification/session-code-checkpoint.md)
record bounds, lifetime, older-extension behavior and privacy. The full disposable
Phase-2 gate passes (including 24 offscreen Qt rows); `git diff --check` passes.
Local log: `/tmp/wb-session-code-gate.log`. No physical matching or independent
review is claimed. Slice 3 is next: establish and test exact current terminal
correlation before adding the focus intent or compositor adapter.

## Slice 3 — correlation spike and approved checked-navigation policy

Everything through slice 2 was checkpointed as `7eac1e8`; nothing was pushed.
The [read-only terminal-focus spike](../../spikes/terminal-focus/README.md) now
has an executable diagnostic, reduced public-schema evidence and eleven passing
offline tests. Both current Pi sessions map diagnostically to separate Herdr
panes inside the same Foot window. Focusing only the window would not select the
right Pi panel.

Herdr's public focus calls have no expected-occupant guard; the public snapshot
also lacks current attached-client/window identity. A preflight followed by an
unguarded focus call cannot promise atomic exact-agent navigation. At that spike
checkpoint, no production focus intent/adapter was enabled and no live focus was executed. No new Pi
telemetry, authority or user configuration was introduced.

The operator subsequently chose the first option: keep the existing Herdr layout
and implement bounded best-effort **Show terminal pane**. The strict atomic-focus
blocker remains a runtime limitation, not a reason to imply atomic success.
The authoritative MVP and terminal behavior now record that policy.

Implemented in the development tree: one-click observed/managed row navigation,
a fresh connection-bound runner ticket, receipt-before-send and replay suppression,
real framed requests/results in the same-process Pi extension, and a lazy local
Herdr/Foot/Hyprland leaf adapter with bounded commands and pre/post checks. No raw
OS/routing metadata crosses the bridge. Unknown or unsupported arrangements are
not guessed; after a possible mutation, failed verification reports unknown.

The [checked-navigation checkpoint](../reviews/local-workbench-phase-2-verification/checked-pane-navigation.md)
records the precise supported arrangement, attachment/atomicity limitations and
failure gates. Full disposable Phase-2 gate: **PASS, 25 offscreen Qt rows**;
read-only spike: **11/11**. This is host continuation, not independent review or
physical focus acceptance. At that engineering checkpoint no installed update,
Pi reload, terminal launch, live focus, Adoption or execution occurred.

The subsequent explicit **install and reload** request installed/loaded Companion
**0.13.0** after preserving the freshly discovered installed 0.12.0, then restarted
the identity-checked existing Owner to epoch 12. Receipt/assets, unrelated config,
Project/Goal records and disconnected/retired history were verified preserved.
Existing Pi panes still need the operator's `/reload` when idle; fresh extension
identity does not recover a disconnected or retired Run. No live focus/Adoption
or physical matching acceptance is claimed. The linked checkpoint records exact
installation evidence and the separate Pi reload boundary.

## Operator-reported latency and excessive row text

Following installation, the operator reports actual pane switching but rejects
its roughly 1–2 second latency for frequent use. Other non-menu actions, including
Close, are also slow; the dock flickers roughly once a second and agent rows carry
too much explanatory text. This is live feedback, not UX acceptance.

The [investigation](../../spikes/terminal-focus/LATENCY.md) confirms the shared
1000 ms action poll, nine synchronous shell calls before a navigation request and
fourteen through Close. Read-only local shell calls measured ~31 ms each; the
pane/process/window read pass measured ~13 ms. Identical heartbeat row destruction
was **not** reproduced offscreen; changed row data did recreate delegates/reset
inline state. The native flicker cause remains open.

Recommended next slice: responsive action delivery, bounded generation-checked
IPC batching/reuse, liveness separate from visible updates, stable rows and compact
normal-state presentation. Keep uncertainty visible and all exact-target/receipt
checks; do not simply remove safety checks or accelerate the existing expensive
poll loop. No implementation or new installation is implied by these diagnostics.
