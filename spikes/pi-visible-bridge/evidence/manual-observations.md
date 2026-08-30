# Manual visible-TUI observations

Date: 2026-08-30  
Classification: **supported with constraints**

## Environment

- Pi 0.84.4
- Interactive command: `pi -e ./spikes/pi-visible-bridge/extension.ts`
- Agent Run ID: `visible-spike-agent`
- Extension instance ID: `visible-spike-extension`
- Pi session ID: `01a0544d-856c-7407-8b88-bf2cc33e48a8`
- Visible Pi PID: `98226`

## Observed results

1. The runner accepted a TUI-mode handshake from PID `98226`.
2. The managed assignment appeared and executed in the interactive host Pi session.
3. The visible agent used the `read` tool and replied `VISIBLE BRIDGE ASSIGNMENT COMPLETE`.
4. The attention probe visibly required and resolved confirmation; runner events recorded sequences 38–39.
5. Submitting `Human takeover probe` produced `human_message_submitted` and `manual_takeover` at sequences 40–41. The visible agent replied `HUMAN TAKEOVER ACKNOWLEDGED`.
6. The runner was stopped and restarted while Pi PID `98226` remained alive.
7. The same Pi session and extension instance reconnected, emitted `bridge_reconnected`, and supplied a state snapshot preserving `manual_takeover` plus the settled assignment.
8. Resending `visible-spike-1` produced `duplicate` and did not execute a second time.
9. A second attention probe succeeded after reconnect at sequences 64–65.
10. Process-tree inspection found one visible Pi process with threads and no descendant Pi agent. The separate Node runner and an unrelated pre-existing Pi process were expected.

## Evidence

- [`manual-runner.ndjson`](manual-runner.ndjson) — 78 ordered runner records across initial connection and restart
- [`manual-process-tree.txt`](manual-process-tree.txt) — PID, session, process-tree, and Pi/runner listing

## Constraints discovered manually

- `message_started`, `message_updated`, and `message_ended` currently expose excessive content. In particular, a `toolResult` message published the complete contents returned by the `read` tool even though raw tool-result telemetry was intended to be excluded.
- Token-level `message_updated` events are too high-volume for the production runner or QML projection.
- Production telemetry must omit tool-result bodies, omit thinking content, define explicit user/assistant message policy, and coalesce or discard streaming deltas.
- Slash commands and user-bash takeover detection remain unproven.
- Attention evidence covers extension-owned UI confirmation, not every native Pi/provider/authentication prompt.
- Recovery covers runner restart while the same Pi extension instance survives. Pi restart, extension reload, durable event replay, and full-reboot recovery remain unsupported.
