#!/usr/bin/env bash
# Bounded AL-07 end-to-end gate. Uses a disposable Project/store, real QML and
# adapter code, a framed fake Pi extension, and /usr/bin/true as the validator.
# Never opens a live bridge, installs/reloads/restarts anything, or changes a
# repository Project. All state and gate scratch are removed on exit.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "node is unavailable" >&2
    exit 127
fi
qt_runner="${QT_BIN:-/usr/lib/qt6/bin/qmltestrunner}"
if [[ ! -x "$qt_runner" ]]; then
    echo "offscreen qmltestrunner is unavailable: $qt_runner" >&2
    exit 127
fi
scratch="$(mktemp -d /tmp/omarchestra-local-workbench-v1-composed.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch"/{home,tmp}
clean_path="$(dirname "$node_bin"):/usr/bin:/bin"
flags=()
if "$node_bin" --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
    flags+=(--experimental-strip-types)
fi
if "$node_bin" --help | /usr/bin/grep -qE '(^|[[:space:]])--experimental-sqlite([[:space:]]|$)'; then
    flags+=(--experimental-sqlite)
fi
printf '%s\n' '== Local Workbench Phase 3 AL-07 composed fake-only gate =='
printf 'node: '; env -i PATH="$clean_path" HOME="$scratch/home" "$node_bin" --version
env -i PATH="$clean_path" HOME="$scratch/home" TMPDIR="$scratch/tmp" QT_BIN="$qt_runner" \
    /usr/bin/timeout --signal=TERM --kill-after=3s 55s \
    "$node_bin" "${flags[@]}" --test \
    "$root/test/phase-3-assignment-loop-composed.test.ts"
