# Retired repository-local Agent Console launch path

Status: **REJECTED PATH — evidence retained; not an MVP blocker.**

This disposable first-vertical-slice finding records why the installed Omarchy shell cannot load a repository-local QML plugin temporarily for one Team Goal. That requirement was based on an incorrect lifecycle assumption and has been superseded by the accepted Companion Plugin architecture in `docs/design/mvp.md` and ADR 0001.

## Installed API evidence

The installed Omarchy shell supports persistent third-party plugins, not per-run absolute-path registration:

1. `/usr/share/omarchy/shell/services/PluginRegistry.qml` scans direct children of `$HOME/.config/omarchy/plugins` plus packaged first-party plugins.
2. `/usr/share/omarchy/shell/README.md` documents copying or cloning a plugin into `~/.config/omarchy/plugins/<plugin-id>/`.
3. `summon(pluginId, payloadJson)` resolves a discovered, enabled ID; it does not accept a manifest or source path.
4. Third-party enablement is persistent shell configuration in `~/.config/omarchy/shell.json`.
5. The `omarchy-shell` wrapper forwards IPC to the running shell and is not a repository-local plugin host.

Therefore the old recipe correctly cannot discover and summon repository-local Agent Console QML without installation state. Its fail-closed behavior remains valid for that retired recipe.

## Correct resolution

Product installation and Team Goal execution are separate lifecycles:

- explicit human-authorized setup installs, validates, and enables one versioned Omarchestra Companion Plugin through the supported third-party path;
- update, rollback, and exact uninstall are also explicit product-management operations;
- routine Team Goal runs open and clear ephemeral Projection Sessions through the installed plugin;
- runtime cleanup leaves the installed plugin and Omarchy configuration unchanged;
- no upstream Omarchy feature, candidate patch, standalone Qt/GTK/Quickshell dashboard, or per-run QML copy/symlink is required.

The setup path may write exact Omarchestra-owned assets and enablement configuration because those writes are the declared installation operation, not hidden runtime side effects. The old gate's prohibition on configuration mutation still applies to routine Team Goal execution.

### Retained runtime guardrails

The retired recipe and every routine Team Goal path must still reject `quickshell -p`, a generic Qt/GTK dashboard, per-run copies or symlinks under `~/.config/omarchy/plugins/`, temporary `shell.json` edits, edits below `/usr/share/omarchy`, and an unverified assumed plugin copy. Only the separate explicit setup workflow may install and enable the versioned Companion Plugin.

## Disposition of the old launcher and spike

`just prototype-live-agent-console-gate` still preflights the absent `registerTemporaryPlugin` interface and exits before live resource creation. Keep that safe behavior until the recipe is replaced; do not implement or install the candidate patch merely to make it pass.

The bounded [`omarchy-ephemeral-plugin-loader`](../../../spikes/omarchy-ephemeral-plugin-loader/README.md) spike remains useful rejected-path evidence: it confirms the installed API shape and demonstrates the security and cleanup complexity introduced by temporary registration. Its candidate `omarchy.temporary-panel/v1` patch is scratch-validated only, will not be submitted upstream, and is not an Omarchestra dependency.

The next spike is Companion Plugin packaging and Projection Session integration, followed by the replacement human gate described in [`live-agent-console-gate.md`](live-agent-console-gate.md). Until that gate passes, live Pi/Agent Console visual agreement remains unproven.
