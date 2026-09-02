# Live Agent Console launch blocker

Status: **UNSUPPORTED — fail closed before creating live resources.**

This is a disposable first-vertical-slice finding, not a production decision.
It records the installed Omarchy shell API available to the later human gate.

## Required launch property

The gate needs a supported way for the running Omarchy shell to load and summon
an Agent Console plugin directly from this repository for one explicitly
human-authorized run. The launch must be temporary, must not change user
configuration, and must allow exact unload and cleanup.

The installed public plugin API does not provide that property.

## Installed API evidence

The evidence below comes from the installed, read-only Omarchy files. No live
shell IPC call or configuration mutation was used to establish it.

1. `/usr/share/omarchy/shell/services/PluginRegistry.qml` sets its third-party
   plugin directory to `$HOME/.config/omarchy/plugins` through
   `pluginsDir: home + "/.config/omarchy/plugins"`.
2. Its third-party scanner walks only direct children of that directory and
   accepts `<child>/manifest.json`. The other scan root is the packaged
   first-party plugin directory supplied by the Omarchy shell.
3. The installed `/usr/share/omarchy/shell/README.md` documents installation as
   cloning or copying a plugin into `~/.config/omarchy/plugins/<plugin-id>/`.
   It documents no additional search path or temporary absolute-path loader.
4. `/usr/share/omarchy/shell/shell.qml` resolves `summon(pluginId, payloadJson)`
   through the registry, rejects an unknown plugin, and rejects a disabled
   plugin. `summon` cannot accept a manifest path or QML source path.
5. Third-party enablement is represented in shell configuration. The registry's
   `setEnabled` calls the shell config mutator, and `shell.qml` persists that
   result through the `FileView` for
   `$HOME/.config/omarchy/shell.json`.
6. The documented `omarchy-shell` wrapper forwards IPC to the already-running
   shell. It does not register a repo-local source or start an isolated plugin
   host.

Therefore a repository-local Agent Console cannot be discovered, enabled, and
summoned through the installed supported API without writing under
`~/.config/omarchy/`.

## Forbidden fallbacks

This prototype must not bypass the blocker by:

- launching a second standalone Quickshell instance with `quickshell -p`;
- substituting a generic Qt, QML, or GTK window for an Omarchy shell plugin;
- creating a file or directory symlink under `~/.config/omarchy/plugins/`;
- temporarily copying plugin source under `~/.config`;
- editing, replacing, backing up, or restoring `shell.json` as part of the run;
- assuming that the operator has preinstalled or enabled a matching plugin;
- editing `/usr/share/omarchy` or using an undocumented internal loader.

A manually preinstalled copy is not a repo-local disposable launch seam and
would leave configuration outside the run's exact resource ownership. It is
not accepted as a prerequisite.

## Required failure behavior

`just prototype-live-agent-console-gate` must remain human-only. On this
installed API it must report this blocker and exit nonzero **before** it starts
or contacts a runner, Pi, Ghostty, Hyprland action, provider, Boomux, SSH,
systemd, or Quickshell/Omarchy UI resource. The automated check must test that
fail-closed contract with fakes and source audits. Fusion must not invoke the
human recipe.

Repository-local QML plugin source may still be schema-checked, linted, and
exercised through injected plain values. That proves only a presentation
boundary, not live Omarchy loading or visual agreement.

## Smallest next spike

Obtain or add one supported public Omarchy capability with this contract:

```text
registerTemporaryPlugin(absoluteRepoPluginDirectory) -> opaque registration
summon(opaque registration, payload)
hide(opaque registration)
unregister(opaque registration)
```

Equivalent API shapes are acceptable if they provide all of these properties:

1. source remains in the repository;
2. registration and enablement are process-local or explicitly ephemeral;
3. no write occurs under `~/.config` or `/usr/share/omarchy`;
4. the plugin runs inside the existing Omarchy shell and receives supported
   shared theme/component injection;
5. registration returns an exact identity that authorizes only its own hide
   and unload operations;
6. shell restart, crash, interruption, duplicate unregister, and plugin-ID
   collision semantics are documented and testable;
7. a non-mutating capability query lets the human launcher fail before it
   creates any other resource.

After that capability exists, the next authorized human gate can connect the
repo-local projection adapter to the plugin, exercise waiting → managed →
manual_takeover, confirm sibling isolation and one-minute persistence, and
perform exact cleanup. Until then, live Pi/Agent Console visual agreement is
pending and must not be claimed.
