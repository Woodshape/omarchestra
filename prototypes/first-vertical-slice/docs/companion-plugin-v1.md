# Companion Plugin v1 prototype contract

Status: **bounded prototype contract**

Code: [`../companion/contracts.ts`](../companion/contracts.ts)

This contract separates one durable Companion Plugin installation from each ephemeral Team Goal Projection Session. It does not define production packaging and does not grant QML, the plugin, or a Projection Session orchestration authority.

## Fixed baseline

| Field | Value |
| --- | --- |
| Plugin ID | `omarchestra.agent-console` |
| Initial plugin release | `0.2.0` |
| Companion protocol | `omarchestra.companion/v1` |
| Evidenced Omarchy version | `4.0.2-1` |
| Evidenced Quickshell version | `0.3.1-1` |

Compatibility is an exact pair, not a range. Setup fails closed for any other or unknown Omarchy or Quickshell version. Expanding this matrix requires new evidence and a contract update.

## Authority and lifecycle

1. An explicit setup operation installs and enables one versioned plugin through the supported Omarchy mechanism.
2. Installation persists when a Team Goal ends.
3. Opening a Team Goal creates a new Projection Session identity bound to that Team Goal, client, local session generation, and discovered plugin generation.
4. A session starts from an authoritative runner snapshot. QML is not opened with fabricated state.
5. Ordered updates and cursor recovery remain in the non-QML projection adapter.
6. `hide` and `clear` remove ephemeral state only. They cannot disable, unload, update, uninstall, rewrite QML, or write `shell.json`.
7. A plugin reload increments the plugin generation. Calls from the previous generation fail with `stale_plugin_generation`; recovery creates a new Projection Session and starts from a fresh authoritative snapshot.
8. Plugin reload and Projection Session cleanup have no Agent Run, terminal, PTY, assignment, or process-lifecycle authority.

Routine projection code receives only `CompanionShellPort`. Installation code receives the separate `CompanionInstallationPorts`. This type split prevents a routine session from reaching setup mutations by interface.

## Capability discovery

Discovery occurs before a runner connection or panel summon. A successful response has exactly:

```json
{
  "protocol": "omarchestra.companion/v1",
  "pluginId": "omarchestra.agent-console",
  "version": "0.2.0",
  "pluginGeneration": 1,
  "capabilities": [
    "session.open",
    "session.update",
    "session.intent",
    "session.hide",
    "session.clear",
    "session.resnapshot"
  ]
}
```

The required capability set is fixed for v1. Unknown capabilities, duplicate capabilities, a foreign protocol, an absent plugin, or a missing required capability fail before connecting to the runner. Capability discovery is read-only.

## Projection Session identity

Each open allocates this exact identity:

```json
{
  "sessionId": "opaque-bounded-id",
  "teamGoalId": "team-goal-id",
  "clientId": "projection-client-id",
  "sessionGeneration": 1,
  "pluginGeneration": 1
}
```

`sessionId`, `teamGoalId`, and `clientId` are bounded opaque identifiers. Generations are positive safe integers. Session generation is monotonic for a manager instance. Plugin generation comes from capability discovery. Neither is durable installation authority.

Every session-bound operation carries the full identity. A plugin-generation mismatch is a `stale_plugin_generation` error. A mismatch in any other identity component is a `stale_projection_session` error. Stale frames and intents cannot resurrect cleared or hidden presentation.

## Strict bounded envelopes

The TypeScript module rejects unknown fields and envelopes over 16 KiB. Identifiers, labels, details, nesting, collection sizes, and intent payloads are bounded. Input must be finite acyclic JSON data.

The session protocol defines these exact operations:

| Operation | Required body | Rule |
| --- | --- | --- |
| `authoritative_snapshot` | session identity and validated `SnapshotBody` | Team Goal must equal the session Team Goal; required before open |
| `ordered_update` | session identity and one validated `EventRecord` | existing projection core owns duplicate, identity, and contiguous-cursor checks |
| `resnapshot` | session identity and validated `SnapshotBody` | Team Goal and accepted cursor must match |
| `intent` | session identity, unique intent ID, `present_agent`, present Role, bounded payload | valid only for a ready projection |
| `intent_ack` | session identity, intent ID, result, optional detail | resolves one pending intent once |
| `hide` | session identity | hides the panel and clears ephemeral state |
| `clear` | session identity | clears ephemeral state without uninstalling or hiding the durable plugin |
| `reconnect` | session identity, `resumeAfter` or `null`, bounded reason | gaps and connection loss recover through an authoritative snapshot |

The first vertical slice continues to use the existing runner projection `SnapshotBody` and `EventRecord` validators. Companion envelopes add session and plugin-generation boundaries; they do not create another cursor state machine.

### Shell presentation payloads

A summon payload contains protocol, the complete session identity, and one validated ready projection. An `applyHandoff` call carries the same metadata plus the validated `status`, `cursor`, and three plain role cards. Cards contain only `role`, opaque `agentRunId`, and the committed `piStatus` string.

The runtime shell surface is deliberately limited to:

```text
capabilities(pluginId)
summon(pluginId, payloadJson)
call(pluginId, applyHandoff | clear | intentResult, payloadJson)
hide(pluginId, payloadJson)
```

There is no runtime install, update, enable, disable, unload, rescan, configuration-write, filesystem, terminal, or process method.

## Intent rules

The prototype supports only `present_agent`. The non-QML manager verifies that:

- the Projection Session and plugin generation are current;
- the projection is `ready`;
- the requested Role is present in the authoritative cards;
- the intent ID is new and bounded.

The intent is sent once and remains pending until an acknowledgement returns `accepted`, `invalid`, `duplicate`, or `unavailable`. QML emits a presentation intent and renders its result. It does not send protocol frames, deduplicate IDs, decide acknowledgement, or focus a terminal directly.

## Installation contract

Installation operations are exactly `install`, `update`, `rollback`, and `uninstall`.

### Release

A release binds:

- exact plugin ID, release version, and `omarchestra.companion/v1`;
- exact supported host compatibility;
- a bounded relative-path-to-bytes asset map;
- required `manifest.json` and `AgentConsole.qml` assets.

Absolute paths, `.` or `..` components, backslashes, empty components, oversized files, and oversized releases are invalid. The inspected release and asset map are cloned and frozen before inclusion in a plan.

### Read-only plan

Inspection performs no mutation and returns an immutable plan containing:

- schema version and requested operation;
- exact plugin and release, or `null` for uninstall;
- exact compatibility;
- digests of host compatibility, plugin tree, receipt, and `shell.json` state;
- inspection timestamp and stable plan digest.

Any host, plugin-tree, receipt, or configuration change after inspection makes the plan stale. Execution rechecks every precondition before mutation.

### Authorization

Authorization includes the exact operation, plan digest, authorization ID, and an issuer-verifiable token. It is valid for one exact immutable plan. Missing, forged, cross-operation, or different-plan authorization fails before writes.

Human authorization belongs only to the separate manual setup procedure. Automated gates use an in-memory fake authorizer.

### Receipt and ownership

A successful install writes an owner-only receipt with:

- plugin ID, current release, optional previous release, and compatibility;
- plan digest and installation timestamp;
- exact asset relative paths, absolute paths, SHA-256 values, owner, mode, device, and inode identities;
- exact `shell.json` preimage/postimage bytes and hashes.

The receipt is evidence for update, rollback, and uninstall. It is not accepted when absent, malformed, symlinked, foreign-owned, mode-unsafe, internally inconsistent, or inconsistent with the current installation. A pre-existing target without a verified receipt is foreign and is never adopted.

Update and rollback require an exact recursive asset inventory. Missing, extra, changed, symlinked, or identity-replaced assets fail closed. Uninstall removes only receipt-listed unchanged assets and restores the recorded supported-configuration precondition. Names, prefixes, current selection, or plugin ID alone never authorize deletion.

### Mutation order and recovery

Execution stages bounded changes, revalidates exact identities before each destructive step, invokes only supported `rescan`, `enable`, or `disable` shell operations, and checks postconditions. It never invokes a second untracked `shell.json` writer.

On failure, recovery restores the exact prior state only while recovery preconditions still match. If external drift appears during recovery, the operation does not overwrite it. It returns and records `incomplete_recovery` with expected/observed state digests and preserved drift paths. Incomplete recovery is explicit, never reported as success.

### Injected ports

`CompanionInstallationPorts` contains:

- no-follow filesystem inspection and exact-identity mutations;
- read-only configuration inspection;
- supported Omarchy `rescan`, `enable`, and `disable` actions;
- owner-only receipt access;
- plan-bound authorization verification;
- host compatibility and current-owner inspection;
- deterministic digest and clock providers;
- optional mutation and recovery evidence sinks.

The installation and Projection Session cores may not bypass these ports with direct filesystem, configuration, shell IPC, or process calls. The fake adapter and the separately human-authorized live adapter implement the same interfaces; only the live port implementation may translate a typed port operation into a bounded host/process action. The shared contract itself performs no I/O.

## Typed failures

All contract failures derive from `CompanionError` and carry a stable `code` plus bounded detail. Important categories are:

- protocol/envelope and capability mismatch;
- plugin absent, stale plugin generation, or stale Projection Session;
- invalid/duplicate intent or invalid projection state;
- unsupported compatibility or invalid release/plan;
- missing/mismatched authorization or stale precondition;
- unsafe path, foreign installation, invalid receipt, or configuration conflict;
- failed postcondition/operation;
- incomplete recovery.

Callers may show a bounded detail but must branch on `code`, not parse error prose.

## Explicit exclusions

This contract does not implement ordinary Pi observation, Adoption, Team Goal orchestration, durable event storage, terminal presentation, PTY control, provider access, SSH, Boomux, Hyprland, systemd, or live setup. Automated validation remains fake-only. QML remains presentation-only.
