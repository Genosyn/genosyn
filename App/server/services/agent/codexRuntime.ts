import type { AIModel } from "../../db/entities/AIModel.js";
import {
  CODEX_CONFIG_OVERRIDES,
  prepareCodexRuntime,
  withSubscriptionModelLock,
} from "../codexSubscription.js";
import { CodexAppServer, CodexAppServerError } from "./codexAppServer.js";
import { toolResultCap } from "./contextBudget.js";
import { contextUsage } from "./contextUsage.js";
import type { ToolRegistry } from "./tools/toolRegistry.js";
import type { AgentMessage, AgentTool, StreamCallbacks, ToolResult, TurnUsage } from "./types.js";

type JsonObject = Record<string, unknown>;

const ALLOWED_CODEX_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "dynamicToolCall",
  "contextCompaction",
]);
const SUBSCRIPTION_TURN_DEADLINE_MS = 6 * 60 * 60 * 1_000;

type DynamicToolCallParams = {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
};

type DynamicToolCallResponse = {
  contentItems: Array<
    { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }
  >;
  success: boolean;
};

export type CodexSubscriptionResult = {
  finalText: string;
  steps: number;
};

/**
 * Execute one AI Employee turn through OpenAI's official Codex app-server.
 *
 * Only the resident portion of Genosyn's existing ToolRegistry is advertised.
 * That resident set already includes `find_tools` and `call_tool`, whose bound
 * closures can resolve the deferred catalogue exactly as the direct API loop
 * does. No second permission or dispatch implementation is introduced here.
 */
export async function runCodexSubscriptionTurn(params: {
  model: AIModel;
  system: string;
  messages: AgentMessage[];
  registry: ToolRegistry;
  maxSteps: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<CodexSubscriptionResult> {
  return withSubscriptionModelLock(params.model.id, params.signal, async () => {
    const lease = await prepareCodexRuntime(params.model.id);
    const effectiveModel = lease.model;
    let server: CodexAppServer | null = null;
    let toolCalls = 0;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let disallowedItemType: string | null = null;
    let finalText = "";
    let lastUsageFingerprint = "";
    let terminalError: Error | null = null;
    let runawayViolation: string | null = null;
    const streamedByItem = new Map<string, string>();
    const completedMessages: Array<{ text: string; phase: string | null }> = [];
    const completion = deferred<void>();

    try {
      server = await CodexAppServer.start({
        cwd: lease.home.workspace,
        env: lease.env,
        configOverrides: [...CODEX_CONFIG_OVERRIDES],
        onServerRequest: async (method, requestParams) => {
          if (method !== "item/tool/call") {
            throw new CodexAppServerError(
              `Genosyn denied unsupported Codex server request: ${method}`,
              "REQUEST_DENIED",
            );
          }
          const call = parseDynamicToolCall(requestParams);
          if (threadId && call.threadId !== threadId) {
            throw new Error("Codex sent a tool call for the wrong thread.");
          }
          if (turnId && call.turnId !== turnId) {
            throw new Error("Codex sent a tool call for the wrong turn.");
          }
          toolCalls += 1;
          if (toolCalls > Math.max(1, params.maxSteps)) {
            runawayViolation =
              `Genosyn stopped this turn after ${params.maxSteps} tool calls ` +
              "to prevent a runaway loop.";
            interruptActiveTurn(server, threadId, turnId);
            completion.resolve(undefined);
            return toolFailure(runawayViolation);
          }
          return invokeRegistryTool(
            params.registry,
            call,
            effectiveModel.contextWindow,
            params.callbacks,
          );
        },
      });

      const stopNotifications = server.onNotification((method, raw) => {
        const body = asObject(raw);
        if (!body) return;
        if (!matchesActiveTurn(body, threadId, turnId)) return;

        if (method === "item/agentMessage/delta") {
          const itemId = stringField(body, "itemId");
          const delta = stringField(body, "delta");
          if (!itemId || delta === null) return;
          streamedByItem.set(itemId, (streamedByItem.get(itemId) ?? "") + delta);
          safeCallback(() => params.callbacks?.onText?.(delta));
          return;
        }

        if (method === "item/completed") {
          const item = asObject(body.item);
          const type = stringField(item, "type");
          if (type === "agentMessage") {
            const text = stringField(item, "text") ?? "";
            const itemId = stringField(item, "id") ?? "";
            const streamed = streamedByItem.get(itemId) ?? "";
            if (text && text.startsWith(streamed) && text.length > streamed.length) {
              const missing = text.slice(streamed.length);
              safeCallback(() => params.callbacks?.onText?.(missing));
            } else if (text && !streamed) {
              safeCallback(() => params.callbacks?.onText?.(text));
            }
            if (text) {
              completedMessages.push({
                text,
                phase: stringField(item, "phase"),
              });
            }
            return;
          }
          if (!isAllowedCodexItemType(type)) {
            disallowedItemType = type ?? "unknown";
            interruptActiveTurn(server, threadId, turnId);
            completion.resolve(undefined);
          }
          return;
        }

        if (method === "item/started") {
          const item = asObject(body.item);
          const type = stringField(item, "type");
          if (!isAllowedCodexItemType(type)) {
            disallowedItemType = type ?? "unknown";
            interruptActiveTurn(server, threadId, turnId);
            completion.resolve(undefined);
          }
          return;
        }

        if (method === "thread/tokenUsage/updated") {
          const usage = asObject(body.tokenUsage);
          const total = asObject(usage?.total);
          const last = asObject(usage?.last);
          const inputTokens = numberField(last, "inputTokens");
          const outputTokens = numberField(last, "outputTokens");
          if (inputTokens !== null && outputTokens !== null) {
            const fingerprint = JSON.stringify(total ?? last);
            if (fingerprint !== lastUsageFingerprint) {
              lastUsageFingerprint = fingerprint;
              const reported: TurnUsage = { inputTokens, outputTokens };
              safeCallback(() => params.callbacks?.onUsage?.(reported));
              // A ChatGPT subscription model has no probeable window and the
              // manual override is refused for it, so this is almost always a
              // token count with a null denominator. Reporting it anyway is
              // still worth more than silence: "142,000 tokens, window unknown"
              // tells a Member why a long thread started forgetting things.
              safeCallback(() =>
                params.callbacks?.onContextUsage?.(
                  contextUsage(inputTokens, effectiveModel.contextWindow),
                ),
              );
            }
          }
          return;
        }

        if (method === "error" && body.willRetry !== true) {
          const detail = asObject(body.error);
          terminalError = new CodexAppServerError(
            stringField(detail, "message") || "OpenAI Codex reported a terminal error.",
            stringField(detail, "codexErrorInfo"),
            detail,
          );
          return;
        }

        if (method === "turn/completed") {
          const turn = asObject(body.turn);
          const status = stringField(turn, "status");
          if (status === "completed") {
            completion.resolve(undefined);
            return;
          }
          if (status === "interrupted" && (disallowedItemType || runawayViolation)) {
            completion.resolve(undefined);
            return;
          }
          const error = asObject(turn?.error);
          completion.reject(
            terminalError ??
              new CodexAppServerError(
                stringField(error, "message") ||
                  (status === "interrupted"
                    ? "The OpenAI subscription turn was interrupted."
                    : "The OpenAI subscription turn failed."),
                status,
                error,
              ),
          );
        }
      });

      const started = await server.request<unknown>(
        "thread/start",
        {
          model: effectiveModel.model,
          modelProvider: "openai",
          allowProviderModelFallback: false,
          cwd: lease.home.workspace,
          approvalPolicy: "never",
          sandbox: "read-only",
          baseInstructions: [
            "You are the runtime for a Genosyn AI Employee.",
            "Follow the developer instructions and continue the supplied conversation.",
            "Use only the dynamic tools supplied by Genosyn. Native shell, file-editing, web, app, plugin, skill, memory, goal, and multi-agent tools are disabled.",
            "A tool's result is authoritative. Never claim an external action succeeded unless its tool result says it did.",
          ].join("\n"),
          developerInstructions: params.system,
          personality: "none",
          ephemeral: true,
          environments: [],
          runtimeWorkspaceRoots: [],
          selectedCapabilityRoots: [],
          dynamicTools: params.registry.resident.map(dynamicToolSpec),
          serviceName: "genosyn",
          threadSource: "genosyn",
        },
        30_000,
      );
      threadId = assertCodexThreadPosture(started, {
        cwd: lease.home.workspace,
        model: effectiveModel.model,
      });

      if (params.signal?.aborted) throw abortError();
      const conversation = splitConversation(params.messages);
      if (conversation.history.length > 0) {
        await server.request(
          "thread/inject_items",
          {
            threadId,
            items: conversation.history,
          },
          30_000,
        );
      }
      const turnStarted = await server.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId,
          input: [
            {
              type: "text",
              text: conversation.current,
              text_elements: [],
            },
          ],
          approvalPolicy: "never",
        },
        30_000,
      );
      if (!turnStarted.turn?.id) {
        throw new Error("OpenAI Codex did not return a turn id.");
      }
      turnId = turnStarted.turn.id;
      if (disallowedItemType || runawayViolation) {
        interruptActiveTurn(server, threadId, turnId);
      }

      const onAbort = () => {
        interruptActiveTurn(server, threadId, turnId);
        completion.reject(abortError());
      };
      const stopExit = server.onExit((error) => {
        completion.reject(
          error ??
            new CodexAppServerError(
              "OpenAI Codex app-server closed before the turn completed.",
              "PROCESS_EXIT",
            ),
        );
      });
      const deadline = setTimeout(() => {
        interruptActiveTurn(server, threadId, turnId);
        completion.reject(
          new CodexAppServerError(
            "OpenAI Codex subscription turn exceeded its hard runtime limit.",
            "TURN_DEADLINE",
          ),
        );
      }, SUBSCRIPTION_TURN_DEADLINE_MS);
      deadline.unref?.();
      params.signal?.addEventListener("abort", onAbort, { once: true });
      if (params.signal?.aborted) onAbort();
      try {
        await completion.promise;
      } finally {
        clearTimeout(deadline);
        params.signal?.removeEventListener("abort", onAbort);
        stopExit();
        stopNotifications();
      }

      if (disallowedItemType) {
        throw new Error(
          `OpenAI Codex attempted the disallowed ${disallowedItemType} item. Genosyn stopped the turn before allowing native workspace access.`,
        );
      }
      if (runawayViolation) throw new Error(runawayViolation);

      finalText =
        [...completedMessages]
          .reverse()
          .find((message) => message.phase === "final_answer" && message.text.trim().length > 0)
          ?.text.trim() ??
        [...completedMessages]
          .reverse()
          .find((message) => message.text.trim().length > 0)
          ?.text.trim() ??
        [...streamedByItem.values()]
          .reverse()
          .find((text) => text.trim().length > 0)
          ?.trim() ??
        "";
      return {
        finalText: finalText || "(no reply)",
        steps: Math.max(1, toolCalls + 1),
      };
    } finally {
      await server?.close().catch(() => undefined);
      await lease.finish();
    }
  });
}

export function assertCodexThreadPosture(
  value: unknown,
  expected: { cwd: string; model: string },
): string {
  const response = asObject(value);
  const thread = asObject(response?.thread);
  const sandbox = asObject(response?.sandbox);
  const runtimeRoots = response?.runtimeWorkspaceRoots;
  const instructionSources = response?.instructionSources;
  if (!thread || !sandbox) {
    throw new Error("OpenAI Codex app-server did not honor Genosyn's requested thread isolation.");
  }
  const threadId = typeof thread.id === "string" && thread.id.length > 0 ? thread.id : null;
  const valid =
    threadId !== null &&
    thread.ephemeral === true &&
    thread.parentThreadId === null &&
    response?.model === expected.model &&
    response?.modelProvider === "openai" &&
    response?.cwd === expected.cwd &&
    thread.cwd === expected.cwd &&
    response?.approvalPolicy === "never" &&
    sandbox?.type === "readOnly" &&
    sandbox.networkAccess === false &&
    Array.isArray(runtimeRoots) &&
    runtimeRoots.length === 0 &&
    Array.isArray(instructionSources) &&
    instructionSources.length === 0;
  if (!valid) {
    throw new Error("OpenAI Codex app-server did not honor Genosyn's requested thread isolation.");
  }
  return threadId;
}

function dynamicToolSpec(tool: AgentTool): JsonObject {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
    throw new Error(`Genosyn tool name is not valid for OpenAI Codex: ${tool.name}`);
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    deferLoading: false,
  };
}

async function invokeRegistryTool(
  registry: ToolRegistry,
  call: DynamicToolCallParams,
  contextWindow: number | null,
  callbacks?: StreamCallbacks,
): Promise<DynamicToolCallResponse> {
  if (call.namespace !== null) {
    return toolFailure(`Unknown Genosyn tool namespace: ${call.namespace}`);
  }
  const tool = registry.resolve(call.tool);
  if (!tool) return toolFailure(`Unknown Genosyn tool: ${call.tool}`);
  const input = asObject(call.arguments);
  if (!input) return toolFailure(`Tool ${call.tool} requires a JSON object.`);

  let described = { name: tool.name, input };
  try {
    described = tool.describeCall?.(input) ?? described;
  } catch {
    // Logging metadata must not prevent the actual tool call.
  }
  safeCallback(() => callbacks?.onToolUse?.(described.name, described.input));

  let result: ToolResult;
  try {
    result = await tool.run(input);
  } catch (error) {
    result = {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
  const content = clip(result.content, toolResultCap(contextWindow));
  const reportedResult = { ...result, content };
  safeCallback(() => callbacks?.onToolResult?.(described.name, reportedResult));

  const contentItems: DynamicToolCallResponse["contentItems"] = [
    {
      type: "inputText",
      text: content || (result.isError ? "Tool call failed." : "(no output)"),
    },
  ];
  for (const image of result.images ?? []) {
    if (!/^image\/[a-z0-9.+-]+$/i.test(image.mimeType)) continue;
    contentItems.push({
      type: "inputImage",
      imageUrl: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return { contentItems, success: !result.isError };
}

function toolFailure(message: string): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: message }],
    success: false,
  };
}

function parseDynamicToolCall(value: unknown): DynamicToolCallParams {
  const body = asObject(value);
  const threadId = stringField(body, "threadId");
  const turnId = stringField(body, "turnId");
  const callId = stringField(body, "callId");
  const tool = stringField(body, "tool");
  const namespace = body?.namespace === null ? null : stringField(body, "namespace");
  if (!threadId || !turnId || !callId || !tool || namespace === undefined) {
    throw new Error("OpenAI Codex sent an invalid dynamic tool call.");
  }
  return {
    threadId,
    turnId,
    callId,
    namespace,
    tool,
    arguments: body?.arguments,
  };
}

function splitConversation(messages: AgentMessage[]): {
  history: JsonObject[];
  current: string;
} {
  if (messages.length === 0) {
    throw new Error("The OpenAI subscription turn has no user message.");
  }
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user") {
    throw new Error("The OpenAI subscription conversation must end with a user message.");
  }

  const history = messages.slice(0, -1).map((message) => ({
    type: "message",
    role: message.role,
    content: [
      {
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: messageText(message),
      },
    ],
  }));
  return {
    history,
    current: messageText(latest),
  };
}

function messageText(message: AgentMessage): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") {
        return `[Prior tool call: ${block.name} ${JSON.stringify(block.input)}]`;
      }
      return `[Prior tool result${block.isError ? " (error)" : ""}: ${block.content}]`;
    })
    .join("\n");
}

function isAllowedCodexItemType(type: string | null | undefined): boolean {
  return typeof type === "string" && ALLOWED_CODEX_ITEM_TYPES.has(type);
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringField(record: JsonObject | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: JsonObject | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeCallback(callback: () => void): void {
  try {
    callback();
  } catch {
    // Stream/transcript observers are never allowed to break the turn.
  }
}

function matchesActiveTurn(
  body: JsonObject,
  threadId: string | null,
  turnId: string | null,
): boolean {
  const eventThreadId = stringField(body, "threadId");
  const eventTurnId = stringField(body, "turnId");
  if (threadId && eventThreadId && eventThreadId !== threadId) return false;
  if (turnId && eventTurnId && eventTurnId !== turnId) return false;
  return true;
}

function interruptActiveTurn(
  server: CodexAppServer | null,
  threadId: string | null,
  turnId: string | null,
): void {
  if (!server || !threadId || !turnId) return;
  void server.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => undefined);
}

function clip(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return value.slice(0, cap) + `\n… [truncated ${value.length - cap} chars]`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error("The OpenAI subscription turn was aborted.");
  error.name = "AbortError";
  return error;
}
