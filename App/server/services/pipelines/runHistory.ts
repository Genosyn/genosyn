import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import {
  PipelineRun,
  type PipelineRunStatus,
  type PipelineTriggerKind,
} from "../../db/entities/PipelineRun.js";
import {
  andWhereDateRange,
  dateRange,
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  type PageRequest,
  pageQueryShape,
} from "../listPaging.js";

/**
 * A Pipeline's Run history, newest first, one page at a time
 * (`services/listPaging.ts`).
 *
 * The `list_pipeline_runs` tool and `GET /pipelines/:idOrSlug/runs` both
 * stopped at the newest 50 Runs — so for a webhook pipeline that fires every
 * few minutes, "when did this start failing?" had no answer past the last few
 * hours. Both read this now: the route when asked for a page (without one it
 * still answers the newest 50, as the Pipelines page reads them), the tool
 * always. A Run's log, input and outputs are never read for a listing.
 */

/** 50 Runs a page by default, at most 200. */
export const PIPELINE_RUN_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

export const PIPELINE_RUN_STATUSES = ["running", "completed", "failed", "skipped"] as const;
export const PIPELINE_TRIGGER_KINDS = ["manual", "schedule", "webhook", "event"] as const;

export type PipelineRunFilter = {
  status?: PipelineRunStatus;
  triggerKind?: PipelineTriggerKind;
  /** Started on or after this day (`YYYY-MM-DD`, UTC) or instant. */
  from?: string;
  /** Started on or before this day (the whole day) or instant. */
  to?: string;
};

/** The filters as an AI tool's body sends them; the REST route reads the same from its query. */
export const pipelineRunFilterShape = {
  status: z.enum(PIPELINE_RUN_STATUSES).optional(),
  triggerKind: z.enum(PIPELINE_TRIGGER_KINDS).optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
};

/** The same filters as `GET /pipelines/:idOrSlug/runs` reads them from its query string. */
export const pipelineRunsQuerySchema = z.object({
  status: pipelineRunFilterShape.status.describe("Only Runs that ended in, or are in, this state."),
  triggerKind: pipelineRunFilterShape.triggerKind.describe("Only Runs fired by this kind of trigger."),
  from: pipelineRunFilterShape.from.describe(
    "Started on or after this date: YYYY-MM-DD is a calendar day in UTC; an ISO timestamp is that instant.",
  ),
  to: pipelineRunFilterShape.to.describe(
    "Started on or before this date: YYYY-MM-DD includes that whole day (UTC); an ISO timestamp is that instant.",
  ),
  ...pageQueryShape,
});

/** Every column of a Run but its log, input and outputs. */
const SUMMARY_COLUMNS = [
  "id",
  "pipelineId",
  "startedAt",
  "finishedAt",
  "status",
  "triggerKind",
  "triggerNodeId",
  "errorMessage",
  "createdAt",
] as const;

/** One Pipeline's Runs matching the filter, unordered: the shared WHERE of a page and the plain list. */
export function pipelineRunQuery(pipelineId: string, filter: PipelineRunFilter) {
  const qb = AppDataSource.getRepository(PipelineRun)
    .createQueryBuilder("run")
    .select(SUMMARY_COLUMNS.map((column) => `run.${column}`))
    .where("run.pipelineId = :pipelineId", { pipelineId });
  if (filter.status) qb.andWhere("run.status = :status", { status: filter.status });
  if (filter.triggerKind) {
    qb.andWhere("run.triggerKind = :triggerKind", { triggerKind: filter.triggerKind });
  }
  return andWhereDateRange(qb, "run.startedAt", dateRange(filter.from, filter.to), "started");
}

/**
 * One Pipeline's Runs, newest first, a page at a time. `pipelineId` must
 * already be known to belong to `companyId` (a Run has no company of its own);
 * the company binds the cursor.
 */
export async function pagePipelineRuns<Out>(
  companyId: string,
  pipelineId: string,
  filter: PipelineRunFilter,
  page: PageRequest & { budgetChars?: number },
  present: (runs: PipelineRun[]) => Out[] | Promise<Out[]>,
): Promise<Page<Out>> {
  const started = dateRange(filter.from, filter.to);
  return keysetPage({
    query: () => pipelineRunQuery(pipelineId, filter),
    keys: [
      { column: "run.startedAt", direction: "DESC", type: "timestamp" },
      { column: "run.id", direction: "DESC", type: "string" },
    ],
    scope: "pipeline.runs",
    fingerprint: filterFingerprint(companyId, {
      pipelineId,
      status: filter.status,
      triggerKind: filter.triggerKind,
      started: { gte: started.gte, lt: started.lt, lte: started.lte },
    }),
    noun: "Runs",
    limits: PIPELINE_RUN_PAGE,
    page,
    present,
  });
}
