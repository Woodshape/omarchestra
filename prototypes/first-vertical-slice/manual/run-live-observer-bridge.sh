#!/usr/bin/env bash
#
# PROTOTYPE — NOT PRODUCTION.
#
# Human-only procedure for the disposable observer bridge. The bridge gateway
# is the only live process this script starts. The visible Pi command is
# printed for the operator and is never launched here. The --check path is
# fake/static only and never reads user state or contacts Companion.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROTOTYPE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(cd -- "$PROTOTYPE_DIR/../.." && pwd -P)
GATEWAY="$SCRIPT_DIR/live-observer-gateway.ts"
EXTENSION="$SCRIPT_DIR/live-observer-extension.ts"
TRANSPORT="$SCRIPT_DIR/live-observer-transport.ts"
LIVE_ADAPTER="$SCRIPT_DIR/live-companion-omarchy.ts"

# The prototype requires the Node version declared by package.json.
NODE_FLAGS=(--experimental-strip-types)

if [[ "${1:-}" == "--check" ]]; then
  [[ "$#" -eq 1 ]] || {
    printf 'usage: %s [--check|--live]\n' "$0" >&2
    exit 2
  }
  [[ -f "$GATEWAY" && -f "$EXTENSION" && -f "$TRANSPORT" && -f "$LIVE_ADAPTER" ]]
  bash -n "$0"
  node "${NODE_FLAGS[@]}" "$GATEWAY" --check
  printf 'observer bridge launcher: PASS (fake-only)\n'
  exit 0
fi

if [[ "${1:-}" != "--live" || "$#" -ne 1 ]]; then
  printf 'usage: %s [--check|--live]\n' "$0" >&2
  exit 2
fi

# This guard precedes all live command lookup, user-state access, directory
# creation, Companion discovery, and gateway startup.
if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'live observer bridge requires a TTY on stdin and stdout; use --check for fake-only validation\n' >&2
  exit 2
fi

for command in node omarchy-shell mktemp stat mkdir rmdir chmod cat rm; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'missing live observer prerequisite: %s\n' "$command" >&2
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

reject_dot_components() {
  local candidate="$1"
  [[ "$candidate" != *'//'*
    && "$candidate" != */./*
    && "$candidate" != */../*
    && "$candidate" != */.
    && "$candidate" != */.. ]]
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
reject_dot_components "$STATE_HOME" || {
  printf 'evidence state home must be canonical and contain no dot components\n' >&2
  exit 2
}
reject_symlink_components "$STATE_HOME"
path_is_in_repo "$STATE_HOME" && {
  printf 'evidence state home must be outside the repository\n' >&2
  exit 2
}
EVIDENCE_PARENT="$STATE_HOME/omarchestra/observer-gates"
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

# Evidence is created before the runtime resource so an early setup failure
# cannot strand a live directory. The directory remains private evidence and
# is never recursively removed by this procedure.
EVIDENCE_DIR=$(mktemp -d -- "$EVIDENCE_PARENT/observer-XXXXXX")
EVIDENCE_IDENTITY=""
RUNTIME_DIR="$RUNTIME_PARENT/omarchestra-observer-bridge"
RUNTIME_IDENTITY=""
RUNTIME_CREATED=0
SOCKET_PATH="$RUNTIME_DIR/observer.sock"
SOCKET_IDENTITY=""
SOCKET_IDENTITY_FILE="$EVIDENCE_DIR/socket-identity"
SOCKET_IDENTITY_FILE_ID=""
GATEWAY_STATUS=1
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
    procedure_ready|companion_verified|fingerprint_before|gateway_started|gateway_stopped|fingerprint_after|fingerprint_match|socket_absent|runtime_removed|runtime_not_created|cleanup_incomplete|aborted) ;;
    *)
      printf 'refusing unknown evidence phase\n' >&2
      return 1
      ;;
  esac
  append_private "$EVIDENCE_DIR/observer-events.ndjson" "{\"phase\":\"$phase\"}"
}

remove_exact_socket() {
  local socket="$1" expected="$2" current
  [[ -n "$socket" ]] || return 0
  [[ ! -e "$socket" && ! -L "$socket" ]] && return 0
  # The gateway transport owns the socket identity. If it leaves an endpoint,
  # this launcher refuses removal because no unverified path may be guessed.
  [[ -n "$expected" ]] || {
    printf 'refusing to remove observer socket without its captured identity\n' >&2
    return 1
  }
  reject_symlink_components "$socket" || return 1
  [[ -S "$socket" && ! -L "$socket" ]] || return 1
  current=$(stat -c '%d:%i' -- "$socket")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove observer socket after device/inode drift\n' >&2
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
  # rmdir, not recursive removal: unexpected files or substituted sockets are
  # preserved for manual reconciliation.
  rmdir -- "$directory"
}

cleanup() {
  local exit_status=$?
  (( CLEANED == 0 )) || return "$exit_status"
  CLEANED=1
  set +e

  if (( VERDICT_WRITTEN == 0 )); then
    record_event aborted || true
    write_private "$EVIDENCE_DIR/verdict.txt" \
      'ABORTED — the human-only observer procedure did not reach its final verdict.' || true
    VERDICT_WRITTEN=1
  fi

  if remove_exact_socket "$SOCKET_PATH" "$SOCKET_IDENTITY"; then
    if [[ ! -e "$SOCKET_PATH" && ! -L "$SOCKET_PATH" ]]; then
      record_event socket_absent || true
    fi
  else
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
    exit_status=1
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
  printf 'refusing to replace an existing observer runtime directory: %s\n' "$RUNTIME_DIR" >&2
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
# Human-only observer bridge checklist

This run is observation-only. Do not record prompts, responses, input, tool
names or results, terminal output, repository content, credentials, cwd, title,
focus, provider/model values, or raw errors. Record only the bounded phase
labels written by the launcher and the Companion version/capability facts.

1. Fail-open: before starting the gateway, run the printed visible Pi command
   in a separate ordinary terminal. Confirm Pi remains interactive while this
   socket is absent. Do not type or record any content for this check.
2. Registration: start the gateway, type its exact authorization phrase, then
   run the printed Pi command in the separate visible terminal. Confirm one
   Unassigned · observed session and no managed or Adoption state.
3. Heartbeat: leave the visible Pi idle for more than one five-second heartbeat
   interval. Confirm the observed card remains current and available.
4. Disconnect: close that Pi session. Confirm the card becomes unavailable
   without any process, terminal, or input action from the bridge.
5. Expiry: do not reconnect for more than the fifteen-second lease. Confirm
   the unavailable observed card expires from the current collection.
6. Reconnect: start the same printed Pi command again while the gateway is
   running. Confirm a fresh current registration and no duplicate collection
   entry. To exercise gateway restart, quit this run, rerun the launcher, and
   rerun the printed command. Do not claim continuity across a new Pi process.
7. Pause/resume: use only the gateway controls `pause`, `status`, and `resume`.
   Confirm expiry continues while publication is paused and the latest bounded
   snapshot appears after resume.
8. Quit: type `quit` in the gateway terminal. Confirm the socket and runtime
   directory are removed only after exact identity checks and the Companion
   installation fingerprint is unchanged.

No live Adoption, managed work, terminal supervision, or separate Pi launch is
part of this procedure. The Pi command below is printed for a human operator;
the launcher never executes it.
EOF
)
write_private "$EVIDENCE_DIR/procedure.md" "$PROCEDURE_TEXT"
record_event procedure_ready

printf '\nHuman-only observer bridge procedure\n'
printf '%s\n' "$PROCEDURE_TEXT"
printf '%s\n' 'The launcher will start only the observer gateway. It will never launch Pi.'
printf 'In another ordinary terminal, use this printed command when instructed (printed only):\n'
printf '  env OMARCHESTRA_OBSERVER_SOCKET=%q pi -e %q\n' "$SOCKET_PATH" "$EXTENSION"
printf '\nFirst test fail-open with the gateway absent, then press Enter here to start it.\n> '
read -r _ || true

# Read-only preflight: ask the installed shell for the exact current Companion
# capability envelope and write only its bounded protocol facts to evidence.
node "${NODE_FLAGS[@]}" --input-type=module - \
  "$EVIDENCE_DIR/companion-capabilities.json" "$LIVE_ADAPTER" <<'NODE'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
const outputPath = process.argv[2]
const adapterPath = process.argv[3]
const adapterUrl = pathToFileURL(adapterPath)
const {
  createLiveCompanionPorts,
} = await import(adapterUrl.href)
const {
  OBSERVER_COMPANION_RELEASE,
} = await import(new URL('../companion/releases.ts', adapterUrl).href)
const {
  COMPANION_OBSERVER_CAPABILITY,
  COMPANION_PLUGIN_ID,
  COMPANION_PROTOCOL_ID,
  assertRequiredCapabilities,
  validateCapabilitiesEnvelope,
} = await import(new URL('../companion/contracts.ts', adapterUrl).href)
const ports = createLiveCompanionPorts({ release: OBSERVER_COMPANION_RELEASE })
const envelope = validateCapabilitiesEnvelope(await ports.shell.capabilities(COMPANION_PLUGIN_ID))
assertRequiredCapabilities(envelope.capabilities)
const observerCapability = COMPANION_OBSERVER_CAPABILITY
if (observerCapability !== 'session.observer'
    || envelope.protocol !== COMPANION_PROTOCOL_ID
    || envelope.pluginId !== COMPANION_PLUGIN_ID
    || envelope.version !== '0.3.0'
    || !envelope.capabilities.includes(observerCapability)) {
  throw new Error('installed Companion is not the required observer-capable 0.3.0 release')
}
const record = {
  protocol: envelope.protocol,
  pluginId: envelope.pluginId,
  version: envelope.version,
  pluginGeneration: envelope.pluginGeneration,
  capabilities: envelope.capabilities,
}
const encoded = `${JSON.stringify(record)}\n`
if (Buffer.byteLength(encoded, 'utf8') > 4096) throw new Error('capability evidence exceeded its bound')
fs.writeFileSync(outputPath, encoded, { encoding: 'utf8', mode: 0o600 })
fs.chmodSync(outputPath, 0o600)
NODE
record_event companion_verified

INSTALLATION_BEFORE=$(node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --fingerprint)
[[ "$INSTALLATION_BEFORE" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'read-only Companion installation fingerprint was not a bounded digest\n' >&2
  exit 1
}
write_private "$EVIDENCE_DIR/installation-fingerprint-before.txt" "$INSTALLATION_BEFORE"
record_event fingerprint_before

write_private "$SOCKET_IDENTITY_FILE" ''
SOCKET_IDENTITY_FILE_ID=$(stat -c '%d:%i' -- "$SOCKET_IDENTITY_FILE")
[[ "$SOCKET_IDENTITY_FILE_ID" =~ ^[0-9]+:[0-9]+$ ]] || {
  printf 'could not capture the socket identity evidence file\n' >&2
  exit 1
}

printf '\nStarting the foreground observer gateway.\n'
printf 'Controls: status | pause | resume | quit\n'
record_event gateway_started
if node "${NODE_FLAGS[@]}" "$GATEWAY" \
    --live \
    --socket "$SOCKET_PATH" \
    --socket-identity-file "$SOCKET_IDENTITY_FILE" \
    --execution-node-id observer-live-local \
    --sweep-interval-ms 1000; then
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
record_event gateway_stopped

if (( GATEWAY_STATUS != 0 )); then
  write_private "$EVIDENCE_DIR/verdict.txt" \
    'ABORTED — observer gateway exited before the human-only procedure completed.'
  VERDICT_WRITTEN=1
  exit 1
fi

INSTALLATION_AFTER=$(node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --fingerprint)
[[ "$INSTALLATION_AFTER" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'post-run Companion installation fingerprint was not a bounded digest\n' >&2
  exit 1
}
write_private "$EVIDENCE_DIR/installation-fingerprint-after.txt" "$INSTALLATION_AFTER"
record_event fingerprint_after
[[ "$INSTALLATION_BEFORE" == "$INSTALLATION_AFTER" ]] || {
  write_private "$EVIDENCE_DIR/verdict.txt" \
    'FAIL — the persistent Companion installation fingerprint changed during the observer run.'
  VERDICT_WRITTEN=1
  exit 1
}
record_event fingerprint_match

write_private "$EVIDENCE_DIR/verdict.txt" \
  'PASS — human-only observer procedure completed; Companion installation fingerprint was unchanged.'
VERDICT_WRITTEN=1
printf '\nPASS. Private owner-only evidence: %s\n' "$EVIDENCE_DIR"
printf 'No live Adoption or managed-work claim was made.\n'
