import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentMessage,
  AssistantBlock,
  AssistantTurn,
  ModelClient,
  ToolDef,
} from "../types.js";

/**
 * Anthropic Messages API client — the direct replacement for the `claude-code`
 * harness. We stream one assistant turn, forward text deltas, and hand back the
 * final content blocks (text + tool_use) so the loop can dispatch tools and
 * continue.
 *
 * The Messages API maps almost 1:1 onto our internal message model: content
 * blocks, `tool_use`, and `tool_result` all line up, so the conversion here is
 * mechanical.
 */

/**
 * Anthropic requires an explicit output cap, and rejects (400s) any value above
 * the model's ceiling. Claude 3 (opus/sonnet/haiku, non-3.5/3.7) cap output at
 * 4096; 3.5, 3.7, and 4.x accept 8192. `model` is a free-text field, so clamp by
 * id prefix rather than sending a fixed 8192 that breaks older models.
 */
function maxTokensFor(model: string): number {
  if (/^claude-3-(opus|sonnet|haiku)-/.test(model)) return 4096;
  return 8192;
}

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  baseURL?: string;
}): ModelClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });

  return {
    model: opts.model,
    // Anthropic publishes no hard ceiling on how many tools a request may carry
    // — the practical limit is the context window, which the loop already
    // budgets against. Declaring a number we made up would drop tools an
    // employee needs to work around a wall that isn't there.
    maxTools: null,
    async streamTurn({ system, messages, tools, signal, onText }): Promise<AssistantTurn> {
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: maxTokensFor(opts.model),
          system,
          messages: messages.map(toAnthropicMessage),
          ...(tools.length > 0 ? { tools: tools.map(toAnthropicTool) } : {}),
        },
        signal ? { signal } : undefined,
      );

      if (onText) {
        stream.on("text", (delta: string) => {
          try {
            onText(delta);
          } catch {
            // A consumer callback must never take down the stream.
          }
        });
      }

      const final = await stream.finalMessage();
      const blocks: AssistantBlock[] = [];
      for (const block of final.content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
        // thinking / redacted_thinking / server-tool blocks are not part of our
        // loop — we don't advertise those capabilities.
      }
      return {
        blocks,
        stopReason: final.stop_reason ?? "end_turn",
        usage: {
          // `input_tokens` is only the uncached remainder — the cached spans
          // were part of the prompt too, so add them back or we'd under-report
          // context use the moment prompt caching is switched on.
          inputTokens:
            final.usage.input_tokens +
            (final.usage.cache_read_input_tokens ?? 0) +
            (final.usage.cache_creation_input_tokens ?? 0),
          outputTokens: final.usage.output_tokens,
        },
      };
    },
  };
}

function toAnthropicTool(t: ToolDef): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    // Anthropic's input_schema is a JSON-Schema object; our tools already carry
    // one. Cast through the SDK's loose shape.
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessage(m: AgentMessage): Anthropic.MessageParam {
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text };
        return {
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        };
      }),
    };
  }
  return {
    role: "user",
    content: m.content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      // Attach any images (e.g. a browser screenshot) as native image blocks so
      // a vision-capable model actually sees them, rather than dropping them.
      const images = b.images ?? [];
      if (images.length > 0) {
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
        if (b.content) blocks.push({ type: "text", text: b.content });
        for (const img of images) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: img.mimeType as "image/png", data: img.data },
          });
        }
        return {
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: blocks,
          ...(b.isError ? { is_error: true } : {}),
        };
      }
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      };
    }),
  };
}
