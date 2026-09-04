# Companion Plugin vertical-slice red-to-green ledger

Status: **automated ledger complete and fake-only; separate human live validation passed 2026-09-03**

This ledger records the test-first progression for one persistent, versioned
`omarchestra.agent-console` installation and ephemeral
`omarchestra.companion/v1` Projection Sessions. All commands in this ledger are
fake-only or static. They did not contact a live Omarchy shell, mutate user
configuration, launch a GUI, Pi, provider, Boomux, SSH, Hyprland, or systemd,
or create private live evidence.

## Sequence

| Phase | Evidence | Intended result | Final result |
| --- | --- | --- | --- |
| Installation seam before implementation | `companion-installation-red.txt` | Missing contracts/installation/fake adapters fail | 22 intended failures |
| Projection Session seam before implementation | `companion-projection-red.txt` | Missing session/shell/QML adaptation fails; existing negative QML assertion may pass | 1 pass, 23 intended failures |
| Integrated acceptance before implementation | `companion-acceptance-red.txt` | Missing shared implementation fails; existing fake-only/QML boundary may pass | 1 pass, 4 intended failures |
| Installation implementation | `companion-installation-green.txt` | Exact plans, authorization, compatibility, safety, receipt, lifecycle, and recovery pass | 22 pass, 0 fail |
| Projection Session implementation | `companion-projection-green.txt` | Discovery, snapshot, ordered updates, intents, reload, reconnect, hide/clear, reused core, and QML pass | 24 pass, 0 fail |
| Integrated implementation | `companion-acceptance-green.txt` | One install across two Team Goals, fresh session identities, reload reconstruction, unchanged agents, byte-identical cleanup | 5 pass, 0 fail plus standalone `VERDICT PASS` |
| Extended automated boundaries | `companion-boundary-green.txt` | Fusion/recipe/module/QML boundaries remain fake-only | 18 pass, 0 fail |
| Human-procedure contract | `companion-human-recipe-check.txt` | TTY, exact authorization, private evidence, exact cleanup, and `--check` isolation pass without live mode | fake/static checks pass; separate live procedure later passed |

The red captures are retained unchanged. Green captures were produced only
after their implementation dependencies existed.

## Final fake-only acceptance

Command:

```bash
just prototype-companion-check
```

The gate runs the Companion installation, Projection Session, integrated
acceptance, QML/release, replacement setup-procedure, and live-launcher
regression suites, followed by the standalone `companion/acceptance.ts`
scenario and the human launcher's fake-only `--check` path.

Current result: **78/78 tests pass**, the standalone scenario prints
`VERDICT PASS`, and the launcher check prints `PASS (fake-only)`.

The standalone scenario records:

- one installation execution and exactly one enabled plugin entry;
- Team Goal A session generation 1, Team Goal B generation 2, and reload
  reconstruction generation 3;
- plugin generation 1 replaced by generation 2;
- stale-session rejection;
- identical reconstructed cards;
- unchanged fake-agent identities, connections, assignments, and delivered
  turns;
- zero runtime installation mutations;
- byte-identical plugin tree, owner-only receipt, and `shell.json` after
  clear/hide/cleanup.

## Separate human live result

On 2026-09-03, `just prototype-companion-setup-validation` passed with three
real interactive Pi hosts and the installed Companion Plugin. The operator
confirmed exact Pi-footer/Agent-Console agreement for waiting, Builder-only
managed work, manual takeover, sibling isolation, one-minute persistence, and
supported reload reconstruction. Structured evidence confirmed clear/hide and
matching before/after installation fingerprints. All ephemeral processes,
windows, sockets, and the runtime directory reconciled absent; the plugin
remained installed and enabled. Owner-only evidence is retained outside Git at
`${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/companion-20260903T120052-2322215/`.

## Installation findings

The fake installation path uses the same injected interfaces as the separate
human adapter. It proves:

- exact compatibility is initially Omarchy `4.0.2-1` and Quickshell
  `0.3.1-1`; unknown versions fail before mutation;
- inspection is read-only and returns a frozen stable-digest plan;
- authorization is bound to the exact plan and operation;
- install, update, rollback, and uninstall revalidate current filesystem,
  receipt, configuration, and compatibility state;
- symlinks, unsafe ownership or modes, foreign targets, malformed or
  conflicting configuration, and missing, extra, changed, or inconsistent
  assets fail closed;
- forced failures restore exact prior state when safe;
- recovery preserves external drift and reports incomplete recovery instead
  of overwriting it;
- exact uninstall removes only verified owned state and restores the recorded
  configuration preimage.

## Projection Session findings

The installed plugin and Team Goal lifecycle remain separate:

- capability discovery precedes every runner connection;
- a valid authoritative snapshot precedes panel summon;
- ordered updates, duplicate/gap handling, reconnect, and resnapshot reuse the
  existing non-QML projection core and adapter;
- acknowledged presentation intents are validated, deduplicated, and sent
  once;
- stale plugin generations close the old session and cannot continue issuing
  shell calls;
- clear and hide remove ephemeral state only;
- QML renders validated plain values and has no filesystem, storage, protocol,
  cursor, reconnect, process, terminal, shell-command, or orchestration
  authority.

## Recipe and live boundary

`prototype-companion-check` is the complete unattended Companion gate.
`prototype-companion-setup-validation` is the only active live Companion
recipe. The live recipe requires all of the following before setup mutation:

- compatible package versions;
- an interactive TTY on stdin and stdout;
- display of the exact immutable installation plan;
- the exact typed authorization phrase for that plan;
- an owner-only private evidence directory.

Its runtime cleanup addresses exact PID birth/cmdline, window
class/address/PID, socket and directory device/inode, and Projection Session
identities. It never uninstalls the persistent Companion Plugin. Automation
and Fusion can reach the replacement script only through `--check` or static
analysis.

The live path was not run. Therefore this milestone does not claim live plugin
installation, live Agent Console rendering, visual agreement with Pi, or live
reload behavior.

## Rejected path

`manual/run-live-agent-console-gate.sh`,
`docs/live-agent-console-launch-blocker.md`, and
`spikes/omarchy-ephemeral-plugin-loader/` remain rejected historical evidence.
The old launcher stays fail-closed and no active recipe invokes it. The spike's
candidate patch is not installed, submitted, or required.

## Scope limit

This milestone implements neither ordinary-terminal Pi observation nor
Adoption. Their protocol, identity, expiry, acknowledgement, packaging, and
reconciliation work remains open.
