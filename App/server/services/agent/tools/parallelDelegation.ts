import type { AgentTool } from "../types.js";

/** Hard limits keep one model turn from multiplying into unbounded API spend. */
export const MAX_PARALLEL_DELEGATIONS = 4;
export const MAX_DELEGATIONS_PER_CALL = 8;
export const MAX_DELEGATIONS_PER_TURN = 12;

const MAX_LABEL_LENGTH = 80;
const MAX_INSTRUCTION_LENGTH = 20_000;
const MAX_RESULT_LENGTH = 12_000;

export type DelegationBudget = { remaining: number };

export type DelegatedBrief = {
  label: string;
  instruction: string;
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
  signal?: AbortSignal;
  runBrief: (brief: DelegatedBrief) => Promise<DelegatedBriefResult>;
}): AgentTool {
  return {
    name: "delegate_parallel_work",
    description:
      "Delegate independent parts of the current objective to temporary parallel workers that are copies of you. Each worker gets your Soul, Skills, AI Model, Grants, secrets, working directory, and a self-contained brief, then its result is returned here for you to verify and synthesize. Use this for independent research, analysis, or API calls. For file-writing work, partition files explicitly: workers share one working directory, so overlapping edits or git operations can conflict. This is immediate bounded work, not a Handoff to another AI Employee. You can delegate at most 8 briefs per call, 12 in the whole turn, with up to 4 running at once; workers cannot delegate again.",
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
                description:
                  "Complete brief with scope, inputs, constraints, and expected output.",
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
    run: async (input) => {
      const parsed = parseInput(input);
      if ("error" in parsed) return { content: parsed.error, isError: true };
      if (params.signal?.aborted) {
        return { content: "Parallel delegation was aborted before it started.", isError: true };
      }
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
      const results = await runBounded(
        parsed.tasks,
        parsed.maxConcurrency,
        params.runBrief,
        params.signal,
      );
      const failed = results.filter((result) => result.status === "failed").length;
      return {
        content: formatResults(parsed.tasks, results, parsed.maxConcurrency),
        ...(failed === results.length ? { isError: true } : {}),
      };
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
    const { label, instruction } = value as Record<string, unknown>;
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
    tasks.push({ label: label.trim(), instruction: instruction.trim() });
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
  runBrief: (brief: DelegatedBrief) => Promise<DelegatedBriefResult>,
  signal?: AbortSignal,
): Promise<DelegatedBriefResult[]> {
  const results = new Array<DelegatedBriefResult>(tasks.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      if (signal?.aborted) {
        results[index] = { status: "failed", error: "Aborted before this brief started." };
        continue;
      }
      try {
        results[index] = await runBrief(tasks[index]);
      } catch (err) {
        results[index] = {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  return results;
}

function formatResults(
  tasks: DelegatedBrief[],
  results: DelegatedBriefResult[],
  maxConcurrency: number,
): string {
  const completed = results.filter((result) => result.status === "completed").length;
  const sections = results.map((result, index) => {
    const heading = `## ${index + 1}. ${tasks[index].label} — ${result.status}`;
    const body = result.status === "completed" ? result.output : result.error;
    return `${heading}\n${clip(body || "(no output)", MAX_RESULT_LENGTH)}`;
  });
  return [
    `Parallel delegation finished: ${completed}/${results.length} briefs completed (concurrency ${maxConcurrency}).`,
    "Verify and synthesize these worker results before answering or taking follow-up action.",
    ...sections,
  ].join("\n\n");
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + `\n[truncated after ${max} characters]`;
}
