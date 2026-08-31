import { makeHello } from "../lib/protocol.mjs"

export const REMOTE_IDS = Object.freeze({
  receipt: "10000000-0000-4000-8000-000000000001",
  teamGoal: "30000000-0000-4000-8000-000000000003",
  coordinator: "40000000-0000-4000-8000-000000000004",
  builder: "50000000-0000-4000-8000-000000000005",
  reviewer: "60000000-0000-4000-8000-000000000006"
})

export const REMOTE_BINDINGS = Object.freeze({
  coordinator: { agentRunId: REMOTE_IDS.coordinator, shellId: "shell-coordinator", shellRunId: "run-coordinator" },
  builder: { agentRunId: REMOTE_IDS.builder, shellId: "shell-builder", shellRunId: "run-builder" },
  reviewer: { agentRunId: REMOTE_IDS.reviewer, shellId: "shell-reviewer", shellRunId: "run-reviewer" }
})

export function bridgeHello(role, overrides = {}) {
  const binding = REMOTE_BINDINGS[role]
  return makeHello({
    teamGoalId: REMOTE_IDS.teamGoal,
    role,
    agentRunId: binding.agentRunId,
    shellId: binding.shellId,
    piSessionId: `pi-${role}`,
    extensionInstanceId: `extension-${role}`,
    pid: role === "coordinator" ? 101 : role === "builder" ? 102 : 103,
    mode: "tui",
    timestamp: 1,
    ...overrides
  })
}

export function fakeClock(start = 1) {
  let value = start
  return () => value++
}