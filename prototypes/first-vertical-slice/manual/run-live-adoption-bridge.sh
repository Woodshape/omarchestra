#!/usr/bin/env bash
#
# PROTOTYPE — NOT PRODUCTION.
#
# Human-only procedure for the disposable live Adoption bridge. The Adoption
# gateway is the only live process this script starts. The visible Pi command
# is printed for the operator and is never launched here. The --check path is
# fake/static only and never reads user state or contacts Companion.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROTOTYPE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(cd -- "$PROTOTYPE_DIR/../.." && pwd -P)
GATEWAY="$SCRIPT_DIR/live-adoption-gateway.ts"
EXTENSION="$SCRIPT_DIR/live-adoption-extension.ts"
TRANSPORT="$SCRIPT_DIR/live-observer-transport.ts"
STORE="$SCRIPT_DIR/live-adoption-store.ts"

NODE_FLAGS=(--experimental-strip-types)

if [[ "${1:-}" == "--check" ]]; then
  [[ "$#" -eq 1 ]] || {
    printf 'usage: %s [--check|--live]\n' "$0" >&2
    exit 2
  }
  [[ -f "$GATEWAY" && -f "$EXTENSION" && -f "$TRANSPORT" && -f "$STORE" ]]
  bash -n "$0"
  node "${NODE_FLAGS[@]}" "$GATEWAY" --check
  printf 'live Adoption bridge launcher: PASS (fake-only)\n'
  exit 0
fi

if [[ "${1:-}" != "--live" || "$#" -ne 1 ]]; then
  printf 'usage: %s [--check|--live]\n' "$0" >&2
  exit 2
fi

# Stop before creating evidence or runtime state. The implementation has not
# passed independent acceptance review, even though its scaffold tests pass.
printf 'live_adoption_incomplete: manual Adoption is disabled pending integration and safety fixes\n' >&2
exit 2

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'live Adoption bridge requires a TTY on stdin and stdout; use --check for fake-only validation\n' >&2
  exit 2
fi

for command in node mktemp stat mkdir rmdir chmod cat rm; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'missing live Adoption prerequisite: %s\n' "$command" >&2
    exit 2
  }
done

umask 077

reject_symlink_components() {
  local input="$1" prefix="" part
  local components=()
  [[ "$input" == /* ]] || return 1
  IFS='/' read -r -a components <<< "${input#/}"
  for part in "${components[@]}"; do
    [[ -n "$part" ]] || continue
    prefix="$prefix/$part"
    [[ ! -L "$prefix" ]] || {
      printf 'refusing path with symlink component: %s\n' "$prefix" >&2
      return 1
    }
  done
}

path_is_in_repo() {
  local candidate="$1"
  [[ "$candidate" == "$REPO_ROOT" || "$candidate" == "$REPO_ROOT/"* ]]
}

RUNTIME_PARENT="${XDG_RUNTIME_DIR:-/tmp}"
[[ "$RUNTIME_PARENT" == /* && "$RUNTIME_PARENT" != *$'\n'* && "$RUNTIME_PARENT" != *$'\r'* ]] || {
  printf 'XDG_RUNTIME_DIR must be an absolute path without line breaks\n' >&2
  exit 2
}
[[ -d "$RUNTIME_PARENT" ]] || {
  printf 'runtime parent does not exist: %s\n' "$RUNTIME_PARENT" >&2
  exit 2
}
reject_symlink_components "$RUNTIME_PARENT"
RUNTIME_PARENT_CANONICAL=$(cd -- "$RUNTIME_PARENT" && pwd -P)
[[ "$RUNTIME_PARENT" == "$RUNTIME_PARENT_CANONICAL" ]] || {
  printf 'runtime parent must be canonical and cannot use a symlink path\n' >&2
  exit 2
}
RUNTIME_PARENT="$RUNTIME_PARENT_CANONICAL"
path_is_in_repo "$RUNTIME_PARENT" && {
  printf 'runtime parent must be outside the repository\n' >&2
  exit 2
}

if [[ -n "${XDG_STATE_HOME:-}" ]]; then
  STATE_HOME="$XDG_STATE_HOME"
elif [[ -n "${HOME:-}" ]]; then
  STATE_HOME="$HOME/.local/state"
else
  printf 'HOME or XDG_STATE_HOME is required for private evidence\n' >&2
  exit 2
fi
[[ "$STATE_HOME" == /* && "$STATE_HOME" != *$'\n'* && "$STATE_HOME" != *$'\r'* ]] || {
  printf 'XDG_STATE_HOME/HOME must resolve to an absolute path without line breaks\n' >&2
  exit 2
}
reject_symlink_components "$STATE_HOME"
path_is_in_repo "$STATE_HOME" && {
  printf 'evidence state home must be outside the repository\n' >&2
  exit 2
}
EVIDENCE_PARENT="$STATE_HOME/omarchestra/adoption-gates"
path_is_in_repo "$EVIDENCE_PARENT" && {
  printf 'evidence directory must be outside the repository\n' >&2
  exit 2
}
mkdir -p -- "$EVIDENCE_PARENT"
chmod 700 "$EVIDENCE_PARENT"
reject_symlink_components "$EVIDENCE_PARENT"
EVIDENCE_PARENT_CANONICAL=$(cd -- "$EVIDENCE_PARENT" && pwd -P)
[[ "$EVIDENCE_PARENT" == "$EVIDENCE_PARENT_CANONICAL" ]] || {
  printf 'evidence parent must be canonical and cannot use a symlink path\n' >&2
  exit 2
}
EVIDENCE_PARENT="$EVIDENCE_PARENT_CANONICAL"
path_is_in_repo "$EVIDENCE_PARENT" && {
  printf 'evidence directory must be outside the repository\n' >&2
  exit 2
}

EVIDENCE_DIR=$(mktemp -d -- "$EVIDENCE_PARENT/adoption-XXXXXX")
EVIDENCE_IDENTITY=""
RUNTIME_DIR="$RUNTIME_PARENT/omarchestra-adoption-bridge"
RUNTIME_IDENTITY=""
RUNTIME_CREATED=0
SOCKET_PATH="$RUNTIME_DIR/adoption.sock"
SOCKET_IDENTITY=""
SOCKET_IDENTITY_FILE="$EVIDENCE_DIR/socket-identity"
SOCKET_IDENTITY_FILE_ID=""
DATABASE_PATH="$RUNTIME_DIR/adoption.sqlite"
DATABASE_IDENTITY=""
DATABASE_IDENTITY_FILE="$EVIDENCE_DIR/database-identity"
DATABASE_IDENTITY_FILE_ID=""
GATEWAY_STATUS=1
GATEWAY_OK=0
VERDICT_WRITTEN=0
CLEANED=0
CLEANUP_SAFE=1

evidence_dir_is_exact() {
  [[ -n "$EVIDENCE_DIR" && -d "$EVIDENCE_DIR" && ! -L "$EVIDENCE_DIR" ]] || return 1
  reject_symlink_components "$EVIDENCE_DIR" || return 1
  [[ -n "$EVIDENCE_IDENTITY" ]] || return 1
  [[ "$(stat -c '%d:%i' -- "$EVIDENCE_DIR" 2>/dev/null || true)" == "$EVIDENCE_IDENTITY" ]]
}

write_private() {
  local file="$1" value="$2"
  evidence_dir_is_exact || return 1
  [[ "$file" == "$EVIDENCE_DIR/"* ]] || return 1
  [[ ! -L "$file" ]] || return 1
  printf '%s' "$value" > "$file"
  chmod 600 "$file"
}

append_private() {
  local file="$1" value="$2"
  evidence_dir_is_exact || return 1
  [[ "$file" == "$EVIDENCE_DIR/"* ]] || return 1
  [[ ! -L "$file" ]] || return 1
  printf '%s\n' "$value" >> "$file"
  chmod 600 "$file"
}

record_event() {
  local phase="$1"
  case "$phase" in
    procedure_ready|gateway_started|gateway_stopped|socket_absent|runtime_removed|runtime_not_created|cleanup_incomplete|aborted) ;;
    *)
      printf 'refusing unknown evidence phase\n' >&2
      return 1
      ;;
  esac
  append_private "$EVIDENCE_DIR/adoption-events.ndjson" "{\"phase\":\"$phase\"}"
}

remove_exact_socket() {
  local socket="$1" expected="$2" current
  [[ -n "$socket" ]] || return 0
  [[ ! -e "$socket" && ! -L "$socket" ]] && return 0
  [[ -n "$expected" ]] || {
    printf 'refusing to remove Adoption socket without its captured identity\n' >&2
    return 1
  }
  reject_symlink_components "$socket" || return 1
  [[ -S "$socket" && ! -L "$socket" ]] || return 1
  current=$(stat -c '%d:%i' -- "$socket")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove Adoption socket after device/inode drift\n' >&2
    return 1
  }
  rm -f -- "$socket"
}

remove_exact_runtime_directory() {
  local directory="$1" expected="$2" current
  [[ -n "$directory" ]] || return 0
  [[ ! -e "$directory" && ! -L "$directory" ]] && return 0
  reject_symlink_components "$directory" || return 1
  [[ -d "$directory" && ! -L "$directory" ]] || return 1
  [[ -n "$expected" ]] || return 1
  current=$(stat -c '%d:%i' -- "$directory")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove runtime directory after device/inode drift\n' >&2
    return 1
  }
  rmdir -- "$directory"
}

# Remove one owned database/sidecar file only when its captured device/inode
# still matches. A substituted file, symlink, or unrelated resource is never
# removed. The expected identity is a single `device:inode` value.
remove_exact_database_file() {
  local file="$1" expected="$2" current
  [[ -n "$file" ]] || return 0
  [[ ! -e "$file" && ! -L "$file" ]] && return 0
  [[ -n "$expected" ]] || {
    printf 'refusing to remove Adoption database file without its captured identity: %s\n' "$file" >&2
    return 1
  }
  reject_symlink_components "$file" || return 1
  [[ -f "$file" && ! -L "$file" ]] || {
    printf 'refusing to remove non-regular or substituted Adoption database file: %s\n' "$file" >&2
    return 1
  }
  current=$(stat -c '%d:%i' -- "$file")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove substituted Adoption database file: %s\n' "$file" >&2
    return 1
  }
  rm -f -- "$file"
}

# Remove the owned database and its sidecars using the captured identities.
# The gateway writes one `path device:inode` line per owned file to the
# database identity evidence file; this function reads and verifies each.
remove_exact_database() {
  local file expected
  [[ -n "$DATABASE_IDENTITY" ]] || return 0
  while IFS=' ' read -r file expected; do
    [[ -n "$file" && -n "$expected" ]] || continue
    remove_exact_database_file "$file" "$expected" || return 1
  done <<< "$DATABASE_IDENTITY"
}

cleanup() {
  local exit_status=$?
  (( CLEANED == 0 )) || return "$exit_status"
  CLEANED=1
  set +e

  if remove_exact_socket "$SOCKET_PATH" "$SOCKET_IDENTITY"; then
    if [[ ! -e "$SOCKET_PATH" && ! -L "$SOCKET_PATH" ]]; then
      record_event socket_absent || true
    fi
  else
    CLEANUP_SAFE=0
  fi
  if ! remove_exact_database; then
    CLEANUP_SAFE=0
  fi
  if (( RUNTIME_CREATED == 1 )); then
    remove_exact_runtime_directory "$RUNTIME_DIR" "$RUNTIME_IDENTITY" || CLEANUP_SAFE=0
  else
    record_event runtime_not_created || true
  fi

  if (( CLEANUP_SAFE == 1 )); then
    if (( RUNTIME_CREATED == 1 )); then record_event runtime_removed || true; fi
  else
    record_event cleanup_incomplete || true
  fi

  # The verdict is never inferred from gateway exit alone. PASS requires both
  # a successful gateway run and verified removal of every owned resource.
  if (( VERDICT_WRITTEN == 0 )); then
    if (( GATEWAY_OK == 0 )); then
      record_event aborted || true
      write_private "$EVIDENCE_DIR/verdict.txt" \
        'ABORTED — the human-only Adoption procedure did not reach its final verdict.' || true
    elif (( CLEANUP_SAFE == 1 )); then
      write_private "$EVIDENCE_DIR/verdict.txt" \
        'PASS — human-only Adoption procedure completed; no automatic assignment was dispatched.' || true
    else
      write_private "$EVIDENCE_DIR/verdict.txt" \
        'FAIL — cleanup was incomplete; the Adoption procedure did not complete safely.' || true
      exit_status=1
    fi
    VERDICT_WRITTEN=1
  fi
  return "$exit_status"
}
trap cleanup EXIT INT TERM

chmod 700 "$EVIDENCE_DIR"
reject_symlink_components "$EVIDENCE_DIR"
EVIDENCE_IDENTITY=$(stat -c '%d:%i' -- "$EVIDENCE_DIR")
[[ "$EVIDENCE_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]] || {
  printf 'could not capture the exact evidence directory identity\n' >&2
  exit 2
}
[[ "$(stat -c '%a' -- "$EVIDENCE_DIR")" == 700 ]] || {
  printf 'evidence directory is not mode 0700\n' >&2
  exit 2
}
path_is_in_repo "$EVIDENCE_DIR" && {
  printf 'evidence directory must be outside the repository\n' >&2
  exit 2
}

[[ ! -e "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || {
  printf 'refusing to replace an existing Adoption runtime directory: %s\n' "$RUNTIME_DIR" >&2
  exit 2
}
mkdir -- "$RUNTIME_DIR"
RUNTIME_CREATED=1
chmod 700 "$RUNTIME_DIR"
reject_symlink_components "$RUNTIME_DIR"
RUNTIME_IDENTITY=$(stat -c '%d:%i' -- "$RUNTIME_DIR")
[[ "$RUNTIME_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]] || {
  printf 'could not capture the exact runtime directory identity\n' >&2
  exit 2
}
[[ "$(stat -c '%a' -- "$RUNTIME_DIR")" == 700 ]] || {
  printf 'runtime directory is not mode 0700\n' >&2
  exit 2
}
path_is_in_repo "$RUNTIME_DIR" && {
  printf 'runtime directory must be outside the repository\n' >&2
  exit 2
}

PROCEDURE_TEXT=$(cat <<'EOF'
# Human-only live Adoption bridge checklist

This run validates the bounded observed-to-managed Adoption transition. Do not
record prompts, responses, input, tool names or results, terminal output,
repository content, credentials, cwd, title, focus, provider/model values, or
raw errors. Record only the bounded phase labels written by the launcher.

1. Fail-open: before starting the gateway, run the printed visible Pi command
   in a separate ordinary terminal. Confirm Pi remains interactive while this
   socket is absent.
2. Registration: start the gateway, type its exact authorization phrase, then
   run the printed Pi command. Confirm one Unassigned · observed session.
3. Adoption: from the Companion Unassigned Agents panel, request Adoption for
   the exact current session, confirm the exact displayed proposal, and confirm
   the same-process acknowledgement. Confirm exactly one committed Agent Run
   with the committed role/state and no automatic assignment.
4. Managed bridge: confirm the committed role/state appears in the same visible
   Pi and that managed input is handled only by the committed bridge.
5. Disconnect: close the Pi session. Confirm the managed bridge deactivates and
   no dispatch remains enabled.
6. Quit: type `quit` in the gateway terminal. Confirm the socket and runtime
   directory are removed only after exact identity checks.

No automatic assignment is dispatched by Adoption. The Pi command below is
printed for a human operator; the launcher never executes it.
EOF
)
write_private "$EVIDENCE_DIR/procedure.md" "$PROCEDURE_TEXT"
record_event procedure_ready

printf '\nHuman-only live Adoption bridge procedure\n'
printf '%s\n' "$PROCEDURE_TEXT"
printf '%s\n' 'The launcher will start only the Adoption gateway. It will never launch Pi.'
printf 'In another ordinary terminal, use this printed command when instructed (printed only):\n'
printf '  env OMARCHESTRA_ADOPTION_SOCKET=%q pi -e %q\n' "$SOCKET_PATH" "$EXTENSION"
printf '\nFirst test fail-open with the gateway absent, then press Enter here to start it.\n> '
read -r _ || true

write_private "$SOCKET_IDENTITY_FILE" ''
SOCKET_IDENTITY_FILE_ID=$(stat -c '%d:%i' -- "$SOCKET_IDENTITY_FILE")
[[ "$SOCKET_IDENTITY_FILE_ID" =~ ^[0-9]+:[0-9]+$ ]] || {
  printf 'could not capture the socket identity evidence file\n' >&2
  exit 1
}

write_private "$DATABASE_IDENTITY_FILE" ''
DATABASE_IDENTITY_FILE_ID=$(stat -c '%d:%i' -- "$DATABASE_IDENTITY_FILE")
[[ "$DATABASE_IDENTITY_FILE_ID" =~ ^[0-9]+:[0-9]+$ ]] || {
  printf 'could not capture the database identity evidence file\n' >&2
  exit 1
}

printf '\nStarting the foreground Adoption gateway.\n'
printf 'Controls: status | quit\n'
record_event gateway_started
if node "${NODE_FLAGS[@]}" "$GATEWAY" \
    --live \
    --socket "$SOCKET_PATH" \
    --socket-identity-file "$SOCKET_IDENTITY_FILE" \
    --database-identity-file "$DATABASE_IDENTITY_FILE" \
    --execution-node-id adoption-live-local; then
  GATEWAY_STATUS=0
else
  GATEWAY_STATUS=$?
fi
if [[ -f "$SOCKET_IDENTITY_FILE" && ! -L "$SOCKET_IDENTITY_FILE" \
    && "$(stat -c '%d:%i' -- "$SOCKET_IDENTITY_FILE" 2>/dev/null || true)" == "$SOCKET_IDENTITY_FILE_ID" ]]; then
  candidate_socket_identity=$(cat -- "$SOCKET_IDENTITY_FILE")
  if [[ "$candidate_socket_identity" =~ ^[0-9]+:[0-9]+$ ]]; then
    SOCKET_IDENTITY="$candidate_socket_identity"
  fi
fi
if [[ -f "$DATABASE_IDENTITY_FILE" && ! -L "$DATABASE_IDENTITY_FILE" \
    && "$(stat -c '%d:%i' -- "$DATABASE_IDENTITY_FILE" 2>/dev/null || true)" == "$DATABASE_IDENTITY_FILE_ID" ]]; then
  DATABASE_IDENTITY=$(cat -- "$DATABASE_IDENTITY_FILE")
fi
record_event gateway_stopped

if (( GATEWAY_STATUS == 0 )); then
  GATEWAY_OK=1
fi
# The verdict is written by cleanup() only after verified resource removal.
printf '\nAdoption gateway exited; verifying owned resource cleanup.\n'
printf 'No live Adoption claim beyond the bounded committed transition was made.\n'
