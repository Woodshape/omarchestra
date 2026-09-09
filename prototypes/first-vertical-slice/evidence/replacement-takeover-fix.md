# Replacement takeover/recovery correction

PROTOTYPE — NOT PRODUCTION.

## Finding

Operator live validation exposed a replacement recorded as managed/disconnected
while its surviving Pi reappeared as Unassigned. Earlier assistant explanations
mistook previous-session terminal scrollback for another live process and were
incorrect. The operator reported entering `y` in the retirement checklist;
that checklist PASS is superseded for engineering acceptance by this finding.
Private evidence files were not changed. The focused live correction was
subsequently verified by the operator as recorded below; this does not convert
the earlier broad checklist verdict into a full acceptance claim.

Replacement commitments live in `retirement_replacements`, but takeover markers
referenced only `adopted_runs`. The first interactive takeover therefore failed
its SQLite foreign-key check and revoked the connection. Recovery lookup also
searched only original Adoption commitments, permitting replacement registration
as observed after reconnect. Replacement cards ignored durable takeover status.

## Correction

- The single runner resolves recovery bindings from both retained commitment
  families and rejects ordinary registration of either kind of managed binding.
- SQLite stores replacement takeover markers with a foreign key to replacement
  commitments; existing original takeover records remain unchanged.
- Replacement cards apply the same durable manual-control presentation.
- Terminal purge removes replacement takeover markers within its transaction.
- No Pi extension, QML, installed assets, live bridge, or private state changed.

## Reproduction and validation

Added composed fake-Pi/framed-gateway/SQLite regression in
`observer/test/live-adoption-composed.test.ts`. Before the fix it failed at
`isManualTakeover(replacement.agentRunId) === true` (actual false).

The regression starts from a retired predecessor fixture, performs normal
confirmed replacement Adoption through the same-Pi extension, submits
source-only interactive input, verifies footer/card takeover, reconnects through
an independently reopened SQLite store, checks no Unassigned resurrection or
Assignment dispatch, then retires/purges the replacement and checks marker
cleanup. Both delivered and lost committed-frame variants pass.

Commands:

```sh
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-live-adoption-check
QMLLINT_BIN=/usr/lib/qt6/bin/qmllint just prototype-retirement-replacement-check
git diff --check
```

Results (rerun before commit): 80/80 Adoption; 62/62 retirement/purge;
69/69 live-observer regression; diff check clean.

## Focused human validation

The operator confirmed restarting the bridge after the fix and reported the
replacement flow working. The supplied screenshot shows a retained retired
predecessor, a connected Builder in manual takeover, the current Pi footer in
manual takeover, and no Unassigned sessions. Record **operator-reported live
PASS for replacement takeover** only. Live reconnect/gateway-restart recovery
remains unverified; those cases have automated evidence, not human evidence.
No conversation content or screenshot is copied into repository evidence.

## Read-only patch review

The implementing assistant performed a separate read-only review of the diff
and adjacent storage/recovery paths before commit. No blocking finding was
identified within this correction's scope:

- Recovery compares the full Node/process/session/extension binding, then
  retains the existing retirement check and fresh connection challenge.
- Registration cannot grant observed authority to a retained replacement.
- SQLite foreign keys remain enabled; takeover table selection uses fixed
  internal names, and no user-supplied identifier becomes SQL syntax.
- Purge deletes the replacement marker before its referenced commitment within
  the existing transaction; historical original takeover rows are unchanged.
- The composed test covers delivered/lost commit receipt, same-Pi input,
  reopened-store recovery, card/footer agreement and marker cleanup.
- No installed asset, live process, socket, private evidence or Pi configuration
  was touched during this correction.

This is a **self-review, not an independent reviewer PASS**. Independent review
remains outstanding. Broader retirement contracts and the in-memory adapter's
replacement-takeover parity are not certified by this bounded SQLite fix.
Passing fresh Adoption after purging all predecessors is not replacement evidence.
