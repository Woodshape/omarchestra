# Pi terminal behavior

Status: **MVP behavior locked; observer protocol and packaging remain open technical contracts.**

This document specializes the authoritative MVP design for visible Pi terminals. It does not grant QML, the observer, or the terminal runtime additional domain authority.

## One visible process

Every working Agent Run is the actual interactive Pi process visible in its native Ghostty/Hyprland terminal. Omarchestra does not hide a JSON/RPC worker behind an Agent Console card, scrape ANSI or PTY output, or mirror conversation content into QML.

The extension inside that same Pi process is the only source of structured Pi lifecycle facts. The Team Runner commits orchestration state; Pi renders the committed presentation value and emits bounded observations.

## Managed terminals

Omarchestra-launched agents begin immediately as visible Coordinator, Builder, and Reviewer terminals. Roles without work display `waiting` rather than remaining hidden.

For each managed Agent Run:

- the Pi status surface persistently displays the committed `<Role> · <state>` value;
- the Agent Console card repeats that exact committed value;
- dynamic terminal metadata is `Omarchestra — <Role> — <state>` for Hyprland and switchers only;
- Ghostty remains decorationless and is never launched with a pinned `--title`;
- assignments enter the visible Pi through the extension's same-process Pi API only after the Team Runner commits them;
- structured lifecycle and attention events leave through an owner-only authenticated channel, never through terminal scraping.

Boomux owns managed PTYs, process attachment, detach/reconnect, and resize. Omarchestra references those capabilities through opaque Runtime Bindings.

## Ordinary terminals

Product setup may install one opt-in global Omarchestra Pi observer extension. This allows a Pi started normally in a terminal opened through `Leader+Enter` to announce itself to the local owner-only Agent Registry without changing how the user launched or controls Pi.

A discovered ordinary session:

- appears in the Agent Console under **Unassigned Agents** as an **Observed Pi Session**;
- displays `Unassigned · observed` in Omarchestra's named Pi status slot while connected, without replacing unrelated extension statuses;
- retains its ordinary terminal title and receives no Omarchestra terminal metadata;
- has no Team Goal, Role, Assignment, Agent Control Mode, writer lease, Runtime Binding guarantee, or orchestration authority;
- receives no prompt, assignment, keystroke, cancellation, process action, or lifecycle supervision from Omarchestra;
- remains usable when the registry or Companion Plugin is absent, restarting, incompatible, or unreachable.

Observation reports only protocol/version, exact ephemeral session identity, process instance identity needed for same-process correlation, lifecycle state, availability/busy eligibility, and bounded timestamps/health. It excludes prompts, responses, thinking, tool arguments and results, terminal output, repository contents, credentials, and environment values. Exact identity shape, retention, and expiry are open protocol work; PID, title, cwd, or a display name alone are never authority.

## Adoption

Adoption is an explicit user action, not a side effect of discovery or focus:

1. The user selects one current Observed Pi Session in Unassigned Agents.
2. The user selects a local Team Goal on the session's Execution Node and an unoccupied Role, then confirms the authority change. MVP ordinary-terminal sessions cannot be adopted into a remote Team Goal.
3. The Team Runner proposes an exact binding to the extension inside that same Pi process.
4. The extension verifies its current identity and activity and acknowledges or refuses from inside that same process.
5. The Team Runner reconciles current activity and commits the Agent Run, Role, control mode, and presentation value atomically.
6. Only after commit may Omarchestra send managed work. The footer changes from `Unassigned · observed` to `<Role> · <state>` and managed title metadata begins.

Node-mismatched, unknown, stale, exited, duplicate, busy, already-managed, role-conflicting, or unacknowledged sessions fail closed. A failed attempt leaves the Pi ordinary, interactive, observed when still connected, and unassigned. Adoption does not fabricate prior work or claim Boomux PTY persistence unless a managed Runtime Binding is separately and exactly established.

## Human input and takeover

Human input is always possible in the visible Pi terminal.

- Input to an Observed Pi Session is ordinary autonomous use and creates no takeover event because Omarchestra has no control authority.
- Input that steers a managed Agent Run enters `manual_takeover`, pauses dependent orchestration, and requires structured handoff and explicit reconciliation before managed dispatch resumes.
- The extension does not suppress user input or inject terminal keystrokes.
- Pi/provider/auth approvals remain in the exact terminal; runner-owned structured decisions may appear in the Agent Console.

## Restart and exit

A Companion Plugin reload affects only its Projection Session and never interrupts Pi. The bounded fake-only Companion slice now proves that the old plugin generation is rejected, a new Projection Session identity is allocated, identical cards are reconstructed from a fresh authoritative snapshot, and fake agent identities, connections, assignments, and delivered turns remain unchanged. Live Pi/Agent Console agreement has not been run and is not implied by that evidence.

A registry/runner restart reconstructs observed and managed presentation from fresh same-process registrations and authoritative snapshots; it does not infer identity from stale terminal metadata.

When an ordinary Pi exits or its observer disconnects beyond the bounded expiry contract, its Observed Pi Session becomes unavailable and then disappears or is retained only as explicitly stale history. It cannot be adopted or assigned while stale. Managed Agent Run exit follows the Team Runner's failure and recovery policy instead.

## Installation boundary

Observer and Companion Plugin installation, compatibility verification, update, rollback, and uninstall are explicit product-management operations. Starting or cleaning a Team Goal never installs, updates, disables, or removes either component and never writes Omarchy or Pi global configuration.

The Companion prototype now fake-proves this split through injected ports: one authorized installation remains enabled across two Team Goals, while open, reconnect, clear, hide, and cleanup leave plugin assets, receipt, and `shell.json` bytes unchanged. `just prototype-companion-check` reproduces that unattended evidence. `just prototype-companion-setup-validation` is a separate TTY- and exact-authorization-gated live procedure and has not been executed.

Ordinary-terminal observation and Adoption were not implemented by the Companion milestone. Their observer protocol, packaging, identity, expiry, acknowledgement, and reconciliation contracts remain open exactly as described above.
