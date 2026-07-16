import type { AIModel } from "../../db/entities/AIModel.js";
import { runAgentLoop } from "./loop.js";
import { createModelClient } from "./modelClients/index.js";
import { gatherEmployeeTools } from "./tools/index.js";
import type { AgentMessage, AgentTool, StreamCallbacks } from "./types.js";

/**
 * Run one employee agent turn end-to-end — the entry point both the chat seam
 * and the routine runner call.
 *
 * This is the whole job the harness CLI used to do, in-process:
 *   1. build the model client from the employee's AIModel credentials;
 *   2. assemble the tool list (coding + genosyn + browser + user MCP servers);
 *   3. run the tool-use loop, streaming text and tool activity via `callbacks`;
 *   4. tear the bridged MCP connections down.
 *
 * Returns the model's final reply text, or a friendly error the seam can show.
 */

export type EmployeeAgentParams = {
  model: AIModel;
  employeeId: string;
  /** System prompt: persona + Soul + memory + skills + tools briefing. */
  system: string;
  /** Conversation so far, ending with the message to act on. */
  messages: AgentMessage[];
  /** The employee's working directory (repos, attachments, bash cwd). */
  cwd: string;
  /** Env for the bash tool — company secrets + materialized repo vars. */
  toolEnv: Record<string, string>;
  /** Short-lived MCP token scoping genosyn/browser tool calls to this employee. */
  genosynToken: string;
  /** Hard ceiling on a single bash invocation. */
  bashTimeoutMs: number;
  /** Max model turns before we stop (runaway-loop backstop). */
  maxSteps: number;
  routineId?: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
};

export type EmployeeAgentResult =
  | { status: "ok"; finalText: string; steps: number }
  | { status: "error"; error: string };

/**
 * Cut the tool list down to what the provider will accept.
 *
 * OpenAI 400s an over-length `tools` array and takes the whole run with it, so a
 * trimmed employee beats a dead one. `gatherEmployeeTools` has already ordered
 * the list so the tools the employee holds no grant for sit at the back, which
 * is why cutting from the tail cuts the least useful thing first rather than an
 * arbitrary one.
 *
 * A null cap means the provider publishes no limit (Anthropic, any custom
 * endpoint) — never a number we invented. Nothing is dropped in that case.
 */
function trimToProviderCap(
  tools: AgentTool[],
  limit: number | null,
  callbacks?: StreamCallbacks,
): AgentTool[] {
  if (limit === null || tools.length <= limit) return tools;
  const kept = tools.slice(0, limit);
  callbacks?.onToolsTrimmed?.({
    offered: tools.length,
    limit,
    dropped: tools.slice(limit).map((t) => t.name),
  });
  return kept;
}

export async function runEmployeeAgent(
  params: EmployeeAgentParams,
): Promise<EmployeeAgentResult> {
  const built = createModelClient(params.model);
  if ("error" in built) return { status: "error", error: built.error };

  const gathered = await gatherEmployeeTools({
    employeeId: params.employeeId,
    genosynToken: params.genosynToken,
    cwd: params.cwd,
    toolEnv: params.toolEnv,
    bashTimeoutMs: params.bashTimeoutMs,
    routineId: params.routineId,
    conversationId: params.conversationId,
    runId: params.runId,
    signal: params.signal,
  });

  const tools = trimToProviderCap(gathered.tools, built.client.maxTools, params.callbacks);

  try {
    const result = await runAgentLoop({
      client: built.client,
      system: params.system,
      messages: params.messages,
      tools,
      maxSteps: params.maxSteps,
      // Read off the model row rather than taking it as a param: it's the only
      // source, and every seam that can run an agent already holds the row.
      contextWindow: params.model.contextWindow,
      signal: params.signal,
      callbacks: params.callbacks,
    });
    return { status: "ok", finalText: result.finalText, steps: result.steps };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await gathered.close();
  }
}
