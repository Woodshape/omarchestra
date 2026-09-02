#!/usr/bin/env bash
#
# PROTOTYPE — NOT PRODUCTION.
#
# Human-only combined live Agent Console gate launcher — FAIL CLOSED.
#
# The installed Omarchy shell has no supported repo-local ephemeral plugin
# loader: third-party plugins are discovered only under the user's plugin
# configuration directory, enablement persists user shell configuration, and
# summon accepts only discovered enabled IDs. The exact installed-API evidence,
# the forbidden fallbacks, and the required upstream capability are recorded in
# docs/live-agent-console-launch-blocker.md inside this prototype.
#
# Therefore this launcher always fails closed BEFORE it would start or contact
# a runner, visible agent host, terminal emulator, desktop compositor action,
# model provider, terminal runtime, remote transport, service manager, or any
# desktop shell/UI process. It never creates a scratch directory, socket, PID
# record, or window of its own. The completed terminal-side human evidence
# remains `just prototype-vertical-slice-role-label-gate`.
#
# Modes:
#   --check   fake-only static contract check (used by automated gates)
#   (none)    human gate path: reports the recorded launch blocker and exits 1
#
# This launcher never adds a Ghostty title option and never changes the
# existing decorationless role-label launcher.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PROTOTYPE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
GATE_SCRIPT="$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
BLOCKER_DOC="$PROTOTYPE_DIR/docs/live-agent-console-launch-blocker.md"
RUN_REPORT="$PROTOTYPE_DIR/docs/live-agent-console-run-report.md"
REGISTRY_MODULE="$SCRIPT_DIR/live-gate-resources.ts"
BLOCKER_DOC_RELATIVE="prototypes/first-vertical-slice/docs/live-agent-console-launch-blocker.md"
ROLE_LABEL_GATE_RECIPE="prototype-vertical-slice-role-label-gate"

# The single upstream capability that would unblock the combined live gate is
# recorded in the blocker report: an ephemeral, non-mutating, repo-local
# plugin registration with exact unregister/cleanup semantics.
REQUIRED_CAPABILITY="registerTemporaryPlugin"

check_mode() {
  # Fake-only static contract check. Never contacts or launches any live
  # system; validates only that the fail-closed contract materials exist.
  local failed=0
  local file
  for file in "$BLOCKER_DOC" "$RUN_REPORT" "$REGISTRY_MODULE" "$GATE_SCRIPT"; do
    if [[ ! -e "$file" ]]; then
      printf 'missing required contract file: %s\n' "$file" >&2
      failed=1
    fi
  done
  bash -n "$GATE_SCRIPT" || { printf 'combined gate script has a syntax error\n' >&2; failed=1; }

  NODE_FLAGS=()
  if node --help | grep -q -- '--experimental-strip-types'; then
    NODE_FLAGS+=(--experimental-strip-types)
  fi
  if ! node "${NODE_FLAGS[@]}" -e "import('$REGISTRY_MODULE')"; then
    printf 'fake resource registry module does not import cleanly\n' >&2
    failed=1
  fi

  if (( failed == 0 )); then
    printf 'live agent console launcher static check: PASS (fake-only)\n'
  fi
  return "$failed"
}

report_blocker() {
  cat <<'BLOCKED'

  Omarchestra live Agent Console gate — BLOCKED (fail closed)

  The installed Omarchy shell has no supported way to load and summon a
  repository-local, temporary Agent Console plugin without writing under the
  user's Omarchy configuration. This run must not mutate user configuration,
  so the combined live gate cannot start here.

  It has exited before creating or contacting any live resource: no runner,
  no visible agent host, no terminal emulator, no provider request, no
  compositor action, no terminal-runtime or remote transport, no service
  manager, and no desktop shell or UI process was started.

  What exists today:

    - Terminal-side human evidence (completed):
        just prototype-vertical-slice-role-label-gate
      It proves the three decorationless visible Pi hosts, their persistent
      Pi status labels, managed/manual-takeover transitions, sibling
      isolation, and one-minute persistence, with exact cleanup.

    - Fake-only Agent Console proof (unattended):
        just prototype-vertical-slice
        just prototype-live-agent-console-check
      Projection adapter, thin QML cards, launcher contract, failure cleanup,
      and source audits — all fake-only.

  Why this launcher cannot proceed, and the smallest upstream capability
  that would unblock it, are recorded in:

    prototypes/first-vertical-slice/docs/live-agent-console-launch-blocker.md

  Do not work around this blocker by installing a plugin copy, editing user
  configuration, or launching a substitute window: those fallbacks are
  explicitly rejected in the blocker report.

BLOCKED
}

if [[ "${1:-}" == "--check" ]]; then
  check_mode
  exit $?
fi

# ---------------------------------------------------------------------------
# Human-authorized live path. On the installed Omarchy API this must fail
# closed BEFORE any resource creation, so there is deliberately no launch
# logic below: no runner, no visible agent host, no terminal window, no
# provider request, no compositor action, no runtime/remote transport, no
# service manager, and no desktop shell/UI process is ever started here.
# ---------------------------------------------------------------------------

printf '\nOmarchestra live Agent Console gate (HUMAN-AUTHORIZED ONLY)\n\n'
printf 'The combined live gate checks the upstream ephemeral plugin capability first.\n\n'

if [[ "${OMARCHESTRA_EPHEMERAL_PLUGIN_CAPABILITY:-}" == "$REQUIRED_CAPABILITY" ]]; then
  # Even a claimed capability does not authorize this launcher: the supported
  # API is not implemented by the installed shell, and this file must be
  # updated by the upstream capability spike before any live run is attempted.
  printf 'A capability flag named "%s" is set, but the recorded blocker has not\n' "$REQUIRED_CAPABILITY"
  printf 'been cleared by an upstream capability spike. Refusing to proceed.\n'
  report_blocker
  exit 1
fi

printf 'Required upstream capability "%s" is not provided by the installed shell.\n' "$REQUIRED_CAPABILITY"
printf 'The combined live gate therefore cannot run on this installation.\n'
report_blocker
printf '\nCompleted terminal-side human gate (run it explicitly if you want that evidence):\n'
printf '  just %s\n' "$ROLE_LABEL_GATE_RECIPE"
printf '\nFull blocker report with the required next upstream capability:\n'
printf '  %s\n' "$BLOCKER_DOC_RELATIVE"
printf '\nAutomated validation of this fail-closed contract (fake-only): --check\n\n'

exit 1