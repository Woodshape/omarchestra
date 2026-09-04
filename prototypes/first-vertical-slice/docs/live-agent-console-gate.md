# Live Agent Console gate — first vertical-slice prototype

Status: **RETIRED PATH — replacement Companion setup procedure passed its human-only live validation on 2026-09-03.**

This is the manual-gate plan for the removable first vertical-slice prototype. The retained `manual/run-live-agent-console-gate.sh` still fails closed because it implements the rejected per-run QML-loading path. Its justfile recipe is no longer active. Do not treat that historical error as a product blocker or weaken its preflight. Use `just prototype-companion-setup-validation` for the explicitly installed Companion Plugin procedure.

The automated gate remains fake-only and never invokes any visible agent host, terminal emulator, compositor action, provider, terminal runtime, remote transport, service manager, desktop shell process, product setup, or user-configuration mutation.

## What each layer proves

| Evidence | Kind | Status |
| --- | --- | --- |
| `just prototype-vertical-slice` | fake-only automated | proven (durable runner, protocol, takeover, restart, reconnect) |
| `just prototype-vertical-slice-manual-check` | fake-only automated | proven for the role-label adapter |
| `just prototype-live-agent-console-check` | fake-only automated | green — adapter, QML, historical launcher, setup-contract, cleanup, source-audit, syntax, and QML-lint checks |
| `just prototype-companion-check` | fake-only automated | green — 78 installation, Projection Session, acceptance, setup-contract, live-launcher regression tests plus standalone acceptance and launcher `--check` |
| `just prototype-vertical-slice-role-label-gate` | prior human evidence | completed — three decorationless visible Pi hosts, persistent Pi status labels, waiting → managed → manual_takeover, sibling isolation, one-minute persistence |
| Persistent Companion Plugin setup/update/uninstall | fake-only then human-authorized | live installation/update and installed capability discovery passed; uninstall remains fake-proven |
| Agent Console cards against live Pi | human-only | passed 2026-09-03 |

## Locked replacement architecture

Omarchestra follows Boomux's lifecycle split:

1. An explicit, human-authorized setup installs, validates, and enables one versioned Omarchestra Companion Plugin through Omarchy's supported third-party plugin path.
2. The installed plugin persists across Team Goals.
3. A Team Goal creates only an ephemeral Projection Session carrying a snapshot, ordered events, and acknowledged intents.
4. Hiding or cleaning a Team Goal clears that Projection Session; it does not unregister, remove, or rewrite the plugin or `shell.json`.
5. Exact update, rollback, and uninstall are separate product-management operations.

No upstream Omarchy feature or per-run repository-local QML registration is required. The completed ephemeral-loader spike is retained as rejected-path evidence.

## Fake-only entry conditions — satisfied

The replacement procedure is implemented. Its automated entry conditions are green:

- setup plans and mutates only exact Omarchestra-owned plugin assets and the exact intended `shell.json` enablement entry;
- exact Omarchy/Quickshell compatibility verification fails before mutation or live resource creation;
- normal projection open/hide/reconnect/clear paths do not write plugin files or Omarchy configuration;
- update, rollback, and uninstall detect foreign or changed assets and fail closed;
- runner absence, stale cursors, duplicate sources, plugin reload, and projection reconnect remain presentation-only failures;
- success, failure, interruption, and assertion cleanup use exact registered runtime identities and never uninstall the Companion Plugin;
- Fusion and every automated recipe are statically prevented from reaching live mode; the script is executable in automation only with `--check`.

These unattended results remain fake and static. The separate human result below establishes that the installed live shell loaded and rendered the plugin.

## Human-only replacement gate

`just prototype-companion-setup-validation` requires explicit operator authorization, verifies the installed plugin version and compatibility, and then:

1. start the runner and three decorationless Ghostty/Pi hosts;
2. ask the already-installed Companion Plugin to open one Projection Session;
3. confirm three Pi footers and Agent Console cards agree on the same committed `<Role> · <state>` values;
4. prove waiting → managed → manual_takeover, sibling isolation, one-minute persistence, plugin reload/reconnect, and projection clearing;
5. cross-check structured projection data rather than terminal or conversation content;
6. clean only exact Team Goal and Projection Session resources, leaving the installed plugin intact.

Private live evidence belongs under `${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/` with owner-only permissions and never enters Git.

The replacement gate passed on 2026-09-03. It confirmed waiting → managed → manual_takeover, sibling isolation, one-minute persistence, supported rescan with identical reconstructed cards, clear/hide, matching installation fingerprints, and absence of all ephemeral runtime resources after reconciliation. The persistent Companion Plugin remained installed and enabled. Detailed evidence remains owner-only under `${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/companion-20260903T120052-2322215/` and is intentionally not committed.
