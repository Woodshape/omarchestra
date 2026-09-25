---
status: accepted
---

# Use Git history for Companion release source

The earlier packaging contract kept byte-for-byte copies of Companion 0.6.0 and 0.7.0 under `companion/retained/`. Later release work extended that pattern to additional installed versions and added per-version archive assertions. The operator rejected maintaining those duplicate asset trees: this repository already versions the source, and no engineering requirement justifies keeping each published bundle alongside it.

## Decision

- Keep Companion source directly in `packages/local-workbench-v1/console/plugin/`. The active version remains ordinary release metadata in the manifest and package constants; the active source does not live under a version-named directory.
- Do not keep any asset snapshots under `packages/local-workbench-v1/companion/retained/` or an equivalent historical-version directory in the active package. Remove the current `retained/` tree.
- Use Git commit history as the authoritative record for historical source and versioned manifests. Historical assets are inspected or reconstructed from their Git revision, not copied forward into the current source tree.
- Keep the production release catalog limited to the current release. Continue testing that current packaged assets match current source and that install/update/rollback failure semantics are correct. Use generated test fixtures and receipt/plan evidence rather than archived historical asset bundles.
- Keep exact filesystem/configuration ownership, authorization, receipt, and rollback checks unchanged. This source-history decision does not change existing release-version semantics or loaded-version negotiation.

This supersedes only the old 0.6.0/0.7.0 and subsequent copied-bundle retention practice. It does not alter capability negotiation, the Companion identity, or the separate historical prototype catalog under `prototypes/`.

## Consequences

- The active package has no `retained/` directory and no duplicate current-release folder.
- Historical release source remains available through Git history.
- Per-version hash tests for copied historical trees are replaced by current source/package parity checks and behavior-focused installer tests.
- Completed one-off recovery tooling must rely on its exact private receipt/plan evidence rather than checked-in historical source copies.
