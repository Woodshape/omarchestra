#!/usr/bin/env bash
#
# PROTOTYPE — NOT PRODUCTION.
#
# Human-only setup and live validation for the persistent Omarchestra
# Companion Plugin. This is deliberately separate from the retired
# repository-local launcher. The only unattended path is --check, which runs
# fake ports and performs no shell IPC, filesystem installation, GUI, Pi,
# provider, runner, or terminal action.
#
# Live mode installs or updates one explicitly authorized persistent plugin,
# then creates a disposable Team Runner, visible Pi hosts, and one ephemeral
# Projection Session. Runtime cleanup removes only the exact resources this
# invocation recorded. It never disables, unloads, updates, or uninstalls the
# persistent Companion Plugin.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROTOTYPE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(cd -- "$PROTOTYPE_DIR/../.." && pwd -P)
LIVE_ADAPTER="$SCRIPT_DIR/live-companion-omarchy.ts"
RUNNER_CLI="$PROTOTYPE_DIR/src/cli.ts"
ROLE_EXTENSION="$SCRIPT_DIR/live-role-label-extension.ts"
MODEL="${OMARCHESTRA_GATE_MODEL:-openai-codex/gpt-5.6-sol}"
TEAM_GOAL_ID="companion-human-gate"
CLIENT_ID="companion-human-gate-$$"
ROLES=(coordinator builder reviewer)

NODE_FLAGS=()
if node --help 2>/dev/null | grep -qE '(^|[[:space:]])--experimental-strip-types([[:space:]]|$)'; then
  NODE_FLAGS+=(--experimental-strip-types)
fi

if [[ "${1:-}" == "--check" ]]; then
  [[ "$#" -eq 1 ]] || {
    printf 'usage: %s [--check]\n' "$0" >&2
    exit 2
  }
  # This branch intentionally contains no command lookup for live tools and no
  # path under HOME. The TypeScript check builds FakeOmarchy in memory.
  [[ -f "$LIVE_ADAPTER" ]]
  [[ -f "$PROTOTYPE_DIR/companion/installation.ts" ]]
  [[ -f "$PROTOTYPE_DIR/companion/fake-omarchy.ts" ]]
  [[ -f "$PROTOTYPE_DIR/companion/contracts.ts" ]]
  [[ -f "$PROTOTYPE_DIR/companion/releases.ts" ]]
  [[ -f "$PROTOTYPE_DIR/companion/projection-session.ts" ]]
  [[ -f "$ROLE_EXTENSION" ]]
  [[ -f "$RUNNER_CLI" ]]
  bash -n "$SCRIPT_DIR/run-companion-setup-validation.sh"
  node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --check
  printf 'companion setup-validation launcher: PASS (fake-only)\n'
  exit 0
fi

if [[ "$#" -ne 0 ]]; then
  printf 'usage: %s [--check]\n' "$0" >&2
  exit 2
fi

# A live setup must be driven from a real terminal. Checking this before any
# mkdir, shell command, plugin operation, or resource launch prevents a pipe,
# CI job, or background invocation from becoming an implicit authorization.
if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'live Companion setup requires a TTY on stdin and stdout; use --check for fake-only validation\n' >&2
  exit 2
fi

for command in node omarchy-shell pacman ghostty pi hyprctl jq stat mktemp awk; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'missing live Companion prerequisite: %s\n' "$command" >&2
    exit 2
  }
done
[[ "$MODEL" =~ ^[A-Za-z0-9._~-]+/[A-Za-z0-9._:~-]+$ ]] || {
  printf 'invalid model identifier\n' >&2
  exit 2
}

umask 077
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
[[ "$STATE_HOME" == /* ]] || {
  printf 'XDG_STATE_HOME/HOME must resolve to an absolute path\n' >&2
  exit 2
}
EVIDENCE_PARENT="$STATE_HOME/omarchestra/manual-gates"
mkdir -p -- "$EVIDENCE_PARENT"
chmod 700 "$EVIDENCE_PARENT"
EVIDENCE_DIR="$EVIDENCE_PARENT/companion-$(date +%Y%m%dT%H%M%S)-$$"
mkdir -- "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"

RUNTIME_DIR=""
RUNNER_SOCKET=""
CONTROL_FIFO=""
RUNNER_PID=""
PROJECTION_PID=""
PIDS=()
PID_LABELS=()
PID_IDENTITIES=()
WINDOW_CLASSES=()
WINDOW_ADDRESSES=()
WINDOW_PIDS=()
SOCKET_IDENTITY=""
PLUGIN_READY=0
GATE_COMPLETED=0
CLEANED=0
CLEANUP_SAFE=1

write_private() {
  local file="$1" value="$2"
  printf '%s' "$value" > "$file"
  chmod 600 "$file"
}

append_private() {
  local file="$1" value="$2"
  printf '%s\n' "$value" >> "$file"
  chmod 600 "$file"
}

process_identity() {
  local pid="$1" start cmdline
  [[ -r "/proc/$pid/stat" && -r "/proc/$pid/cmdline" ]] || return 1
  start=$(awk '{print $22}' "/proc/$pid/stat")
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  cmdline="${cmdline% }"
  printf '%s\t%s' "$start" "$cmdline"
}

register_pid() {
  local pid="$1" label identity
  identity=$(process_identity "$pid") || {
    printf 'could not record exact identity for %s PID %s\n' "$label" "$pid" >&2
    return 1
  }
  PIDS+=("$pid")
  PID_LABELS+=("$label")
  PID_IDENTITIES+=("$identity")
  append_private "$EVIDENCE_DIR/resource-identities.ndjson" \
    "$(printf '%s' "{\"kind\":\"pid\",\"label\":\"$label\",\"pid\":$pid,\"identity\":$(printf '%s' "$identity" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))')}" )"
}

terminate_exact_pid() {
  local pid="$1" expected="$2" label="$3" current
  [[ -n "$pid" ]] || return 0
  if [[ ! -e "/proc/$pid" ]]; then return 0; fi
  current=$(process_identity "$pid" 2>/dev/null || true)
  if [[ "$current" != "$expected" ]]; then
    printf 'refusing to terminate %s PID %s: exact process identity drifted\n' "$label" "$pid" >&2
    return 1
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 100); do
    [[ ! -e "/proc/$pid" ]] && return 0
    current=$(process_identity "$pid" 2>/dev/null || true)
    [[ "$current" != "$expected" ]] && {
      printf 'refusing escalation for %s PID %s after identity drift\n' "$label" "$pid" >&2
      return 1
    }
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    [[ ! -e "/proc/$pid" ]] && return 0
    sleep 0.1
  done
  return 1
}

close_exact_window() {
  local class="$1" address="$2" expected_pid="$3" row current_address current_pid
  row=$(hyprctl clients -j 2>/dev/null | jq -r --arg class "$class" --arg address "$address" \
    '.[] | select(.class == $class and .address == $address) | [.address, (.pid|tostring)] | @tsv' | head -n1 || true)
  if [[ -z "$row" ]]; then return 0; fi
  IFS=$'\t' read -r current_address current_pid <<< "$row"
  if [[ "$current_address" != "$address" || "$current_pid" != "$expected_pid" ]]; then
    printf 'refusing to close window %s: exact class/address/PID identity drifted\n' "$class" >&2
    return 1
  fi
  hyprctl dispatch closewindow "address:$address" >/dev/null
}

remove_exact_socket() {
  local socket="$1" expected="$2" current
  [[ -n "$socket" ]] || return 0
  [[ -e "$socket" ]] || return 0
  [[ ! -L "$socket" && -S "$socket" ]] || {
    printf 'refusing to remove non-socket or symlink at %s\n' "$socket" >&2
    return 1
  }
  current=$(stat -c '%d:%i' -- "$socket")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove socket with changed device/inode: %s\n' "$socket" >&2
    return 1
  }
  rm -f -- "$socket"
}

remove_exact_fifo() {
  local fifo="$1"
  [[ -n "$fifo" ]] || return 0
  [[ -p "$fifo" && ! -L "$fifo" ]] || {
    [[ ! -e "$fifo" ]] && return 0
    printf 'refusing to remove changed control FIFO: %s\n' "$fifo" >&2
    return 1
  }
  rm -f -- "$fifo"
}

remove_exact_directory() {
  local directory="$1" expected current
  [[ -n "$directory" ]] || return 0
  [[ -d "$directory" && ! -L "$directory" ]] || {
    [[ ! -e "$directory" ]] && return 0
    printf 'refusing to remove changed runtime directory: %s\n' "$directory" >&2
    return 1
  }
  current=$(stat -c '%d:%i' -- "$directory")
  [[ "$current" == "$expected" ]] || {
    printf 'refusing to remove runtime directory with changed device/inode: %s\n' "$directory" >&2
    return 1
  }
  rm -rf -- "$directory"
}

cleanup() {
  local exit_status=$? index
  (( CLEANED == 0 )) || return "$exit_status"
  CLEANED=1
  set +e

  if [[ -n "$EVIDENCE_DIR" && -d "$EVIDENCE_DIR" && "$GATE_COMPLETED" -eq 0 ]]; then
    append_private "$EVIDENCE_DIR/verdict.md" "ABORTED — the human Companion validation stopped before completion."
    append_private "$EVIDENCE_DIR/verdict.md" "No installation removal is part of runtime cleanup."
  fi

  # Hide the addressed durable panel before disposing of the controller. This
  # is a supported presentation operation and does not disable or remove the
  # installed plugin or change shell.json.
  if (( PLUGIN_READY == 1 )); then
    omarchy-shell shell hide omarchestra.agent-console >/dev/null 2>&1 || CLEANUP_SAFE=0
  fi

  # Release only the exact windows found for this run, then terminate only
  # processes whose PID birth marker and complete command line still match.
  for index in "${!WINDOW_CLASSES[@]}"; do
    close_exact_window "${WINDOW_CLASSES[$index]}" "${WINDOW_ADDRESSES[$index]}" "${WINDOW_PIDS[$index]}" || CLEANUP_SAFE=0
  done
  for (( index=${#PIDS[@]}-1; index>=0; index-- )); do
    terminate_exact_pid "${PIDS[$index]}" "${PID_IDENTITIES[$index]}" "${PID_LABELS[$index]}" || CLEANUP_SAFE=0
  done
  remove_exact_socket "$RUNNER_SOCKET" "$SOCKET_IDENTITY" || CLEANUP_SAFE=0
  remove_exact_fifo "$CONTROL_FIFO" || CLEANUP_SAFE=0

  # The directory identity is captured immediately after mktemp. A changed
  # path is preserved for manual reconciliation instead of recursively
  # deleting an unrelated directory. This is the only recursive removal.
  if [[ -n "$RUNTIME_DIR" ]]; then
    runtime_identity=$(stat -c '%d:%i' -- "$RUNTIME_DIR" 2>/dev/null || true)
    if [[ -n "${RUNTIME_IDENTITY:-}" && "$runtime_identity" != "$RUNTIME_IDENTITY" ]]; then
      printf 'preserving runtime directory after identity drift: %s\n' "$RUNTIME_DIR" >&2
      CLEANUP_SAFE=0
    else
      remove_exact_directory "$RUNTIME_DIR" "${RUNTIME_IDENTITY:-}" || CLEANUP_SAFE=0
    fi
  fi

  if (( CLEANUP_SAFE == 0 )); then
    append_private "$EVIDENCE_DIR/verdict.md" "Exact cleanup incomplete; changed resources were preserved."
    exit_status=1
  fi
  return "$exit_status"
}
trap cleanup EXIT INT TERM

# Compatibility and plan authorization happen before this point creates any
# runner, socket, Pi process, Ghostty window, or Projection Session.
node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --live --evidence-dir "$EVIDENCE_DIR"
PLUGIN_READY=1
write_private "$EVIDENCE_DIR/runtime-boundary.txt" \
  "Runtime cleanup owns only exact runner/Pi/Ghostty/projection/socket/directory identities.\nPersistent plugin: untouched by runtime cleanup.\n"

RUNTIME_DIR=$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/omarchestra-companion-gate.XXXXXX")
chmod 700 "$RUNTIME_DIR"
RUNTIME_IDENTITY=$(stat -c '%d:%i' -- "$RUNTIME_DIR")
mkdir -- "$RUNTIME_DIR/sessions" "$RUNTIME_DIR/state"
chmod 700 "$RUNTIME_DIR/sessions" "$RUNTIME_DIR/state"
CONTROL_FIFO="$RUNTIME_DIR/projection-control.fifo"
mkfifo "$CONTROL_FIFO"
chmod 600 "$CONTROL_FIFO"
RUNNER_SOCKET="$RUNTIME_DIR/state/runner.sock"

cat > "$RUNTIME_DIR/pi-host.sh" <<'HOST'
#!/usr/bin/env bash
set -euo pipefail
role="$1"
runtime="$2"
extension="$3"
model="$4"
printf '%s\n' "$$" > "$runtime/$role.pid"
chmod 600 "$runtime/$role.pid"
while [[ ! -e "$runtime/start-pi" ]]; do sleep 0.05; done
session_id=$(<"$runtime/$role.session-id")
exec env \
  OMARCHESTRA_TEAM_GOAL_ID="companion-human-gate" \
  OMARCHESTRA_ROLE="$role" \
  OMARCHESTRA_AGENT_RUN_ID="companion-human-$role-run" \
  OMARCHESTRA_EXTENSION_INSTANCE_ID="companion-human-$role-extension" \
  OMARCHESTRA_TERMINAL_SESSION_REF="companion-human-$role-terminal" \
  OMARCHESTRA_SHELL_RUN_ID="companion-human-$role-shell" \
  OMARCHESTRA_PI_SESSION_ID="$session_id" \
  OMARCHESTRA_BRIDGE_SOCKET="$runtime/state/runner.sock" \
  OMARCHESTRA_GATE_STATUS_FILE="$runtime/$role.status.json" \
  pi --no-extensions --no-approve --no-context-files --no-tools \
    --model "$model" --thinking minimal \
    --session-id "$session_id" --session-dir "$runtime/sessions/$role" \
    -e "$extension"
HOST
chmod 700 "$RUNTIME_DIR/pi-host.sh"

for role in "${ROLES[@]}"; do
  mkdir -- "$RUNTIME_DIR/sessions/$role"
  chmod 700 "$RUNTIME_DIR/sessions/$role"
  session_id=$(node -e "process.stdout.write(require('node:crypto').randomUUID())")
  write_private "$RUNTIME_DIR/$role.session-id" "$session_id\n"
  class="com.omarchestra.CompanionGate.$role"
  ghostty \
    --class="$class" \
    --window-decoration=none \
    -e "$RUNTIME_DIR/pi-host.sh" "$role" "$RUNTIME_DIR" "$ROLE_EXTENSION" "$MODEL" \
    >> "$EVIDENCE_DIR/ghostty-launch.log" 2>&1 &
  launcher_pid=$!
  register_pid "$launcher_pid" "Ghostty $role"
done

for role in "${ROLES[@]}"; do
  pid_file="$RUNTIME_DIR/$role.pid"
  for _ in $(seq 1 150); do [[ -s "$pid_file" ]] && break; sleep 0.1; done
  [[ -s "$pid_file" ]] || { printf '%s Pi host did not publish a PID\n' "$role" >&2; exit 1; }
done

BOOTSTRAP_JSON=$(RUNTIME_DIR="$RUNTIME_DIR" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const runtime = process.env.RUNTIME_DIR
const roles = ['coordinator', 'builder', 'reviewer'].map((role) => ({
  role,
  agentRunId: `companion-human-${role}-run`,
  terminalSessionRef: `companion-human-${role}-terminal`,
  shellRunId: `companion-human-${role}-shell`,
  piSessionId: fs.readFileSync(path.join(runtime, `${role}.session-id`), 'utf8').trim(),
  extensionInstanceId: `companion-human-${role}-extension`,
  hostPid: Number(fs.readFileSync(path.join(runtime, `${role}.pid`), 'utf8').trim()),
}))
process.stdout.write(JSON.stringify({
  teamGoalId: 'companion-human-gate',
  goalText: 'Human validation of one persistent Companion Plugin and one ephemeral Projection Session.',
  roles,
  assignment: {
    id: 'companion-human-builder-assignment',
    role: 'builder',
    agentRunId: 'companion-human-builder-run',
    prompt: 'Reply with exactly: COMPANION MANAGED BUILDER TURN COMPLETE',
  },
}))
NODE
)

node "${NODE_FLAGS[@]}" "$RUNNER_CLI" \
  --state-dir "$RUNTIME_DIR/state" \
  --socket-name runner.sock \
  --journal default \
  --bootstrap-json "$BOOTSTRAP_JSON" \
  > "$EVIDENCE_DIR/runner.ndjson" 2>&1 &
RUNNER_PID=$!
register_pid "$RUNNER_PID" "foreground Team Runner"
chmod 600 "$EVIDENCE_DIR/runner.ndjson"

for _ in $(seq 1 150); do [[ -S "$RUNNER_SOCKET" ]] && break; sleep 0.1; done
[[ -S "$RUNNER_SOCKET" ]] || { printf 'runner socket did not become ready\n' >&2; exit 1; }
[[ ! -L "$RUNNER_SOCKET" ]] || { printf 'runner socket unexpectedly became a symlink\n' >&2; exit 1; }
SOCKET_IDENTITY=$(stat -c '%d:%i' -- "$RUNNER_SOCKET")

# Start the projection controller only after setup and all exact runtime
# identities are available. It uses UnixProjectionConnector and the live
# CompanionShellPort, never a temporary plugin registration.
node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --projection \
  --socket "$RUNNER_SOCKET" \
  --control "$CONTROL_FIFO" \
  --evidence "$EVIDENCE_DIR" \
  --team-goal "$TEAM_GOAL_ID" \
  --client-id "$CLIENT_ID" \
  > "$EVIDENCE_DIR/projection-controller.stdout" 2>&1 &
PROJECTION_PID=$!
register_pid "$PROJECTION_PID" "Projection Session controller"
chmod 600 "$EVIDENCE_DIR/projection-controller.stdout"

# Pi hosts are released only after the runner and projection controller exist.
touch "$RUNTIME_DIR/start-pi"
chmod 600 "$RUNTIME_DIR/start-pi"

for role in "${ROLES[@]}"; do
  pi_pid=$(<"$RUNTIME_DIR/$role.pid")
  register_pid "$pi_pid" "Pi $role"
done

for role in "${ROLES[@]}"; do
  class="com.omarchestra.CompanionGate.$role"
  row=""
  for _ in $(seq 1 100); do
    row=$(hyprctl clients -j | jq -r --arg class "$class" \
      '.[] | select(.class == $class) | [.address, (.pid|tostring)] | @tsv' | head -n1 || true)
    [[ -n "$row" ]] && break
    sleep 0.1
  done
  [[ -n "$row" ]] || { printf 'window did not appear for %s\n' "$role" >&2; exit 1; }
  IFS=$'\t' read -r address window_pid <<< "$row"
  WINDOW_CLASSES+=("$class")
  WINDOW_ADDRESSES+=("$address")
  WINDOW_PIDS+=("$window_pid")
done

wait_for_projection() {
  local coordinator="$1" builder="$2" reviewer="$3" role expected
  for _ in $(seq 1 450); do
    if [[ -s "$EVIDENCE_DIR/projection.json" ]] && jq -e \
      --arg coordinator "$coordinator" --arg builder "$builder" --arg reviewer "$reviewer" '
        .status == "ready" and
        ([.cards[] | select(.role == "coordinator" and .piStatus == $coordinator)] | length) == 1 and
        ([.cards[] | select(.role == "builder" and .piStatus == $builder)] | length) == 1 and
        ([.cards[] | select(.role == "reviewer" and .piStatus == $reviewer)] | length) == 1
      ' "$EVIDENCE_DIR/projection.json" >/dev/null 2>&1; then
      for role in "${ROLES[@]}"; do
        case "$role" in
          coordinator) expected="$coordinator" ;;
          builder) expected="$builder" ;;
          reviewer) expected="$reviewer" ;;
        esac
        [[ -s "$RUNTIME_DIR/$role.status.json" ]] || { expected=""; break; }
        jq -e --arg role "$role" --arg expected "$expected" \
          '.role == $role and .piStatus == $expected' \
          "$RUNTIME_DIR/$role.status.json" >/dev/null 2>&1 || { expected=""; break; }
      done
      [[ -n "$expected" ]] && return 0
    fi
    sleep 0.1
  done
  return 1
}

send_projection_control() {
  printf '%s\n' "$1" > "$CONTROL_FIFO"
}

record_checkpoint() {
  local name="$1"
  cp -- "$EVIDENCE_DIR/projection.json" "$EVIDENCE_DIR/checkpoint-$name-projection.json"
  chmod 600 "$EVIDENCE_DIR/checkpoint-$name-projection.json"
  for role in "${ROLES[@]}"; do
    cp -- "$RUNTIME_DIR/$role.status.json" "$EVIDENCE_DIR/checkpoint-$name-$role-presentation.json"
    chmod 600 "$EVIDENCE_DIR/checkpoint-$name-$role-presentation.json"
  done
}

confirm() {
  local question="$1" answer
  printf '%s [y/N] ' "$question"
  read -r answer || true
  [[ "$answer" =~ ^[Yy]$ ]]
}

wait_for_projection waiting waiting waiting || { printf 'initial authoritative projection did not arrive\n' >&2; exit 1; }
record_checkpoint initial
append_private "$EVIDENCE_DIR/observations.md" "initial: Pi and Companion projection show Coordinator · waiting, Builder · waiting, Reviewer · waiting"
confirm 'Do the three decorationless Pi statuses and the three Agent Console cards agree exactly at waiting?' || exit 1

printf '\nFocus the Builder Pi and enter exactly: /omarchestra-start\n'
printf 'Wait for the managed assignment to complete, then press Enter here.\n'
read -r _ || true
wait_for_projection waiting managed waiting || { printf 'managed Builder projection did not arrive\n' >&2; exit 1; }
record_checkpoint managed
append_private "$EVIDENCE_DIR/observations.md" "managed: Builder is managed; Coordinator and Reviewer remain waiting"
confirm 'Does only the Builder show the managed state on both Pi and Agent Console?' || exit 1

printf '\nFocus the Builder Pi and enter exactly: Manual takeover check\n'
printf 'Press Enter here after the takeover status is visible.\n'
read -r _ || true
wait_for_projection waiting manual_takeover waiting || { printf 'manual_takeover projection did not arrive\n' >&2; exit 1; }
record_checkpoint takeover
append_private "$EVIDENCE_DIR/observations.md" "takeover: Builder is manual_takeover; sibling roles remain waiting"
confirm 'Does only the Builder show manual_takeover on both surfaces?' || exit 1

for remaining in 60 45 30 15; do
  printf '%s seconds of persistence remaining\n' "$remaining"
  sleep 15
done
wait_for_projection waiting manual_takeover waiting || { printf 'projection changed during persistence interval\n' >&2; exit 1; }
record_checkpoint persisted
confirm 'After one minute, are all exact Pi and Agent Console labels still present and distinct?' || exit 1

# Reload is an explicit supported rescan, followed by a new Projection Session
# and a fresh authoritative runner snapshot. The plugin remains installed.
jq -cS '.cards' "$EVIDENCE_DIR/projection.json" > "$RUNTIME_DIR/cards-before-reload.json"
chmod 600 "$RUNTIME_DIR/cards-before-reload.json"
rm -f -- "$EVIDENCE_DIR/projection-reloaded" "$EVIDENCE_DIR/projection-ready"
send_projection_control reload
for _ in $(seq 1 300); do [[ -f "$EVIDENCE_DIR/projection-reloaded" ]] && break; sleep 0.1; done
[[ -f "$EVIDENCE_DIR/projection-reloaded" ]] || { printf 'plugin reload did not produce a fresh Projection Session\n' >&2; exit 1; }
wait_for_projection waiting manual_takeover waiting || { printf 'reloaded projection did not reconstruct exact cards\n' >&2; exit 1; }
jq -cS '.cards' "$EVIDENCE_DIR/projection.json" > "$RUNTIME_DIR/cards-after-reload.json"
chmod 600 "$RUNTIME_DIR/cards-after-reload.json"
cmp -s "$RUNTIME_DIR/cards-before-reload.json" "$RUNTIME_DIR/cards-after-reload.json" || {
  printf 'reloaded projection cards differ from the authoritative cards before reload\n' >&2
  exit 1
}
record_checkpoint reloaded
confirm 'Did the supported rescan recover identical cards without interrupting the three agent identities?' || exit 1

INSTALLATION_BEFORE=$(node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --fingerprint)
write_private "$EVIDENCE_DIR/installation-fingerprint-before-runtime.txt" "$INSTALLATION_BEFORE\n"
send_projection_control clear
for _ in $(seq 1 100); do [[ -f "$EVIDENCE_DIR/projection-cleared" ]] && break; sleep 0.1; done
[[ -f "$EVIDENCE_DIR/projection-cleared" ]] || { printf 'Projection Session clear did not complete\n' >&2; exit 1; }
send_projection_control hide
for _ in $(seq 1 100); do [[ -f "$EVIDENCE_DIR/projection-hidden" ]] && break; sleep 0.1; done
[[ -f "$EVIDENCE_DIR/projection-hidden" ]] || { printf 'Projection Session hide did not complete\n' >&2; exit 1; }
INSTALLATION_AFTER=$(node "${NODE_FLAGS[@]}" "$LIVE_ADAPTER" --fingerprint)
write_private "$EVIDENCE_DIR/installation-fingerprint-after-runtime.txt" "$INSTALLATION_AFTER\n"
[[ "$INSTALLATION_BEFORE" == "$INSTALLATION_AFTER" ]] || {
  printf 'runtime cleanup changed the persistent plugin, receipt, or shell configuration\n' >&2
  exit 1
}

send_projection_control quit || true
GATE_COMPLETED=1
write_private "$EVIDENCE_DIR/verdict.md" \
  "PASS — persistent Companion installation survived Projection Session clear/hide and exact runtime cleanup.\n"
append_private "$EVIDENCE_DIR/verdict.md" "Live visual agreement was confirmed by the operator; evidence contains structured labels only."
printf '\nPASS. Private owner-only evidence: %s\n' "$EVIDENCE_DIR"
printf 'The persistent Companion Plugin was not removed by runtime cleanup.\n'
