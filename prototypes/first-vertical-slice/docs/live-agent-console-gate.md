# Live Agent Console gate — first vertical-slice prototype

Status: **CURRENT RECIPE RETIRED — replacement gate pending Companion Plugin setup.**

This is the manual-gate plan for the removable first vertical-slice prototype. The existing `just prototype-live-agent-console-gate` launcher still fails closed on the absent `registerTemporaryPlugin` API because it implements a rejected per-run QML-loading path. Do not treat that error as a product blocker and do not weaken its preflight; replace the recipe when the explicitly installed Companion Plugin prototype exists.

The automated gate remains fake-only and never invokes any visible agent host, terminal emulator, compositor action, provider, terminal runtime, remote transport, service manager, desktop shell process, product setup, or user-configuration mutation.

## What each layer proves

| Evidence | Kind | Status |
| --- | --- | --- |
| `just prototype-vertical-slice` | fake-only automated | proven (durable runner, protocol, takeover, restart, reconnect) |
| `just prototype-vertical-slice-manual-check` | fake-only automated | proven for the role-label adapter |
| `just prototype-live-agent-console-check` | fake-only automated | green — projection adapter, QML boundary, launcher contract, failure cleanup, source audit |
| `just prototype-vertical-slice-role-label-gate` | prior human evidence | completed — three decorationless visible Pi hosts, persistent Pi status labels, waiting → managed → manual_takeover, sibling isolation, one-minute persistence |
| Persistent Companion Plugin setup/update/uninstall | fake-only then human-authorized | pending |
| Agent Console cards against live Pi | human-only | pending the replacement gate |

## Locked replacement architecture

Omarchestra follows Boomux's lifecycle split:

1. An explicit, human-authorized setup installs, validates, and enables one versioned Omarchestra Companion Plugin through Omarchy's supported third-party plugin path.
2. The installed plugin persists across Team Goals.
3. A Team Goal creates only an ephemeral Projection Session carrying a snapshot, ordered events, and acknowledged intents.
4. Hiding or cleaning a Team Goal clears that Projection Session; it does not unregister, remove, or rewrite the plugin or `shell.json`.
5. Exact update, rollback, and uninstall are separate product-management operations.

No upstream Omarchy feature or per-run repository-local QML registration is required. The completed ephemeral-loader spike is retained as rejected-path evidence.

## Replacement-gate entry conditions

Before a new live recipe may replace the retired launcher, fake-only tests must prove:

- setup plans and mutates only exact Omarchestra-owned plugin assets and the exact intended `shell.json` enablement entry;
- compatibility verification fails before reload or any live resource creation;
- normal projection open/hide/reconnect/clear paths do not write plugin files or Omarchy configuration;
- update, rollback, and uninstall detect foreign or changed assets and fail closed;
- runner absence, stale cursors, duplicate sources, plugin reload, and projection reconnect remain presentation-only failures;
- success, failure, interruption, and assertion cleanup use exact registered runtime identities and never uninstall the Companion Plugin.

## Human-only replacement gate

The future recipe must require explicit operator authorization, verify the installed plugin version and compatibility, and then:

1. start the runner and three decorationless Ghostty/Pi hosts;
2. ask the already-installed Companion Plugin to open one Projection Session;
3. confirm three Pi footers and Agent Console cards agree on the same committed `<Role> · <state>` values;
4. prove waiting → managed → manual_takeover, sibling isolation, one-minute persistence, plugin reload/reconnect, and projection clearing;
5. cross-check structured projection data rather than terminal or conversation content;
6. clean only exact Team Goal and Projection Session resources, leaving the installed plugin intact.

Private live evidence belongs under `${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/` with owner-only permissions and never enters Git.

Until the replacement gate passes, live Pi/Agent Console visual agreement remains unproven.
