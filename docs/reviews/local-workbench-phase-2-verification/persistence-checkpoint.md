# Direct implementation checkpoint — exact owned resources

Historical checkpoint status: **First persistence repair checkpoint implemented and tested; S1 was incomplete at this checkpoint.** The subsequent [binding/fence checkpoint](binding-fence-checkpoint.md) completes the S1 durable-substrate gate. Phase 2 management remains blocked.

The user authorized direct implementation of the completion sequence. This checkpoint addresses concrete F6/F11/persisted-F12 failure paths before changing bridge or execution code. Existing Fusion work is preserved.

## Shipped

- New `runner/owned-resources.ts`: durable, exclusive-created `ownership.json` records device/inode/UID/type for the manifest, lifetime lock, store, fence ledger and state/runtime parent chain. Existing roots require this receipt before SQLite opens; missing locks cannot be recreated next to retained history. Same-content resource/root replacement is refused. Active store and ledger method calls revalidate identity and receipt/manifest bytes. Closing still releases resources after drift.
- Exact SQLite sidecar names replace the suffix-wide allowance. Owner database mode is set before journal creation, not afterward. Manifest and receipt writes flush content and parent directory; interrupted manifest/temp evidence is preserved instead of deleted by filename.
- Store and ledger startup compare SQLite's schema objects against the supported DDL, including constraints/indexes/triggers. Store integrity and foreign keys are checked. Persisted integer columns and epoch/revision metadata reject unsafe numeric values; epoch/generation exhaustion refuses reuse.
- New `runner/backup-inventory.ts`: backup deletion requires recorded exact file identities and hashes. Creation and verification open the copied SQLite database read-only for schema/integrity checks. Metadata is closed and bounded, paths are basenames only, and unrecorded/damaged inventory fails closed. Rotation never intentionally deletes unknown or damaged evidence. An interrupted inventory operation can leave preserved files and requires explicit recovery; it is not silently repaired or described as a portable restore.
- `phase-2-owned-resources.test.ts` adds eleven regression cases. Existing backup tests now prove damaged evidence prevents further rotation, rather than permitting deletion of damaged backups.
- Phase 2 includes the new tests and bounds every Node invocation with a test-process timeout. The overall BLOCKED result is preserved.
- `AGENTS.md` records the bounded-delegation, actual-integration, reviewer-provenance and subprocess-cleanup lessons for future runs.

## Validation

Initial new ownership tests failed against the Fusion implementation (`/tmp/p2-owned-red.log`). After repairs:

- Ownership + existing foundation + integration safety tests pass (`/tmp/p2-owned-green.log`).
- Full package tests under disposable `env -i` pass, retaining the existing five deferred runtime TODOs (`/tmp/p2-checkpoint-all.log`).
- `just --no-dotenv local-workbench-v1-check` passes (`/tmp/p2-checkpoint-phase1.log`).
- Full Phase 2 runs its passing implemented subset and deliberately returns **exit 1, BLOCKED** (`/tmp/p2-checkpoint-gate.log`).
- `git diff --check` passes. No runtime installation or live Pi/desktop use, no real Project mutation, no commit/push.

The original negative reproducer/recorded output describes the pre-repair tree. Its defect expectations intentionally cease matching as these fixes land; it is not a release gate. Corresponding fail-closed expectations now live in package tests.

## Evidence limits and next work

Do not mark all of F6/F11/F12 or S1 closed from this checkpoint. Remaining S1 work includes the Goal-qualified exact-incarnation binding/fence schema, cross-ledger retirement/purge operation recovery, and additional bootstrap/interruption coverage. Backup/ownership receipts are local root identity evidence, not portable restore authorization or protection against an attacker who can rewrite all same-user ownership evidence. Unsupported older roots without exact receipts are refused; there is no automatic migration/adoption of those roots. Current development tests use disposable fresh roots.

The next direct implementation step is the remaining S1 identity and recoverable fence-operation substrate, then S2 transactional command outcomes/source lifecycle. No schema shortcut, fake bridge or optimistic native-open record is accepted as completion of later slices.
