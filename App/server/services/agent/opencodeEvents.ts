import type { ApiError, Event, Part, AssistantMessage } from "@opencode-ai/sdk/v2";
import type { StreamCallbacks } from "./types.js";
import { contextUsage } from "./contextUsage.js";
import { OPENCODE_MCP } from "./opencodeConfig.js";

/** Normalize OpenCode's durable snapshots and deltas without double-reporting. */
export class OpenCodeEvents {
  readonly parts = new Map<string, Part>();
  readonly assistants = new Map<string, AssistantMessage>();
  private roles = new Map<string, "user" | "assistant">();
  private textReady = new Map<string, boolean>();
  private completedSteps = new Set<string>();
  private startedTools = new Set<string>();
  private finishedTools = new Set<string>();
  private compacted = new Set<string>();
  private retries = new Set<string>();
  private endedReasoning = new Set<string>();
  private currentMessageId = "";
  steps = 0;
  stopReason = "end_turn";
  error: Error | null = null;

  constructor(
    readonly sessionId: string,
    private callbacks?: StreamCallbacks,
    private window: number | null = null,
    private onMcpTool?: (part: Part) => void,
  ) {}

  accept(event: Event): void {
    if (event.type === "message.updated") {
      const info = event.properties.info;
      if (info.sessionID !== this.sessionId) return;
      this.roles.set(info.id, info.role);
      if (info.role !== "assistant") return;
      if (!this.textReady.has(info.id))
        this.textReady.set(info.id, this.callbacks?.shouldStreamText?.() ?? true);
      this.assistants.set(info.id, info);
      this.currentMessageId = info.id;
      if (info.error && info.error.name !== "MessageAbortedError")
        this.error = openCodeError(info.error);
      return;
    }
    if (event.type === "session.error" && event.properties.sessionID === this.sessionId) {
      // OpenCode emits overflow here before trying semantic compaction. Only
      // a terminal assistant error establishes that recovery actually failed.
      if (
        event.properties.error &&
        !["MessageAbortedError", "ContextOverflowError"].includes(event.properties.error.name)
      )
        this.error = openCodeError(event.properties.error);
      return;
    }
    if (
      event.type === "session.status" &&
      event.properties.sessionID === this.sessionId &&
      event.properties.status.type === "retry"
    ) {
      const status = event.properties.status;
      const key = `${this.currentMessageId}:attempt:${status.attempt}`;
      if (!this.retries.has(key)) {
        this.retries.add(key);
        this.callbacks?.onModelRetry?.({
          attempt: status.attempt,
          maxAttempts: null,
          delayMs: Math.max(0, status.next - Date.now()),
          reason: "Model connection interrupted",
        });
      }
      return;
    }
    if (event.type === "message.part.delta") {
      const { sessionID, partID, field, delta } = event.properties;
      if (sessionID !== this.sessionId || field !== "text" || delta.length === 0) return;
      const part = this.parts.get(partID);
      if (part?.type === "reasoning") {
        if (!this.reasoningVisible(part.messageID)) return;
        part.text += delta;
        this.callbacks?.onReasoning?.(delta, part.id);
        return;
      }
      if (
        part?.type !== "text" ||
        this.roles.get(part.messageID) !== "assistant" ||
        !this.textReady.get(part.messageID) ||
        this.assistants.get(part.messageID)?.summary ||
        part.synthetic ||
        part.ignored
      )
        return;
      part.text += delta;
      this.callbacks?.onText?.(delta);
      return;
    }
    if (event.type !== "message.part.updated") return;
    this.part(event.properties.part);
  }

  part(part: Part): void {
    if (part.sessionID !== this.sessionId) return;
    const old = this.parts.get(part.id);
    this.parts.set(part.id, { ...part });
    // A tool part also establishes assistant provenance if its message
    // snapshot was delayed. Freeze readiness before the MCP gate can run.
    if (part.type === "tool" && !this.textReady.has(part.messageID))
      this.textReady.set(part.messageID, this.callbacks?.shouldStreamText?.() ?? true);
    if (part.type === "tool" && part.tool.startsWith(`${OPENCODE_MCP}_`)) this.onMcpTool?.(part);
    if (part.type === "reasoning") {
      // Thinking is observed, never answered: it reaches a feed beside the
      // reply and never the reply itself, and it follows the same readiness
      // gate as prose so a discussion's pre-read thoughts stay withheld too.
      if (!this.reasoningVisible(part.messageID)) return;
      const before = old?.type === "reasoning" ? old.text : "";
      if (part.text.startsWith(before) && part.text.length > before.length)
        this.callbacks?.onReasoning?.(part.text.slice(before.length), part.id);
      if (part.time?.end !== undefined && !this.endedReasoning.has(part.id)) {
        this.endedReasoning.add(part.id);
        this.callbacks?.onReasoningEnd?.(part.id);
      }
      return;
    }
    if (
      part.type === "text" &&
      this.roles.get(part.messageID) === "assistant" &&
      this.textReady.get(part.messageID) &&
      !this.assistants.get(part.messageID)?.summary &&
      !part.synthetic &&
      !part.ignored
    ) {
      const before = old?.type === "text" ? old.text : "";
      if (part.text.startsWith(before) && part.text.length > before.length)
        this.callbacks?.onText?.(part.text.slice(before.length));
    } else if (part.type === "step-finish" && !this.completedSteps.has(part.id)) {
      this.completedSteps.add(part.id);
      this.steps++;
      this.stopReason = part.reason === "stop" ? "end_turn" : part.reason;
      const inputTokens = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write;
      // OpenCode fills absent upstream usage with zeros. Preserve unknown
      // usage rather than reporting a free turn or an empty context window.
      if (inputTokens > 0 || part.tokens.output > 0 || part.tokens.reasoning > 0) {
        // OpenCode separates reasoning from visible output; provider billing
        // and Genosyn's output count include both.
        this.callbacks?.onUsage?.({
          inputTokens,
          outputTokens: part.tokens.output + part.tokens.reasoning,
        });
        if (inputTokens > 0)
          this.callbacks?.onContextUsage?.(contextUsage(inputTokens, this.window));
      }
    } else if (part.type === "tool" && !part.tool.startsWith(`${OPENCODE_MCP}_`)) {
      const state = part.state;
      const callId = `${part.messageID}:${part.callID}`;
      if (state.status !== "pending" && !this.startedTools.has(part.id)) {
        this.startedTools.add(part.id);
        this.callbacks?.onToolUse?.(part.tool, state.input, callId);
      }
      if (
        (state.status === "completed" || state.status === "error") &&
        !this.finishedTools.has(part.id)
      ) {
        this.finishedTools.add(part.id);
        this.callbacks?.onToolResult?.(
          part.tool,
          {
            content: state.status === "completed" ? state.output : state.error,
            ...(state.status === "error" ? { isError: true } : {}),
          },
          callId,
        );
      }
    } else if (part.type === "compaction" && !this.compacted.has(part.id)) {
      this.compacted.add(part.id);
      // OpenCode owns semantic compaction. Its event does not report dropped
      // result/token counts, so do not invent them.
      this.callbacks?.onCompact?.({
        evicted: null,
        freedTokens: null,
        reason: part.overflow ? "overflow" : "budget",
      });
    } else if (
      part.type === "retry" &&
      !this.retries.has(`${part.messageID}:attempt:${part.attempt}`)
    ) {
      this.retries.add(`${part.messageID}:attempt:${part.attempt}`);
      this.callbacks?.onModelRetry?.({
        attempt: part.attempt,
        maxAttempts: null,
        delayMs: 0,
        reason: part.error.data.statusCode
          ? `HTTP ${part.error.data.statusCode}`
          : "Model connection interrupted",
      });
    }
  }

  private reasoningVisible(messageId: string): boolean {
    return (
      this.roles.get(messageId) === "assistant" &&
      this.textReady.get(messageId) === true &&
      !this.assistants.get(messageId)?.summary
    );
  }

  get finalText(): string {
    const ordered = [...this.assistants.values()].filter((message) => !message.summary);
    const message = ordered.at(-1);
    if (!message) return "";
    return [...this.parts.values()]
      .filter(
        (part) =>
          part.messageID === message.id && part.type === "text" && !part.synthetic && !part.ignored,
      )
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
}

/**
 * Provider response bodies and headers may contain secrets; the message carries
 * only the status. What the provider said goes on `providerDetail` (see
 * `providerErrorDetail`), which only the AI Model setup forms show.
 */
export function openCodeError(error: NonNullable<AssistantMessage["error"]>): Error {
  if (error.name === "APIError")
    return Object.assign(
      new Error(
        `The AI Model request failed${error.data.statusCode ? ` (HTTP ${error.data.statusCode})` : ""}.`,
      ),
      {
        status: error.data.statusCode,
        statusCode: error.data.statusCode,
        providerDetail: providerErrorDetail(error.data),
      },
    );
  if (error.name === "ProviderAuthError")
    return Object.assign(new Error("The AI Model rejected its stored credentials."), {
      status: 401,
      statusCode: 401,
    });
  if (error.name === "ContextOverflowError")
    return new Error(
      "The AI Model's context window was exceeded after OpenCode tried to compact the conversation.",
    );
  return new Error(`OpenCode could not complete the AI Model turn (${error.name}).`);
}

/** Text shaped like an API key or a bearer token, as a provider may quote one back. */
const KEY_SHAPED = /\b(?:sk|rk|pk)-[\w*•-]{6,}|\bBearer\s+[\w.~+/=-]+/gi;

/**
 * What the provider said about a failed request, for the person connecting an
 * AI Model: the HTTP status, the error type and message from the response
 * body, and the request ID the provider's support asks for. Never the response
 * headers. The proxy has already taken the stored key out of the body
 * (`opencodeProxy.ts`); text shaped like a key is removed here too, and the
 * whole is bounded. Null when the provider said nothing.
 */
export function providerErrorDetail(data: ApiError["data"]): string | null {
  const body = parseObject(data.responseBody);
  const error = asObject(body?.error);
  const message =
    textField(error, "message") ??
    textField(body, "error") ??
    textField(body, "message") ??
    textField(body, "detail") ??
    textField(data, "message") ??
    (body ? null : textField(data, "responseBody"));
  const type = textField(error, "type") ?? textField(error, "code");
  const requestId = textField(body, "request_id");
  const lines = [
    [data.statusCode ? `HTTP ${data.statusCode}` : null, type].filter(Boolean).join(" · "),
    message?.replace(/\s+/g, " ").slice(0, 1_000) ?? "",
    requestId ? `Request ID: ${requestId.slice(0, 200)}` : "",
  ].filter(Boolean);
  return lines.length ? lines.join("\n").replace(KEY_SHAPED, "[redacted]") : null;
}

function parseObject(text: string | undefined): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text ?? ""));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textField(record: object | null, key: string): string | null {
  const value = (record as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function openCodeActivityError(error: unknown): Error {
  const cause =
    error && typeof error === "object"
      ? (error as { code?: unknown; cause?: { code?: unknown }; message?: unknown })
      : undefined;
  const code = cause?.cause?.code ?? cause?.code;
  const safeCode =
    typeof code === "string" &&
    /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_[A-Z_]+)$/.test(code)
      ? code
      : undefined;
  const status =
    typeof cause?.message === "string"
      ? /^SSE failed: (\d{3})\b/.exec(cause.message)?.[1]
      : undefined;
  return new Error(
    `OpenCode's activity connection failed${safeCode ? ` (${safeCode})` : status ? ` (HTTP ${status})` : ""}.`,
  );
}
