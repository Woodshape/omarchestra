# Live Adoption engineering completion evidence

**PROTOTYPE — NOT PRODUCTION. No installation or live Adoption validation.**

Baseline: `7d7a314` after checkpoint `add63d8`.

## Red-to-green observations

- New executable launcher-function tests initially reported **1 pass / 6 fail**:
  the verdict matrix had no implementing function, and an unrelated manifest
  path with a matching inode was deleted. Implemented explicit verdict rules
  and exact manifest-path restrictions, then changed launcher DB cleanup to
  absence verification so it cannot race a resumed writer.
- The real manual extension/SQLite composition now exercises both successful
  committed delivery and deliberately dropped committed delivery, followed by
  fresh-transport recovery and readiness. Its first disconnect run exposed
  non-idempotent fake duplex destruction; the fake was corrected to match
  Node's idempotent stream destruction semantics.
- Interactive input uses a throwing `text` getter in the fake Pi host. The
  actual manual hook reads only `source`, continues input, persists takeover,
  and receives committed control presentation. Takeover survives another
  SQLite open and another challenged reconnect without restoring readiness.
  The final four composed variants also cover input during gateway loss, with
  and without committed-frame delivery. A pending source-only takeover is
  reconciled before readiness; ordinary pre-proposal input remains untouched.
- Actual packaged QML methods execute in an isolated JS context. Complete
  0.4.0 packaged QML passes qmllint. Complete historical 0.2.0/0.3.0 release
  objects were compared against `7d7a314` and match exactly.
- Filesystem fixtures verify replacement/symlink/sidecar refusal, initial
  owner-only file creation, duplicate active ownership-lock refusal, and exact
  recovery after lock release. No live socket or desktop is used.

## Final executable gates

Commands used `QMLLINT_BIN=/usr/lib/qt6/bin/qmllint` where applicable.

| Command | Result |
| --- | --- |
| `just prototype-live-adoption-check` | 78/78; entrypoint and launcher --check PASS |
| `just prototype-live-observer-check` | 69/69 |
| `just prototype-observer-adoption-check` | 137/137; integrated verdict PASS |
| `just prototype-companion-check` | 87/87; integrated verdict PASS |
| `just prototype-live-agent-console-check` | 78/78 |
| `just prototype-vertical-slice-manual-check` | 6/6 |
| `just prototype-vertical-slice` | default/WAL scenarios PASS |
| `git diff --check` | PASS |

Pi 0.85.1 extension documentation and its status-line example were inspected;
executable Pi coverage uses the fake host, not a live compatibility claim.

The vertical-slice gate's nondeterministic generated output was restored to its
checkpoint version. No private live evidence was copied into Git.

## Independent review

A separate read-only LUNA context (`openai-codex/gpt-5.6-luna`) returned
**PASS — bounded engineering readiness**, specifically covering creation-time
ownership, exclusive-lock resume, socket identity, SIGKILL preservation,
machine acceptance facts, busy interactive takeover, same-Pi-only recovery,
and no Assignment/Return-to-team expansion. Review did not run tests or live
integrations. Local trace: `/tmp/adoption-luna-final-review.jsonl`.

A previous completed review identified recovery/verdict gaps; those were fixed.
Its requests for Pi-process-crash recovery and an idle prerequisite for takeover
were rejected against the authoritative locked scope. An earlier review attempt
timed out without producing a report; it provides no acceptance evidence.

The hard-coded incomplete guards were removed after review. Human execution
still requires an interactive TTY, exact authorization, separately installed
Companion 0.4.0, machine facts, exact cleanup, and operator UI attestation.
No live success is claimed by this engineering evidence.
