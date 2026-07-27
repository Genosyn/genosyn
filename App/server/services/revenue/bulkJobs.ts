import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { RevenueOperation } from "../../db/entities/RevenueOperation.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import {
  BulkAtomicValidationError,
  runRevenueBulkOperation,
  type BulkExecutionProgress,
  type BulkRequest,
  type BulkResult,
  type BulkTarget,
} from "./bulk.js";
import {
  createRevenueOperation,
  getRevenueOperation,
  rollbackRevenueOperation,
  type RevenueOperationActor,
} from "./operations.js";

type BulkJobPayload = {
  type: "bulk_job";
  clientRequest: BulkRequest;
  executionRequest: BulkRequest;
  actor: RevenueOperationActor;
};

export type RevenueBulkJob = {
  operation: RevenueOperation;
  summary: Record<string, unknown>;
  rows: Array<Record<string, unknown>>;
  rowTotal: number;
};

const activeJobs = new Set<string>();
const activeJobProgress = new Map<string, { token: symbol; progress: BulkExecutionProgress }>();
const BULK_JOB_LEASE_TTL_MS = 60_000;
const BULK_JOB_LEASE_RETRY_MS = 5_000;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function reviveRequest(request: BulkRequest): BulkRequest {
  const filter = request.target.filter;
  const action = request.action;
  return {
    ...request,
    target: {
      ...request.target,
      filter: filter
        ? {
            ...filter,
            dueFrom: filter.dueFrom ? new Date(String(filter.dueFrom)) : undefined,
            dueTo: filter.dueTo ? new Date(String(filter.dueTo)) : undefined,
            reminderFrom: filter.reminderFrom ? new Date(String(filter.reminderFrom)) : undefined,
            reminderTo: filter.reminderTo ? new Date(String(filter.reminderTo)) : undefined,
            staleBefore: filter.staleBefore ? new Date(String(filter.staleBefore)) : undefined,
            createdBefore: filter.createdBefore
              ? new Date(String(filter.createdBefore))
              : undefined,
          }
        : undefined,
    },
    action:
      action.type === "update_follow_up"
        ? {
            ...action,
            dueAt:
              action.dueAt === null
                ? null
                : action.dueAt
                  ? new Date(String(action.dueAt))
                  : undefined,
            reminderAt:
              action.reminderAt === null
                ? null
                : action.reminderAt
                  ? new Date(String(action.reminderAt))
                  : undefined,
          }
        : action,
  };
}

function frozenTarget(request: BulkRequest, preview: BulkResult): BulkTarget {
  if (request.resourceType === "follow_up") {
    return {
      followUpIds: preview.rows
        .filter((row): row is typeof row & { source: "task" | "deal" | "partnership" } =>
          Boolean(row.source),
        )
        .map((row) => ({ source: row.source, id: row.resourceId })),
    };
  }
  return { ids: preview.rows.map((row) => row.resourceId) };
}

function jobSummary(
  state: "queued" | "running" | "completed" | "partial" | "failed" | "rolled_back",
  preview: BulkResult,
  extra: Record<string, unknown> = {},
  executionProgress?: BulkExecutionProgress,
): Record<string, unknown> {
  return {
    state,
    progress: {
      total: executionProgress?.total ?? preview.matched,
      processed:
        executionProgress?.processed ??
        (state === "queued" || state === "running" ? 0 : preview.matched),
      valid: preview.valid,
      failedValidation: preview.failed,
      ...(executionProgress
        ? {
            applied: executionProgress.applied,
            skipped: executionProgress.skipped,
            failed: executionProgress.failed,
          }
        : {}),
    },
    preview,
    ...extra,
  };
}

function enqueue(operationId: string): void {
  if (activeJobs.has(operationId)) return;
  const handle = setImmediate(() => {
    void executeRevenueBulkJob(operationId);
  });
  handle.unref();
}

function enqueueAfterLeaseContention(operationId: string): void {
  const handle = setTimeout(() => {
    enqueue(operationId);
  }, BULK_JOB_LEASE_RETRY_MS);
  handle.unref();
}

export async function createRevenueBulkJob(
  companyId: string,
  request: BulkRequest,
  actor: RevenueOperationActor = {},
): Promise<{ job: RevenueOperation; preview: BulkResult; replayed: boolean }> {
  if (!request.idempotencyKey) throw new Error("An idempotency key is required");
  const existing = await AppDataSource.getRepository(RevenueOperation).findOneBy({
    companyId,
    idempotencyKey: request.idempotencyKey,
  });
  if (existing) {
    const payload = parseJson<BulkJobPayload | null>(existing.requestJson, null);
    if (!payload || payload.type !== "bulk_job") {
      throw new Error("That idempotency key was already used for another Revenue operation");
    }
    if (JSON.stringify(payload.clientRequest) !== JSON.stringify(request)) {
      throw new Error("That idempotency key was already used for a different bulk job");
    }
    const summary = parseJson<{ preview?: BulkResult }>(existing.summaryJson, {});
    return {
      job: existing,
      preview:
        summary.preview ??
        ({
          dryRun: true,
          matched: 0,
          valid: 0,
          applied: 0,
          skipped: 0,
          failed: 0,
          rows: [],
        } satisfies BulkResult),
      replayed: true,
    };
  }

  const preview = await runRevenueBulkOperation(
    companyId,
    { ...request, dryRun: true, idempotencyKey: undefined },
    actor,
  );
  const executionRequest: BulkRequest = {
    ...request,
    target: frozenTarget(request, preview),
    dryRun: false,
    idempotencyKey: `bulk-job-execution:${request.idempotencyKey}`,
  };
  const payload: BulkJobPayload = {
    type: "bulk_job",
    clientRequest: request,
    executionRequest,
    actor,
  };
  const job = await AppDataSource.transaction((manager) =>
    createRevenueOperation(manager, {
      companyId,
      kind: "bulk",
      resourceType: request.resourceType,
      status: "queued",
      idempotencyKey: request.idempotencyKey,
      request: payload,
      summary: jobSummary("queued", preview),
      actor,
      rows: [],
    }),
  );
  enqueue(job.id);
  return { job, preview, replayed: false };
}

async function executeRevenueBulkJobWithLease(
  operationId: string,
  onProgress?: (progress: BulkExecutionProgress) => void | Promise<void>,
): Promise<void> {
  const repo = AppDataSource.getRepository(RevenueOperation);
  const job = await repo.findOneBy({ id: operationId, kind: "bulk" });
  if (!job || ["completed", "partial", "failed", "rolled_back"].includes(job.status)) return;
  const payload = parseJson<BulkJobPayload | null>(job.requestJson, null);
  if (!payload || payload.type !== "bulk_job") return;
  const priorSummary = parseJson<{ preview?: BulkResult }>(job.summaryJson, {});
  const preview = priorSummary.preview;
  if (!preview) throw new Error("Bulk job preview is unavailable");
  const progressToken = Symbol(operationId);
  activeJobProgress.set(operationId, {
    token: progressToken,
    progress: {
      total: preview.matched,
      processed: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
    },
  });
  try {
    job.status = "running";
    job.summaryJson = JSON.stringify(jobSummary("running", preview));
    await repo.save(job);
    const result = await runRevenueBulkOperation(
      job.companyId,
      reviveRequest(payload.executionRequest),
      payload.actor,
      async (progress) => {
        const active = activeJobProgress.get(operationId);
        if (active?.token === progressToken) active.progress = progress;
        await onProgress?.(progress);
      },
    );
    job.status = result.failed > 0 ? "partial" : "completed";
    job.completedAt = new Date();
    job.summaryJson = JSON.stringify(
      jobSummary(
        job.status,
        preview,
        {
          executionOperationId: result.operationId ?? null,
          result,
        },
        {
          total: result.matched,
          processed: result.matched,
          applied: result.applied,
          skipped: result.skipped,
          failed: result.failed,
        },
      ),
    );
    await repo.save(job);
  } catch (error) {
    job.status = "failed";
    job.completedAt = new Date();
    const failedResult = error instanceof BulkAtomicValidationError ? error.result : undefined;
    const observedProgress = activeJobProgress.get(operationId)?.progress;
    job.summaryJson = JSON.stringify(
      jobSummary(
        "failed",
        preview,
        {
          error: (error as Error).message,
          result: failedResult,
        },
        failedResult
          ? {
              total: failedResult.matched,
              processed: failedResult.matched,
              applied: failedResult.applied,
              skipped: failedResult.skipped,
              failed: failedResult.failed,
            }
          : observedProgress,
      ),
    );
    await repo.save(job);
  } finally {
    if (activeJobProgress.get(operationId)?.token === progressToken) {
      activeJobProgress.delete(operationId);
    }
  }
}

export async function executeRevenueBulkJob(
  operationId: string,
  onProgress?: (progress: BulkExecutionProgress) => void | Promise<void>,
): Promise<void> {
  if (activeJobs.has(operationId)) return;
  activeJobs.add(operationId);
  let leaseContended = false;
  try {
    const result = await withSchedulerLease(
      `revenue-bulk-job:${operationId}`,
      BULK_JOB_LEASE_TTL_MS,
      () => executeRevenueBulkJobWithLease(operationId, onProgress),
    );
    leaseContended = result === null;
  } finally {
    activeJobs.delete(operationId);
  }
  if (leaseContended) enqueueAfterLeaseContention(operationId);
}

export async function getRevenueBulkJob(
  companyId: string,
  id: string,
  opts: { rowLimit?: number; rowOffset?: number } = {},
): Promise<RevenueBulkJob | null> {
  const operation = await AppDataSource.getRepository(RevenueOperation).findOneBy({
    companyId,
    id,
    kind: "bulk",
  });
  if (!operation) return null;
  const payload = parseJson<BulkJobPayload | null>(operation.requestJson, null);
  if (!payload || payload.type !== "bulk_job") return null;
  const persistedSummary = parseJson<Record<string, unknown>>(operation.summaryJson, {});
  const liveProgress =
    operation.status === "running" ? activeJobProgress.get(operation.id)?.progress : undefined;
  const summary = liveProgress
    ? {
        ...persistedSummary,
        progress: {
          ...(typeof persistedSummary.progress === "object" && persistedSummary.progress !== null
            ? (persistedSummary.progress as Record<string, unknown>)
            : {}),
          ...liveProgress,
        },
      }
    : persistedSummary;
  const executionOperationId =
    typeof summary.executionOperationId === "string" ? summary.executionOperationId : null;
  if (executionOperationId) {
    const execution = await getRevenueOperation(companyId, executionOperationId, opts);
    if (execution) {
      return {
        operation,
        summary,
        rows: execution.rows.map((row) => ({
          id: row.id,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          entityType: row.entityType,
          action: row.action,
          status: row.status,
          detail: row.detail,
          before: parseJson(row.beforeJson, null),
          after: parseJson(row.afterJson, null),
        })),
        rowTotal: execution.rowTotal,
      };
    }
  }
  const preview = summary.preview as BulkResult | undefined;
  const rows = (preview?.rows ?? []) as unknown as Array<Record<string, unknown>>;
  const offset = Math.max(opts.rowOffset ?? 0, 0);
  const limit = Math.min(Math.max(opts.rowLimit ?? 100, 1), 500);
  return {
    operation,
    summary,
    rows: rows.slice(offset, offset + limit),
    rowTotal: rows.length,
  };
}

export async function rollbackRevenueBulkJob(
  companyId: string,
  id: string,
): Promise<{ job: RevenueOperation; rolledBack: number }> {
  const detail = await getRevenueBulkJob(companyId, id, { rowLimit: 1 });
  if (!detail) throw new Error("Revenue bulk job not found");
  const executionOperationId =
    typeof detail.summary.executionOperationId === "string"
      ? detail.summary.executionOperationId
      : null;
  if (!executionOperationId) throw new Error("This bulk job has no applied changes to roll back");
  const result = await rollbackRevenueOperation(companyId, executionOperationId);
  detail.operation.status = "rolled_back";
  detail.operation.rolledBackAt = new Date();
  detail.operation.summaryJson = JSON.stringify({
    ...detail.summary,
    state: "rolled_back",
    rolledBack: result.rolledBack,
  });
  const job = await AppDataSource.getRepository(RevenueOperation).save(detail.operation);
  return { job, rolledBack: result.rolledBack };
}

export async function resumeRevenueBulkJobs(): Promise<number> {
  const jobs = await AppDataSource.getRepository(RevenueOperation).find({
    where: {
      kind: "bulk",
      status: In(["queued", "running"]),
    },
    take: 500,
  });
  let resumed = 0;
  for (const job of jobs) {
    const payload = parseJson<BulkJobPayload | null>(job.requestJson, null);
    if (!payload || payload.type !== "bulk_job") continue;
    enqueue(job.id);
    resumed += 1;
  }
  return resumed;
}
