import type {
  AgentMessage,
  AgentTool,
  ModelClient,
  StreamCallbacks,
  ToolResultBlock,
} from "./types.js";

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
 */

export type AgentLoopResult = {
  /** The model's final human-visible prose (the last turn's text). */
  finalText: string;
  /** How many model turns we ran. */
  steps: number;
  /** Why the loop ended: "end_turn" | "max_steps" | "aborted" | provider reason. */
  stopReason: string;
};

/** How much of a tool result we keep verbatim before truncating for the model. */
const TOOL_RESULT_CAP = 60_000;

export async function runAgentLoop(params: {
  client: ModelClient;
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  maxSteps: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
}): Promise<AgentLoopResult> {
  const { client, system, tools, maxSteps, signal, callbacks } = params;
  const messages = [...params.messages];
  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  let finalText = "";
  let separatedText = false;

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) return { finalText, steps: step, stopReason: "aborted" };

    const turn = await client.streamTurn({
      system,
      messages,
      tools: toolDefs,
      signal,
      onText: callbacks?.onText,
    });

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
      callbacks?.onToolUse?.(tu.name, tu.input);
      const tool = byName.get(tu.name);
      let result;
      if (!tool) {
        result = { content: `Unknown tool: ${tu.name}`, isError: true };
      } else {
        try {
          result = await tool.run(tu.input);
        } catch (err) {
          result = {
            content: `Tool ${tu.name} threw: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
      const clipped = clip(result.content, TOOL_RESULT_CAP);
      callbacks?.onToolResult?.(tu.name, { content: clipped, isError: result.isError });
      results.push({
        type: "tool_result",
        toolUseId: tu.id,
        content: clipped || "(no output)",
        isError: result.isError,
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

function clip(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n… [truncated ${s.length - cap} chars]`;
}
