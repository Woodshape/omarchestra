# Standalone Foot navigation and Hyprland focus syntax

Status: **implementation and full disposable engineering gate PASS; existing Pi
extensions not reloaded. No live focus performed.** Companion assets/protocol
remain 0.14.0. Independent review and physical focus acceptance remain separate.

## Request and authority

The operator reports switching between Herdr agents succeeds but both rows show
`Focus unverified`; an external ordinary-terminal Pi reports navigation unavailable.
They explicitly approved adding checked standalone-window navigation and fixing
the unverified result. The MVP/terminal contracts now record the added bounded
**direct local Foot → Hyprland** path. This is not support for every emulator,
multiplexer, wrapper, remote terminal or reattachment arrangement.

Navigation remains one explicit presentation request through the exact challenged
Pi extension, with receipt-before-send, current-session guards, replay suppression,
no Adoption/control/input/launch side effects and no automatic retry. Unknown
post-dispatch outcomes remain visible; the repair does not simply label CLI success
as `shown` or remove verification.

## Confirmed syntax defect

Read-only inspection found the active compositor is Hyprland **0.56.2**, commit
`efb50993780079460b0cbed1363e2166a2de1d9f`, using the Lua configuration manager.
The old native leaf emitted:

```text
hyprctl dispatch focuswindow address:0x…
```

In Lua mode, [that exact compositor revision's dispatch handler](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/debug/HyprCtl.cpp)
constructs `return hl.dispatch(<arguments>)`. The old arguments are invalid Lua.
Thus Herdr can switch its pane successfully, but the following window-focus step
fails, correctly leaving an **unknown** partial outcome. It is not proof that
Herdr's post-focus flag should be ignored.

The [dispatcher constructor](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/lua/bindings/LuaBindingsDispatchers.cpp)
accepts `hl.dsp.focus({window="address:0x…"})`. The
[dispatcher wrapper](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/config/lua/bindings/LuaBindingsDispatcherUtils.cpp)
returns protected `HL.Dispatcher` userdata, not a raw Lua function. The first
candidate capability probe incorrectly required a function: disposable tests
passed but a read-only native probe refused. That finding became a wrapped-value
regression; the corrected native probe reports `lua`. No focus was issued during
any of these probes.

Reproducible **read-only** checks (the constructed dispatcher is never invoked,
and `load` only compiles the old expression):

```sh
hyprctl -j version
hyprctl eval 'local fn = load("return hl.dispatch(focuswindow address:0xabc)"); assert(fn == nil)'
hyprctl eval 'local d = hl.dsp.focus({window="address:0x0"}); assert(type(d) == "function" or getmetatable(d) == "HL.Dispatcher")'
```

Both `eval` checks returned `ok`. A separate query of the constructor's Lua type
returned `userdata`. The production command adapter's corrected **read-only**
`focus-api` operation also returned `lua` on this desktop. These observations
establish syntax/capability facts, not physical focus acceptance.

## Implementation

### Compositor API selection

- Each complete local proof checks the exact compositor socket, window metadata
  and a fixed, read-only dispatcher-construction probe.
- `ok` selects the Lua dispatcher. Only the exact known response `eval is only
  supported with the lua config manager` selects the legacy dispatcher. Unknown,
  malformed or failed probes refuse **before any pane/window mutation**. Legacy
  behavior is fixture-tested, not separately validated on a legacy-configured host.
- Pin the selected API in the local proof. A mode change between checks is identity
  drift, not permission to try both syntaxes. After a dispatch failure there is no
  fallback/retry. Lua code is fixed except for a strictly hexadecimal, internally
  resolved window address; no caller text, title or shell interpolation is allowed.
- A successful command still requires the unchanged local proof, a focused Herdr
  pane where applicable, and the exact active-window address.

### Standalone path

- Any inherited `HERDR_*` hint requires a complete valid Herdr route. Missing,
  malformed or failed Herdr context never selects the standalone path instead.
- Without Herdr routing, require interactive stdin/stdout character devices that
  match the controlling TTY, not just arbitrary interactive descriptors. Recheck
  both descriptor devices before/after inspection. The addressed Pi must lead
  its own foreground process group on that nonzero controlling TTY.
- Require a stable PID/start/parent/group/TTY chain to the original Foot process.
  Pi may be executed directly by Foot or through same-TTY `bash`, `zsh`, `fish`,
  `sh` or `dash` ancestors whose foreground group is that Pi. Unknown wrappers,
  Herdr/tmux/screen/SSH ancestors, background jobs and TTY hops refuse.
- Exactly one compositor window may belong to that Foot process; it must be
  mapped, non-hidden and class `foot`. Missing/multiple windows, Foot-client/server
  arrangements without a unique original ancestor window, and other emulators
  remain unsupported. Do not choose the visible member of an ambiguous set.
- Three complete proofs: initial, immediately before the sole window dispatch,
  and afterward, followed by active-window verification. No pane ID is invented
  (`paneId`/`paneFocused` are locally null), no Herdr command runs, and no window
  lookup uses display code, title, cwd or recency.

The Herdr path retains all four complete proofs, pane-then-window ordering and
original-ancestor/client-foreground constraints. At current operation counts it
uses 19 native commands; standalone uses eight. The original four-second operation
abort and per-command 600 ms/SIGKILL/1 MiB bounds remain. No local routing/process
metadata crosses the bridge. Public focus still has an unavoidable check/dispatch
race and no attachment attestation; `shown` remains a momentary checked result.

## Executable evidence

```sh
node --test packages/local-workbench-v1/test/pane-navigation.test.ts \
  packages/local-workbench-v1/test/window-navigation.test.ts
node --test packages/local-workbench-v1/test/phase-2-framed-adoption.test.ts \
  packages/local-workbench-v1/test/phase-2-real-bridge.test.ts
node --test spikes/terminal-focus/probe.test.mjs
bash packages/local-workbench-v1/scripts/phase-2-gate.sh
git diff --check
```

- The old Lua-host regression first returned `unknown` instead of `shown`; the
  preserved failure is [here](../../../spikes/terminal-focus/evidence/lua-window-focus-regression.txt).
- Actual native entry/argv/parser coverage for standalone and Herdr routes,
  partial routing, unsupported API/TTY/ancestry/window facts, PID/start/parent/
  endpoint/API drift before and after mutation, command failures, wrong active
  window, connection expiry and abort. No native OS focus is used by tests.
- A real Lua parser test checks old/new expression syntax, fixed-address injection
  refusal, raw-closure and protected-dispatcher construction, and that probing
  never dispatches. `/usr/bin/lua` (tested 5.5.1) is a **test-only** prerequisite;
  production uses the compositor's API, not a Lua subprocess.
- Actual adapter → authority → durable receipt → framed registry → Pi extension →
  native entry/command adapter with fake OS facts, for both observed and explicitly
  adopted/manual-takeover sessions. Replay does not dispatch; failed window focus
  remains unknown; no Run/Role/Assignment changes follow navigation.
- Actual private Unix-socket transport now reaches the standalone native entry,
  rather than a navigator callback that simply returns `shown`.
- Full gate: **PASS**, including **28 offscreen Qt rows**, periodic heartbeat loss
  control, warm wake path, existing bridge/Adoption/receipt/rollback suites and
  five pre-existing future-execution TODOs. Log:
  `/tmp/workbench-window-navigation-gate.log`. Original focus spike: **11/11 PASS**.

## Applying and remaining acceptance

No Companion asset, release number or bridge envelope changed. Neither an Owner
restart nor a shell reinstall/reload is needed for this Pi-side leaf correction.
A **newly loaded** observer uses it; existing Pi extensions retain their imported
code and require the operator's explicit `/reload` when idle (or a newly started
Pi). No reload, process launch, navigation, Adoption or management operation was
performed here.

An extension reload creates fresh observation identity and does **not** silently
recover an existing managed Run. Plan managed-session reload/reconciliation and
any retirement/fresh Adoption separately, preserving history and explicit
confirmation. Test an unassigned standalone Pi first without adopting it. Physical
standalone-window/Herdr focus, absence of false unverified outcomes, latency and
independent review are still outstanding.
