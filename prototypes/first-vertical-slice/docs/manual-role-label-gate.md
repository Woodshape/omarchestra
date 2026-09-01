# Manual role-label gate — plan only (first vertical-slice prototype)

Status: **PLAN ONLY — performs no action.**
This document is a written procedure for a later human-authorized run. Nothing
in this repository executes it, and the automated acceptance gate must never
invoke it: no GUI action, live process action, Pi host, or terminal is started
by or through this plan.

## Question the gate answers

Do the **real** Pi extension status surface and the **real** native terminal
title identify each visible agent's fixed role and its current
`managed` / `waiting` / `manual_takeover` state, without reading any
conversation content?

The automated prototype only proves fake presentation adapters. This gate is
where a human proves the real label surfaces.

## Preconditions (human-authorized only)

1. One visible interactive Pi host per role (Coordinator, Builder, Reviewer),
   each running the bridge extension configured with its role binding, native
   terminal-title hook, and Pi-status hook.
2. One foreground runner serving the same Team Goal the bridges are bound to.
3. A writable private evidence location outside the repository for
   screenshots/transcripts (never inside Git).
4. Authorization to submit one interactive message in the Builder terminal.

## Procedure

1. **Idle identification.** Without scrolling any conversation, read each of
   the three native terminal titles and each Pi status surface.
   - Each title must match `Omarchestra — <Role> — <state>` with state
     `waiting` while idle.
   - Each Pi status surface must match `<Role> · <state>`.
2. **Surface independence.** Cover one surface at a time; each surface alone
   must identify the role. Roles must not be identifiable only by combining
   surfaces or by assignment text.
3. **Managed state.** After the runner dispatches the Builder assignment,
   re-read both Builder surfaces: both must show `managed`, and both
   Coordinator and Reviewer surfaces must still show `waiting`.
4. **Takeover transition.** Submit one ordinary interactive message in the
   Builder terminal. Re-read both Builder surfaces: both must show
   `manual_takeover`. Confirm Coordinator and Reviewer surfaces are unchanged.
5. **Persistence.** Leave the terminals idle for at least one minute and
   re-read all surfaces; labels must remain visible and unchanged (not
   transient, not overwritten by harness output).
6. **Distinctness.** All three native titles must be mutually distinct, and
   all three Pi statuses must be mutually distinct, at every observed moment.

## Failure rules (the gate fails if any of the following holds)

- Any role cannot be identified from **either** required surface without
  reading conversation or assignment content.
- Any label is missing, stale relative to the observed control state,
  duplicated across roles, or visible only transiently.
- A state change (managed → manual_takeover) does not appear on **both**
  Builder surfaces.
- A Coordinator or Reviewer surface changes during the Builder takeover.
- Identity requires reading conversation content, terminal scrollback, or the
  Agent Console.

## Recorded output

The operator records, per role and per surface, the exact observed string and
timestamp, plus the takeover-transition observations, in the private evidence
location. The gate result is then appended to the prototype README verdict
notes by a human — never automated.