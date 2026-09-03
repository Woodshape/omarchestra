# Manual role/state presentation gate — first vertical-slice prototype

Status: **COMPLETED WITH A REJECTED UI ASSUMPTION — contract revised.**

This is human evidence for the removable first vertical-slice prototype. The
automated gate remains fake-only and never invokes Pi, Ghostty, Hyprland, a
provider, SSH, Boomux, systemd, or other live integration.

## Question

Can the real visible Pi process expose truthful role/control state without
conversation content, and are native terminal titles plus Pi status acceptable
as two persistent Omarchy surfaces?

## Human-authorized environment

- Local Omarchy/Hyprland desktop
- Ghostty 1.3.1
- Pi 0.84.4, one real interactive TUI for Coordinator, Builder, and Reviewer
- One small `openai-codex/gpt-5.6-sol` Builder turn
- Private evidence under
  `${XDG_STATE_HOME:-~/.local/state}/omarchestra/manual-gates/`
- Exact controller-owned cleanup after each attempt

## Attempt 1 — decorationless Omarchy windows

The three real Pi TUIs opened in the normal Omarchy tiled presentation.

Observed:

1. All three Pi footer statuses visibly and independently identified their
   roles as `waiting`.
2. Starting the queued Builder assignment changed only Builder to `managed`.
3. Submitting `Manual takeover check` changed only Builder to
   `manual_takeover`; the fixed gate phrase was handled locally so it did not
   create a second model request.
4. Coordinator and Reviewer remained `waiting`.
5. The Pi status strings remained visible and unchanged through the one-minute
   persistence interval.
6. No native terminal title was persistently visible in the decorationless
   Omarchy layout.
7. The launcher had supplied Ghostty's `--title` option. Ghostty documents that
   this forces the title and ignores later program title sequences; captured
   Hyprland metadata therefore remained at the launch-time `starting` value.

Result: **FAIL** for the old two-surface acceptance rule. Pi status passed;
persistently visible terminal titles did not exist.

## Attempt 2 — forced Ghostty client decorations

The launcher defect was removed and dynamic Pi-controlled titles reached
Ghostty. Client-side decorations were forced so those titles became visible.

Observed at the idle checkpoint:

1. The Coordinator title was visible in a GTK header.
2. Narrow Builder and Reviewer tiles truncated their titles, so title alone
   could not expose the complete role/state string.
3. The GTK headers looked foreign to the normal decorationless Omarchy desktop
   and consumed scarce tiled space.
4. All three Pi statuses remained correct and visible.

The operator stopped the gate at this first checkpoint rather than legitimizing
non-native, truncation-prone chrome. Result: **ABORTED**, with the old title-bar
contract rejected.

## Accepted presentation contract

Human confirmation replaced the old requirement:

1. Agent Ghostty windows remain decorationless and visually native to Omarchy.
2. Each visible Pi footer persistently exposes `<Role> · <state>` without
   conversation content.
3. Agent Console cards redundantly expose role/state across the whole team.
4. The bridge continues to publish
   `Omarchestra — <Role> — <state>` as dynamic terminal-title metadata for
   Hyprland, launchers, and window switchers.
5. Terminal-title metadata is not treated as persistent chrome or an
   independent human-visible acceptance surface.

## Evidence and reproducibility

Private evidence records the exact expected strings, human confirmations,
Hyprland client snapshots, same-process Pi identities, runner lifecycle, and
cleanup. It is intentionally outside Git.

Fake-only checks for the disposable live adapter:

```bash
just prototype-vertical-slice-manual-check
```

The human-authorized terminal-side diagnostic is:

```bash
just prototype-vertical-slice-role-label-gate
```

It now launches decorationless windows and can validate Pi status plus dynamic
title metadata. It cannot complete the product presentation criterion until a
live Agent Console exists; QML redundancy remains fake-only in this slice.

## Conclusion

**Supported with constraints.** Real same-process Pi status rendering,
managed-state transition, Builder-only manual takeover, sibling isolation, and
one-minute persistence are supported. Dynamic title metadata is supported when
the launcher does not pin Ghostty's title. Visible title bars are explicitly
rejected for the Omarchy product. Live Agent Console redundancy remains a later
human gate.
