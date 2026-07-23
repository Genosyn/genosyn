import OpenAI from "openai";
import type {
  AgentMessage,
  AssistantBlock,
  AssistantTurn,
  ModelClient,
  ToolDef,
  ToolResultBlock,
} from "../types.js";
import { parseArgs } from "./parseArgs.js";

/**
 * OpenAI Responses API client — the carrier for the `openai` provider.
 *
 * Its sibling `openai.ts` speaks Chat Completions and still carries every
 * `custom` provider (Ollama, vLLM, llama.cpp, LM Studio, a gateway). Those
 * servers borrow OpenAI's *wire format*, and `/v1/responses` is not part of what
 * they implement — so the two clients are split by endpoint rather than merged
 * behind a flag. See `modelClients/index.ts` for the routing.
 *
 * Why the openai provider had to leave Chat Completions: reasoning models
 * (gpt-5.x, o-series) apply a default reasoning effort server-side, and that
 * default combined with function tools is rejected outright there —
 *
 *   400 Function tools with reasoning_effort are not supported for gpt-5.6-sol
 *   in /v1/chat/completions. To use function tools, use /v1/responses or set
 *   reasoning_effort to 'none'.
 *
 * — which lands on us without our ever sending `reasoning_effort`, because the
 * *server* supplies it. Since an employee is nothing but a tool loop, the only
 * two ways out were to turn reasoning off on a reasoning model, or to move to
 * the endpoint that allows both. This is that move.
 *
 * The routing is per-provider, not per-model: `model` is free text (an operator
 * types it), so sniffing "is this a reasoning model?" from the id would be a
 * guess that silently breaks on the next model OpenAI ships. Every OpenAI model
 * we can reach with an API key — reasoning or not — is served by /v1/responses,
 * so the whole provider moves and there is no id to interpret.
 */

export function createOpenAIResponsesClient(opts: {
  apiKey: string;
  model: string;
  /** Provider tool ceiling; see `OPENAI_MAX_TOOLS` in ./openai.ts. */
  maxTools?: number | null;
}): ModelClient {
  const client = new OpenAI({ apiKey: opts.apiKey });

  return {
    model: opts.model,
    maxTools: opts.maxTools ?? null,
    async streamTurn({ system, messages, tools, signal, onText }): Promise<AssistantTurn> {
      const stream = await client.responses.create(
        {
          model: opts.model,
          stream: true,
          // Responses takes the system prompt as a top-level field rather than a
          // `role:"system"` message.
          instructions: system,
          input: toResponsesInput(messages),
          // Genosyn is self-hostable and the prompt carries the Soul, company
          // skills, and whatever a tool just read off disk. Retaining that on
          // OpenAI's side is a data-residency decision an operator never made,
          // so opt out. Nothing here needs server-side state: the loop replays
          // the full transcript every turn rather than chaining on
          // `previous_response_id`.
          store: false,
          // No `stream_options` counterpart is needed. Chat Completions reports
          // no token counts on a streamed response unless asked
          // (`include_usage`); Responses always puts usage on its terminal
          // event, and the param doesn't exist here.
          ...(tools.length > 0 ? { tools: tools.map(toResponsesTool) } : {}),
        },
        signal ? { signal } : undefined,
      );

      /**
       * The terminal event's snapshot. Deltas carry no running `response`, so
       * the final item list is only readable once one of the three terminal
       * events lands — and `incomplete` / `failed` are terminal too, so watching
       * only `completed` would drop usage and lose a truncated turn's output.
       *
       * The text is read back off this rather than accumulated from the deltas:
       * the deltas exist to stream, the snapshot is what the turn *was*.
       */
      let final: OpenAI.Responses.Response | undefined;

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          if (onText) {
            try {
              onText(event.delta);
            } catch {
              // never let a consumer callback break the stream
            }
          }
        } else if (
          event.type === "response.completed" ||
          event.type === "response.incomplete" ||
          event.type === "response.failed"
        ) {
          final = event.response;
        }
      }

      if (!final) {
        throw new Error("The model's stream ended without a final response.");
      }

      // A mid-generation failure arrives as an *event*, not a rejected promise —
      // a plain `for await` would swallow it and hand the loop a turn that looks
      // merely empty. Rethrow so it reaches the loop's overflow retry, which is
      // only reachable from a thrown error (see `isContextOverflowError`).
      //
      // Keyed on the status alone: `error` is optional on every Response, so a
      // failure that arrives without one must still fail loudly rather than fall
      // through as a successful turn with nothing in it.
      if (final.status === "failed") {
        throw Object.assign(
          new Error(final.error?.message ?? "The model failed this turn without saying why."),
          final.error?.code ? { code: final.error.code } : {},
        );
      }

      const blocks: AssistantBlock[] = [];
      for (const item of final.output) {
        if (item.type === "message") {
          const itemText = item.content
            .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === "output_text")
            .map((c) => c.text)
            .join("");
          if (itemText) blocks.push({ type: "text", text: itemText });
        } else if (item.type === "function_call") {
          blocks.push({
            type: "tool_use",
            // `call_id`, never the item's own `id`. The loop echoes this
            // verbatim onto the tool_result, and a `function_call_output` is
            // matched by `call_id` — hand it `id` (`fc_…` rather than `call_…`)
            // and the *next* turn 400s. There is deliberately no synthesized
            // fallback the way the Chat Completions client has one: there the id
            // is an opaque echo some local servers omit, but here the server
            // validates it against the call it actually made, so inventing one
            // is a guaranteed rejection.
            id: item.call_id,
            name: item.name,
            input: parseArgs(item.arguments).input,
          });
        }
        // `reasoning` items are dropped: AssistantBlock has nowhere to put them,
        // so they can't survive the loop's transcript. Dropping *every* one is
        // the safe half of that trade — the model still reasons on each turn, it
        // just doesn't get its previous scratchpad back, which OpenAI describes
        // as a quality nicety rather than a requirement. What is *not* safe is
        // dropping some and keeping others: a reasoning item echoed back without
        // the item that followed it is a hard 400. Keep this all-or-nothing.
      }

      return {
        blocks,
        // Loose by contract — the loop decides "tools pending" from the blocks
        // themselves and never reads this string.
        stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : (final.status ?? "completed"),
        ...(final.usage
          ? {
              usage: {
                // Already the whole billed prompt: `input_tokens_details.cached_tokens`
                // is a breakdown *within* this number, not a separate span. Do
                // not add it back the way the Anthropic client must — there
                // `input_tokens` excludes the cached spans, here it doesn't, and
                // summing would double-count and force phantom compaction.
                inputTokens: final.usage.input_tokens,
                outputTokens: final.usage.output_tokens,
              },
            }
          : {}),
      };
    },
  };
}

function toResponsesTool(t: ToolDef): OpenAI.Responses.FunctionTool {
  return {
    type: "function",
    // Flat here, where Chat Completions nests the same fields under `function`.
    name: t.name,
    description: t.description,
    parameters: t.inputSchema as Record<string, unknown>,
    // Explicitly off. Our schemas come from arbitrary MCP servers, and strict
    // mode demands every key be required with `additionalProperties: false` —
    // which most of them won't satisfy, and each violation 400s the whole turn.
    strict: false,
  };
}

/**
 * Convert our transcript into Responses input items.
 *
 * The shape is flatter than Chat Completions': an assistant turn's tool calls
 * become sibling `function_call` items rather than a `tool_calls` array hanging
 * off the message, and each of our tool_result blocks becomes a
 * `function_call_output` keyed by `call_id`.
 */
function toResponsesInput(messages: AgentMessage[]): OpenAI.Responses.ResponseInputItem[] {
  const out: OpenAI.Responses.ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) out.push({ role: "assistant", content: text });
      for (const b of m.content) {
        if (b.type !== "tool_use") continue;
        out.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    } else {
      // A user turn can mix free text and tool results. Tool results become
      // their own `function_call_output` items; any plain text becomes a user
      // message.
      const textParts: string[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          textParts.push(b.text);
        } else {
          out.push({
            type: "function_call_output",
            call_id: b.toolUseId,
            output: toolOutput(b),
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
    }
  }
  return out;
}

/**
 * A tool result's payload, carrying any images natively.
 *
 * The Chat Completions client has to replace a screenshot with a note saying the
 * model can't see it — not because the model can't, but because a tool-role
 * message there is text-only. Responses takes a content list, so the workaround
 * goes away and a browser screenshot reaches the model the same way it does on
 * Anthropic. The loop already leaves an image-only result's text empty on
 * purpose, and the budget already charges for the image either way.
 */
function toolOutput(b: ToolResultBlock): OpenAI.Responses.ResponseInputItem.FunctionCallOutput["output"] {
  const images = b.images ?? [];
  if (images.length === 0) return b.content;
  return [
    ...(b.content ? [{ type: "input_text" as const, text: b.content }] : []),
    ...images.map((img) => ({
      type: "input_image" as const,
      image_url: `data:${img.mimeType};base64,${img.data}`,
    })),
  ];
}
