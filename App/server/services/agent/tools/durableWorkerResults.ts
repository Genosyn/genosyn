import { randomUUID } from "node:crypto";
import { AppDataSource } from "../../../db/datasource.js";
import { ParallelWorkerResult } from "../../../db/entities/ParallelWorkerResult.js";
import { Run } from "../../../db/entities/Run.js";
import {
  captureRecoveryGrants,
  hash,
  recoveryGrantsCover,
  resolveRecoveryScope,
  type RecoveryScope,
} from "../workRecoveryScope.js";
import {
  MAX_SINGLE_WORKER_CHARS,
  MAX_STORED_WORKER_CHARS,
  MAX_STORED_WORKER_RESULTS,
  workerResultMetadata,
  type ParallelResultStore,
} from "./parallelWorkerResults.js";

/** A durable record is saved as each worker settles, not when its parent succeeds. */
export function createDurableParallelResultStore(
  token: string,
  scope: RecoveryScope,
): ParallelResultStore {
  const parentTurnId = randomUUID();
  const owned = new Set<string>();
  const claimed = new Set<string>();
  const where = {
    companyId: scope.companyId,
    employeeId: scope.employeeId,
    scopeKey: scope.scopeKey,
    authority: scope.authority,
    requesterUserId: scope.requesterUserId,
  };
  const repo = () => AppDataSource.getRepository(ParallelWorkerResult);
  let writes = Promise.resolve();
  const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = writes.then(operation);
    writes = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  async function currentGrants() {
    const current = await resolveRecoveryScope(token);
    if (
      !current ||
      current.scopeKey !== scope.scopeKey ||
      current.authority !== scope.authority ||
      current.requesterUserId !== scope.requesterUserId ||
      current.employeeId !== scope.employeeId ||
      current.companyId !== scope.companyId
    )
      return null;
    return captureRecoveryGrants(scope.companyId, scope.employeeId);
  }
  const shape = (row: ParallelWorkerResult) => ({
    resultId: row.id,
    label: row.label,
    status: row.status,
    text: row.output,
    totalChars: row.totalChars,
  });
  async function authorizedRow(id: string) {
    const grants = await currentGrants();
    if (!grants) return null;
    const row = await repo().findOneBy({ ...where, id });
    return row && recoveryGrantsCover(row.grantsJson, grants) ? row : null;
  }
  async function listPage(offset: number) {
    const grants = await currentGrants();
    const [rows, total] = grants
      ? await repo().findAndCount({
          where,
          order: { createdAt: "DESC", id: "DESC" },
          skip: offset,
          take: 12,
        })
      : ([[], 0] as const);
    const results = rows
      .filter((row) => grants && recoveryGrantsCover(row.grantsJson, grants))
      .map((row) => workerResultMetadata(shape(row)));
    const hasMore = offset + rows.length < total;
    return {
      results,
      coverage: {
        offset,
        limit: 12,
        scanned: rows.length,
        returned: results.length,
        total,
        hasMore,
        nextOffset: hasMore ? offset + rows.length : null,
      },
    };
  }
  return {
    scopeDescription:
      "durable; same Run occurrence and its retries/continuations, or exact conversation and requesting authority; current Grants required",
    reserve: (label, brief) =>
      serial(async () => {
        const grants = await currentGrants();
        if (!grants) throw new Error("Worker persistence requires current recovery authority.");
        const briefHash = hash(
          JSON.stringify([label, brief?.instruction ?? "", brief?.requiredTools ?? []]),
        );
        const existing = await repo().findOneBy({ ...where, briefHash });
        if (existing) {
          if (!recoveryGrantsCover(existing.grantsJson, grants))
            throw new Error("The earlier worker's Grants changed; recovery is unavailable.");
          return existing.id;
        }
        if (owned.size >= MAX_STORED_WORKER_RESULTS) return null;
        const row = repo().create({
          ...where,
          parentRunId: scope.runId,
          parentTurnId,
          briefHash,
          label: label.slice(0, 80),
          grantsJson: JSON.stringify(grants),
          requiredToolsJson: JSON.stringify(brief?.requiredTools ?? []),
        });
        try {
          await repo().save(row);
        } catch (error) {
          // A concurrent retry claiming the same brief must reuse the winner.
          const winner = await repo().findOneBy({ ...where, briefHash });
          if (winner && recoveryGrantsCover(winner.grantsJson, grants)) return winner.id;
          throw error;
        }
        owned.add(row.id);
        return row.id;
      }),
    finish: (resultId, result) =>
      serial(async () => {
        if (!owned.has(resultId)) return;
        const rows = await repo().findBy({ ...where, parentTurnId });
        const retained = rows.reduce((sum, row) => sum + row.output.length, 0);
        const text = result.status === "completed" ? result.output : result.error;
        const output = text.slice(
          0,
          Math.max(0, Math.min(MAX_SINGLE_WORKER_CHARS, MAX_STORED_WORKER_CHARS - retained)),
        );
        const current = rows.find((row) => row.id === resultId);
        const grants = new Set<string>(JSON.parse(current?.grantsJson ?? "[]"));
        for (const grant of await captureRecoveryGrants(scope.companyId, scope.employeeId))
          grants.add(grant);
        // Do not depend on the parent's now-revoked MCP token when saving its
        // worker's final evidence. The server-owned reservation is the writer.
        await repo().update(
          { ...where, id: resultId, parentTurnId, status: "pending" },
          {
            status: result.status,
            output,
            totalChars: text.length,
            grantsJson: JSON.stringify([...grants].sort()),
          },
        );
      }),
    captureGrants: (resultId, observed) =>
      serial(async () => {
        if (!owned.has(resultId)) return;
        const row = await repo().findOneBy({
          ...where,
          id: resultId,
          parentTurnId,
          status: "pending",
        });
        if (!row) return;
        const grants = [...new Set<string>([...JSON.parse(row.grantsJson), ...observed])].sort();
        await repo().update(
          { id: row.id, parentTurnId, status: "pending" },
          { grantsJson: JSON.stringify(grants) },
        );
      }),
    list: async () => (await listPage(0)).results,
    listPage,
    read: async (resultId, offset, maxChars) => {
      const row = await authorizedRow(resultId);
      if (!row) return null;
      const text = row.output.slice(offset, offset + maxChars);
      const end = Math.min(row.output.length, offset + text.length);
      return {
        ...workerResultMetadata(shape(row)),
        coverage: {
          offset,
          returnedChars: text.length,
          totalChars: row.totalChars,
          retainedChars: row.output.length,
          truncated: offset > 0 || end < row.totalChars,
          nextOffset: end < row.output.length ? end : null,
          complete: row.status !== "pending" && offset === 0 && end === row.totalChars,
        },
        text,
      };
    },
    reuse: async (resultId) => {
      const row = await authorizedRow(resultId);
      if (!row)
        return {
          status: "failed",
          error: "Earlier worker evidence is unavailable under current Grants.",
        };
      if (owned.has(resultId) && !claimed.has(resultId) && row.status === "pending") {
        claimed.add(resultId);
        return null;
      }
      if (row.status === "completed")
        return {
          status: "completed",
          output:
            row.output +
            (row.output.length < row.totalChars
              ? "\n[Stored output was truncated; inspect recovery coverage.]"
              : ""),
        };
      if (row.status === "failed") return { status: "failed", error: row.output };
      const parent = row.parentRunId
        ? await AppDataSource.getRepository(Run).findOneBy({ id: row.parentRunId })
        : null;
      return {
        status: "failed",
        error:
          parent?.status === "running"
            ? "This exact brief is already running. Recover its result instead of starting duplicate work."
            : "The earlier worker has no completed result. Verify its Effects before retrying with a revised brief.",
      };
    },
  };
}
