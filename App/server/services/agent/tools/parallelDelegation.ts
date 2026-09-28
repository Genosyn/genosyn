import type { AgentTool } from "../types.js";
import { createParallelResultStore, type ParallelResultStore } from "./parallelWorkerResults.js";

export {
  createParallelResultStore,
  createParallelWorkResultTool,
} from "./parallelWorkerResults.js";
export type { ParallelResultStore } from "./parallelWorkerResults.js";

/** Hard limits keep one model turn from multiplying into unbounded API spend. */
export const MAX_PARALLEL_DELEGATIONS = 4;
export const MAX_DELEGATIONS_PER_CALL = 8;
export const MAX_DELEGATIONS_PER_TURN = 12;

const MAX_LABEL_LENGTH = 80;
const MAX_INSTRUCTION_LENGTH = 20_000;
const MAX_RESULT_LENGTH = 600;
/** Return control before a transport timeout; workers remain owned by this turn. */
export const PARALLEL_DELEGATION_WAIT_MS = 30_000;

export type DelegationBudget = { remaining: number };

/**
 * Managed ChatGPT credentials can rotate, so subscription turns serialize on
 * one model lock. A parent cannot wait on a delegated copy that is waiting for
 * that same lock. Temporary workers also pass a non-zero depth so delegation
 * remains one level deep.
 */
export function supportsParallelDelegation(
  authMode: "apikey" | "subscription" | "customEndpoint",
  delegationDepth = 0,
): boolean {
  return authMode !== "subscription" && delegationDepth === 0;
}

/** Build a worker prompt without claiming that one-level delegation is recursive. */
export function delegatedSystemPrompt(parentSystem: string, label: string): string {
  const workerSystem = parentSystem
    .split("\n")
    .map(stripGeneratedDelegationReference)
    .filter((line): line is string => line !== null)
    .join("\n");
  return [
    workerSystem,
    "",
    "## Temporary parallel worker",
    `You are handling the delegated brief ${JSON.stringify(label)} as a temporary copy of the parent AI Employee.`,
    "Work only on this brief. You do not receive the parent conversation, so rely on the self-contained instruction below.",
    "Use your tools when needed, but do not create a Handoff or try to delegate again. Return a concise, factual result with evidence the parent can verify and synthesize.",
    "Report any unfinished work to the parent. Only the parent can mark its Routine Run as failed.",
  ].join("\n");
}

function stripGeneratedDelegationReference(line: string): string | null {
  if (line.startsWith("- Parallel delegation: `delegate_parallel_work`")) return null;
  if (line.startsWith("Run outcome: ")) return null;
  if (!line.startsWith("_Tools: ")) return line;

  const tools = line
    .slice("_Tools: ".length, line.endsWith("_") ? -1 : undefined)
    .split(", ")
    .filter((tool) => tool !== "`delegate_parallel_work`");
  return tools.length > 0 ? `_Tools: ${tools.join(", ")}_` : null;
}

export type DelegatedBrief = {
  label: string;
  instruction: string;
  requiredTools?: string[];
};

export type DelegatedBriefResult =
  | { status: "completed"; output: string }
  | { status: "failed"; error: string };

/**
 * Build the one-level parallel-delegation tool exposed to a top-level employee.
 *
 * The runtime owns the actual child turn through `runBrief`; this module only
 * validates the model's requested briefs, enforces the shared turn budget, and
 * schedules them with a small worker pool. Keeping orchestration here makes the
 * safety limits independently smoke-testable without a real model API.
 */
export function createParallelDelegationTool(params: {
  budget: DelegationBudget;
  resultStore?: ParallelResultStore;
  signal?: AbortSignal;
  runBrief: (
    brief: DelegatedBrief,
    resultId?: string,
    signal?: AbortSignal,
  ) => Promise<DelegatedBriefResult>;
  preflight?: (briefs: DelegatedBrief[]) => Promise<string | null>;
  onBackgroundWork?: (pendingGroups: number) => void;
}): AgentTool & { close(): Promise<void> } {
  const resultStore: ParallelResultStore = params.resultStore ?? createParallelResultStore();
  const lifetime = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, lifetime.signal])
    : lifetime.signal;
  const active = new Set<Promise<unknown>>();
  let pendingGroups = 0;
  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work);
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    );
    return work;
  };
  // Several pending delegation calls share one pool, rather than multiplying
  // the advertised four-worker bound by the number of calls in flight.
  let activeWorkers = 0;
  const waiting: Array<{
    run(): Promise<DelegatedBriefResult>;
    resolve(result: DelegatedBriefResult): void;
    reject(error: unknown): void;
  }> = [];
  const pump = () => {
    while (waiting.length > 0 && activeWorkers < MAX_PARALLEL_DELEGATIONS) {
      const worker = waiting.shift()!;
      if (signal.aborted) {
        worker.reject(new Error("The parent turn was aborted."));
        continue;
      }
      activeWorkers++;
      void Promise.resolve()
        .then(worker.run)
        .then(worker.resolve, worker.reject)
        .finally(() => {
          activeWorkers--;
          pump();
        });
    }
  };
  const schedule = (run: () => Promise<DelegatedBriefResult>) =>
    new Promise<DelegatedBriefResult>((resolve, reject) => {
      waiting.push({ run, resolve, reject });
      pump();
    });
  return {
    name: "delegate_parallel_work",
    executionLane: "delegation",
    description:
      "Delegate independent, self-contained briefs with your Grants. Include inputs and requiredTools; workers cannot see this conversation. Partition shared file writes. Max 8/call, 12/turn, 4 concurrent across calls. Long work returns pending result IDs; do independent work or use get_parallel_work_result (waitMs:30000), without redispatch. Verify needed results before acting or ending this turn, which stops unfinished workers. Results persist for this Run lineage/conversation; identical completed briefs are reused. Required tools are checked first.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_DELEGATIONS_PER_CALL,
          description:
            "Independent, self-contained briefs. Include every input and constraint the worker needs; it does not receive the parent conversation.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                minLength: 1,
                maxLength: MAX_LABEL_LENGTH,
                description: "Short name used to identify this result.",
              },
              instruction: {
                type: "string",
                minLength: 1,
                maxLength: MAX_INSTRUCTION_LENGTH,
                description: "Complete brief with scope, inputs, constraints, and expected output.",
              },
              requiredTools: {
                type: "array",
                maxItems: 40,
                items: { type: "string", maxLength: 128 },
                description:
                  "Exact tool names this brief requires; missing tools fail before any worker starts.",
              },
            },
            required: ["label", "instruction"],
            additionalProperties: false,
          },
        },
        maxConcurrency: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PARALLEL_DELEGATIONS,
          description: "How many briefs may run simultaneously (default 4, capped at 4).",
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
    run: (input) =>
      track(
        (async () => {
          const parsed = parseInput(input);
          if ("error" in parsed) return { content: parsed.error, isError: true };
          if (signal.aborted) {
            return { content: "Parallel delegation was aborted before it started.", isError: true };
          }
          const preflightError = await params.preflight?.(parsed.tasks);
          if (preflightError) return { content: preflightError, isError: true };
          if (parsed.tasks.length > params.budget.remaining) {
            return {
              content:
                `This turn can delegate ${params.budget.remaining} more brief` +
                `${params.budget.remaining === 1 ? "" : "s"}; this call requested ${parsed.tasks.length}. ` +
                "Reduce the batch or finish the remaining work yourself.",
              isError: true,
            };
          }

          // Reserve the whole batch before starting it. A failed child still costs
          // a model call and must not give the parent an infinite retry budget.
          params.budget.remaining -= parsed.tasks.length;
          const resultIds: Array<string | null> = [];
          for (const task of parsed.tasks)
            resultIds.push(await resultStore.reserve(task.label, task));
          // Claim every newly owned reservation before starting the pool. If the
          // parent stops, even briefs that never acquired a slot must become
          // failed, while reused pending/completed records stay untouched.
          const reused: Array<DelegatedBriefResult | null> = [];
          for (const resultId of resultIds)
            reused.push(resultId ? ((await resultStore.reuse?.(resultId)) ?? null) : null);
          const shouldStore = reused.map((result) => result === null);
          pendingGroups++;
          params.onBackgroundWork?.(pendingGroups);
          const completion = track(
            runBounded(
              parsed.tasks,
              parsed.maxConcurrency,
              async (brief, index) => {
                const resultId = resultIds[index];
                return (
                  reused[index] ??
                  schedule(() => params.runBrief(brief, resultId ?? undefined, signal))
                );
              },
              signal,
              async (result, index) => {
                const resultId = resultIds[index];
                if (resultId && shouldStore[index]) await resultStore.finish(resultId, result);
              },
            ).finally(() => {
              pendingGroups--;
              params.onBackgroundWork?.(pendingGroups);
            }),
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          const results = await Promise.race([
            completion,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), PARALLEL_DELEGATION_WAIT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (results === null) {
            const metadata = await Promise.all(
              resultIds.map(async (id, index) => {
                const row = id ? await resultStore.read(id, 0, 0) : null;
                if (!row)
                  return { resultId: id, label: parsed.tasks[index].label, available: false };
                const { text: _text, coverage: _coverage, ...result } = row;
                return result;
              }),
            );
            return {
              content: [
                "Parallel delegation exceeded the initial wait. Check each result's current status below; pending means unfinished, not a tool outage.",
                "Continue independent work, then use get_parallel_work_result with these result IDs to check status and read completed evidence. If you are waiting for a result, pass waitMs up to 30000 instead of rapidly polling. Do not repeat these briefs. Ending the parent turn stops unfinished workers; its original deadline still applies.",
                JSON.stringify({
                  scope: resultStore.scopeDescription ?? "Current parent turn only.",
                  results: metadata,
                }),
              ].join("\n\n"),
            };
          }
          const failed = results.filter((result) => result.status === "failed").length;
          return {
            content: await formatResults(
              parsed.tasks,
              results,
              parsed.maxConcurrency,
              resultIds,
              resultStore,
            ),
            ...(failed === results.length ? { isError: true } : {}),
          };
        })(),
      ),
    async close() {
      lifetime.abort();
      pump();
      while (active.size > 0) await Promise.allSettled([...active]);
    },
  };
}

function parseInput(
  input: Record<string, unknown>,
): { tasks: DelegatedBrief[]; maxConcurrency: number } | { error: string } {
  if (!Array.isArray(input.tasks)) {
    return { error: "`tasks` must be an array of self-contained briefs." };
  }
  if (input.tasks.length < 1 || input.tasks.length > MAX_DELEGATIONS_PER_CALL) {
    return {
      error: `Pass between 1 and ${MAX_DELEGATIONS_PER_CALL} delegated briefs per call.`,
    };
  }

  const tasks: DelegatedBrief[] = [];
  for (let i = 0; i < input.tasks.length; i++) {
    const value = input.tasks[i];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: `tasks[${i}] must be an object with label and instruction.` };
    }
    const { label, instruction, requiredTools } = value as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL_LENGTH) {
      return {
        error: `tasks[${i}].label must be 1–${MAX_LABEL_LENGTH} characters.`,
      };
    }
    if (
      typeof instruction !== "string" ||
      !instruction.trim() ||
      instruction.length > MAX_INSTRUCTION_LENGTH
    ) {
      return {
        error: `tasks[${i}].instruction must be 1–${MAX_INSTRUCTION_LENGTH} characters.`,
      };
    }
    if (
      requiredTools !== undefined &&
      (!Array.isArray(requiredTools) ||
        requiredTools.length > 40 ||
        requiredTools.some((name) => typeof name !== "string" || !name.trim() || name.length > 128))
    ) {
      return { error: `tasks[${i}].requiredTools must contain at most 40 exact tool names.` };
    }
    tasks.push({
      label: label.trim(),
      instruction: instruction.trim(),
      ...(Array.isArray(requiredTools)
        ? { requiredTools: [...new Set(requiredTools.map((name: string) => name.trim()))] }
        : {}),
    });
  }

  const requested = input.maxConcurrency ?? MAX_PARALLEL_DELEGATIONS;
  if (
    typeof requested !== "number" ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > MAX_PARALLEL_DELEGATIONS
  ) {
    return {
      error: `maxConcurrency must be an integer from 1 to ${MAX_PARALLEL_DELEGATIONS}.`,
    };
  }
  return { tasks, maxConcurrency: Math.min(requested, tasks.length) };
}

async function runBounded(
  tasks: DelegatedBrief[],
  maxConcurrency: number,
  runBrief: (brief: DelegatedBrief, index: number) => Promise<DelegatedBriefResult>,
  signal?: AbortSignal,
  onResult?: (result: DelegatedBriefResult, index: number) => Promise<void>,
): Promise<DelegatedBriefResult[]> {
  const results = new Array<DelegatedBriefResult>(tasks.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      if (signal?.aborted) {
        results[index] = { status: "failed", error: "Aborted before this brief started." };
        await onResult?.(results[index], index);
        continue;
      }
      try {
        results[index] = await runBrief(tasks[index], index);
      } catch (err) {
        results[index] = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      await onResult?.(results[index], index);
      // The bounded recovery store owns the retained text. Keep only a preview
      // in the batch while slower workers finish, rather than retaining every
      // original worker response until the whole batch has completed.
      const result = results[index];
      results[index] =
        result.status === "completed"
          ? { status: "completed", output: clip(result.output, MAX_RESULT_LENGTH) }
          : { status: "failed", error: clip(result.error, MAX_RESULT_LENGTH) };
    }
  };

  // A persistence failure in one worker must not release the parent's cleanup
  // barrier while sibling workers still have live tools and credentials.
  const settled = await Promise.allSettled(Array.from({ length: maxConcurrency }, () => worker()));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

async function formatResults(
  tasks: DelegatedBrief[],
  results: DelegatedBriefResult[],
  maxConcurrency: number,
  resultIds: Array<string | null>,
  resultStore: ParallelResultStore,
): Promise<string> {
  const completed = results.filter((result) => result.status === "completed").length;
  const sections = results.map((result, index) => {
    const heading = `## ${index + 1}. ${tasks[index].label} — ${result.status}`;
    const body = result.status === "completed" ? result.output : result.error;
    return `${heading}\n${body || "(no output)"}`;
  });
  return [
    `Parallel delegation finished: ${completed}/${results.length} briefs completed (concurrency ${maxConcurrency}).`,
    "Verify and synthesize these worker results before answering or taking follow-up action.",
    `Recovery: call get_parallel_work_result with resultId (or omit it to list results). ${resultStore.scopeDescription ?? "Current parent turn only."}`,
    JSON.stringify({
      results: await Promise.all(
        resultIds.map(async (id, index) => {
          if (!id)
            return {
              label: tasks[index].label,
              resultId: null,
              stored: false,
              reason: "Result count limit reached",
            };
          const row = await resultStore.read(id, 0, 0);
          if (!row) return { resultId: id, stored: true, available: false };
          const { text: _text, coverage: _coverage, ...metadata } = row;
          return metadata;
        }),
      ),
    }),
    ...sections,
  ].join("\n\n");
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return (
    Buffer.from(value.slice(0, max), "utf16le").toString("utf16le") +
    `\n[truncated after ${max} characters]`
  );
}
