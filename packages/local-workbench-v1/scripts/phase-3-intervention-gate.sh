#!/usr/bin/env bash
# Bounded AL-06 intervention check: fake-only and disposable. A seeded
# Assignment lifecycle exercises the explicit Stop, takeover, structured
# handoff, bounded correction/resume reconciliation and restart-recovery paths.
# Native operator routes additionally prove request receipts, same-Pi handoff,
# explicit effect/risk review, fresh challenged control, writer clearance,
# rollback, lost ACKs and surviving-extension restart. The composed loop gate
# separately exercises actual QML Stop, Return, Resume and writer release.
# Stop revokes future dispatch first and never claims Pi/tool termination;
# takeover advances the control epoch and pauses automatic delivery; a
# superseded epoch fences stale Candidate and pass results; correction stays
# inside persisted limits; restart leaves an uncertain writer that blocks
# continuation. Only disposable Projects and framed fake-Pi APIs are used;
# there is no live bridge, installed-state mutation or real Pi dispatch.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi
scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-intervention-loop.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch"/{home,tmp}
clean_path="$(dirname "$node_bin"):/usr/bin:/bin"
run_node() {
    env -i PATH="$clean_path" HOME="$scratch/home" TMPDIR="$scratch/tmp" \
        /usr/bin/timeout --signal=TERM --kill-after=5s 180s "$node_bin" "$@"
}
flags=()
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
    flags+=(--experimental-sqlite)
fi
printf '%s\n' '== Local Workbench Phase 3 intervention gate =='
printf 'node: '; run_node --version
run_node "${flags[@]}" --test \
    "$root/test/phase-3-assignment-intervention.test.ts" \
    "$root/test/native-intervention.test.ts"
