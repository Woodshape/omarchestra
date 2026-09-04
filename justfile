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
