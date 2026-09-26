# Run Fusion Harness against this workspace while keeping the harness itself external.
set dotenv-path := "/home/woodshape/claude/fusion-harness/.env"
set dotenv-load := true

fusion_harness := env_var_or_default("FUSION_HARNESS_HOME", "/home/woodshape/claude/fusion-harness")

# PROTOTYPE — NOT PRODUCTION: unattended fake-only acceptance gate for the
# first vertical-slice prototype. Fresh temporary state per run; starts only
# the prototype's foreground Node runner; no live systems are invoked.
prototype-vertical-slice:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
        flags+=(--experimental-sqlite)
    fi
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    mkdir -p "$root/prototypes/first-vertical-slice/evidence"
    node "${flags[@]}" "$root/prototypes/first-vertical-slice/src/acceptance.ts" 2>&1 | tee "$root/prototypes/first-vertical-slice/evidence/fake-only-acceptance.txt"

# Fake-only checks for the manual role-label adapter. This never starts Pi,
# Ghostty, a provider, SSH, Boomux, systemd, or any other live integration.
prototype-vertical-slice-manual-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/manual/test/live-bridge-core.test.ts" \
        "$root/prototypes/first-vertical-slice/manual/test/launcher-contract.test.mjs"
    node "${flags[@]}" -e "import('$root/prototypes/first-vertical-slice/manual/live-role-label-extension.ts')"
    bash -n "$root/prototypes/first-vertical-slice/manual/run-role-label-gate.sh"
    bash "$root/prototypes/first-vertical-slice/manual/run-role-label-gate.sh" --check
    if command -v shellcheck >/dev/null; then
        shellcheck "$root/prototypes/first-vertical-slice/manual/run-role-label-gate.sh"
    fi

# PROTOTYPE — NOT PRODUCTION: unattended fake-only check integrating every
# live Agent Console seam (projection adapter, QML boundary, launcher
# contract, failure cleanup, source audit). Runs only Node test/lint
# processes and the replacement setup procedure's fake-only --check mode.
# Never starts Pi, Ghostty, Hyprland actions, Quickshell/Omarchy UI, a
# provider, SSH, Boomux, systemd, or either human-only gate.
prototype-live-agent-console-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    mkdir -p "$root/prototypes/first-vertical-slice/evidence"
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/console/test/projection-adapter.test.ts" \
        "$root/prototypes/first-vertical-slice/console/test/qml-boundary.test.mjs" \
        "$root/prototypes/first-vertical-slice/console/test/source-audit.test.mjs" \
        "$root/prototypes/first-vertical-slice/manual/test/live-agent-console-launcher.test.mjs" \
        "$root/prototypes/first-vertical-slice/manual/test/companion-setup-validation.test.mjs" \
        "$root/prototypes/first-vertical-slice/manual/test/live-gate-resources.test.ts"
    node "${flags[@]}" -e "import('$root/prototypes/first-vertical-slice/console/live-projection-adapter.ts')"
    node "${flags[@]}" -e "import('$root/prototypes/first-vertical-slice/manual/live-gate-resources.ts')"
    bash -n "$root/prototypes/first-vertical-slice/manual/run-companion-setup-validation.sh"
    bash "$root/prototypes/first-vertical-slice/manual/run-companion-setup-validation.sh" --check
    if command -v qmllint >/dev/null; then
        qmllint -I /usr/share/omarchy/shell \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsole.qml" \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsoleCards.qml" \
            "$root/prototypes/first-vertical-slice/console/plugin/UnassignedAgents.qml"
    fi
    if command -v shellcheck >/dev/null; then
        shellcheck "$root/prototypes/first-vertical-slice/manual/run-companion-setup-validation.sh"
    fi

# PROTOTYPE — NOT PRODUCTION: complete unattended fake-only observer and
# Adoption check. It runs only the observer fakes, static audits, and QML
# boundary tests; it never invokes a human-only recipe or live integration.
prototype-observer-adoption-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/observer/test/protocol.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/telemetry-policy.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/registry.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/adoption.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/extension-adapter.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/companion-projection.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/source-audit.test.mjs" \
        "$root/prototypes/first-vertical-slice/observer/test/acceptance.test.ts" \
        "$root/prototypes/first-vertical-slice/console/test/qml-boundary.test.mjs"
    qml_lint="${QMLLINT_BIN:-}"
    if [[ -z "$qml_lint" ]] && command -v qmllint >/dev/null; then
        qml_lint=qmllint
    fi
    if [[ -n "$qml_lint" ]]; then
        "$qml_lint" -I /usr/share/omarchy/shell \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsole.qml" \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsoleCards.qml" \
            "$root/prototypes/first-vertical-slice/console/plugin/UnassignedAgents.qml"
    fi
    mkdir -p "$root/prototypes/first-vertical-slice/evidence"
    node "${flags[@]}" "$root/prototypes/first-vertical-slice/observer/acceptance.ts" 2>&1 \
        | tee "$root/prototypes/first-vertical-slice/evidence/observer-acceptance-green.txt"

# PROTOTYPE — NOT PRODUCTION: complete unattended fake-only observer bridge
# check. It runs injected transports, static audits, and the launcher's
# no-resource --check path. It never starts a live socket, Pi, Companion shell,
# provider, terminal, Adoption operation, or process-control integration.
prototype-live-observer-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/observer/test/live-frame-channel.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-gateway-core.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-companion-projection.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-observer-bridge.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-bridge-source-audit.test.mjs" \
        "$root/prototypes/first-vertical-slice/manual/test/live-observer-launcher.test.mjs"
    bash -n "$root/prototypes/first-vertical-slice/manual/run-live-observer-bridge.sh"
    bash "$root/prototypes/first-vertical-slice/manual/run-live-observer-bridge.sh" --check
    if command -v shellcheck >/dev/null; then
        shellcheck "$root/prototypes/first-vertical-slice/manual/run-live-observer-bridge.sh"
    fi

# PROTOTYPE — NOT PRODUCTION: dedicated fake-only retirement/replacement gate
# layered on top of live Adoption. It runs the retirement/red tests, the
# retirement presentation test, the durable SQLite retirement store tests,
# the QML boundary tests for the additive RetiredAgentCards component, and
# the existing live-Adoption source audit. It never opens a socket, launches
# Pi, a provider, a desktop, SSH, Boomux, systemd, or mutates an installation.
prototype-retirement-replacement-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
        flags+=(--experimental-sqlite)
    fi
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/observer/test/retirement-replacement-red.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/retirement-replacement-presentation.test.ts" \
        "$root/prototypes/first-vertical-slice/manual/test/live-retirement-store.test.ts" \
        "$root/prototypes/first-vertical-slice/console/test/qml-boundary.test.mjs" \
        "$root/prototypes/first-vertical-slice/observer/test/source-audit.test.mjs"
    mkdir -p "$root/prototypes/first-vertical-slice/evidence"
    {
        printf '# retirement/replacement automated gate\n'
        printf 'red-gate suites: retirement-replacement-red, retirement-replacement-presentation\n'
        printf 'durable store suites: manual/test/live-retirement-store\n'
        printf 'qml boundary suites: console/test/qml-boundary\n'
        printf 'source audit: observer/test/source-audit\n'
    } > "$root/prototypes/first-vertical-slice/evidence/retirement-replacement-automated.txt"

# HUMAN-AUTHORIZED LIVE GATE: explicit human-validated retirement/replacement
# flow against the persistent live Adoption bridge. The operator must already
# have launched `just prototype-live-adoption-bridge --live` and confirmed the
# disconnected Agent Run to retire. Never invoke from automated recipes.
prototype-retirement-replacement-gate:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-retirement-replacement-gate.sh' --live

# PROTOTYPE — NOT PRODUCTION: dedicated fake-only live-Adoption gate. It runs
# the live-Adoption red tests (runner, gateway, Companion controller) plus the
# observation-only gateway regression. It never opens a socket, launches Pi, a
# provider, a desktop, SSH, Boomux, systemd, or mutates an installation.
prototype-live-adoption-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-runner.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-gateway.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-companion.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-presentation.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-durability.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-managed-bridge.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-composed.test.ts" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-authority-boundary.test.ts" \
        "$root/prototypes/first-vertical-slice/manual/test/adoption-owned-database.test.ts" \
        "$root/prototypes/first-vertical-slice/manual/test/live-adoption-launcher.test.mjs" \
        "$root/prototypes/first-vertical-slice/observer/test/live-adoption-source-audit.test.mjs" \
        "$root/prototypes/first-vertical-slice/observer/test/live-gateway-core.test.ts"
    bash -n "$root/prototypes/first-vertical-slice/manual/run-live-adoption-bridge.sh"
    bash "$root/prototypes/first-vertical-slice/manual/run-live-adoption-bridge.sh" --check

# HUMAN-AUTHORIZED LIVE GATE: runs the disposable observer-only bridge after
# the operator has verified the pinned Companion 0.3.0 release and is using an
# interactive TTY. It prints the separate Pi command but never launches Pi.
# Never invoke from automated recipes.
prototype-live-observer-bridge:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-live-observer-bridge.sh' --live

# HUMAN-AUTHORIZED LIVE GATE: runs the disposable live Adoption bridge after
# the operator has verified the pinned Companion 0.3.0 release and is using an
# interactive TTY. It prints the separate Pi command but never launches Pi and
# never dispatches work. Never invoke from automated recipes.
prototype-live-adoption-bridge:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-live-adoption-bridge.sh' --live

# PROTOTYPE — NOT PRODUCTION: complete unattended fake-only Companion check.
# It never invokes the human setup path except through --check.
prototype-companion-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    flags=()
    if node --help | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
        flags+=(--experimental-strip-types)
    fi
    node "${flags[@]}" --test \
        "$root/prototypes/first-vertical-slice/companion/test/installation.test.ts" \
        "$root/prototypes/first-vertical-slice/console/test/companion-projection-session.test.ts" \
        "$root/prototypes/first-vertical-slice/companion/test/acceptance.test.ts" \
        "$root/prototypes/first-vertical-slice/companion/test/observer-panel-lifecycle.test.ts" \
        "$root/prototypes/first-vertical-slice/manual/test/companion-setup-validation.test.mjs"
    node "${flags[@]}" "$root/prototypes/first-vertical-slice/companion/acceptance.ts"
    bash "$root/prototypes/first-vertical-slice/manual/run-companion-setup-validation.sh" --check

# HUMAN-AUTHORIZED LIVE GATE: explicit persistent Companion setup followed by
# live Projection Session validation. Never invoke from automated recipes.
prototype-companion-setup-validation:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-companion-setup-validation.sh'

# REJECTED-PATH SPIKE — unattended fake-only preservation gate only; no
# active Omarchestra recipe depends on this loader. Runs the seam test graph
# (including the candidate-patch verifier and source audits) plus scratch-only
# patch verification. Fresh temporary state per run; never starts Pi,
# Ghostty, Hyprland actions, Quickshell/Omarchy UI, a provider, SSH, Boomux,
# systemd, or any
# user/installed mutation. Never applies the patch outside scratch copies.
spike-omarchy-ephemeral-plugin-loader:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    spike="$root/spikes/omarchy-ephemeral-plugin-loader"
    node "$spike/scripts/run-fake-checks.mjs" --all 2>&1 \
        | tee "$spike/evidence/final-automated.txt"
    {
        printf '# candidate patch scratch verifier\n'
        bash "$spike/scripts/verify-candidate-patch.sh"
        printf '# patch-verifier-exit: 0\n'
    } 2>&1 | tee -a "$spike/evidence/final-automated.txt"

# HUMAN-AUTHORIZED LIVE GATE: opens three real Ghostty/Pi windows locally and
# makes one small Builder model request. Never invoke from automated gates.
prototype-vertical-slice-role-label-gate:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-role-label-gate.sh'

# General three-slot Fusion stack. Pi and every child agent use this directory
# as their CWD; optional arguments are forwarded unchanged to Pi.
fusion *ARGS:
    pi -e "{{fusion_harness}}/extensions/fusion-harness/fusion-harness.ts" \
        --fh-config "{{fusion_harness}}/.pi/fusion-harness/model-stack-fusion.yaml" \
        {{ARGS}}

# Opt-in observer/Adoption milestone: create or resume its branch, then launch
# Fusion collaboration against the committed execution plan.
fusion-observer-adoption:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    harness='{{fusion_harness}}'
    target='prototype/observer-adoption-gate'
    cd "$root"
    [[ -z "$(git status --porcelain)" ]] || {
        printf 'just fusion-observer-adoption requires a clean worktree\n' >&2
        exit 2
    }
    current=$(git branch --show-current)
    if [[ "$current" == main ]]; then
        if git show-ref --verify --quiet "refs/heads/$target"; then
            git switch "$target"
        elif git show-ref --verify --quiet "refs/remotes/origin/$target"; then
            git switch --track "origin/$target"
        else
            git switch -c "$target"
        fi
    elif [[ "$current" != "$target" ]]; then
        printf 'just fusion-observer-adoption requires main or %s; current branch is %s\n' "$target" "$current" >&2
        exit 2
    fi
    exec pi -e "$harness/extensions/fusion-harness/fusion-harness.ts" \
        --fh-config "$harness/.pi/fusion-harness/model-stack-fusion.yaml" \
        "/fh-collaborate Read docs/plans/observer-adoption-implementation.md completely and execute it phase by phase. Preserve every locked authority and privacy boundary, work test-first, stop before any human-only live action, and do not commit or push."

# LOCAL WORKBENCH V1 — PHASE 0/1 ONLY. Run with
# `just --no-dotenv local-workbench-v1-check` because the root justfile
# otherwise loads the external Fusion dotenv before any recipe runs.
# This entrypoint uses only injected fixtures, disposable state, source audits,
# offscreen Qt components with inert host/theme ports, and static QML lint.
# It does not install, launch Pi, access a
# provider, open a desktop, mutate a Project, or rewrite repository evidence.
local-workbench-v1-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    qml_lint="${QMLLINT_BIN:-$(command -v qmllint || true)}"
    if [[ -z "$qml_lint" && -x /usr/lib/qt6/bin/qmllint ]]; then qml_lint=/usr/lib/qt6/bin/qmllint; fi
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        QMLLINT_BIN="$qml_lint" \
        bash "$root/packages/local-workbench-v1/scripts/phase-gate.sh"

# LOCAL WORKBENCH V1 — PHASE 2 P2.1 FOUNDATION. Run with
# `just --no-dotenv local-workbench-v1-foundation-check` for the same
# dotenv reason above. This entrypoint needs only Node: disposable temp roots,
# injected ids/clocks, and node:sqlite. It installs nothing, launches no Pi or
# desktop, reads no user state, mutates no Project, dispatches no Assignment,
# and executes no acceptance check.
local-workbench-v1-foundation-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-2-foundation-gate.sh"

# LOCAL WORKBENCH V1 — PHASE 2 P2.2-P2.5 RUNNABLE WORKBENCH. Run with
# `just --no-dotenv local-workbench-v1-phase-2-check` for the same dotenv
# reason above. This entrypoint needs Node and an offscreen Qt test runner:
# disposable temp roots, injected ids/clocks/ports, and node:sqlite. It
# installs nothing, launches no Pi or desktop, reads no user state, mutates no
# Project, dispatches no Assignment, and executes no acceptance check. It
# refuses to pass when the real QML render is unavailable.
local-workbench-v1-phase-2-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-2-gate.sh"

# LOCAL WORKBENCH V1 — PHASE 3 PROJECT-CONTEXT PREFLIGHT. This bounded fake
# gate exercises the same-process Pi digest, exact challenged Run match,
# freshness and projection. It performs no Assignment delivery or gate run.
local-workbench-v1-phase-3-context-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-context-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-02 prerequisite only. This fingerprints
# disposable checkouts under C9; it is not durable admission or live acceptance.
local-workbench-v1-phase-3-admission-prereq-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-admission-prereq-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-02 durable admission only. Fake bridge and
# disposable store: one exact reviewed Start commits atomically, fault and
# reopen never send or release uncertain authority, and start_assignment stays
# rejected. Not delivery, dispatch or live acceptance.
local-workbench-v1-phase-3-admission-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-admission-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-03 committed same-Pi delivery only. Fake bridge
# and disposable store: one queued outbox row is delivered once on the exact
# challenged committed connection, the extension deduplicates by stable delivery
# identity, and lost ACK / accepted-then-throw / disconnect / duplicate /
# conflicting / restart never queue, resend or release uncertain authority. Not
# dispatch, gate execution or live acceptance; start_assignment stays rejected.
local-workbench-v1-phase-3-delivery-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-delivery-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-04 Candidate association only. Fake bridge
# and disposable store: one exact structured payload from the current committed
# Run reaches the durable store through the dedicated submission port, exact
# duplicates stay idempotent, changed/retired/epoch-drifted reuse is refused
# before mutation, and artifact references are re-verified on disk. Not gate
# execution or live acceptance; start_assignment stays rejected.
local-workbench-v1-phase-3-candidate-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-candidate-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-05 frozen-gate acceptance only. Disposable
# store and real disposable Git checkout: one frozen versioned check runs
# through the bounded no-shell executor, the Candidate is double-scanned before
# and after, and only a final revalidated pass completes the Goal in one
# transaction. Non-pass/unknown/mutation/timeout/output-limit and
# stop/epoch/takeover races stay nonaccepting and preserve uncertainty. Not
# dispatch or live acceptance; start_assignment stays rejected.
local-workbench-v1-phase-3-assignment-gate-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-assignment-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-06 intervention only. Disposable store and
# real disposable Git checkout: a seeded Assignment lifecycle exercises the
# explicit Stop (revoke dispatch first, never claim termination), source
# takeover (advance control epoch, pause delivery, fence stale Candidate/pass),
# exact structured handoff, bounded correction/resume reconciliation and
# restart recovery that blocks continuation through an uncertain writer. No
# live dispatch, install, or Project mutation; start_assignment stays rejected.
local-workbench-v1-phase-3-intervention-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-intervention-gate.sh"

# LOCAL WORKBENCH V1 — bounded AL-07 composed acceptance. This uses the real
# QML/adapter and Runner/SQLite path, a framed fake Pi, and a disposable Git
# Project with /usr/bin/true as its deterministic validator. It performs one
# expected fake send only. No live Pi, install, reload, restart, or push.
local-workbench-v1-phase-3-assignment-loop-check:
    #!/usr/bin/env bash
    set -euo pipefail
    root='{{justfile_directory()}}'
    node_bin="$(command -v node || true)"
    node_dir="$(dirname "${node_bin:-/usr/bin/node}")"
    qt_runner="${QMLTEST_BIN:-/usr/lib/qt6/bin/qmltestrunner}"
    env -i \
        PATH="$node_dir:/usr/bin:/bin" \
        NODE_BIN="$node_bin" \
        QT_BIN="$qt_runner" \
        bash "$root/packages/local-workbench-v1/scripts/phase-3-assignment-loop-composed-gate.sh"
