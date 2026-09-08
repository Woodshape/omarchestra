# Engineering task: bounded live Adoption bridge

Status: bounded engineering implementation complete; fake gates green and
independent read-only review PASS. Observation remains operator-accepted;
Adoption installation and live validation remain unrun. This task is retained
as the original requirements; implementation/evidence are recorded in
[`live-adoption-engineering-handoff.md`](../../prototypes/first-vertical-slice/docs/live-adoption-engineering-handoff.md).

## Objective

Extend the removable prototype so one observed ordinary local Pi can be
explicitly adopted into one local Team Goal and vacant Role. Implement and
fake-test the live wiring; leave live execution to the operator. This is not
production implementation or authorization to modify the installed plugin.

## Read first

Read AGENTS.md, CONTEXT.md, docs/design/mvp.md,
docs/design/pi-terminal-behavior.md, ADRs 0001–0003,
prototypes/first-vertical-slice/docs/observer-adoption-v1.md,
docs/plans/observer-adoption-implementation.md, and
spikes/observer-live-bridge/README.md completely. Read the actual installed Pi
public extension docs before implementing Pi APIs; record the tested version.
The earlier plan's fake-only milestone is complete, not a task to repeat.

## Accepted baseline

- Observation and the standalone Companion panel have operator-reported live
  PASS and explicit slice acceptance. Do not repeat prerequisite debates.
- R1 is accepted: isIdle plus existing guards is best-effort, not complete
  slash-command/user-bash attestation. Do not reopen this as a blocker.
- The current observation gateway deliberately rejects Adoption. Preserve that
  mode and expose Adoption only through a separate explicit manual path.
- Same-version Companion assets previously required a shell restart before the
  new method became callable. Record/check actual capabilities and methods;
  do not silently rewrite historical release bytes or mutate installations.

## Work sequence

1. Audit the existing Adoption state machine, fake transaction store, live
   registry gateway, Pi adapter, managed bridge, and Companion intent path.
   Write a short bounded integration contract identifying the real transaction
   owner and the exact post-commit bridge activation path. Do not pretend that
   passing fake transactions already proves durable live commit.
2. Add red tests for propose → authorize exact proposal → same-connection ack
   → reconcile/revalidate → one durable atomic commit → managed presentation.
3. Implement local disposable persistence/transport adapters around the existing
   core. Commit the observed-to-managed transition, Role occupancy, Agent Run,
   control state, and presentation consistently; crash recovery must never
   expose both an adoptable observation and a managed run for the same binding.
4. Wire actual Companion request/confirmation intents and bounded results to
   the runner. Do not stop at QML signals that no live controller consumes.
   Keep eligibility, identity, expiry, and transactions outside QML.
5. Activate the managed bridge only after commit in the same visible Pi.
   Display the exact committed role/state. No hidden Pi, terminal input
   injection, or fabricated Runtime Binding. Preserve ordinary interactivity.
6. Add a human-only Adoption procedure with private evidence and exact cleanup.
   Separate commit/presentation validation from any optional provider-backed
   assignment; never dispatch work automatically merely to test Adoption.
7. Run independent read-only spec/safety review and the regression gates.
   Fix substantiated findings test-first and leave a concrete handoff.

## Required acceptance

- No authority or prompt dispatch before commit; exactly one commit on success.
- Invalid/stale identity, reused PID, mismatched Node, remote goal, occupied
  Role, busy/unknown/exited session, refusal, timeout, duplicate, disconnect,
  and identity drift cannot grant authority.
- Failure/restart at each stage reconstructs a truthful observed or committed
  state without duplicate Adoption or premature bridge activation.
- Same-process identity survives the successful transition; ordinary Adoption
  continues to report runtimeBindingGuarantee=unavailable.
- Managed presentation and Unassigned Agents cannot diverge after commit.
- Cleanup preserves installed plugin/configuration and never kills the user's
  ordinary Pi. Loss of a disposable runner must not leave dispatch enabled.
- Preserve content-free observer telemetry. Any managed input handling belongs
  exclusively to the committed managed bridge, not the observer collector.

## Execution boundaries

Use one writer and a read-only reviewer. Keep implementation under
prototypes/first-vertical-slice and update affected contracts/docs. Automated
checks use fakes/injected ports and do not launch Pi, providers, GUI, SSH,
Boomux, systemd, or touch installed plugin/global Pi configuration. Do not run
the human procedure, install/update the plugin, commit, or push during this
engineering run. If a Companion update is necessary, package it explicitly and
leave installation as a separate operator step, not a runtime side effect.

## Gates and handoff

Add a dedicated fake-only live-Adoption gate. Also run with
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint:

- just prototype-live-observer-check
- just prototype-observer-adoption-check
- just prototype-companion-check
- just prototype-live-agent-console-check
- just prototype-vertical-slice
- just prototype-vertical-slice-manual-check
- git diff --check

Report modified files, exact results, review findings, bounded limitations,
and the next runnable manual command. Keep private evidence outside Git and
avoid incidental timestamp-only changes to historical generated evidence.
