import { randomUUID } from "node:crypto";
import type { AgentTool } from "../types.js";
import type { DelegatedBrief, DelegatedBriefResult } from "./parallelDelegation.js";

export const MAX_STORED_WORKER_RESULTS = 12;
export const MAX_STORED_WORKER_CHARS = 1_000_000;
export const MAX_SINGLE_WORKER_CHARS = 256_000;
const MAX_READ_CHARS = 8_000;
const RESULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredResult = {
  resultId: string;
  label: string;
  status: "pending" | "completed" | "failed";
  text: string;
  totalChars: number;
};

export function workerResultMetadata(result: StoredResult) {
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
      return [...results.values()].map(workerResultMetadata);
    },
    read(resultId: string, offset: number, maxChars: number) {
      const entry = results.get(resultId);
      if (!entry) return null;
      const text = entry.text.slice(offset, offset + maxChars);
      const end = Math.min(entry.text.length, offset + text.length);
      return {
        ...workerResultMetadata(entry),
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

type MemoryStore = ReturnType<typeof createParallelResultStore>;
type MaybePromise<T> = T | Promise<T>;
export type ParallelResultStore = {
  scopeDescription?: string;
  reserve(label: string, brief?: DelegatedBrief): MaybePromise<string | null>;
  finish(resultId: string, result: DelegatedBriefResult): MaybePromise<void>;
  list(): MaybePromise<ReturnType<MemoryStore["list"]>>;
  read(
    resultId: string,
    offset: number,
    maxChars: number,
  ): MaybePromise<ReturnType<MemoryStore["read"]>>;
  reuse?(resultId: string): Promise<DelegatedBriefResult | null>;
  captureGrants?(resultId: string, grants: string[]): Promise<void>;
  listPage?(offset: number): Promise<{
    results: ReturnType<MemoryStore["list"]>;
    coverage: {
      offset: number;
      limit: number;
      scanned: number;
      returned: number;
      total: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
  }>;
};

export function createParallelWorkResultTool(store: ParallelResultStore): AgentTool {
  return {
    name: "get_parallel_work_result",
    readOnly: true,
    description:
      "Recover worker results without rerunning work. Omit resultId to list IDs, labels and status; provide one to read a bounded page. Follow nextOffset until null. Saved results survive the parent timeout and are available only in the same Run retry/continuation lineage or exact conversation and authority. Current Grants are rechecked. Scope and storage limits are explicit.",
    inputSchema: {
      type: "object",
      properties: {
        resultId: { type: "string" },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: MAX_SINGLE_WORKER_CHARS,
          description:
            "Character offset when reading a result; listing offset when resultId is omitted.",
        },
        maxChars: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const offset = input.offset ?? 0;
      const maxChars = input.maxChars ?? 4_000;
      if (
        Object.keys(input).some((key) => !["resultId", "offset", "maxChars"].includes(key)) ||
        (input.resultId !== undefined &&
          (typeof input.resultId !== "string" || !RESULT_ID.test(input.resultId))) ||
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
      const scope =
        store.scopeDescription ??
        "current parent turn only; no persistent Run or conversation scope";
      if (input.resultId === undefined) {
        const page = await store.listPage?.(offset);
        return {
          content: JSON.stringify({
            scope,
            ...(page ? { coverage: page.coverage } : {}),
            limits: {
              resultsPerParentTurn: MAX_STORED_WORKER_RESULTS,
              retainedCharsPerParentTurn: MAX_STORED_WORKER_CHARS,
              charsPerResult: MAX_SINGLE_WORKER_CHARS,
            },
            results: page?.results ?? (await store.list()),
          }),
        };
      }
      const result = await store.read(input.resultId as string, offset, maxChars);
      if (!result) {
        return {
          content: JSON.stringify({
            error:
              "Result is unavailable in this recovery scope, or its original Grants are no longer available.",
            scope,
          }),
          isError: true,
        };
      }
      return { content: JSON.stringify({ scope, ...result }) };
    },
  };
}
