# S3 checkpoint — configured check resolution

Status: **S3 engineering checkpoint PASS (Project context + C14 definition configuration); Phase 2 remains BLOCKED.** Direct implementation and source self-review with disposable/offscreen evidence; not independent review, live Pi/desktop acceptance or executable gate evidence.

## Scope and authority

- `runner/check-definition.ts` rejects unknown/partial drafts using the closed C14 validator; the runner, not QML or the caller, resolves the absolute executable to a regular executable file, canonical Project-root cwd and up to 63 declared regular Project resources. Resources reject symlink traversal, duplicates, escaped paths, missing/unreadable/nonregular files and per-file or aggregate 64 MiB overflow. An executable outside the Project can be selected by absolute path; the stored digest pins its resolved target. The scanner reads bounded bytes without invoking any executable, shell, validator, Pi or provider. It checks observed file identity/size/timestamps during hashing, then rereads files once to detect observed changes during resolution. This is not a lock against same-UID adversarial replacement.
- Constructed environment draft rejects reserved ambient/harness variables and secret-shaped names. It cannot attest that arbitrary operator-supplied values are nonsecret. The existing C8 bounds on argv, environment, timeout/output and correction/elapsed limits are enforced by the closed draft validator. Command summary is display-only; semantic claim distinguishes zero exit from semantic review. No dynamic dependency discovery or filesystem isolation is claimed.
- `create_check`/`configure_checks` persist full canonical definition bytes and their SHA-256 digest under `(projectId,checkId,version)`. `check_definitions` rows are immutable; an edit creates a new version. A saved definition can be parsed/verified without looking up caller hashes; `verifyCheckResources` explicitly rehashes pinned resources for future start review, but Phase 2 does not start work or run a check. Resource drift never silently changes an old version.
- At this S3 checkpoint schema **8** changed the meaning of stored check JSON while preserving the SQL table layout. The later [S5 checkpoint](framed-adoption-checkpoint.md) advances the current schema to **9** for pending Adoption proposals; neither older root upgrades automatically. Schema-7 development roots **fail closed**, including roots containing previous unchecked drafts. There is no automatic migration/restore or silent reinterpretation. The owner must retain such a root with its matching version until an explicit supported upgrade exists. Project directory identity remains the schema-7 `repo-v1` meaning, distinct from C9 candidate content fingerprints.
- The actual offscreen QML → adapter → runner → SQLite path now covers create and versioned edit with a changed on-disk config, producing distinct runner-calculated hashes. The UI and adapter require cwd to equal the selected Project root. This is not proof of native installed Companion negotiation or full check-detail delivery.

## Evidence

Bounded foreground commands on Node 26.8.1, using disposable roots:

```sh
timeout --signal=TERM --kill-after=5s 110s node --experimental-strip-types --test \
  packages/local-workbench-v1/test/*.test.ts packages/local-workbench-v1/test/*.test.mjs
just --no-dotenv local-workbench-v1-check
just --no-dotenv local-workbench-v1-phase-2-check
```

The final full package suite reported **341 tests: 336 pass, 5 existing runtime TODOs, zero failures** after the UI/adapter adjustment; the final Phase 2 run exercised the same tree and passed its implemented subset (foundation 41/41, management 165/165, presentation 83 pass/5 TODO, audits 38/38, Qt offscreen 18 rows). Phase 1 gate passed including static QML lint with pre-existing namespace-metadata warnings. The *full* Phase 2 recipe exited **1/BLOCKED by design** because the real bridge, challenged management and native entry remain incomplete. No install, live Project, Pi/provider execution, check execution, Assignment delivery, or prototype/spike modification occurred. These are host-executed tests and self-review, not a second independent acceptance verdict.

Failures pinned in `test/phase-2-check-resources.test.ts`: missing/escaped/duplicate/symlink/nonregular/oversized resources, missing/nonexecutable executable, wrong cwd, reserved/secret-shaped environment, extra caller digest and missing fields. Tests cover zero execution, immutable versions, same-intent rejection/replay, persisted digest validation, old schema refusal and resource drift. `phase-2-composed.test.ts` exercises real QML create/edit and runner-owned v1/v2 resource digests. The phase gate now runs the new tests and still ends BLOCKED; it was not turned green by changing the banner.

## Remaining boundary

S3 save-time resource resolution is not the C7/C9 execution gate: at Phase 3 start, confirm an exact current Project/Goal/Run and candidate, verify canonical stored bytes, rehash executable/resources immediately before and after execution, establish declared dependency closure, and reject drift. No arbitrary script dependencies are inferred from argv, nor is a runtime sandbox claimed. Before phase-3 gate execution, exercise the C7/C9 all-file candidate fingerprint and validator resource closure against real build/test tools; ignored outputs and indirect dependencies may block otherwise ordinary commands. Phase 2 still requires S4 real bridge, S5 challenged exact Adoption/recovery and S6 native owner/client composition, plus independent verification before an operator walkthrough.
