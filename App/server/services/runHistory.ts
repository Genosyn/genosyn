import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import {
  andWhereDateRange,
  dateRange,
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  pageQueryShape,
  type PageRequest,
} from "./listPaging.js";

/**
 * A Routine's Run history, one page at a time (`services/listPaging.ts`).
 *
 * The `list_runs` AI tool and `GET /routines/:rid/runs` (when it is asked for
 * a page) read this one function, so an AI Employee and an API client reach
 * the same Runs in the same order, and a cursor from one continues the other
 * for the same Routine. The list is the finished Runs only: a Run still
 * queued or running has no verdicts yet. Newest first, by when each started,
 * then by id, so Runs started in the same instant are neither skipped nor
 * repeated at a page boundary — and a Routine that runs hourly keeps
 * thousands, which "when did this start failing?" needs.
 *
 * Reachability is the caller's: a Run is listed exactly when its Routine is
 * one the caller resolved, which is what keeps another company's history out.
 */

/** Runs that have stopped. A `running` row's verdicts are not written yet. */
export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  "completed",
  "reviewed",
  "continued",
  "failed",
  "error",
  "skipped",
  "timeout",
  "interrupted",
];

/** 20 Runs by default — well inside one tool result — and at most 50 a page. */
export const RUN_PAGE: PageLimits = { defaultLimit: 20, maxLimit: 50 };

/** Every Run column but its transcript, which a history listing never shows. */
export function runListColumns(): string[] {
  return AppDataSource.getMetadata(Run)
    .columns.filter((column) => column.propertyName !== "logContent" && column.isSelect)
    .map((column) => `run.${column.propertyName}`);
}

export type RunHistoryFilter = {
  /** The Routines whose Runs are read. Never empty. */
  routineIds: string[];
  /** One finished status; unset is every finished status. */
  status?: RunStatus;
  /** Started on or after this day (`YYYY-MM-DD`, UTC) or instant. */
  from?: string;
  /** Started on or before this day (the whole day) or instant. */
  to?: string;
};

/** The status filter both the tool and the REST route take. */
export const runStatusFilter = z.enum(TERMINAL_RUN_STATUSES as [RunStatus, ...RunStatus[]]);

/** `GET /routines/:rid/runs`'s query: the filters `list_runs` takes, and a page. */
export const routineRunsQuerySchema = z.object({
  status: runStatusFilter
    .optional()
    .describe(
      "Only Runs that ended in this status. continued means the Run saved its progress and the next Run took over its unfinished work.",
    ),
  from: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Started on or after this date: YYYY-MM-DD is a calendar day in UTC; an ISO timestamp is that instant.",
    ),
  to: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Started on or before this date: YYYY-MM-DD includes that whole day (UTC)."),
  ...pageQueryShape,
});

/** Runs of `routineIds` matching the status and start-date filters, unordered. */
export function runHistoryQuery(
  filter: RunHistoryFilter,
  options: { columns?: string[]; finishedOnly?: boolean } = {},
) {
  const started = dateRange(filter.from, filter.to);
  const qb = AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .select(options.columns ?? runListColumns())
    .where("run.routineId IN (:...routineIds)", { routineIds: filter.routineIds });
  if (filter.status) qb.andWhere("run.status = :status", { status: filter.status });
  else if (options.finishedOnly !== false) {
    qb.andWhere("run.status IN (:...statuses)", { statuses: TERMINAL_RUN_STATUSES });
  }
  return andWhereDateRange(qb, "run.startedAt", started, "started");
}

/**
 * Finished Runs of `routineIds`, newest first, one page at a time. `columns`
 * picks what each Run carries (every column but the transcript by default).
 * A bad date or cursor throws a `ListQueryError`.
 */
export async function pageRunHistory<Out>(
  companyId: string,
  filter: RunHistoryFilter,
  page: PageRequest & { budgetChars?: number },
  present: (runs: Run[]) => Promise<Out[]> | Out[],
  options: { columns?: string[] } = {},
): Promise<Page<Out>> {
  if (filter.routineIds.length === 0) throw new Error("A Run history needs at least one Routine");
  const started = dateRange(filter.from, filter.to);
  return keysetPage({
    query: () => runHistoryQuery(filter, { columns: options.columns }),
    keys: [
      { column: "run.startedAt", direction: "DESC", type: "timestamp" },
      { column: "run.id", direction: "DESC", type: "string" },
    ],
    scope: "runs",
    // The list is the Routines, the status and the window — not who reads it,
    // so a cursor carries over between the tool and the REST route.
    fingerprint: filterFingerprint(companyId, {
      routineIds: [...filter.routineIds].sort(),
      status: filter.status,
      started,
    }),
    noun: "Runs",
    limits: RUN_PAGE,
    page,
    present,
  });
}
