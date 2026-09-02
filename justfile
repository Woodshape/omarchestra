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
# processes and the launcher's fake-only --check mode. Never starts Pi,
# Ghostty, Hyprland actions, Quickshell/Omarchy UI, a provider, SSH, Boomux,
# systemd, or the human-only gate.
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
        "$root/prototypes/first-vertical-slice/manual/test/live-gate-resources.test.ts"
    node "${flags[@]}" -e "import('$root/prototypes/first-vertical-slice/console/live-projection-adapter.ts')"
    node "${flags[@]}" -e "import('$root/prototypes/first-vertical-slice/manual/live-gate-resources.ts')"
    bash -n "$root/prototypes/first-vertical-slice/manual/run-live-agent-console-gate.sh"
    bash "$root/prototypes/first-vertical-slice/manual/run-live-agent-console-gate.sh" --check
    if command -v qmllint >/dev/null; then
        qmllint -I /usr/share/omarchy/shell \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsole.qml" \
            "$root/prototypes/first-vertical-slice/console/plugin/AgentConsoleCards.qml"
    fi
    if command -v shellcheck >/dev/null; then
        shellcheck "$root/prototypes/first-vertical-slice/manual/run-live-agent-console-gate.sh"
    fi

# HUMAN-AUTHORIZED LIVE GATE (currently fail-closed on the installed Omarchy
# API): the combined live Agent Console gate. Reports the recorded launch
# blocker and exits before creating any resource. Never invoke from automated
# gates; see prototypes/first-vertical-slice/docs/live-agent-console-gate.md.
prototype-live-agent-console-gate:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-live-agent-console-gate.sh'

# HUMAN-AUTHORIZED LIVE GATE: opens three real Ghostty/Pi windows locally and
# makes one small Builder model request. Never invoke from automated gates.
prototype-vertical-slice-role-label-gate:
    bash '{{justfile_directory()}}/prototypes/first-vertical-slice/manual/run-role-label-gate.sh'

# Three-slot Fusion stack. Pi and every child agent use this directory as their CWD.
fusion *ARGS:
    pi -e "{{fusion_harness}}/extensions/fusion-harness/fusion-harness.ts" \
        --fh-config "{{fusion_harness}}/.pi/fusion-harness/model-stack-fusion.yaml" \
        {{ARGS}}
