#!/usr/bin/env bash
# Bounded AL-03 committed same-Pi delivery gate: fake bridge, disposable store.
# One queued outbox row is delivered once on the exact challenged committed
# connection; the extension deduplicates by stable delivery identity; lost ACK,
# accepted-then-throw, disconnect, duplicate/conflicting frames and restart stay
# bounded. It never queues a hidden turn, never blindly resends, never releases
# an uncertain writer, and leaves `start_assignment` rejected.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi
scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-delivery-loop.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch"/{home,tmp}
clean_path="$(dirname "$node_bin"):/usr/bin:/bin"
run_node() {
    env -i PATH="$clean_path" HOME="$scratch/home" TMPDIR="$scratch/tmp" \
        /usr/bin/timeout --signal=TERM --kill-after=5s 60s "$node_bin" "$@"
}
flags=()
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
    flags+=(--experimental-sqlite)
fi
printf '%s\n' '== Local Workbench Phase 3 committed Assignment-delivery gate =='
printf 'node: '; run_node --version
run_node "${flags[@]}" --test \
    "$root/test/phase-3-assignment-store.test.ts" \
    "$root/test/phase-3-assignment-delivery.test.ts"
