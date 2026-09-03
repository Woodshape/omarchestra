# Temporary panel interface v1

Status: **fake-proven candidate contract for Omarchy 4.0.2-1; not installed or live-proven**

Interface identifier: `omarchy.temporary-panel/v1`

## Public boundary

The candidate adds one IPC target and one method:

```text
target: temporary-panel
method: request(requestJson: string) -> responseJson: string
```

Every request is one bounded JSON object:

```json
{
  "version": 1,
  "operation": "capabilities"
}
```

Every response is a typed envelope:

```json
{
  "version": 1,
  "operation": "capabilities",
  "ok": true,
  "result": {}
}
```

Failures use one shape:

```json
{
  "version": 1,
  "operation": "register",
  "ok": false,
  "error": {
    "code": "plugin_id_collision",
    "message": "The manifest id is already registered",
    "retryable": false
  }
}
```

The target exposes only `request`. It does not expose separate shallow lifecycle methods. The supported operations are `capabilities`, `register`, `status`, `summon`, `call`, `hide`, `unregister`, and `inspect`.

## Capability discovery

`capabilities` is versioned and non-mutating. It must not allocate an operation, register a source, create a Loader, change the normal plugin registry, or call a configuration provider, mutator, or writer.

Candidate response:

```json
{
  "version": 1,
  "operation": "capabilities",
  "ok": true,
  "result": {
    "interface": "omarchy.temporary-panel/v1",
    "supported": true,
    "scope": ["panel"],
    "registration": "asynchronous",
    "persistence": "process-memory-only",
    "restart": "registrations-cleared",
    "limits": {
      "requestBytes": 32768,
      "pathBytes": 4096,
      "manifestBytes": 65536,
      "entryPointBytes": 1048576,
      "payloadBytes": 16384,
      "methodBytes": 64,
      "registrations": 16,
      "queuedCallsPerRegistration": 32,
      "queuedBytesPerRegistration": 65536
    }
  }
}
```

On the current installed baseline the `temporary-panel` target does not exist. A caller must treat target absence, method absence, malformed capability output, `supported !== true`, or an unknown interface identifier as unsupported. It must fail before creating any runner, terminal, provider, remote, UI, or plugin resource.

## Registration

Request:

```json
{
  "version": 1,
  "operation": "register",
  "path": "/absolute/canonical/repository/plugin"
}
```

Filesystem inspection is asynchronous in the available QML API. A valid initial response therefore returns an operation identity, not lifecycle authority:

```json
{
  "version": 1,
  "operation": "register",
  "ok": true,
  "result": {
    "state": "validating",
    "operationId": "opaque-operation-identity"
  }
}
```

The caller polls `status`:

```json
{
  "version": 1,
  "operation": "status",
  "operationId": "opaque-operation-identity"
}
```

A successful terminal result contains a distinct registration identity:

```json
{
  "version": 1,
  "operation": "status",
  "ok": true,
  "result": {
    "state": "registered_hidden",
    "registrationId": "opaque-registration-identity",
    "pluginId": "example.agent-console"
  }
}
```

Operation identities are for observing validation only. They cannot summon, call, hide, or unregister a panel. Registration identities are server-generated, opaque, process-local capabilities. Callers must never parse an identity or reconstruct one from a plugin ID or path.

### Path and source rules

Registration succeeds only when all checks pass without partial registry or loader state:

1. `path` is a string with no NUL or newline, is at most 4096 UTF-8 bytes, begins with `/`, exists, is a directory, and is already in canonical form.
2. Every component from `/` through the source directory is checked with non-following metadata and is not a symbolic link. The source directory is owned by the shell user and is not group- or world-writable.
3. `<path>/manifest.json` is an existing, user-owned, non-symlink regular file no larger than 65536 bytes.
4. The manifest parses as one plain JSON object of depth at most 16. Its serialized form and bounded fields satisfy the limits below.
5. The host deep-clones the parsed manifest, stamps the verified canonical source as `__sourceDir`, and calls the installed `PluginRegistry.validateManifest()` contract. It does not implement a weaker substitute.
6. The validated manifest has exactly `kinds: ["panel"]`, exactly one entry-point key named `panel`, and no service, bar, bar-widget, overlay, or menu kind.
7. The panel entry point is a relative string no longer than 1024 UTF-8 bytes. The installed entry-point check passes. Its canonical result remains below the source directory, every component is non-symlink, and the final path is an existing, user-owned regular file no larger than 1048576 bytes.
8. The filesystem checks run again immediately before assigning `Loader.source`. The current manifest bytes must exactly match the registered snapshot, in addition to the path, ownership, permission, symlink, and entry-point checks. A changed source fails closed.

The temporary host never honors `keepLoaded`. `hide` unloads the temporary object while retaining registration authority.

### Manifest bounds

- `id`: 1 to 128 UTF-8 bytes and valid under the installed validator.
- `name`: 1 to 256 UTF-8 bytes.
- `version`: 1 to 64 UTF-8 bytes.
- `kinds`: exactly one item, `panel`.
- `entryPoints`: exactly one key, `panel`.
- Total manifest: at most 65536 bytes and depth at most 16.
- Diagnostic text returned to a caller: at most 1024 UTF-8 bytes.

Optional installed-schema fields remain subject to the total size and depth bounds. The temporary host does not broaden the installed schema.

### Ownership and TOCTOU limit

Omarchy plugins are unsandboxed code. This interface accepts only an explicitly requested, user-owned source and assumes the shell user trusts that code and that same-user processes do not race to replace it during validation and loading.

The available QML Loader accepts a path URL, not an already-open file descriptor. Rechecking immediately before load narrows but cannot eliminate the same-UID replacement race. This candidate does not claim protection from a malicious same-user process. Race-free identity would require a native helper that loads from safely held descriptors or an immutable snapshot. Persistent developer installation is not an accepted workaround.

## Collision rules

Registration rejects:

- any ID beginning with `omarchy.`;
- an ID present in the installed first-party or third-party registry;
- an ID held by another pending or ready temporary registration;
- a canonical source directory held by another pending or ready temporary registration;
- a source directory equal to an installed plugin's source directory;
- a request made while the installed registry scan is unresolved, with retryable `registry_busy`;
- a byte-identical duplicate request already validating, with retryable `duplicate_pending`.

A duplicate register never aliases or returns an existing registration identity.

When installed plugins change, every temporary record is rechecked. A new installed ID or source collision invalidates only the colliding temporary registration, clears its queues, closes and unloads its object, and leaves an inspectable `failed_collision` record that can still be unregistered. Its temporary source and ID claims remain held until exact unregister completes, even if the installed collision later disappears. It never disables or unloads the installed plugin.

## Lifecycle operations

### Summon

```json
{
  "version": 1,
  "operation": "summon",
  "registrationId": "opaque-registration-identity",
  "payload": {"status":"waiting"}
}
```

`summon` revalidates the source, creates the Loader owned by that exact registration when needed, and queues one `open(payloadJson)` delivery. Shared shell properties are injected before queue delivery. Multiple accepted summons preserve arrival order within the queue bounds. An already loaded panel receives the new payload; initial payload delivery is not the update mechanism.

### Call and update

```json
{
  "version": 1,
  "operation": "call",
  "registrationId": "opaque-registration-identity",
  "method": "updateProjection",
  "payload": {"status":"managed"}
}
```

`call` is accepted only after `summon` has started. While the Loader is resolving, calls join the same per-registration FIFO after the open payload. Once loaded, the host invokes `item[method](payloadJson)`.

A method must match `^[A-Za-z][A-Za-z0-9_]{0,63}$`, must not begin with `_`, and must not be `open`, `close`, or `destroy`. A missing method produces `unknown_method`; an exception produces `plugin_call_failed`. Immediate return values are converted to a string and truncated at 4096 UTF-8 bytes. Queued calls report `queued`, and observation of their later failure is available through `inspect`.

This seam is the required path for later committed Agent Console projection values. A caller must not rely on the initial summon payload.

### Payload bounds

A payload must be a JSON-serializable null, boolean, finite number, string, array, or plain object with depth at most 16. Its compact JSON encoding is at most 16384 UTF-8 bytes. Each registration holds at most 32 queued open/call entries and 65536 queued bytes. Exceeding either bound fails without changing the queue.

### Hide

`hide(registrationId)` clears that registration's pending open and call queue, invalidates in-flight loader callbacks, invokes `close()` when available, deactivates and clears its Loader, and waits for its item to disappear. The registration remains in `registered_hidden` and may be summoned again.

- First hide: `changed: true`, with `state: hiding` or `registered_hidden`.
- Hide while hiding or already hidden: success with `changed: false`.
- Hide of failed but already-unloaded registration: success with `changed: false`.
- Unknown, stale, or wrong identity: typed failure and no state change.

### Unregister

`unregister(registrationId)` performs exact teardown:

1. Mark only the addressed record `unregistering` and advance its generation.
2. Reject new summon/call operations and clear all queued payloads and calls.
3. Invoke `close()` on its loaded item when available.
4. Set its Loader inactive, clear its source, remove its model entry, and destroy the Loader.
5. Confirm the item and Loader are gone using callbacks that compare both registration identity and generation.
6. Remove active registry, ID, and source claims.
7. Retain a bounded process-local tombstone so duplicate unregister can report safely.

The first request returns `changed: true`. A duplicate while teardown is pending returns success with `state: unregistering` and `changed: false`. A duplicate unregister matching a retained tombstone returns success with `state: unregistered` and `changed: false`; other lifecycle operations against that tombstone fail with `unknown_registration`. After tombstone expiry every operation returns `unknown_registration`. No result authorizes cleanup by plugin ID, path, name, prefix, focus, or current selection.

## State machine

```text
register request
  -> validating
  -> rejected
  -> registered_hidden

registered_hidden --summon--> loading --open delivered--> summoned
loading --hide--> hiding -> registered_hidden
summoned --call--> summoned
summoned --hide--> hiding -> registered_hidden
loading/summoned/registered_hidden/failed --unregister--> unregistering -> unregistered tombstone
validation/load/call/source/rescan error -> failed (cleanup remains available)
```

A load or plugin error is stored as bounded `lastError` and remains visible through `inspect`. Load failure clears queued work and unloads the failed object. It does not erase the registration identity, release its source or ID claims, or prevent exact unregister.

## Identity and restart semantics

The host creates a fresh per-shell nonce independently of capability queries and combines it internally with monotonic counters for operation and registration identities. The serialized values remain opaque and are bounded to 256 UTF-8 bytes. Every asynchronous callback captures registration identity plus a generation and does nothing unless both still match the current record.

- A random or malformed identity returns `invalid_identity` or `unknown_registration`.
- An identity from another registration cannot affect a sibling.
- An identity invalidated by unregister cannot be reused.
- Shell exit, crash, or restart clears registrations, operations, queues, loaders, and tombstones because none are persisted.
- A restarted shell creates a different nonce. Pre-restart identities return `stale_registration` when recognizable or `unknown_registration`; both are fail-closed.
- Sources are not rediscovered or revived after restart. A caller must query capabilities and register again.

## Persistence isolation

The temporary host maintains separate in-memory maps and Loader objects. It must not:

- insert into or mutate `PluginRegistry.installedPlugins`;
- call `shellConfigMutator`, `persistShellConfig`, or `FileView.setText`;
- add entries to `shell.json` or normal enabled-plugin arrays;
- create, copy, or link files below `~/.config/omarchy/plugins`;
- write the source directory or installed Omarchy files.

The existing shell independently creates its normal user plugin directory during startup. This contract proves that capability and temporary lifecycle operations cause no additional configuration or source writes; it does not claim the entire installed shell performs no filesystem activity.

## Capacity and retention

- At most 16 pending plus active temporary registrations per shell.
- Filesystem validation is serialized through one fixed helper process; excess work fails with retryable `capacity_exceeded`.
- At most 64 terminal operation records are retained, including active registration results.
- At most 64 unregister tombstones are retained for five minutes. Oldest terminal records are evicted first, never active records.
- Capability queries do not consume capacity.

## Error codes

The interface uses stable codes. Implementations may add bounded detail but must not replace codes with free-form success strings.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `bad_json` | Request is not one JSON object | no |
| `request_too_large` | Request exceeds 32768 bytes | no |
| `unsupported_version` | `version` is not exactly `1` | no |
| `unknown_operation` | Operation is not part of v1 | no |
| `invalid_field` | Required field is absent or has the wrong type | no |
| `invalid_identity` | Identity syntax or length is invalid | no |
| `unknown_operation_id` | Validation operation is absent or expired | no |
| `unknown_registration` | Registration is absent or tombstone expired | no |
| `stale_registration` | Detectable identity belongs to another shell instance | no |
| `registry_busy` | Installed registry scan is unresolved | yes |
| `capacity_exceeded` | Registration or operation capacity is full | yes |
| `duplicate_pending` | Same request is already validating | yes |
| `path_invalid` | Path is non-absolute, noncanonical, missing, or wrong type | no |
| `path_not_owned` | Source is not owned by the shell user | no |
| `symlink_component` | Source, manifest, entry point, or a component is a symlink | no |
| `source_unsafe` | Source permissions or revalidation are unsafe | no |
| `manifest_too_large` | Manifest exceeds its bound | no |
| `manifest_invalid` | Installed manifest validation or bounded parsing failed | no |
| `panel_scope_required` | Manifest is not exactly one panel kind and entry point | no |
| `entry_point_invalid` | Entry point is missing, escaped, unsafe, or oversized | no |
| `plugin_id_collision` | ID collides with installed or temporary state | no |
| `source_collision` | Canonical source collides with installed or temporary state | no |
| `failed_collision` | A later rescan invalidated the registration | no |
| `invalid_payload` | Payload is not bounded JSON | no |
| `queue_full` | Queue count or bytes would exceed its bound | yes |
| `invalid_method` | Method syntax or lifecycle reservation failed | no |
| `not_summoned` | Call has no active or loading summon | no |
| `unknown_method` | Loaded item does not expose the requested method | no |
| `plugin_load_failed` | Loader failed; inspect contains bounded detail | no |
| `plugin_call_failed` | Plugin method threw | no |
| `source_changed` | Immediate pre-load revalidation differs | no |
| `teardown_pending` | Exact destruction has not completed | yes |

## Test seams

Tests observe behavior only through `request(requestJson)` with injected filesystem, loader, config, identity, restart, and cleanup ports:

1. Capability response is versioned and causes no state/config mutation.
2. Registration accepts one valid fake panel and rejects malformed, non-panel, escaped, symlinked, non-owned, oversized, duplicate, and colliding sources without partial state.
3. Register, summon, later call/update, hide, and unregister affect only the addressed fake and clear its Loader, item, and queues.
4. Wrong, stale, duplicate, and pre-restart identities fail safely; restart starts empty.
5. Capability and lifecycle never call injected config mutators or writers; installed state remains byte-identical.
6. A candidate patch applies only to a hash-verified scratch baseline and modified QML lints without UI launch.
7. Forced failures and interruptions remove exact scratch resources while unrelated fakes survive.
8. The automated command graph contains no live IPC, GUI, config mutation, provider, remote, supervision, or service-manager route.
