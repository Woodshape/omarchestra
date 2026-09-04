# Observer live bridge spike

Status: **fake-only contract green; live validation not run**

**PROTOTYPE — NOT PRODUCTION.** This spike records the bounded observer bridge
path. It does not promote the prototype into production and does not authorize
live installation, live Adoption, or automated access to a developer machine.

## Question

Can an ordinary visible interactive Pi report privacy-bounded lifecycle facts
through an extension in that same Pi process, an owner-only Unix NDJSON
transport, and a disposable gateway to the Companion 0.3.0 observer seam
without creating management authority, inspecting content, or launching Pi?

## Success criteria

The fake-only gate must prove:

- strict bounded observer framing and fail-closed malformed or oversized input;
- registration, heartbeat, graceful disconnect, abrupt disconnect, lease expiry,
  and same-session reconnect with fresh connection values;
- one `Unassigned · observed` projection with `choices: []`;
- rejection of Adoption and runner frames without registry mutation;
- Companion protocol/plugin/version and `session.observer` verification;
- isolation of Companion publication failure from the Pi connection;
- fail-open ordinary Pi behavior when the initial connection is unavailable;
- no automated import path to the live shell, installation, Adoption, managed
  work, content-bearing Pi hooks, or process/desktop controls; and
- a human launcher whose `--check` branch creates no user or live state.

A future human gate may additionally test the local socket with an ordinary Pi.
It may not claim live Adoption or stronger Pi activity attestation.

## Setup

The fake-only setup uses Node 22.6 or newer, protocol
`omarchestra.observer/v1`, injected duplex streams and clocks, the disposable
in-memory Agent Registry, and a fake Companion shell advertising the exact
observer-capable 0.3.0 contract. No test imports a live adapter or uses the
developer's installed plugin as a fixture.

Implemented seams:

- `prototypes/first-vertical-slice/observer/live-frame-channel.ts` — bounded
  NDJSON over an injected duplex stream;
- `prototypes/first-vertical-slice/observer/live-gateway-core.ts` — disposable
  observation-only registry gateway;
- `prototypes/first-vertical-slice/observer/live-companion-projection.ts` —
  narrow Companion observer publisher;
- `prototypes/first-vertical-slice/manual/live-observer-transport.ts` — owner-
  only Unix socket server/client with path, UID, mode, and device/inode checks;
- `prototypes/first-vertical-slice/manual/live-observer-extension.ts` — lazy
  Pi observer connector; and
- `prototypes/first-vertical-slice/manual/live-observer-gateway.ts` —
  human-authorized foreground wiring with bounded controls.

The separate procedure is
[`prototypes/first-vertical-slice/docs/observer-adoption-live-validation.md`](../../prototypes/first-vertical-slice/docs/observer-adoption-live-validation.md).

## Companion 0.3.0 catalog check

The immutable catalog contains two distinct releases:

- historical managed Companion `0.2.0`, still the default
  `COMPANION_PLUGIN_VERSION` for the existing Projection Session path; and
- observer-capable Companion `0.3.0`, with the additive `session.observer`
  capability and `UnassignedAgents.qml` asset.

The observer release is selected explicitly by the live preflight. Automated
QML/source tests compare its manifest and all packaged assets with the canonical
sources. The observer publisher separately validates the installed capability
envelope and never substitutes local catalog constants for the installed
response. No live installation or installed-plugin inspection was run by the
fake-only gate.

## Evidence

Run from the repository root:

```bash
just prototype-live-observer-check
```

The 2026-09-04 fake-only run passed 62 tests with zero failures. The gateway
entrypoint reported its no-resource check PASS, and the launcher reported its
fake-only check PASS. The gate runs injected frame, gateway, projection, and
bridge tests; launcher tests; import/recipe/privacy audits; Bash syntax
validation; and the launcher's `--check` path. It opens no Unix listener and
does not contact Pi, a provider, Omarchy shell IPC, a terminal, a desktop, SSH,
Boomux, systemd, or installed plugin state. It writes no tracked generated
evidence and no private live evidence.

Related unattended gates remain separate:

```bash
just prototype-observer-adoption-check
just prototype-companion-check
```

## Panel-opening limitation

`applyObservedAgents` is a sessionless state update in Companion 0.3.0. It does
not make `AgentConsole.qml` visible. Visibility still belongs to the existing
valid Projection Session `open()` path. The observer bridge cannot summon the
panel, fabricate managed cards, create a Team Goal, or perform Adoption.

If a separately valid Projection Session is already open, its presentation may
show the observed projection. That is optional visual context, not a requirement
for this spike and not live Adoption evidence. A standalone observer-only panel
requires a later Companion contract change.

## R1 and live boundary

Pi 0.84.4 has no complete content-free start/end lifecycle for slash-command
and `user_bash` execution. The contract accepts `ctx.isIdle()` plus its existing
guards as best-effort reconciliation and records this as R1. No input or
command content, conversation state, terminal output, tool data, credentials,
cwd, title, focus, or provider/model data may be inspected.

The live procedure requires an owner using a TTY, an already installed and
enabled observer-capable Companion 0.3.0, a canonical owner-only runtime path,
and private evidence outside Git. It prints the Pi command but never launches
it. The procedure compares before/after installation fingerprints and removes
only the exact socket/runtime identities. See its status and stop rules before
any human run.

Automation performed no live observer run. No live Adoption claim is made.

## Conclusion

The observation-only bridge contract is supported by fake and static evidence.
Live feasibility remains unproven. The result does not establish Adoption,
managed work, installed-plugin safety on a live machine, or a visible
observer-only panel.

## Design impact

Keep observation transport, registry state, and Companion publication separate
from Adoption and managed-runner authority. Keep Companion 0.2.0 as the
historical managed default and select observer-capable 0.3.0 explicitly. Treat
standalone observer panel opening as a future Companion contract change, and
retain R1 as bounded best-effort activity reporting rather than adding
content-bearing hooks.

## Disposition

Retain these modules and tests as removable prototype evidence for the bounded
observer contract. Do not promote them directly into production. Production
work remains open for authenticated transport, persistence and replay,
compatibility policy, telemetry filtering/coalescing, standalone observer-panel
lifecycle, slash-command and `user_bash` lifecycle coverage, and Adoption.
