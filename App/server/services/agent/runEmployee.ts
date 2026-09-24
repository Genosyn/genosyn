import { randomUUID } from "node:crypto";
import type { AIModel } from "../../db/entities/AIModel.js";
import type { ModelEffort } from "../../../shared/modelEffort.js";
import { agentRuntime } from "./runtime.js";
import { config } from "../../../config.js";
import { codingRuntimeAvailability } from "./codingAvailability.js";
import {
  gatherEmployeeTools,
  guardPrivilegedTools,
  selectSurfaceTools,
  type ToolScope,
} from "./tools/index.js";
import type { AgentMessage, AgentTool, StreamCallbacks } from "./types.js";
import type { PrivilegedToolCallAuthorizer } from "../memberTurnAuthority.js";
import { formatModelError } from "./modelError.js";
import {
  createParallelDelegationTool,
  createParallelResultStore,
  createParallelWorkResultTool,
  delegatedSystemPrompt,
  MAX_DELEGATIONS_PER_TURN,
  supportsParallelDelegation,
  type DelegatedBrief,
  type DelegationBudget,
  type ParallelResultStore,
} from "./tools/parallelDelegation.js";
import { createChatProgressTool } from "./tools/chatProgress.js";
import { createRuntimeDiagnostics } from "./tools/runtimeDiagnostics.js";
import { createDurableParallelResultStore } from "./tools/durableWorkerResults.js";
import { resolveRecoveryScope } from "./workRecoveryScope.js";
import {
  NATIVE_CODING_CAPABILITY,
  prepareRetryCapabilities,
  recordRegistryCapabilities,
  RetryPreflightError,
  type RetryCapabilityRecorder,
} from "./retryPreflight.js";
import { residentOnlyRegistry } from "./tools/toolRegistry.js";
import { runCodexSubscriptionTurn } from "./codexRuntime.js";
import { CompanyAgentCapacityError, withCompanyAgentCapacity } from "../companyAgentCapacity.js";
import { issueDelegatedMcpToken, resolveMcpToken, revokeMcpToken } from "../mcpTokens.js";
import { selfReviewToolScope } from "../proactive/reviewPolicy.js";
import { proactiveReviewToolScope, PROACTIVE_REVIEW_BRIEF } from "../proactive/workReviewPolicy.js";

/**
 * Run one employee agent turn end-to-end — the entry point both the chat seam
 * and the routine runner call.
 *
 * This is the whole runtime job:
 *   1. configure OpenCode, or the official OpenAI Codex subscription runtime,
 *      from the employee's AIModel credentials;
 *   2. assemble the tool list (coding + genosyn + browser + user MCP servers);
 *   3. let the selected runtime run its loop and forward activity to `callbacks`;
 *   4. tear the bridged MCP connections down.
 *
 * Returns the model's final reply text, or a friendly error the seam can show.
 */

export type EmployeeAgentParams = {
  model: AIModel;
  /** Turn-local effort; null leaves the model's default unchanged. */
  effort?: ModelEffort | null;
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
  /** Default native bash timeout; Genosyn command tools enforce it as a ceiling. */
  bashTimeoutMs: number;
  /** Max model turns before we stop; null leaves the turn bounded by its caller's deadline. */
  maxSteps: number | null;
  routineId?: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
  /** Internal recursion guard. Only the top-level employee can delegate. */
  delegationDepth?: number;
  /** Internal shared cap across every delegation call in this top-level turn. */
  delegationBudget?: DelegationBudget;
  /** Server-owned retry dependencies; workers inherit the parent's recorder. */
  recoveryRecorder?: RetryCapabilityRecorder;
  recoveryGrantObserver?: (grants: string[]) => Promise<void>;
  requiredTools?: string[];
  /** Model-facing tool names the employee's active Skills asked to keep loaded. */
  skillToolset?: string[];
  /** Surface-specific in-process tools, kept resident for this turn. */
  extraTools?: AgentTool[];
  /**
   * Explicit authority classification for extraTools. Omitted is privileged,
   * so a future local tool cannot accidentally escape the live Member gate.
   */
  extraToolsAuthority?: "member" | "privileged";
  /**
   * Coding, browser, and company-configured MCP servers have no per-Member
   * ACL. Only employee automation or an administrative Member may receive
   * them; ordinary interactive Members stay on the governed Genosyn surface.
   */
  allowPrivilegedToolSources?: boolean;
  /** Re-check administrative Member authority before every ambient tool call. */
  authorizePrivilegedToolCall?: PrivilegedToolCallAuthorizer;
  /**
   * Confine the turn to one surface's tools — a Repository work session gets
   * the `repository_*` tools and nothing else, delegation included. See
   * {@link ToolScope}.
   */
  toolScope?: ToolScope;
};

export type EmployeeAgentResult =
  | {
      status: "ok";
      finalText: string;
      steps: number;
      /**
       * Why the runtime ended: `"end_turn"`,
       * `"max_steps"`, `"aborted"`, or a provider-specific reason. Undefined on
       * the OpenAI subscription runtime, which does not report one. Callers
       * that care about honest completion treat `"max_steps"` as unfinished
       * work — the loop was stopped by the runaway backstop, not by the model
       * deciding it was done.
       */
      stopReason?: string;
    }
  | { status: "error"; error: string };

/**
 * Parameters for a deliberately tool-contained model turn.
 *
 * Unlike {@link runEmployeeAgent}, this path never gathers coding tools,
 * Genosyn tools, browser access, company MCP servers, repositories, or secret
 * environment variables. It is for narrow decisions over untrusted input
 * where the caller supplies the complete local tool surface explicitly.
 */
export type RestrictedEmployeeAgentParams = {
  model: AIModel;
  effort?: ModelEffort | null;
  employeeId: string;
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  maxSteps: number;
  signal?: AbortSignal;
  callbacks?: StreamCallbacks;
};

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
  try {
    return await withCompanyAgentCapacity(params.employeeId, params.signal, (signal) =>
      runEmployeeTurn({ ...params, signal }),
    );
  } catch (error) {
    if (error instanceof RetryPreflightError) throw error;
    if (error instanceof CompanyAgentCapacityError)
      return { status: "error", error: error.message };
    return { status: "error", error: formatModelError(params.model, error) };
  }
}

async function runEmployeeTurn(params: EmployeeAgentParams): Promise<EmployeeAgentResult> {
  // Token authority also narrows callers that omit or override the visible scope.
  const tokenInfo = resolveMcpToken(params.genosynToken);
  const reviewScope =
    selfReviewToolScope(tokenInfo?.selfReviewOnly) ??
    proactiveReviewToolScope(tokenInfo?.proactiveReview);
  if (tokenInfo?.proactiveReview)
    params = { ...params, system: `${params.system}\n\n${PROACTIVE_REVIEW_BRIEF}` };
  if (reviewScope) {
    params = {
      ...params,
      toolScope: reviewScope,
      allowPrivilegedToolSources: false,
      extraTools: [],
    };
  }
  const delegationDepth = params.delegationDepth ?? 0;
  const delegationBudget = params.delegationBudget ?? { remaining: MAX_DELEGATIONS_PER_TURN };
  const allowPrivileged = params.allowPrivilegedToolSources ?? true;
  const diagnostics = createRuntimeDiagnostics({
    runtime: params.model.authMode === "subscription" ? "codex_subscription" : "opencode",
    contextWindow: params.model.contextWindow,
    maxSteps: params.maxSteps,
    bashTimeoutMs: params.bashTimeoutMs,
    codingMode: config.agent.codingTools.executionMode,
    nativeCoding:
      params.model.authMode !== "subscription" &&
      allowPrivileged &&
      !params.toolScope?.surfaceOnly &&
      config.agent.codingTools.executionMode === "host" &&
      codingRuntimeAvailability().available,
    callbacks: params.callbacks,
    signal: params.signal,
  });
  // Workers forward cost/retry observations, but never replace the parent's context reading.
  params = { ...params, callbacks: diagnostics.callbacks };
  const deferredLocalTools: AgentTool[] = params.toolScope?.surfaceOnly ? [] : [diagnostics.tool];
  const localTools: AgentTool[] = selectSurfaceTools(params.extraTools ?? [], {
    authority: params.extraToolsAuthority,
    allowPrivileged,
    authorizePrivilegedToolCall: params.authorizePrivilegedToolCall,
  });
  if (!reviewScope && delegationDepth === 0 && params.callbacks?.onProgress) {
    localTools.push(createChatProgressTool(params.callbacks.onProgress));
  }
  if (
    allowPrivileged &&
    !params.toolScope?.surfaceOnly &&
    supportsParallelDelegation(params.model.authMode, delegationDepth)
  ) {
    const recoveryScope = await resolveRecoveryScope(params.genosynToken);
    const resultStore: ParallelResultStore = recoveryScope
      ? createDurableParallelResultStore(params.genosynToken, recoveryScope)
      : createParallelResultStore();
    deferredLocalTools.push(
      ...guardPrivilegedTools(
        [createParallelWorkResultTool(resultStore)],
        params.authorizePrivilegedToolCall,
      ),
    );
    localTools.push(
      ...guardPrivilegedTools(
        [
          createParallelDelegationTool({
            budget: delegationBudget,
            resultStore,
            signal: params.signal,
            runBrief: (brief, resultId) =>
              runDelegatedBrief(
                {
                  ...params,
                  recoveryGrantObserver:
                    resultId && resultStore.captureGrants
                      ? (grants) => resultStore.captureGrants!(resultId, grants)
                      : undefined,
                },
                brief,
                delegationBudget,
              ),
            preflight: async (briefs) => {
              try {
                await params.recoveryRecorder?.check(
                  briefs.flatMap((brief) => brief.requiredTools ?? []),
                );
                return null;
              } catch (error) {
                if (error instanceof RetryPreflightError) return error.message;
                throw error;
              }
            },
          }),
        ],
        params.authorizePrivilegedToolCall,
      ),
    );
  }

  if (params.model.authMode === "subscription") {
    return runSubscriptionEmployeeAgent(params, localTools, deferredLocalTools, diagnostics);
  }

  const gathered = await gatherEmployeeTools({
    employeeId: params.employeeId,
    genosynToken: params.genosynToken,
    cwd: params.cwd,
    localTools,
    deferredLocalTools,
    toolEnv: params.toolEnv,
    bashTimeoutMs: params.bashTimeoutMs,
    skillToolset: params.skillToolset,
    routineId: params.routineId,
    conversationId: params.conversationId,
    runId: params.runId,
    signal: params.signal,
    allowPrivilegedToolSources: params.allowPrivilegedToolSources,
    authorizePrivilegedToolCall: params.authorizePrivilegedToolCall,
    toolScope: params.toolScope,
    nativeCoding: config.agent.codingTools.executionMode === "host",
    onDeprecatedFamily: (family, target) => {
      console.warn(
        `[genosyn] employee=${params.employeeId} used the deprecated family tool "${family}" ` +
          `(-> ${target}). Update the Skill or Soul that names it.`,
      );
    },
  });

  params.callbacks?.onToolsDeferred?.(gathered.registry.stats);

  const nativeCoding =
    allowPrivileged &&
    !params.toolScope?.surfaceOnly &&
    config.agent.codingTools.executionMode === "host" &&
    codingRuntimeAvailability().available;

  // Kept as a backstop even though the resident set is now far under any
  // provider cap: it is the only guard against a 400 that kills the whole run,
  // and a bridged MCP server could still hand us a hundred tools. Reserve
  // sixteen slots for OpenCode's native tools when coding is on.
  gathered.registry.resident = trimToProviderCap(
    gathered.registry.resident,
    params.model.provider === "openai" ? (nativeCoding ? 112 : 128) : null,
    params.callbacks,
  );
  diagnostics.setRegistry(gathered.registry);

  try {
    const recorder = await prepareRetryCapabilities({
      token: params.genosynToken,
      employeeId: params.employeeId,
      registry: gathered.registry,
      nativeCoding,
      requiredTools: params.requiredTools,
      inherited: params.recoveryRecorder,
    });
    params.recoveryRecorder = recorder;
    recordRegistryCapabilities(gathered.registry, recorder, params.recoveryGrantObserver);
    const nativeAuthorizer =
      nativeCoding && (tokenInfo?.runId || params.recoveryGrantObserver)
        ? async () => {
            const grants = await recorder.record([NATIVE_CODING_CAPABILITY]);
            await params.recoveryGrantObserver?.(grants);
            return params.authorizePrivilegedToolCall?.() ?? null;
          }
        : params.authorizePrivilegedToolCall;
    const result = await agentRuntime.run({
      model: params.model,
      effort: params.effort,
      system: params.system,
      messages: params.messages,
      registry: gathered.registry,
      maxSteps: params.maxSteps,
      cwd: params.cwd,
      toolEnv: params.toolEnv,
      bashTimeoutMs: params.bashTimeoutMs,
      nativeCoding,
      authorizePrivilegedToolCall: nativeAuthorizer,
      signal: params.signal,
      callbacks: params.callbacks,
    });
    return {
      status: "ok",
      finalText: result.finalText,
      steps: result.steps,
      stopReason: result.stopReason,
    };
  } catch (err) {
    if (err instanceof RetryPreflightError) throw err;
    reportAgentTurnFailure(
      "request failed",
      params.employeeId,
      params.model.id,
      params.signal,
      err,
    );
    return {
      status: "error",
      error: formatModelError(params.model, err),
    };
  } finally {
    try {
      await params.recoveryRecorder?.flush();
    } finally {
      await gathered.close();
    }
  }
}

/**
 * Run a model with only the local tools the caller supplied.
 *
 * Keep this separate from the full employee runtime instead of adding a
 * boolean that can be forgotten at a call site: a restricted turn has no cwd,
 * MCP token, tool environment, repo materialization, or discovery catalogue to
 * accidentally widen later. Both OpenCode and the official OpenAI
 * subscription runtime receive the same tiny registry.
 */
export async function runRestrictedEmployeeAgent(
  params: RestrictedEmployeeAgentParams,
): Promise<EmployeeAgentResult> {
  try {
    return await withCompanyAgentCapacity(params.employeeId, params.signal, (signal) =>
      runRestrictedEmployeeTurn({ ...params, signal }),
    );
  } catch (error) {
    if (error instanceof CompanyAgentCapacityError)
      return { status: "error", error: error.message };
    return { status: "error", error: formatModelError(params.model, error) };
  }
}

async function runRestrictedEmployeeTurn(
  params: RestrictedEmployeeAgentParams,
): Promise<EmployeeAgentResult> {
  const registry = residentOnlyRegistry(params.tools);
  try {
    if (params.model.authMode === "subscription") {
      const result = await runCodexSubscriptionTurn({
        model: params.model,
        effort: params.effort,
        system: params.system,
        messages: params.messages,
        registry,
        maxSteps: params.maxSteps,
        signal: params.signal,
        callbacks: params.callbacks,
      });
      return { status: "ok", finalText: result.finalText, steps: result.steps };
    }

    const result = await agentRuntime.run({
      model: params.model,
      effort: params.effort,
      system: params.system,
      messages: params.messages,
      registry,
      maxSteps: params.maxSteps,
      nativeCoding: false,
      signal: params.signal,
      callbacks: params.callbacks,
    });
    return {
      status: "ok",
      finalText: result.finalText,
      steps: result.steps,
      stopReason: result.stopReason,
    };
  } catch (err) {
    reportAgentTurnFailure(
      "restricted request failed",
      params.employeeId,
      params.model.id,
      params.signal,
      err,
    );
    return {
      status: "error",
      error: formatModelError(params.model, err),
    };
  }
}

async function runSubscriptionEmployeeAgent(
  params: EmployeeAgentParams,
  localTools: AgentTool[],
  deferredLocalTools: AgentTool[],
  diagnostics: ReturnType<typeof createRuntimeDiagnostics>,
): Promise<EmployeeAgentResult> {
  let gathered: Awaited<ReturnType<typeof gatherEmployeeTools>> | null = null;
  try {
    gathered = await gatherEmployeeTools({
      employeeId: params.employeeId,
      genosynToken: params.genosynToken,
      cwd: params.cwd,
      localTools,
      deferredLocalTools,
      toolEnv: params.toolEnv,
      bashTimeoutMs: params.bashTimeoutMs,
      skillToolset: params.skillToolset,
      routineId: params.routineId,
      conversationId: params.conversationId,
      runId: params.runId,
      signal: params.signal,
      allowPrivilegedToolSources: params.allowPrivilegedToolSources,
      authorizePrivilegedToolCall: params.authorizePrivilegedToolCall,
      toolScope: params.toolScope,
      onDeprecatedFamily: (family, target) => {
        console.warn(
          `[genosyn] employee=${params.employeeId} used the deprecated family tool "${family}" ` +
            `(-> ${target}). Update the Skill or Soul that names it.`,
        );
      },
    });

    params.callbacks?.onToolsDeferred?.(gathered.registry.stats);
    // Dynamic tools follow the Responses API naming/size contract. The normal
    // working set is around twenty; retain the provider's published ceiling as
    // a defensive backstop for unusually large Skill-requested resident sets.
    gathered.registry.resident = trimToProviderCap(
      gathered.registry.resident,
      128,
      params.callbacks,
    );
    diagnostics.setRegistry(gathered.registry);

    const recorder = await prepareRetryCapabilities({
      token: params.genosynToken,
      employeeId: params.employeeId,
      registry: gathered.registry,
      nativeCoding: false,
      requiredTools: params.requiredTools,
      inherited: params.recoveryRecorder,
    });
    params.recoveryRecorder = recorder;
    recordRegistryCapabilities(gathered.registry, recorder, params.recoveryGrantObserver);

    const result = await runCodexSubscriptionTurn({
      model: params.model,
      effort: params.effort,
      system: params.system,
      messages: params.messages,
      registry: gathered.registry,
      maxSteps: params.maxSteps,
      signal: params.signal,
      callbacks: params.callbacks,
    });
    return { status: "ok", finalText: result.finalText, steps: result.steps };
  } catch (err) {
    if (err instanceof RetryPreflightError) throw err;
    reportAgentTurnFailure(
      "subscription request failed",
      params.employeeId,
      params.model.id,
      params.signal,
      err,
    );
    return {
      status: "error",
      error: formatModelError(params.model, err),
    };
  } finally {
    try {
      await params.recoveryRecorder?.flush();
    } finally {
      await gathered?.close();
    }
  }
}

/**
 * Log why a turn ended badly — unless it ended because someone asked it to.
 *
 * A cancelled turn surfaces here as an abort error from whichever provider was
 * mid-stream, and printing that as a failure with a stack trace teaches an
 * operator to distrust their own logs: a Member stopping a reply, a turn
 * hitting its deadline, and a worker losing its claim are all normal. The
 * error is still reported to the caller either way; only the log line changes.
 */
function reportAgentTurnFailure(
  kind: string,
  employeeId: string,
  modelId: string,
  signal: AbortSignal | undefined,
  err: unknown,
): void {
  if (signal?.aborted) {
    console.info(`[agent:model] ${kind.replace("failed", "stopped")} employee=${employeeId}`);
    return;
  }
  console.error(`[agent:model] ${kind} employee=${employeeId} model=${modelId}`, err);
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
  const workerCallPrefix = randomUUID();
  const scopedCallId = (callId?: string) =>
    callId === undefined ? undefined : `${workerCallPrefix}:${callId}`;
  const callbacks: StreamCallbacks = {
    onToolUse: (name, input, callId) =>
      parent.callbacks?.onToolUse?.(`[worker:${workerLabel}] ${name}`, input, scopedCallId(callId)),
    onToolResult: (name, result, callId) =>
      parent.callbacks?.onToolResult?.(
        `[worker:${workerLabel}] ${name}`,
        result,
        scopedCallId(callId),
      ),
    onModelRetry: parent.callbacks?.onModelRetry,
    onUsage: parent.callbacks?.onUsage,
    onCompact: parent.callbacks?.onCompact,
    onToolsTrimmed: parent.callbacks?.onToolsTrimmed,
    // `onContextUsage` is deliberately absent. A worker's `messages` is
    // replaced below with a single fresh brief, so its prompt is small and
    // unrelated to the parent conversation — forwarding it would make the
    // Member's context gauge drop to a worker's reading mid-turn and then jump
    // back. `onUsage` is still forwarded because a cost line legitimately wants
    // every provider call, worker or not.
  };

  const workerToken = issueDelegatedMcpToken(parent.genosynToken);
  let result: EmployeeAgentResult;
  try {
    result = await runEmployeeAgent({
      ...parent,
      genosynToken: workerToken,
      system: delegatedSystemPrompt(parent.system, brief.label),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: delegatedUserMessage(brief) }],
        },
      ],
      // Routine workers share their parent's deadline without a separate step
      // ceiling. Finite interactive turns keep their smaller specialist cap.
      maxSteps: parent.maxSteps === null ? null : Math.min(parent.maxSteps, 30),
      // Give each browser-enabled worker an independent browser session instead
      // of racing the parent conversation's persistent page state.
      conversationId: undefined,
      callbacks,
      delegationDepth: (parent.delegationDepth ?? 0) + 1,
      delegationBudget,
      requiredTools: brief.requiredTools,
    });
  } finally {
    revokeMcpToken(workerToken);
  }

  if (result.status === "error") return { status: "failed", error: result.error };
  if (result.stopReason === "aborted") {
    return {
      status: "failed",
      error: `Worker interrupted. Partial evidence: ${result.finalText.trim() || "none"}`,
    };
  }
  if (result.stopReason === "max_steps") {
    return {
      status: "failed",
      error: `Worker reached its step limit before finishing. Partial evidence: ${result.finalText.trim() || "none"}`,
    };
  }
  return {
    status: "completed",
    output: result.finalText.trim() || "(worker completed without a text result)",
  };
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
