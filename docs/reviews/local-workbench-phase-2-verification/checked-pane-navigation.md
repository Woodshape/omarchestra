# Checked “Show terminal pane” — development checkpoint

Status: **disposable engineering PASS; Companion 0.13.0 installed/loaded and Owner
restarted. The operator subsequently reports live navigation but rejects its
latency and dense rows; UX acceptance and independent review remain pending.** The operator chose checked best-effort navigation to
preserve the existing Herdr layout. This is not atomic exact-agent focus.

## Contract and implementation

- Overview observed and managed row headers expose **Show terminal pane**. One
  click emits `present` with an empty payload and a runner-issued opaque ticket.
  Navigation is not Adoption or a consequential authority change; existing
  same-button confirmations remain unchanged. No popup, tooltip or notification.
- Optional bridge capability `presentation.checked-pane` follows the existing
  three capabilities and `presentation.session-code`. Legacy extensions receive
  no ticket. A new extension against an older strict Owner can be refused while
  ordinary Pi remains fail-open; there is no silent compatibility fallback.
- Each current connection gets a fresh navigation ticket. The presentation
  adapter accepts only enabled projected targets. The Owner validates the whole
  intent, current revision, ticket, connection, lease and incarnation fence,
  then persists acceptance **before** attempting a `focus_request` write.
  Display codes, observed IDs, Run IDs, PIDs and window addresses are not tickets.
- The immutable receipt says `navigation_requested`, not “focused.” Replaying
  the same intent is outcome lookup only. No navigation outbox is replayed after
  an Owner restart. In-memory state and tickets are deliberately ephemeral.
- The request binds process/session/extension identity, observed ID and exact
  challenged connection. Pi revalidates those fields and its current TUI session.
  A monotonic request sequence prevents duplicate execution without an unbounded
  replay ledger. Only one local navigation may be in flight; connection/session
  replacement invalidates its guard before any further mutation.
- Only the addressed Pi extension invokes the lazy native leaf. No native OS or
  compositor operations run in the Owner, QML, module imports or extension setup.
  No terminal input, Pi API dispatch, adoption, takeover, terminal creation,
  attach, layout modification, configuration write or runtime upgrade is added.

## Native leaf and limits

Initial support is deliberately **local Herdr → original Foot window → Hyprland**:

1. Require inherited Herdr caller context and explicit local socket routing.
   Locally check socket ownership, ancestor safety and endpoint device/inode.
   Do not guess the UI-focused pane or use remote-machine forwarding.
2. Resolve `herdr pane current --current`; match the addressed Pi's own PID and
   foreground process group through `pane process-info`. Pin the current pane,
   terminal, tab and workspace IDs. Its shell must be below the Herdr ancestor.
3. Inspect a bounded procfs PID/parent/start/group/TTY chain to the original Foot
   process. The outer Herdr client must still be foreground on a different TTY.
   Require exactly one mapped, non-hidden Foot window for that terminal process.
   Multiple windows, vanished/reused processes, missing metadata or unsupported
   arrangements refuse without guessing.
4. Reinspect the complete proof before `herdr agent focus PANE_ID`, again before
   `hyprctl dispatch focuswindow address:ADDRESS`, and after both. Finally require
   the pane's focused flag and matching compositor active-window address.
   Herdr's explicit focus may mark its agent seen; it changes no Omarchestra
   control mode or ownership.

Fixed enumerated argv, no shell, fixed `/usr/bin` executables, minimal local
routing environment. Every command has a 600 ms timeout, SIGKILL for its exact
command child, 1 MiB output limit and an AbortSignal. The navigation operation
has a four-second abort timer; the Owner's result deadline is five seconds.
Process ancestry is limited to 32 entries; window/process inventories to 256.
CLI JSON can contain ancillary metadata; only allowlisted facts are inspected.
No routing environment, OS PID, path, argv, title or terminal content crosses the
observer bridge, reaches QML or is persisted as navigation telemetry.

**Remaining risk:** public Herdr focus has no expected-occupant guard, and public
metadata has no attached-client/window binding. Stable original ancestry is a
constrained presentation candidate, not attachment attestation. Detach/reattach
or other changes that leave the inspected facts intact may escape checks; the
interval before either dispatch is also unguarded. No successful CLI exit or
post-check removes these limitations. Unknown arrangements without the original
ancestor window are unsupported. This neither extends Boomux/remote guarantees
nor promises ordinary-session persistence or reattachment.

## Honest outcomes

`terminalNavigation` contains only `{target, enabled, state, reason}`:

- `idle`: available to attempt checked navigation, not guaranteed to succeed.
- `checking`: one request is in flight; another click is disabled/refused.
- `shown`: pane/window facts matched in the post-check **at that instant**, not a
  durable assertion that the window still displays that Pi.
- `unavailable`: local preflight failed before focus dispatch, or no capable
  current connection exists. These cases have distinct literal explanations.
- `unknown`: verification/command failed after a possible mutation, or the
  result deadline expired. Text explicitly says focus may have changed.

A disconnect during checking projects unknown with no usable target while that
observation is retained. Registry expiry can subsequently remove the observation;
no durable navigation history is fabricated. Reconnect changes the ticket and
starts idle. No automatic retry or rollback of a focus change occurs.

## Evidence and reproduction

```sh
bash packages/local-workbench-v1/scripts/phase-2-gate.sh
node --test spikes/terminal-focus/probe.test.mjs
git diff --check
```

Full disposable Phase-2 gate: **PASS**, including **25 offscreen Qt rows**.
Local log: `/tmp/wb-pane-gate.log`. Read-only spike: **11/11 PASS**.

Coverage:

- `test/pane-navigation.test.ts`: two panes sharing one window; exact fixed argv;
  process/start/parent/TTY/client-foreground drift; ambiguous/hidden/missing
  windows; wrong shell/pane/process group; changes before each mutation and after;
  command failure, deadline abort, connection loss, wrong post-focus state;
  strict wire/schema bounds and ancillary-metadata exclusion.
- `test/phase-2-framed-adoption.test.ts`: actual presentation adapter → durable
  authority → framed registry → real extension adapter → injected navigation;
  exact second-peer routing, receipt-before-send, receipt-failure/stale refusal,
  forged targets/identities, wire and intent replay, dropped result, reconnect,
  same-session replacement, adopted/taken-over continuity and in-flight guard
  cancellation. No Run, Assignment or control transition is created by navigation.
- `test/phase-2-real-bridge.test.ts`: request and result traverse a real disposable
  owner-only Unix socket into the actual Pi adapter with an injected navigator;
  legacy capability refusal. This is transport evidence, not desktop evidence.
- `test/rendered-layout.test.ts`: real offscreen QML row clicks emit one `present`
  intent with only the ticket, checking/disconnection disables it, and uncertainty
  stays visible without retry. Source audits permit only the narrow native leaf.

The first full-gate run caught a historical test expecting all `present` requests
to return `handler_unavailable`. Its no-current-target case now correctly expects
`navigation_unavailable`; it remains rejected, not disabled to obtain a pass.

At the engineering checkpoint no live focus, installation/reload, Adoption or
physical matching check had occurred. The last recorded installation then was
0.11.0 and development was 0.12.0; the later authorized preflight below supersedes
that historical installation information. Host continuation is not independent
review, and this checkpoint does not complete overall Phase 2 acceptance.

## Authorized installation and reload — 2026-09-25

The operator explicitly requested **install and reload**. Fresh read-only
preflight found receipt-valid installed/loaded **0.12.0**, Owner epoch 11, one
Project, one Goal, one disconnected Run, two retired Runs and no pending Adoption.
No active management operation needed interruption. The historical 0.11.0
installation report was not treated as current host truth.

Before mutation, the exact 15 installed 0.12.0 assets were captured in
`packages/local-workbench-v1/companion/retained/0.12.0/`, with aggregate SHA-256
`9cc9480aaf40e6f820f62a53300485838fa920d57ddc0225be72f83952865f32`.
The active release became **0.13.0** rather than reusing an installed version for
different bytes. Added hash-pinned retention and 0.12.0→0.13.0→0.12.0 rollback
coverage; the full disposable gate passed again, including 25 Qt rows
(`/tmp/wb-navigation-013-gate.log`).

The operator approved the exact plan in the visible, bounded setup TTY. Installer
exit was 0. Readback through the ownership-validating installer confirmed:

- all 15 installed assets and receipt-backed identities match 0.13.0;
- `previousRelease` contains the exact preflight 0.12.0 release;
- receipt SHA-256 is
  `06d3fb06f1ee63f7e6fb846375b0ac9e9b8af1b279820686098271f7c6fccdc9`;
- `shell.json` is byte-for-byte unchanged (SHA-256
  `61cc254ec8e0172e998ef061495d9d5a2dfc391a91afbe87cffdada2b6786d28`).

`omarchy restart shell` and restart of the identity-checked existing
`omarchestra-workbench-owner.service` both exited 0. The loaded presentation
contract reports **0.13.0**, generation `1790332523953728`, newer than installation.
Owner status reports epoch **12**, PID **297782**, running, presentation **hidden**,
one Project, one Goal and revision 25. Project/Goal record digest and binding
state counts remain unchanged. No new Owner terminal or Pi was launched; the only
new terminal was the bounded human installer.

Private evidence:
`~/.local/state/omarchestra/manual-gates/workbench-navigation-install-289309-aHhQtM/`
contains preflight, exact receipt/configuration backups, setup TTY/result,
post-install verification, shell/Owner reload logs and loaded-version/history
readback. The installer's own exact-plan/result directory is also retained.

**Pi itself was not reloaded or restarted.** The installed observer already imports
this checkout, so existing Pi panes need the operator's `/reload` when idle.
Reload creates fresh observer identity; it does not restore a disconnected Run or
inherit a retired Run's authority. No keystrokes were injected, no Adoption or
terminal-focus request was sent, and no physical shared-code/focus acceptance or
independent review is claimed.

### Subsequent operator feedback

The operator subsequently reports using pane navigation, with roughly 1–2 second
latency, similar delay on other non-menu buttons including Close, and periodic
dock flicker. The screenshot shows shared-code rows but is not independent
footer-matching evidence. The [latency investigation](../../../spikes/terminal-focus/LATENCY.md)
records read-only native timing, disposable call tracing and the negative result
for identical-heartbeat row-recreation. Navigation is not accepted as usable;
this feedback does not authorize another installation or weaken targeting checks.
