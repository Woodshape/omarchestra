#!/usr/bin/env bash
# Bounded AL-04 Candidate-association gate: fake bridge, disposable store.
# One exact structured payload from the current committed Run reaches the
# durable store through the dedicated submission port; an exact duplicate is
# idempotent, changed or retired reuse is refused before mutation, artifact
# references are re-verified on disk (missing/escaped/changed/misdeclared all
# reject), and a lost receipt never rolls the association back. It keeps
# `start_assignment` rejected.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi
scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-candidate-loop.XXXXXX)"
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
printf '%s\n' '== Local Workbench Phase 3 Candidate-association gate =='
printf 'node: '; run_node --version
run_node "${flags[@]}" --test \
    "$root/test/candidate.test.ts" \
    "$root/test/phase-3-assignment-store.test.ts" \
    "$root/test/phase-3-candidate.test.ts"
