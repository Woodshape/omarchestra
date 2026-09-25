# Responsive dock checkpoint — Companion 0.14.0

Status: **whole disposable Phase-2 engineering gate PASS; Companion 0.14.0
installed/loaded after separately authorized shell and Owner restart.**
Independent review and physical acceptance remain pending. After installation,
the operator reports better reaction time but unchanged whole-dock flicker. An
Owner-only cadence correction is now disposable-tested and **loaded after a
separately authorized Owner restart**; native verification remains pending.
No Pi reload, navigation/focus request, new Adoption, Assignment or check execution
was performed during this repair/update. The existing manual-takeover Run
reconnected without re-Adoption. The operator approved all three repairs after the
[latency investigation](../../../spikes/terminal-focus/LATENCY.md).

## Implemented contract

- **Immediate action wakeup.** Every emitted QML request notifies the existing
  Owner through `WorkbenchWake.qml` and the packaged `workbench-wake.mjs` client.
  One client runs at a time; notifications during that run coalesce. Its fixed
  `/usr/bin/node` argv, empty inherited environment, owner-only socket checks,
  bounded request/reply and 1500 ms deadline grant no authority. It sends only
  `wake` plus the captured Projection Session/generation, never an action or Pi
  identity. It cannot start an Owner/service/agent or install anything. Owner
  rejects stale wake metadata and reads the exact loaded QML queue itself.
  The original one-second tick remains liveness and lost-wakeup recovery, not
  the normal click scheduler. There is no fast idle polling loop.
- **Single guarded IPC.** Initial open still negotiates the exact release,
  protocol, capabilities, presentation contract and generation. Subsequent
  `dispatch` checks the complete expected identity *inside the same QML call*
  as the operation and returns a checked response. The compiled loaded version
  cannot be relabelled by a manifest refresh. Close clears only its addressed
  session; no unguarded shell hide can affect a successor. Refused, malformed or
  unacknowledged cleanup reports unavailable, not a fabricated successful hide.
  Source revalidation,
  immutable intent/receipt checks and the displayed-snapshot-before-feedback
  barrier remain intact. Cosmetic `submitted` feedback no longer blocks dispatch.
- **Immediate local Close.** Close hides the surface immediately and disarms
  confirmation. It drops only not-yet-read UI clicks, retaining one view-close
  request and the exact session until the Owner clears it. Already accepted
  commands keep their normal durable outcome; this is not cancellation. A data
  update or watchdog cannot discard that Close, and a heartbeat cannot reopen
  the hidden surface. Reopening still establishes a fresh Projection Session.
- **Liveness without redraw.** If visible snapshot data is unchanged, Owner
  sends only the addressed revision/cursor heartbeat. QML renews its watchdog
  without replacing the projection or models. A stale view requests a full
  snapshot; a heartbeat alone cannot revive stale data. Failed publication
  never advances the native displayed-data cache or releases acknowledged feedback.
- **Stable keyed rows.** Managed, observed, retired, choice/action, Add-agent and Assignment-target
  rows reconcile by exact runner IDs, not code, label or position. Field updates
  and reordering retain delegates, keyboard focus and disclosures; removal,
  replacement and Project/Goal/session scope changes recreate the relevant rows.
  Unchanged snapshot subtrees retain their references. This does not preserve
  obsolete confirmations, queued domain clicks or execution reviews.
- **Compact presentation.** Normal observed rows show `Pi CODE · activity`.
  Managed rows retain Role and the opaque committed state, with abnormal control/
  connection state visible. Normal health, lifecycle and navigation disclaimers
  are no longer repeated below every row. Session-specific Adoption blockers,
  unavailable navigation and unverified focus remain visible. Full navigation
  reasons and observed facts are available through inline disclosure, not popups.
  Shared Project-context/Goal-selection blockers appear once per contextual list,
  including Add agent. No eligibility or ticket is inferred by this formatting.

## Executable evidence

```sh
bash packages/local-workbench-v1/scripts/phase-2-gate.sh
node spikes/terminal-focus/latency-trace.mjs
node spikes/terminal-focus/heartbeat-churn.mjs
```

Full gate: **PASS**, including **28 offscreen Qt rows**, real private Quickshell
wake integration, current/stale session and generation rejection, unchanged
Adoption/receipt/bridge suites, source audits and update/rollback coverage. Five
pre-existing future-execution TODOs remain; this slice does not execute work.
Local full-gate log: `/tmp/wb-responsive-gate.log`.

`presentation-wake.test.ts` runs a separate offscreen Quickshell with actual
packaged QML and client against the actual disposable native Owner, guarded IPC,
adapter, SQL receipt and fake Pi peer. Its periodic scheduler is deliberately
never called. This proves a real QML → Process → socket wake path, not merely a
fixture callback. Native layer chrome/theme are substitutes; Pi navigation is
fake. The exact shell/client process group is bounded and killed on failure.

`presentation-wake-client.test.mjs` covers private-endpoint requirements, forbidden
extra action fields, wrong/oversized/trailing replies, disconnect and a stalled
peer with no retry. Native-owner tests additionally run the actual packaged Node
entry point, check successor-view fencing and exercise slow reads/context drift.
Rendered tests cover immediate Close, two-press guards, stable focus/disclosures,
replacement despite equal display codes, compact rows and a shared blocker once.

| Disposable production-path trace | 0.13.0 | 0.14.0 |
| --- | ---: | ---: |
| Idle heartbeat and empty queue poll: shell calls | 6 | 2 |
| Heartbeat-due navigation: calls before bridge send | 9 | 2 |
| Same navigation tick: calls after bridge send | 9 | 3 |
| Heartbeat-due Close: Owner calls through cleanup | 14 | 3 |

The separate warm-click Quickshell integration requires **one** guarded queue read
before the bridge send and **two** calls for Owner-side Close cleanup. Local Close
waits for neither. These counts exclude the bounded wake client and are not an
elapsed physical-focus benchmark. The integration prints test-trigger→bridge and
completed-tick durations, including its synthetic trigger IPC; they are not p50/
p95 measurements of the user's dock or Herdr focus. One full-gate sample was
116.3 ms to bridge send and 218.0 ms through the completed tick. Pi focus/checks
were not executed in that sample; the clock used for source liveness was held at
a deterministic warm-click value. It is not a physical interaction budget PASS.

The churn probe now reports no observed-button recreation or managed-menu collapse
for any of its five updates (identical object, identical wire, cursor, observed
activity, managed last event). The previous changed-row failures have become
rendered regressions. Native flicker is **not** claimed independently resolved:
physical compositor/style behavior still requires the operator's live check.

Gate bring-up also exposed test-fixture issues: Quickshell's appended Unix socket
path exceeded Qt's bound under the nested disposable TMPDIR, old harnesses omitted
new packaged presentation helpers, and an Add-agent test selected a now-identically
labelled *hidden* Overview control. These were corrected with a bounded short
private path, explicit helper fixtures and visible-control selection—not by
skipping the real bridge or weakening assertions.

## Release and remaining acceptance

The published 0.13.0 setup artifact is retained as 15 assets and was compared
read-only with the installed bytes. Aggregate SHA-256 (sorted filename + bytes):
`902ef962e38e29a2d8620ef7f5f69473f32ee0126eeecf2446f02587bfeac6fc`.
Tests pin it and cover 0.13.0 → 0.14.0 → exact 0.13.0 rollback, alongside older
upgrade paths. At the disposable engineering checkpoint no installed state changed.

This describes the gate and copied assets at that historical checkpoint. By the
operator's later decision in [ADR 0006](../../adr/0006-use-git-history-for-companion-release-source.md),
the copied bundle and historical-version assertions were removed from the current
tree; rollback behavior is tested with generated fixtures and Git preserves prior
source.

## Authorized live installation and reload — 2026-09-25

The subsequent explicit **install and reload** request authorized the receipt-backed
0.13.0 → 0.14.0 update and shell/existing Owner restart. Fresh preflight found
**two Projects, two Goals, one manual-takeover Run and three retired Runs**, not the
older one-Project/disconnected-Run baseline. There were no pending Adoption
proposals, management operations or queued/attempting bridge deliveries; the
manual-takeover Run held no writer lease. Installation did not create those records.

- Operator approved the exact plan in the bounded temporary setup TTY. Installer,
  `omarchy restart shell` and the identity-checked existing
  `omarchestra-workbench-owner.service` restart all exited **0**. No Owner terminal,
  second Owner, Pi restart/reload or terminal-pane navigation request was used.
- Verified all **19 installed assets**, receipt ownership and exact retained 0.13.0
  rollback release. Loaded compiled contract reports **0.14.0**, generation
  **1790341279684532**, newer than installation at `2026-09-25T12:56:43.892Z`.
- Owner is enabled/running at epoch **13**, PID **466658**, revision **36**;
  presentation was hidden at verification. The exact same Run identity/Role
  membership returned to `manual_takeover` with writer state `none`. The only
  appended events were `adoption_disconnected` and `manual_takeover_reconnected`;
  all previous 34 events remain identical. This is reconnect evidence, not a new
  human-operated Adoption acceptance gate.
- `shell.json`, persistent ownership receipt, Project/Goal records, Run identities
  and memberships are unchanged. Installed receipt SHA-256:
  `2d4d7a30e6d1ae6a096058293be1bfe560e30635c1c90c00063cb6498d44b994`.
  Unchanged shell SHA-256:
  `61cc254ec8e0172e998ef061495d9d5a2dfc391a91afbe87cffdada2b6786d28`.
  Project/Goal digest:
  `dd78d38a33cca746e62a4a6cfad4cc1f6d5b63b51a745b0cc1db1ce83f91f172`.
  Run-identity/membership digest:
  `f53dd9124307f0cf089bc7e4dbcdc83ef95884a2b71345b557b8944aaf091050`.

Private evidence:
`~/.local/state/omarchestra/manual-gates/workbench-responsive-install-459084-c0VXYd/`
contains the read-only preflight/history, old receipt/configuration, setup TTY log
and exit status, installed verification, restart preflight, shell/Owner exit logs,
loaded contract and final verification. Exact installer plan/result are under
`~/.local/state/omarchestra/manual-gates/companion-setup-460573-yIFQzN/`.
The first post-install verification attempt hit a helper-only SQL-row versus JSON
object-prototype mismatch; normalizing row prototypes fixed that comparison.
No production data, expected history or installation was changed to pass it.

This repair changes no Pi extension code and required no injected Pi `/reload`.
Independent review, physical click latency/flicker acceptance and separate live
Adoption acceptance are still outstanding. Checked-navigation race/attachment
limitations are unchanged.

## Operator report: successful focus, dock hidden on transient IPC timeout

After the operator reloaded Pi sessions and used the new standalone focus action,
they report **terminal switching succeeds but the dock disappears**. Read-only
correlation on 2026-09-25 confirmed the focus request was acknowledged before the
disappearance. The desktop shell's main Quickshell PID remained alive; no
coredump, segfault, kernel OOM or Owner restart was recorded. The Owner stayed
healthy at epoch 15/PID 766418, and read-only shell ping/plugin-list calls succeed
now. This was not evidence that the focus command crashed the desktop shell.

The log does establish why the panel hid. At 19:22:34 CEST a `qs ipc` request
started but did not yield a command-line/result record; the last successful
periodic heartbeat and queue poll were at 19:22:33.912/19:22:33.945. The Owner
then logged `Companion shell unavailable` at 19:22:36.929. Under the old tick
policy, any such error immediately stopped the presentation host; `host.stop()`
issued the guarded Companion `close`, which sets `opened=false` and hides the
PanelWindow. The timeline strongly indicates a bounded shell-IPC timeout during
that refresh, although the missing subprocess argv means the exact failed method
cannot be proven from this journal. Focus succeeded before this separate Owner
failure; whether focus caused the transient IPC stall is unproven.

Implemented follow-up in the checkout: the fixed desktop adapter now identifies
transport unavailability separately. If the projection refresh/heartbeat call
fails for that reason, Owner retains the open view, skips draining queued intents
against a stale display, and retries on the next existing tick. The QML watchdog
may mark the still-visible projection stale; a successful refresh recovers it.
Other errors, especially uncertain intent reads, incompatible Companion
contracts and generation changes, retain their fail-closed teardown policy. No
navigation is retried and no action is inferred or replayed.

Regression: `phase-2-native-owner.test.ts` injects one bounded transport timeout,
proves the view stays open and the intent queue is untouched, then verifies the
next successful tick refreshes before draining the queued Close. Focused Owner,
presentation-shell and source tests pass; full Phase-2 gate passes at
`/tmp/workbench-owner-transient-refresh-gate.log` (28 offscreen Qt rows, zero
failures; five pre-existing future-execution TODOs). This source correction is
**not yet loaded**: the currently running epoch-15 Owner predates this patch.
The operator subsequently authorized an **Owner-only restart** after their Pi
reload work. Fresh preflight verified the exact enabled service and PID 766418,
hidden presentation, two Projects/Goals, **five retired Runs** (all writer states
`uncertain`), no pending Adoption/management/delivery work, current 0.14.0 loaded
Companion generation and matching installation receipt/assets. The Owner restarted
successfully at epoch **16**, PID **803210**, revision **53**; it remains active,
with presentation hidden. All 53 prior events, Project/Goal records and Run
identity/membership digests are unchanged; no events were appended. Installed
assets, receipt, ownership, shell configuration and loaded Companion generation
are unchanged. Private preflight/restart/history evidence is at
`~/.local/state/omarchestra/manual-gates/workbench-owner-refresh-restart-opVOH0/`.

This loaded the Owner-side source correction. No Omarchy shell reload, Pi reload,
focus test, Adoption or domain action was performed during the restart. The user
will reload Pi sessions separately.

## Post-install flicker report and Owner-only cadence correction

The operator reports **improved reaction time but unchanged whole-dock flicker
every few seconds**. This rejects flicker acceptance for the installed 0.14.0
checkpoint; the row-identity tests did not cover the real periodic scheduler.

The [cadence investigation](../../../spikes/workbench-heartbeat-cadence/README.md)
reproduced three automatic `connected → stale → connected` cycles in 12 seconds,
with heartbeats 2002 ms apart. A second 1000 ms throttle, measured after synchronous
publication completes, suppressed alternate one-second Owner ticks. That raced
the unchanged 2000 ms QML watchdog. The window stayed open; connection-dependent
controls were disabled/re-enabled and the view required repeated full snapshots.

The correction makes each existing periodic Owner tick publish liveness, while
warm click wakes still coalesce unchanged data. No Companion assets, Pi code,
identity checks, stale timeout or polling frequency changed. The new real
scheduler/guarded IPC/QML watchdog test records zero healthy stale transitions,
1000–1002 ms heartbeat gaps, and correctly detects/reconciles a deliberate 2300 ms
stall of its disposable Owner. The full Phase-2 gate passes with this additional
regression and all 28 Qt rows (`/tmp/workbench-cadence-gate.log`).

The operator subsequently authorized Owner restart and commit. Fresh preflight
found two manual-takeover Runs, three retired Runs, two Projects and two Goals,
with no pending proposals, management operations or in-flight bridge deliveries.
The verified existing service restarted successfully at epoch **14**, PID
**529724**, revision **45**. Both exact Runs reconnected in manual control; all
previous 41 events remain unchanged, with only two disconnect and two reconnect
events appended. Project/Goal/Run identity records, installed assets/receipt,
configuration and loaded Companion generation remain unchanged. No shell/Pi
reload or navigation was performed; presentation was hidden at verification.
Private evidence: `~/.local/state/omarchestra/manual-gates/workbench-cadence-restart-FpEsLf/`.

The correction is now active in the Owner, but still awaits the operator's native
flicker check. It addresses a reproduced timing defect consistent with the report,
not yet a confirmed resolution of every native visual flicker.
