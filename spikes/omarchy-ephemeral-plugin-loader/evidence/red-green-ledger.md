# Red to green evidence ledger

Status: **final fake-only recipe green; candidate patch verified in scratch**

All automated behavior uses injected fakes or hash-verified scratch copies. No evidence in this ledger comes from live shell IPC or UI execution.

## Intended red

Command:

```text
cd /home/woodshape/claude/omarchestra/spikes/omarchy-ephemeral-plugin-loader
node --test test/
```

Captured result: exit 1, 61 tests, 4 pass, 57 intended failures.

Evidence:

- [`red/README.md`](red/README.md)
- [`red/all-seams-red.txt`](red/all-seams-red.txt)

Failure ownership:

| Missing behavior | Intended failures | Reason |
| --- | ---: | --- |
| Fake public model, adapter, and exact cleanup | 52 | `lib/index.mjs` did not exist |
| Candidate patch and scratch verifier | 3 | patch and verifier did not exist |
| Fake-only just recipe | 2 | integration recipe did not exist |
| Negative source-audit assertions | 0 | 4 assertions correctly passed while implementation files were absent |

Every substantive seam was red. There were no file-level test discovery failures.

## Implemented green lanes

### Fake model and cleanup

Command recorded by the lane runner:

```text
node --test test/link-check.test.mjs test/s1-capability.test.mjs test/s2-registration.test.mjs test/s3-lifecycle.test.mjs test/s4-identity-restart.test.mjs test/s5-persistence-isolation.test.mjs test/s7-failure-cleanup.test.mjs
```

Result: exit 0, 52 tests, 52 pass, 0 fail.

Evidence: [`green/model-and-cleanup.txt`](green/model-and-cleanup.txt)

### Candidate patch

Commands:

```text
bash scripts/verify-candidate-patch.sh
node --test test/s6-patch-verification.test.mjs
```

Result: verifier exit 0 and seam 6 has 3 tests, 3 pass, 0 fail.

Verified markers:

```text
baseline-verified
copy-ok
dry-run-ok
allowlist-ok
apply-ok
forced-cleanup-ok
installed-unchanged
cleanup-ok
residue-clean
```

Evidence: [`green/patch-audit.txt`](green/patch-audit.txt)

The allowlist contains only:

- `shell/services/TemporaryPanelHost.qml`, new deep module;
- `shell/shell.qml`, host construction and reload teardown wiring;
- `shell/README.md`, public interface and threat-boundary documentation.

The final verifier requires `/usr/lib/qt6/bin/qmllint` 6.11.2 and both modified QML files pass. The earlier status 255 came from Qt 5 `qmllint` 1.0 at `/usr/bin/qmllint`, not from the Qt 6 tool used by Omarchy. A nonzero lint result can no longer be accepted as a skip.

## Seam ledger

| Seam | Intended red | Current result | Evidence and observation |
| --- | ---: | --- | --- |
| S1 Capability | 3 | 3 pass | Versioned support response, no config/filesystem/Loader mutation, no capacity consumption |
| S2 Registration | 17 | 17 pass | Valid async registration plus path, ownership, permission, symlink, manifest, scope, escape, collision, scan, duplicate, capacity, envelope, and partial-state rejection cases |
| S3 Lifecycle | 14 original plus 5 review regressions | 19 pass | Summon, full pre-load revalidation, FIFO open/call delivery, multiple-open combined bounds, stale-callback invalidation, retained failure claims, tombstone rejection, method errors, hide/resummon, exact unregister, queue clearing, load failure, sibling safety |
| S4 Identity/restart | 7 | 7 pass | Malformed, unknown, operation-only, sibling, stale, pre-restart, and status-smuggling cases |
| S5 Persistence isolation | 5 | 5 pass | Zero config writers, no installed-registry leak, rejection isolation, later rescan collision isolation |
| S6 Patch | 3 original plus 2 review regressions | 5 pass | Hash check, scratch copy, dry-run/apply, allowlist, manifest-snapshot and lifecycle guards, Qt 6 lint for both modified QML files, exact verifier cleanup identity |
| S7 Failure cleanup | 5 original plus 1 review regression | 6 pass | Forced failure, unrelated survival, refused-path replacement safety, symlink/type/identity revalidation, real scratch deletion, composition with host failure |
| S8 Source audit | 2 substantive red plus 4 initial passes | 6 pass | Fake-only recipe exists, stays free of live paths, and no human/live recipe exists |
| Link check | 1 | 1 pass | Frozen exports link successfully |

Final suite after two independent-review correction passes: 69 tests, 69 pass, 0 fail. Eight added tests strengthen the lifecycle, patch, and cleanup seams; the original 61-test red capture remains unchanged. The second review's authentic failing capture is retained at [`red/review-findings-red.txt`](red/review-findings-red.txt).

## Red-evidence integrity

Three test corrections were made while implementing the fake lane:

1. S4 changed a sibling expectation from `summoned` to `loading` because that fake Loader had not resolved.
2. S5 added a missing assertion-helper import and corrected the fake Loader index so the test checks that the non-colliding sibling survives.
3. S7 uses the fake filesystem's actual node-deletion API.

These repair erroneous expectation or fixture plumbing. They do not relax the public contract or remove a rejection, identity, persistence, or cleanup assertion. The final test sources are not byte-identical to the red capture, so this fact is retained with the evidence rather than hidden.

## Independent-review corrections

The candidate interface identifier is corrected to `omarchy.temporary-panel/v1`. The first review corrected validation-before-load, callback identity/generation checks, teardown claim retention, combined FIFO bounds, registration-time Loader creation, full fake pre-load revalidation, and typed candidate validation errors. The second review corrected multiple-summon bounds, hide-time callback invalidation, retained failed-record claims, tombstone consistency, candidate manifest-snapshot comparison, exact scratch cleanup authorization, and fresh per-host nonce generation. Candidate load mode performs entry-point checks before emitting and comparing the exact manifest-byte snapshot; this is deliberately stricter than the fake's validated-JSON comparison for whitespace-only edits. Focused regression checks cover these changes. [`final-validation.txt`](final-validation.txt) records the mapping and final commands.

These checks establish fake behavior and candidate source structure only. They do not execute the candidate QML or establish installed support.

## Residue expectations

Every final run must prove:

- no `/tmp/omarchy-ephemeral-verifier-*` directory remains;
- no `/tmp/omarchy-ephemeral-unrelated-*` directory remains;
- unrelated scratch sentinels survive until their exact owner removes them;
- installed source and package hashes still match `source-provenance.json`;
- no repository socket, PID file, copied installed tree, or user-config staging appears;
- final Git status equals the initially clean tree plus only intended spike, justfile, spike-index, and blocker-pointer changes;
- no background or live integration process was launched.

Final validation reports zero owned scratch directories and processes, all 22 provenance hashes unchanged, and byte-identical user `shell.json`. The earlier `residue.txt` path error is retained as failed historical evidence; the corrected successful check is in [`final-validation.txt`](final-validation.txt).

## Final transition

The fake-only and scratch-only work is complete. The later architecture decision retains this ledger as rejected-path evidence: the candidate will not be submitted, installed, or human-validated. Product work continues with persistent Companion Plugin setup and ephemeral Projection Sessions.
