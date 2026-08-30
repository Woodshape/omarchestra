import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBridgeState,
  createHello,
  createStateSnapshot,
  evaluateAssignment,
  makeInvalidAssignmentAcknowledgement,
  markAssignmentSettled,
  markAssignmentStarted,
  markConnected,
  markDisconnected,
  nextEvent,
  observeSubmittedInput,
} from "./lib/state.mjs";
import { ReconnectingBridgeClient } from "./lib/client.mjs";

export function classifyInputSource(source: unknown): "submitted-human" | "extension" | "other" {
  if (source === "interactive") return "submitted-human";
  if (source === "extension") return "extension";
  return "other";
}

function idFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : fallback;
}

function observableContent(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap((block) => {
    if (!block || typeof block !== "object" || block.type === "thinking") return [];
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "image") return [{ type: "image", mimeType: block.mimeType ?? block.source?.mediaType }];
    if (block.type === "toolCall") return [{ type: "toolCall", id: block.id, name: block.name }];
    return [{ type: String(block.type ?? "unknown") }];
  });
}

function messageData(message: any) {
  if (!message || typeof message !== "object") return { value: message };
  return {
    role: message.role,
    customType: message.customType,
    toolName: message.toolName,
    content: observableContent(message.content),
  };
}

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let state: any;
  let client: ReconnectingBridgeClient | undefined;
  let closed = false;

  const emit = (eventType: string, data: unknown = {}, assignmentId?: string) => {
    if (!state || closed) return;
    const result = nextEvent(state, eventType as any, data, { assignmentId });
    state = result.state;
    client?.send(result.event);
  };

  const sendSnapshot = () => {
    if (state && client) client.send(createStateSnapshot(state));
  };

  const acceptAssignment = (assignment: any) => {
    if (!state || closed) return;
    if (context?.mode !== "tui") {
      client?.send(makeInvalidAssignmentAcknowledgement(assignment.assignmentId, "visible TUI mode is required"));
      return;
    }
    const result = evaluateAssignment(state, assignment, { isIdle: context.isIdle() });
    state = result.state;
    client?.send(result.acknowledgement);
    if (result.acknowledgement.status !== "accepted") return;
    emit("assignment_started", { promptCharacters: assignment.prompt.length }, assignment.assignmentId);
    try {
      pi.sendUserMessage(assignment.prompt);
    } catch (error) {
      emit("assignment_needs_reconciliation", { reason: String(error) }, assignment.assignmentId);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    closed = false;
    if (ctx.mode !== "tui") {
      ctx.ui.notify("visible Pi bridge requires TUI mode", "error");
      return;
    }
    const agentRunId = idFromEnv("OMARCHESTRA_AGENT_RUN_ID", "spike-agent");
    const extensionInstanceId = idFromEnv("OMARCHESTRA_EXTENSION_INSTANCE_ID", `bridge-${process.pid}`);
    const socketPath = process.env.OMARCHESTRA_BRIDGE_SOCKET;
    if (!socketPath) {
      ctx.ui.notify("OMARCHESTRA_BRIDGE_SOCKET is not set", "error");
      return;
    }
    state = createBridgeState({ agentRunId, piSessionId: idFromEnv("OMARCHESTRA_PI_SESSION_ID", ctx.sessionManager.getSessionId()), extensionInstanceId });
    client = new ReconnectingBridgeClient({
      socketPath,
      makeHello: () => createHello(state),
      onState: (kind: string, detail?: any) => {
        if (kind === "connected") {
          const result = markConnected(state);
          state = result.state;
          if (result.eventType) emit(result.eventType, {});
          if (state.connectionCount === 1) emit("session_started", { mode: ctx.mode });
          sendSnapshot();
        } else if (kind === "disconnected") {
          const result = markDisconnected(state);
          state = result.state;
          if (result.eventType) emit(result.eventType, {});
        }
      },
      onMessage: (message: any) => {
        if (message.type === "assignment") acceptAssignment(message);
      },
    });
    client.start();
  });

  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    if (state) {
      const result = nextEvent(state, "session_shutdown", {});
      state = result.state;
      client?.send(result.event);
    }
    client?.close();
    client = undefined;
    context = undefined;
  });

  pi.on("input", async (event, _ctx) => {
    if (classifyInputSource(event.source) !== "submitted-human") return;
    if (!state || closed) return;
    const result = observeSubmittedInput(state, event.source);
    state = result.state;
    if (!result.takeover) return;
    emit("human_message_submitted", { characters: event.text.length });
    emit("manual_takeover", { reason: "submitted interactive input" });
  });

  pi.on("agent_start", async () => {
    if (state?.assignment?.state === "accepted") state = markAssignmentStarted(state);
    emit("agent_started", {});
  });
  pi.on("agent_end", async (event) => emit("agent_ended", { messageCount: event.messages?.length ?? 0 }));
  pi.on("agent_settled", async () => {
    if (state?.assignment && (state.assignment.state === "accepted" || state.assignment.state === "working")) {
      state = markAssignmentSettled(state);
      emit(state.controlMode === "manual_takeover" ? "assignment_needs_reconciliation" : "assignment_settled", {});
    }
    emit("agent_settled", {});
  });
  pi.on("message_start", async (event) => emit("message_started", messageData(event.message)));
  pi.on("message_update", async (event) => {
    const update = event.assistantMessageEvent;
    if (update?.type === "thinking_delta") return;
    emit("message_updated", {
      message: messageData(event.message),
      update: update?.type === "text_delta" ? { type: update.type, delta: update.delta } : { type: update?.type },
    });
  });
  pi.on("message_end", async (event) => emit("message_ended", messageData(event.message)));
  pi.on("tool_execution_start", async (event) => emit("tool_started", { toolCallId: event.toolCallId, toolName: event.toolName }));
  pi.on("tool_execution_update", async (event) => emit("tool_updated", { toolCallId: event.toolCallId, toolName: event.toolName }));
  pi.on("tool_execution_end", async (event) => emit("tool_ended", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }));
  pi.on("ui_prompt_start", async (event) => emit("attention_required", {
    owner: "agent",
    reason: event.reason,
    kind: event.kind,
    title: event.title,
  }));
  pi.on("ui_prompt_end", async (event) => emit("attention_resolved", {
    owner: "agent",
    reason: event.reason,
    kind: event.kind,
    title: event.title,
  }));

  pi.registerCommand("bridge-attention-probe", {
    description: "Exercise bridge attention telemetry with a visible confirmation",
    handler: async (_args, ctx) => {
      await ctx.ui.confirm("Bridge attention probe", "Confirm to resolve this visible attention test.");
    },
  });
}
