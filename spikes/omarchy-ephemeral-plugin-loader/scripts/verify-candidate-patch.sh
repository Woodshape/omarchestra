#!/usr/bin/env bash
# SPIKE — candidate-only verifier. It never edits installed or user files.
# The patch is applied only to a hash-verified copy of /usr/share/omarchy.

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
SPIKE_ROOT="$ROOT/spikes/omarchy-ephemeral-plugin-loader"
PROVENANCE="$SPIKE_ROOT/evidence/source-provenance.json"
PATCH_PATH="$SPIKE_ROOT/upstream/omarchy-4.0.2-1-temporary-panel-v1.patch"
TMP_ROOT="${TMPDIR:-/tmp}"
scratch=""
scratch_identity=""
unrelated=""
unrelated_identity=""

case "$TMP_ROOT" in
  /tmp|/tmp/*) ;;
  *) printf 'refusing non-/tmp scratch root: %s\n' "$TMP_ROOT" >&2; exit 1 ;;
esac

symlink_component() {
  local value="$1"
  local current=""
  local rest="${value#/}"
  while [[ -n "$rest" ]]; do
    local part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    [[ -z "$part" ]] && continue
    current="$current/$part"
    [[ ! -L "$current" ]] || return 0
  done
  return 1
}

remove_exact_directory() {
  local path_value="$1"
  local expected_identity="$2"
  [[ -n "$path_value" && -n "$expected_identity" ]] || return 1
  [[ ! -e "$path_value" ]] && return 0
  if [[ ! -d "$path_value" ]] || symlink_component "$path_value"; then
    printf 'refusing-cleanup-symlink_component-or-type: %s\n' "$path_value" >&2
    return 1
  fi
  local actual_identity
  actual_identity=$(stat -c '%d:%i' -- "$path_value") || return 1
  if [[ "$actual_identity" != "$expected_identity" ]]; then
    printf 'refusing-cleanup-identity-changed: %s\n' "$path_value" >&2
    return 1
  fi
  rm -rf -- "$path_value"
}

cleanup() {
  local exit_code=$?
  local clean=1
  trap - HUP INT TERM
  set +e

  if [[ -n "$unrelated" ]]; then
    if [[ ! -f "$unrelated/sentinel" ]]; then
      clean=0
      printf 'unrelated-resource-not-preserved\n' >&2
    fi
  fi

  if [[ -n "$scratch" ]]; then
    case "$scratch" in
      "$TMP_ROOT"/omarchy-ephemeral-verifier-*)
        remove_exact_directory "$scratch" "$scratch_identity" || clean=0
        ;;
      *)
        clean=0
        printf 'refusing-to-remove-unexpected-scratch: %s\n' "$scratch" >&2
        ;;
    esac
  fi

  if [[ -n "$unrelated" ]]; then
    case "$unrelated" in
      "$TMP_ROOT"/omarchy-ephemeral-unrelated-*)
        remove_exact_directory "$unrelated" "$unrelated_identity" || clean=0
        ;;
      *) clean=0 ;;
    esac
  fi

  if (( clean )); then
    printf 'cleanup-ok\n'
  else
    printf 'cleanup-failed\n'
    exit_code=1
  fi

  if [[ -n "$scratch" && -e "$scratch" ]] || [[ -n "$unrelated" && -e "$unrelated" ]]; then
    printf 'residue-present\n'
    exit_code=1
  else
    printf 'residue-clean\n'
  fi
  exit "$exit_code"
}

on_signal() {
  exit 130
}

trap cleanup EXIT
trap on_signal HUP INT TERM

die() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

[[ -f "$PROVENANCE" ]] || die "missing source provenance: $PROVENANCE"
[[ -f "$PATCH_PATH" ]] || die "missing candidate patch: $PATCH_PATH"

# Emit path/hash pairs from the recorded manifest. Package metadata, cached
# archives, installed shell files, and QML API metadata are all verified before
# any scratch copy is made.
provenance_rows() {
  node --input-type=module -e '
    import fs from "node:fs"
    const provenance = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const rows = []
    const add = (entry) => {
      if (entry && typeof entry.path === "string" && typeof entry.sha256 === "string") {
        rows.push([entry.path, entry.sha256])
      }
    }
    for (const packageInfo of Object.values(provenance.installedPackages || {})) {
      add({ path: packageInfo.metadataPath, sha256: packageInfo.metadataSha256 })
      add(packageInfo.cacheArchive)
      add(packageInfo.cacheSignature)
    }
    add(provenance.versionDiscrepancy)
    for (const entry of provenance.installedSources || []) add(entry)
    for (const entry of provenance.qmlApiEvidence || []) add(entry)
    for (const [pathValue, hashValue] of rows) process.stdout.write(`${pathValue}\t${hashValue}\n`)
  ' "$PROVENANCE"
}

verify_hash() {
  local file="$1"
  local expected="$2"
  [[ -f "$file" ]] || die "missing hash input: $file"
  local actual ignored
  read -r actual ignored < <(sha256sum -- "$file")
  [[ "$actual" == "$expected" ]] || die "hash mismatch: $file"
}

while IFS=$'\t' read -r recorded_path recorded_hash; do
  [[ -n "$recorded_path" && -n "$recorded_hash" ]] || continue
  verify_hash "$recorded_path" "$recorded_hash"
done < <(provenance_rows)
printf 'baseline-verified\n'

scratch=$(mktemp -d "$TMP_ROOT/omarchy-ephemeral-verifier-XXXXXX")
scratch_identity=$(stat -c '%d:%i' -- "$scratch")
unrelated=$(mktemp -d "$TMP_ROOT/omarchy-ephemeral-unrelated-XXXXXX")
unrelated_identity=$(stat -c '%d:%i' -- "$unrelated")
printf 'unrelated-sentinel\n' > "$unrelated/sentinel"

# Copy the complete installed Omarchy tree needed by the patch and QML imports.
cp -a -- /usr/share/omarchy/. "$scratch/"

# Confirm the copy still matches every recorded installed Omarchy path.
while IFS=$'\t' read -r recorded_path recorded_hash; do
  [[ -n "$recorded_path" && -n "$recorded_hash" ]] || continue
  case "$recorded_path" in
    /usr/share/omarchy/*)
      copied_path="$scratch/${recorded_path#/usr/share/omarchy/}"
      verify_hash "$copied_path" "$recorded_hash"
      ;;
  esac
done < <(provenance_rows)
printf 'copy-ok\n'

# The patch must be valid before it is applied. The candidate patch itself is
# the only source of changes in this scratch tree.
(cd "$scratch" && git apply --check "$PATCH_PATH")
printf 'dry-run-ok\n'

(cd "$scratch" && git apply --numstat "$PATCH_PATH") > "$scratch/.candidate-numstat"
while IFS=$'\t' read -r added removed touched; do
  [[ -n "$touched" ]] || continue
  case "$touched" in
    shell/README.md|shell/shell.qml|shell/services/TemporaryPanelHost.qml) ;;
    *) die "candidate patch touches forbidden path: $touched" ;;
  esac
done < "$scratch/.candidate-numstat"
printf 'allowlist-ok\n'

(cd "$scratch" && git apply "$PATCH_PATH")
printf 'apply-ok\n'

QMLLINT=/usr/lib/qt6/bin/qmllint
[[ -x "$QMLLINT" ]] || die "Qt 6 qmllint is required at $QMLLINT"
"$QMLLINT" --version | grep -q '^qmllint 6\.' || die "Qt 6 qmllint version check failed"
for qml_file in shell/services/TemporaryPanelHost.qml shell/shell.qml; do
  if ! timeout --kill-after=1s 20s "$QMLLINT" -I "$scratch/shell" \
      "$scratch/$qml_file" >"$scratch/.qmllint-out" 2>"$scratch/.qmllint-err"; then
    cat "$scratch/.qmllint-out" "$scratch/.qmllint-err" >&2
    die "candidate $qml_file failed Qt 6 qmllint"
  fi
done
printf 'qmllint-ok (qt6; TemporaryPanelHost.qml and shell.qml)\n'

# Exercise the verifier's forced-failure cleanup path inside the owned scratch
# root. The unrelated sibling remains until the EXIT trap checks it.
forced="$scratch/forced-cleanup"
mkdir -p "$forced"
forced_identity=$(stat -c '%d:%i' -- "$forced")
(
  set -e
  trap 'remove_exact_directory "$forced" "$forced_identity"' EXIT HUP INT TERM
  false
) || true
[[ ! -e "$forced" ]] || die "forced cleanup left scratch residue"
printf 'forced-cleanup-ok\n'

# Applying the candidate must not alter any installed input used for the
# baseline. Recheck all recorded hashes after the scratch operation.
while IFS=$'\t' read -r recorded_path recorded_hash; do
  [[ -n "$recorded_path" && -n "$recorded_hash" ]] || continue
  verify_hash "$recorded_path" "$recorded_hash"
done < <(provenance_rows)
printf 'installed-unchanged\n'

exit 0
