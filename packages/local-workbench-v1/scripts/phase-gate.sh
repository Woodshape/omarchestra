#!/usr/bin/env bash
# Local Workbench v1 Phase 0/1 presentation gate.
#
# This gate covers only the closed contracts, injected presentation adapter,
# QML/source boundaries, fixtures, and static QML lint. It does not prove
# durable Project/Goal state, Adoption, writer admission, same-Pi delivery,
# gate execution, cancellation, restart recovery, or live installation.
#
# The gate is foreground and provider-free. It uses a disposable environment,
# never loads dotenv or reads user state. Offscreen Qt tests render only child
# components with inert theme ports; no installed shell or live service loads.
# Missing Qt test/lint tools is a non-passing limitation.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi

scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1.XXXXXX)"
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
        "$node_bin" "$@"
}

flags=()
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi

printf '%s\n' '== Local Workbench v1 Phase 0/1 presentation gate =='
printf 'node: '; run_node --version
printf '%s\n' 'scope: injected projection/intents, offscreen Qt with inert host/theme ports, source boundaries, and static QML lint; no native desktop or runtime acceptance'

printf '%s\n' '== running injected presentation tests =='
run_node "${flags[@]}" --test \
    "$root/test/projection.test.ts" \
    "$root/test/intent.test.ts" \
    "$root/test/stale-session.test.ts" \
    "$root/test/layout-fixtures.test.ts" \
    "$root/test/acceptance.test.ts" \
    "$root/test/presentation-shell.test.ts" \
    "$root/test/phase1-followup.test.ts" \
    "$root/test/rendered-layout.test.ts" \
    "$root/../../manual/test/workbench-preview.test.ts" \
    "$root/test/qml-boundary.test.mjs" \
    "$root/test/source-audit.test.mjs" \
    "$root/test/retained-release.test.mjs"

printf '%s\n' '== static QML lint =='
qml_lint="${QMLLINT_BIN:-}"
if [[ -z "$qml_lint" ]] && command -v qmllint >/dev/null 2>&1; then
    qml_lint="$(command -v qmllint)"
fi
if [[ -z "$qml_lint" || ! -x "$qml_lint" ]]; then
    echo 'QML lint: UNAVAILABLE (qmllint not found) - limitation, not PASS' >&2
    exit 1
fi
# Quickshell's qs namespace needs a static import alias for qmllint.
# The link is disposable and reads system QML only, never installed user assets.
mkdir -p "$scratch/imports"
ln -s /usr/share/omarchy/shell "$scratch/imports/qs"
env -i \
    PATH="$clean_path" \
    HOME="$scratch/home" \
    TMPDIR="$scratch/tmp" \
    "$qml_lint" --ignore-settings --import error -I "$scratch/imports" \
    "$root/console/plugin/WorkbenchConsole.qml" \
    "$root/console/plugin/WorkbenchHost.qml" \
    "$root/console/plugin/WorkbenchOverview.qml" \
    "$root/console/plugin/WorkbenchGoal.qml" \
    "$root/console/plugin/WorkbenchCards.qml" \
    "$root/console/plugin/WorkbenchAssignmentForm.qml" \
    "$root/console/plugin/WorkbenchChecks.qml" \
    "$root/console/plugin/WorkbenchReview.qml" \
    "$root/console/plugin/WorkbenchBoard.qml"
printf '%s\n' 'QML lint: PASS'
printf '%s\n' '== Phase 0/1 automated presentation gate: PASS; native layout checkpoint pending; runtime unimplemented =='
