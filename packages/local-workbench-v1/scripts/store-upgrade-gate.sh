#!/usr/bin/env bash
# Offline, disposable schema/receipt upgrade gate. No installed state, service,
# shell, Pi, transport or real Project is reached. Child crash tests terminate
# only their own exact subprocess; each has an independent hard timeout.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$node_bin" && -x "$node_bin" ]] || { echo 'node unavailable' >&2; exit 127; }
scratch="$(mktemp -d /tmp/omarchestra-store-upgrade-gate.XXXXXX)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch"/{home,tmp}
printf '%s\n' '== Offline schema 9 -> 10 upgrade gate (disposable only) =='
"$node_bin" --version
env -i PATH="$(dirname "$node_bin"):/usr/bin:/bin" HOME="$scratch/home" TMPDIR="$scratch/tmp" \
  /usr/bin/timeout --signal=TERM --kill-after=5s 90s "$node_bin" --experimental-strip-types --experimental-sqlite \
  --test --test-concurrency=1 --test-timeout=20000 \
  "$root/test/store-migration.test.ts" \
  "$root/test/phase-2-runtime-reboot.test.ts" \
  "$root/test/phase-3-assignment-store.test.ts" \
  "$root/test/runner-foundation.test.ts"
