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

# Three-slot Fusion stack. Pi and every child agent use this directory as their CWD.
fusion *ARGS:
    pi -e "{{fusion_harness}}/extensions/fusion-harness/fusion-harness.ts" \
        --fh-config "{{fusion_harness}}/.pi/fusion-harness/model-stack-fusion.yaml" \
        {{ARGS}}
