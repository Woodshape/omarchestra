Implemented the visible Pi bridge spike under `spikes/pi-visible-bridge/`.

## Result

- Versioned Unix-socket NDJSON protocol
- Visible-host Pi extension using `pi.sendUserMessage()`
- Lifecycle, message, tool, attention, and takeover telemetry
- Runner restart and reconnect handling
- No SDK-created, spawned, RPC, or PTY-controlled Pi agent
- Complete spike record and file disposition
- Manual verification commands in `spikes/pi-visible-bridge/README.md`

## Validation

- Pi extension loads through Pi 0.84.4
- 11 automated tests pass
- `git diff --check` passes
- Evidence: `spikes/pi-visible-bridge/evidence/automated.txt`
- All changes remain within the spike directory

## Provenance

- `1.a` SOL: protocol and state helpers
- `2.a` TERRA: runner stub and runner tests
- `2.b` LUNA: Pi extension, reconnecting client, and extension tests
- `3.a` TERRA: integration tests and automated evidence
- `4.a` SOL: integration fixes, spike record, security constraints, and final validation

Automated feasibility is supported with constraints. Visible-TUI support remains pending the documented human observation gate and is not claimed.