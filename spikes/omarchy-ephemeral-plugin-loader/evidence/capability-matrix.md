# Installed Omarchy 4.0.2-1 capability matrix

Inspection date: 2026-09-02

Method: read-only source and package inspection. No shell IPC, shell restart, Quickshell launch, user configuration mutation, or live UI action was used.

## Result

| Capability | Installed result | Exact installed evidence |
| --- | --- | --- |
| Non-mutating capability discovery | **Absent.** `ping` is a health check and `listPlugins` describes discovered plugins. Neither reports an ephemeral-loader interface or version. No `temporary-panel` target exists in the complete installed IPC source. | `/usr/share/omarchy/shell/README.md:168-186`; `/usr/share/omarchy/shell/shell.qml:873-988`; the public shell IPC block ends at `/usr/share/omarchy/shell/shell.qml:1030` |
| Repo-local temporary registration | **Absent.** The third-party root is fixed to `~/.config/omarchy/plugins`; scanning accepts only its direct child manifests. The documented manual path also requires that directory and normal enablement. There is no absolute-path or process-local registration operation. | `/usr/share/omarchy/shell/services/PluginRegistry.qml:10-24`; `/usr/share/omarchy/shell/services/PluginRegistry.qml:662-697`; `/usr/share/omarchy/shell/README.md:127-141` |
| Summon | **Available only by discovered, enabled plugin ID.** Unknown and disabled IDs fail. Initial payloads are queued by plugin ID, not an opaque registration identity. | `/usr/share/omarchy/shell/shell.qml:440-478`; IPC wrapper `/usr/share/omarchy/shell/shell.qml:1002-1004`; docs `/usr/share/omarchy/shell/README.md:176-182` |
| Update/call after summon | **Available only for an already-loaded discovered plugin ID.** Calls made while the Loader is unresolved return `unknown`; there is no handle-aware call queue. | `/usr/share/omarchy/shell/shell.qml:558-578`; IPC wrapper `/usr/share/omarchy/shell/shell.qml:1027-1029`; docs `/usr/share/omarchy/shell/README.md:182` |
| Hide | **Available by plugin ID.** It invokes `close` and removes the ID from open state. Public IPC returns no typed identity-aware result. | `/usr/share/omarchy/shell/shell.qml:480-495`; IPC wrapper `/usr/share/omarchy/shell/shell.qml:1006-1008`; docs `/usr/share/omarchy/shell/README.md:180` |
| Exact unregister/unload | **Absent publicly.** Loader and queue maps are keyed by plugin ID. `unloadPanels()` clears every panel. Delegate destruction only removes an ID-keyed loader map entry. No public unregister operation, opaque authority, tombstone, or addressed teardown completion exists. | `/usr/share/omarchy/shell/shell.qml:409-419`; `/usr/share/omarchy/shell/shell.qml:515-555`; `/usr/share/omarchy/shell/shell.qml:610-654`; complete public lifecycle IPC `/usr/share/omarchy/shell/shell.qml:1002-1029` |
| Configuration writes | Summon, call, and hide do not directly persist, but a third-party plugin must first be installed below user config and enabled through normal state. `setEnabled` uses the wired mutator, which writes `shell.json`. Registry startup also creates the normal user plugin directory. There is no separate in-memory authority. | `/usr/share/omarchy/shell/services/PluginRegistry.qml:16-24`; `/usr/share/omarchy/shell/services/PluginRegistry.qml:123-138`; `/usr/share/omarchy/shell/services/PluginRegistry.qml:449-459`; `/usr/share/omarchy/shell/services/PluginRegistry.qml:696-715`; `/usr/share/omarchy/shell/shell.qml:108-112`; `/usr/share/omarchy/shell/shell.qml:148-161`; `/usr/share/omarchy/shell/README.md:215-225,268-272` |
| Restart/crash behavior | Open IDs, payload queues, panel entries, and loaders are QML properties of the single shell process. They do not survive restart. Installed source and enablement do survive on disk and are rediscovered. There is no temporary identity, stale-handle rejection, or documented exact crash cleanup contract. | shell process scope `/usr/share/omarchy/shell/README.md:3-11`; process maps `/usr/share/omarchy/shell/shell.qml:409-419,515-516,581-584`; session-only keep-loaded wording `/usr/share/omarchy/shell/plugins/README.md:76-77`; persisted paths `/usr/share/omarchy/shell/README.md:213-225` |

## Supporting validation and loader evidence

The installed validator is reusable but not sufficient by itself for an arbitrary absolute source:

- relative entry-point screening: `/usr/share/omarchy/shell/services/PluginRegistry.qml:36-40`;
- schema, required fields, IDs, kinds, and entry-point object: `/usr/share/omarchy/shell/services/PluginRegistry.qml:43-90`;
- lexical source join and prefix check: `/usr/share/omarchy/shell/services/PluginRegistry.qml:93-107`;
- first-party and reserved `omarchy.*` collision handling: `/usr/share/omarchy/shell/services/PluginRegistry.qml:597-615`.

It does not inspect canonical paths, ownership, symlink components, file type, file existence, or byte bounds. A temporary loader must call it and add stricter filesystem checks rather than replace it with a parallel schema.

The existing panel host establishes a bounded reuse point:

- it selects enabled panel, overlay, and menu manifests at `/usr/share/omarchy/shell/shell.qml:586-602`;
- it creates one asynchronous Loader and injects shared shell properties at `/usr/share/omarchy/shell/shell.qml:610-639`;
- it exposes load errors and hides failed panels at `/usr/share/omarchy/shell/shell.qml:640-649`;
- it unregisters loader bookkeeping during destruction at `/usr/share/omarchy/shell/shell.qml:651`.

The installed OSD demonstrates the panel method shape: its manifest declares the panel entry point at `/usr/share/omarchy/shell/plugins/osd/manifest.json:2-12`, and its root implements `open(payloadJson)` plus `close()` at `/usr/share/omarchy/shell/plugins/osd/Osd.qml:57-80`.

Quickshell API metadata explains why safe registration cannot return a registration identity synchronously:

- `Process` is asynchronous: `/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes:50-180`;
- `FileView` has asynchronous load signals but no canonical-path, ownership, or stat interface: `/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes:343-503`;
- `IpcHandler` invokes synchronous QML functions: `/usr/lib/qt6/qml/Quickshell/Io/quickshell-io.qmltypes:570-594`;
- `Loader.source` accepts a URL rather than a held file descriptor: `/usr/lib/qt6/qml/QtQuick/plugins.qmltypes:10025-10142`.

The installed `/usr/bin/omarchy-shell` is only a forwarder to an already-running shell (`:23-24,55-66`). It adds no registration or isolated host.

## Phase 1 branch decision

**Branch 2: the supported equivalent remains absent.**

The local source is sufficient to design and statically test a narrow candidate under a trusted same-user source model because it exposes manifest validation, asynchronous process inspection, Loader creation, injection, error signals, and object destruction. It is not sufficient to claim race-free protection against a malicious same-UID source replacement: QML cannot hold an already-validated file descriptor through Loader creation.

Proceed only with a candidate patch against the exact hashed Omarchy 4.0.2-1 baseline. Do not apply it to the installed shell and do not claim live support. Exact upstream Git provenance is unavailable locally, so the artifact cannot be called upstream-ready.
