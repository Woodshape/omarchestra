# Independent Phase 2 verification

Status: **S1–S6 disposable engineering gate PASS; bounded independent integration review completed without remaining blocking findings; overall Phase 2 incomplete: the authorized [live setup/native-open walkthrough](live-setup-and-open.md) now passes through a stable visible dock. One live Project and Goal are registered; confirmed Pi Adoption remains pending. The [same-button confirmation correction](same-button-confirmation.md) is installed as 0.11.0 and command-path/native-open proven; a physical two-press click on a real observed Pi and live Adoption remain untested. The original [read-only host compatibility preflight](human-walkthrough-preflight.md) is historical; [ADR 0005](../../adr/0005-negotiate-companion-features-not-host-package-versions.md) replaced fixed-version gating.** The independent source review and negative reproductions below concern the **original Fusion-delivered tree**, not the later repairs. They are not a full security audit or live acceptance.

The findings/reproductions below characterize the original Fusion-delivered tree. Later direct repairs are recorded separately in the [completion plan](../../plans/local-workbench-v1-phase-2-completion.md), including the passing S1 substrate, S2 command/source, S3 Project-context/check-resource, [S4 real bridge](real-pi-bridge-checkpoint.md), [S5 framed Adoption](framed-adoption-checkpoint.md) and [S6 native owner/composition](native-owner-composition-checkpoint.md) engineering checkpoints. The original table below is a **historical** defect inventory: do not treat its pre-repair F2–F5/F8 descriptions as current implementation facts. The later [independent integration review](independent-integration-review.md) inspects the S6 paths and their S1–S5 dependencies read-only; the host checkpoints and this historical defect reproducer are not substitutes for that review or a live acceptance gate.

## Subsequent session-usability work

The operator-approved [three-slice sequence](../../plans/workbench-session-usability.md)
now has development-only eligibility explanations and a [shared dock/Pi session
code checkpoint](session-code-checkpoint.md). These direct changes have disposable
host verification, not independent review, installed-release or physical-matching
acceptance. Exact terminal focus remains the next slice.

## Evidence

- Reviewed the current `packages/local-workbench-v1/runner/` composition, authority, Adoption, transport, host, entry, paths, backup, Git-context, schema and projection implementations, plus relevant adapter and acceptance-test paths.
- At the time of this original review, ran `timeout 60s just --no-dotenv local-workbench-v1-phase-2-check`: **exit 1, BLOCKED**. Log: `/tmp/phase2-independent-verification.log`. The subsequent S6 gate exits **0**; see the S6 checkpoint. The historical diagnostic is not a current gate.
- Nine negative characterizations reproduced against the real runner modules in disposable roots. [Source](reproduce.mjs), [recorded output](reproduced.txt). Exit 0 from this diagnostic means the defects reproduced; it is **not a green engineering gate**. Convert these to fail-closed regression expectations during repair.
- Existing `prototypes/` and `spikes/` remain unchanged. No runtime source was modified during verification. No installed desktop/Pi, user state, live project or provider was used.

Reproduce from the repository root:

```sh
scratch=$(mktemp -d /tmp/p2-review-env.XXXXXX)
node_bin=$(command -v node)
env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$scratch" TMPDIR="$scratch" \
  timeout 60s "$node_bin" --experimental-strip-types \
  docs/reviews/local-workbench-phase-2-verification/reproduce.mjs
result=$?
rm -rf -- "$scratch"
exit "$result"
```

The lock-substitution diagnostic unlinks **only its own disposable owner database** while holding the first connection, then demonstrates that a second runner opens. It does not affect a live workbench. Other cases inject Git facts, observer events or a store outcome-write failure. The original and replacement incarnation protocols do not exist here, so these object-event tests must not be mistaken for bridge acceptance.

## Disposition of existing findings

Finding IDs follow ASTRA's Fusion authority reviews; the final integration result already superseded some earlier examples.

| ID | Independently verified current disposition | Evidence / exact remaining work |
| --- | --- | --- |
| F1 | Open | `transport.ts` provides encode/decode and an object callback port, not an implemented visible Pi extension or connected framed transport. `main.ts:startForeground` supplies no observer transport. No process/session/extension tuple, connection challenge or sequence validation reaches this path. |
| F2 | Partially fixed, core issue open | `adoption.ts:assertLive` checks Run-ID fences. `schema.ts` stores no Pi incarnation identity in a binding. Fresh observed/Run IDs are not a substitute for an exact retired-incarnation fence. |
| F3 | Partially fixed | Connected takeover retirement is now refused, and disconnected takeover is distinct. But bindings have no Goal ID; occupancy is Project+Role and counts uncommitted proposals. Reproduced an abandoned proposal blocking another ACK and leaving its failed competitor `disconnected`. `projection.ts` also lists managed bindings without Project/Goal filtering. |
| F4 | Open | Reproduced an ACK one tick after the proposal expires, carrying a wrong transport ID, still committing. `authorize` checks expiry once; pending ACK deadline is independent, and receipt handling never validates event transport identity/activity. `TransportEvent` does not even declare the nonce consumed by Adoption. |
| F5 | Partially fixed | Restart/disconnect now preserve manual takeover as disconnected. No challenge/proof recovery or surviving-extension offline-input reconciliation exists. `authority.ts:route` acknowledges `recover` (and `present`) without doing anything. |
| F6 | Open | Reproduced second simultaneous owner after deleting the disposable `owner.sqlite`. Startup requires store/fences but permits a missing owner database. Mode/name checks are not exact parent/resource identity or substitution detection; fencing must not split with resource replacement. |
| F7 | Open | Reproduced durable Goal creation after injected dedup-result failure, leaving no receipt, and acceptance with the wrong plugin generation. `route` commits before `record`; revision/cursor mutate before SQL commit returns. Retirement/purge bypass the authority event/revision transaction. |
| F8 | Partially fixed | Leaf checks and hidden purged cards exist. `runner.ts:purgeBinding` only marks the full row purged, then separately marks the ledger; it does not delete history down to minimal fences or prove interruption-safe completion. |
| F9 | Partially fixed, do not repeat repaired claims | Current Git uses fixed `/usr/bin/git`, constructed environment, no global/system config, fsmonitor disabled and optional locks disabled. Submodule and state-root overlap checks were added. Repository replacement at identical paths remains undetected. Additionally reproduced a failed `git status` being reported as supported/clean: exit status is ignored. |
| F10 | Open | Reproduced saving a malformed definition with nonexistent executable and extra authority field. `normalizeCheckFields` only checks name/mode and hashes caller draft JSON, not canonical resolved executable/resources. No check execution is necessary to fix this. |
| F11 | Partially fixed, do not repeat repaired collision claim | Existing backup targets and dangling metadata symlinks are now refused/preserved. But rotation deletes by filename pattern; verification follows paths, trusts metadata shape and never opens the backup to check SQLite integrity. Reproduced arbitrary non-SQLite bytes accepted with a matching hash/schema metadata. |
| F12 | Open | Reproduced nested arbitrary payload accepted by `decodeFrame`. Registry/proposal maps lack admission bounds; projections silently slice collections at 100. Store schema validation checks columns rather than full constraints; persisted numeric conversions lack safe-integer validation. |

## Additional presentation finding: F13

**Open; source-confirmed, not reproduced through installed QML.** In `host.ts`:

- `intentSink` calls `applyFeedback` before `source.publish`, permitting acknowledged status before its committed snapshot. `applyFeedback` does not require that the current snapshot reach `committedRevision`.
- `publish` suppresses unchanged snapshots. There is no periodic authoritative heartbeat here, while the adapter uses a two-second stale threshold. An idle connected runner therefore lacks the required freshness signal.
- The returned source channel's `send` ignores resnapshot/outcome queries, and its `close` leaves the handler registered until the separate source close. Required resynchronization and reconnect lifecycle are not implemented by this port.

The native entry gap compounds this: `start` emits stdio records, not an installed Companion open; `status`/`backup` acquire an owner and advance the epoch; EOF ends the runner. None is a normal presentation-only open/hide path. Fix this as part of a real lifecycle composition, not by weakening staleness or printing success.

## Conclusion

The original Fusion **BLOCKED** verdict was justified by this historical evidence. Later S1–S6 repairs now pass the fake-only engineering gate and the bounded independent integration review found no remaining blocking findings; the **now-authorized human walkthrough** resumed and verified setup and stable native open; management actions and exact confirmed Adoption must still be verified before claiming Phase-2 completion. See the [completion plan](../../plans/local-workbench-v1-phase-2-completion.md).
