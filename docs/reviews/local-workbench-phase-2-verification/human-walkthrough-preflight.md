# Human Phase-2 management walkthrough — live preflight

Status (2026-09-24): **operator authorized; original preflight BLOCKED before setup/Adoption on a then-active package-version pin.** Subsequently the operator explicitly rejected this policy; [ADR 0005](../../adr/0005-negotiate-companion-features-not-host-package-versions.md) and source changes remove the active pin and add read-only plugin-discovery probing. These changes have fake-host tests only. This original preflight remains read-only historical evidence, **not** a fresh live capability check or completed walkthrough.

## Scope and evidence

The operator expressly authorized the real Companion/Pi management walkthrough after the disposable S6 gate and independent integration review. Before installing, reloading, launching an owner, or touching Pi, the host was inspected:

- `omarchy version` / `pacman -Q omarchy quickshell`: **Omarchy 4.0.4-1**, Quickshell **0.3.1-1**.
- Installed `~/.config/omarchy/plugins/omarchestra.agent-console/manifest.json`: **0.7.0**, the earlier presentation candidate. This is not the current S6 runtime release.
- Current active `packages/local-workbench-v1/companion/releases.ts` release: **0.8.0**, pinned to Omarchy **4.0.3-1** / Quickshell **0.3.1-1**. The authoritative `docs/design/local-workbench-v1-contract.md` records that pin. The human-only `manual/local-workbench-preview.ts --setup` uses the historical receipt-backed installer; `CompanionInstallation.inspect()` requires the new release's exact compatibility to match the live host, and the installer's accepted compatibility set does not contain 4.0.4-1. The update would therefore be rejected before authorization/mutation. This conclusion is from inspected source, **not a live installer attempt**.
- `omarchy-shell shell ping` answered `ok`, and `listPlugins` showed the existing plugin enabled; neither call installed or opened a Workbench Projection Session.

No `--setup`, Pi extension load, shell reload, owner startup, Project registration, proposal, Adoption, Assignment delivery, check execution or cleanup was attempted. Existing plugin and receipt bytes were not changed. Do not bypass compatibility checks, disguise 4.0.4 as 4.0.3, or update the live plugin just to obtain a PASS.

## Next contract decision

**Follow-up read-only host check (2026-09-24):** called `LiveCompanionHost(new DirectLiveCommandPort(5000)).compatibility()` without setup or owner startup. It observed Omarchy `4.0.4-1`, Quickshell `0.3.1-1` and a successful `omarchy-shell shell listPlugins` JSON-array response. This confirms only discovery, not that the shell will enable/load the new Companion or answer its runtime contract. No host state was mutated.

**Replacement engineering check (fake-only):** `manual/test/workbench-preview.test.ts` reports 11/11, historical installer/setup regressions 44/44, and the full disposable Phase-2 gate exits 0 (including offscreen QML). On a fake 4.0.4-1 host an owned 0.7 → 0.8 update succeeds; a later fake host bump does not invalidate the owned receipt; inspect→apply host drift still refuses mutation; a fake shell without `listPlugins` is refused. No command in this check installed or modified the real plugin.

**Superseded next step:** fixed-version pin expansion or a host downgrade is no longer required. The active release now has `compatibility: null`; the authorized installer validates recorded package versions for boundedness and inspect→apply freshness, probes the read-only shell plugin discovery API, and retains receipt/asset/owner safeguards. The human operator must still run a fresh preflight and explicitly authorized setup in a TTY, and restart/revalidate the *loaded* Companion before management presentation. This policy change alone does not establish that Omarchy 4.0.4-1's full plugin API works live. Historical 0.6/0.7 release bytes and receipts remain unchanged. No Phase-3 dispatch is authorized.
