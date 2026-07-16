import OpenAI from "openai";
import type {
  AgentMessage,
  AssistantBlock,
  AssistantTurn,
  ModelClient,
  ToolDef,
} from "../types.js";

/**
 * OpenAI Chat Completions client — the direct replacement for the `codex`
 * harness, and also the carrier for the `custom` provider (any OpenAI-compatible
 * server: Ollama, vLLM, llama.cpp, LM Studio, a gateway, …) via a `baseURL`
 * override.
 *
 * Chat Completions models tool use with a flat message list rather than content
 * blocks, so the conversion is chunkier than Anthropic's: an assistant turn with
 * tool calls becomes one `assistant` message carrying `tool_calls`, and each of
 * our `tool_result` blocks becomes a separate `role:"tool"` message.
 */

/**
 * OpenAI rejects a `tools` array longer than this with a 400 that fails the
 * whole turn ("Invalid 'tools': array too long").
 *
 * This is OpenAI's own number and travels with the *service*, not with the wire
 * format — an OpenAI-compatible server (vLLM, Ollama, a gateway) speaks the same
 * Chat Completions API through this very client and has no such cap. So it's the
 * caller that decides whether it applies; see `modelClients/index.ts`.
 */
export const OPENAI_MAX_TOOLS = 128;

export function createOpenAIClient(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Provider tool ceiling; null for OpenAI-compatible servers (see above). */
  maxTools?: number | null;
}): ModelClient {
  const client = new OpenAI({
    // Most local servers ignore the key but the SDK refuses an empty string.
    apiKey: opts.apiKey || "not-needed",
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  return {
    model: opts.model,
    maxTools: opts.maxTools ?? null,
    async streamTurn({ system, messages, tools, signal, onText }): Promise<AssistantTurn> {
      const stream = await client.chat.completions.create(
        {
          model: opts.model,
          stream: true,
          // Without this, a streamed response reports no token counts at all —
          // the server defaults it off. It's how we learn how full the context
          // is; every OpenAI-compatible server we target (vLLM included)
          // accepts it.
          stream_options: { include_usage: true },
          messages: toOpenAIMessages(system, messages),
          ...(tools.length > 0 ? { tools: tools.map(toOpenAITool) } : {}),
        },
        signal ? { signal } : undefined,
      );

      let text = "";
      let finishReason = "stop";
      let usage: AssistantTurn["usage"];
      // tool_call deltas arrive fragmented and keyed by index; assemble them.
      const toolAcc = new Map<
        number,
        { id: string; name: string; args: string }
      >();

      for await (const chunk of stream) {
        // The usage chunk arrives last and carries an empty `choices` array, so
        // read it before the guard below skips the chunk entirely.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          text += delta.content;
          if (onText) {
            try {
              onText(delta.content);
            } catch {
              // never let a consumer callback break the stream
            }
          }
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const blocks: AssistantBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
        if (!tc.name) continue;
        blocks.push({
          type: "tool_use",
          id: tc.id || `call_${tc.name}_${blocks.length}`,
          name: tc.name,
          input: parseArgs(tc.args),
        });
      }

      const stopReason =
        finishReason === "tool_calls" || toolAcc.size > 0 ? "tool_use" : finishReason;
      return { blocks, stopReason, ...(usage ? { usage } : {}) };
    },
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  const s = raw.trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toOpenAITool(t: ToolDef): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  };
}

function toOpenAIMessages(
  system: string,
  messages: AgentMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = m.content
        .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // A user turn can mix free text and tool results. Tool results become
      // their own `role:"tool"` messages; any plain text becomes a user message.
      const textParts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          textParts.push(b.text);
        } else {
          // Chat Completions tool-role messages are text-only, so images (e.g.
          // browser screenshots) can't ride along here — note their presence.
          const content =
            b.content ||
            ((b.images?.length ?? 0) > 0
              ? "[image result omitted — this model can't view images]"
              : "");
          out.push({ role: "tool", tool_call_id: b.toolUseId, content });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }
  return out;
}
