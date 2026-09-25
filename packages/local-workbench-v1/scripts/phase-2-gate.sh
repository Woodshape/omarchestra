#!/usr/bin/env bash
# Local Workbench v1 Phase 2 disposable engineering acceptance gate (P2.2-P2.5, S6).
#
# One foreground run over the runnable bounded management journey: Project
# inspection and confirmed registration, Team Goals, Project-scoped checks,
# Adoption through the real state machine, retirement, replacement and purge,
# restart durability, intent deduplication, and the composition of the durable
# runner with the actual presentation adapter.
#
# Every root is disposable under a temp directory created here. The runner
# receives all roots, clocks and id sources by injection. Nothing installs,
# launches Pi, opens a desktop, mutates a user Project, delivers an Assignment or
# executes an acceptance check. Only disposable Git fixtures are changed.
# The gate asserts both execution zeros explicitly.
# Node's node:sqlite is the only store.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi

scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-phase2.XXXXXX)"
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
        QT_BIN="${QT_BIN:-}" \
        /usr/bin/timeout --signal=TERM --kill-after=5s 60s "$node_bin" "$@"
}

flags=()
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi
if run_node --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
    flags+=(--experimental-sqlite)
fi

printf '%s\n' '== Local Workbench v1 Phase 2 gate (P2.2-P2.5) =='
printf 'node: '; run_node --version
printf '%s\n' 'scope: one foreground runner; Project registry, Team Goals, Project-scoped checks, Adoption lifecycle, durable restart, actual-adapter composition'
printf '%s\n' 'invariant: zero Assignment deliveries and zero acceptance-check executions in every scenario'

printf '%s\n' '== durable runner foundation (P2.1) =='
run_node "${flags[@]}" --test \
    "$root/test/runner-foundation.test.ts" \
    "$root/test/phase-2-owned-resources.test.ts" \
    "$root/test/phase-2-runtime-reboot.test.ts" \
    "$root/test/phase-2-fence-operations.test.ts"

printf '%s\n' '== runnable management and adoption journey (P2.2-P2.5) =='
run_node "${flags[@]}" --test \
    "$root/test/phase-2-authority.test.ts" \
    "$root/test/phase-2-project-context.test.ts" \
    "$root/test/phase-2-check-resources.test.ts" \
    "$root/test/phase-2-real-bridge.test.ts" \
    "$root/test/phase-2-challenged-ack-seam.test.ts" \
    "$root/test/phase-2-framed-adoption.test.ts" \
    "$root/test/session-eligibility.test.ts" \
    "$root/test/session-code.test.ts" \
    "$root/test/pane-navigation.test.ts" \
    "$root/test/phase-2-native-owner.test.ts" \
    "$root/test/owner-service.test.ts" \
    "$root/test/phase-2-command-transactions.test.ts" \
    "$root/test/phase-2-retirement-outcomes.test.ts" \
    "$root/test/phase-2-adoption-outcomes.test.ts" \
    "$root/test/phase-2-delivery-outbox.test.ts" \
    "$root/test/phase-2-intent-envelope.test.ts" \
    "$root/test/phase-2-adoption-exchange.test.ts" \
    "$root/test/phase-2-integration-safety.test.ts"

printf '%s\n' '== actual presentation adapter composition =='
run_node "${flags[@]}" --test \
    "$root/test/phase-2-composed.test.ts" \
    "$root/test/phase-2-source-outcomes.test.ts" \
    "$root/test/phase-2-entry.test.ts" \
    "$root/test/presentation-shell.test.ts" \
    "$root/test/intent.test.ts" \
    "$root/test/projection.test.ts" \
    "$root/test/acceptance.test.ts" \
    "$root/test/phase1-followup.test.ts" \
    "$root/test/stale-session.test.ts"

printf '%s\n' '== Phase 1 boundary audits against the updated tree =='
run_node "${flags[@]}" --test \
    "$root/test/source-audit.test.mjs" \
    "$root/test/qml-boundary.test.mjs" \
    "$root/test/retained-release.test.mjs"

printf '%s\n' '== disposable Companion migration, receipt and release tests =='
run_node "${flags[@]}" --test \
    "$root/../../prototypes/first-vertical-slice/companion/test/installation.test.ts" \
    "$root/../../prototypes/first-vertical-slice/companion/test/bar-upgrade.test.ts" \
    "$root/../../manual/test/workbench-preview.test.ts" \
    "$root/../../manual/test/workbench-companion-receipt-recovery.test.ts" \
    "$root/../../manual/test/workbench-service-toggle.test.ts"

printf '%s\n' '== actual QML render and intent capture (offscreen) =='
qt_runner="${QMLTESTRUNNER_BIN:-/usr/lib/qt6/bin/qmltestrunner}"
if [[ -x "$qt_runner" ]]; then
    QT_BIN="$qt_runner" run_node "${flags[@]}" --test \
        "$root/test/rendered-layout.test.ts" \
    "$root/test/bar-widget.test.ts"
else
    echo 'QML offscreen render: UNAVAILABLE (qmltestrunner not found) - limitation, not PASS' >&2
    exit 1
fi

printf '%s\n' 'Phase 2 acceptance gate: S6 engineering PASS (native owner, exact Companion negotiation, framed fake Pi and real offscreen QML)'
printf '%s\n' 'Human management walkthrough and independent review are separate; no live Pi or Companion was installed or contacted.'
