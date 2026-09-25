# Ordinary-session terminal focus

Status: **read-only correlation spike complete.** The operator subsequently
approved checked best-effort navigation, not atomic exact focus. A separate
[development implementation](../../docs/reviews/local-workbench-phase-2-verification/checked-pane-navigation.md)
is disposable-tested; no live focus, installation or runtime upgrade is claimed.

Checkpoint before this spike: `7eac1e8` (eligibility + shared visual session codes).

## Question

Can the current local Workbench focus the exact terminal panel containing one
bridge-connected Pi without using display names, titles or PID alone as identity,
without changing control mode, and without starting a replacement terminal?

## Success criteria

1. Resolve an exact live bridge incarnation to a current native presentation.
2. Account for panes/tabs and attached clients, not just a desktop window.
3. Reject stale/reused process or window identity and ambiguous mappings.
4. Dispatch only an explicit user focus action, without input, launch, Adoption,
   process control or hidden selection of a sibling Pi.
5. Establish what the public mutation actually guards; a read-before-write or
   successful CLI exit cannot by itself prove atomic exact-process focus.

## Setup and bounds

Read-only inspection of the user's existing local desktop, separate from
unattended tests. Runtime `herdr --version` and `herdr status server` both report
**0.9.1**, compatible private protocol **22**. Pacman's installed package record
is `herdr 0.8.2-1`, so that package label is not runtime API evidence. Foot is
**1.28.0**; Hyprland is **0.56.2**, commit
`efb50993780079460b0cbed1363e2166a2de1d9f`.

Commands used: `herdr --help`, `herdr --skill`, relevant command `--help`,
`herdr status server`, `herdr api schema --json`, `herdr pane list`, explicit
`herdr pane process-info --pane ID`, `hyprctl -j clients`, and procfs `stat`
metadata. **No** pane read, terminal output, focus, attach, launch, rename,
server update/restart, configuration write, Pi reload or Adoption occurred.

`probe.mjs` is import-inert and has an explicit manual entry. It checks that it
runs within a selected Herdr caller context, never guesses a desktop-focused
session, invokes only fixed read-command argv, kills each exact command child on
its 3-second timeout and bounds command output to 4 MiB. Inventories and ancestry
are bounded. It projects only process/topology/window metadata and discards
non-allowlisted CLI fields; it is not a new observer telemetry policy. The Herdr
CLI responses can include ancillary cwd/argv/title metadata, so this diagnostic
must not be promoted into a production observer or persisted as raw output.

Reproduce the **manual read-only** assessment from an existing Herdr pane with
explicit currently running Pi PIDs (not copied historical PIDs):

```sh
timeout --kill-after=3s 220s node spikes/terminal-focus/probe.mjs \
  --inspect-local PI_PID_A PI_PID_B
```

This queries the caller's selected local Herdr session only. It never focuses
anything, even when it prints `diagnostic_candidate`. A failure or candidate is
not authority. The script does not connect to the Workbench bridge and therefore
cannot prove that an inspected PID is a particular Observed Pi Session.

## Evidence

The live read-only probe found:

- Both Pi processes had distinct controlling PTYs and distinct shell parents.
- Both were foreground processes in **different Herdr panes/tabs**.
- Both ancestry chains led through the same Herdr server/client and **one Foot
  desktop window**. A Hyprland window-only jump cannot distinguish these Pi panels.
- `pane.process_info` provides foreground PIDs and shell PID; it reported `tty:
  null` in this run. The diagnostic used procfs for controlling-terminal facts.
- Public `pane.focus` takes only `{pane_id}`. Public `agent.focus` takes only
  `{target}`. Neither schema supplies an expected Pi incarnation, process-start
  identity, terminal identity or revision. The directional `pane focus` CLI is
  not the same operation as the socket's exact-pane `pane.focus` method.
- Public `SessionSnapshot` has panes/tabs/workspaces/agents/layouts and their
  focused IDs, but no attached-client-to-native-window relation. A process
  ancestry candidate is not proof of the current attachment after detach or
  reattachment, and must not be silently treated as one.

The checked fixture `evidence/public-focus-schema.json` retains the exact two
focus request definitions and only the SessionSnapshot property names. The full
bundled schema captured privately in `/tmp/omarchestra-herdr-schema.json` had
SHA-256 `226d4ecbd128d2e6bc84e4c8ddcec21ba9c7e51a0aafffcf087111ead3f1fa9a`.
No raw live snapshot, process arguments, title or transcript is committed.

### Executable failure cases

```sh
timeout --kill-after=3s 20s node --test spikes/terminal-focus/probe.test.mjs
```

Eleven tests cover two panes sharing one window; PID/start-time/parent/TTY/name
drift; missing/hidden/ambiguous windows; ambiguous or unresolved panes; metadata
allowlists with throwing private-field getters; the captured public schema; and
a check-then-focus replacement counterexample. Tests import no live probes and
contact no user process, Herdr, compositor or Pi.

The race test is a **contract model**, not a live Herdr race reproduction. The
read-only result establishes the advertised public shape, not the behavior of
undocumented methods or a physical successful focus action.

## Conclusion

**Supported:** read-only diagnostic pane/window candidates for this running
Herdr/Foot arrangement. **Not established:** exact bridge-to-pane-to-current-
attachment focus, or an atomic expected-occupant guard in the public focus API.

Do not convert this into a fake focus button or claim window focus is exact Pi
focus. Do not silently invoke `agent focus` on a previously inspected pane ID:
its occupant can change before the mutation. Post-readback can detect some
changes, but cannot undo an already incorrect presentation change.

## Design impact and next bounded step

At spike completion the [slice plan](../../docs/plans/workbench-session-usability.md)
required an explicit choice between:

1. **Bounded best-effort navigation:** approve presentation-only “Show terminal
   pane” semantics with live pre/post checks and truthful `unavailable`/`unknown`
   outcomes. Explicitly accept the unguarded interval and constrain attachment
   selection (for example, one verified local attached client). It still must
   never adopt, dispatch input, change control mode or create a replacement.
2. **Strict exact-agent navigation:** first establish a public guarded pane/
   occupant operation plus current attached-client/window identity. This may
   require runtime API work. Do not modify or upgrade the user's Herdr or
   compositor as an implicit implementation step.

The spike itself chose neither direction. The operator subsequently selected
option 1 to preserve the current Herdr layout. The authoritative terminal behavior
now records checked best-effort semantics and the original-ancestor-window limit,
including inability to attest attached-client identity from ancestry. Existing
exact Adoption and shared visual codes remain unchanged; no PID-derived
orchestration identity is introduced.

## Subsequent latency investigation

After installation, the operator reported 1–2 second pane navigation, slow Close
and other non-menu actions, excess row text and roughly one-second flicker.
The [latency investigation](LATENCY.md) establishes a shared 1000 ms action poll
and repeated synchronous shell IPC before dispatch. Read-only native measurements
and a disposable production-path trace identify the main delay; an offscreen Qt
experiment narrows—but does not establish—the native flicker cause. No production
or installed-system change was made during that investigation.

## Standalone-window and Lua focus follow-up

After live use, the operator explicitly approved adding standalone Foot navigation
and fixing `Focus unverified` despite Herdr pane switching. The
[implementation/evidence checkpoint](../../docs/reviews/local-workbench-phase-2-verification/standalone-window-navigation.md)
records a read-only confirmation that the legacy window-focus arguments cannot
parse under the active Hyprland Lua dispatch wrapper. The new native-leaf route
probes supported syntax before mutation; direct standalone windows require their
own foreground/TTY/original-Foot proof, not fallback from failed Herdr checks.
Disposable native/bridge/Lua-parser coverage passes. No live focus or Pi reload
was performed; atomicity and attachment limitations remain unchanged.

## Disposition

Retain the probe, reduced public schema and failure tests as evidence only.
Do not import them from `packages/local-workbench-v1/`. No installation or
physical focus acceptance, and no independent review, is claimed.
