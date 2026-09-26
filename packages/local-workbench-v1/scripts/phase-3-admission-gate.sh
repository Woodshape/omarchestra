#!/usr/bin/env bash
# Bounded AL-02 durable-admission gate: fake-only and disposable. It commits
# one exact reviewed Start into the Owner store, proves fault/concurrency/reopen
# behavior, and confirms `start_assignment` stays rejected. It never sends a
# delivery, releases an uncertain writer, opens a live bridge, or runs a gate.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi
scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-admission-loop.XXXXXX)"
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
printf '%s\n' '== Local Workbench Phase 3 durable Assignment-admission gate =='
printf 'node: '; run_node --version
run_node "${flags[@]}" --test \
    "$root/test/start-proposal.test.ts" \
    "$root/test/phase-3-assignment-store.test.ts" \
    "$root/test/phase-3-admission.test.ts"
