# Omarchy ephemeral panel loader spike

Status: **complete rejected-path evidence; candidate patch verified only in scratch and will not be installed or submitted**

This directory is a removable, fake-only spike. It is not installed Omarchy source, a live plugin, or production architecture. ADR 0001 supersedes its original product-path assumption: Omarchestra will install a persistent companion plugin and create ephemeral Projection Sessions instead of registering QML per Team Goal.

## Question

> Can the installed Omarchy shell support a safe, public, in-memory interface that registers a repository-local panel plugin, summons and updates it inside the existing shell, then hides and unregisters it exactly, without writing user or installed configuration?

## Phase 1 answer

**The supported equivalent is absent from installed Omarchy 4.0.2-1.**

The shell discovers third-party plugins only below `~/.config/omarchy/plugins`, normal third-party enablement is represented in `shell.json`, and public summon, call, and hide operations address discovered plugin IDs. It exposes no versioned capability query, absolute-path temporary registration, opaque lifecycle identity, or exact public unregister operation.

The complete result with installed file and line citations is in [`evidence/capability-matrix.md`](evidence/capability-matrix.md). Exact source and package hashes are in [`evidence/source-provenance.json`](evidence/source-provenance.json).

The installed source does expose enough public QML machinery for a narrow candidate patch under an explicit trusted same-user source model: reusable manifest validation, asynchronous `Process`, Loader lifecycle callbacks, property injection, and destruction signals. The candidate must remain separate from normal plugin discovery and persistence.

## Setup

- Repository: `/home/woodshape/claude/omarchestra`
- Initial branch: `prototype/live-agent-console-gate`
- Initial HEAD: `ce8f4e381c84596cab3da79900d74852141c0637`
- Initial `git status --short`: empty
- Installed package: Omarchy `4.0.2-1`
- Installed package: Quickshell `0.3.1-1`
- `/usr/share/omarchy/version`: `4.0.0.alpha`, recorded as a discrepancy rather than package authority
- Installed Omarchy tree: no local Git metadata
- Network lookup: none
- Installed and user files modified during inspection: none
- Live shell, UI, IPC, provider, terminal, remote, and service actions during inspection: none

The package metadata supplies an upstream URL but no exact upstream commit. Any patch produced here is therefore a **candidate patch against Omarchy 4.0.2-1**, never an upstream-ready patch.

## Success criteria

The spike is complete only when fake-observed evidence covers:

1. a versioned, read-only capability query with no registry/config mutation;
2. valid panel registration and fail-closed malformed, non-panel, escaped, symlinked, non-owned, oversized, duplicate, and collision cases;
3. register, summon, later update/call, hide, and exact unregister for only the addressed fake;
4. duplicate, stale, wrong, and pre-restart identity isolation;
5. zero calls to injected persistence mutators and byte-identical installed state;
6. candidate patch dry-run/application and QML lint only in a hash-verified scratch baseline;
7. exact scratch cleanup on success, failure, and interruption while unrelated fakes survive;
8. a command-graph audit excluding live shell IPC, GUI, user config, providers, remotes, process supervision, and service managers.

Each seam must have intended red evidence before implementation and final green evidence afterward.

## Design twice

### Alternative A: extend the existing `shell` IPC target with lifecycle methods

Conceptual surface:

```text
shell temporaryPanelCapabilities
shell registerTemporaryPanel path
shell summonTemporaryPanel registration payload
shell callTemporaryPanel registration method payload
shell hideTemporaryPanel registration
shell unregisterTemporaryPanel registration
```

Advantages:

- minimal caller discovery because the `shell` target already exists;
- direct similarity to current summon, call, and hide methods.

Rejected costs:

- six or more shallow methods duplicate parsing, version checks, typed errors, and bounds;
- asynchronous registration does not fit a method that appears to return a registration immediately;
- lifecycle policy is split between the ID-keyed normal host and handle-keyed temporary state;
- callers may incorrectly mix plugin IDs with opaque registration identities;
- cleanup and capability evolution are harder to review as one module contract.

### Alternative B: one deep temporary-panel host and one JSON request method

Selected surface:

```text
target: temporary-panel
request(versionedJson) -> versionedJson
```

Operations are `capabilities`, `register`, `status`, `summon`, `call`, `hide`, `unregister`, and `inspect`.

Advantages:

- one parser owns versioning, input bounds, response envelopes, and typed errors;
- asynchronous registration is explicit: `register` returns an operation identity and `status` later returns lifecycle authority;
- all temporary maps, queues, loaders, generation checks, tombstones, and cleanup live in one deep module;
- normal `installedPlugins`, ID-keyed panel maps, and configuration writers remain untouched;
- string-only Quickshell IPC carries one bounded JSON argument and response;
- a caller can query support before creating any other resource.

Costs:

- the candidate adds one IPC target and a dedicated QML host;
- callers must poll bounded registration and teardown state;
- filesystem validation needs an asynchronous fixed helper process.

**Selection: Alternative B.** It has greater depth, better locality, an honest fit with synchronous IPC plus asynchronous filesystem inspection, and safer exact-identity cleanup.

## Selected contract

[`contracts/temporary-panel-v1.md`](contracts/temporary-panel-v1.md) defines `omarchy.temporary-panel/v1`.

Core properties:

- only manifests with exactly `kinds: ["panel"]` and one panel entry point are accepted;
- registration is process-memory-only and never becomes installed enablement;
- lifecycle operations require a server-generated opaque registration identity;
- source paths must be absolute, canonical, existing, user-owned, non-symlink, and bounded;
- the installed manifest validator and entry-point URL logic are reused and strengthened with filesystem checks;
- first-party, installed third-party, temporary ID, and canonical-source collisions fail closed;
- later committed projection values use `call`, not the initial summon payload;
- hide unloads the temporary object but retains registration authority;
- unregister clears queues and destroys exactly the addressed Loader and item before reporting terminal completion;
- duplicate hide and unregister have explicit idempotent results;
- shell restart creates an empty registry and old identities do not revive;
- errors remain inspectable and never remove cleanup authority.

## Red to green evidence

The intended red run contained 61 tests: 4 negative source-audit assertions passed and 57 substantive tests failed because the fake model, candidate patch, verifier, and integration recipe did not exist. The original red captures remain unchanged.

The initial fake model and cleanup lane reached 52/52 green. Two review passes then identified concrete queue, callback invalidation, revalidation, teardown-claim, tombstone, and exact-cleanup gaps. Eight focused regression tests were added across those passes while correcting the findings. The final unattended recipe now passes 69/69 tests, including all six source-audit checks and five candidate-patch checks.

The tests observe capability, registration, lifecycle, identity/restart, persistence isolation, and failure cleanup through the selected JSON interface and injected ports. Candidate checks prove source guards, exact-baseline scratch application, touched-file scope, and lint. They do not execute candidate QML.

Exact commands, counts, historical test corrections, patch markers, and final results are recorded in [`evidence/red-green-ledger.md`](evidence/red-green-ledger.md) and [`evidence/final-validation.txt`](evidence/final-validation.txt).

## Candidate patch

[`upstream/omarchy-4.0.2-1-temporary-panel-v1.patch`](upstream/omarchy-4.0.2-1-temporary-panel-v1.patch) is a review artifact against the exact installed baseline. It touches only:

- `shell/services/TemporaryPanelHost.qml`: new validation state machine, fixed asynchronous filesystem verifier, handle-keyed records and FIFO queues, separate Loader host, typed JSON dispatcher, collision rechecks, and exact teardown;
- `shell.qml`: temporary-host construction and plugin-reload teardown wiring;
- `shell/README.md`: public interface, process-memory, panel-only, and same-user threat documentation.

No scanner, `PluginRegistry.qml`, normal ID-keyed panel host, service host, bar host, installed file, or user configuration is modified. The new deep module calls the installed `PluginRegistry.validateManifest()` and `entryPointUrl()` seams rather than adding a weaker manifest schema.

The verifier hash-checks all recorded provenance, copies `/usr/share/omarchy` to an exact `mktemp` tree, dry-runs and applies the patch there, enforces the three-path allowlist, runs bounded lint, checks installed hashes again, and removes its exact scratch state under success and signal traps. It also proves an unrelated scratch sentinel survives until its own exact cleanup.

Independent review corrections in the current patch:

- Loader creation and source assignment occur only after summon-time filesystem validation succeeds and the manifest bytes still match the registered snapshot;
- registration creates no Loader delegate;
- the fixed validation process checks its work serial, and every Loader callback checks registration identity plus a captured generation;
- failed source revalidation, installed collisions, and unregister retain source and plugin-ID claims until exact unregister teardown completes;
- the 32-entry queue limit counts the combined open/call FIFO, including multiple summons;
- hide invalidates late loader callbacks, and non-unregister operations reject tombstoned identities;
- each candidate host generates a fresh process-local nonce instead of treating Quickshell's stable instance name as restart identity;
- scratch cleanup captures and revalidates directory device/inode, type, and symlink-safe path identity before recursive removal;
- filesystem helper exit statuses preserve the contract's typed path, ownership, symlink, permission, manifest-size, and entry-point errors;
- the capability identifier is the normative `omarchy.temporary-panel/v1`.

Current patch evidence:

- baseline hashes, copy, dry-run, apply, allowlist, forced cleanup, installed-source isolation, and residue checks pass;
- `/usr/lib/qt6/bin/qmllint` 6.11.2 passes both modified QML files. The earlier status 255 came from the unrelated Qt 5 `qmllint` 1.0 found first on `PATH`; the verifier now requires the Qt 6 tool and cannot treat a lint failure as a skip;
- the patch-source regression audit covers entry-point and manifest-content validation-before-load, no registration-time Loader delegates, combined queue bounds, fresh host identity, callback identity/generation checks, typed validation mappings, terminal claim release, and exact verifier cleanup identity.

The patch has never been applied to `/usr/share/omarchy` and is not installed support. Static patch checks and lint do not prove QML runtime behavior.

## Threat and lifecycle boundary

Omarchy documents plugins as unsandboxed code. Registering a panel means trusting the selected source with the shell user's authority. The candidate narrows accidental and cross-registration damage through ownership checks, non-symlink canonical paths, bounded inputs, exact handles, generation checks, collision rejection, and exact unload.

It cannot eliminate a malicious same-UID path replacement race. QML Loader consumes a URL and cannot retain a previously validated file descriptor. The host must revalidate immediately before load, but the candidate remains supported only for a trusted, quiescent, user-owned repository source. A race-free adversarial same-user contract would require a native descriptor-based loader or immutable snapshot and would block this candidate.

Temporary state dies with the shell process. This is intentional. It is not durable state, is never reconstructed from disk, and does not own any runner, agent, terminal, provider, or remote resource.

## Final evidence

| Evidence | State |
| --- | --- |
| Required documents and installed sources read completely | complete |
| Installed versions and 22-entry SHA-256 manifest | complete; all 22 hashes rechecked after validation |
| Capability matrix with exact installed lines | complete |
| Design comparison and selected contract | complete |
| Intended red interface tests | complete: 61 tests, 4 pass, 57 intended fail |
| Initial fake model and cleanup lane | complete: 52/52 green |
| Final recipe after review corrections | complete: 69/69 green |
| Candidate patch scratch dry-run/application | complete under exact baseline hashes |
| Qt 6 lint for both modified QML files | pass |
| Existing prototype regression recipes | all three pass |
| Source, syntax, module, secret, and whitespace checks | pass |
| Installed and user configuration isolation | pass; 22 hashes match and `shell.json` is byte-identical |
| Scratch and process residue | clean; all recorded counts zero |
| Human/live validation | deliberately not run; retired with this path |

Full commands and exact exits are in [`evidence/final-validation.txt`](evidence/final-validation.txt). The earlier [`evidence/residue.txt`](evidence/residue.txt) contains a failed historical path lookup and is not used as successful evidence; final validation performs the corrected before/after user-configuration comparison.

The original later-human procedure is retained as a cancelled historical plan: [`later-human-validation.md`](later-human-validation.md). Its upstream entry conditions are no longer product work.

## Verdict and limitations

**Locally proven, fake-only:** the versioned interface model covers bounded capability discovery, asynchronous registration, panel-only validation, collision rejection, summon, later call/update, hide, exact unregister, idempotence, stale/wrong/restart identity isolation, persistence isolation, failure observability, and exact fake cleanup. These tests do not execute QML or contact a shell.

**Locally proven, candidate-only:** the patch applies to a scratch copy whose source hashes match installed Omarchy 4.0.2-1. Its touched-file allowlist, new-host QML lint, forced cleanup, installed-hash preservation, and zero scratch residue pass. Patch application does not establish live behavior or semantic conformance by itself.

**Upstream-unproven:** local package metadata names an upstream URL but contains no exact Git commit, and `/usr/share/omarchy` has no Git metadata. The artifact is a candidate patch against 4.0.2-1, not upstream-ready.

**Installed-unsupported:** the installed shell still has no `temporary-panel` target. Nothing in this run edits or reloads it. A repository patch is not a public installed capability.

**Human-not-run:** no live shell, Agent Console, Pi, terminal, provider, Hyprland action, Boomux, SSH, systemd unit, or human gate was launched. This candidate will not receive live product validation; live projection agreement instead depends on the Companion Plugin gate.

Open candidate limitations:

- a malicious same-UID process can race URL-based QML loading despite immediate revalidation;
- candidate pre-load comparison uses exact manifest bytes, while the fake compares validated JSON; whitespace-only changes therefore fail closed only in the candidate;
- the fake model does not execute QML, and patch-source checks plus `qmllint` do not prove runtime Loader behavior;
- exact upstream provenance, review, and acceptance remain unproven;
- no installed capability or live Agent Console behavior has been tested.

## Design impact and disposition

This spike exposed the unnecessary assumption that plugin lifecycle had to equal Team Goal lifecycle. Omarchestra now follows the installed Boomux companion-plugin model: explicit setup owns durable plugin assets and enablement, while Projection Sessions are ephemeral.

Retain the contract, fake model, automated evidence, candidate patch, and security findings as rejected-path review artifacts. Do not promote fake code into production, install the patch, or submit it upstream. The candidate remains truthful only against the inspected Omarchy 4.0.2-1 baseline.

## Next step

Prototype fake-only setup, compatibility verification, update, rollback, and exact uninstall for a versioned Omarchestra Companion Plugin using the supported third-party plugin path. Then adapt the existing projection core to open, reconnect, hide, and clear ephemeral Projection Sessions without changing Omarchy installation state during a Team Goal. The replacement live gate remains explicitly human-authorized.
