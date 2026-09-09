#!/usr/bin/env bash
#
# PROTOTYPE — NOT PRODUCTION.
#
# Human-only procedure for the additive retirement-and-replacement slice. This
# script never opens a socket, launches Pi, a provider, a desktop, SSH, Boomux,
# or systemd. It is a checklist and evidence writer for the operator who has
# already completed `just prototype-live-adoption-bridge --live`, observed one
# committed Agent Run, and then taken the visible Pi process offline.
#
# The --check path is fake/static only and never reads user state or contacts
# the Adoption gateway or Companion.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROTOTYPE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(cd -- "$PROTOTYPE_DIR/../.." && pwd -P)

if [[ "${1:-}" == "--check" ]]; then
  [[ "$#" -eq 1 ]] || {
    printf 'usage: %s [--check|--live]\n' "$0" >&2
    exit 2
  }
  [[ -f "$SCRIPT_DIR/live-adoption-gateway.ts" ]]
  [[ -f "$SCRIPT_DIR/live-retirement-store.ts" ]]
  [[ -f "$PROTOTYPE_DIR/console/plugin/RetiredAgentCards.qml" ]]
  bash -n "$0"
  printf 'retirement/replacement gate launcher: PASS (fake-only)\n'
  exit 0
fi

if [[ "${1:-}" != "--live" || "$#" -ne 1 ]]; then
  printf 'usage: %s [--check|--live]\n' "$0" >&2
  exit 2
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  printf 'retirement/replacement gate requires a TTY on stdin and stdout; use --check for fake-only validation\n' >&2
  exit 2
fi

for command in mktemp stat mkdir rmdir chmod cat rm; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'missing retirement/replacement prerequisite: %s\n' "$command" >&2
    exit 2
  }
done

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
EVIDENCE_PARENT="$STATE_HOME/omarchestra/retirement-replacement-gates"
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

EVIDENCE_DIR=$(mktemp -d -- "$EVIDENCE_PARENT/retirement-XXXXXX")
EVIDENCE_IDENTITY=""
HUMAN_CONFIRMED=0
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

cleanup() {
  local exit_status=$?
  (( CLEANED == 0 )) || return "$exit_status"
  CLEANED=1
  set +e
  if (( VERDICT_WRITTEN == 0 )); then
    if (( CLEANUP_SAFE == 1 )) && (( HUMAN_CONFIRMED == 1 )); then
      write_private "$EVIDENCE_DIR/verdict.txt" \
        'PASS — human-only retirement/replacement and terminal-history purge checklist completed; lineage cleanup confirmed, no automatic assignment dispatched.' || true
    elif (( CLEANUP_SAFE == 0 )); then
      write_private "$EVIDENCE_DIR/verdict.txt" 'FAIL — evidence directory cleanup was incomplete.' || true
      exit_status=1
    else
      write_private "$EVIDENCE_DIR/verdict.txt" \
        'INCOMPLETE — operator did not confirm every retirement/replacement observation.' || true
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

PROCEDURE_TEXT=$(cat <<'EOF'
# Human-only retirement/replacement checklist

Pre-conditions. You have already completed `just prototype-live-adoption-bridge
--live`, observed exactly one committed Agent Run in the Companion console, and
taken the visible Pi process offline. The Retirement & Replacement slice is
additive and never modifies historical Adoption facts. Do not record prompts,
responses, input, tool names, terminal output, repository content, credentials,
cwd, title, focus, provider/model values, or raw errors. Record only the
bounded phase labels below.

1. Disconnect visibility: confirm the previously committed Agent Run is now
   shown as Disconnected in the Companion managed cards. Do not type any
   process-stop command yet.
2. Select the disconnected Run: in the Companion console, select the
   disconnected Agent Run and choose Retire Agent Run. Confirm the dialog
   names the exact Team Goal and Role from the previously committed fact.
3. Process-stop warning: confirm the dialog shows a process-stop warning and
   a confirm button labeled Retire irreversibly. Type the literal confirmation
   phrase printed by the dialog, not any free-text substitute.
4. Retirement committed: confirm the managed card moves to a Retired subtext
   in the additive RetiredAgentCards surface and the Adoption sink reports
   zero new commitments. Do not auto-retire on lease expiry: leave the gate
   idle for at least one lease interval and confirm no silent retirement
   occurs.
5. New Pi launch: from a separate ordinary terminal, run the visible Pi
   command printed by the launcher. Wait for the Companion Unassigned Agents
   panel to display the new Unassigned · observed session exactly once.
6. Replacement Adoption: in the Companion Unassigned Agents panel, select the
   same vacant Role and confirm the exact proposal. Confirm the
   same-process acknowledgement and that the new managed Run carries an
   `Adopted · <Role>` state with the exact predecessor Agent Run id recorded.
7. No dispatch: confirm Omarchestra dispatched zero Assignments in this flow.
   The visible Pi process remains the only source of work; the new Run owns
   the same Project as the predecessor only by explicit confirm-and-ack.
8. Terminal purge: after the replacement is disconnected, retire it. Confirm
   the predecessor card explains that its successor must be deleted first.
   Delete the retired successor, then delete the predecessor. Confirm both
   retired cards disappear, the Role remains vacant, and the visible Pi
   sessions/processes are unchanged.
9. Persistence: close the Companion and re-open it. Confirm the purged cards
   remain absent and no stale replacement proposal can recreate the lineage.

When every observation above is confirmed, the script asks:

  Run Omarchestra Retirement/Replacement gate? y/N    (N is the default)

Type y or Y to mark the verdict PASS. Anything else is INCOMPLETE. The launcher
never launches Pi or dispatches work. It writes only the bounded phase labels
above.
EOF
)
write_private "$EVIDENCE_DIR/procedure.md" "$PROCEDURE_TEXT"
append_private "$EVIDENCE_DIR/retirement-events.ndjson" '{"phase":"procedure_ready"}'

printf '\nHuman-only retirement/replacement procedure\n'
printf '%s\n' "$PROCEDURE_TEXT"

printf '\nConfirm every checklist observation above (steps 1-9).\n'
printf 'Run Omarchestra Retirement/Replacement gate? y/N (N is the default):\n> '
read -r confirmation || confirmation=''
if [[ "$confirmation" == 'y' || "$confirmation" == 'Y' ]]; then
  HUMAN_CONFIRMED=1
  append_private "$EVIDENCE_DIR/retirement-events.ndjson" '{"phase":"operator_confirmed"}'
fi

printf '\nRetirement/replacement gate finished; verdict written to the evidence directory.\n'
