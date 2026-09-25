# Dock latency and refresh investigation

Status: **shared click-path delay established; exact native flicker cause remains
unconfirmed.** Investigation only: no production code, installed assets, Pi
reload, focus, hide/open or service restart changed during these measurements.

## Question and operator evidence

After 0.13.0 installation, the operator reports roughly 1–2 seconds to switch
agent panels, noticeable delay on all non-menu actions including Close, excessive
per-agent text, and dock flicker roughly once per second. The supplied screenshot
shows two observed-session rows with repeated navigation caveats, connection/
lifecycle/activity/health facts and the same Project-context Adoption blocker.
This is operator-reported live behavior, not a timed click trace or full focus
acceptance. Do not misreport the previously unrun focus test as a new automated
live PASS.

## Confirmed source path

1. `runner/native-owner.ts` runs `host.tick()` on a **1000 ms interval**.
   QML queues actions; `console/presentation-shell.ts` drains them only on that
   tick. Local destination/menu switches do not take this path. A queued click
   therefore waits for the next poll; normal phase-dependent wait approaches
   one second before processing, and blocked event loops can make it longer.
2. `runner/host.ts` publishes before polling. Every native view operation in
   `runner/desktop-command.ts` repeats `capabilities` and `presentationContract`
   before the actual method. Each is a separate synchronous process invocation
   through the installed `omarchy-shell` → `timeout` → `qs ipc` wrapper.
3. `WorkbenchAdapter.emitIntent()` also displays **submitted feedback before
   calling the intent sink**. Thus even its acknowledgement chrome adds three
   blocking shell invocations before the navigation request can leave the Owner.
4. A disposable trace through the actual native Owner/host/adapter/registry,
   with injected desktop and Pi endpoints, establishes these counts:

| Path | Shell calls |
| --- | ---: |
| Idle heartbeat + empty intent poll | 6 |
| Navigation, before bridge request is written | 9 |
| Navigation, after that write during the same tick | 9 |
| Close, through final native `hide` | 14 |

Before navigation dispatch the sequence is: negotiate + apply snapshot;
negotiate + take intent; negotiate + display submitted feedback. Those nine
calls precede Pi's pane-navigation routine entirely. After dispatch the Owner
remains synchronously occupied publishing the receipt/snapshot and polling again;
that can further delay result processing. Pi navigation itself is asynchronous
and need not wait for all subsequent Owner calls to finish.

`projectContext()` is cached in this path; ordinary snapshot/navigation processing
is **not** running a complete Git inspection per click. No intentional one-second
sleep exists in the Pi navigator. Its four-second timer is an abort limit, not a
mandatory wait. Bridge receipt delivery is not heartbeat-polled inside Pi.

## Read-only native measurements

Ten samples per primitive, using the actual production command adapters and
current inherited local Herdr context. No `takeIntent` (which dequeues actions),
`focus`, `open`, `hide`, input, registration or Adoption request was issued.
Only aggregate timing is recorded, not native metadata or command output.

| Primitive | Median ms | Range ms |
| --- | ---: | ---: |
| Loaded Companion capabilities | 31.3 | 30.8–33.5 |
| Loaded presentation contract | 31.0 | 29.3–31.7 |
| Herdr current caller pane | 3.3 | 3.2–4.9 |
| Herdr pane process metadata | 3.6 | 3.5–3.8 |
| Hyprland client list | 6.1 | 6.0–7.1 |
| Hyprland active window | 5.9 | 5.7–6.5 |
| One sequential pane/process/window read pass | 13.1 | 12.8–15.3 |

Using ~31 ms as a rough representative shell-call cost, nine calls add about
**280 ms before navigation dispatch**, and fourteen add about **430 ms before
Close finishes**, in addition to poll-phase waiting. These are **estimates**:
mutating shell methods, SQLite receipt cost, actual focus commands, desktop render
latency and Pi event-loop scheduling were not measured by the read-only probe.
This is sufficient to establish an architectural cause of perceptible shared
latency; it is not an exact decomposition of the operator's 1–2-second samples.

The navigator performs four read passes (two before pane focus, another before
window focus, another after), plus two focus commands and final active-window
read. The measured reads total roughly 58 ms excluding procfs/endpoint checks and
mutations. They are not the dominant measured source of the seconds-scale delay.
Removing identity checks or changing the user's Herdr layout is not justified.

## Flicker: hypothesis tested, not overstated

Full authoritative snapshots reach QML every second even when unchanged, matching
the reported flicker cadence. `WorkbenchConsole.applyProjection()` assigns the
projection, and row models are JavaScript-array Repeaters. However, an actual
offscreen Qt characterization **disproved** the initial blanket hypothesis that
any identical snapshot necessarily destroys/recreates the agent rows:

| Applied update | Observed button recreated | Managed inline menu collapsed |
| --- | --- | --- |
| Identical object snapshot | no | no |
| Identical encoded-wire snapshot | no | no |
| Cursor-only encoded snapshot | no | no |
| Observed activity changes | yes | no |
| Managed last-event changes | no | yes |

Changing row data can recreate delegates and lose transient UI state; identical
heartbeats did not in this test. The offscreen harness substitutes shell chrome
and uses software rendering, so it cannot rule out native repaint/style/compositor
behavior or live data/connection transitions. **Exact cause of the reported
one-second native flicker is still open.** Do not label “row rebuild every
heartbeat” as confirmed. A bounded native render/update trace is needed to
resolve that separately without reading terminal content.

## Recommended next bounded repair

1. Separate user-action delivery from the one-second liveness/snapshot cadence.
   Prefer a proven immediate wakeup/persistent path; if polling is retained,
   establish a short, bounded action poll without flooding the shell with CLI
   processes. Merely changing 1000 to 50 while keeping synchronous renegotiation
   is not a sufficient design.
2. Batch or reuse shell transport and remove pre-dispatch presentation round trips
   while retaining exact loaded-version/generation/session checks, stale-action
   refusal, receipt-before-send and replay guarantees. Close should feel immediate
   without stopping the Owner or changing management state.
3. Separate liveness renewal from visible data changes. Preserve stable row identity,
   hover/focus and inline disclosure on unrelated updates. Reproduce and resolve
   the actual native flicker instead of assuming the offscreen test explains it.
4. Compact healthy rows to identity plus useful activity/control state. Avoid the
   permanent navigation disclaimer and repeated normal-state vocabulary. Present
   a shared Project-context blocker once near its Project/Adoption context, not
   as the same paragraph under every row; retain short per-agent failures and
   accessible inline details, without popups or hidden authority errors.
5. Gate the hot path with call-count, fake slow-transport, stale-generation and
   duplicate-click regressions, plus stable-row tests. Measure actual click→pane
   and click→Close p50/p95 after separately authorized installation. Aim for
   sub-100 ms typical interaction and establish a measured tail budget; this is
   a proposed target, not a current performance claim.

This is a shared workbench interaction/update slice, not a Herdr focus-only
micro-optimization. Keep the accepted checked-navigation race limitations and all
Adoption/ownership/privacy boundaries. UI compactness and transport details above
are recommendations, not silently installed changes.

## Reproduction and disposition

From the repository root:

```sh
# Disposable production-path call counts; no installed services contacted.
timeout --kill-after=2s 15s node spikes/terminal-focus/latency-trace.mjs

# Actual offscreen Qt characterization using the repository's existing harness.
# The isolated child group and nested Qt process are bounded and cleaned up.
node spikes/terminal-focus/heartbeat-churn.mjs

# Explicit READ-ONLY local native timings; requires HERDR_ENV=1 and loaded dock.
timeout --kill-after=2s 30s node spikes/terminal-focus/latency-primitives.mjs --read-only-local
```

The trace produced the counts above. The Qt harness passes 26 rows, including the
new characterization; this is not a production-fix gate. Original focus spike
regressions remain 11/11. Retain these import-inert scripts as investigation
artifacts; production imports none of them. No installed system modifications or
independent review occurred.
