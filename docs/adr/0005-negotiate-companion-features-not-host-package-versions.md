---
status: accepted
---

# Negotiate Companion features, not fixed Omarchy package versions

> **Partial supersession:** The historical 0.6.0/0.7.0 copied-asset retention clause below is superseded by [ADR 0006](0006-use-git-history-for-companion-release-source.md). All capability-negotiation and installation-ownership decisions in this ADR remain accepted.

The operator explicitly rejected hard-binding the Local Workbench Companion to one Omarchy package version after its installed 0.7.0 plugin ran on Omarchy 4.0.4-1 while the active 0.8.0 package still declared 4.0.3-1. Exact package-version equality is not a useful proxy for the supported third-party plugin API and blocked the separately authorized human walkthrough before setup.

For the **active Local Workbench release and its explicit setup**, require the needed shell/plugin operations to be available, verify enabled ownership and exact release assets through the installation receipt, and ask the **loaded** Companion for the exact plugin ID, release version, protocol, ordered capability set, presentation contract, destinations and generation. Missing/incompatible methods or loaded contracts fail closed. Unknown Omarchy or Quickshell package versions alone do **not** prohibit setup or presentation.

The installer may record observed host package versions as audit information and as an inspect→apply freshness precondition: if the host changes during the authorized operation, re-inspect instead of applying a stale plan. Such observed versions do not become a release-level supported-version allowlist or invalidate a previously owned installation after an unrelated host update. For an explicitly authorized active-release **update only**, unrelated out-of-band bar layout changes may be carried into the next receipt's uninstall preimage if the old receipt's plugin operation is verified, current configuration differs exclusively in the bar subtree, original and current JSON formatting is canonical, and no Omarchestra plugin ID appears in the changed bar. Inspect must validate this before the consent prompt; execute rechecks the exact snapshot. The original receipt remains untouched until the authorized update and all other drift still fails closed. The historical 0.6.0/0.7.0 copied-asset retention requirement is superseded by ADR 0006; Git history is the source archive. Do not rewrite foreign installations or relax exact filesystem/configuration ownership, plan digest, authorization, or rollback checks. Normal `start`/`open`/`hide` never install, update, rescan, or reload the shell.

The operator-approved 0.14.0 responsiveness repair retains initial full loaded
negotiation, then checks the exact expected protocol/plugin/release/presentation/
generation inside one guarded QML operation instead of separate discovery round
trips before each call. The compiled loaded version is not relabelled by mutable
manifest metadata. Session-bound close never follows its check with an unguarded
hide. This is transport batching of the same checks, not cached permission to
mutate a successor instance. The [checkpoint](../reviews/local-workbench-phase-2-verification/responsive-dock.md)
records real disposable Quickshell/Owner evidence and the separate installation
boundary.

Acceptance requires fake-host negative tests for missing capabilities, malformed/foreign loader state, changed host between plan and apply, conflicting receipt ownership, and installed-release mismatch, plus a later separately human-operated TTY installation/reload and loaded-component check. It is **not** an assertion that every Omarchy release is compatible. Unsupported observed APIs remain unavailable with actionable reasons; real Assignment/check execution is unchanged and unavailable in Phase 2.
