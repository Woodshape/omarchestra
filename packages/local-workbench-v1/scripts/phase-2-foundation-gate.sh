#!/usr/bin/env bash
# Local Workbench v1 Phase 2 foundation gate (P2.1).
#
# Covers only the durable runner foundation: owner-only roots, one-owner
# exclusion, ownership manifest and durable Node identity, store/ledger schema
# and pragma drift, write-ahead binding fences, leaf-only purge, vacancy
# generations, recovery ordering, and backup preconditions.
#
# The gate is foreground and provider-free. Every root is disposable under a
# temp directory created by this script; the runner never reads XDG/HOME user
# state and receives all roots and clocks by injection. Nothing here installs,
# launches Pi, opens a desktop, mutates a Project, delivers an Assignment, or
# executes an acceptance check. Node's node:sqlite is the only store.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi

scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-foundation.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch"/{home,config,cache,state,runtime,tmp}
clean_path="$(dirname "$node_bin"):/usr/bin:/bin"

run_node() {
    env -i \
        PATH="$clean_path" \
        HOME="$scratch/home" \
        XDG_CONFIG_HOME="$scratch/config" \
        XDG_CACHE_HOME="$scratch/cache" \
        XDG_STATE_HOME="$scratch/state" \
        XDG_RUNTIME_DIR="$scratch/runtime" \
        TMPDIR="$scratch/tmp" \
        /usr/bin/timeout --signal=TERM --kill-after=5s 60s "$node_bin" "$@"
}

flags=()
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
    flags+=(--experimental-sqlite)
fi

printf '%s\n' '== Local Workbench v1 Phase 2 foundation gate (P2.1) =='
printf 'node: '; run_node --version
printf '%s\n' 'scope: one foreground runner, owner-only durable roots, SQLite store + independent fence ledger, recovery and backup preconditions'
printf '%s\n' 'invariant: zero Assignment deliveries and zero acceptance-check executions (no delivery or validator surface exists in this gate)'

printf '%s\n' '== running durable runner foundation tests =='
run_node "${flags[@]}" --test \
    "$root/test/runner-foundation.test.ts" \
    "$root/test/phase-2-owned-resources.test.ts" \
    "$root/test/phase-2-fence-operations.test.ts"

printf '%s\n' '== running Phase 1 boundary audits against the updated tree =='
run_node "${flags[@]}" --test \
    "$root/test/source-audit.test.mjs" \
    "$root/test/retained-release.test.mjs" \
    "$root/test/qml-boundary.test.mjs"

printf '%s\n' '== S1 persistence foundation gate: PASS; not Phase 2 management acceptance =='
