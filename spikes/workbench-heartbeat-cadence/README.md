# Workbench heartbeat cadence

Status: **timing defect reproduced; Owner-only correction passes the full disposable
Phase-2 gate and is now loaded after separately authorized Owner restart.**
Native visual acceptance and independent review remain separate. Companion assets
remain exactly 0.14.0; the shell and Pi were not reloaded.

## Question

After installing 0.14.0, the operator reports improved reaction time but unchanged
whole-dock flicker every few seconds. Can the real periodic Owner/QML path falsely
expire a healthy presentation, even when stable-row reconciliation works?

Success criteria: observe the actual QML watchdog with the real periodic Owner,
guarded IPC and non-frozen clock; characterize publication gaps and connection
transitions; remove false expiry without extending the 2000 ms deadline, hiding
real source loss, weakening confirmation or adding faster polling.

## Reproducible setup

```sh
node spikes/workbench-heartbeat-cadence/probe.mjs
node --test spikes/workbench-heartbeat-cadence/probe.test.mjs
node --test packages/local-workbench-v1/test/phase-2-source-outcomes.test.ts
bash packages/local-workbench-v1/scripts/phase-2-gate.sh
```

Recorded with Node 26.8.1, Quickshell 0.3.1, Qt base 6.11.2-3 and Qt declarative
6.11.2-1. `probe.mjs` is import-inert. It creates a private offscreen Quickshell,
uses the packaged QML via the existing native-chrome/theme substitute fixture,
and opens only a disposable native Owner. Its **default production scheduler and
real monotonic clock** run for 12 seconds. It logs QML connection changes, window
open/close transitions and actual guarded heartbeat/resnapshot replies.

No installed shell, compositor, Pi, real Project or service is contacted. Roots,
HOME/config/cache and Qt runtime are private. Each IPC child has a one-second
bound; the exact Quickshell process group has a 25-second kill deadline and is
awaited/cleaned on success and failure. The full gate runs this test in its own
bounded subprocess, separately from parallel suites.

The negative control blocks **only the disposable Owner's Node event loop** for
2300 ms while its separate Qt process continues running. The watchdog must expire,
then reject a heartbeat-only revival and require a full snapshot. No live process
is paused or signalled.

## Evidence and cause

Before correction, [`evidence/before.json`](evidence/before.json) records:

- successive heartbeat requests **2002 ms apart**;
- **three** automatic `connected → stale → connected` cycles in 12 seconds;
- three heartbeat replies demanding `resnapshot`;
- approximately **30–34 ms** spent stale per cycle;
- one window open and one final cleanup, not repeated window recreation.

`createRunnerSource()` records its last publication time **after** synchronous
shell IPC completes, then throttles identical snapshots for 1000 ms. The Owner
also invokes that source on a 1000 ms timer. The following tick arrives less than
1000 ms after the previous publication completed and is suppressed. Delivery is
therefore pushed to the next tick, about 2000 ms later—racing QML's 2000 ms
watchdog. On expiry, connection-dependent controls disable and confirmation is
cleared; a subsequent full snapshot restores connected presentation. Stable
array/delegate identity cannot prevent this separate state transition.

[`evidence/regression-before.txt`](evidence/regression-before.txt) captures a
deterministic failure using the actual host and 40 ms simulated publication cost:
the first periodic tick publishes zero updates instead of one. The earlier idle
source test advanced a zero-cost fake clock by 1001 ms; the wake integration froze
its clock and disabled periodic callbacks. Neither covered this interaction.

The source throttle in the baseline is also present in `5250c6a`'s `runner/host.ts`.
To reproduce its behavior from the corrected tree, use a **disposable copy** and
remove `{ heartbeat: true }` only from the periodic `host.tick` call in
`runner/native-owner.ts`; run the probe there. Do not edit installed assets or
restart a live Owner for this experiment. Timing/counts vary by host; the recorded
before sample is not a guaranteed native frame trace.

## Correction and acceptance

The periodic Owner callback now explicitly requests a heartbeat publication on
**each existing one-second tick**. Wake-driven ticks and before-intent checks
retain ordinary deduplication/coalescing. Visible data is still compared at the
desktop boundary: unchanged state produces a lightweight guarded heartbeat, not
model replacement. Receipt/publication acknowledgement barriers are unchanged.
No QML, Companion release, Pi extension, timer frequency or stale deadline changed.

[`evidence/after.txt`](evidence/after.txt) records:

- heartbeat gaps **1000–1002 ms**;
- **zero** stale transitions or resnapshots during the healthy 12-second interval;
- the deliberate 2300 ms stall produces exactly one stale transition, one required
  resnapshot and a connected recovery;
- one window open and one final cleanup.

The full Phase-2 gate passes, including this new real periodic-cadence test,
**28 offscreen Qt rows**, warm-click wake coverage, receipt/bridge/Adoption suites,
installer rollback and the five pre-existing future-execution TODOs. Gate log:
`/tmp/workbench-cadence-gate.log`.

## Conclusion, contract impact and disposition

**Supported:** an actual presentation-liveness defect reproduces without a native
compositor and matches the reported cadence. It is not evidence that every native
flicker has this cause or that the user's desktop is now fixed.

Technical contract: the periodic liveness scheduler must not pass through a second
completion-relative throttle that can skip its next renewal. Keep the existing
stale deadline and fail-closed resnapshot/confirmation behavior on genuine loss.
This restores the approved responsiveness contract, not new product scope.

Retain the probe and before/after evidence. Its regression is included in the full
engineering gate; only the bounded cadence correction is promoted into production.
The installed 0.14.0 Companion needs **no reinstall or shell/Pi reload** for this
Owner-only fix. The operator subsequently authorized restart and commit. Fresh
preflight verified two Projects, two Goals, **two** manual-takeover Runs and three
retired Runs, with no pending proposals, management operations or in-flight bridge
deliveries. The existing service restarted successfully: epoch **13 → 14**, PID
**466658 → 529724**, revision **41 → 45**. Both exact Runs reconnected in manual
control with writer state `none`; all prior events and Project/Goal/Run identity
records were preserved. Only two disconnect and two reconnect events were appended.

Installed assets, receipt, configuration, durable ownership receipt and loaded
Companion generation **1790341279684532** remain unchanged. No Companion install,
shell reload, Pi reload or navigation occurred. The dock was hidden at verification;
the operator still needs to reopen it and check native flicker.

Private before/after records, code hashes and restart result:
`~/.local/state/omarchestra/manual-gates/workbench-cadence-restart-FpEsLf/`.
Installation fingerprint before/after:
`d4bd1a3bd0850f1e953b29c1e1b6e6bcd9574b80a3ff2a923711c3ba74e5b139`.
Project/Goal digest:
`dd78d38a33cca746e62a4a6cfad4cc1f6d5b63b51a745b0cc1db1ce83f91f172`.
Run-identity/membership digest:
`bc35d2731760db2e73b2d82bf7a30d7b786df46c3d47ee4ce3715fa970cda93a`.
