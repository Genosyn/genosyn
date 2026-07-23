import {
  compactMessages,
  isContextOverflowError,
  projectPromptTokens,
  promptBudget,
  toolResultCap,
} from "./contextBudget.js";
import type {
  AgentMessage,
  ModelClient,
  StreamCallbacks,
  ToolResult,
  ToolResultBlock,
} from "./types.js";
import type { ToolRegistry } from "./tools/toolRegistry.js";
import { PARSE_ERROR_KEY } from "./modelClients/parseArgs.js";

/**
 * The agentic loop — the thing the harness CLIs used to own.
 *
 * We call the model for one turn, stream its text out, and if it asked to call
 * tools we execute them, feed the results back, and go again. We stop when the
 * model produces a turn with no tool calls (it's done) or when we hit the step
 * ceiling (a runaway loop backstop).
 *
 * The loop is provider-agnostic: {@link ModelClient} hides the wire format and
 * {@link AgentTool} hides where a tool actually runs (in-process coding tool,
 * loopback genosyn call, or a bridged MCP server).
 *
 * ## Staying inside the window
 *
 * A transcript only grows, so a long run will eventually outgrow whatever room
 * the model has. We defend in two places, because neither is sufficient alone:
 *
 *   1. **Before each turn**, project what the prompt will cost (the provider's
 *      count for the last turn, plus an estimate of what we've appended since)
 *      and compact if it wouldn't fit. This is the one that keeps runs healthy.
 *   2. **After a rejected turn**, catch the provider's context-length 400,
 *      compact hard, and retry once. This is the backstop for when the estimate
 *      in (1) was wrong, or when we never had a window to budget against.
 *
 * Both need `contextWindow`. When it's null we can't budget at all and only (2)
 * applies — which is why the model's window is worth knowing (see
 * `services/agent/contextWindow.ts`).
 */

export type AgentLoopResult = {
  /** The model's final human-visible prose (the last turn's text). */
  finalText: string;
  /** How many model turns we ran. */
  steps: number;
  /** Why the loop ended: "end_turn" | "max_steps" | "aborted" | provider reason. */
  stopReason: string;
};

export async function runAgentLoop(params: {
  client: ModelClient;
  system: string;
  messages: AgentMessage[];
  registry: ToolRegistry;
  maxSteps: number;
  /** The model's context window in tokens, or null when we don't know it. */
  contextWindow?: number | null;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<AgentLoopResult> {
  const { client, system, registry, maxSteps, signal, callbacks } = params;
  const contextWindow = params.contextWindow ?? null;
  const messages = [...params.messages];
  // Derived once, above the loop, from an array the registry never mutates —
  // so the provider sees a byte-identical `tools` payload on every step.
  const toolDefs = registry.resident.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const resultCap = toolResultCap(contextWindow);

  let finalText = "";
  let separatedText = false;
  /** The provider's own count for the last prompt — our compaction anchor. */
  let lastPromptTokens: number | null = null;
  /** How many messages that anchor covers. Anything past it is our estimate. */
  let anchoredThrough = 0;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { finalText, steps: step, stopReason: "aborted" };

    // (1) Pre-flight: will the prompt we're about to send fit?
    if (contextWindow) {
      const projected = projectPromptTokens(lastPromptTokens, messages.slice(anchoredThrough));
      const budget = promptBudget(contextWindow);
      if (projected !== null && projected > budget) {
        const { evicted, freedTokens } = compactMessages({
          messages,
          currentTokens: projected,
          targetTokens: budget,
        });
        if (evicted > 0) {
          callbacks?.onCompact?.({ evicted, freedTokens, reason: "budget" });
          if (lastPromptTokens !== null) {
            lastPromptTokens = Math.max(0, lastPromptTokens - freedTokens);
          }
        }
      }
    }

    const promptedThrough = messages.length;
    const turn = await streamTurnWithRecovery({
      client,
      system,
      messages,
      toolDefs,
      signal,
      callbacks,
    });

    lastPromptTokens = turn.usage?.inputTokens ?? null;
    anchoredThrough = promptedThrough;
    if (turn.usage) callbacks?.onUsage?.(turn.usage);

    messages.push({ role: "assistant", content: turn.blocks });

    const turnText = turn.blocks
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (turnText.trim()) finalText = turnText;

    const toolUses = turn.blocks.filter(
      (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      return { finalText, steps: step + 1, stopReason: turn.stopReason || "end_turn" };
    }

    // Between reply prose and the next turn, drop a blank line into any log
    // consumer so tool activity reads cleanly under the text.
    if (turnText.trim() && !separatedText) separatedText = true;

    const results: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      // Honor cancellation promptly — don't start further tool work once the
      // turn has been aborted (a timeout, or a user cancel). Tools that don't
      // observe the signal themselves are short-circuited here.
      if (signal?.aborted) {
        results.push({
          type: "tool_result",
          toolUseId: tu.id,
          content: "Aborted before running.",
          isError: true,
        });
        continue;
      }
      // Lenient dispatch: `resolve` reads the whole registry, not just what we
      // advertised. A model naming a deferred tool directly — from a Skill,
      // from find_tools, or from memory — is right, and answering "unknown
      // tool" would punish it for being right.
      const tool = registry.resolve(tu.name);
      // A dispatching tool (`call_tool`, a retired family alias) reports the
      // target it is really running, so the transcript names the tool the model
      // reached for rather than the door it came through.
      const described = tool?.describeCall?.(tu.input);
      const reportedName = described?.name ?? tu.name;
      callbacks?.onToolUse?.(reportedName, described?.input ?? tu.input);

      let result: ToolResult;
      // The OpenAI-shaped clients stamp a malformed argument blob here rather
      // than silently passing `{}`. Answer it before dispatch: every tool's zod
      // is `.strict()`, so letting the stamp through would trade a misleading
      // "field is required" for an equally misleading "unrecognized key".
      const parseError = tu.input[PARSE_ERROR_KEY];
      if (typeof parseError === "string") {
        result = {
          content:
            `Your arguments for ${reportedName} did not parse: ${parseError}\n` +
            "Re-send the call with valid JSON.",
          isError: true,
        };
      } else if (!tool) {
        // Only point at find_tools when it actually exists — with discovery off
        // every tool is resident, so advising the model to call a tool that
        // isn't there would just invite it to retry until the step limit.
        const hint = registry.resolve("find_tools")
          ? " Call find_tools to see what is available."
          : "";
        result = { content: `Unknown tool: ${tu.name}.${hint}`, isError: true };
      } else {
        try {
          result = await tool.run(tu.input);
        } catch (err) {
          result = {
            content: `Tool ${reportedName} threw: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
      const clipped = clip(result.content, resultCap);
      const images = result.images;
      callbacks?.onToolResult?.(reportedName, { content: clipped, isError: result.isError, images });
      results.push({
        type: "tool_result",
        toolUseId: tu.id,
        // An image-only result (a screenshot) legitimately has empty text.
        content: clipped || (images && images.length > 0 ? "" : "(no output)"),
        isError: result.isError,
        ...(images && images.length > 0 ? { images } : {}),
      });
    }

    messages.push({ role: "user", content: results });
  }

  return {
    finalText: finalText || "(the agent stopped after reaching the step limit)",
    steps: maxSteps,
    stopReason: "max_steps",
  };
}

/**
 * (2) Run one turn, and if the provider rejects the prompt as too long, compact
 * as hard as we're allowed to and try once more.
 *
 * This exists because the pre-flight check can be wrong in both directions: our
 * estimate of un-sent content is approximate, and when the window is unknown
 * there's no pre-flight at all. Retrying costs one round-trip; not retrying
 * costs the whole run, which is the bug this replaced.
 *
 * `keepRecentBatches: 1` is the aggressive setting — everything but the batch
 * the model is actively reasoning about becomes a stub. If that still doesn't
 * free anything, the prompt is irreducible (system prompt + tool catalog +
 * one turn already exceed the window) and no retry will help, so we surface
 * that plainly instead of looping.
 */
async function streamTurnWithRecovery(params: {
  client: ModelClient;
  system: string;
  messages: AgentMessage[];
  toolDefs: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}) {
  const { client, system, messages, toolDefs, signal, callbacks } = params;
  try {
    return await client.streamTurn({
      system,
      messages,
      tools: toolDefs,
      signal,
      onText: callbacks?.onText,
    });
  } catch (err) {
    if (!isContextOverflowError(err)) throw err;

    // We know the prompt exceeded the window but not by how much — the call
    // failed, so there's no usage to read. Rather than invent a number to
    // compact against, free everything we're allowed to: target zero, keep only
    // the batch in flight. This is the emergency path, and a run that survives
    // with a thin history beats a run that dies with a rich one.
    const { evicted, freedTokens } = compactMessages({
      messages,
      currentTokens: Number.MAX_SAFE_INTEGER,
      targetTokens: 0,
      keepRecentBatches: 1,
    });
    if (evicted === 0) {
      throw new Error(
        "The prompt is too long for this model's context window, and there is nothing " +
          `left to drop — the system prompt (Soul + skills) plus ${toolDefs.length} resident ` +
          "tools and a single turn already exceed it. Trim the employee's skills, or move it " +
          "to a model with a larger window. Original error: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    callbacks?.onCompact?.({ evicted, freedTokens, reason: "overflow" });

    return await client.streamTurn({
      system,
      messages,
      tools: toolDefs,
      signal,
      onText: callbacks?.onText,
    });
  }
}

function clip(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n… [truncated ${s.length - cap} chars]`;
}
