import { z } from "zod";
import type { AgentTool, ContextUsage, StreamCallbacks } from "../types.js";
import type { ToolRegistry } from "./toolRegistry.js";

const inputSchema = z.object({ toolName: z.string().trim().min(1).max(128).optional() }).strict();

/** Turn-local facts only: never inspect credentials, environment, prompts or tool results. */
export function createRuntimeDiagnostics(options: {
  runtime: "opencode" | "codex_subscription";
  contextWindow: number | null;
  maxSteps: number;
  bashTimeoutMs: number;
  codingMode: "host" | "bubblewrap" | "disabled";
  nativeCoding: boolean;
  callbacks?: StreamCallbacks;
  signal?: AbortSignal;
}) {
  let registry: ToolRegistry | undefined;
  let context: ContextUsage | null = null;
  let contextObservedAt: string | null = null;
  let compactions = 0;
  let retries = 0;
  let trimmedTools = 0;
  let lastCompaction: { reason: "budget" | "overflow"; observedAt: string } | null = null;
  let lastRetry: {
    attempt: number;
    maxAttempts: number | null;
    delayMs: number;
    observedAt: string;
  } | null = null;
  const startedAt = Date.now();
  const callbacks: StreamCallbacks = {
    ...options.callbacks,
    onContextUsage: (usage) => {
      context = { ...usage };
      contextObservedAt = new Date().toISOString();
      options.callbacks?.onContextUsage?.(usage);
    },
    onCompact: (info) => {
      compactions++;
      lastCompaction = { reason: info.reason, observedAt: new Date().toISOString() };
      options.callbacks?.onCompact?.(info);
    },
    onModelRetry: (info) => {
      retries++;
      lastRetry = {
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        delayMs: info.delayMs,
        observedAt: new Date().toISOString(),
      };
      options.callbacks?.onModelRetry?.(info);
    },
    onToolsTrimmed: (info) => {
      trimmedTools += info.dropped.length;
      options.callbacks?.onToolsTrimmed?.(info);
    },
  };
  const tool: AgentTool = {
    name: "get_runtime_diagnostics",
    description:
      "Read this turn's runtime, measured context usage, compaction/retry observations, limits and tool availability. " +
      "Optionally look up an exact tool name. Unknown context is reported as unknown; this does not diagnose an overflow or grant access.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: {
          type: "string",
          maxLength: 128,
          description: "Optional exact tool name to inspect.",
        },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run: async (input) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        return {
          content: "Expected an optional toolName string (1–128 characters).",
          isError: true,
        };
      if (!registry)
        return { content: "Runtime diagnostics are not ready for this turn.", isError: true };
      const name = parsed.data.toolName;
      const registered = name ? registry.resolve(name) : undefined;
      const advertised = name ? registry.resident.some((entry) => entry.name === name) : false;
      return {
        content: JSON.stringify({
          scope: "current_turn",
          runtime: options.runtime,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          aborted: options.signal?.aborted ?? false,
          context: {
            measured: context !== null,
            observedAt: contextObservedAt,
            promptTokens: context?.promptTokens ?? null,
            contextWindow: context?.contextWindow ?? options.contextWindow,
            percent: context?.percent ?? null,
            coverage:
              "Latest reported primary conversation usage; not a prediction of the next request. Unknown values are null.",
          },
          limits: { maxSteps: options.maxSteps, bashTimeoutMs: options.bashTimeoutMs },
          coding: { configuredMode: options.codingMode, nativeToolsEnabled: options.nativeCoding },
          tools: {
            advertised: registry.resident.length,
            registered: registry.all.size,
            deferred: registry.searchable.length,
            discoveryAvailable: Boolean(registry.resolve("find_tools")),
            parallelDelegationAvailable: Boolean(registry.resolve("delegate_parallel_work")),
            workerRecoveryAvailable: Boolean(registry.resolve("get_parallel_work_result")),
            coverage:
              "Genosyn's current tool registry. Native runtime tools are separate. Registration is not authorization; live Grants and Member access still apply.",
          },
          observed: {
            compactions,
            retries,
            trimmedTools,
            lastCompaction,
            lastRetry,
            coverage:
              "Events reported during this turn, including forwarded worker events. Zero means none observed, not proof that no runtime recovery occurred.",
          },
          ...(name
            ? {
                tool: {
                  name,
                  registered: Boolean(registered),
                  advertised,
                  visibility: registered ? registry.visibility(name) : null,
                  readOnly: registered?.readOnly ?? null,
                  authorization: "Rechecked when called; diagnostics do not authorize execution.",
                },
              }
            : {}),
        }),
      };
    },
  };
  return {
    tool,
    callbacks,
    setRegistry: (value: ToolRegistry) => {
      registry = value;
    },
  };
}
