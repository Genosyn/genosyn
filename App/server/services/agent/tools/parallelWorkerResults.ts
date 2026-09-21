import { randomUUID } from "node:crypto";
import type { AgentTool } from "../types.js";
import type { DelegatedBriefResult } from "./parallelDelegation.js";

export const MAX_STORED_WORKER_RESULTS = 12;
export const MAX_STORED_WORKER_CHARS = 1_000_000;
export const MAX_SINGLE_WORKER_CHARS = 256_000;
const MAX_READ_CHARS = 8_000;

type StoredResult = {
  resultId: string;
  label: string;
  status: "pending" | "completed" | "failed";
  text: string;
  totalChars: number;
};

function metadata(result: StoredResult) {
  return {
    resultId: result.resultId,
    label: result.label,
    status: result.status,
    totalChars: result.totalChars,
    retainedChars: result.text.length,
    storageTruncated: result.text.length < result.totalChars,
  };
}

/** A closure owned by one parent turn, never a global employee/session cache. */
export function createParallelResultStore() {
  const results = new Map<string, StoredResult>();
  let retainedChars = 0;
  return {
    reserve(label: string): string | null {
      if (results.size >= MAX_STORED_WORKER_RESULTS) return null;
      const resultId = randomUUID();
      results.set(resultId, {
        resultId,
        label: label.slice(0, 80),
        status: "pending",
        text: "",
        totalChars: 0,
      });
      return resultId;
    },
    finish(resultId: string, result: DelegatedBriefResult): void {
      const entry = results.get(resultId);
      if (!entry || entry.status !== "pending") return;
      const text = result.status === "completed" ? result.output : result.error;
      entry.status = result.status;
      entry.totalChars = text.length;
      // Bound both the individual result and the whole turn. UTF-16 storage is
      // at most twice this character budget; no output files or global cache.
      const end = Math.min(MAX_SINGLE_WORKER_CHARS, MAX_STORED_WORKER_CHARS - retainedChars);
      // Copy the prefix: a sliced V8 string can otherwise retain the backing
      // storage for a much larger discarded worker output.
      entry.text = Buffer.from(text.slice(0, end), "utf16le").toString("utf16le");
      retainedChars += entry.text.length;
    },
    list() {
      return [...results.values()].map(metadata);
    },
    read(resultId: string, offset: number, maxChars: number) {
      const entry = results.get(resultId);
      if (!entry) return null;
      const text = entry.text.slice(offset, offset + maxChars);
      const end = Math.min(entry.text.length, offset + text.length);
      return {
        ...metadata(entry),
        coverage: {
          offset,
          returnedChars: text.length,
          totalChars: entry.totalChars,
          retainedChars: entry.text.length,
          truncated: offset > 0 || end < entry.totalChars,
          nextOffset: end < entry.text.length ? end : null,
          complete: entry.status !== "pending" && offset === 0 && end === entry.totalChars,
        },
        text,
      };
    },
  };
}

export type ParallelResultStore = ReturnType<typeof createParallelResultStore>;

export function createParallelWorkResultTool(store: ParallelResultStore): AgentTool {
  return {
    name: "get_parallel_work_result",
    readOnly: true,
    description:
      "Recover temporary worker results from this parent turn without rerunning the work. Omit resultId to list result IDs, labels and status; provide one to read a bounded page. Follow nextOffset until null. Reports text that could not be retained because of storage limits. Results expire when the parent turn ends and cannot be read from another conversation, Run, or worker.",
    inputSchema: {
      type: "object",
      properties: {
        resultId: { type: "string" },
        offset: { type: "integer", minimum: 0, maximum: MAX_SINGLE_WORKER_CHARS },
        maxChars: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const offset = input.offset ?? 0;
      const maxChars = input.maxChars ?? 4_000;
      if (
        Object.keys(input).some((key) => !["resultId", "offset", "maxChars"].includes(key)) ||
        (input.resultId !== undefined && typeof input.resultId !== "string") ||
        typeof offset !== "number" ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > MAX_SINGLE_WORKER_CHARS ||
        typeof maxChars !== "number" ||
        !Number.isInteger(maxChars) ||
        maxChars < 1 ||
        maxChars > MAX_READ_CHARS
      ) {
        return {
          content: "Invalid resultId, offset or maxChars for worker result recovery.",
          isError: true,
        };
      }
      const scope = "current parent turn only; expires when this turn ends";
      if (input.resultId === undefined) {
        return {
          content: JSON.stringify({
            scope,
            results: store.list(),
            limits: {
              results: MAX_STORED_WORKER_RESULTS,
              retainedChars: MAX_STORED_WORKER_CHARS,
              charsPerResult: MAX_SINGLE_WORKER_CHARS,
            },
          }),
        };
      }
      const result = store.read(input.resultId as string, offset, maxChars);
      if (!result) {
        return {
          content: JSON.stringify({
            error:
              "Result is not available in this parent turn. It may belong to another turn or have expired.",
            scope,
          }),
          isError: true,
        };
      }
      return { content: JSON.stringify({ scope, ...result }) };
    },
  };
}
