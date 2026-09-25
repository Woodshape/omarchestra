# Pi terminal behavior

Status: **MVP behavior locked; bounded fake-only observer prototype green; R1 accepted as bounded risk; human observation PASS accepted; live Adoption not run.**

This document specializes the authoritative MVP design for visible Pi terminals. It does not grant QML, the observer, or the terminal runtime additional domain authority.

## One visible process

Every working Agent Run is the actual interactive Pi process visible in its native Ghostty/Hyprland terminal. Omarchestra does not hide a JSON/RPC worker behind an Agent Console card, scrape ANSI or PTY output, or mirror conversation content into QML.

The extension inside that same Pi process is the only source of structured Pi lifecycle facts. The Team Runner commits orchestration state; Pi renders the committed presentation value and emits bounded observations.

## Managed terminals

Omarchestra-launched agents begin immediately as visible Coordinator, Builder, and Reviewer terminals. Roles without work display `waiting` rather than remaining hidden.

For each managed Agent Run:

- the Pi status surface persistently displays the committed `<Role> · <state>` value;
- the Agent Console card repeats that exact committed value;
- dynamic terminal metadata is `Omarchestra — <Role> — <state>` for Hyprland and switchers only;
- Ghostty remains decorationless and is never launched with a pinned `--title`;
- assignments enter the visible Pi through the extension's same-process Pi API only after the Team Runner commits them;
- structured lifecycle and attention events leave through an owner-only authenticated channel, never through terminal scraping.

Boomux owns managed PTYs, process attachment, detach/reconnect, and resize. Omarchestra references those capabilities through opaque Runtime Bindings.

## Standalone observer panel placement

The user-selected standalone observer surface docks to a configurable screen edge
(left by default; right, top, and bottom also supported). It reserves compositor
space so tiled terminals move aside, rather than covering them with a centered
overlay. Closing the observer surface releases that space. This is presentation
only and grants no terminal or process authority. Managed-panel behavior is
unchanged.

## Ordinary terminals

Product setup may install one opt-in global Omarchestra Pi observer extension. This allows a Pi started normally in a terminal opened through `Leader+Enter` to announce itself to the local owner-only Agent Registry without changing how the user launched or controls Pi.

A discovered ordinary session:

- appears in the Agent Console under **Unassigned Agents** as an **Observed Pi Session**;
- displays `Unassigned · observed` in Omarchestra's named Pi status slot while connected, without replacing unrelated extension statuses;
- retains its ordinary terminal title and receives no Omarchestra terminal metadata;
- has no Team Goal, Role, Assignment, Agent Control Mode, writer lease, Runtime Binding guarantee, or orchestration authority;
- receives no prompt, assignment, keystroke, cancellation, process action, or lifecycle supervision from Omarchestra;
- remains usable when the registry or Companion Plugin is absent, restarting, incompatible, or unreachable.

Observation reports only protocol/version, exact ephemeral session identity, process instance identity needed for same-process correlation, lifecycle state, availability/busy eligibility, and bounded health facts. It excludes prompts, responses, thinking, tool arguments and results, terminal output, repository contents, credentials, and environment values. For the bounded prototype, [ADR 0003](../adr/0003-use-connection-bound-observer-capabilities.md) selects random process/session/extension capabilities bound to the exact current local connection and fresh challenges. The [Observer and Adoption v1 contract](../../prototypes/first-vertical-slice/docs/observer-adoption-v1.md) fixes strict envelopes, monotonic ordering, a five-second heartbeat, a fifteen-second lease, privacy classes, reconciliation, and atomic commit behavior. Sender wall clocks do not authorize expiry. PID, title, cwd, focus, recency, display name, or equal strings never authorize correlation or Adoption.

The removable observer/Adoption prototype is now fake-only green across its
protocol, privacy, registry, acknowledgement, projection, transaction,
transport, gateway, and launcher seams. It is not live feasibility evidence.
The human-only procedure is documented in
[`observer-adoption-live-validation.md`](../../prototypes/first-vertical-slice/docs/observer-adoption-live-validation.md);
automation runs only its no-resource `--check` path. Automation performed no
live run, and no live Adoption claim is made.

The observer publisher targets Companion 0.3.0's additive `session.observer`
capability and explicit sessionless `openObservedAgents`,
`applyObservedAgents`, and `clearObservedAgents` lifecycle. Fake-only evidence
shows that it opens and updates a standalone `Unassigned Agents` panel and
clears only observer state. It does not use managed summon, fabricate a managed
projection, populate the managed cursor, or create a Projection Session. If a
managed panel is open, observer update and clear leave its identity, cards, and
visibility unchanged. The operator reported live observation verification PASS
and accepted the slice (closeout recorded 2026-09-08). Live Adoption remains
unrun; detailed evidence limits are recorded in the observer live bridge spike.

The Pi 0.84.4 public surface lacks a complete content-free start/end lifecycle
for slash-command and `user_bash` execution. The current bounded contract
accepts `ctx.isIdle()` plus its existing guards as best-effort reconciliation,
without inspecting content; this R1 limitation is recorded for later hardening
and is not a stronger Pi attestation.

## Approved local-workbench usability slices

The operator approved the [session-usability sequence](../plans/workbench-session-usability.md)
after observing indistinguishable rows with different Adoption choices:

- Expose structured activity and health independently of connection availability,
  with a runner-owned reason when Adoption is unavailable.
- Add a short collision-checked visual session code shared by the dock and that
  Pi's named status slot. This supplements `Unassigned · observed` (and managed
  Role/state); it is display identity only, never Adoption or connection authority.
  Unrelated status slots and ordinary terminal titles remain unchanged.
- Implement checked best-effort **Show terminal pane** as agreed below. Missing,
  ambiguous or stale preflight reports unavailable; uncertain post-dispatch
  verification reports unknown. It neither launches a replacement nor promises
  atomic exact-agent focus, PTY persistence or reattachment.

Slices 1 and 2 are implemented. After Companion 0.13.0 installation/Owner reload,
the operator reported using live pane navigation while rejecting its latency and
dense rows. Physical shared-code matching remains unvalidated. The approved
[responsive-dock repair](../reviews/local-workbench-phase-2-verification/responsive-dock.md)
is disposable-tested and now installed/loaded as 0.14.0 after a separately
authorized shell/Owner restart, preserving history and the existing manual-takeover
Run through reconnect. It provides code/activity defaults, visible
exceptions and inline facts, shared Project blockers once, stable rows and immediate
presentation wakeup/Close. It changes no Pi extension or terminal-routing checks. The [shared-code contract](../reviews/local-workbench-phase-2-verification/session-code-checkpoint.md)
uses independent collision-checked `Pi XXXX-XXXX` codes negotiated through the
exact observer connection. Codes persist for that incarnation within the owner
lifetime, including lease expiry/reconnect; a new owner renegotiates them. Only
the currently connected bridge projects a code. Legacy or disconnected rows
explicitly show code unavailable. No stored conversation identity or connection
capability is shortened into a display code, and codes never authorize an action.
The linked sequence owns implementation checkpoints and evidence limits. Checked
navigation is implemented and disposable-tested, with Companion 0.14.0 now
installed/loaded. Navigation now has operator-reported use, but no independent
physical focus/latency acceptance. The [terminal-focus spike](../../spikes/terminal-focus/README.md)
found two current Pi panels in separate Herdr panes inside one Foot window.
Window focus alone therefore does not satisfy exact Pi navigation. Herdr's public
focus targets a pane/agent location without an expected-occupant guard, and its
public snapshot does not identify current attached-client/window bindings.
The operator subsequently approved **checked best-effort “Show terminal pane”**
while keeping the existing Herdr layout. This supersedes the strict atomic-focus
requirement for this bounded local ordinary-terminal path only: inspect the exact
Pi's current pane and unique original ancestor window, revalidate before each
focus step and after both, and report unavailable before mutation or unknown if
verification fails after mutation. The unavoidable check/dispatch interval is
explicitly accepted; no atomic exact-agent guarantee is claimed. Reattached or
ambiguous presentations without the original ancestor window are unsupported.
Stable process ancestry is not runtime attestation of the currently attached
client: attachment changes that leave those facts intact may escape the checks.
This limitation is not relabelled as verified attachment or exact-agent focus.

The operator subsequently approved a second bounded local path: a standalone
Foot window on Hyprland, without Herdr. Require the addressed Pi's direct
foreground process group, interactive input/output on that controlling TTY, a stable bounded same-TTY
shell ancestry to its original Foot process, and exactly one mapped/non-hidden
Foot window for that process. Unknown wrappers/multiplexers, TTY hops, incomplete
inherited Herdr context, and ambiguous/changed windows refuse; failure of a Herdr
proof never falls back to standalone window focus. Focus only that checked window,
then recheck the proof and active-window address. No pane identity is invented.
Both paths probe supported compositor focus syntax read-only before dispatch;
CLI success alone still cannot report `shown`. This is not general terminal-host
support or attachment attestation. Live focus and extension reload remain separate.

Navigation executes only inside the addressed same-process Pi extension after an
explicit runner-issued, connection-bound request. A leaf adapter may locally use
its inherited Herdr routing context, procfs process/start/TTY metadata and public
pane/window metadata. No routing environment value, PID, title, argument, path or
terminal output crosses the observer bridge or reaches QML. These facts are for
presentation checks only, never Adoption, process identity or management authority.
Unknown environments fail without guessing the focused session. There is no
terminal launch, attachment, layout change, keystroke/input injection, notification
or automatic retry. “Shown” means only the post-check succeeded at that instant.

## Adoption

Adoption is an explicit user action, not a side effect of discovery or focus:

1. The user selects one current Observed Pi Session in Unassigned Agents.
2. The user selects a local Team Goal on the session's Execution Node and an unoccupied Role, then confirms the authority change. MVP ordinary-terminal sessions cannot be adopted into a remote Team Goal.
3. The Team Runner proposes an exact binding to the extension inside that same Pi process.
4. The extension verifies its current identity and activity and acknowledges or refuses from inside that same process.
5. The Team Runner reconciles current activity and commits the Agent Run, Role, control mode, and presentation value atomically.
6. Only after commit may Omarchestra send managed work. The footer changes from `Unassigned · observed` to `<Role> · <state>` and managed title metadata begins.

Node-mismatched, unknown, stale, exited, duplicate, busy, already-managed, role-conflicting, or unacknowledged sessions fail closed. A failed attempt leaves the Pi ordinary, interactive, observed when still connected, and unassigned. Adoption does not fabricate prior work or claim Boomux PTY persistence unless a managed Runtime Binding is separately and exactly established.

The bounded live-Adoption engineering integration is now fake-tested and
independently reviewed: Companion 0.4.0 adds a separate Adoption session,
commit delivery is followed by same-Pi readiness, and interactive input creates
a durable takeover marker without reading content. Gateway recovery requires
the same surviving Pi/extension, exact owned runtime evidence, and a fresh
connection challenge. This does not add Pi-process/reload/reboot recovery or
PTY guarantees. Installed setup and human live Adoption validation remain
unrun; see the prototype's `live-adoption-engineering-handoff.md`.

## Human input and takeover

Human input is always possible in the visible Pi terminal.

- Input to an Observed Pi Session is ordinary autonomous use and creates no takeover event because Omarchestra has no control authority.
- Input that steers a managed Agent Run enters `manual_takeover`, pauses dependent orchestration, and requires structured handoff and explicit reconciliation before managed dispatch resumes.
- The extension does not suppress user input or inject terminal keystrokes.
- Pi/provider/auth approvals remain in the exact terminal; runner-owned structured decisions may appear in the Agent Console.

## Restart and exit

A Companion Plugin reload affects only its Projection Session and never interrupts Pi. The bounded fake-only Companion slice proves that the old plugin generation is rejected, a new Projection Session identity is allocated, identical cards are reconstructed from a fresh authoritative snapshot, and fake agent identities, connections, assignments, and delivered turns remain unchanged. The separate human gate on 2026-09-03 also confirmed identical live cards after supported rescan without interrupting the three visible Pi identities.

A registry/runner restart reconstructs observed and managed presentation from fresh same-process registrations and authoritative snapshots; it does not infer identity from stale terminal metadata.

When an ordinary Pi exits or its observer disconnects beyond the bounded expiry contract, its Observed Pi Session becomes unavailable and then disappears or is retained only as explicitly stale history. It cannot be adopted or assigned while stale. Managed Agent Run exit follows the Team Runner's failure and recovery policy instead.

### Explicit retirement and replacement

The user may explicitly retire a disconnected or exited Agent Run, then adopt a new observed Pi into the vacated Role. Retirement permanently fences the old Run's orchestration authority and preserves its history while retained; it does not kill Pi or delete its session file. A separate explicit Delete Retired History action may remove a terminal retired Run's Omarchestra history and card while retaining only a minimal non-presented identity fence; it never deletes Pi history, session files, processes, tools, or external artifacts. A predecessor with a replacement descendant remains until successors are purged first. A reconnecting retired extension cannot reclaim the Role.

The user launches the replacement in a visible terminal and may manually resume their saved Pi conversation. That process remains Unassigned until fresh confirmation, exact same-process acknowledgement, reconciliation, and Adoption commit create a new Agent Run linked to its predecessor. Failed Adoption leaves the Role vacant, not rebound to the retired Run. No Assignment is automatically resumed or transferred. Possible surviving tools and uncertain checkout effects require separate reconciliation before conflicting work.

This is approved behavior. See the authoritative [retirement policy](mvp.md#explicit-retirement-and-replacement), [purge decision](../adr/0004-explicit-purge-of-terminal-retired-history.md), and [implementation task](../plans/explicit-retirement-replacement.md).

## Installation boundary

Observer and Companion Plugin installation, compatibility verification, update, rollback, and uninstall are explicit product-management operations. Starting or cleaning a Team Goal never installs, updates, disables, or removes either component and never writes Omarchy or Pi global configuration.

The Companion prototype fake-proves this split through injected ports: one authorized installation remains enabled across two Team Goals, while open, reconnect, clear, hide, and cleanup leave plugin assets, receipt, and `shell.json` bytes unchanged. `just prototype-companion-check` reproduces that unattended evidence. The separate TTY- and exact-authorization-gated `just prototype-companion-setup-validation` procedure passed on 2026-09-03; its before/after installation fingerprints matched and its runtime resources reconciled absent while the plugin remained enabled.

Ordinary-terminal observation and Adoption were not implemented by the Companion milestone; they now have a bounded fake-only prototype with protocol, privacy, registry, acknowledgement, reconciliation, projection, transaction, and standalone observer-panel lifecycle evidence. Companion 0.2.0 remains the immutable historical managed default, while observer-capable 0.3.0 is selected explicitly. Observer installation lifecycle, production persistence and socket trust, and human live validation remain open. The proposed human-only procedure is recorded in [`observer-adoption-live-validation.md`](../../prototypes/first-vertical-slice/docs/observer-adoption-live-validation.md) and has received operator-reported observation PASS; live Adoption remains unrun.
