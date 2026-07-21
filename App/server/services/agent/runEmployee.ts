import type { AIModel } from "../../db/entities/AIModel.js";
import { runAgentLoop } from "./loop.js";
import { createModelClient } from "./modelClients/index.js";
import { gatherEmployeeTools } from "./tools/index.js";
import type { AgentMessage, AgentTool, StreamCallbacks } from "./types.js";
import { formatModelError } from "./modelError.js";
import {
  createParallelDelegationTool,
  MAX_DELEGATIONS_PER_TURN,
  type DelegatedBrief,
  type DelegationBudget,
} from "./tools/parallelDelegation.js";

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
  /** Internal recursion guard. Only the top-level employee can delegate. */
  delegationDepth?: number;
  /** Internal shared cap across every delegation call in this top-level turn. */
  delegationBudget?: DelegationBudget;
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

export async function runEmployeeAgent(params: EmployeeAgentParams): Promise<EmployeeAgentResult> {
  const built = await createModelClient(params.model);
  if ("error" in built) return { status: "error", error: built.error };

  const delegationDepth = params.delegationDepth ?? 0;
  const delegationBudget = params.delegationBudget ?? { remaining: MAX_DELEGATIONS_PER_TURN };
  const localTools: AgentTool[] = [];
  if (delegationDepth === 0) {
    localTools.push(
      createParallelDelegationTool({
        budget: delegationBudget,
        signal: params.signal,
        runBrief: (brief) => runDelegatedBrief(params, brief, delegationBudget),
      }),
    );
  }

  const gathered = await gatherEmployeeTools({
    employeeId: params.employeeId,
    genosynToken: params.genosynToken,
    cwd: params.cwd,
    localTools,
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
    console.error(
      `[agent:model] request failed employee=${params.employeeId} model=${params.model.id}`,
      err,
    );
    return {
      status: "error",
      error: formatModelError(params.model, err),
    };
  } finally {
    await gathered.close();
  }
}

/** Run one temporary copy of the employee with an isolated conversation. */
async function runDelegatedBrief(
  parent: EmployeeAgentParams,
  brief: DelegatedBrief,
  delegationBudget: DelegationBudget,
): Promise<{ status: "completed"; output: string } | { status: "failed"; error: string }> {
  if (parent.signal?.aborted) {
    return { status: "failed", error: "The parent turn was aborted." };
  }

  const workerLabel = brief.label.replace(/\s+/g, " ").slice(0, 40);
  const callbacks: StreamCallbacks = {
    onToolUse: (name, input) =>
      parent.callbacks?.onToolUse?.(`[worker:${workerLabel}] ${name}`, input),
    onToolResult: (name, result) =>
      parent.callbacks?.onToolResult?.(`[worker:${workerLabel}] ${name}`, result),
    onUsage: parent.callbacks?.onUsage,
    onCompact: parent.callbacks?.onCompact,
    onToolsTrimmed: parent.callbacks?.onToolsTrimmed,
  };

  const result = await runEmployeeAgent({
    ...parent,
    system: delegatedSystemPrompt(parent.system, brief.label),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: delegatedUserMessage(brief) }],
      },
    ],
    // A child is a bounded specialist, not another full-length top-level run.
    maxSteps: Math.min(parent.maxSteps, 30),
    // Give each browser-enabled worker an independent browser session instead
    // of racing the parent conversation's persistent page state.
    conversationId: undefined,
    callbacks,
    delegationDepth: (parent.delegationDepth ?? 0) + 1,
    delegationBudget,
  });

  if (parent.signal?.aborted) {
    return { status: "failed", error: "The parent turn was aborted." };
  }
  if (result.status === "error") return { status: "failed", error: result.error };
  return {
    status: "completed",
    output: result.finalText.trim() || "(worker completed without a text result)",
  };
}

function delegatedSystemPrompt(parentSystem: string, label: string): string {
  return [
    parentSystem,
    "",
    "## Temporary parallel worker",
    `You are handling the delegated brief ${JSON.stringify(label)} as a temporary copy of the parent AI Employee.`,
    "Work only on this brief. You do not receive the parent conversation, so rely on the self-contained instruction below.",
    "Use your tools when needed, but do not create a Handoff or try to delegate again. Return a concise, factual result with evidence the parent can verify and synthesize.",
  ].join("\n");
}

function delegatedUserMessage(brief: DelegatedBrief): string {
  return [
    `## Delegated brief: ${brief.label}`,
    "",
    brief.instruction,
    "",
    "Complete this brief now and return the result to the parent AI Employee.",
  ].join("\n");
}
