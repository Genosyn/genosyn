import type { CodexAppServer } from "../services/agent/codexAppServer.js";

/** A deterministic upstream response; the production isolation and completion checks still run. */
export function fakeCodexVerification(
  cwd: string,
  options: { reply?: string; status?: string; model?: string } = {},
): CodexAppServer {
  const listeners = new Set<(method: string, params: unknown) => void>();
  return {
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      const input = params as Record<string, unknown>;
      if (method === "model/list")
        return {
          data: [{ model: options.model ?? "gpt-current", isDefault: true }],
          nextCursor: null,
        } as T;
      if (method === "thread/start")
        return {
          thread: { id: "verify-thread", ephemeral: true, parentThreadId: null, cwd },
          cwd,
          model: input.model,
          modelProvider: "openai",
          approvalPolicy: "never",
          sandbox: { type: "readOnly", networkAccess: false },
          runtimeWorkspaceRoots: [],
          instructionSources: [],
        } as T;
      if (method === "turn/start") {
        for (const listener of listeners) {
          listener("item/completed", {
            threadId: "verify-thread",
            turnId: "verify-turn",
            item: { type: "agentMessage", text: options.reply ?? "OK" },
          });
          listener("turn/completed", {
            threadId: "verify-thread",
            turn: { id: "verify-turn", status: options.status ?? "completed" },
          });
        }
        return { turn: { id: "verify-turn" } } as T;
      }
      if (method === "turn/interrupt") return {} as T;
      throw new Error(`Unexpected verification method: ${method}`);
    },
    onNotification: (listener: (method: string, params: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: () => () => undefined,
    close: async () => undefined,
    stderrSummary: () => "",
  } as unknown as CodexAppServer;
}

export function successfulModelStream(
  provider: "anthropic" | "openai",
  options: { tool?: string; ok?: boolean; textOnly?: boolean } = {},
): Response {
  const tool = options.tool ?? "connection_test";
  const ok = options.ok ?? true;
  const events =
    provider === "openai"
      ? [
          {
            type: "response.completed",
            response: {
              status: "completed",
              output: options.textOnly
                ? [{ type: "message", content: [{ type: "output_text", text: "OK" }] }]
                : [
                    {
                      type: "function_call",
                      call_id: "probe-call",
                      name: tool,
                      arguments: JSON.stringify({ ok }),
                    },
                  ],
              usage: { input_tokens: 20, output_tokens: 5 },
            },
          },
        ]
      : [
          {
            type: "message_start",
            message: {
              id: "probe-message",
              type: "message",
              role: "assistant",
              model: "claude-current",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: options.textOnly
              ? { type: "text", text: "" }
              : { type: "tool_use", id: "probe-call", name: tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: options.textOnly
              ? { type: "text_delta", text: "OK" }
              : { type: "input_json_delta", partial_json: JSON.stringify({ ok }) },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: options.textOnly ? "end_turn" : "tool_use", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
